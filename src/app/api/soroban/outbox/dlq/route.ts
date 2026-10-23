import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { listSorobanOutboxDeadLetters } from "@/lib/soroban-outbox-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawLimit = request.nextUrl.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return NextResponse.json(
      { error: "Limit must be an integer between 1 and 200" },
      { status: 400 }
    );
  }

  try {
    const items = await listSorobanOutboxDeadLetters(
      session.user.maintainerOrgId ?? "default",
      limit
    );
    return NextResponse.json({ items, count: items.length });
  } catch {
    return NextResponse.json(
      { error: "Failed to load Soroban outbox dead letters" },
      { status: 500 }
    );
  }
}