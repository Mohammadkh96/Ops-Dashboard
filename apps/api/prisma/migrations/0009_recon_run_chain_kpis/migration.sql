-- Chain-level run figures. Reconciliation now issues one verdict per
-- transaction across the whole CRM → Paymaxis → PSP chain, so a run is summarised
-- by how many transactions reconciled out of those in scope — not by two
-- per-layer match rates, which were partial views of the same number and read as
-- a contradiction in the history table. Existing rows keep their per-layer
-- counts and default to 0 here; the UI falls back to the old pair for them.
ALTER TABLE "ReconRun" ADD COLUMN IF NOT EXISTS "reconciled" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReconRun" ADD COLUMN IF NOT EXISTS "inScope" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReconRun" ADD COLUMN IF NOT EXISTS "p1" INTEGER NOT NULL DEFAULT 0;
