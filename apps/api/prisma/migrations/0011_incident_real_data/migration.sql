-- Incidents become a real record rather than a list of rows.
--
-- ref: a stable human reference. The list used to number rows by position, so
-- INC-104 became INC-103 the moment an older incident was opened — a reference
-- nobody could quote in a handover.
-- source/signature: an incident declared from a detector condition carries that
-- condition's signature, so re-declaring a still-live condition reopens the same
-- incident instead of creating a second one.
-- evidence: the numbers that justified it, captured at declaration. A detection
-- is transient; an hour later there is nothing left to check it against.
-- timeline: append-only [{at, text, by}] — what actually happened, in order.
ALTER TABLE "Incident" ADD COLUMN IF NOT EXISTS "ref" SERIAL;
ALTER TABLE "Incident" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'DECLARED';
ALTER TABLE "Incident" ADD COLUMN IF NOT EXISTS "signature" TEXT;
ALTER TABLE "Incident" ADD COLUMN IF NOT EXISTS "evidence" JSONB;
ALTER TABLE "Incident" ADD COLUMN IF NOT EXISTS "timeline" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Incident" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS "Incident_signature_key" ON "Incident"("signature");
