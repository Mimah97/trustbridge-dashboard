import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { invalidateContributorListCaches } from "@/lib/cache-tags";
import { banContributor, unbanContributor } from "@/lib/ban-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Maintainer endpoint for banning or unbanning a contributor by GitHub handle.
 * Requires maintainer session and a mandatory reason for bans.
 */
export async function POST(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireMaintainerSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Forbidden. Maintainer access required." }, { status: 403 });
  }

  try {
    const body = (await request.json()) as {
      action?: "ban" | "unban";
      githubUsername?: string;
      reason?: string;
    };

    const action = body.action ?? "ban";
    const githubUsername = body.githubUsername?.trim();
    const reason = body.reason?.trim();

    if (!githubUsername) {
      return NextResponse.json({ error: "githubUsername is required." }, { status: 400 });
    }

    if (action === "ban") {
      if (!reason) {
        return NextResponse.json({ error: "Reason is required to ban a contributor." }, { status: 400 });
      }

      const result = await banContributor({
        githubUsername,
        reason,
        actorId: session.user.id,
        actorLogin: session.user.githubUsername ?? null,
      });

      await invalidateContributorListCaches();

      return NextResponse.json({
        success: true,
        message: `Contributor @${result.githubUsername} has been banned.`,
        details: result,
      });
    } else if (action === "unban") {
      const result = await unbanContributor({
        githubUsername,
        actorId: session.user.id,
        actorLogin: session.user.githubUsername ?? null,
        reason,
      });

      await invalidateContributorListCaches();

      return NextResponse.json({
        success: true,
        message: `Contributor @${result.githubUsername} has been unbanned.`,
        details: result,
      });
    } else {
      return NextResponse.json({ error: "Invalid action. Must be 'ban' or 'unban'." }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to execute ban action.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
