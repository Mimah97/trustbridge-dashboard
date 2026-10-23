import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  registrationFindMany: vi.fn(),
  lockCreate: vi.fn(),
  lockUpdateMany: vi.fn(),
  lockDeleteMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: { findMany: database.registrationFindMany },
    cronExportLock: {
      create: database.lockCreate,
      updateMany: database.lockUpdateMany,
      deleteMany: database.lockDeleteMany,
    },
  },
}));

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/csv-export", () => ({
  buildContributorsCsv: vi.fn(() => "csv"),
  getContributorsCsvFilename: vi.fn(() => "contributors-2026-10-21.csv"),
}));
vi.mock("@/lib/email", () => ({
  buildTreasuryExportEmailBody: vi.fn(() => "body"),
  sendEmailNotification: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/logger", () => ({
  StructuredLogger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));
vi.mock("@/lib/registrations", () => ({
  toContributorRow: vi.fn(),
}));
vi.mock("@/lib/stale-export", () => ({
  getStaleContributors: vi.fn(() => []),
  isExportStale: vi.fn(() => false),
}));
vi.mock("@/lib/analytics", () => ({ trackServerCsvExported: vi.fn() }));
vi.mock("@/lib/cron-export-alert", () => ({
  sendCronExportAlert: vi.fn(),
  pingCronExportSuccess: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { sendEmailNotification } from "@/lib/email";
import { resetCronExportState, runCronExport } from "@/lib/cron-export";

describe("cron export lock integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCronExportState();
    database.lockCreate.mockResolvedValue({});
    database.lockUpdateMany.mockResolvedValue({ count: 0 });
    database.lockDeleteMany.mockResolvedValue({ count: 1 });
    database.registrationFindMany.mockResolvedValue([]);
    process.env.CRON_EXPORT_MIN_INTERVAL_MS = "0";
    process.env.TREASURY_EXPORT_EMAIL = "finance@example.com";
    delete process.env.CRON_EXPORT_EMAIL;
  });

  it("skips a forced overlapping run without exporting a second time", async () => {
    let releaseRead!: (registrations: never[]) => void;
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const blockedRead = new Promise<never[]>((resolve) => {
      releaseRead = resolve;
    });

    database.registrationFindMany.mockImplementationOnce(() => {
      signalReadStarted();
      return blockedRead;
    });
    database.lockCreate
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({ code: "P2002" });
    database.lockUpdateMany.mockResolvedValueOnce({ count: 0 });

    const firstRun = runCronExport();
    await readStarted;

    const overlappingRun = await runCronExport({ force: true });

    expect(overlappingRun.status).toBe("skipped");
    expect(overlappingRun.error).toContain("already in progress");
    expect(database.registrationFindMany).toHaveBeenCalledTimes(1);

    releaseRead([]);
    expect((await firstRun).status).toBe("ok");
    expect(database.registrationFindMany).toHaveBeenCalledTimes(1);
    expect(sendEmailNotification).toHaveBeenCalledTimes(1);
    expect(prisma.cronExportLock.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "nightly-treasury-export",
        token: expect.any(String),
      },
    });
  });

  it("releases the lease after a failed export so a later run can proceed", async () => {
    database.registrationFindMany
      .mockRejectedValueOnce(new Error("Database unavailable"))
      .mockResolvedValueOnce([]);

    const failedRun = await runCronExport();
    const nextRun = await runCronExport({ force: true });

    expect(failedRun.status).toBe("error");
    expect(nextRun.status).toBe("ok");
    expect(prisma.cronExportLock.deleteMany).toHaveBeenCalledTimes(2);
  });
});