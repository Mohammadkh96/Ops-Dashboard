-- Cursor for the historical import. The poller reads newest-first and stops at
-- the first page it already knows, so payments older than the day polling
-- started never arrive; this lets a separate pass walk deeper in bounded slices
-- and resume where it stopped, which a 60-second serverless invocation must be
-- able to do or the walk can never finish.
CREATE TABLE IF NOT EXISTS "PaymaxisBackfill" (
    "shopId" TEXT NOT NULL,
    "nextPage" INTEGER NOT NULL DEFAULT 0,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "stored" INTEGER NOT NULL DEFAULT 0,
    "oldestSeen" TIMESTAMP(3),
    "done" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "claimedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymaxisBackfill_pkey" PRIMARY KEY ("shopId")
);
