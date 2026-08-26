-- A payment's identity stops depending on when we happened to read it.
--
-- dedupeKey used to be provider:id:state:exact-timestamp. That deduped the API
-- against itself perfectly — every re-read of an unchanged payment carries the
-- same timestamp — and could not dedupe the API against anything else. A
-- console export writes timestamps to the second, in the operator's timezone,
-- and states in Title Case; the API returns milliseconds, UTC and SHOUTING.
-- Neither difference says anything about the payment, and both made the key
-- differ, so importing a period that was already polled stored every payment in
-- it twice. An import of 70,023 rows across a period being polled daily
-- reported "0 already held", which is the number you get when nothing can ever
-- match.
--
-- This rewrites the existing keys to provider:id:state and collapses whatever
-- that reveals as duplicates. It is a no-op on a database that only ever held
-- one source.

ALTER TABLE "PaymentEvent" ADD COLUMN "identity" TEXT;

-- Rows with neither an id nor a reference cannot be keyed at all; they keep
-- whatever key they have (dedupeKey is nullable and a NULL never collides).
UPDATE "PaymentEvent"
SET "identity" =
  provider || ':' ||
  COALESCE(NULLIF(btrim("paymentId"), ''), NULLIF(btrim("reference"), '')) || ':' ||
  UPPER(regexp_replace(btrim(COALESCE("state", '')), '[[:space:]-]+', '_', 'g'))
WHERE COALESCE(NULLIF(btrim("paymentId"), ''), NULLIF(btrim("reference"), '')) IS NOT NULL;

-- Keep ONE row per payment-state. Preference, in order:
--   • a webhook over a poll over an import — the provider's own callback
--     carries the fullest payload, an export the thinnest;
--   • a row that has a date over one that does not;
--   • the earliest received, so the record keeps the moment we first saw it.
DELETE FROM "PaymentEvent" p
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY "identity"
           ORDER BY
             CASE "source"
               WHEN 'webhook' THEN 0
               WHEN 'poll' THEN 1
               ELSE 2
             END,
             ("occurredAt" IS NULL),
             "receivedAt"
         ) AS rn
  FROM "PaymentEvent"
  WHERE "identity" IS NOT NULL
) dup
WHERE p."id" = dup."id" AND dup.rn > 1;

UPDATE "PaymentEvent" SET "dedupeKey" = "identity" WHERE "identity" IS NOT NULL;

ALTER TABLE "PaymentEvent" DROP COLUMN "identity";
