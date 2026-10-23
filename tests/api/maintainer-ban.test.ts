/**
 * API tests for POST /api/maintainer/ban (issue #328).
 *
 * Covers maintainer happy-path ban/unban, unauthorized callers, CSRF
 * rejection, and invalid payloads with a stable `{ error }` shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-auth", () => ({
  requireMaintainerSession: vi.fn(),
}));
vi.mock("@/lib/ban-service", () => ({
  banContributor: vi.fn(),
  unbanContributor: vi.fn(),
}));

import { requireMaintainerSession } from "@/lib/api-auth";
import { banContributor, unbanContributor } from "@/lib/ban-service";
import { POST } from "@/app/api/maintainer/ban/route";

const SESSION = {
  user: { id: "maintainer-1", githubUsername: "alice", isMaintainer: true },
};

const sameOriginHeaders: Record<string, string> = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

function request(body?: unknown, headers?: Record<string, string>) {
  return new NextRequest("http://localhost:3000/api/maintainer/ban", {
    method: "POST",
    headers: headers ?? sameOriginHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/maintainer/ban", () => {
  it("rejects cross-origin requests", async () => {
    const res = await POST(
      request(
        { action: "ban", githubUsername: "spammer", reason: "abuse" },
        { origin: "https://evil.example", "content-type": "application/json" }
      )
    );
    expect(res.status).toBe(403);
    expect(banContributor).not.toHaveBeenCalled();
  });

  it("returns 403 for unauthorized callers", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(null);

    const res = await POST(
      request({ action: "ban", githubUsername: "spammer", reason: "abuse" })
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Forbidden. Maintainer access required." });
    expect(banContributor).not.toHaveBeenCalled();
    expect(unbanContributor).not.toHaveBeenCalled();
  });

  it("returns 400 when githubUsername is missing", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(SESSION as never);

    const res = await POST(request({ action: "ban", reason: "abuse" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "githubUsername is required." });
    expect(banContributor).not.toHaveBeenCalled();
  });

  it("returns 400 when ban reason is missing", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(SESSION as never);

    const res = await POST(
      request({ action: "ban", githubUsername: "spammer" })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "Reason is required to ban a contributor." });
    expect(banContributor).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid action", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(SESSION as never);

    const res = await POST(
      request({ action: "suspend", githubUsername: "spammer", reason: "abuse" })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid action. Must be 'ban' or 'unban'." });
    expect(banContributor).not.toHaveBeenCalled();
    expect(unbanContributor).not.toHaveBeenCalled();
  });

  it("bans a contributor for an authenticated maintainer", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(SESSION as never);
    vi.mocked(banContributor).mockResolvedValue({
      success: true,
      githubUsername: "spammer",
      reason: "Wallet theft report #102",
    });

    const res = await POST(
      request({
        action: "ban",
        githubUsername: "Spammer",
        reason: "Wallet theft report #102",
        locale: "es",
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      message: "Contributor @spammer has been banned.",
      details: {
        success: true,
        githubUsername: "spammer",
        reason: "Wallet theft report #102",
      },
    });
    expect(banContributor).toHaveBeenCalledWith({
      githubUsername: "Spammer",
      reason: "Wallet theft report #102",
      actorId: "maintainer-1",
      actorLogin: "alice",
      locale: "es",
    });
  });

  it("defaults action to ban when omitted", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(SESSION as never);
    vi.mocked(banContributor).mockResolvedValue({
      success: true,
      githubUsername: "spammer",
      reason: "TOS violation",
    });

    const res = await POST(
      request({ githubUsername: "spammer", reason: "TOS violation" })
    );

    expect(res.status).toBe(200);
    expect(banContributor).toHaveBeenCalled();
    expect(unbanContributor).not.toHaveBeenCalled();
  });

  it("unbans a contributor for an authenticated maintainer", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(SESSION as never);
    vi.mocked(unbanContributor).mockResolvedValue({
      success: true,
      githubUsername: "reformed_user",
    });

    const res = await POST(
      request({
        action: "unban",
        githubUsername: "reformed_user",
        reason: "Appeal approved",
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      message: "Contributor @reformed_user has been unbanned.",
      details: {
        success: true,
        githubUsername: "reformed_user",
      },
    });
    expect(unbanContributor).toHaveBeenCalledWith({
      githubUsername: "reformed_user",
      actorId: "maintainer-1",
      actorLogin: "alice",
      reason: "Appeal approved",
    });
    expect(banContributor).not.toHaveBeenCalled();
  });

  it("returns 500 with a stable error shape when the service throws", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(SESSION as never);
    vi.mocked(banContributor).mockRejectedValue(new Error("db unavailable"));

    const res = await POST(
      request({
        action: "ban",
        githubUsername: "spammer",
        reason: "abuse",
      })
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "db unavailable" });
  });
});
