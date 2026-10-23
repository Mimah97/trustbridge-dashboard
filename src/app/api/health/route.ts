import { NextResponse } from "next/server";

import { publicOptionsResponse, withPublicCors } from "@/lib/public-cors";
import { runHealthChecks } from "@/lib/health";
export type { HealthStatus, HealthResponse } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Lightweight liveness + readiness probe for the TrustBridge Dashboard.
 *
 * Consumed by `NetworkStatusPanel` to render live RPC health. The response
 * shape is the `HealthResponse` contract from `@/lib/health`; the panel
 * tolerates partial payloads, but this route always returns a well-formed
 * body so operators get a stable contract.
 */
export async function GET() {
  let body;
  try {
    body = await runHealthChecks();
  } catch (error) {
    // Never let a probe failure surface as an unhandled 500 — the panel
    // renders this as an "unavailable" state instead of crashing.
    body = {
      status: "unavailable" as const,
      checks: [],
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Health check failed",
    };
  }

  return withPublicCors(
    NextResponse.json(body, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
      },
    })
  );
}

export function OPTIONS() {
  return publicOptionsResponse("GET, OPTIONS");
}
