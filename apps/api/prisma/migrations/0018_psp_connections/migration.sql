-- Payment providers this dashboard talks to directly.
--
-- Configuration rather than one table per provider: seven arrived at once and
-- more will follow, and the "Add PSP" button exists so that adding one is a
-- form rather than a release.
--
-- The credential columns hold AES-256-GCM ciphertext, never plaintext. The key
-- lives in CREDENTIALS_KEY in the host environment, so a stolen dump of this
-- table is ciphertext and nothing else.
CREATE TABLE "PspConnection" (
    "id"           TEXT NOT NULL,
    "terminal"     TEXT NOT NULL,
    "provider"     TEXT NOT NULL,
    "label"        TEXT NOT NULL,
    "baseUrl"      TEXT,
    "authMode"     TEXT NOT NULL DEFAULT 'bearer',
    "authName"     TEXT,
    "apiKeyEnc"    TEXT,
    "apiSecretEnc" TEXT,
    "keyHint"      TEXT,
    "endpoints"    JSONB NOT NULL DEFAULT '{}',
    "enabled"      BOOLEAN NOT NULL DEFAULT false,
    "lastOkAt"     TIMESTAMP(3),
    "lastTriedAt"  TIMESTAMP(3),
    "lastError"    TEXT,
    "balances"     JSONB,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PspConnection_pkey" PRIMARY KEY ("id")
);

-- The terminal name is the join back to the payment data already stored, so it
-- has to be unique and has to be kept exactly as Paymaxis reports it.
CREATE UNIQUE INDEX "PspConnection_terminal_key" ON "PspConnection"("terminal");
CREATE INDEX "PspConnection_provider_idx" ON "PspConnection"("provider");
CREATE INDEX "PspConnection_enabled_idx" ON "PspConnection"("enabled");
