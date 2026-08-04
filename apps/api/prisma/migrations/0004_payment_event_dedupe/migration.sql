
-- AlterTable
ALTER TABLE "PaymentEvent" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'webhook';

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_dedupeKey_key" ON "PaymentEvent"("dedupeKey");

