# API Keys

Maintainers can create short-lived API keys that gate treasury export automation
and other privileged operations without sharing GitHub credentials.

← Back to [ARCHITECTURE.md](./ARCHITECTURE.md) | [README](../README.md)

---

## Overview

| Route | Method | Guard | Purpose |
|-------|--------|-------|---------|
| `/api/settings/api-keys` | `GET` | Maintainer session | List all keys (no raw value) |
| `/api/settings/api-keys` | `POST` | Maintainer session + CSRF | Create key — raw value returned once |
| `/api/settings/api-keys/[id]` | `DELETE` | Maintainer session + CSRF | Revoke key (soft delete) |

---

## Key lifecycle

```
Create → raw key shown once → stored as SHA-256 hash only
         ↓
      Active (revokedAt = null)
         ↓
      Revoke → revokedAt = now()   ← soft delete, row retained for audit
```

The raw key is **never stored**. Only its SHA-256 hex digest (`keyHash`) is
persisted in the `ApiKey` table. If a key is lost after creation it cannot be
recovered — create a new one and revoke the old one.

---

## Scopes

| Scope | Description |
|-------|-------------|
| `treasury:read` | Read treasury balances and contributor readiness |
| `treasury:export` | Download the Wave payout CSV |
| `contributors:read` | Read contributor registrations |
| `contributors:write` | Trigger re-checks and batch operations |

Scopes are stored as a `String[]` column on the `ApiKey` row and validated
server-side against `VALID_SCOPES` in `src/app/api/settings/api-keys/route.ts`.
An invalid scope in the `POST` body returns `400`.

---

## UI — ApiKeyPanel

`src/components/ApiKeyPanel.tsx` renders on the maintainer settings page.

### Test IDs (data-testid)

| testid | Element |
|--------|---------|
| `api-key-panel` | Root card |
| `maintainer-only-message` | Message shown to non-maintainers |
| `raw-key-banner` | One-time secret reveal banner |
| `raw-key-value` | `<code>` containing the raw key |
| `copy-raw-key-button` | Clipboard copy button |
| `dismiss-raw-key-button` | Banner dismiss button |
| `create-api-key-form` | Create form wrapper |
| `api-key-name-input` | Name text input |
| `scope-checkboxes` | Scope checkbox group wrapper |
| `scope-checkbox-{scope}` | Individual scope checkbox (e.g. `scope-checkbox-treasury:read`) |
| `create-api-key-button` | Submit button |
| `create-error` | Inline create error message |
| `api-key-list` | Existing keys list wrapper |
| `api-key-row-{id}` | Individual key row |
| `revoke-button-{id}` | Revoke button on an active key |
| `revoked-badge-{id}` | "Revoked" badge on a revoked key |
| `revoke-error` | Inline revoke error message |

---

## Security notes

- **One-time disclosure** — the raw key is returned in `POST` response body
  exactly once and never stored; it cannot be retrieved from the API afterwards.
- **Hash storage** — `ApiKey.keyHash` is a SHA-256 hex digest. It cannot be
  reversed to obtain the raw key.
- **Soft delete** — `DELETE` sets `revokedAt`; the row is retained for audit.
  Hard deletes are not supported through the API.
- **Maintainer-only** — all three endpoints verify `session.user.isMaintainer`.
  A non-maintainer (including an unauthenticated request) receives `403`.
- **CSRF** — `POST` and `DELETE` routes call `assertSameOrigin()` before
  touching the session.

---

## Database model

```prisma
model ApiKey {
  id        String    @id @default(cuid())
  name      String
  keyHash   String    @unique   // SHA-256 hex digest
  scopes    String[]
  createdAt DateTime  @default(now())
  revokedAt DateTime?           // null = active, non-null = revoked
}
```

---

## Testing

Tests live in `src/components/ApiKeyPanel.test.tsx` and cover:

- `GET` — 403 for unauthenticated / non-maintainer, 200 with key list for maintainer
- `POST` — CSRF guard, 403 for non-maintainer, 400 for missing name, 400 for
  invalid scope, 201 with `rawKey` present exactly once, hash stored not plaintext
- `DELETE` — CSRF guard, 403 for non-maintainer, 404 for missing id, 409 for
  already-revoked, 200 soft-delete with `revokedAt` set

Run with:

```bash
npm test
# or target just this file:
npx vitest run src/components/ApiKeyPanel.test.tsx
```
# Maintainer API Keys

← Back to [README](../README.md) · See also [Environment variables](./ENVIRONMENT.md) · [Architecture](./ARCHITECTURE.md)

---

## Why API keys?

Scheduled export jobs (cron, CI pipelines, treasury automation) need to call the contributor export endpoints without a human GitHub OAuth session. Forwarding a session cookie to a cron job is:

- **Fragile** — the cookie expires when the maintainer's session does.
- **Over-privileged** — a session carries the maintainer's full identity and all GitHub permissions.
- **Unauditable** — there is no way to distinguish a human export from an automated one in the audit log.

API keys solve all three problems: they are long-lived, scoped to the minimum required permission (`export:read`), and produce a distinct `actorLogin` (`api-key:<name>`) in every audit log entry.

---

## Security model

| Property | Detail |
|---|---|
| **Raw key** | Shown once at creation. Never stored in the database, never logged. |
| **Storage** | Only the SHA-256 hex digest (`keyHash`) is persisted in the `ApiKey` table. |
| **Key format** | `tb_<43 url-safe base64 chars>` (~258 bits of entropy from `crypto.randomBytes(32)`). |
| **Scope** | `export:read` — read-only access to `/api/contributors/export/*`. |
| **Expiry** | Optional ISO-8601 datetime. Expired keys are rejected at the DB lookup step. |
| **Revocation** | Soft-delete (`revokedAt` timestamp set on DELETE). Effective on the next request — no propagation delay. |
| **Rate limiting** | 60 requests per 60 seconds per source IP (in-process sliding window). Returns `429` with `RateLimit-*` / `Retry-After` headers. |
| **Max keys** | 10 active (non-revoked) keys per maintainer. Keeps credential inventory manageable. |
| **Audit trail** | `api_key.created`, `api_key.revoked`, `api_key.use_rejected` written to `AuditLog` on every relevant event. |
| **Plaintext guard** | `isValidApiKeyFormat()` rejects malformed values before the DB round-trip. |

### Scope bitmask

Scopes are submitted and stored as named strings (for example, `scopes: ["export:read"]`). Authorization maps those names to a bitmask so scope checks are composable; the database and API response remain string arrays.

| Scope | Bit | Mask | Permission |
|---|---:|---:|---|
| `export:read` | 0 | `1` (`0b0001`) | Read `/api/contributors/export/*` and `/api/treasury/export`; no write access |
| `cron:trigger` | 1 | `2` (`0b0010`) | Trigger `POST /api/cron/export` and `POST /api/cron/digest`; no session rights |

Bits are zero-based and masks are powers of two (`1 << bit`). Unknown scope names grant no permissions and are rejected when creating keys. The wildcard `*` is reserved for internal authorization use and cannot be created through the management API. New scopes must be assigned the next unused bit and added to the shared scope definitions before they are exposed.

> The rate limiter is in-process. On multi-instance deployments the effective limit is `N × 60` where N is the number of running instances. This is noted in `ENVIRONMENT.md` and acceptable for abuse prevention.

---

## Creating a key

### Via the settings UI

1. Go to `/dashboard/settings` (requires `operator` or `admin` role).
2. Find the **API keys** card.
3. Enter a descriptive name (e.g. `nightly-export-cron`) and click **Create key**.
  The scope badge tooltip shows its bit and mask; currently all UI-created keys use `export:read` (bit 0, mask 1).
4. Copy the secret from the green banner — it will **not** be shown again.
5. Store it in your CI/CD secret store (e.g. GitHub Actions secrets).

### Via the API (curl)

```bash
curl -X POST https://your-deployment.vercel.app/api/settings/api-keys \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=<your-session-cookie>" \
  -d '{"name": "nightly-export-cron", "scopes": ["export:read"]}'
```

Response (201):

```json
{
  "key": {
    "id": "cuid...",
    "name": "nightly-export-cron",
    "scopes": ["export:read"],
    "createdAt": "2026-09-25T00:00:00.000Z",
    "expiresAt": null,
    "secret": "tb_Abc123..."
  },
  "warning": "Store this secret now — it will not be shown again."
}
```

> The `secret` field appears only in this response. Subsequent `GET /api/settings/api-keys` requests return metadata only — no secret.

#### Optional: set an expiry

```bash
-d '{"name": "quarterly-audit", "scopes": ["export:read"], "expiresAt": "2027-01-01T00:00:00Z"}'
```

---

## Using a key

Pass the key as a `Bearer` token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer tb_Abc123..." \
  https://your-deployment.vercel.app/api/contributors/export/csv \
  -o contributors.csv
```

### GitHub Actions example

```yaml
name: Nightly treasury export

on:
  schedule:
    - cron: "0 2 * * *"   # 02:00 UTC daily

jobs:
  export:
    runs-on: ubuntu-latest
    steps:
      - name: Download contributor CSV
        run: |
          curl \
            --fail \
            --retry 3 \
            --retry-delay 30 \
            -H "Authorization: Bearer ${{ secrets.TRUSTBRIDGE_API_KEY }}" \
            "${{ vars.TRUSTBRIDGE_URL }}/api/contributors/export/csv" \
            -o contributors.csv

      - name: Upload as artifact
        uses: actions/upload-artifact@v4
        with:
          name: contributors-${{ github.run_id }}
          path: contributors.csv
          retention-days: 30
```

Store the secret as `TRUSTBRIDGE_API_KEY` in your repository secrets (Settings → Secrets and variables → Actions). The URL as a repository variable is optional but keeps workflows environment-agnostic.

---

## Endpoints protected by `export:read`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/contributors/export/csv` | Download contributors as CSV |
| `GET` | `/api/contributors/export/json` | Download contributors as JSON |
| `GET` / `POST` | `/api/treasury/export` | Treasury payout export (JSON, optional CSV) |

Both endpoints accept either a maintainer browser session **or** a valid `export:read` API key. A request with neither receives `401 Unauthorized`; a valid key without the scope receives `403` with code `insufficient_scope`.

## Endpoints protected by `cron:trigger`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/cron/export` | Trigger the nightly treasury CSV export run |
| `POST` | `/api/cron/digest` | Trigger the not-ready contributor digest run |

These endpoints accept a maintainer session, the scheduler `CRON_SECRET` bearer token, **or** a valid API key carrying the `cron:trigger` scope. Session behaviour is unchanged. A valid key without the scope receives `403` with code `insufficient_scope`. Expired or revoked keys are rejected before the scope check.

---

## Listing and revoking keys

### List active keys

```bash
GET /api/settings/api-keys
Authorization: Cookie (operator+ session required)
```

Returns the caller's non-revoked keys with metadata (no secret):

```json
{
  "keys": [
    {
      "id": "cuid...",
      "name": "nightly-export-cron",
      "scopes": ["export:read"],
      "createdAt": "2026-09-25T00:00:00.000Z",
      "expiresAt": null,
      "lastUsedAt": "2026-09-25T02:00:05.123Z"
    }
  ]
}
```

### Revoke a key

```bash
DELETE /api/settings/api-keys/<id>
Authorization: Cookie (operator+ session required)
```

- Sets `revokedAt` immediately. The key stops working on the next request.
- Returns `409 Conflict` if the key is already revoked.
- Returns `403 Forbidden` if the key belongs to a different user.
- The UI shows a confirmation dialog before sending the request.

A revocation is always written to `AuditLog` with `action: "api_key.revoked"`.

---

## Audit log entries

All key lifecycle events appear in `/api/audit` (visible in the **Recent activity** section of `/dashboard/settings`):

| `action` | When |
|---|---|
| `api_key.created` | Key was successfully created. `metadata` includes `scopes` and `expiresAt`. |
| `api_key.revoked` | Key was revoked by its owner. `targetLabel` is the key name. |
| `api_key.revoke_denied` | A maintainer attempted to revoke a key owned by another user. |
| `api_key.use_rejected` | An incoming request was rejected. `metadata.reason` is one of `revoked`, `expired`, or `insufficient_scope`. |

`actorLogin` for authenticated export requests is `api-key:<key-name>`, making automated exports easy to identify and filter in the audit log.

---

---

TrustBridge API keys authenticate machine-to-machine requests to the
`src/app/api/` routes. This document describes how API-key auth interacts with
session auth, and the explicit matrix of allowed credential combinations that
routes accepting either credential must enforce.

## Credential sources

- **Session** — resolved by `src/lib/api-auth.ts` from the request cookies.
- **API key** — resolved by `src/lib/api-key-auth.ts` from the
  `Authorization: Bearer <key>` header (or the configured key header).

Both helpers return a stable result shape so call sites in `src/app/api/` can
branch on the outcome without inventing a parallel auth subsystem.

## Dual-auth matrix

Routes that accept *either* a session or an API key must follow this matrix.
"Present" means the credential was supplied on the request; "valid" means it
resolved to an active principal.

| Session | API key | Outcome |
| ------- | ------- | ------- |
| absent  | absent  | `401` — `missing_credentials` |
| valid   | absent  | allow — session principal |
| absent  | valid   | allow — API-key principal |
| valid   | valid   | allow — session principal wins; API key is ignored |
| invalid | absent  | `401` — `invalid_session` |
| absent  | invalid | `401` — `invalid_api_key` |
| invalid | valid   | allow — API-key principal |
| valid   | invalid | allow — session principal |
| invalid | invalid | `401` — `invalid_credentials` |

Rules:

1. A single valid credential is always sufficient (happy path).
2. When both credentials are present and valid, the session principal is used
   and the API key is not consulted for authorization decisions.
3. An invalid credential never overrides a valid one; the valid credential wins.
4. When no valid credential is present, the route fails closed with a stable
   error code from the table above.

## Error responses

Failures return a JSON body with a stable `error` code and a human-readable
`message`. Codes are stable so clients and tests can assert on them:

- `missing_credentials` — neither credential supplied.
- `invalid_session` — session supplied but not valid.
- `invalid_api_key` — API key supplied but not valid.
- `invalid_credentials` — both supplied but neither valid.

## Tests

`tests/` covers the matrix above, including the happy path (valid single
credential) and failure paths (missing credentials, invalid credentials, and
conflicting dual credentials). When adding a route that accepts session or API
key auth, extend the matrix tests rather than adding ad-hoc assertions.

## Security notes

- API keys are never logged or echoed back in responses.
- Only a masked prefix of a key may appear in operator-facing output.
- Existing pause and happy-path semantics are preserved; this matrix only
defines which credential is honored when multiple are present.
