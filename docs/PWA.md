# PWA — Minimal Progressive Web App

TrustBridge Dashboard ships a minimal PWA layer: a web app manifest, a shell-only service worker, and an offline connectivity banner. This document explains the design, the security constraints, and what the PWA does *not* do by design.

---

## What is included

| Feature | File | Purpose |
|---------|------|---------|
| Web app manifest | `public/manifest.json` | Enables "Add to Home Screen" on mobile; provides name, icons, theme colour |
| Service worker | `public/sw.js` | Caches static shell assets for faster repeat loads; never caches API data |
| Offline banner | `src/components/OfflineBanner.tsx` | Tells users when their connection is gone so Horizon failures don't look like app bugs |
| Layout wiring | `src/app/layout.tsx` | Registers the SW, links the manifest, mounts the offline banner |

---

## Web app manifest (`public/manifest.json`)

Key fields:

```json
{
  "name": "TrustBridge Dashboard",
  "short_name": "TrustBridge",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0f172a",
  "theme_color": "#3E1BDB"
}
```

- `display: "standalone"` hides the browser chrome when launched from the home screen.
- `theme_color` matches the Stellar purple brand colour (`#3E1BDB`), which is also set as `themeColor` in the Next.js `metadata` object so that the `<meta name="theme-color">` tag is emitted server-side.
- `background_color` matches the dark-mode background to avoid a white flash during app launch.

---

## Service worker (`public/sw.js`)

### Caching strategy

The SW uses a **cache-first** strategy for a small set of shell assets and **network-first** for everything else. This means:

- Repeat visits load the app shell instantly from cache.
- Content routes (pages, API data) always try the network first.
- If the network fails and no cached version exists, the request fails normally — the SW does not synthesize a fallback page.

### Shell assets that ARE cached

```
/                   (root document — splash for add-to-homescreen)
/manifest.json
/favicon.ico
/_next/static/**    (JS/CSS chunks, fonts)
```

### Security invariants — what is NEVER cached

These rules must not be relaxed without a security review:

| Route pattern | Reason |
|---------------|--------|
| `/api/*` | Contains contributor PII (Stellar addresses, readiness state, GitHub identities). Caching would serve stale data across session boundaries and potentially leak one user's data to another on a shared device. |
| `/api/auth/*` | Session cookies must reach the NextAuth origin server for validation. A cached auth response would allow replaying expired or invalidated sessions. |
| `POST / PUT / DELETE` | Mutating requests must always reach the origin. |
| Opaque (cross-origin) responses | Cannot be inspected for status; silently caching a CDN error page would break the app. |

These invariants are enforced in `isNetworkOnly()` in `public/sw.js`. Any request matching those conditions is not intercepted at all — it falls through to the browser's default network handling.

### Cache versioning and invalidation

The cache is named `trustbridge-shell-v1`. When a new SW version is deployed:

1. `install`: the new SW pre-caches shell assets into the new cache name and calls `skipWaiting()`.
2. `activate`: the new SW deletes all caches whose name does not match the current version and calls `clients.claim()`.

To force a full cache refresh on the next deploy, increment the `CACHE_NAME` constant in `public/sw.js` (e.g. `trustbridge-shell-v2`).

### Registration

The SW is registered via an inline `<script>` in `src/app/layout.tsx`:

```html
<script>
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
      navigator.serviceWorker.register('/sw.js', { scope: '/' });
    });
  }
</script>
```

Registration is deliberately deferred to the `load` event so the SW does not compete with first-paint network requests. Failures are suppressed in development (HTTPS is required for service workers in production; Next.js dev server uses HTTP by default).

---

## Offline banner (`src/components/OfflineBanner.tsx`)

The banner is a client component that listens to `window.addEventListener('online' | 'offline')` and renders when `navigator.onLine` is `false`.

```
┌──────────────────────────────────────────────────────────────────┐
│ 📡 You're offline. Live Horizon data and Stellar checks are      │
│    unavailable until your connection is restored.                │
└──────────────────────────────────────────────────────────────────┘
```

Design decisions:

- **Avoids SSR mismatch**: initial state is `false` (online); the `useEffect` corrects it after hydration. The server has no concept of network state.
- **Auto-dismisses**: when the `online` event fires, the banner disappears without user action.
- **`aria-live="polite"`**: screen readers announce the banner without interrupting current reading flow.
- **`data-testid="offline-banner"`**: enables reliable automated testing.
- **Visual distinction**: uses yellow/amber palette, distinct from the amber maintenance banner, to signal a transient connectivity state rather than a site-wide admin alert.

---

## Offline queue for pending rechecks

Recheck actions (`POST /api/rechecks`) are **not** replayed by the service worker. The SW never intercepts mutating requests (see the security invariants above), so an offline recheck is never silently buffered at the network layer. Instead, the client-side queue in `src/lib/` owns the behavior, and the offline banner is the user-facing signal that a queue may be accumulating.

### What happens while offline

1. The user triggers a recheck. The client checks `navigator.onLine` (and the `offline` event state) before issuing the request.
2. If offline, the action is **not** sent. It is appended to the pending-recheck queue in `src/lib/` and persisted to `localStorage` under a versioned key so it survives a reload or app relaunch.
3. The offline banner (`data-testid="offline-banner"`) is shown, so the user knows the action is pending rather than failed. The UI must not present the recheck as completed.
4. Each queued entry records the contributor id, the recheck payload, and a client-generated idempotency key. The idempotency key is what prevents double-submits on reconnect.

### What happens on reconnect

1. The `online` event fires; the banner auto-dismisses.
2. The queue is flushed **in FIFO order**, one entry at a time. Each entry is sent as a normal `POST /api/rechecks` with the existing auth cookie and CSRF token — the queue does not bypass auth or CSRF.
3. **Dedupe**: before sending, the client drops any entry whose idempotency key was already acknowledged, and the server treats a repeated idempotency key as a no-op. This is what stops contributors from double-submitting when they tap recheck twice offline.
4. On a `2xx` response the entry is removed from the queue and persisted state is rewritten.
5. On a `4xx` (validation, auth, CSRF) the entry is removed and surfaced as a clear, stable error — retrying a malformed or unauthorized entry would loop forever.
6. On a network error or `5xx` the entry stays queued and is retried on the next `online` event or the next flush tick. Retries are bounded; after the limit the entry is dropped and an actionable error is shown.

### Cancellation and pause

- If the user navigates away or the app is paused mid-flush, the in-flight entry is left in the queue until its response is observed. No partial privileged state is written: the queue entry is only removed after a confirmed response.
- A malformed queue entry (bad JSON, missing idempotency key) is discarded on load with a stable error rather than crashing the flush loop.

### What this is NOT

This is a client-side queue, not Background Sync. The SW does not register a `sync` event and does not replay requests while the tab is closed. If the tab is closed with entries pending, they flush on the next launch when connectivity returns.

---

## Content Security Policy (CSP) notes

The project does not currently configure a CSP header (see `next.config.mjs` and `src/middleware.ts`). If a CSP is added in the future, the following directives are required for the PWA to function:

```
# Allow the service worker script (served from same origin, no external fetch needed)
script-src 'self';

# Allow the SW to use the Cache API (same-origin fetch inside the SW)
# No special CSP directive needed — SW fetch is governed by the SW's own origin.

# Allow the manifest
# No special CSP directive needed — manifests are fetched as subresources, covered by default-src.
```

The inline SW registration script in `layout.tsx` uses `dangerouslySetInnerHTML`. If a `script-src` CSP with `nonce` or `hash` is added, this script must be covered by the nonce or a corresponding hash must be computed and added to the CSP header.

---

## What this PWA does NOT do

This is intentionally minimal. The following are explicitly out of scope:

| Feature | Why excluded |
|---------|--------------|
| Full offline dashboard | Contributor data is PII; caching it in the SW would require careful per-user cache partitioning and cache eviction tied to session expiry. Out of scope. |
| Background sync | Would require queueing mutating requests (register, recheck) offline and replaying them later — complex and risky for financial/Stellar operations. The client-side recheck queue above is the deliberate, bounded alternative. |
| Push notifications | Requires a push subscription service. Not planned. |
| Workbox / next-pwa | Adds build complexity and auto-generates a SW from the Next.js chunk manifest, which can inadvertently cache API routes. A hand-written SW with explicit exclusions is safer for this project. |
| iOS Safari "Add to Homescreen" icons | The project does not currently have PWA-sized PNG icons. The `favicon.ico` is registered as a fallback. Add 192×192 and 512×512 PNGs to `public/` and reference them in `manifest.json` to enable rich homescreen icons. |

---

## Testing

The offline banner is testable with `data-testid="offline-banner"`. A unit test can mock `navigator.onLine` and fire synthetic `offline`/`online` events:

```typescript
import { render, screen, act } from "@testing-library/react";
import { OfflineBanner } from "@/components/OfflineBanner";

it("shows when offline", async () => {
  Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
  render(<OfflineBanner />);
  await act(async () => {
    window.dispatchEvent(new Event("offline"));
  });
  expect(screen.getByTestId("offline-banner")).toBeInTheDocument();
});

it("hides when back online", async () => {
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  render(<OfflineBanner />);
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  expect(screen.queryByTestId("offline-banner")).not.toBeInTheDocument();
});
```

The offline recheck queue in `src/lib/` is covered by tests under `tests/`:

- **Happy path**: a recheck queued while offline is flushed on the `online` event and removed from persisted state after a `2xx`.
- **Failure path**: a malformed queue entry (or a `4xx` response) is discarded and surfaces a stable error instead of looping.
