-- KycCase becomes one row per VERIFICATION, not one per client.
--
-- The provider's own export forced the distinction. A client is verified as
-- many times as it takes: CU447 appears four times in one afternoon -- invalid,
-- invalid, invalid, valid -- CU702 four times, CU643 three. One row per client
-- would keep whichever attempt was imported last and discard the history that
-- explains it, which is precisely the history a compliance officer is asked
-- about. The client's CURRENT standing is derived from these rows instead.
--
-- clientId becomes NULLABLE, and that is deliberate rather than lax. The export
-- carries verifications with no external applicant id at all -- an application
-- abandoned or duplicated before it reached an account. It still cost money,
-- still carries a decline reason, and still belongs in the count. Requiring a
-- client would drop those silently, which is the one thing a compliance record
-- must never do.
ALTER TABLE "KycCase" ALTER COLUMN "clientId" DROP NOT NULL;

-- The foreign key has to be rebuilt, not just relaxed. A REQUIRED relation
-- defaults to ON DELETE RESTRICT and an OPTIONAL one to SET NULL, so dropping
-- the NOT NULL alone leaves the constraint describing the old shape -- a
-- difference that is invisible until someone deletes a client and gets a
-- restriction the schema says should not exist.
ALTER TABLE "KycCase" DROP CONSTRAINT "KycCase_clientId_fkey";
ALTER TABLE "KycCase" ADD CONSTRAINT "KycCase_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- What the provider said, kept in the provider's own words.
--
-- providerStatus is verbatim on purpose: the same vendor says "VALID" in its
-- export and "completed" in its callback, so a mapping onto our own enum has to
-- be redoable without re-importing anything.
--
-- "form" is not decoration. One entity's form runs PROFILE, DOCUMENT, FACIAL,
-- ADDRESS and DATABASE_SCREENING; the other omits ADDRESS. It is the only field
-- that records that two clients were held to different standards.
ALTER TABLE "KycCase" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'kycaid';
ALTER TABLE "KycCase" ADD COLUMN "verificationId" TEXT;
ALTER TABLE "KycCase" ADD COLUMN "applicantId" TEXT;
ALTER TABLE "KycCase" ADD COLUMN "providerStatus" TEXT;
ALTER TABLE "KycCase" ADD COLUMN "form" TEXT;
ALTER TABLE "KycCase" ADD COLUMN "method" TEXT;
ALTER TABLE "KycCase" ADD COLUMN "declineReasons" TEXT[];
ALTER TABLE "KycCase" ADD COLUMN "priceEur" DECIMAL(10,2);
ALTER TABLE "KycCase" ADD COLUMN "processingMin" INTEGER;

-- The whole row as it arrived. A field nobody mapped today is the one a dispute
-- needs next month, and a KYC export cannot always be pulled again.
ALTER TABLE "KycCase" ADD COLUMN "raw" JSONB;

-- The natural key: re-importing the same export updates rather than duplicates.
CREATE UNIQUE INDEX "KycCase_provider_verificationId_key"
  ON "KycCase"("provider", "verificationId");
CREATE INDEX "KycCase_applicantId_idx" ON "KycCase"("applicantId");
CREATE INDEX "KycCase_submittedAt_idx" ON "KycCase"("submittedAt");
