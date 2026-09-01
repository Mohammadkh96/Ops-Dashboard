-- Where a terminal's transactions come from.
--
-- Several providers have no read API at all. Match2Pay publishes two
-- endpoints, both of which create money movements, and pushes everything else
-- by callback — to Paymaxis, which already imports it into PaymentEvent keyed
-- by terminal. Those transactions were in this database the whole time; what
-- was missing was a screen that knew to look there instead of at an API that
-- does not exist.
ALTER TABLE "PspConnection"
  ADD COLUMN "ledgerSource" TEXT NOT NULL DEFAULT 'provider';
