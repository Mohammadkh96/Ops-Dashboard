/** The shift shapes the API returns. One definition, shared by every view. */

export type ShiftTask = {
  id: string;
  title: string;
  howTo: string | null;
  category: string;
  priority: string;
  status: string;
  notes: string | null;
  assigneeId: string | null;
  completedBy: string | null;
  completedAt: string | null;
};

export type Shift = {
  id: string;
  name: string;
  status: string;
  opsDay: string | null;
  slot: number | null;
  startedAt: string;
  endedAt: string | null;
  startedAtLocal: string;
  openedBy: string | null;
  takenOverFrom: string | null;
  handoverTo: string | null;
  startBalances: Record<string, number> | null;
  startNotes: string | null;
  /** The handover this shift's opener read before starting, and when. */
  readHandoverOf: string | null;
  handoverReadAt: string | null;
  /** The same instant in the desk's timezone, like startedAtLocal. */
  handoverReadAtLocal: string | null;
  notes: string | null;
  kyc: unknown;
  tickets: ShiftTicket[];
  participants: { userId: string; name: string }[];
  tasks: ShiftTask[];
  tasksDone: number;
  tasksTotal: number;
};

export type ActiveShift = {
  shift: Shift | null;
  joined: boolean;
  suggestedName: string;
};

/**
 * The shift this desk is taking over from — the last one that closed.
 *
 * Enough to set expectations before the handover document loads: "nothing
 * outstanding" and "four tasks still open" are very different shifts to be
 * walking into, and the reader should know which one it is before they start
 * reading. Null on the first shift of all.
 */
export type PreviousShift = {
  shift: {
    id: string;
    name: string;
    opsDay: string | null;
    slot: number | null;
    endedAt: string | null;
    endedAtLocal: string | null;
    endedBy: string | null;
    handoverTo: string | null;
    hasNotes: boolean;
    openTasks: number;
    tickets: number;
  } | null;
};

/** A support ticket the next shift needs to know about. */
export type ShiftTicket = {
  num: string;
  subject: string;
  desc: string;
  status: string;
};

export type TaskTemplate = {
  id: string;
  title: string;
  howTo: string | null;
  category: string;
  appliesTo: string;
  priority: string;
  active: boolean;
  position: number;
};

export type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: string;
  roleLabel: string | null;
  isManager: boolean;
};

export type ShiftFinancials = {
  deposits: { count: number; amount: number };
  withdrawals: { count: number; amount: number };
  refunds: { count: number; amount: number };
  volume: number;
  declined: number;
  pending: number;
  successRate: number | null;
  byPsp: {
    psp: string;
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

/** Whether the handover email actually went out, and why not if it did not. */
export type MailResult = {
  sent: boolean;
  provider: "gmail" | "resend" | "sendgrid" | "none";
  to: string[];
  reason?: string;
};

export type ShiftReport = {
  shift: Shift;
  mail?: MailResult;
  financials: ShiftFinancials;
  incidents: { ref: string; title: string; severity: string; status: string; at: string }[];
  openTasks: { title: string; priority: string; status: string }[];
  durationMins: number;
};

export const SHIFT_NAMES = ["Morning", "Evening", "Night", "Ad Hoc"];
export const PRIORITIES = ["Low", "Medium", "High", "Critical"];
