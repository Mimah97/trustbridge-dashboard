import { describe, it, expect, beforeEach, vi } from "vitest";
import { isUserBanned, banContributor, unbanContributor } from "@/lib/ban-service";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    bannedContributor: {
      findFirst: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/email", () => ({
  buildBanEmail: vi.fn(),
  sendEmailNotification: vi.fn(),
}));

import { buildBanEmail, sendEmailNotification } from "@/lib/email";

describe("Ban Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns banned: false for unbanned user", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      banned: false,
      banReason: null,
      bannedAt: null,
      githubUsername: "contributor1",
    } as any);
    vi.mocked(prisma.bannedContributor.findFirst).mockResolvedValue(null);

    const status = await isUserBanned("user-1", "contributor1");
    expect(status.banned).toBe(false);
  });

  it("returns banned: true when user record has banned flag", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      banned: true,
      banReason: "TOS Violation",
      bannedAt: new Date("2026-08-30"),
      githubUsername: "spammer",
    } as any);

    const status = await isUserBanned("user-2", "spammer");
    expect(status.banned).toBe(true);
    expect(status.reason).toBe("TOS Violation");
  });

  it("returns banned: true when username matches BannedContributor (case-insensitive)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.bannedContributor.findFirst).mockResolvedValue({
      id: "ban-1",
      githubUsername: "bad_actor",
      reason: "Compromised account",
      createdAt: new Date(),
    } as any);

    const status = await isUserBanned(null, "BAD_ACTOR");
    expect(status.banned).toBe(true);
    expect(status.reason).toBe("Compromised account");
  });

  it("bans contributor with mandatory reason and logs audit event", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user-99",
      githubUsername: "malicious_user",
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValue({} as any);
    vi.mocked(prisma.bannedContributor.upsert).mockResolvedValue({} as any);

    const result = await banContributor({
      githubUsername: "MALICIOUS_USER",
      reason: "Wallet theft report #102",
      actorId: "maintainer-1",
      actorLogin: "admin",
    });

    expect(result.success).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-99" },
        data: expect.objectContaining({
          banned: true,
          banReason: "Wallet theft report #102",
        }),
      })
    );
    expect(prisma.bannedContributor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { githubUsername: "malicious_user" },
      })
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contributor.banned",
        actorId: "maintainer-1",
        targetLabel: "malicious_user",
      })
    );
  });

  it("sends the ban notice in the selected locale when the user has an email", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user-99",
      githubUsername: "malicious_user",
      email: "user@example.com",
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValue({} as any);
    vi.mocked(prisma.bannedContributor.upsert).mockResolvedValue({} as any);
    vi.mocked(buildBanEmail).mockReturnValue({ subject: "Aviso", body: "Suspenso" });
    vi.mocked(sendEmailNotification).mockResolvedValue(true);

    const result = await banContributor({
      githubUsername: "malicious_user",
      reason: "Abuse",
      actorId: "maintainer-1",
      locale: "es",
    });

    expect(result.emailSent).toBe(true);
    expect(buildBanEmail).toHaveBeenCalledWith({
      githubUsername: "malicious_user",
      reason: "Abuse",
      locale: "es",
    });
    expect(sendEmailNotification).toHaveBeenCalledWith({
      to: "user@example.com",
      subject: "Aviso",
      body: "Suspenso",
    });
  });

  it("does not roll back a ban when the notice cannot be delivered", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user-99",
      githubUsername: "malicious_user",
      email: "user@example.com",
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValue({} as any);
    vi.mocked(prisma.bannedContributor.upsert).mockResolvedValue({} as any);
    vi.mocked(buildBanEmail).mockReturnValue({ subject: "Notice", body: "Body" });
    vi.mocked(sendEmailNotification).mockResolvedValue(false);

    const result = await banContributor({
      githubUsername: "malicious_user",
      reason: "Abuse",
      actorId: "maintainer-1",
    });

    expect(result.success).toBe(true);
    expect(result.emailSent).toBe(false);
    expect(prisma.bannedContributor.upsert).toHaveBeenCalled();
  });

  it("throws error if ban reason is empty", async () => {
    await expect(
      banContributor({
        githubUsername: "user",
        reason: "   ",
        actorId: "admin",
      })
    ).rejects.toThrow("reason is required");
  });

  it("unbans contributor and logs audit event", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user-99",
      githubUsername: "reformed_user",
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValue({} as any);
    vi.mocked(prisma.bannedContributor.deleteMany).mockResolvedValue({ count: 1 } as any);

    const result = await unbanContributor({
      githubUsername: "REFORMED_USER",
      actorId: "maintainer-1",
      actorLogin: "admin",
    });

    expect(result.success).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-99" },
        data: expect.objectContaining({
          banned: false,
        }),
      })
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contributor.unbanned",
      })
    );
  });
});