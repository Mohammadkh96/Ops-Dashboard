import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { directionOf, stateBucket } from '../modules/success-rate';
import { isSettledState, providerLabel } from '../paymaxis/normalize';
import {
  deskTime,
  nextSlot,
  opsDay,
  slotsPerDay,
  suggestShiftName,
} from './ops-day';

export type Actor = { userId: string; email: string; role: string };

/** Roles that may edit the task library, close somebody else's shift, and see
 *  the manager views. Everything else is open to anyone signed in. */
const MANAGER_ROLES = ['ADMIN', 'OPERATIONS_MANAGER'];

export const isManager = (role: string) => MANAGER_ROLES.includes(role);

function asJson(v: unknown): Prisma.InputJsonValue {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return (v ?? {}) as Prisma.InputJsonValue;
}

export type ShiftFinancials = {
  deposits: { count: number; amount: number };
  withdrawals: { count: number; amount: number };
  refunds: { count: number; amount: number };
  /** Deposits + withdrawals. Refunds are reported, never netted into volume. */
  volume: number;
  declined: number;
  pending: number;
  /** Settled share of everything decided — the desk's headline quality number. */
  successRate: number | null;
  byPsp: {
    psp: string;
    terminal: string | null;
    deposits: number;
    depositAmount: number;
    withdrawals: number;
    withdrawalAmount: number;
    refunds: number;
    refundAmount: number;
    volume: number;
  }[];
  byCurrency: { currency: string; count: number; amount: number }[];
  currencies: string[];
};

@Injectable()
export class ShiftsService {
  private readonly log = new Logger(ShiftsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── the open shift ────────────────────────────────────────────────────

  /**
   * The one shift currently open, if any.
   *
   * One at a time, deliberately. Two open shifts means every figure has to ask
   * "which one?", and the desk has no answer — there is one desk.
   */
  async active(actor?: Actor) {
    const shift = await this.prisma.shift.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { startedAt: 'desc' },
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        participants: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true } },
          },
          orderBy: { joinedAt: 'asc' },
        },
        tasks: { orderBy: [{ status: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    if (!shift)
      return {
        shift: null,
        joined: false,
        suggestedName: suggestShiftName(new Date()),
      };

    return {
      shift: this.shiftView(shift),
      // Whether the caller is one of the hands on this shift. Actions are
      // attributed, so somebody who has not joined is asked to before they can
      // log work against it.
      joined: actor
        ? shift.participants.some((p) => p.userId === actor.userId)
        : false,
      suggestedName: shift.name,
    };
  }

  private shiftView(shift: {
    id: string;
    name: string;
    status: string;
    opsDay: string | null;
    slot: number | null;
    startedAt: Date;
    endedAt: Date | null;
    takenOverFrom: string | null;
    handoverTo: string | null;
    startBalances: unknown;
    startNotes: string | null;
    notes: string | null;
    kyc: unknown;
    tickets: unknown;
    user?: { firstName: string; lastName: string } | null;
    participants?: {
      userId: string;
      user: { firstName: string; lastName: string };
    }[];
    tasks?: unknown[];
  }) {
    const done = (shift.tasks ?? []).filter(
      (t) => (t as { status: string }).status === 'Done',
    ).length;
    return {
      id: shift.id,
      name: shift.name,
      status: shift.status,
      opsDay: shift.opsDay,
      slot: shift.slot,
      startedAt: shift.startedAt.toISOString(),
      endedAt: shift.endedAt ? shift.endedAt.toISOString() : null,
      startedAtLocal: deskTime(shift.startedAt),
      openedBy: shift.user
        ? `${shift.user.firstName} ${shift.user.lastName}`.trim()
        : null,
      takenOverFrom: shift.takenOverFrom,
      handoverTo: shift.handoverTo,
      startBalances: shift.startBalances ?? null,
      startNotes: shift.startNotes,
      notes: shift.notes,
      kyc: shift.kyc ?? null,
      tickets: shift.tickets ?? [],
      participants: (shift.participants ?? []).map((p) => ({
        userId: p.userId,
        name: `${p.user.firstName} ${p.user.lastName}`.trim(),
      })),
      tasks: shift.tasks ?? [],
      tasksDone: done,
      tasksTotal: (shift.tasks ?? []).length,
    };
  }

  // ── start ─────────────────────────────────────────────────────────────

  /**
   * Opens the shift and seeds it with the standing tasks for it.
   *
   * The library is copied in rather than referenced, so the list a person
   * worked from is preserved exactly as it was worded that day — editing the
   * library later corrects the next shift, not the record of the last one.
   */
  async start(
    actor: Actor,
    body: {
      name?: string;
      takenOverFrom?: string;
      balances?: Record<string, number>;
      startNotes?: string;
    },
  ) {
    const open = await this.prisma.shift.findFirst({
      where: { status: 'ACTIVE' },
    });
    if (open) {
      throw new ConflictException(
        'A shift is already open. Join it instead of starting another — there is one desk, so there is one shift.',
      );
    }

    const name = (body.name ?? '').trim() || suggestShiftName(new Date());
    const templates = await this.prisma.taskTemplate.findMany({
      where: {
        active: true,
        OR: [{ appliesTo: 'All Shifts' }, { appliesTo: name }],
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });

    const shift = await this.prisma.shift.create({
      data: {
        name,
        userId: actor.userId,
        takenOverFrom: (body.takenOverFrom ?? '').trim() || null,
        startBalances: body.balances ? asJson(body.balances) : Prisma.DbNull,
        startNotes: (body.startNotes ?? '').trim() || null,
        participants: { create: { userId: actor.userId } },
        tasks: {
          create: templates.map((t) => ({
            templateId: t.id,
            title: t.title,
            howTo: t.howTo,
            category: t.category,
            priority: t.priority,
          })),
        },
      },
    });

    this.log.log(`Shift ${shift.id} (${name}) opened by ${actor.email}`);
    return this.active(actor);
  }

  /** Adds the caller to the open shift. */
  async join(actor: Actor) {
    const shift = await this.prisma.shift.findFirst({
      where: { status: 'ACTIVE' },
    });
    if (!shift) throw new NotFoundException('No shift is open to join.');
    await this.prisma.shiftParticipant.upsert({
      where: { shiftId_userId: { shiftId: shift.id, userId: actor.userId } },
      create: { shiftId: shift.id, userId: actor.userId },
      update: { leftAt: null },
    });
    return this.active(actor);
  }

  // ── end ───────────────────────────────────────────────────────────────

  /**
   * Closes the shift and files it against an ops day.
   *
   * Refuses while the caller still has open tasks assigned to them, which is
   * the one rule the desk's spreadsheet enforced and the reason its checklist
   * meant anything: a shift that can be closed over unfinished work is a
   * checklist people learn to ignore. A manager can override, because
   * sometimes a task genuinely cannot be finished and somebody has to decide
   * that — but it is a decision with a name on it, not a default.
   */
  async end(
    actor: Actor,
    body: {
      handoverTo?: string;
      notes?: string;
      kyc?: unknown;
      tickets?: unknown[];
      force?: boolean;
    },
  ) {
    const shift = await this.prisma.shift.findFirst({
      where: { status: 'ACTIVE' },
      include: { tasks: true, participants: true },
    });
    if (!shift) throw new NotFoundException('No shift is open.');

    const mine = shift.tasks.filter(
      (t) =>
        t.assigneeId === actor.userId &&
        ['Pending', 'In Progress', 'Blocked'].includes(t.status),
    );
    if (mine.length && !body.force) {
      throw new BadRequestException(
        `${mine.length} task(s) assigned to you are still open: ${mine
          .map((t) => t.title)
          .slice(0, 3)
          .join(
            '; ',
          )}${mine.length > 3 ? '…' : ''}. Finish them, reassign them, or ask a manager to close the shift over them.`,
      );
    }
    if (mine.length && body.force && !isManager(actor.role)) {
      throw new ForbiddenException(
        'Only a manager can close a shift over open tasks.',
      );
    }

    const endedAt = new Date();
    const day = opsDay(endedAt);
    // Which positions this ops day has already used. The number follows from
    // those, not from a count of shifts — see ops-day.ts.
    const already = await this.prisma.shift.findMany({
      where: { opsDay: day, status: 'ENDED' },
      select: { slot: true },
    });
    const slot = nextSlot(
      endedAt,
      already.map((s) => s.slot ?? 0).filter(Boolean),
    );

    await this.prisma.shift.update({
      where: { id: shift.id },
      data: {
        status: 'ENDED',
        endedAt,
        endedBy: actor.email,
        opsDay: day,
        slot,
        handoverTo: (body.handoverTo ?? '').trim() || null,
        notes: (body.notes ?? '').trim() || null,
        kyc: body.kyc ? asJson(body.kyc) : Prisma.DbNull,
        tickets: asJson(Array.isArray(body.tickets) ? body.tickets : []),
      },
    });

    this.log.log(
      `Shift ${shift.id} closed by ${actor.email} as ${day} shift ${slot}`,
    );
    return this.report(shift.id);
  }

  // ── the numbers ───────────────────────────────────────────────────────

  /**
   * What happened on a shift, read from the payments themselves.
   *
   * The desk's spreadsheet asked the closing agent to upload a CSV export at
   * the end of every shift so it could count what they had just done. That
   * step exists here too — but it is the historical import, run once, not a
   * chore repeated three times a day. The payments are already in the
   * database, so a shift's figures are a query, not a task somebody can forget
   * or do twice.
   */
  async financials(from: Date, to: Date): Promise<ShiftFinancials> {
    const rows = await this.prisma.paymentEvent.findMany({
      where: { occurredAt: { gte: from, lte: to } },
      select: {
        id: true,
        paymentId: true,
        reference: true,
        state: true,
        type: true,
        amount: true,
        currency: true,
        psp: true,
        terminal: true,
        occurredAt: true,
        receivedAt: true,
      },
      take: 50_000,
    });

    // One entry per payment at its latest state — the same collapse every
    // other figure in this dashboard uses. Without it a payment that went
    // PENDING then COMPLETED is counted twice and every total is wrong in a
    // way that looks like good news.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const key = r.paymentId || r.reference || r.id;
      const prev = latest.get(key);
      const at = (x: (typeof rows)[number]) =>
        (x.occurredAt ?? x.receivedAt).getTime();
      if (!prev || at(r) > at(prev)) latest.set(key, r);
    }

    const zero = () => ({ count: 0, amount: 0 });
    const out: ShiftFinancials = {
      deposits: zero(),
      withdrawals: zero(),
      refunds: zero(),
      volume: 0,
      declined: 0,
      pending: 0,
      successRate: null,
      byPsp: [],
      byCurrency: [],
      currencies: [],
    };

    const psps = new Map<string, ShiftFinancials['byPsp'][number]>();
    const currencies = new Map<string, { count: number; amount: number }>();
    let completed = 0;
    let decided = 0;

    for (const r of latest.values()) {
      const bucket = stateBucket(r.state, isSettledState);
      if (bucket === 'declined') out.declined += 1;
      if (bucket === 'pending') out.pending += 1;
      if (bucket === 'completed' || bucket === 'declined') {
        decided += 1;
        if (bucket === 'completed') completed += 1;
      }
      // Only settled money counts toward a total. A declined deposit is not
      // money the desk handled, however much it was for.
      if (bucket !== 'completed') continue;

      const dir = directionOf(r.type);
      const amount = Math.abs(r.amount);
      if (dir === 'deposits') {
        out.deposits.count += 1;
        out.deposits.amount += amount;
      } else if (dir === 'withdrawals') {
        out.withdrawals.count += 1;
        out.withdrawals.amount += amount;
      } else {
        out.refunds.count += 1;
        out.refunds.amount += amount;
      }

      const pspKey = r.psp || r.terminal || 'Unassigned';
      let p = psps.get(pspKey);
      if (!p) {
        p = {
          psp: pspKey,
          terminal: r.terminal,
          deposits: 0,
          depositAmount: 0,
          withdrawals: 0,
          withdrawalAmount: 0,
          refunds: 0,
          refundAmount: 0,
          volume: 0,
        };
        psps.set(pspKey, p);
      }
      if (dir === 'deposits') {
        p.deposits += 1;
        p.depositAmount += amount;
        p.volume += amount;
      } else if (dir === 'withdrawals') {
        p.withdrawals += 1;
        p.withdrawalAmount += amount;
        p.volume += amount;
      } else {
        // Refunds are tracked per terminal but kept OUT of volume, so the PSP
        // table ties exactly to the deposit and withdrawal figures above.
        p.refunds += 1;
        p.refundAmount += amount;
      }

      const cur = r.currency || 'Unknown';
      const c = currencies.get(cur) ?? { count: 0, amount: 0 };
      c.count += 1;
      c.amount += amount;
      currencies.set(cur, c);
    }

    out.volume = out.deposits.amount + out.withdrawals.amount;
    out.successRate = decided
      ? Math.round((completed / decided) * 1000) / 10
      : null;
    out.byPsp = [...psps.values()].sort((a, b) => b.volume - a.volume);
    out.byCurrency = [...currencies.entries()]
      .map(([currency, v]) => ({ currency, ...v }))
      .sort((a, b) => b.amount - a.amount);
    out.currencies = out.byCurrency.map((c) => c.currency);
    return out;
  }

  /** One shift's handover: what it was, what it did, what it left behind. */
  async report(shiftId: string) {
    const shift = await this.prisma.shift.findUnique({
      where: { id: shiftId },
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
        participants: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
        tasks: { orderBy: [{ status: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    if (!shift) throw new NotFoundException('No such shift.');

    const to = shift.endedAt ?? new Date();
    const financials = await this.financials(shift.startedAt, to);

    // Open incidents across the whole system, not just this shift's — the next
    // person inherits all of them, and one raised two shifts ago that nobody
    // closed is exactly the one worth putting in front of them.
    const incidents = await this.prisma.incident.findMany({
      where: { status: { not: 'RESOLVED' } },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
      take: 25,
      select: {
        ref: true,
        title: true,
        severity: true,
        status: true,
        createdAt: true,
      },
    });

    const openTasks = shift.tasks.filter((t) => t.status !== 'Done');

    return {
      shift: this.shiftView(shift),
      financials,
      incidents: incidents.map((i) => ({
        ref: `INC-${i.ref}`,
        title: i.title,
        severity: i.severity,
        status: i.status,
        at: i.createdAt.toISOString(),
      })),
      openTasks: openTasks.map((t) => ({
        title: t.title,
        priority: t.priority,
        status: t.status,
      })),
      durationMins: Math.max(
        0,
        Math.round((to.getTime() - shift.startedAt.getTime()) / 60000),
      ),
    };
  }

  /**
   * The whole ops day, shift by shift — the pivot the handover email is built
   * from. Shift 1 shows one column, shift 3 shows three and a day total.
   */
  async day(day: string) {
    const shifts = await this.prisma.shift.findMany({
      where: { opsDay: day },
      orderBy: [{ slot: 'asc' }, { endedAt: 'asc' }],
      include: {
        user: { select: { firstName: true, lastName: true } },
        participants: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
      },
    });

    const columns = await Promise.all(
      shifts.map(async (s) => ({
        id: s.id,
        slot: s.slot,
        name: s.name,
        agent: `${s.user.firstName} ${s.user.lastName}`.trim(),
        endedAt: s.endedAt ? s.endedAt.toISOString() : null,
        endedAtLocal: s.endedAt ? deskTime(s.endedAt) : null,
        financials: await this.financials(s.startedAt, s.endedAt ?? new Date()),
      })),
    );

    return {
      day,
      slotsPerDay: slotsPerDay(columns.map((c) => c.slot ?? 0)),
      columns,
      // Only meaningful from the second shift onward: there is nothing to
      // total on the first one, and a "day total" identical to the only column
      // reads as a mistake.
      showDayTotal: columns.length > 1,
    };
  }

  /** Recent shifts, newest first. */
  async history(limit = 30) {
    const shifts = await this.prisma.shift.findMany({
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      include: {
        user: { select: { firstName: true, lastName: true } },
        participants: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
        tasks: { select: { status: true } },
      },
    });
    return shifts.map((s) => ({
      ...this.shiftView(s),
      // The task list itself is noise in a history row; the count is the point.
      tasks: undefined,
    }));
  }

  // ── tasks ─────────────────────────────────────────────────────────────

  async addTask(
    actor: Actor,
    body: {
      title?: string;
      howTo?: string;
      category?: string;
      priority?: string;
      assigneeId?: string;
    },
  ) {
    const shift = await this.prisma.shift.findFirst({
      where: { status: 'ACTIVE' },
    });
    if (!shift) throw new NotFoundException('No shift is open.');
    const title = (body.title ?? '').trim();
    if (!title) throw new BadRequestException('A task needs a title.');
    await this.prisma.shiftTask.create({
      data: {
        shiftId: shift.id,
        title,
        howTo: (body.howTo ?? '').trim() || null,
        category: body.category || 'Operations',
        priority: body.priority || 'Medium',
        assigneeId: body.assigneeId || actor.userId,
      },
    });
    return this.active(actor);
  }

  async updateTask(
    actor: Actor,
    id: string,
    body: {
      status?: string;
      assigneeId?: string | null;
      notes?: string;
      priority?: string;
    },
  ) {
    const task = await this.prisma.shiftTask.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('No such task.');
    const done = body.status === 'Done';
    await this.prisma.shiftTask.update({
      where: { id },
      data: {
        status: body.status ?? task.status,
        priority: body.priority ?? task.priority,
        notes: body.notes ?? task.notes,
        assigneeId:
          body.assigneeId === undefined ? task.assigneeId : body.assigneeId,
        // Recorded on the way through: "who ticked this?" is asked far more
        // often than it can be answered afterwards.
        completedBy: done ? actor.email : task.completedBy,
        completedAt: done ? new Date() : task.completedAt,
      },
    });
    return this.active(actor);
  }

  // ── task library (managers) ───────────────────────────────────────────

  async library(activeOnly = false) {
    return this.prisma.taskTemplate.findMany({
      where: activeOnly ? { active: true } : {},
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async saveTemplate(
    actor: Actor,
    body: {
      id?: string;
      title?: string;
      howTo?: string;
      category?: string;
      appliesTo?: string;
      priority?: string;
      active?: boolean;
      position?: number;
    },
  ) {
    if (!isManager(actor.role)) {
      throw new ForbiddenException(
        'Only a manager can change the task library — it is what every shift is measured against.',
      );
    }
    const title = (body.title ?? '').trim();
    if (!title) throw new BadRequestException('A library task needs a title.');
    const data = {
      title,
      howTo: (body.howTo ?? '').trim() || null,
      category: body.category || 'Operations',
      appliesTo: body.appliesTo || 'All Shifts',
      priority: body.priority || 'Medium',
      active: body.active !== false,
      position: Number(body.position ?? 0),
    };
    if (body.id) {
      await this.prisma.taskTemplate.update({ where: { id: body.id }, data });
    } else {
      await this.prisma.taskTemplate.create({ data });
    }
    return this.library();
  }

  async deleteTemplate(actor: Actor, id: string) {
    if (!isManager(actor.role)) {
      throw new ForbiddenException(
        'Only a manager can change the task library.',
      );
    }
    // Deactivated, not deleted: shifts that ran it keep pointing here, and a
    // task removed from the library is still part of what happened last week.
    await this.prisma.taskTemplate.update({
      where: { id },
      data: { active: false },
    });
    return this.library();
  }

  /** Everyone who can be assigned work or handed a shift. */
  async team() {
    const users = await this.prisma.user.findMany({
      where: { isActive: true },
      orderBy: { firstName: 'asc' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
      },
    });
    return users.map((u) => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName}`.trim(),
      email: u.email,
      role: u.role,
      roleLabel: providerLabel(u.role),
      isManager: isManager(u.role),
    }));
  }
}
