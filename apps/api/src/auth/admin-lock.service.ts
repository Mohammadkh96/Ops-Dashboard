import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../prisma/prisma.service';

/**
 * A second password, guarding the Admin tab.
 *
 * WHY A SECOND ONE AT ALL. Being signed in and being able to change somebody's
 * role, read the whole audit trail or touch provider credentials should not be
 * the same state. The ordinary way an operations dashboard gets misused is not
 * a break-in: it is a session left open on an unlocked laptop on a busy desk.
 * This is the step that has to be taken deliberately, and it expires by itself
 * so that forgetting to lock up is not a decision anybody has to remember.
 *
 * WHY NOT THE SIGN-IN PASSWORD. An account created through Google sign-in has
 * no usable sign-in password — the column holds unusable text on purpose.
 * Asking for it would lock every Google user out of the Admin tab forever,
 * which is most of the desk the moment SSO is switched on.
 *
 * WHY NOT ONE SHARED SECRET IN THE ENVIRONMENT. A shared password cannot be
 * attributed, so the audit log stops meaning anything the moment two people
 * know it; it cannot be rotated without a redeploy; and it ends up in a chat
 * message. Each administrator sets their own.
 *
 * WHAT THIS IS NOT. It is not a second factor — somebody who has taken over the
 * session can watch the passphrase being typed. It raises the cost of casual
 * misuse and puts a deliberate, logged, expiring step in front of the
 * destructive things. Real second-factor authentication is a different feature.
 */
@Injectable()
export class AdminLockService {
  private readonly log = new Logger(AdminLockService.name);

  /** How long an unlock lasts. Long enough to do a job, short enough to matter. */
  static readonly TTL_MINUTES = 15;
  /** Wrong attempts before the lock stops answering. */
  static readonly MAX_FAILS = 5;
  /** How long it stays shut after that. */
  static readonly LOCKOUT_MINUTES = 15;
  /** The shortest passphrase worth calling one. */
  static readonly MIN_LENGTH = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Where this person stands with the lock.
   *
   * Told to the browser so it can show the right screen — set a passphrase,
   * type it, or wait out a lockout — rather than making somebody discover which
   * one they are in by failing.
   */
  async status(userId: string) {
    const user = await this.mustBeAdmin(userId);
    const lockedFor = remainingMs(user.adminLockedUntil);
    return {
      /** Whether they have ever set one. */
      configured: Boolean(user.adminPassHash),
      setAt: user.adminPassSetAt?.toISOString() ?? null,
      lockedForSeconds: Math.ceil(lockedFor / 1000),
      attemptsLeft: Math.max(
        0,
        AdminLockService.MAX_FAILS - (user.adminFails ?? 0),
      ),
      ttlMinutes: AdminLockService.TTL_MINUTES,
      minLength: AdminLockService.MIN_LENGTH,
    };
  }

  /**
   * Sets the passphrase, or changes it.
   *
   * Changing requires the current one. Without that, a session somebody has
   * walked away from could be used to REPLACE the passphrase — which would turn
   * the second password from an obstacle into a formality, and lock the real
   * owner out at the same time.
   */
  async setPassphrase(
    userId: string,
    input: { current?: string; next?: string },
  ) {
    const user = await this.mustBeAdmin(userId);
    const next = (input.next ?? '').trim();

    if (next.length < AdminLockService.MIN_LENGTH) {
      throw new BadRequestException(
        `Use at least ${AdminLockService.MIN_LENGTH} characters. This one guards role changes and the audit trail.`,
      );
    }

    if (user.adminPassHash) {
      const ok = await bcrypt.compare(input.current ?? '', user.adminPassHash);
      if (!ok) {
        throw new UnauthorizedException(
          'That is not the current admin passphrase.',
        );
      }
      // A passphrase that is also the sign-in password gives back exactly what
      // the second one was for.
      if (await bcrypt.compare(next, user.passwordHash)) {
        throw new BadRequestException(
          'Choose something other than your sign-in password — the point of this one is that it is a separate step.',
        );
      }
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        adminPassHash: await bcrypt.hash(next, 12),
        adminPassSetAt: new Date(),
        // Setting a new one clears any lockout: the person proved they are the
        // owner, and leaving them shut out of what they just set is nonsense.
        adminFails: 0,
        adminLockedUntil: null,
      },
    });
    await this.record(userId, 'admin.passphrase.set', {
      first: !user.adminPassHash,
    });
    this.log.log(
      `${user.email} ${user.adminPassHash ? 'changed' : 'set'} their admin passphrase`,
    );
    return { ok: true };
  }

  /**
   * Opens the lock, and hands back a token that says so.
   *
   * A SEPARATE token from the session, with a short life and a scope of its
   * own. It is never stored — the browser holds it in memory, so closing the
   * tab locks up. Putting this in localStorage beside the session token would
   * make the whole thing decorative.
   */
  async unlock(userId: string, passphrase: string) {
    const user = await this.mustBeAdmin(userId);

    const lockedFor = remainingMs(user.adminLockedUntil);
    if (lockedFor > 0) {
      throw new ForbiddenException(
        `Too many wrong attempts. Try again in ${Math.ceil(lockedFor / 60000)} minute(s).`,
      );
    }
    if (!user.adminPassHash) {
      throw new BadRequestException(
        'No admin passphrase has been set for this account yet. Set one first.',
      );
    }

    const ok = await bcrypt.compare(passphrase ?? '', user.adminPassHash);
    if (!ok) {
      const fails = (user.adminFails ?? 0) + 1;
      const lockOut = fails >= AdminLockService.MAX_FAILS;
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          adminFails: lockOut ? 0 : fails,
          adminLockedUntil: lockOut
            ? new Date(Date.now() + AdminLockService.LOCKOUT_MINUTES * 60_000)
            : null,
        },
      });
      // Logged whether it worked or not. A run of failures against the admin
      // lock is exactly the thing somebody should be able to find afterwards,
      // and it is invisible if only successes are recorded.
      await this.record(userId, 'admin.unlock.failed', { attempt: fails });
      this.log.warn(`Failed admin unlock for ${user.email} (attempt ${fails})`);
      throw new UnauthorizedException(
        lockOut
          ? `That is not the passphrase. Too many attempts — locked for ${AdminLockService.LOCKOUT_MINUTES} minutes.`
          : `That is not the passphrase. ${AdminLockService.MAX_FAILS - fails} attempt(s) left before this locks for ${AdminLockService.LOCKOUT_MINUTES} minutes.`,
      );
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { adminFails: 0, adminLockedUntil: null },
    });
    await this.record(userId, 'admin.unlock', null);

    const expiresAt = new Date(
      Date.now() + AdminLockService.TTL_MINUTES * 60_000,
    );
    return {
      adminToken: await this.jwt.signAsync(
        // `scope` is what the guard looks for. A session token has no scope, so
        // one can never be mistaken for the other however it is passed in.
        { sub: user.id, email: user.email, role: user.role, scope: 'admin' },
        { expiresIn: `${AdminLockService.TTL_MINUTES}m` },
      ),
      expiresAt: expiresAt.toISOString(),
      ttlMinutes: AdminLockService.TTL_MINUTES,
    };
  }

  /**
   * Whether a token really is an unlocked admin, right now.
   *
   * Re-reads the account rather than trusting the role inside the token: an
   * administrator demoted or deactivated two minutes ago still holds a
   * perfectly valid token for another thirteen, and the whole point of this
   * lock is the things it guards.
   */
  async verifyElevated(token: string | undefined): Promise<{
    userId: string;
    email: string;
  }> {
    if (!token) {
      throw new ForbiddenException(
        'This needs the Admin tab unlocked. Enter your admin passphrase.',
      );
    }
    let claims: { sub?: string; scope?: string; email?: string };
    try {
      claims = this.jwt.verify(token);
    } catch {
      throw new ForbiddenException(
        'The admin session has expired. Enter your passphrase again.',
      );
    }
    if (claims.scope !== 'admin' || !claims.sub) {
      throw new ForbiddenException('That is not an admin session token.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, email: true, role: true, isActive: true },
    });
    if (!user || !user.isActive || user.role !== 'ADMIN') {
      throw new ForbiddenException(
        'That account is no longer an active administrator.',
      );
    }
    return { userId: user.id, email: user.email };
  }

  /**
   * Clears another administrator's passphrase, so they can set a new one.
   *
   * The recovery path, and it deliberately needs a DIFFERENT unlocked
   * administrator — not an environment variable, which would be a shared
   * break-glass secret sitting in a config file forever. A desk with one
   * administrator and a forgotten passphrase is a database update, which is the
   * honest cost of not having a master key.
   */
  async resetFor(actorId: string, targetId: string) {
    if (actorId === targetId) {
      throw new BadRequestException(
        'Change your own passphrase instead — resetting it is for helping somebody else back in.',
      );
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, email: true },
    });
    if (!target) throw new BadRequestException('No such account.');

    await this.prisma.user.update({
      where: { id: targetId },
      data: {
        adminPassHash: null,
        adminPassSetAt: null,
        adminFails: 0,
        adminLockedUntil: null,
      },
    });
    await this.record(actorId, 'admin.passphrase.reset', {
      target: target.email,
    });
    this.log.warn(`Admin passphrase reset for ${target.email} by ${actorId}`);
    return { ok: true, email: target.email };
  }

  /** The caller, if they are an administrator at all. */
  private async mustBeAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) {
      throw new ForbiddenException('That account is not active.');
    }
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException(
        'The Admin tab is for administrators. Ask one to change your role if you need it.',
      );
    }
    return user;
  }

  /**
   * Writes to the audit trail, and never fails the thing it is recording.
   *
   * A missing log line is bad; an unlock that errors because the log table is
   * behind a migration is worse, because it makes the tab unreachable at the
   * exact moment somebody is trying to fix the deployment.
   */
  private async record(userId: string, action: string, detail: unknown) {
    await this.prisma.auditLog
      .create({
        data: {
          userId,
          action,
          entityType: 'AdminLock',
          entityId: userId,
          newValue: (detail ?? undefined) as never,
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

/** Milliseconds left on a lockout, or 0. */
function remainingMs(until: Date | null | undefined): number {
  if (!until) return 0;
  return Math.max(0, until.getTime() - Date.now());
}
