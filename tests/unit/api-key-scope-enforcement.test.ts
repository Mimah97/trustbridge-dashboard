/**
 * Scope enforcement tests for API-key auth (#647).
 *
 * Covers allow/deny per scope, empty masks, multi-scope keys, the stable 403
 * response shape, and lifecycle checks (revoked/expired fail before scope).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@/lib/prisma";
import {
  authenticateApiKey,
  hasScope,
  insufficientScopeResponse,
  requireApiKeyScope,
} from "@/lib/api-key-auth";
import {
  API_KEY_ALL_SCOPES_MASK,
  apiKeyScopesToBitmask,
  hasApiKeyScope,
} from "@/lib/api-key-scopes";

const RAW_KEY = `tb_${"A".repeat(43)}`;

function keyRequest(raw: string = RAW_KEY): NextRequest {
  return new NextRequest("http://localhost:3000/api/treasury/export", {
    headers: { authorization: `Bearer ${raw}` },
  });
}

function dbKey(overrides = {}) {
  return {
    id: "key-1",
    name: "export-cron",
    scopes: ["export:read"],
    createdById: "maintainer-1",
    maintainerOrgId: "org-1",
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Pure scope helpers ──────────────────────────────────────────────────────

describe("api-key scopes", () => {
  it("allows export:read keys on export routes", () => {
    expect(hasApiKeyScope(["export:read"], "export:read")).toBe(true);
  });

  it("denies export:read keys on cron trigger routes", () => {
    expect(hasApiKeyScope(["export:read"], "cron:trigger")).toBe(false);
  });

  it("allows cron:trigger keys on cron trigger routes", () => {
    expect(hasApiKeyScope(["cron:trigger"], "cron:trigger")).toBe(true);
  });

  it("denies keys with an empty scope mask", () => {
    expect(apiKeyScopesToBitmask([])).toBe(0);
    expect(hasApiKeyScope([], "export:read")).toBe(false);
    expect(hasApiKeyScope([], "cron:trigger")).toBe(false);
  });

  it("allows multi-scope keys on single-scope routes", () => {
    expect(
      hasApiKeyScope(["export:read", "cron:trigger"], "cron:trigger")
    ).toBe(true);
    expect(hasApiKeyScope(["export:read", "cron:trigger"], "export:read")).toBe(
      true
    );
  });

  it("wildcard covers every scope", () => {
    expect(apiKeyScopesToBitmask(["*"])).toBe(API_KEY_ALL_SCOPES_MASK);
    expect(hasApiKeyScope(["*"], "export:read")).toBe(true);
    expect(hasApiKeyScope(["*"], "cron:trigger")).toBe(true);
  });
});

// ── Stable 403 response ─────────────────────────────────────────────────────

describe("insufficientScopeResponse", () => {
  it("returns 403 with a stable error code and no internals", async () => {
    const res = insufficientScopeResponse("cron:trigger");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({
      error: "Forbidden: API key lacks the required scope",
      code: "insufficient_scope",
      requiredScope: "cron:trigger",
    });
    expect(JSON.stringify(body)).not.toMatch(/stack|keyHash|secret/i);
  });
});

// ── Authenticator behaviour ─────────────────────────────────────────────────

describe("authenticateApiKey", () => {
  it("returns the key for a valid active key (allow path)", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(dbKey());
    const auth = await authenticateApiKey(keyRequest());
    expect(auth).toMatchObject({ id: "key-1", name: "export-cron" });
  });

  it("returns null when no bearer token is presented", async () => {
    const auth = await authenticateApiKey(
      new NextRequest("http://localhost:3000/api/treasury/export")
    );
    expect(auth).toBeNull();
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it("rejects revoked keys before the scope check", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(
      dbKey({ revokedAt: new Date("2026-01-01") })
    );
    const auth = await authenticateApiKey(keyRequest());
    expect(auth).toBeNull();
  });

  it("rejects expired keys before the scope check", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(
      dbKey({ expiresAt: new Date("2020-01-01") })
    );
    const auth = await authenticateApiKey(keyRequest());
    expect(auth).toBeNull();
  });

  it("requireApiKeyScope denies a valid key missing the scope", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(dbKey());
    const auth = await requireApiKeyScope(keyRequest(), "cron:trigger");
    expect(auth).toBeNull();
  });

  it("requireApiKeyScope allows a valid key carrying the scope", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(
      dbKey({ scopes: ["export:read", "cron:trigger"] })
    );
    const auth = await requireApiKeyScope(keyRequest(), "cron:trigger");
    expect(auth).toMatchObject({ id: "key-1" });
  });

  it("hasScope gates the 403 path used by routes", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(dbKey());
    const auth = await authenticateApiKey(keyRequest());
    expect(auth && !("rateLimited" in auth) && hasScope(auth.scopes, "cron:trigger")).toBe(
      false
    );
  });
});
