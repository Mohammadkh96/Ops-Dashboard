-- Who the person is, which check failed, and what they presented.
--
-- A REVERSAL, AND IT IS WORTH SAYING SO IN THE SCHEMA. This table was built to
-- hold no identity data at all: the verifications report carries name, date of
-- birth, email, phone, tax id, wallet address and telegram username, and the
-- reader dropped every one of them before anything was stored, so that the
-- dashboard could not become a second copy of the CRM's identity records held
-- to a lower standard. The compliance desk asked for them, which is a decision
-- the desk is entitled to make — and it changes what this database is. From
-- this migration on, retention, access control and deletion obligations apply
-- here the way they apply to the CRM.
--
-- The identity columns cost nothing in requests: every one was already present
-- in the report rows the sync reads and was being discarded.
--
-- The other two groups are not free. `failedChecks` comes from
-- GET /verifications/{id} and the document fields from GET /applicants/{id} —
-- one request per verification each, against forty thousand rows — so they are
-- filled by an enrichment pass that walks "never asked, newest first" in
-- batches, not by the sync. That is what the two `…FetchedAt` columns are for:
-- NULL means nobody has asked yet, which is a different fact from "asked, and
-- nothing failed". A screen that cannot tell those apart reports a verification
-- as clean when the truth is that it has never been looked at.
ALTER TABLE "KycCase"
  ADD COLUMN "applicantName"      TEXT,
  ADD COLUMN "dob"                TEXT,
  ADD COLUMN "email"              TEXT,
  ADD COLUMN "phone"              TEXT,
  ADD COLUMN "taxIdNumber"        TEXT,
  ADD COLUMN "walletAddress"      TEXT,
  ADD COLUMN "telegramUsername"   TEXT,
  ADD COLUMN "failedChecks"       TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "checkComments"      JSONB,
  ADD COLUMN "providerVerified"   BOOLEAN,
  ADD COLUMN "checksFetchedAt"    TIMESTAMP(3),
  ADD COLUMN "documents"          JSONB,
  ADD COLUMN "documentExpiry"     TIMESTAMP(3),
  ADD COLUMN "nationality"        TEXT,
  ADD COLUMN "residenceCountry"   TEXT,
  ADD COLUMN "gender"             TEXT,
  ADD COLUMN "applicantFetchedAt" TIMESTAMP(3);

-- "Expiring within 90 days" is a range scan over the whole table, and the two
-- enrichment passes each walk "IS NULL, newest first" every batch. Without
-- these three, both are sequential scans of forty thousand rows, repeatedly.
CREATE INDEX "KycCase_documentExpiry_idx"     ON "KycCase"("documentExpiry");
CREATE INDEX "KycCase_checksFetchedAt_idx"    ON "KycCase"("checksFetchedAt");
CREATE INDEX "KycCase_applicantFetchedAt_idx" ON "KycCase"("applicantFetchedAt");
