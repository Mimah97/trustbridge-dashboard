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
  getContributors,
} from "@/lib/registrations";
import {
  buildContributorsCsv,
  getContributorsCsvFilename,
} from "@/lib/csv-export";

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

    const csv = buildContributorsCsv(contributors);
    const filename = getContributorsCsvFilename();

    await recordAuditLog({
      action: "export.csv",
      actorId,
      actorLogin,
      metadata: {
        contributorCount: total,
        filename,
      },
    });

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await recordAuditLog({
      action: "export.csv.failed",
      actorId,
      actorLogin,
      metadata: { error: message },
    });

    return NextResponse.json(
      { error: "Failed to export CSV", details: message },
      { status: 500 }
    );
  }
}
