import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Accounts, from the Admin tab.
 *
 * Everything here runs behind the admin lock, so the question this file answers
 * is not "who may" — it is "what should an administrator be stopped from doing
 * to themselves". Three things, and they are the whole reason this is not four
 * lines of Prisma:
 *
 *   • You cannot demote or deactivate YOURSELF. It is one click, it is
 *     irreversible from where you are standing, and on a desk with one
 *     administrator it means nobody can get back in.
 *
 *   • You cannot remove the LAST administrator, whoever does it. Same outcome,
 *     reached politely.
 *
 *   • An account is never deleted, only deactivated. Shifts, incidents, tasks
 *     and audit entries all point at it, and deleting the row would either
 *     fail on a foreign key or quietly rewrite who did what.
 */

/** The roles an account may hold. Mirrors the Role enum. */
export const ROLES = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'OPERATIONS',
  'COMPLIANCE',
  'SUPPORT',
  'FINANCE',
  'EXECUTIVE',
  'AUDITOR',
  'READ_ONLY',
] as const;

export type RoleName = (typeof ROLES)[number];

@Injectable()
export class AdminUsersService {
  private readonly log = new Logger(AdminUsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every account, with enough to administer it.
   *
   * Includes HOW each person gets in — Google, a password, or neither — because
   * "why can't Sara sign in?" is the most common question this screen is opened
   * to answer, and it is unanswerable from a name and a role.
   */
  async list() {
    const rows = await this.prisma.user.findMany({
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        googleId: true,
        passwordHash: true,
        adminPassSetAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return rows.map((u) => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName}`.trim() || u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      role: u.role,
      status: u.isActive ? 'active' : 'disabled',
      /** Signed in with Google at least once. */
      google: Boolean(u.googleId),
      /**
       * Whether a password could ever work. An account created for Google
       * sign-in holds unusable text here on purpose, and showing it as "has a
       * password" would send somebody hunting for a password that cannot exist.
       */
      hasPassword: !u.passwordHash.startsWith('google-only:'),
      adminUnlockSet: Boolean(u.adminPassSetAt),
      createdAt: u.createdAt.toISOString(),
      lastSeen: u.updatedAt.toISOString(),
    }));
  }

  /**
   * Adds somebody.
   *
   * With NO password by default, which is the normal case now that the company
   * signs in with Google: the account exists with the right role, and the first
   * time they press "Continue with Google" they land in it. Nothing to send,
   * nothing to type, nothing to leak in a chat message.
   *
   * A temporary password is offered for the case Google cannot cover — a
   * contractor outside the domain, or a break-glass account.
   */
  async create(
    actorId: string,
    input: {
      email?: string;
      firstName?: string;
      lastName?: string;
      role?: string;
      /** Set one now instead of leaving it to Google. */
      password?: string;
    },
  ) {
    const email = (input.email ?? '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException('A valid email address is required.');
    }
    const role = this.checkRole(input.role ?? 'READ_ONLY');

    const firstName = (input.firstName ?? '').trim() || email.split('@')[0];
    const lastName = (input.lastName ?? '').trim();

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      // Named rather than a bare 409: the account often exists and is simply
      // deactivated, and "already exists" sends somebody looking for a
      // duplicate that is not there.
      throw new ConflictException(
        existing.isActive
          ? `${email} already has an account.`
          : `${email} already has an account — it is deactivated. Re-enable it instead of making a second one.`,
      );
    }

    if (input.password && input.password.length < 10) {
      throw new BadRequestException(
        'A temporary password needs at least 10 characters.',
      );
    }

    const user = await this.prisma.user.create({
      data: {
        email,
        firstName,
        lastName,
        role: role as never,
        // The same unusable marker Google sign-in writes: bcrypt.compare fails
        // against it for every input, so an account with no password cannot be
        // signed into with one rather than being signed into with anything.
        passwordHash: input.password
          ? await bcrypt.hash(input.password, 10)
          : `google-only:${randomBytes(24).toString('hex')}`,
      },
    });

    await this.record(actorId, 'user.created', user.id, {
      email,
      role,
      withPassword: Boolean(input.password),
    });
    this.log.log(`Account created for ${email} as ${role}`);
    return { id: user.id, email: user.email, role: user.role };
  }

  /** Changes a role, a name, or whether the account works at all. */
  async update(
    actorId: string,
    id: string,
    input: {
      role?: string;
      isActive?: boolean;
      firstName?: string;
      lastName?: string;
    },
  ) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('No such account.');

    const role = input.role ? this.checkRole(input.role) : undefined;
    const losingAdmin =
      (role !== undefined && role !== 'ADMIN' && target.role === 'ADMIN') ||
      (input.isActive === false && target.role === 'ADMIN');

    if (id === actorId) {
      // The one-click mistake. From where the person is standing it is
      // irreversible: the screen they would fix it on is the one they just shut.
      if (role !== undefined && role !== target.role) {
        throw new BadRequestException(
          'You cannot change your own role. Ask another administrator to do it.',
        );
      }
      if (input.isActive === false) {
        throw new BadRequestException(
          'You cannot deactivate your own account.',
        );
      }
    }

    if (losingAdmin) {
      const others = await this.prisma.user.count({
        where: { role: 'ADMIN', isActive: true, id: { not: id } },
      });
      if (others === 0) {
        throw new BadRequestException(
          'That is the last active administrator. Promote somebody else first, or nobody can administer this dashboard.',
        );
      }
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(role !== undefined ? { role: role as never } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.firstName !== undefined
          ? { firstName: input.firstName.trim() }
          : {}),
        ...(input.lastName !== undefined
          ? { lastName: input.lastName.trim() }
          : {}),
      },
    });

    await this.record(
      actorId,
      'user.updated',
      id,
      {
        email: target.email,
        from: { role: target.role, isActive: target.isActive },
      },
      { role: updated.role, isActive: updated.isActive },
    );
    return { id: updated.id, role: updated.role, isActive: updated.isActive };
  }

  /**
   * Sets a password for somebody who needs one.
   *
   * Returned to the administrator to hand over, rather than emailed: there is
   * no reset-link flow here, and inventing one that quietly does nothing
   * because mail is unconfigured would be worse than saying plainly that you
   * are holding a password you have to pass on.
   */
  async setPassword(actorId: string, id: string, password: string) {
    if (!password || password.length < 10) {
      throw new BadRequestException('Use at least 10 characters.');
    }
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('No such account.');

    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await bcrypt.hash(password, 10) },
    });
    await this.record(actorId, 'user.password.set', id, {
      email: target.email,
    });
    this.log.warn(`Password set for ${target.email} by ${actorId}`);
    return { ok: true, email: target.email };
  }

  /**
   * Takes the password away again, leaving Google as the only way in.
   *
   * The counterpart to the one above: a temporary password handed over during
   * onboarding should not stay live forever once the person is signing in with
   * their work account.
   */
  async clearPassword(actorId: string, id: string) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('No such account.');
    if (!target.googleId && target.id === actorId) {
      throw new BadRequestException(
        'You have never signed in with Google, so removing your password would lock you out.',
      );
    }

    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: `google-only:${randomBytes(24).toString('hex')}` },
    });
    await this.record(actorId, 'user.password.cleared', id, {
      email: target.email,
    });
    return { ok: true, email: target.email };
  }

  private checkRole(role: string): RoleName {
    const upper = role
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');
    if (!(ROLES as readonly string[]).includes(upper)) {
      throw new BadRequestException(
        `"${role}" is not a role. Choose one of: ${ROLES.join(', ')}.`,
      );
    }
    return upper as RoleName;
  }

  /** Never fails the thing it is recording — see AdminLockService.record. */
  private async record(
    userId: string,
    action: string,
    entityId: string,
    oldValue?: unknown,
    newValue?: unknown,
  ) {
    await this.prisma.auditLog
      .create({
        data: {
          userId,
          action,
          entityType: 'User',
          entityId,
          oldValue: (oldValue ?? undefined) as never,
          newValue: (newValue ?? undefined) as never,
        },
      })
      .catch((e: unknown) => {
        this.log.error(
          `Could not write ${action} to the audit log: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      });
  }
}
