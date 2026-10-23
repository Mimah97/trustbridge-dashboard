/**
 * @module cache-tags
 *
 * Canonical Next.js cache tag constants and invalidation helpers for the
 * contributor list endpoints.
 *
 * ## The problem (#555)
 *
 * `GET /api/contributors` and `GET /api/contributors/paginated` are both
 * marked `dynamic = "force-dynamic"`, which bypasses Next.js's built-in
 * `fetch` cache entirely — those routes are intentionally never cached by the
 * Next.js Data Cache.  The real caching layer for contributor data is the
 * in-process `contributorCache` and `statsCache` in `src/lib/cache.ts`.
 *
 * The gap was that after a recheck (single or batch) or a new registration the
 * in-process cache was invalidated correctly via `invalidateContributorCaches()`
 * and `invalidateDashboardStatsCache()`, but:
 *
 *   a) `GET /api/contributors` responses carried no `Cache-Control` header,
 *      so browsers and CDNs could cache a stale contributor list indefinitely.
 *   b) There was no named, shared set of cache tag constants for contributors,
 *      making it easy for new mutation paths to forget to invalidate.
 *
 * ## What this module provides
 *
 * 1. **`CONTRIBUTOR_CACHE_TAGS`** — stable string constants used as Next.js
 *    `revalidateTag()` targets.  Even though the routes use
 *    `force-dynamic` (which bypasses the Data Cache), tags are still valid
 *    for any `fetch()` calls inside the route handlers that use `next: { tags }`.
 *    They also serve as the canonical list that mutation handlers call.
 *
 * 2. **`invalidateContributorListCaches()`** — single entry point that
 *    resets *all* in-process caches affected by a contributor mutation and
 *    emits `revalidateTag()` calls so any Data-Cache entries are cleared too.
 *    Call this from every handler that mutates registration state:
 *      - `POST /api/register`
 *      - `POST /api/contributors` (batch recheck)
 *      - `POST /api/contributors/[id]` (single recheck)
 *      - `POST /api/maintainer/ban` (ban / unban)
 *      - `POST /api/registrations/[id]/restore` (restore)
 *      - `PATCH /api/disputes` (dispute status resolution)
 *
 * 3. **`buildContributorListCacheControl()`** — a `Cache-Control` header value
 *    for `GET /api/contributors` responses.  The contributor list is
 *    maintainer-only (authenticated) and should be short-lived: stale after
 *    30 s, but the browser/CDN may re-use a stale copy for up to 60 s while a
 *    background revalidation is in flight.
 *
 * ## Multi-instance note
 *
 * Like the rate-limit store, the in-process caches here are per-Node.js
 * process.  `revalidateTag()` is Next.js's mechanism for cross-replica
 * invalidation on Vercel's infrastructure; without it, replicas serving
 * cached Data Cache hits would not see the fresh data until their local TTL
 * expired.  In a single-process deployment `revalidateTag()` is still harmless
 * — it simply finds no cached fetch entries and returns immediately.
 */

import { revalidateTag } from "next/cache";

import {
  invalidateContributorCaches,
  statsCache,
  buildCacheKey,
} from "./cache";

// ---------------------------------------------------------------------------
// Tag constants
// ---------------------------------------------------------------------------

/**
 * Cache tag for the full contributor list (`GET /api/contributors`).
 * Add this as `next: { tags: [CONTRIBUTOR_CACHE_TAGS.list] }` to any
 * `fetch()` inside contributor GET handlers to opt those responses into
 * tag-based revalidation.
 */
export const CONTRIBUTOR_CACHE_TAGS = {
  /** The full, unfiltered contributor list. */
  list: "contributors:list",
  /** Cursor-paginated contributor list. */
  paginated: "contributors:paginated",
  /** Dashboard-level readiness statistics. */
  stats: "contributors:stats",
} as const;

export type ContributorCacheTag =
  (typeof CONTRIBUTOR_CACHE_TAGS)[keyof typeof CONTRIBUTOR_CACHE_TAGS];

// ---------------------------------------------------------------------------
// Invalidation entry point
// ---------------------------------------------------------------------------

/**
 * Invalidate all contributor-related caches after a mutation.
 *
 * Covers:
 *   1. The in-process `contributorCache` (partial contributor-keyed entries).
 *   2. The in-process `statsCache` (aggregate readiness counts).
 *   3. Next.js Data Cache entries tagged with any `CONTRIBUTOR_CACHE_TAGS`
 *      value, via `revalidateTag()`.
 *
 * Safe to call from any server-side mutation context (API route, Server
 * Action, background job).  `revalidateTag` is a no-op outside Next.js
 * request context in tests.
 *
 * @example
 * ```ts
 * // After a batch recheck completes:
 * await invalidateContributorListCaches();
 * ```
 */
export async function invalidateContributorListCaches(): Promise<void> {
  // 1. In-process invalidation (contributorCache + verificationCache + statsCache)
  invalidateContributorCaches();
  // Also evict the stats cache entry used by getDashboardStats() in registrations.ts
  // (same key formula: buildCacheKey("stats", "dashboard"))
  statsCache.invalidate(buildCacheKey("stats", "dashboard"));

  // 2. Next.js Data Cache tag revalidation (no-op in non-Next.js contexts)
  try {
    revalidateTag(CONTRIBUTOR_CACHE_TAGS.list);
    revalidateTag(CONTRIBUTOR_CACHE_TAGS.paginated);
    revalidateTag(CONTRIBUTOR_CACHE_TAGS.stats);
  } catch {
    // revalidateTag() throws "Invariant: revalidateTag called outside request
    // context" when invoked from a background worker or unit test. This is
    // not a fatal error — the in-process invalidation above already covers
    // the server-side cache. Swallow silently so callers never have to guard.
  }
}

// ---------------------------------------------------------------------------
// HTTP Cache-Control header for authenticated contributor list responses
// ---------------------------------------------------------------------------

/**
 * `Cache-Control` header value for `GET /api/contributors` responses.
 *
 * The contributor list is only served to authenticated maintainers so it must
 * be `private` (no CDN/proxy caching).  A short `max-age` with
 * `stale-while-revalidate` lets the browser avoid redundant round trips while
 * ensuring the list updates within `max-age + swr` seconds of a mutation.
 *
 * Defaults:
 *   - `maxAgeMs` — 30 seconds (show fresh data quickly after a recheck)
 *   - `swrMs`    — 60 seconds (serve stale while re-fetching in background)
 *
 * @param maxAgeMs  Freshness window in milliseconds (default 30 s).
 * @param swrMs     Stale-while-revalidate window in milliseconds (default 60 s).
 */
export function buildContributorListCacheControl(
  maxAgeMs: number = 30_000,
  swrMs: number = 60_000
): string {
  const maxAge = Math.floor(maxAgeMs / 1000);
  const swr = Math.floor(swrMs / 1000);
  return `private, max-age=${maxAge}, stale-while-revalidate=${swr}`;
}
