"use client";

import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * OfflineBanner
 *
 * Shows a non-intrusive amber banner when the browser reports that the
 * network is unavailable. The banner dismisses automatically when the
 * connection is restored.
 *
 * Implementation notes:
 * - Client component: uses `navigator.onLine` + `online`/`offline` events.
 * - Initial state reads `navigator.onLine` in the effect (not during render)
 *   to avoid SSR hydration mismatch — the server has no concept of network
 *   state, so we default to `true` and let the first effect correct it.
 * - Follows the same visual pattern as MaintenanceBanner for consistency,
 *   but uses a distinct amber-600/yellow palette to signal a transient
 *   connectivity state rather than a site-wide alert.
 * - `aria-live="polite"` so screen readers announce the banner without
 *   interrupting current reading.
 * - `forceOffline` lets Storybook/tests render the offline state
 *   deterministically without depending on the real `navigator.onLine`.
 */
export interface OfflineBannerProps {
  /**
   * When provided, overrides the live network state. Intended for
   * Storybook visual QA and tests; production call sites omit it.
   */
  forceOffline?: boolean;
}

export function OfflineBanner({ forceOffline }: OfflineBannerProps = {}) {
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    // Correct the initial state after mount (avoids SSR mismatch)
    setIsOffline(!navigator.onLine);

    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const offline = forceOffline ?? isOffline;

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className="flex items-center justify-center gap-2 border-b border-yellow-400 bg-yellow-100 px-4 py-2 text-center text-sm font-medium text-yellow-900 dark:border-yellow-600 dark:bg-yellow-950 dark:text-yellow-100"
    >
      <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        You&apos;re offline. Live Horizon data and Stellar checks are unavailable
        until your connection is restored.
      </span>
    </div>
  );
}
