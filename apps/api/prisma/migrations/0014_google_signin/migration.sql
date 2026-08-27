-- Signing in with a company Google account.
--
-- Sign-in matches on the VERIFIED email from Google, so this column is not what
-- authenticates anybody. It is recorded on first Google sign-in so it is
-- visible later which accounts can use that door, and so a re-used address
-- cannot silently inherit a different person's account: Google's subject id is
-- stable for a person, where an email address is only stable for a mailbox.
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
