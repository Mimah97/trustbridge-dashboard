import type { Session } from "next-auth";
import { describe, expect, it, vi, beforeEach } from "vitest";

// The route now delegates all auth to requireAdmin from @/lib/api-auth.
// Mock that instead of getServerSession so tests stay aligned with the route.
vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  buildInviteEmail: vi.fn(),
  sendEmailNotification: vi.fn(),
}));

vi.mock("@/lib/invite-helpers", () => ({
  createInvite: vi.fn(),
  generateInviteCode: vi.fn(() => "mock-code-1234567890abcdef1234"),
  listInvites: vi.fn(),
  revokeInvites: vi.fn(),
  hashInviteCode: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn().mockResolvedValue(true),
}));

import { requireAdmin } from "@/lib/api-auth";
import { recordAuditLog } from "@/lib/audit";
import { buildInviteEmail, sendEmailNotification } from "@/lib/email";
import { createInvite, listInvites, revokeInvites } from "@/lib/invite-helpers";
import { NextRequest } from "next/server";

import { POST, GET, DELETE } from "@/app/api/invites/generate/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminSession(id = "user-1"): Session {
  return {
    user: { id, isMaintainer: true, role: "admin", githubUsername: "maintainer" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

describe("Bulk invite link generator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── POST ──────────────────────────────────────────────────────────────────

  describe("POST /api/invites/generate", () => {
    it("generates bulk invite links and persists them", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(adminSession());
      vi.mocked(createInvite).mockResolvedValue({
        id: "invite-1",
        codeHash: "hash1",
        batchLabel: null,
        expiresAt: new Date("2026-09-25"),
        used: false,
        usedAt: null,
        createdAt: new Date(),
      } as never);

      const res = await POST(
        new NextRequest("http://localhost/api/invites/generate", {
          method: "POST",
          headers: { origin: "http://localhost" },
          body: JSON.stringify({ count: 5, expiryDays: 30 }),
        })
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.generated).toBe(5);
      expect(json.invites).toHaveLength(5);
      expect(json.invites[0].code).toBeDefined();
      expect(createInvite).toHaveBeenCalledTimes(5);
      expect(sendEmailNotification).not.toHaveBeenCalled();
      expect(recordAuditLog).toHaveBeenCalled();
    });

    it("sends localized invite notices to optional recipients", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(adminSession());
      vi.mocked(createInvite).mockResolvedValue({
        id: "invite-1",
        expiresAt: null,
        createdAt: new Date("2026-10-01T00:00:00Z"),
      } as never);
      vi.mocked(buildInviteEmail).mockReturnValue({
        subject: "Convite",
        body: "Código do convite",
      });
      vi.mocked(sendEmailNotification).mockResolvedValue(true);

      const res = await POST(
        new NextRequest("http://localhost/api/invites/generate", {
          method: "POST",
          headers: { origin: "http://localhost" },
          body: JSON.stringify({ recipientEmails: ["guest@example.com"], locale: "pt" }),
        })
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.generated).toBe(1);
      expect(json.emailDelivery).toEqual({ sent: 1, failed: 0 });
      expect(buildInviteEmail).toHaveBeenCalledWith(
        expect.objectContaining({ inviteCode: "mock-code-1234567890abcdef1234", locale: "pt" })
      );
      expect(sendEmailNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "guest@example.com",
          subject: "Convite",
          idempotencyScope: "invite-1",
        })
      );
    });

    it("keeps generated invites when notice delivery fails", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(adminSession());
      vi.mocked(createInvite).mockResolvedValue({
        id: "invite-1",
        expiresAt: null,
        createdAt: new Date("2026-10-01T00:00:00Z"),
      } as never);
      vi.mocked(buildInviteEmail).mockReturnValue({ subject: "Invite", body: "Body" });
      vi.mocked(sendEmailNotification).mockResolvedValue(false);

      const res = await POST(
        new NextRequest("http://localhost/api/invites/generate", {
          method: "POST",
          headers: { origin: "http://localhost" },
          body: JSON.stringify({ recipientEmails: ["guest@example.com"] }),
        })
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.generated).toBe(1);
      expect(json.emailDelivery).toEqual({ sent: 0, failed: 1 });
    });

    it("rejects malformed recipient email lists before creating invites", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(adminSession());

      const res = await POST(
        new NextRequest("http://localhost/api/invites/generate", {
          method: "POST",
          headers: { origin: "http://localhost" },
          body: JSON.stringify({ recipientEmails: ["not-an-email"] }),
        })
      );

      expect(res.status).toBe(400);
      expect(createInvite).not.toHaveBeenCalled();
      expect(sendEmailNotification).not.toHaveBeenCalled();
    });

    it("returns a stable 400 for malformed JSON", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(adminSession());
      const res = await POST(
        new NextRequest("http://localhost/api/invites/generate", {
          method: "POST",
          headers: { origin: "http://localhost" },
          body: "{",
        })
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Request body must be valid JSON" });
      expect(createInvite).not.toHaveBeenCalled();
    });

    it("generates invites with default count of 10", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(adminSession());
      vi.mocked(createInvite).mockResolvedValue({
        id: "invite-1",
        codeHash: "hash1",
        batchLabel: null,
        expiresAt: null,
        used: false,
        usedAt: null,
        createdAt: new Date(),
      } as never);

      const res = await POST(
        new NextRequest("http://localhost/api/invites/generate", {
          method: "POST",
          headers: { origin: "http://localhost" },
          body: JSON.stringify({}),
        })
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.generated).toBe(10);
      expect(createInvite).toHaveBeenCalledTimes(10);
    });

    it("rejects count less than 1", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(adminSession());
      const res = await POST(
        new NextRequest("http://localhost/api/invites/generate", {
          method: "POST",
          headers: { origin: "http://localhost" },
          body: JSON.stringify({ count: 0 }),
        })
      );
      expect(res.status).toBe(400);
    });

    it("rejects count greater than 1000", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(adminSession());
      const res = await POST(
        new NextRequest("http://localhost/api/invites/generate", {
          method: "POST",
          headers: { origin: "http://localhost" },
          body: JSON.stringify({ count: 1001 }),
        })
      );
      expect(res.status).toBe(400);
    });

    it("rejects invalid expiry days", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(adminSession());
      const res = await POST(
        new NextRequest("http://localhost/api/invites/generate", {
          method: "POST",
          headers: { origin: "http://localhost" },
          body: JSON.stringify({ count: 5, expiryDays: 400 }),
        })
      );
      expect(res.status).toBe(400);
    });

    it("returns 403 for non-admin (requireAdmin returns null)", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(null);
      const res = await POST(
        new NextRequest("http://localhost/api/invites/generate", {
          method: "POST",
          headers: { origin: "http://localhost" },
          body: JSON.stringify({ count: 5 }),
        })
      );
      expect(res.status).toBe(403);
    });
  });

  // ── GET ───────────────────────────────────────────────────────────────────

  describe("GET /api/invites/generate", () => {
    it("returns paginated invite list from database", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(adminSession());
      vi.mocked(listInvites).mockResolvedValue({
        invites: [
          {
            id: "inv-1",
            codeHash: "hash",
            batchLabel: null,
            expiresAt: null,
            used: false,
            usedAt: null,
            createdAt: new Date(),
          },
        ],
        total: 1,
        totalPages: 1,
      });

      const res = await GET(
        new NextRequest("http://localhost/api/invites/generate?page=1&pageSize=20")
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.page).toBe(1);
      expect(json.pageSize).toBe(20);
      expect(json.totalCount).toBe(1);
      expect(json.invites).toHaveLength(1);
      expect(listInvites).toHaveBeenCalledWith("user-1", 1, 20);
    });

    it("respects page size limit of 100", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(adminSession());
      vi.mocked(listInvites).mockResolvedValue({
        invites: [],
        total: 0,
        totalPages: 0,
      });

      const res = await GET(
        new NextRequest("http://localhost/api/invites/generate?pageSize=200")
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.pageSize).toBe(100);
    });

    it("returns 403 for non-admin (requireAdmin returns null)", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(null);
      const res = await GET(
        new NextRequest("http://localhost/api/invites/generate")
      );
      expect(res.status).toBe(403);
    });
  });

  // ── DELETE ────────────────────────────────────────────────────────────────

  describe("DELETE /api/invites/generate", () => {
    it("revokes invite links via Prisma", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(adminSession());
      vi.mocked(revokeInvites).mockResolvedValue({ revoked: 3 });

      const res = await DELETE(
        new NextRequest("http://localhost/api/invites/generate", {
          method: "DELETE",
          headers: { origin: "http://localhost" },
          body: JSON.stringify({ codes: ["code1", "code2", "code3"] }),
        })
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.deleted).toBe(3);
      expect(revokeInvites).toHaveBeenCalledWith(
        ["code1", "code2", "code3"],
        "user-1"
      );
      expect(recordAuditLog).toHaveBeenCalled();
    });

    it("rejects empty codes array", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(adminSession());
      const res = await DELETE(
        new NextRequest("http://localhost/api/invites/generate", {
          method: "DELETE",
          headers: { origin: "http://localhost" },
          body: JSON.stringify({ codes: [] }),
        })
      );
      expect(res.status).toBe(400);
    });

    it("rejects more than 1000 codes", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(adminSession());
      const codes = Array.from({ length: 1001 }, (_, i) => "code" + i);
      const res = await DELETE(
        new NextRequest("http://localhost/api/invites/generate", {
          method: "DELETE",
          headers: { origin: "http://localhost" },
          body: JSON.stringify({ codes }),
        })
      );
      expect(res.status).toBe(400);
    });

    it("returns 403 for non-admin (requireAdmin returns null)", async () => {
      vi.mocked(requireAdmin).mockResolvedValue(null);
      const res = await DELETE(
        new NextRequest("http://localhost/api/invites/generate", {
          method: "DELETE",
          headers: { origin: "http://localhost" },
          body: JSON.stringify({ codes: ["code1"] }),
        })
      );
      expect(res.status).toBe(403);
    });
  });
});
