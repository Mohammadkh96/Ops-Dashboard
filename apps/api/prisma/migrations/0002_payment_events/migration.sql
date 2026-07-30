
-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureOk" BOOLEAN NOT NULL DEFAULT false,
    "eventType" TEXT,
    "paymentId" TEXT,
    "reference" TEXT,
    "shop" TEXT,
    "state" TEXT,
    "type" TEXT,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT,
    "customer" TEXT,
    "occurredAt" TIMESTAMP(3),
    "headers" JSONB NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentEvent_receivedAt_idx" ON "PaymentEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "PaymentEvent_provider_paymentId_idx" ON "PaymentEvent"("provider", "paymentId");

-- CreateIndex
CREATE INDEX "PaymentEvent_reference_idx" ON "PaymentEvent"("reference");

