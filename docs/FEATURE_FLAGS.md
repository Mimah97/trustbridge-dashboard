# Feature flags

Ɛ Back to [README](../README.md) · See also [Environment variables](./ENVIRONMENT.md)

`src/lib/feature-flags.ts` is a small flags helper with two sources (env and an
optional database table) plus a built-in default per flag. It exists so shipping-freeze windows, new webhooks, i18n, and other risky changes can be
gated without a deploy — and turned **off** fast during a Wave.

Out of scope: LaunchDarkly / a hosted flag service. An in-app admin UI is
optional; `setFeatureFlag()` and `getAllFeatureFlags()` are provided for one.
An admin-only read-only panel lives at `/dashboard/settings` and lists each
flag's key, resolved value and source.

---

## Resolution order

For every flag, the first source that produces a value wins:

1. **Env override** — `FEATURE_FLAG_<KEY>` (e.g. `FEATURE_FLAG_BATCH_RECHECK=off`).
   Accepted truthy values: `1`, `true`, `on`, `yes`, `enabled`; falsy: `0`,
   `false`, `off`, `no`, `disabled` (case-insensitive). An unrecognised value is
   ignored and resolution falls through.
2. **Database row** — a `FeatureFlag` row, **only** when `FEATURE_FLAGS_DB_ENABLED`
   is truthy. Reads are cached in-process for `FEATURE_FLAGS_CACHE_TTL_MS`
   (default 30s); `clearFeatureFlagCache()` is called automatically after
   `setFeatureFlag()`.
3. **Built-in default** — the `default` in `FEATURE_FLAGS`.

### Fail closed

Flags marked `risky` gate a mutating or destructive path. If the DB source is
**enabled but unreadable** (connection error, table missing, …) a risky flag
resolves to `false` — never to its default. A DB outage therefore *closes*
risky writes rather than leaving them open. Non-risky flags fall back to their
default in the same situation. An env override always wins, even when the DB is
down.

---

## Freeze windows

A **freeze window** is a period (typically during a Wave) when risky, mutating
paths are turned off so contributors can't accidentally ship or re-queue work.
Freeze windows are implemented entirely with the flags below — there is no
separate freeze subsystem. To open a freeze, flip the relevant flags off (env
override or DB row); to close it, flip them back on.

| Flag | Freeze effect when off |
|---|---|
| `batch_recheck` | `POST /api/contributors` returns `403` — no per-contributor Horizon fan-out |
| `invite_generation` | `POST /api/invites/generate` returns `403` — invite issuance frozen |
| `dlq_retry` | Contributor and Soroban outbox replay endpoints return `403` — failed items stay parked |
| `maintenance_mode` | Composes with the `MAINTENANCE` env var to take the app read-only |

Because these flags are `risky`, a DB outage during a freeze keeps them **off**
(fail closed) — see [Fail closed](#fail-closed) above. The env vars that drive
freeze windows (`FEATURE_FLAG_*`, `FEATURE_FLAGS_DB_ENABLED`,
`FEATURE_FLAGS_CACHE_TTL_MS`, `MAINTENANCE`) are documented in
[ENVIRONMENT.md](./ENVIRONMENT.md#feature-flags-and-freeze-windows).

### Freeze-window env vars

The `freeze_window` flag gates the helpers in `src/lib/freeze-window.ts`. When
it is **off**, those helpers never block a request regardless of the
`FREEZE_WINDOW_*` env vars below. When it is **on** (the default), the
`FREEZE_WINDOW_*` vars decide whether a freeze is currently active. These are
the same variables documented in
[ENVIRONMENT.md](./ENVIRONMENT.md#freeze-window-issue-536) — keep both pages in
sync when changing parsing or defaults.

| Env var | Type | Default | Effect |
|---|---|---|---|
| `FREEZE_WINDOW_ENABLED` | boolean | `false` | Master switch. When falsy, no freeze is ever active and the other `FREEZE_WINDOW_*` vars are ignored. |
| `FREEZE_WINDOW_START` | ISO-8601 timestamp | _(unset)_ | Start of the freeze window. Required for a scheduled freeze; an unparseable value is treated as unset. |
| `FREEZE_WINDOW_END` | ISO-8601 timestamp | _(unset)_ | End of the freeze window. Required for a scheduled freeze; an unparseable value is treated as unset. |
| `FREEZE_WINDOW_MESSAGE` | string | _(built-in)_ | Operator-facing message returned with `403` responses while a freeze is active. |

A freeze is active only when `FREEZE_WINDOW_ENABLED` is truthy **and** the
current time falls within `[FREEZE_WINDOW_START, FREEZE_WINDOW_END)`. If either
timestamp is missing or invalid, no scheduled freeze is active (fail open on
misconfiguration, but the `freeze_window` flag still gates the helpers).

Example — schedule a freeze for a Wave:

```dotenv
FEATURE_FLAG_FREEZE_WINDOW=on
FREEZE_WINDOW_ENABLED=true
FREEZE_WINDOW_START=2026-03-01T00:00:00Z
FREEZE_WINDOW_END=2026-03-08T00:00:00Z
FREEZE_WINDOW_MESSAGE="Wave 12 freeze in effect — mutating APIs are paused."
```

Example — disable freeze-window blocking entirely:

```dotenv
FEATURE_FLAG_FREEZE_WINDOW=off
```

---

## The flags

| Key | Default | Risky | Gates | Documented at |
|---|---|---|---|---|
| `batch_recheck` | `true` | ✅ | `POST /api/contributors` — full batch recheck (one Horizon call per contributor) | `src/app/api/contributors/route.ts` |
| `invite_generation` | `true` | ✅ | `POST /api/invites/generate` — bulk invite code creation | `src/app/api/invites/generate/route.ts` |
| `dlq_retry` | `true` | ✅ | Retry a failed job or Soroban outbox item via `POST /api/contributors/queue/dlq/[jobId]/retry` or `POST /api/soroban/outbox/dlq/[id]/replay` | `src/app/api/contributors/queue/dlq/[jobId]/retry/route.ts`, `src/app/api/soroban/outbox/dlq/[id]/replay/route.ts` |
| `maintenance_mode` | `false` | ✅ | Composes with the `MAINTENANCE` env var (see [DEPLOYMENT.md](./DEPLOYMENT.md#maintenance-mode)) | `src/lib/maintenance.ts` |
| `otel_traces` | `false` | — | Opt-in tracing; composes with `OTEL_TRACES_ENABLED` (see [ENVIRONMENT.md](./ENVIRONMENT.md#opentelemetry-tracing-issue-203)) | `src/lib/tracing.ts` |
| `freeze_window` | `true` | ✅ | Enforces wave freeze-window blocking on mutating APIs. When OFF, freeze-window helpers never block requests regardless of `FREEZE_WINDOW_*` env vars. | `src/lib/freeze-window.ts` |

### Two existing risky features are now gated (issue #201)

- **Batch recheck** (`batch_recheck`). Previously any maintainer `POST` to
  `/api/contributors` fanned out a Horizon call per contributor with no kill
  switch. Now it returns `403 { "error": "Batch recheck is currently disabled" }`
  when the flag is off.
- **Invite generation** (`invite_generation`). `/api/invites/generate` now
  returns `403 { "error": "Invite generation is currently disabled" }` when the
  flag is off, so invite issuance can be frozen during a Wave.

---

## Usage

```ts
import { isFeatureEnabled } from "@/lib/feature-flags";

if (!(await isFeatureEnabled("batch_recheck"))) {
  return NextResponse.json({ error: "Batch recheck is currently disabled" }, { status: 403 });
}
```

Edge middleware (no DB, no `server-only`):

```ts
import { isFeatureEnabledFromEnv } from "@/lib/feature-flags";
```

Admin / debug view:

```ts
import { getAllFeatureFlags, setFeatureFlag } from "@/lib/feature-flags";

const flags = await getAllFeatureFlags(); // [{ key, enabled, source, risky, description }]
await setFeatureFlag("batch_recheck", false, session.user.id); // requires FEATURE_FLAGS_DB_ENABLED
```

### Admin panel

The admin-only read-only panel at `/dashboard/settings` lists every flag’s key,
resolved value and source (`env`, `db`, `default` or `fail-closed`). It is gated
by the admin RBAC role; non-admin users are redirected to `/dashboard`. The panel is
read-only — to change a flag, use an env override or the database source.

---

## Database source

Enable with `FEATURE_FLAGS_DB_ENABLED=1` and apply the migration
(`prisma/migrations/20260829120000_add_feature_flag_model`). Rows are keyed by
the flag name:

```sql
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('batch_recheck', false, now())
ON CONFLICT ("key") DO UPDATE SET "enabled" = excluded."enabled", "updatedAt" = now();
```

When `FEATURE_FLAGS_DB_ENABLED` is unset, the table is never queried.

---

## API: GET /api/settings/feature-flags

Returns the resolved feature flags for the dashboard settings page.

- **Authentication**: Requires an authenticated maintainer session. Returns `401 Unauthorized` if unauthenticated and `403 Forbidden` if not a maintainer.
- **Response**:
```json
{
  "flags": [
    {
      "key": "batch_recheck",
      "enabled": true,
      "value": true,
      "source": "Built-in default",
      "description": "Allow maintainers to enqueue a full batch recheck of every contributor."
    }
  ]
}
```
- **Semantics**:
  - Environment overrides win over database rows.
  - Returns `401` for unauthenticated requests.
  - Secret flags are never exposed to non-maintainers.
  - DB outages fail closed for risky flags.
