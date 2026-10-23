# TrustBridge Dashboard Docs

| Doc | Description |
|-----|-------------|
| [SETUP.md](./SETUP.md) | Local development setup |
| [ENVIRONMENT.md](./ENVIRONMENT.md) | Environment variable reference |
| [DOCKER_COMPOSE.md](./DOCKER_COMPOSE.md) | PostgreSQL + app Compose stack |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design, data flow, auth |
| [PROJECT_STRUCTURE.md](./PROJECT_STRUCTURE.md) | Directory layout |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Vercel / production deploy |
| [MAINTAINER_WORKFLOW.md](./MAINTAINER_WORKFLOW.md) | Maintainer workflow & `trustbridge-dash` CLI |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Contribution guide |
| [CSRF.md](./CSRF.md) | CSRF threat model and route policy |
| [FEATURE_FLAGS.md](./FEATURE_FLAGS.md) | Feature flag reference and rollout policy |
| [SESSIONS.md](./SESSIONS.md) | Session lifecycle, cookies, and auth policy |
| [E2E_TESTING.md](./E2E_TESTING.md) | End-to-end test setup and running the suite |
| [VISUAL_REGRESSION.md](./VISUAL_REGRESSION.md) | Visual regression testing & goldens |
| [SENTRY.md](./SENTRY.md) | Error tracking setup |
| [LOGGING_AND_PAGINATION.md](./LOGGING_AND_PAGINATION.md) | Logging and cursor pagination |
| [PERFORMANCE_TESTING.md](./PERFORMANCE_TESTING.md) | k6 smoke tests and load testing guide |
| [PWA.md](./PWA.md) | PWA manifest, service worker shell caching, offline banner, security notes |

## i18n pattern (#515)

Server-rendered and client-hydrated strings share a single source of truth via `src/lib/i18n-config.ts`.

| Symbol | Description |
|--------|-------------|
| `SUPPORTED_LOCALES` | `['en', 'es', 'pt']` — the canonical list consumed by both server and client |
| `DEFAULT_LOCALE` | `'en'` — used when no locale cookie is present |
| `SupportedLocale` | TypeScript union type derived from `SUPPORTED_LOCALES` |
| `isSupportedLocale(s)` | Type-guard; normalises case before checking |
| `resolveLocale(raw)` | Returns a `SupportedLocale`, falling back to `DEFAULT_LOCALE` for unknown/missing values |

**Server (`src/i18n.ts`):** calls `resolveLocale` on the incoming locale, then calls `notFound()` for values that remain unsupported after normalisation. Falls back to `en.json` when the requested locale file is absent.

**Client (`src/lib/i18n-context.tsx`):** `I18nProvider` accepts an optional `initialLocale` prop so the server-selected locale can be forwarded to the client tree without a hydration mismatch. Locale changes load messages from `public/locales/<locale>.json`, matching the server path exactly.

Locale files live in `public/locales/` (`en.json`, `es.json`, `pt.json`). All three must have identical top-level keys — enforced by `tests/unit/i18n.test.ts`.

Transactional invite and ban notices use the `email` section of these same locale packs. The admin invite endpoint accepts optional `recipientEmails` and `locale` fields. When supplied, `recipientEmails` must contain exactly one valid address per invite; omitting it preserves bulk generation without email delivery. Responses include `emailDelivery: { sent, failed }` only for email batches. Delivery failures do not undo generated invites or contributor bans. The dashboard passes its active locale with ban actions; unknown locales fall back to English.
