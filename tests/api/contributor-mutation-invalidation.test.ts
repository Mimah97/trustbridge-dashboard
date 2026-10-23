/**
 * Regression tests for contributor list cache-tag invalidation (#649).
 *
 * Proves that contributor-mutating success paths bust the shared contributor
 * list caches via `invalidateContributorListCaches()`, and that failed
 * mutations do not.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/cache-tags", () => ({
  invalidateContributorListCaches: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api-auth", () => ({
  requireMaintainerSession: vi.fn(),
  requireOperator: vi.fn(),
}));

vi.mock("@/lib/ban-service", () => ({
  banContributor: vi.fn(),
  unbanContributor: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/analytics", () => ({
  trackServerDisputeOpened: vi.fn(),
  trackServerDisputeClosed: vi.fn(),
}));

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    disputeProof: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { invalidateContributorListCaches } from "@/lib/cache-tags";
import { requireMaintainerSession } from "@/lib/api-auth";
import { banContributor, unbanContributor } from "@/lib/ban-service";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";

import { POST as banPOST } from "@/app/api/maintainer/ban/route";
import { POST as restorePOST } from "@/app/api/registrations/[id]/restore/route";
import { PATCH as disputesPATCH } from "@/app/api/disputes/route";

const SESSION = {
  user: { id: "maintainer-1", githubUsername: "alice", isMaintainer: true },
};

const sameOriginHeaders: Record<string, string> = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

function request(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: sameOriginHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("contributor mutation cache invalidation (#649)", () => {
  it("ban success busts the contributor list caches", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(SESSION as never);
    vi.mocked(banContributor).mockResolvedValue({
      success: true,
      githubUsername: "spammer",
      reason: "abuse",
    });

    const res = await banPOST(
      request("http://localhost:3000/api/maintainer/ban", "POST", {
        action: "ban",
        githubUsername: "spammer",
        reason: "abuse",
      })
    );

    expect(res.status).toBe(200);
    expect(invalidateContributorListCaches).toHaveBeenCalledTimes(1);
  });

  it("unban success busts the contributor list caches", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(SESSION as never);
    vi.mocked(unbanContributor).mockResolvedValue({
      success: true,
      githubUsername: "spammer",
      reason: "appealed",
    });

    const res = await banPOST(
      request("http://localhost:3000/api/maintainer/ban", "POST", {
        action: "unban",
        githubUsername: "spammer",
      })
    );

    expect(res.status).toBe(200);
    expect(invalidateContributorListCaches).toHaveBeenCalledTimes(1);
  });

  it("failed ban does not invalidate", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(SESSION as never);
    vi.mocked(banContributor).mockRejectedValue(new Error("db unavailable"));

    const res = await banPOST(
      request("http://localhost:3000/api/maintainer/ban", "POST", {
        action: "ban",
        githubUsername: "spammer",
        reason: "abuse",
      })
    );

    expect(res.status).toBe(500);
    expect(invalidateContributorListCaches).not.toHaveBeenCalled();
  });

  it("restore success busts the contributor list caches", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(SESSION as never);
    vi.mocked(prisma.registration.findFirst).mockResolvedValue({
      id: "reg-1",
    } as never);
    vi.mocked(prisma.registration.update).mockResolvedValue({
      id: "reg-1",
      stellarAddress: "GABC",
    } as never);

    const res = await restorePOST(
      request("http://localhost:3000/api/registrations/reg-1/restore", "POST"),
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(200);
    expect(invalidateContributorListCaches).toHaveBeenCalledTimes(1);
  });

  it("dispute status resolution busts the contributor list caches", async () => {
    vi.mocked(getServerSession).mockResolvedValue(SESSION as never);
    vi.mocked(prisma.disputeProof.findUnique).mockResolvedValue({
      id: "disp-1",
      status: "OPEN",
    } as never);
    vi.mocked(prisma.disputeProof.update).mockResolvedValue({
      id: "disp-1",
      status: "VALIDATED",
    } as never);

    const res = await disputesPATCH(
      request("http://localhost:3000/api/disputes", "PATCH", {
        disputeId: "disp-1",
        status: "VALIDATED",
      })
    );

    expect(res.status).toBe(200);
    expect(invalidateContributorListCaches).toHaveBeenCalledTimes(1);
  });
});
