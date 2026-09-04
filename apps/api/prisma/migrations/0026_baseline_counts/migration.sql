-- How many payments made up each side of an anchor's baseline totals.
--
-- A provider's charge comes in two shapes and only the counts tell them apart.
-- ForumPay takes a percentage of the money moved; Match2Pay takes a flat amount
-- per payment, which looks like a wildly unstable percentage because blockchain
-- gas costs the same to move 20 dollars as 2,000. Choosing between the two
-- means fitting both against the corrections already recorded -- and the flat
-- shape cannot be fitted at all without knowing how many payments each
-- correction covered.
--
-- Null on every existing anchor, which is correct: an anchor taken before this
-- column existed cannot say, and the fit skips the intervals it cannot measure
-- rather than guessing at them.
ALTER TABLE "PspBalanceAnchor" ADD COLUMN "baselineCountIn" INTEGER;
ALTER TABLE "PspBalanceAnchor" ADD COLUMN "baselineCountOut" INTEGER;
