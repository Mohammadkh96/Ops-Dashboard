-- Which KYCAID account a verification came from.
--
-- The two entities -- Tradin Mauritius and Tradin Saint Lucia -- hold SEPARATE
-- KYCAID accounts with separate API tokens. A token reads one of them and
-- cannot see the other, so every verification belongs to exactly one entity
-- and the account is the fact that says which.
--
-- The form was standing in for this and is the weaker record: a form can be
-- renamed, a console export need not carry it, and nothing stops two accounts
-- from naming a form the same thing. The account comes from the credential
-- that fetched the row, so it cannot be wrong about which entity paid for it.
--
-- Nullable: the console export carries no account either, so every row loaded
-- from a file predates this. Unknown is the honest value for those, and a
-- re-fetch of those days fills it in.
ALTER TABLE "KycCase" ADD COLUMN "account" TEXT;

CREATE INDEX "KycCase_account_idx" ON "KycCase"("account");
