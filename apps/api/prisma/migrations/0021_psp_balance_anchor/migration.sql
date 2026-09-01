-- A balance for providers that will not tell us one.
--
-- ForumPay's portal shows a USD figure that no documented endpoint returns;
-- Match2Pay has no read API at all. So the balance is ANCHORED — somebody
-- enters the true figure once, off the portal — and then MOVED by the
-- transactions we already store.
--
-- The anchors are a TABLE, not a column, for one reason: an estimate that is
-- corrected in place hides how wrong it was. Keeping every anchor keeps the
-- estimate that it replaced beside it, so the desk can see the drift in
-- pounds and decide how often the portal actually needs checking. That drift
-- is the honest part of this feature — fees, conversion spread, settlements
-- and manual adjustments inside the portal are all invisible to us, and they
-- compound.

-- Which of the provider's own words add to the balance and which subtract.
--
-- JSON because the vocabulary is the provider's: ForumPay says "Sell" and
-- "Buy", Paymaxis says "DEPOSIT" and "WITHDRAWAL", and a column per provider
-- would be a migration every time one is added.
ALTER TABLE "PspConnection"
  ADD COLUMN "movementRules" JSONB;

CREATE TABLE "PspBalanceAnchor" (
    "id"           TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,

    -- The figure as the portal showed it, and the moment it was true. Those
    -- are different from when it was typed in: somebody reads the portal at
    -- 14:20 and enters it at 14:35, and the transactions in between must not
    -- be counted twice.
    "amount"   DECIMAL(20,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "takenAt"  TIMESTAMP(3) NOT NULL,

    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enteredBy" TEXT,
    "note"      TEXT,

    -- What we were estimating the instant before this anchor replaced it, and
    -- the gap. Null on the first anchor, which had nothing to be wrong about.
    "estimateWas" DECIMAL(20,8),
    "drift"       DECIMAL(20,8),

    CONSTRAINT "PspBalanceAnchor_pkey" PRIMARY KEY ("id")
);

-- The current anchor is the newest by takenAt, which is the only query this
-- table serves besides the history list.
CREATE INDEX "PspBalanceAnchor_connectionId_takenAt_idx"
  ON "PspBalanceAnchor"("connectionId", "takenAt" DESC);

ALTER TABLE "PspBalanceAnchor"
  ADD CONSTRAINT "PspBalanceAnchor_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "PspConnection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
