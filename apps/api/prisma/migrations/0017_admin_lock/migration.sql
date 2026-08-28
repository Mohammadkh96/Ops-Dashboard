-- A second password, for the Admin tab only.
--
-- Nullable and unset for everybody: a migration cannot invent a passphrase, and
-- defaulting one would be a shared credential written into a file. Each
-- administrator sets their own the first time they open the tab.
ALTER TABLE "User" ADD COLUMN "adminPassHash" TEXT;
ALTER TABLE "User" ADD COLUMN "adminPassSetAt" TIMESTAMP(3);

-- A second password is worth nothing if somebody who already has a session can
-- guess at it a thousand times a minute.
ALTER TABLE "User" ADD COLUMN "adminFails" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "adminLockedUntil" TIMESTAMP(3);
