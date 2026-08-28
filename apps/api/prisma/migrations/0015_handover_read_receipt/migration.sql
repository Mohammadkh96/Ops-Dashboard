-- The handover a shift's opener read before starting, and when.
--
-- Both nullable, and deliberately not backfilled: every shift that already
-- exists was started before there was anything to read, and writing a plausible
-- value into those rows would turn "we do not know" into a false record of
-- somebody having read something.
ALTER TABLE "Shift" ADD COLUMN "readHandoverOf" TEXT;
ALTER TABLE "Shift" ADD COLUMN "handoverReadAt" TIMESTAMP(3);
