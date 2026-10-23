import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-auth", () => ({
  requireMaintainerSession: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock("@/lib/csrf", () => ({
  assertSameOrigin: vi.fn(() => null),
}));

vi.mock("@/lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(),
}));

vi.mock("@/lib/soroban-outbox-worker", () => ({
  listSorobanOutboxDeadLetters: vi.fn(),
  processSorobanOutbox: vi.fn(),
  replayFailedSorobanOutboxEntry: vi.fn(),
}));

import { requireMaintainerSession } from "@/lib/api-auth";
import { recordAuditLog } from "@/lib/audit";
import { isFeatureEnabled } from "@/lib/feature-flags";
import {
  listSorobanOutboxDeadLetters,
  processSorobanOutbox,
  replayFailedSorobanOutboxEntry,
} from "@/lib/soroban-outbox-worker";
import { GET } from "./route";
import { POST } from "./[id]/replay/route";

const maintainerSession = {
  user: {
    id: "maintainer-1",
    githubUsername: "maintainer",
    isMaintainer: true,
    maintainerOrgId: "org-1",
  },
};

function makeRequest(path: string, method = "GET") {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { host: "localhost:3000" },
  });
}

describe("Soroban outbox dead-letter API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists org-scoped failed item metadata without payloads", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(maintainerSession as never);
    vi.mocked(listSorobanOutboxDeadLetters).mockResolvedValue([
      {
        id: "outbox-1",
        action: "register",
        attempts: 5,
        lastError: "RPC timeout",
        createdAt: new Date("2026-10-01T00:00:00Z"),
        updatedAt: new Date("2026-10-02T00:00:00Z"),
      },
    ]);

    const response = await GET(makeRequest("/api/soroban/outbox/dlq?limit=20"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(listSorobanOutboxDeadLetters).toHaveBeenCalledWith("org-1", 20);
    expect(body.items[0]).not.toHaveProperty("payload");
  });

  it("replays a failed item and audits the maintainer and item", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(maintainerSession as never);
    vi.mocked(isFeatureEnabled).mockResolvedValue(true);
    vi.mocked(replayFailedSorobanOutboxEntry).mockResolvedValue({
      id: "outbox-1",
      action: "register",
      previousAttempts: 5,
    });
    vi.mocked(processSorobanOutbox).mockResolvedValue({
      processedCount: 1,
      successCount: 1,
      failedCount: 0,
    });

    const response = await POST(
      makeRequest("/api/soroban/outbox/dlq/outbox-1/replay", "POST"),
      { params: { id: "outbox-1" } }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.item).toEqual({ id: "outbox-1", status: "COMPLETED" });
    expect(replayFailedSorobanOutboxEntry).toHaveBeenCalledWith(
      "outbox-1",
      "org-1"
    );
    expect(processSorobanOutbox).toHaveBeenCalledWith({
      batchSize: 1,
      entryId: "outbox-1",
      maintainerOrgId: "org-1",
    });
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "soroban.outbox.replayed",
        actorId: "maintainer-1",
        actorLogin: "maintainer",
        targetId: "outbox-1",
        targetLabel: "register (outbox-1)",
        metadata: { action: "register", previousAttempts: 5 },
      })
    );
  });

  it("returns 404 and does not audit or process an unavailable item", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(maintainerSession as never);
    vi.mocked(isFeatureEnabled).mockResolvedValue(true);
    vi.mocked(replayFailedSorobanOutboxEntry).mockResolvedValue(null);

    const response = await POST(
      makeRequest("/api/soroban/outbox/dlq/missing/replay", "POST"),
      { params: { id: "missing" } }
    );

    expect(response.status).toBe(404);
    expect(recordAuditLog).not.toHaveBeenCalled();
    expect(processSorobanOutbox).not.toHaveBeenCalled();
  });
});