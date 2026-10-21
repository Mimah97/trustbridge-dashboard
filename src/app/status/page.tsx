import type { Metadata } from "next";

import { runHealthChecks } from "@/lib/health";
import { StatusClient } from "./StatusClient";

export const metadata: Metadata = {
  title: "Status",
  description: "TrustBridge service status — dashboard, database, Horizon, and Soroban RPC.",
};

/**
 * ISR: revalidate every 30 s so CDN edges stay fresh.
 * Operators can also trigger an immediate re-fetch with the "Check now" button
 * rendered by StatusClient (see #309).
 */
export const revalidate = 30;

/**
 * Status page (#308 + #309).
 *
 * Calls runHealthChecks() directly instead of fetching
 * NEXT_PUBLIC_APP_URL/api/health — no fragile self-HTTP hop, no dependency on
 * the public URL being correctly set in preview/production environments.
 *
 * The SSR snapshot is passed to StatusClient as `initial`. StatusClient is a
 * "use client" component that adds the accessible "Check now" refresh button
 * without blocking the initial server render.
 */
export default async function StatusPage() {
  let health;
  try {
    health = await runHealthChecks();
  } catch {
    health = null;
  }

  if (!health) {
    return (
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-2xl px-6 py-16 sm:px-8">
        <h1 className="text-2xl font-bold tracking-tight">Service status</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Unable to fetch status. The service may be starting up.
        </p>
      </main>
    );
  }

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-2xl px-6 py-16 sm:px-8">
      <StatusClient initial={health} />
    </main>
  );
}
