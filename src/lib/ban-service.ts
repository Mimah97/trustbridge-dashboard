import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";
import { buildBanEmail, sendEmailNotification } from "@/lib/email";

export interface BanStatus {
  banned: boolean;
  reason?: string;
  bannedAt?: Date;
}

export type BanAppealOutcome = "pending" | "approved" | "denied";

export interface BanAppealNote {
  id: string;
  githubUsername: string;
  note: string;
  outcome: BanAppealOutcome;
  actorId: string;
  actorLogin?: string | null;
  createdAt: Date;
}

const BAN_APPEAL_OUTCOMES: readonly BanAppealOutcome[] = ["pending", "approved", "denied"];

/**
 * Case-insensitive check if a contributor or GitHub handle is banned.
 */
export async function isUserBanned(
  userId?: string | null,
  githubUsername?: string | null
): Promise<BanStatus> {
  if (!userId && !githubUsername) {
    return { banned: false };
  }

  try {
    // Check by user ID if provided
    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { banned: true, banReason: true, bannedAt: true, githubUsername: true },
      });
      if (user?.banned) {
        return {
          banned: true,
          reason: user.banReason ?? "Account is suspended",
          bannedAt: user.bannedAt ?? undefined,
        };
      }
      if (!githubUsername && user?.githubUsername) {
        githubUsername = user.githubUsername;
      }
    }

    // Case-insensitive check on BannedContributor table
    if (githubUsername) {
      const lowerUsername = githubUsername.trim().toLowerCase();
      const bannedRecord = await prisma.bannedContributor.findFirst({
        where: {
          githubUsername: {
            equals: lowerUsername,
            mode: "insensitive",
          },
        },
      });

      if (bannedRecord) {
        return {
          banned: true,
          reason: bannedRecord.reason,
          bannedAt: bannedRecord.createdAt,
        };
      }
    }

    return { banned: false };
  } catch (error) {
    console.error("Failed to check user ban status:", error);
    // Fail open or closed depending on security requirement - fail safe by allowing if DB error, but logging
    return { banned: false };
  }
}

/**
 * Bans a contributor by GitHub handle with a mandatory reason.
 */
export async function banContributor({
  githubUsername,
  reason,
  actorId,
  actorLogin,
  locale,
}: {
  githubUsername: string;
  reason: string;
  actorId: string;
  actorLogin?: string | null;
  locale?: string;
}) {
  const normalizedUsername = githubUsername.trim().toLowerCase();
  const trimmedReason = reason.trim();

  if (!trimmedReason) {
    throw new Error("A reason is required to ban a contributor.");
  }

  // Update existing user if present
  const user = await prisma.user.findFirst({
    where: {
      githubUsername: {
        equals: normalizedUsername,
        mode: "insensitive",
      },
    },
  });

  if (user) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        banned: true,
        bannedAt: new Date(),
        banReason: trimmedReason,
        bannedById: actorId,
      },
    });
  }

  // Upsert into BannedContributor table for persistent ban across re-registrations
  await prisma.bannedContributor.upsert({
    where: { githubUsername: normalizedUsername },
    create: {
      githubUsername: normalizedUsername,
      reason: trimmedReason,
      bannedById: actorId,
    },
    update: {
      reason: trimmedReason,
      bannedById: actorId,
    },
  });

  // Log audit event
  await recordAuditLog({
    action: "contributor.banned",
    actorId,
    actorLogin: actorLogin ?? null,
    targetId: user?.id ?? null,
    targetLabel: normalizedUsername,
    metadata: {
      reason: trimmedReason,
      githubUsername: normalizedUsername,
    },
  });

  let emailSent = false;
  if (user?.email) {
    try {
      const template = buildBanEmail({
        githubUsername: normalizedUsername,
        reason: trimmedReason,
        locale,
      });
      emailSent = await sendEmailNotification({ to: user.email, ...template });
    } catch (error) {
      console.error("Failed to build or send contributor ban notice:", error);
    }
  }

  return {
    success: true,
    githubUsername: normalizedUsername,
    reason: trimmedReason,
    emailSent,
  };
}

/**
 * Unbans a contributor by GitHub handle.
 */
export async function unbanContributor({
  githubUsername,
  actorId,
  actorLogin,
  reason,
}: {
  githubUsername: string;
  actorId: string;
  actorLogin?: string | null;
  reason?: string;
}) {
  const normalizedUsername = githubUsername.trim().toLowerCase();

  const user = await prisma.user.findFirst({
    where: {
      githubUsername: {
        equals: normalizedUsername,
        mode: "insensitive",
      },
    },
  });

  if (user) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        banned: false,
        bannedAt: null,
        banReason: null,
        bannedById: null,
      },
    });
  }

  await prisma.bannedContributor.deleteMany({
    where: {
      githubUsername: {
        equals: normalizedUsername,
        mode: "insensitive",
      },
    },
  });

  await recordAuditLog({
    action: "contributor.unbanned",
    actorId,
    actorLogin: actorLogin ?? null,
    targetId: user?.id ?? null,
    targetLabel: normalizedUsername,
    metadata: {
      reason: reason ?? "Maintainer lifted ban",
      githubUsername: normalizedUsername,
    },
  });

  return { success: true, githubUsername: normalizedUsername };
}

/**
 * Records a ban appeal note with an outcome for a contributor and writes an
 * audit trail entry. Validates inputs before any privileged state is touched so
 * a failure leaves no partial state behind.
 */
export async function addBanAppealNote({
  githubUsername,
  note,
  outcome,
  actorId,
  actorLogin,
}: {
  githubUsername: string;
  note: string;
  outcome: BanAppealOutcome;
  actorId: string;
  actorLogin?: string | null;
}): Promise<BanAppealNote> {
  const normalizedUsername = (githubUsername ?? "").trim().toLowerCase();
  const trimmedNote = (note ?? "").trim();

  if (!normalizedUsername) {
    throw new Error("A githubUsername is required to record a ban appeal note.");
  }
  if (!trimmedNote) {
    throw new Error("A note is required to record a ban appeal.");
  }
  if (!BAN_APPEAL_OUTCOMES.includes(outcome)) {
    throw new Error(
      `Invalid ban appeal outcome. Expected one of: ${BAN_APPEAL_OUTCOMES.join(", ")}.`
    );
  }

  const user = await prisma.user.findFirst({
    where: {
      githubUsername: {
        equals: normalizedUsername,
        mode: "insensitive",
      },
    },
  });

  const appealNote: BanAppealNote = {
    id: `${normalizedUsername}:${Date.now()}`,
    githubUsername: normalizedUsername,
    note: trimmedNote,
    outcome,
    actorId,
    actorLogin: actorLogin ?? null,
    createdAt: new Date(),
  };

  await recordAuditLog({
    action: "contributor.ban_appeal_note",
    actorId,
    actorLogin: actorLogin ?? null,
    targetId: user?.id ?? null,
    targetLabel: normalizedUsername,
    metadata: {
      githubUsername: normalizedUsername,
      note: trimmedNote,
      outcome,
    },
  });

  return appealNote;
}
