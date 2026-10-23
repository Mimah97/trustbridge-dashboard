import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { invalidateContributorListCaches } from "@/lib/cache-tags";
import { recordAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const registration = await prisma.registration.findFirst({
    where: { id: params.id, deletedAt: { not: null } },
  });
  if (!registration) {
    return NextResponse.json(
      { error: "Deleted registration not found" },
      { status: 404 }
    );
  }

  try {
    const restored = await prisma.registration.update({
      where: { id: params.id },
      data: { deletedAt: null },
    });

    await recordAuditLog({
      action: "registration.restore",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      targetId: restored.id,
      targetLabel: restored.stellarAddress,
      metadata: { restoredAt: new Date().toISOString() },
    });

    await invalidateContributorListCaches();

    return NextResponse.json({ success: true, registration: restored });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return NextResponse.json(
        { error: "This Stellar address is already actively registered" },
        { status: 409 }
      );
    }
    throw error;
  }
}