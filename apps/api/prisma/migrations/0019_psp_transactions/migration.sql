-- Stored provider transactions, and where the last sync got to.
--
-- Stored, unlike the balance: a ledger has to be paged through fifty rows at a
-- time, and re-fetching two and a half thousand records to look at yesterday is
-- slow for us and load on somebody else's API.

ALTER TABLE "PspConnection"
  ADD COLUMN "lastSyncAt"      TIMESTAMP(3),
  ADD COLUMN "lastSyncPages"   INTEGER,
  ADD COLUMN "lastSyncFetched" INTEGER;

CREATE TABLE "PspTransaction" (
    "id"           TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "terminal"     TEXT NOT NULL,
    "externalId"   TEXT NOT NULL,
    "reference"    TEXT,
    "direction"    TEXT,
    "status"       TEXT,
    -- 20,8 rather than money: several of these terminals settle in crypto, and
    -- 0.00701648 BTC rounded to two places is zero.
    "amount"       DECIMAL(20,8),
    "currency"     TEXT,
    "occurredAt"   TIMESTAMP(3),
    "rawAt"        TEXT,
    "customer"     TEXT,
    "raw"          JSONB NOT NULL,
    "firstSeenAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PspTransaction_pkey" PRIMARY KEY ("id")
);

-- What makes a re-sync update a row rather than duplicate it.
CREATE UNIQUE INDEX "PspTransaction_connectionId_externalId_key"
  ON "PspTransaction"("connectionId", "externalId");

CREATE INDEX "PspTransaction_connectionId_occurredAt_idx"
  ON "PspTransaction"("connectionId", "occurredAt");
CREATE INDEX "PspTransaction_terminal_occurredAt_idx"
  ON "PspTransaction"("terminal", "occurredAt");
CREATE INDEX "PspTransaction_status_idx" ON "PspTransaction"("status");

-- Cascade: a connection that is deleted takes its rows with it. They are a
-- cache of somebody else's ledger, not a record we are the custodian of.
ALTER TABLE "PspTransaction"
  ADD CONSTRAINT "PspTransaction_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "PspConnection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
