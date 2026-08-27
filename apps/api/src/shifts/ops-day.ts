/**
 * Which ops day a shift belongs to, and which shift of that day it is.
 *
 * This is the part of a shift system that looks trivial and is not. The rules
 * below are not invented here — they are the ones the desk's spreadsheet
 * arrived at over a dozen revisions, each one paid for by a handover that
 * reported the wrong numbers to the wrong day.
 *
 *   • THE DAY DOES NOT BREAK AT MIDNIGHT. The last handover of the day lands
 *     near 00:00, so a midnight boundary files 23:58 under one day and 00:03
 *     under the next — the same handover, either side of a coin toss. The day
 *     breaks at 04:00 instead, which is the quietest point between the last
 *     handover and the first, leaving about four hours of slack around every
 *     one of them.
 *
 *   • THE FIRST HANDOVER OF A DAY IS NUMBERED FROM THE CLOCK, in wide bands:
 *     04:00-12:00 is shift 1, 12:00-20:00 is shift 2, 20:00-04:00 is shift 3.
 *     A day whose first handover arrives in the afternoon therefore opens at
 *     shift 2 rather than pretending a morning shift happened.
 *
 *   • EVERY HANDOVER AFTER THE FIRST IS THE PREVIOUS NUMBER PLUS ONE, and the
 *     clock is ignored. This is deliberate and it is the rule people get
 *     wrong: an agent who hands over two hours late is still the next shift in
 *     sequence. Numbering them from the clock again would skip a number
 *     because their handover drifted into the following band, and a skipped
 *     number reads as a missing shift.
 *
 *   • A FOURTH SHIFT IN A DAY ADDS A NUMBER rather than resetting. An extra
 *     ad-hoc shift is a real thing that happens; silently renumbering it as
 *     shift 1 of a new day is not.
 *
 * Everything here is computed in the DESK'S timezone, never the server's. The
 * server runs in UTC; in Amman a handover at 00:05 local is 21:05 UTC the
 * previous day, so a weekday or a date read off the raw clock is simply the
 * wrong one — which is exactly how the spreadsheet's weekend prompt ended up
 * firing twice.
 */

/** IANA zone the desk works in. Everything user-facing is computed in it. */
export const DESK_TIMEZONE = process.env.OPS_TIMEZONE ?? 'Asia/Amman';

/** The hour the ops day rolls over, in desk time. */
export const OPS_DAY_START_HOUR = Number(process.env.OPS_DAY_START_HOUR ?? 4);

/**
 * Target handover times, in order. Used ONLY to number the first shift of a
 * day; after that the sequence carries itself.
 */
export const HANDOVER_SLOTS = (
  process.env.OPS_HANDOVER_SLOTS ?? '08:00,16:00,00:00'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Wall-clock fields of an instant, as read in the desk's timezone. */
export function deskParts(at: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  // Intl is the only correct way to do this: it knows the zone's DST history,
  // and a fixed offset does not.
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: DESK_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) parts[p.type] = p.value;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some locales render midnight as "24"; both mean the same instant.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: Math.max(0, WEEKDAYS.indexOf(parts.weekday ?? '')),
  };
}

/** yyyy-mm-dd in desk time. */
export function deskDate(at: Date): string {
  const p = deskParts(at);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** HH:mm in desk time. */
export function deskTime(at: Date): string {
  const p = deskParts(at);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * The ops day an instant belongs to, as yyyy-mm-dd.
 *
 * Anything before the rollover hour belongs to the previous day — that is the
 * whole point: a shift handing over at 00:30 closes YESTERDAY's ops day.
 */
export function opsDay(at: Date): string {
  const p = deskParts(at);
  if (p.hour >= OPS_DAY_START_HOUR) {
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }
  // Step back one calendar day in desk terms. Doing the arithmetic on a UTC
  // date built from the desk's own y/m/d keeps month and year ends correct
  // without importing a date library.
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Minutes since the ops-day rollover, for an HH:mm in desk time. */
function minutesIntoOpsDay(hour: number, minute: number): number {
  return (hour * 60 + minute - OPS_DAY_START_HOUR * 60 + 1440) % 1440;
}

/**
 * The slot a handover time falls in — the nearest configured slot, 1-based.
 * Only ever used for the FIRST handover of an ops day.
 */
export function slotFromClock(at: Date): number {
  const p = deskParts(at);
  const rel = minutesIntoOpsDay(p.hour, p.minute);
  let best = 0;
  let bestDiff = Infinity;
  HANDOVER_SLOTS.forEach((slot, i) => {
    const [h, m] = slot.split(':');
    const target = minutesIntoOpsDay(Number(h), Number(m || 0));
    // Circular distance: 23:50 is ten minutes from a 00:00 slot, not 23h50.
    const raw = Math.abs(rel - target);
    const diff = Math.min(raw, 1440 - raw);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  });
  return best + 1;
}

/**
 * The number to give the shift now ending.
 *
 * `slotsAlreadyEnded` is every slot number already recorded for this ops day.
 * Empty means this is the first handover of the day and the clock decides;
 * otherwise it is simply one past the highest, whatever the clock says.
 */
export function nextSlot(endedAt: Date, slotsAlreadyEnded: number[]): number {
  if (!slotsAlreadyEnded.length) return slotFromClock(endedAt);
  return Math.max(...slotsAlreadyEnded) + 1;
}

/** How many shifts a full day is expected to have — for "shift 2 of 3". */
export function slotsPerDay(slotsUsed: number[]): number {
  return Math.max(HANDOVER_SLOTS.length, ...slotsUsed, 1);
}

/**
 * The shift name suggested for a start time. A suggestion only — the agent
 * picks, because an ad-hoc shift is not a clock reading.
 */
export function suggestShiftName(at: Date): string {
  const p = deskParts(at);
  if (p.hour >= 6 && p.hour < 14) return 'Morning';
  if (p.hour >= 14 && p.hour < 22) return 'Evening';
  return 'Night';
}
