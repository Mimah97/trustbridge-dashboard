-- Migration: add_api_key_model
-- Adds the ApiKey table for hashed maintainer API keys used by cron exports.
-- Raw keys are never stored; only the SHA-256 hex digest is persisted.

CREATE TABLE "ApiKey" (
    "id"              TEXT NOT NULL,
    "maintainerOrgId" TEXT NOT NULL DEFAULT 'default',
    "keyHash"         TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "scopes"          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdById"     TEXT NOT NULL,
    "expiresAt"       TIMESTAMP(3),
    "lastUsedAt"      TIMESTAMP(3),
    "revokedAt"       TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- Unique constraint on the hash so a key can be looked up in O(1).
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- Index used by the management list endpoint (all keys for a creator).
CREATE INDEX "ApiKey_createdById_idx" ON "ApiKey"("createdById");

-- Index used by audit / admin list queries ordered by creation time.
CREATE INDEX "ApiKey_createdAt_idx" ON "ApiKey"("createdAt");

-- Index used by stale-key audits / ops dashboards that sort by last usage.
-- NULLs (never-used keys) sort last under DESC, which is the desired order.
CREATE INDEX "ApiKey_lastUsedAt_idx" ON "ApiKey"("lastUsedAt");

-- Foreign key: cascade-delete API keys when their creator is removed.
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
