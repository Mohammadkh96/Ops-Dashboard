// Which day a shift belongs to, and which shift of that day it is — pinned.
//
// Every rule here was learned the expensive way on the desk's spreadsheet: a
// handover filed under the wrong day, a shift number skipped because someone
// was late, a weekend prompt firing twice because a weekday was read off the
// server's UTC clock instead of Amman's. None of those look like bugs when
// they happen — they look like someone made a mistake.
//
//   npx tsx scripts/check-ops-day.ts

import {
  deskDate,
  deskParts,
  deskTime,
  nextSlot,
  opsDay,
  slotFromClock,
  slotsPerDay,
  suggestShiftName,
} from '../src/shifts/ops-day';

let failures = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`ok    ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`,
    );
  }
}
const section = (t: string) => console.log(`\n── ${t} ──`);

/** An instant, written as the desk would say it (Amman is UTC+3, no DST). */
const desk = (s: string) => new Date(`${s}:00+03:00`);

section('the clock is read in Amman, not UTC');
{
  // The case that broke the spreadsheet: 00:05 in Amman is 21:05 UTC the day
  // before. Read off the server's clock, the date, the weekday and therefore
  // the whole ops day are wrong.
  const midnightish = desk('2026-08-26T00:05');
  ok(
    "date is the desk's date",
    deskDate(midnightish) === '2026-08-26',
    deskDate(midnightish),
  );
  ok(
    "time is the desk's time",
    deskTime(midnightish) === '00:05',
    deskTime(midnightish),
  );
  ok(
    'the UTC date would have been the previous day',
    midnightish.toISOString().slice(0, 10) === '2026-08-25',
  );
  // Wednesday 26 Aug 2026.
  ok(
    "weekday is the desk's weekday",
    deskParts(midnightish).weekday === 3,
    deskParts(midnightish).weekday,
  );
}

section('the ops day breaks at 04:00, not midnight');
{
  ok(
    '23:58 belongs to that day',
    opsDay(desk('2026-08-25T23:58')) === '2026-08-25',
  );
  // The whole reason the boundary moved: these two are minutes apart and used
  // to land on different days.
  ok(
    '00:03 still belongs to the PREVIOUS day',
    opsDay(desk('2026-08-26T00:03')) === '2026-08-25',
    opsDay(desk('2026-08-26T00:03')),
  );
  ok(
    '03:59 still the previous day',
    opsDay(desk('2026-08-26T03:59')) === '2026-08-25',
  );
  ok(
    '04:00 starts the new day',
    opsDay(desk('2026-08-26T04:00')) === '2026-08-26',
  );
  ok('08:00 is the new day', opsDay(desk('2026-08-26T08:00')) === '2026-08-26');

  // Month and year ends, where naive date arithmetic breaks.
  ok(
    '01:00 on the 1st rolls back a month',
    opsDay(desk('2026-09-01T01:00')) === '2026-08-31',
    opsDay(desk('2026-09-01T01:00')),
  );
  ok(
    '01:00 on 1 Jan rolls back a year',
    opsDay(desk('2026-01-01T01:00')) === '2025-12-31',
    opsDay(desk('2026-01-01T01:00')),
  );
  ok(
    '01:00 on 1 Mar in a leap year',
    opsDay(desk('2028-03-01T01:00')) === '2028-02-29',
    opsDay(desk('2028-03-01T01:00')),
  );
}

section('the first handover of a day is numbered from the clock');
{
  ok('08:00 → shift 1', slotFromClock(desk('2026-08-26T08:00')) === 1);
  ok('07:30 → shift 1', slotFromClock(desk('2026-08-26T07:30')) === 1);
  ok('16:05 → shift 2', slotFromClock(desk('2026-08-26T16:05')) === 2);
  ok(
    '00:02 → shift 3',
    slotFromClock(desk('2026-08-26T00:02')) === 3,
    slotFromClock(desk('2026-08-26T00:02')),
  );
  // 23:50 is ten minutes from the 00:00 slot, not twenty-three hours. Measuring
  // that distance linearly put the last handover of the night in slot 2.
  ok(
    '23:50 → shift 3, measured the short way round',
    slotFromClock(desk('2026-08-26T23:50')) === 3,
    slotFromClock(desk('2026-08-26T23:50')),
  );

  // A day that opens in the afternoon opens at shift 2 — it does not pretend a
  // morning shift happened.
  ok(
    'a day whose first handover is at 16:00 opens at 2',
    nextSlot(desk('2026-08-26T16:00'), []) === 2,
  );
}

section('after the first, the sequence carries itself');
{
  // THE rule people get wrong. An agent handing over at 18:40 instead of 16:00
  // is still shift 2 — numbering from the clock again would make them shift 2
  // as well here, so use a case where the clock would actually skip:
  ok(
    'late handover keeps its place in the sequence',
    nextSlot(desk('2026-08-26T21:10'), [1]) === 2,
    nextSlot(desk('2026-08-26T21:10'), [1]),
  );
  ok(
    '...where the clock alone would have said 3',
    slotFromClock(desk('2026-08-26T21:10')) === 3,
  );

  // ...and an early one does not repeat the previous number.
  ok(
    'early handover still advances',
    nextSlot(desk('2026-08-26T14:30'), [1]) === 2,
  );
  ok('third shift', nextSlot(desk('2026-08-27T00:05'), [1, 2]) === 3);
  // A fourth shift adds a number rather than resetting the day.
  ok(
    'a fourth shift becomes shift 4',
    nextSlot(desk('2026-08-27T02:00'), [1, 2, 3]) === 4,
  );
  ok('...and the day is then 4 long', slotsPerDay([1, 2, 3, 4]) === 4);
  ok('a normal day is 3 long', slotsPerDay([1, 2]) === 3);

  // A day that began at slot 2 continues 3, 4 — never back to 1.
  ok(
    'a day opened at 2 continues at 3',
    nextSlot(desk('2026-08-27T00:05'), [2]) === 3,
  );
}

section('shift names are suggested, not imposed');
{
  ok(
    '08:00 suggests Morning',
    suggestShiftName(desk('2026-08-26T08:00')) === 'Morning',
  );
  ok(
    '16:00 suggests Evening',
    suggestShiftName(desk('2026-08-26T16:00')) === 'Evening',
  );
  ok(
    '23:00 suggests Night',
    suggestShiftName(desk('2026-08-26T23:00')) === 'Night',
  );
  ok(
    '02:00 suggests Night',
    suggestShiftName(desk('2026-08-26T02:00')) === 'Night',
  );
}

console.log(
  failures ? `\n${failures} check(s) failed.` : '\nAll ops-day checks passed.',
);
process.exit(failures ? 1 : 0);
