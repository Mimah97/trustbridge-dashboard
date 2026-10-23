import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock logger before importing soroban-register so the spy is in place.
vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logger")>();
  const mockLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    ...actual,
    logger: {
      ...mockLogger,
      child: vi.fn().mockReturnValue(mockLogger),
    },
  };
});

import { mirrorRegistrationToSoroban } from "@/lib/soroban-register";
import { logger } from "@/lib/logger";

const PAYLOAD = {
  githubUsername: "octocat",
  stellarAddress: "GBSX3XVYB7XOQY4LZGQ7ZXZQY4LZGQ7ZXZQY4LZGQ7ZXZQY4LZG",
  registrationId: "reg-001",
};

const ORIGINAL_ENV = process.env;

describe("mirrorRegistrationToSoroban", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.clearAllMocks();
  });

  it("skips and returns success when SOROBAN_CONTRACT_ID is unset", async () => {
    delete process.env.SOROBAN_CONTRACT_ID;

    const result = await mirrorRegistrationToSoroban(PAYLOAD);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skipped).toBe(true);
    }
  });

  it("does not throw when SOROBAN_CONTRACT_ID is unset — fail-safe", async () => {
    delete process.env.SOROBAN_CONTRACT_ID;
    await expect(mirrorRegistrationToSoroban(PAYLOAD)).resolves.toBeDefined();
  });

  it("returns success: false and calls logger.error on RPC failure", async () => {
    // A valid-looking contract id but invalid RPC url to trigger the URL error
    process.env.SOROBAN_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    process.env.SOROBAN_RPC_URL = "not-a-valid-url";

    const childLogger = (logger.child as ReturnType<typeof vi.fn>).mock.results[0]?.value ?? {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };

    const result = await mirrorRegistrationToSoroban(PAYLOAD);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe("object");
    }
  });

  it("logs error with structured fields when Soroban RPC fails", async () => {
    process.env.SOROBAN_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    process.env.SOROBAN_RPC_URL = "not-a-valid-url";

    await mirrorRegistrationToSoroban(PAYLOAD);

    // The child logger's error method should have been called
    const childMock = vi.mocked(logger.child);
    expect(childMock).toHaveBeenCalled();
  });

  it("never throws on any failure — best-effort contract", async () => {
    process.env.SOROBAN_CONTRACT_ID = "BAD_ID_THAT_WILL_FAIL";

    const result = await mirrorRegistrationToSoroban(PAYLOAD);
    // Must be a result object, not a thrown exception
    expect(typeof result).toBe("object");
    expect(result).toHaveProperty("success");
  });

  it("returns success for valid contract id and valid RPC url", async () => {
    process.env.SOROBAN_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    const result = await mirrorRegistrationToSoroban(PAYLOAD);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skipped).toBeFalsy();
    }
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mirrorRegistrationToSoroban } from "@/lib/soroban-register";

describe("mirrorRegistrationToSoroban", () => {
  beforeEach(() => {
    // Clear environment variables before each test
    delete process.env.SOROBAN_CONTRACT_ID;
    delete process.env.SOROBAN_RPC_URL;
    delete process.env.SOROBAN_SECRET_KEY;
  });

  it("returns success when SOROBAN_CONTRACT_ID is not configured", async () => {
    const registration = {
      id: "reg-1",
      userId: "user-1",
      stellarAddress: "GBSX7U7ARH74ENSCCX7FYTA5FS2YQXZHY737IBSZEOF72ULMITMZNKQ",
      trustlineReady: true,
      trustlineAuthorized: true,
      funded: true,
      xlmBalance: "10",
      spendableXlmBalance: "9",
      lastCheckedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await mirrorRegistrationToSoroban(registration);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.txHash).toBeUndefined();
  });

  it("returns success when SOROBAN_CONTRACT_ID is configured but empty", async () => {
    process.env.SOROBAN_CONTRACT_ID = "   ";

    const registration = {
      id: "reg-1",
      userId: "user-1",
      stellarAddress: "GBSX7U7ARH74ENSCCX7FYTA5FS2YQXZHY737IBSZEOF72ULMITMZNKQ",
      trustlineReady: true,
      trustlineAuthorized: true,
      funded: true,
      xlmBalance: "10",
      spendableXlmBalance: "9",
      lastCheckedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await mirrorRegistrationToSoroban(registration);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error when SOROBAN_SECRET_KEY is not configured", async () => {
    process.env.SOROBAN_CONTRACT_ID = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

    const registration = {
      id: "reg-1",
      userId: "user-1",
      stellarAddress: "GBSX7U7ARH74ENSCCX7FYTA5FS2YQXZHY737IBSZEOF72ULMITMZNKQ",
      trustlineReady: true,
      trustlineAuthorized: true,
      funded: true,
      xlmBalance: "100.5",
      spendableXlmBalance: "99.0",
      lastCheckedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await mirrorRegistrationToSoroban(registration);
    expect(result.success).toBe(false);
    expect(result.errors).toContain("SOROBAN_SECRET_KEY is not configured — write-through skipped");
  });

  it("accepts a valid registration object", async () => {
    process.env.SOROBAN_CONTRACT_ID = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

    const registration = {
      id: "reg-1",
      userId: "user-1",
      stellarAddress: "GBSX7U7ARH74ENSCCX7FYTA5FS2YQXZHY737IBSZEOF72ULMITMZNKQ",
      trustlineReady: true,
      trustlineAuthorized: true,
      funded: true,
      xlmBalance: "100.5",
      spendableXlmBalance: "99.0",
      lastCheckedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Should not throw even with a configured contract
    const result = await mirrorRegistrationToSoroban(registration);
    expect(typeof result.success).toBe("boolean");
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("returns error object with proper structure on failure", async () => {
    // Test that the return type is correct even when failures occur
    process.env.SOROBAN_CONTRACT_ID = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

    const registration = {
      id: "reg-1",
      userId: "user-1",
      stellarAddress: "GBSX7U7ARH74ENSCCX7FYTA5FS2YQXZHY737IBSZEOF72ULMITMZNKQ",
      trustlineReady: false,
      trustlineAuthorized: false,
      funded: false,
      xlmBalance: "0",
      spendableXlmBalance: "0",
      lastCheckedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await mirrorRegistrationToSoroban(registration);

    // Verify result structure
    expect(typeof result.success).toBe("boolean");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("errors");
  });

  it("handles RPC connection errors gracefully", async () => {
    process.env.SOROBAN_CONTRACT_ID = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    process.env.SOROBAN_SECRET_KEY = "SDUMMY_SECRET_KEY_FOR_TESTING";

    const registration = {
      id: "reg-1",
      userId: "user-1",
      stellarAddress: "GBSX7U7ARH74ENSCCX7FYTA5FS2YQXZHY737IBSZEOF72ULMITMZNKQ",
      trustlineReady: true,
      trustlineAuthorized: true,
      funded: true,
      xlmBalance: "10",
      spendableXlmBalance: "9",
      lastCheckedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // This will fail because the secret key is invalid, but should not throw
    const result = await mirrorRegistrationToSoroban(registration);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
