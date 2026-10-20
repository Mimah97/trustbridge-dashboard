/**
 * Shared health-check logic for the TrustBridge Dashboard.
 *
 * Extracted so that `src/app/status/page.tsx` can import this directly
 * instead of fetching NEXT_PUBLIC_APP_URL/api/health (which is fragile in
 * preview/production and adds an unnecessary HTTP hop). (#308)
 *
 * The API route at `src/app/api/health/route.ts` also calls `runHealthChecks`
 * so both paths stay in sync. (#403)
 *
 * Dependency probes distinguish DB vs queue vs RPC failures with structured
 * statuses so incident response can tell which backend is degraded. (#589)
 */

import { getContractSyncHealth } from "@/lib/contract-sync";
import { prisma } from "@/lib/prisma";
import { buildStalenessSummary } from "@/lib/stale-export";
import { toContributorRow } from "@/lib/registrations";
import { captureException } from "@/lib/sentry";

export type HealthStatus = "ok" | "degraded" | "error";

/**
 * Structured result of a single dependency probe. `kind` identifies which
 * backend failed (db, queue, rpc) so operators can triage without parsing
 * free-form error strings.
 */
export interface DependencyProbe {
  status: HealthStatus;
  latencyMs: number;
  error?: string;
}

export interface HealthResponse {
  status: HealthStatus;
  timestamp: string;
  checks: {
    database: DependencyProbe;
    queue: DependencyProbe;
    horizon: { status: HealthStatus; latencyMs: number };
    sorobanRpc: { status: HealthStatus; latencyMs: number };
    csvStaleness: {
      status: HealthStatus;
      staleCount: number;
      totalCount: number;
      stalePercent: number;
      warning: string;
    };
    contractSync: {
      status: HealthStatus;
      lastRunAt: string | null;
      lastError?: string;
    };
  };
  version: string;
}

/**
 * HTTP status code that should accompany a given overall health status.
 * Shared so the API route and any other consumer agree on the mapping.
 */
export function healthStatusCode(status: HealthStatus): number {
  return status === "error" ? 503 : 200;
}

/** Probe Horizon by hitting /fee_stats — lightweight, no auth, always available. */
async function probeHorizon(): Promise<{ ok: boolean; latencyMs: number }> {
  const url =
    (process.env.NEXT_PUBLIC_HORIZON_URL?.trim() || "https://horizon.stellar.org") +
    "/fee_stats";
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "application/json" },
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

/** Probe Soroban RPC by sending a minimal getHealth JSON-RPC call. */
async function probeSorobanRpc(): Promise<{ ok: boolean; latencyMs: number }> {
  const url =
    process.env.SOROBAN_RPC_URL?.trim() || "https://soroban-testnet.stellar.org";
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    if (!res.ok) return { ok: false, latencyMs: Date.now() - start };
    const json = (await res.json()) as { result?: { status?: string } };
    return { ok: json.result?.status === "healthy", latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

/**
 * Probe the Prisma database with a lightweight `SELECT 1`.
 * Returns a structured probe so DB failures are distinguishable from
 * queue/RPC failures in the health payload. (#589)
 */
async function probeDatabase(): Promise<DependencyProbe> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    captureException(err, { surface: "health", check: "database" });
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown database error",
    };
  }
}

/**
 * Probe the queue backend. The queue is considered healthy when its backing
 * store is reachable; a missing/unreachable queue degrades (not errors) the
 * overall status so a queue outage does not mask a healthy DB. (#589)
 */
async function probeQueue(): Promise<DependencyProbe> {
  const start = Date.now();
  const queueUrl = process.env.QUEUE_HEALTH_URL?.trim();
  if (!queueUrl) {
    // No queue backend configured — treat as healthy no-op.
    return { status: "ok", latencyMs: 0 };
  }
  try {
    const res = await fetch(queueUrl, {
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      captureException(new Error("Queue health probe failed"), {
        surface: "health",
        check: "queue",
        statusCode: res.status,
      });
      return {
        status: "degraded",
        latencyMs: Date.now() - start,
        error: `Queue backend returned ${res.status}`,
      };
    }
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    captureException(err, { surface: "health", check: "queue" });
    return {
      status: "degraded",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown queue error",
    };
  }
}

/**
 * Run all health checks and return a typed HealthResponse.
 * Called server-side by both the API route and the status page.
 */
export async function runHealthChecks(): Promise<HealthResponse> {
  const timestamp = new Date().toISOString();
  const version = process.env.npm_package_version ?? "0.1.0";

  const [horizonProbe, rpcProbe, dbProbe, queueProbe] = await Promise.all([
    probeHorizon(),
    probeSorobanRpc(),
    probeDatabase(),
    probeQueue(),
  ]);

  const dbStatus: HealthStatus = dbProbe.status;

  if (!horizonProbe.ok) {
    captureException(new Error("Horizon health probe failed"), {
      surface: "health",
      check: "horizon",
    });
  }

  if (!rpcProbe.ok) {
    captureException(new Error("Soroban RPC health probe failed"), {
      surface: "health",
      check: "sorobanRpc",
    });
  }

  const horizonStatus: HealthStatus = horizonProbe.ok ? "ok" : "degraded";
  const rpcStatus: HealthStatus = rpcProbe.ok ? "ok" : "degraded";

  // CSV staleness check (only when DB is reachable)
  let csvStatus: HealthStatus = "ok";
  let csvSummary = { staleCount: 0, totalCount: 0, stalePercent: 0, warning: "" };
  if (dbStatus !== "error") {
    try {
      const registrations = await prisma.registration.findMany({
        where: { deletedAt: null },
        include: { user: { select: { githubUsername: true } } },
        orderBy: { updatedAt: "desc" },
      });
      const rows = registrations.map(toContributorRow);
      const summary = buildStalenessSummary(rows);
      csvSummary = {
        staleCount: summary.staleCount,
        totalCount: summary.totalCount,
        stalePercent: summary.stalePercent,
        warning: summary.warning,
      };
      if (summary.stale) csvStatus = "degraded";
    } catch {
      csvStatus = "degraded";
      csvSummary.warning =
        "Unable to determine CSV staleness. Re-check contributor data before exporting.";
    }
  }

  // Contract sync status
  const lastSync = getContractSyncHealth();
  const contractSyncStatus: HealthStatus =
    lastSync?.status === "error" ? "degraded" : "ok";

  // Overall status
  let overallStatus: HealthStatus = "ok";
  if (dbStatus === "error") {
    overallStatus = "error";
  } else if (
    csvStatus === "degraded" ||
    contractSyncStatus === "degraded" ||
    horizonStatus === "degraded" ||
    rpcStatus === "degraded" ||
    queueProbe.status === "degraded"
  ) {
    overallStatus = "degraded";
  }

  return {
    status: overallStatus,
    timestamp,
    checks: {
      database: dbProbe,
      queue: queueProbe,
      horizon: { status: horizonStatus, latencyMs: horizonProbe.latencyMs },
      sorobanRpc: { status: rpcStatus, latencyMs: rpcProbe.latencyMs },
      csvStaleness: { status: csvStatus, ...csvSummary },
      contractSync: {
        status: contractSyncStatus,
        lastRunAt: lastSync?.startedAt ?? null,
        ...(lastSync?.errors?.length ? { lastError: lastSync.errors.join("; ") } : {}),
      },
    },
    version,
  };
}
