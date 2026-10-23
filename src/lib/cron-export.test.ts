import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getLastCronExportHealth,
  resetCronExportState,
  runCronExport,
} from "@/lib/cron-export";
import { recordAuditLog } from "@/lib/audit";
import { sendEmailNotification } from "@/lib/email";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      findMany: vi.fn(),
    },
    cronExportLock: {
      create: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return {
    ...actual,
    sendEmailNotification: vi.fn().mockResolvedValue(true),
  };
});

describe("cron-export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCronExportState();
    vi.mocked(prisma.cronExportLock.create).mockResolvedValue({} as never);
    vi.mocked(prisma.cronExportLock.updateMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.cronExportLock.deleteMany).mockResolvedValue({ count: 1 });
    delete process.env.TREASURY_EXPORT_EMAIL;
    delete process.env.CRON_EXPORT_EMAIL;
    delete process.env.CRON_EXPORT_MIN_INTERVAL_MS;
  });

  const mockRegistrations = [
    {
      id: "reg-1",
      stellarAddress: "GBBD47GYE3DOE6SXR46LEN4DFSLE3THQ5VS37GAMMA5SMVVSAVOI5TESL",
      funded: true,
      trustlineReady: true,
      trustlineAuthorized: true,
      xlmBalance: "100.0",
      spendableXlmBalance: "99.0",
      usdcBalance: "50.0",
      lastCheckedAt: new Date(Date.now() - 3600 * 1000), // 1 hr ago
      horizonLatencyMs: 120,
      user: { githubUsername: "alice" },
    },
    {
      id: "reg-2",
      stellarAddress: "GCKF7GYE3DOE6SXR46LEN4DFSLE3THQ5VS37GAMMA5SMVVSAVOI5TESL",
      funded: true,
      trustlineReady: false,
      trustlineAuthorized: false,
      xlmBalance: "2.0",
      spendableXlmBalance: "1.0",
      usdcBalance: "0.0",
      lastCheckedAt: new Date(Date.now() - 3600 * 1000), // 1 hr ago
      horizonLatencyMs: 110,
      user: { githubUsername: "bob" },
    },
  ];

  it("successfully runs export and sends email when destination is configured", async () => {
    vi.mocked(prisma.registration.findMany).mockResolvedValue(mockRegistrations as never);
    process.env.TREASURY_EXPORT_EMAIL = "treasury@example.com";

    const result = await runCronExport();

    expect(result.status).toBe("ok");
    expect(result.totalContributors).toBe(2);
    expect(result.readyCount).toBe(1);
    expect(result.notReadyCount).toBe(1);
    expect(result.destination).toBe("treasury@example.com");
    expect(result.emailSent).toBe(true);
    expect(result.filename).toMatch(/^contributors-\d{4}-\d{2}-\d{2}\.csv$/);

    expect(sendEmailNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "treasury@example.com",
        subject: expect.stringContaining("Nightly Treasury Contributor Export"),
        attachments: expect.arrayContaining([
          expect.objectContaining({
            filename: result.filename,
            contentType: "text/csv;charset=utf-8",
          }),
        ]),
      })
    );

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "export.cron",
        metadata: expect.objectContaining({
          totalContributors: 2,
          readyCount: 1,
          destination: "treasury@example.com",
          emailSent: true,
        }),
      })
    );

    expect(getLastCronExportHealth()).toEqual(result);
  });

  it("handles export gracefully when no destination email is configured", async () => {
    vi.mocked(prisma.registration.findMany).mockResolvedValue(mockRegistrations as never);

    const result = await runCronExport();

    expect(result.status).toBe("ok");
    expect(result.totalContributors).toBe(2);
    expect(result.destination).toBeUndefined();
    expect(result.emailSent).toBe(false);
    expect(sendEmailNotification).not.toHaveBeenCalled();

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "export.cron",
        metadata: expect.objectContaining({
          destination: "none",
          emailSent: false,
        }),
      })
    );
  });

  it("detects stale contributors and includes them in audit and result", async () => {
    const staleRegistrations = [
      {
        ...mockRegistrations[0],
        lastCheckedAt: new Date(Date.now() - 48 * 3600 * 1000), // 48h ago (stale)
      },
    ];
    vi.mocked(prisma.registration.findMany).mockResolvedValue(staleRegistrations as never);

    const result = await runCronExport({ maxAgeMs: 24 * 3600 * 1000 });

    expect(result.status).toBe("ok");
    expect(result.staleCount).toBe(1);
    expect(result.isStale).toBe(true);

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "export.cron",
        metadata: expect.objectContaining({
          staleCount: 1,
          isStale: true,
        }),
      })
    );
  });

  it("rate limits consecutive runs within the interval window", async () => {
    vi.mocked(prisma.registration.findMany).mockResolvedValue(mockRegistrations as never);
    process.env.CRON_EXPORT_MIN_INTERVAL_MS = "60000";

    const firstRun = await runCronExport();
    expect(firstRun.status).toBe("ok");

    const secondRun = await runCronExport();
    expect(secondRun.status).toBe("skipped");
    expect(secondRun.error).toContain("Rate limited");

    // Force bypass rate limiting
    const forcedRun = await runCronExport({ force: true });
    expect(forcedRun.status).toBe("ok");
  });

  it("handles database errors gracefully and records audit failure", async () => {
    vi.mocked(prisma.registration.findMany).mockRejectedValue(
      new Error("Database connection timeout")
    );

    const result = await runCronExport();

    expect(result.status).toBe("error");
    expect(result.error).toBe("Database connection timeout");

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "export.cron.failed",
        metadata: expect.objectContaining({
          error: "Database connection timeout",
        }),
      })
    );
  });
});
