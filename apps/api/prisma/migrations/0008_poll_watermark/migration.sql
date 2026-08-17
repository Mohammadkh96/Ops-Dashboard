-- Persisted poll watermarks. The poller kept these in memory, which resets on
-- every serverless invocation; storing them makes the poller stateless.
CREATE TABLE IF NOT EXISTS "PollWatermark" (
    "key" TEXT NOT NULL,
    "since" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollWatermark_pkey" PRIMARY KEY ("key")
);
