-- When the money actually moved, as distinct from when the payment was raised.
--
-- ForumPay stamps `inserted` when a payment is CREATED and `settled` when it
-- completes, and those are routinely days apart: a payment raised on the 31st
-- that confirms on the 2nd moved money on the 2nd. The balance places a
-- transaction against its anchor by date, so a payment created before the
-- anchor and settled after it was counted as "already inside the anchor
-- figure" — and never counted at all. It is invisible rather than wrong, which
-- is worse: nothing on the screen says a payment went missing.
--
-- Nullable, and the created date stands in where it is null. Most providers
-- report one timestamp and for them nothing changes.
ALTER TABLE "PspTransaction"
  ADD COLUMN "settledAt" TIMESTAMP(3);

-- The balance asks for everything that moved after a given instant, which is
-- this column falling back to occurredAt.
CREATE INDEX "PspTransaction_connectionId_settledAt_idx"
  ON "PspTransaction"("connectionId", "settledAt");
