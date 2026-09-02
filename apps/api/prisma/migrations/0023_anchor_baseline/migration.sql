-- What was already counted when the balance was entered.
--
-- The balance used to work by DATE: everything that moved after the anchor is
-- movement. That needs a per-provider "when did the money move" timestamp, and
-- it keeps being the wrong one. ForumPay stamps a payment when it is RAISED,
-- so one raised on the 31st and settled on the 2nd sat before an anchor taken
-- on the 2nd and never counted. Paymaxis is worse: its PENDING and COMPLETED
-- events carry the SAME occurredAt, so no field exists that could place the
-- payment correctly, and every late settlement was lost for good.
--
-- So the anchor now records the TOTAL that was already counting when it was
-- taken, and movement is arithmetic on two totals rather than a date filter:
--
--   movement = counting now - counting when the balance was entered
--
-- A payment pending at the anchor and confirmed later is absent from the first
-- total and present in the second, so it counts — with no settlement timestamp
-- needed, identically for every provider. A payment already confirmed appears
-- in both and cancels out. And a payment that was confirmed and is later
-- cancelled or refunded now REDUCES the estimate, which the date filter could
-- not express at all.
--
-- In and out separately, so the screen can still show what came in and what
-- went out since, consistent with the net rather than computed a second way.
ALTER TABLE "PspBalanceAnchor"
  ADD COLUMN "baselineIn"  DECIMAL(20,8),
  ADD COLUMN "baselineOut" DECIMAL(20,8),
  -- The rules the two totals above were measured under. Change which words
  -- count and the baseline is measuring something else — the comparison stops
  -- being like-for-like, and the screen has to say so rather than quietly
  -- reporting the difference between two different questions.
  ADD COLUMN "baselineRules" JSONB;
