# End-to-End Testing

Playwright drives the dashboard in a real Chromium against a locally-started
Next.js dev server. Everything the app would reach over the network — GitHub,
Horizon, the database, the Freighter extension — is mocked.

```bash
npx playwright test                     # all specs
npx playwright test tests/e2e/register.spec.ts
npx playwright test --ui                # watch mode
npx playwright show-report              # last run
```

| Spec | Journey |
| --- | --- |
| `tests/e2e/register.spec.ts` | Contributor registration: sign in, paste an address, read the readiness result, save, copy the Freighter proof. |
| `tests/e2e/register-happy-path.spec.ts` | Register happy path with mocked Horizon (#556): drives the full UI flow for all three Horizon account archetypes (FUNDED→ready, LOW_BALANCE→low_reserve, NO_TRUSTLINE→not_ready) using `HORIZON_TEST_ACCOUNTS` from `tests/mocks/horizon-fixtures.ts` as canonical addresses. Covers address-check request payload, readiness badge, save→confirmation→card update, and address-switching scenarios. |
| `tests/e2e/maintainer.spec.ts` | Maintainer dashboard: access control, contributor table, re-check, metrics, settings. |
| `tests/e2e/status.spec.ts` | Public health page (`/status`, issue #384): loads without auth, renders the heading, timestamp, overall banner and component checks, and refreshes via the "Check now" control against a mocked `/api/health`. |
| `tests/e2e/settings-feature-flags.spec.ts` | Feature-flag panel on `/dashboard/settings` (issue #510): renders mocked flags with their keys, sources and enabled/disabled states, plus the loading, empty, error (HTTP 500) and re-request states. `GET /api/settings/feature-flags` resolves the deployment's real `FEATURE_*` environment, so every case intercepts it — see below. |
| `tests/e2e/maintainer-a11y.spec.ts` | Accessibility gate for the maintainer settings page and the Wave prep / disputes sections (issue #511): runs axe against `/dashboard/settings`, the Wave prep workspace and the disputes panel, fails on serious/critical violations, and asserts keyboard focus order reaches the primary actions. |

## Accessibility gate (axe-core)

Issue #142. Each spec file has one test that signs in, loads its page to a
fully-settled state (mocked APIs resolved, key content visible), and runs
[`@axe-core/playwright`](https://www.npmjs.com/package/@axe-core/playwright)
against it:

- `register.spec.ts` → "the register page has no axe violations beyond the
  baseline" — scans `/register` as a signed-in contributor.
- `maintainer.spec.ts` → "the dashboard page has no axe violations beyond the
  baseline" — scans `/dashboard` as a signed-in maintainer.
- `maintainer-a11y.spec.ts` → scans `/dashboard/settings`, the Wave prep
  workspace and the disputes panel (issue #511), including modal dialogs both
  open and closed.

All scans run with `withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])`
(axe-core's own best-practice-only rules, like landmark/region checks, are
left out — noisy and not what WCAG conformance requires) and are gated by the
existing `test:e2e` script, so they run in CI on every push and PR with no
separate workflow step.

**Failing threshold.** The Wave/settings gate fails the run on any `serious`
or `critical` violation. `minor` and `moderate` findings (including contrast
issues) are logged but do not fail, per the issue's edge-case guidance.

**Baseline allowlist.** `tests/e2e/axe-baseline.ts` exports
`AXE_BASELINE_RULE_IDS`, a short, dated, commented list of axe rule ids
excluded from both gates via `filterBaselineViolations()`. Today it holds only
`color-contrast`, because contrast is already covered by the from-scratch WCAG
luminance calculator in `src/lib/dark-mode-contrast-audit.test.ts` — running
axe's own contrast heuristic on top would duplicate that poorly (it flags
transitioning, off-screen, and gradient-background text that unit tests
already reason about correctly). Anything else added to this list should carry
the same kind of comment: which rule, why it can't be fixed in this PR, and
when to revisit. Keep it short — the point of the gate is to catch real
regressions, not to grow a bigger exemption list every time a test is
inconvenient.

## Signing in without GitHub

Two things have to believe the user is signed in, and they are checked in
different places:

1. **The server.** `withAuth` in `src/middleware.ts` guards `/register` and
   `/dashboard` by decoding a NextAuth **JWT cookie**. Intercepting
   `/api/auth/session` does not fool it — without the cookie the request is
   redirected to the sign-in page and the form never renders.
2. **The client.** `SessionProvider` reads `/api/auth/session` to populate
   `useSession()`.

`signInAsContributor(context, page)` in `tests/e2e/helpers.ts` does both: it
mints a genuine session token with `encode()` from `next-auth/jwt`, sets it as
`next-auth.session-token`, and route-intercepts the session endpoint. No GitHub
round trip is involved, and no OAuth credentials are needed.

Signing the token means the test process and the dev server must share a secret.
`tests/e2e/env.ts` resolves it — `NEXTAUTH_SECRET` when the environment sets one
(CI does), otherwise a fixed local default — and `playwright.config.ts` passes
the same value into the `next dev` it starts. If you run the server yourself and
point the tests at it with `E2E_BASE_URL`, export `NEXTAUTH_SECRET` for both.

For maintainer-only routes, pass `{ isMaintainer: true }`.

## Mocking APIs

`interceptApi(page, pattern, body, status)` fulfils a route with canned JSON.
For anything stateful, route it by hand: the register spec serves
`GET /api/register` from a fixture that `POST /api/register` mutates, so the
"current registration" card only appears if the mutation's invalidate-and-refetch
wiring actually works. That is the kind of bug a unit test cannot see.

`DATABASE_URL` is set to a placeholder. The dev server logs Prisma connection
errors for routes no test exercises; that is expected and not a failure.

### Feature flags must always be intercepted

`GET /api/settings/feature-flags` returns flags resolved from the deployment's
real `FEATURE_*` environment and database overrides. A spec that lets it through
would assert against whatever the host machine or CI runner happens to have set,
so it would pass locally and fail in CI for reasons that have nothing to do with
the code. `settings-feature-flags.spec.ts` therefore declares its fixture inside
each test and intercepts the route in every case, including the error case. Keep
new flag assertions that way: mock the response, never the environment.

## Freighter

Freighter is a browser extension and is never installed in CI. The register spec
covers both states without one:

- **Not installed** (the default): the card says Freighter was not detected, the
  sign button is absent, and copy-to-clipboard still works.
- **Installed**: `installFreighterStub(page)` uses `page.addInitScript()` to put
  a `window.freighterApi` with a recording `signMessage()` on the page before any
  app script runs. The test then asserts the signed message contains the pasted
  address.

If real SDK signing lands later, the stub is the seam to replace.

## Clipboard

The copy-proof test reads the clipboard back, which needs permissions:

```ts
test.use({ permissions: ["clipboard-read", "clipboard-write"] });
```

This is Chromium-only, which is fine — `playwright.config.ts` runs a single
chromium project. If a WebKit or Firefox project is added, the clipboard tests
need to be skipped there, since neither supports those permissions. The
component also handles the case where the Clipboard API is unavailable
altogether (an insecure origin, a denied permission) by telling the user to
select and copy the challenge by hand, rather than failing silently.

## Selectors

Use `data-testid`. The user-visible copy on the register page is deliberately
under revision (`docs/READINESS_MODEL.md`), so specs that match on wording break
for reasons that have nothing to do with the journey.

Test ids currently relied on:

| Test id | Where |
| --- | --- |
| `register-page`, `maintainer-error` | `src/app/register/RegisterClient.tsx` |
| `current-registration`, `current-registration-address` | ” |
| `save-registration`, `registration-saved`, `registration-error` | ” |
| `stellar-address-input`, `address-check-result`, `next-action-copy` | `src/components/AddressInput.tsx` |
| `readiness-badge-<status>`, `readiness-description`, `readiness-next-step` | `src/components/TrustlineStatusBadge.tsx` |
| `trustline-guidance` | `src/components/TrustlineGuidancePanel.tsx` |
| `freighter-proof-card`, `freighter-detection-status`, `freighter-challe

/* … truncated 691 chars — edit only what you need near the top … */
