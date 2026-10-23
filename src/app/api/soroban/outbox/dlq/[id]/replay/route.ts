import { NextResponse, type NextRequest } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { recordAuditLog } from "@/lib/audit";
import { assertSameOrigin } from "@/lib/csrf";
import { isFeatureEnabled } from "@/lib/feature-flags";
import {
  processSorobanOutbox,
  replayFailedSorobanOutboxEntry,
} from "@/lib/soroban-outbox-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { id: string };
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!(await isFeatureEnabled("dlq_retry"))) {
    return NextResponse.json(
      { error: "Dead-letter retry is currently disabled" },
      { status: 403 }
    );
  }

  const id = params.id?.trim();
  if (!id) {
    return NextResponse.json({ error: "Outbox item ID is required" }, { status: 400 });
  }

  try {
    const maintainerOrgId = session.user.maintainerOrgId ?? "default";
    const item = await replayFailedSorobanOutboxEntry(id, maintainerOrgId);
    if (!item) {
      return NextResponse.json(
        { error: "Outbox item not found or not replayable" },
        { status: 404 }
      );
    }

    await recordAuditLog({
      action: "soroban.outbox.replayed",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      targetId: item.id,
      targetLabel: `${item.action} (${item.id})`,
      metadata: { action: item.action, previousAttempts: item.previousAttempts },
    });

    const result = await processSorobanOutbox({
      batchSize: 1,
      entryId: item.id,
      maintainerOrgId,
    });

    return NextResponse.json({
      item: {
        id: item.id,
        status: result.successCount > 0 ? "COMPLETED" : "PENDING",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Soroban outbox replay could not be completed" },
      { status: 503 }
    );
  }
}