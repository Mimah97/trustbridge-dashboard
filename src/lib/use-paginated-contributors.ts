"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { ContributorRow } from "@/types";

export interface PaginatedContributorsPage {
  contributors: ContributorRow[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
}

/**
 * Authoritative contributor page size (#496).
 *
 * This is the single declaration of the default page size for the dashboard's
 * cursor pagination. `useInfiniteContributors` keeps its own copy for the
 * infinite-scroll hook it serves; both default to the API's documented default
 * of 25 (see docs/LOGGING_AND_PAGINATION.md).
 */
const ITEMS_PER_PAGE = 25;

/**
 * Fetches every contributor in one shot (limit=1000) for panels that need the
 * full list — WaveReadinessBar, WavePrepWorkspace, DisputePanel.
 *
 * Uses the same query-key prefix ("contributors") as usePaginatedContributors
 * so invalidateQueries({ queryKey: ["contributors"] }) refreshes both.
 *
 * Part of the #307 fix: replaces useInfiniteContributors which was causing a
 * duplicate /api/contributors/paginated request on every dashboard mount.
 */
export function useAllContributors() {
  const query = useQuery<PaginatedContributorsPage>({
    queryKey: ["contributors", "all"],
    queryFn: async () => {
      const response = await fetch("/api/contributors/paginated?limit=1000");
      if (!response.ok) throw new Error("Failed to load contributors");
      return (await response.json()) as PaginatedContributorsPage;
    },
    staleTime: 30_000,
  });

  return {
    contributors: query.data?.contributors ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * Clamp a caller-supplied page size to a usable whole number.
 *
 * A `0`, negative, fractional, NaN, or infinite page size would otherwise be
 * sent to `/api/contributors/paginated` verbatim; `limit=0` comes back as an
 * empty page, which makes `hasMore` and the pager look wrong rather than
 * surfacing the bad input. Falling back to ITEMS_PER_PAGE keeps the default
 * (25) authoritative and matches the API's documented default.
 */
function normalizePageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize) || pageSize < 1) return ITEMS_PER_PAGE;
  return Math.floor(pageSize);
}

/**
 * Normalize a raw `cursor` query-string value into a usable cursor.
 *
 * Empty strings, whitespace-only values, and repeated params (`?cursor=a&cursor=b`
 * yields the first value) are treated as "no cursor" so a malformed URL falls
 * back to the first page instead of sending a bogus cursor to the API.
 */
function normalizeCursor(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Page-by-page cursor navigation for the maintainer dashboard.
 *
 * Unlike `useInfiniteContributors` (which accumulates all pages into one flat
 * list for infinite scroll), this hook loads exactly one page at a time and
 * exposes `goToNext` / `goToPrev` handlers that update the URL query string
 * so the current page survives a browser refresh.
 *
 * The cursor stack keeps track of every forward step so that going back is
 * simply popping the last cursor rather than re-fetching the entire history.
 *
 * The `cursor` query param is the source of truth for the current page (#530):
 * it is read on mount, kept in sync with browser back/forward navigation, and
 * written on every forward/back/reset step so a reload or shared link lands on
 * the same page.
 *
 * @param pageSize Number of contributors per page (default 25, max 100).
 */
export function usePaginatedContributors(pageSize: number = ITEMS_PER_PAGE) {
  const pageLimit = normalizePageSize(pageSize);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Read initial cursor from URL on mount
  const initialCursor = normalizeCursor(searchParams?.get("cursor"));

  // Stack of cursors — entry[0] is initialCursor (or null for first page),
  // subsequent entries are the nextCursor values returned by each page.
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([initialCursor]);

  // Sync cursor stack if the URL cursor changes externally (e.g. browser back/forward or direct navigation)
  useEffect(() => {
    const urlCursor = normalizeCursor(searchParams?.get("cursor"));
    setCursorStack((prev) => {
      const activeCursor = prev[prev.length - 1];
      if (activeCursor !== urlCursor) {
        // If the URL cursor is already in the stack, slice back to it; otherwise reset stack to urlCursor
        const existingIndex = prev.indexOf(urlCursor);
        if (existingIndex !== -1) {
          return prev.slice(0, existingIndex + 1);
        }
        return [urlCursor];
      }
      return prev;
    });
  }, [searchParams]);

  // currentCursor is always the last entry in the stack.
  const currentCursor = cursorStack[cursorStack.length - 1];
  const pageIndex = cursorStack.length - 1; // 0-based page index

  // Helper to push updated cursor query param to URL
  const updateUrlCursor = useCallback(
    (newCursor: string | null) => {
      const params = new URLSearchParams(searchParams ? searchParams.toString() : "");
      if (newCursor) {
        params.set("cursor", newCursor);
      } else {
        params.delete("cursor");
      }
      const qs = params.toString();
      const newUrl = qs ? `${pathname}?${qs}` : pathname;
      router.push(newUrl);
    },
    [pathname, router, searchParams]
  );

  const query = useQuery<PaginatedContributorsPage>({
    queryKey: ["contributors", "paged", currentCursor, pageLimit],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(pageLimit) });
      if (currentCursor) {
        params.set("cursor", currentCursor);
      }
      const response = await fetch(
        `/api/contributors/paginated?${params.toString()}`
      );
      if (!response.ok) {
        throw new Error("Failed to load contributors");
      }
      return (await response.json()) as PaginatedContributorsPage;
    },
    staleTime: 30_000,
  });

  const goToNext = useCallback(() => {
    const nextCursor = query.data?.nextCursor;
    if (nextCursor) {
      setCursorStack((prev) => [...prev, nextCursor]);
      updateUrlCursor(nextCursor);
    }
  }, [query.data?.nextCursor, updateUrlCursor]);

  const goToPrev = useCallback(() => {
    setCursorStack((prev) => {
      if (prev.length > 1) {
        const nextStack = prev.slice(0, -1);
        const prevCursor = nextStack[nextStack.length - 1];
        updateUrlCursor(prevCursor);
        return nextStack;
      }
      return prev;
    });
  }, [updateUrlCursor]);

  const reset = useCallback(() => {
    setCursorStack([null]);
    updateUrlCursor(null);
  }, [updateUrlCursor]);

  return {
    contributors: query.data?.contributors ?? [],
    total: query.data?.total ?? 0,
    hasMore: query.data?.hasMore ?? false,
    hasPrev: pageIndex > 0 || (currentCursor !== null && cursorStack.length > 1),
    pageIndex,
    currentCursor,
    isLoading: query.isLoading,
    isError: query.isError,
    goToNext,
    goToPrev,
    reset,
  };
}
