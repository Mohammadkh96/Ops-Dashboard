-- The provider's cut, which leaves the balance and was never counted.
--
-- ForumPay reports a fee on every transaction and it is NOT inside the amount:
-- a payout of 1,570.45 also costs a processing fee, so the balance falls by
-- more than the payout. The estimate came out about 0.2% high, in one
-- direction, exactly as an unaccounted percentage does.
--
-- Nullable and only filled where a fee field is configured. Most providers do
-- not report one per transaction, and for those nothing changes.
ALTER TABLE "PspTransaction"
  ADD COLUMN "fee" DECIMAL(20,8);

-- And what the fees came to when the balance was entered.
--
-- The arithmetic does not need this: fees are inside the out total already, so
-- the difference between two out totals carries them. This is so the screen can
-- SAY how much of an outflow was the provider's cut rather than payments —
-- which is the question somebody asks when the estimate and the portal
-- disagree by three dollars.
ALTER TABLE "PspBalanceAnchor"
  ADD COLUMN "baselineFees" DECIMAL(20,8);
