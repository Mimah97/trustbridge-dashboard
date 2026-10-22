import { NextRequest, NextResponse } from "next/server";

import { isAuthorizedScheduler, requireMaintainerSession } from "@/lib/api-auth";
import {
  API_KEY_RATE_LIMIT,
  authenticateApiKey,
  buildRateLimitHeaders,
  hasScope,
  insufficientScopeResponse,
} from "@/lib/api-key-auth";
import { assertSameOrigin } from "@/lib/csrf";
import {
  getLastDigestHealth,
  runCronDigest,
} from "@/lib/cron-digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cron/digest
 *
 * Triggers a scheduled not-ready contributor digest email to the configured
 * maintainer address. Sends aggregate counts and a dashboard link by default;
 * set DIGEST_INCLUDE_FULL_LIST=true to include per-contributor details.
 *
 * Auth: maintainer session (manual trigger) OR `Authorization: Bearer $CRON_SECRET`
 * (automated daily/weekly cron run via Vercel Cron or equivalent).
 *
 * Schedule gate: in-process minimum interval (DIGEST_CRON_MIN_INTERVAL_MS,
 * default 1 hour) prevents spam from misconfigured schedulers.
 *
 * Never throws: DB and email failures are returned as { status: "error" } with
 * HTTP 502 so the scheduler can log the failure without entering a retry storm.
 */
export async function POST(request: NextRequest) {
  // ── CSRF guard (allows scheduler requests with no Origin header) ───────────
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  // ── Auth: maintainer session OR CRON_SECRET bearer token ─────────────────
  const session = await requireMaintainerSession();
  const isScheduler = isAuthorizedScheduler(request);

  // Automation API keys may trigger digest runs with the `cron:trigger` scope.
  let apiKeyActor: { createdById: string; name: string } | null = null;
  if (!session && !isScheduler && request.headers.get("authorization")) {
    const apiKeyAuth = await authenticateApiKey(request);
    if (!apiKeyAuth) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if ("rateLimited" in apiKeyAuth) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: buildRateLimitHeaders(
            apiKeyAuth.result,
            API_KEY_RATE_LIMIT.maxRequests
          ),
        }
      );
    }
    if (!hasScope(apiKeyAuth.scopes, "cron:trigger")) {
      return insufficientScopeResponse("cron:trigger");
    }
    apiKeyActor = apiKeyAuth;
  }

  if (!session && !isScheduler && !apiKeyActor) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await runCronDigest({
    actorId: session?.user?.id ?? apiKeyActor?.createdById ?? null,
    actorLogin:
      session?.user?.githubUsername ?? (apiKeyActor ? `api-key:${apiKeyActor.name}` : "scheduler:cron"),
  });

  return NextResponse.json(result, {
    status: result.status === "error" ? 502 : 200,
  });
}

/**
 * GET /api/cron/digest
 *
 * Read-only status of the most recent digest run.
 * Unauthenticated — returns only aggregate metrics, no contributor PII.
 */
export async function GET() {
  return NextResponse.json({ lastRun: getLastDigestHealth() });
}
