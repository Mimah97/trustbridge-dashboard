# Cron Export — Nightly Treasury CSV

← Back to [README](../README.md) · See also [Digest emails](./DIGEST.md) · [Environment variables](./ENVIRONMENT.md) · [Architecture](./ARCHITECTURE.md)

---

## What it does

`POST /api/cron/export` runs the automated nightly treasury contributor export.
It queries all active (non-deleted) registrations, builds a CSV, and emails it
to the configured treasury address.

The export never throws — all database or email-transport failures are caught,
recorded in the audit log, and surfaced via a structured result object.

---

## Quick setup

1. Set `TREASURY_EXPORT_EMAIL` (recipient for the nightly CSV attachment).
2. Set `CRON_SECRET` (shared bearer token for all `/api/cron/*` routes).
3. Optionally set `CRON_EXPORT_ALERT_WEBHOOK_URL` to receive failure alerts
   (see [Failure alerting](#failure-alerting) below).
4. Add a Vercel Cron entry (see below).
5. Deploy.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TREASURY_EXPORT_EMAIL` | No | — | Primary recipient for the nightly CSV email |
| `CRON_EXPORT_EMAIL` | No | Falls back from `TREASURY_EXPORT_EMAIL` | Alias for `TREASURY_EXPORT_EMAIL` |
| `CRON_SECRET` | Recommended | — | Bearer token for all `/api/cron/*` routes |
| `CRON_EXPORT_MIN_INTERVAL_MS` | No | `60000` (1 min) | Minimum ms between runs; prevents retry storms |
| `CRON_EXPORT_ALERT_WEBHOOK_URL` | No | — | **Failure-alert webhook URL** (see below) |

---

## Vercel Cron setup

Add to `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/export",
      "schedule": "0 2 * * *"
    }
  ]
}
```

Vercel automatically sends `Authorization: Bearer $CRON_SECRET` when
`CRON_SECRET` is set in project environment variables.

---

## Triggering manually

```bash
# From the command line (requires CRON_SECRET)
curl -X POST https://your-deployment.vercel.app/api/cron/export \
  -H "Authorization: Bearer $CRON_SECRET"
```

Or from the maintainer dashboard settings panel:

```js
// Browser DevTools console (requires active operator+ session)
await fetch('/api/cron/export', { method: 'POST' }).then(r => r.json());
```

---

## Health endpoint

```bash
GET /api/cron/export
```

Returns the result of the most recent run. **Unauthenticated** — contains only
aggregate counts and status, no contributor PII.

```json
{
  "lastRun": {
    "status": "ok",
    "startedAt": "2026-10-17T02:00:01.123Z",
    "durationMs": 487,
    "filename": "contributors-2026-10-17.csv",
    "totalContributors": 42,
    "readyCount": 38,
    "lowReserveCount": 2,
    "notReadyCount": 2,
    "staleCount": 0,
    "isStale": false,
    "destination": "treasury@yourorg.com",
    "emailSent": true
  }
}
```

Returns `{ "lastRun": null }` if no export has run since the last deployment.

---

## Failure alerting

When the export fails (database error, email transport failure, or any
unexpected exception) TrustBridge can fire an outbound webhook alert so
operators are notified immediately rather than discovering the failure through
log tailing or the health endpoint.

### How it works

1. The export catches all errors and calls `sendCronExportAlert()` in
   `src/lib/cron-export-alert.ts`.
2. `sendCronExportAlert()` fires a `POST` to `CRON_EXPORT_ALERT_WEBHOOK_URL`
   with a JSON body describing the failure.
3. The POST is fire-and-forget with a 5-second timeout — an alert delivery
   failure never blocks or retries the export itself.
4. If `CRON_EXPORT_ALERT_WEBHOOK_URL` is not set, the step is skipped silently.

### Alert payload

```json
{
  "source": "trustbridge-cron-export",
  "status": "error",
  "error": "Database connection timeout",
  "startedAt": "2026-10-17T02:00:01.123Z",
  "durationMs": 1234,
  "environment": "production"
}
```

### Operator expectations

- **Hard failures alert once**: database errors, streaming aborts, and lock
  contention that survives retries run through the `catch` branch of
  `runCronExport()`, which records `export.cron.failed` and fires exactly one
  `sendCronExportAlert()` call.
- **Skips never alert**: rate-limited overlapping runs return
  `{ status: "skipped" }` before any work starts, so overlapping cron
  invocations do not spam the alert channel.
- **No PII in alerts**: `sendCronExportAlert()` passes the error through
  `redactAlertText()`, which masks Stellar G-addresses (kept as
  `Gxxxx...yyyy` for triage) and `tb_`/`sk-`/Slack-style secrets. Alert
  delivery itself is fire-and-forget — a failing webhook is logged and never
  re-thrown, so it cannot crash the cron handler twice.

### Supported webhook targets

Any HTTP endpoint that accepts a POST with a JSON body works. Common options:

#### Slack incoming webhook

```
CRON_EXPORT_ALERT_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../xxx
```

Slack parses the `text` field. The alert payload sets `text` to a formatted
failure message automatically.

#### PagerDuty Events API v2

```
CRON_EXPORT_ALERT_WEBHOOK_URL=https://events.pagerduty.com/v2/enqueue
```

Set `CRON_EXPORT_ALERT_PAGERDUTY_KEY` to your integration routing key.
The payload will include `routing_key` and `event_action: "trigger"`.

#### Dead-man's switch (healthchecks.io / Better Uptime)

For dead-man's switches, configure the cron to ping on **success** instead:
set `CRON_EXPORT_PING_URL` to your check-in URL. TrustBridge pings it after
each successful run. A missed ping triggers an alert on the external service.

```
CRON_EXPORT_PING_URL=https://hc-ping.com/your-uuid-here
```

#### Generic webhook

Any endpoint that returns HTTP 2xx accepts the payload:

```bash
# Test your webhook endpoint locally
curl -X POST "$CRON_EXPORT_ALERT_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"source":"trustbridge-cron-export","status":"error","error":"test","startedAt":"2026-01-01T00:00:00Z","durationMs":0}'
```

---

## Audit log

Every run writes to `AuditLog` (visible in `/dashboard/settings → Recent activity`):

| `action` | `metadata` fields | When |
|---|---|---|
| `export.cron` | `totalContributors`, `readyCount`, `lowReserveCount`, `notReadyCount`, `staleCount`, `isStale`, `filename`, `destination`, `emailSent`, `durationMs` | Run completed (email sent or not) |
| `export.cron.failed` | `error`, `durationMs` | DB error or unexpected failure |

Runs with no email destination are still audited with `destination: "none"` and `emailSent: false`.

---

## Locking and rate limiting

The export acquires a singleton database lease before reading registrations,
so concurrent triggers on separate app instances cannot create duplicate
treasury files. The lease is token-checked on release and expires after one
hour if a worker exits unexpectedly. A competing trigger, including one that
bypasses the cooldown, returns a skipped result without reading or exporting
data.

The route also applies a min-interval gate (default 1 minute via
`CRON_EXPORT_MIN_INTERVAL_MS`) to prevent retry storms. A trigger within the
window returns:

```json
{ "status": "skipped", "error": "Rate limited: minimum interval between exports is 60000ms" }
```

with HTTP 200 (not 429) so the scheduler does not retry.

Apply the `CronExportLock` schema migration during deployment before enabling
cron exports against the updated application.

---

## CSV columns

| Column | Description |
|---|---|
| `github_username` | Contributor GitHub handle |
| `stellar_address` | Contributor Stellar G-address |
| `readiness` | `ready` / `low_reserve` / `not_ready` |
| `funded` | Account funded with XLM |
| `trustline` | USDC trustline present |
| `trustline_authorized` | Trustline authorized by issuer |
| `verified` | All three checks passed |
| `xlm_balance` | Raw XLM balance |
| `spendable_xlm_balance` | XLM available after reserve |
| `usdc_balance` | USDC balance |
| `last_checked_at` | ISO timestamp of last Horizon check |
| `horizon_latency_ms` | Horizon RPC round-trip in ms |

---

## Stale data detection

If any contributor's `lastCheckedAt` is older than the configured threshold
(`STALE_EXPORT_THRESHOLD_MS`, default 24 hours), the export result includes:

```json
{ "isStale": true, "staleCount": 3 }
```

The CSV is still generated and emailed — operators receive the data with the
stale flag visible in the audit log.

---

## Relationship to other cron features

| Feature | Route | Trigger | Recipient | Content |
|---|---|---|---|---|
| **Treasury export** | `POST /api/cron/export` | Scheduler / manual | `TREASURY_EXPORT_EMAIL` | Full CSV attachment |
| Digest | `POST /api/cron/digest` | Scheduler / manual | `DIGEST_EMAIL` | Aggregate counts + link |
| Email nudge | `POST /api/notifications/email-nudge` | Manual (session) | Maintainer's email | Per-contributor nudge |

The treasury export and digest share the `CRON_SECRET` bearer token and the
`TREASURY_EXPORT_EMAIL` fallback, but run independently and produce different
email bodies.

---

## Implementation files

| File | Purpose |
|---|---|
| `src/lib/cron-export.ts` | Core logic: rate gate, DB query, readiness tally, email dispatch, audit |
| `src/lib/cron-export-alert.ts` | Failure alert dispatcher (webhook + ping) |
| `src/app/api/cron/export/route.ts` | HTTP handler: dual-auth (session or `CRON_SECRET`), CSRF, POST/GET |
| `src/lib/cron-export.test.ts` | Unit tests for export logic, rate limiting, email, audit |
| `src/lib/cron-export-alert.test.ts` | Unit tests for alert dispatch (happy path, failure, env not set) |
