
-- AlterTable
ALTER TABLE "PaymentEvent" ADD COLUMN     "cryptoTxHash" TEXT,
ADD COLUMN     "parentPaymentId" TEXT,
ADD COLUMN     "psp" TEXT;

