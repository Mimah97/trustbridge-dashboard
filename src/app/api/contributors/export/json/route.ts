import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import {
  API_KEY_RATE_LIMIT,
  authenticateApiKey,
  buildRateLimitHeaders,
  hasScope,
  insufficientScopeResponse,
} from "@/lib/api-key-auth";
import { recordAuditLog } from "@/lib/audit";
import {
  buildWalletProofInfo,
  buildHorizonDebugInfo,
} from "@/lib/registration-insights";
import { getContributors } from "@/lib/registrations";
import { buildJson, buildJsonFilename } from "@/lib/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // ── Auth: session (browser) OR API key (cron/automation) ──────────────
  let actorId: string | null = null;
  let actorLogin: string | null = null;

  const session = await requireMaintainerSession();
  if (session) {
    actorId = session.user.id;
    actorLogin = session.user.githubUsername ?? null;
  } else {
    const apiKeyAuth = await authenticateApiKey(request);

    if (!apiKeyAuth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    if (!hasScope(apiKeyAuth.scopes, "export:read")) {
      return insufficientScopeResponse("export:read");
    }

    actorId = apiKeyAuth.createdById;
    actorLogin = `api-key:${apiKeyAuth.name}`;
  }

  try {
    const { contributors, total } = await getContributors();

    if (contributors.length === 0) {
      return NextResponse.json(
        { error: "No contributors to export" },
        { status: 400 }
      );
    }

    const headers = [
      "id",
      "githubUsername",
      "stellarAddress",
      "funded",
      "trustlineReady",
      "trustlineAuthorized",
      "verified",
      "xlmBalance",
      "spendableXlmBalance",
      "readiness",
      "lastCheckedAt",
      "horizonDebugSummary",
      "horizonNextAction",
      "freighterProofChallenge",
    ];

    const rows = contributors.map((contributor) => {
      const horizonDebug =
        contributor.horizonDebug ??
        buildHorizonDebugInfo({
          funded: contributor.funded,
          trustlineReady: contributor.trustlineReady,
          trustlineAuthorized: contributor.trustlineAuthorized,
          readiness: contributor.readiness,
          xlmBalance: contributor.xlmBalance,
          spendableXlmBalance: contributor.spendableXlmBalance,
          lastCheckedAt: contributor.lastCheckedAt,
        });
      const walletProof =
        contributor.walletProof ??
        buildWalletProofInfo(
          contributor.stellarAddress,
          contributor.githubUsername
        );

      return [
        contributor.id,
        contributor.githubUsername,
        contributor.stellarAddress,
        contributor.funded,
        contributor.trustlineReady,
        contributor.trustlineAuthorized,
        contributor.verified,
        contributor.xlmBalance,
        contributor.spendableXlmBalance,
        contributor.readiness,
        contributor.lastCheckedAt || "",
        horizonDebug.summary,
        horizonDebug.nextAction,
        walletProof.challenge,
      ];
    });

    const json = buildJson(headers, rows);
    const filename = buildJsonFilename("contributors");

    await recordAuditLog({
      action: "export.json",
      actorId,
      actorLogin,
      metadata: {
        contributorCount: total,
        filename,
      },
    });

    return new NextResponse(json, {
      status: 200,
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await recordAuditLog({
      action: "export.json.failed",
      actorId,
      actorLogin,
      metadata: { error: message },
    });

    return NextResponse.json(
      { error: "Failed to export JSON", details: message },
      { status: 500 }
    );
  }
}
