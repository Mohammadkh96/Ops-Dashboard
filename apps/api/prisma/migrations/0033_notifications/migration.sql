-- Something the desk should be told about, and what was done to tell them.
--
-- A ROW PER CONDITION, NOT PER CHECK. The detectors run on every cron and every
-- time somebody has the dashboard open; a PSP that has been failing since
-- Tuesday is one thing that happened, not four hundred. A condition still true
-- moves `lastSeenAt` on the notification it already has, and only one nobody
-- has been told about within the cool-off creates a new row and sends mail.
-- The alternative is a feed nobody reads, which is no alerting at all with
-- extra cost.
--
-- `emailedAt` and `emailError` are kept because "was anybody actually told" is
-- a question asked after an incident, not during one — and a mailer that is
-- not configured has to say so rather than silently doing nothing. The
-- notification stands whether or not the mail went out.

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT[],
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emailedAt" TIMESTAMP(3),
    "emailTo" TEXT[],
    "emailError" TEXT,
    "readAt" TIMESTAMP(3),
    "readBy" TEXT,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_signature_idx" ON "Notification"("signature");

-- CreateIndex
CREATE INDEX "Notification_readAt_idx" ON "Notification"("readAt");
