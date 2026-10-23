import "server-only";

import { randomUUID } from "node:crypto";

import { recordAuditLog } from "@/lib/audit";
import { buildContributorsCsv, getContributorsCsvFilename } from "@/lib/csv-export";
import { buildTreasuryExportEmailBody, sendEmailNotification } from "@/lib/email";
import { StructuredLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { toContributorRow } from "@/lib/registrations";
import { getStaleContributors, isExportStale } from "@/lib/stale-export";
import { trackServerCsvExported } from "@/lib/analytics";
import { sendCronExportAlert, pingCronExportSuccess } from "@/lib/cron-export-alert";
import type { ContributorRow } from "@/types";

const logger = new StructuredLogger("cron-export");
const CRON_EXPORT_LOCK_ID = "nightly-treasury-export";
const CRON_EXPORT_LOCK_LEASE_MS = 60 * 60 * 1000;

export type CronExportStatus = "ok" | "error" | "skipped";

export interface CronExportResult {
  status: CronExportStatus;
  startedAt: string;
  durationMs: number;
  filename?: string;
  totalContributors?: number;
  readyCount?: number;
  lowReserveCount?: number;
  notReadyCount?: number;
  staleCount?: number;
  isStale?: boolean;
  destination?: string;
  emailSent?: boolean;
  error?: string;
}

export interface RunCronExportOptions {
  actorId?: string | null;
  actorLogin?: string | null;
  destinationEmail?: string;
  maxAgeMs?: number;
  force?: boolean;
}

let lastRunAt: number | null = null;
let lastResult: CronExportResult | null = null;

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

async function acquireCronExportLock(now: number): Promise<string | null> {
  const token = randomUUID();
  const leaseExpiresAt = new Date(now + CRON_EXPORT_LOCK_LEASE_MS);

  try {
    await prisma.cronExportLock.create({
      data: { id: CRON_EXPORT_LOCK_ID, token, leaseExpiresAt },
    });
    return token;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }

  const reclaimed = await prisma.cronExportLock.updateMany({
    where: {
      id: CRON_EXPORT_LOCK_ID,
      leaseExpiresAt: { lte: new Date(now) },
    },
    data: { token, leaseExpiresAt },
  });

  return reclaimed.count === 1 ? token : null;
}

async function releaseCronExportLock(token: string): Promise<void> {
  try {
    await prisma.cronExportLock.deleteMany({
      where: { id: CRON_EXPORT_LOCK_ID, token },
    });
  } catch (error) {
    logger.error("cron_export_lock_release_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function getMinIntervalMs(): number {
  const parsed = Number.parseInt(
    process.env.CRON_EXPORT_MIN_INTERVAL_MS ?? "60000",
    10
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60000;
}

export function getTreasuryDestinationEmail(): string {
  return (
    process.env.TREASURY_EXPORT_EMAIL?.trim() ||
    process.env.CRON_EXPORT_EMAIL?.trim() ||
    ""
  );
}

/**
 * Execute the automated nightly treasury CSV export.
 *
 * Protected by a database lease across app instances and rate-limited via
 * `CRON_EXPORT_MIN_INTERVAL_MS` to prevent duplicate files and retry storms.
 * Never throws: catches all database or mail errors and returns a structured result.
 */
export async function runCronExport(
  options: RunCronExportOptions = {}
): Promise<CronExportResult> {
  const now = Date.now();
  const minIntervalMs = getMinIntervalMs();

  if (!options.force && lastRunAt !== null && now - lastRunAt < minIntervalMs) {
    logger.info("cron_export_skipped_rate_limited", {
      msSinceLastRun: now - lastRunAt,
      minIntervalMs,
    });
    return {
      status: "skipped",
      startedAt: new Date(now).toISOString(),
      durationMs: 0,
      error: `Rate limited: minimum interval between exports is ${minIntervalMs}ms`,
    };
  }

  const startedAt = new Date(now).toISOString();
  let lockToken: string | null = null;

  try {
    lockToken = await acquireCronExportLock(now);
    if (!lockToken) {
      logger.info("cron_export_skipped_in_progress", { startedAt });
      return {
        status: "skipped",
        startedAt,
        durationMs: 0,
        error: "Another treasury export is already in progress",
      };
    }

    lastRunAt = now;
    logger.info("cron_export_started", { startedAt });

    const registrations = await prisma.registration.findMany({
      where: { deletedAt: null },
      include: {
        user: {
          select: { githubUsername: true },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    const contributors: ContributorRow[] = registrations.map(toContributorRow);
    const totalContributors = contributors.length;

    let readyCount = 0;
    let lowReserveCount = 0;
    let notReadyCount = 0;

    for (const c of contributors) {
      if (c.readiness === "ready") readyCount++;
      else if (c.readiness === "low_reserve") lowReserveCount++;
      else notReadyCount++;
    }

    const staleThreshold = options.maxAgeMs;
    const staleList = getStaleContributors(contributors, staleThreshold);
    const staleCount = staleList.length;
    const isStale = isExportStale(contributors, staleThreshold);

    const filename = getContributorsCsvFilename();
    const csvData = buildContributorsCsv(contributors);

    const destination = options.destinationEmail?.trim() || getTreasuryDestinationEmail();
    let emailSent = false;

    if (destination) {
      const emailBody = buildTreasuryExportEmailBody({
        totalContributors,
        readyCount,
        lowReserveCount,
        notReadyCount,
        staleCount,
        filename,
        exportedAt: startedAt,
      });

      emailSent = await sendEmailNotification({
        to: destination,
        subject: `[TrustBridge] Nightly Treasury Contributor Export - ${filename}`,
        body: emailBody,
        attachments: [
          {
            filename,
            content: csvData,
            contentType: "text/csv;charset=utf-8",
          },
        ],
      });

      if (!emailSent) {
        logger.warn("cron_export_email_failed", { destination, filename });
      }
    } else {
      logger.info("cron_export_no_destination_configured", {
        totalContributors,
        filename,
      });
    }

    const durationMs = Date.now() - now;

    await recordAuditLog({
      action: "export.cron",
      actorId: options.actorId ?? null,
      actorLogin: options.actorLogin ?? "scheduler:cron",
      metadata: {
        totalContributors,
        readyCount,
        lowReserveCount,
        notReadyCount,
        staleCount,
        isStale,
        filename,
        destination: destination || "none",
        emailSent,
        durationMs,
      },
    });

    // Track analytics event (no-op when POSTHOG_API_KEY is absent)
    trackServerCsvExported({
      rowCount: totalContributors,
      triggeredBy: options.actorId ?? "scheduler:cron",
    });

    lastResult = {
      status: "ok",
      startedAt,
      durationMs,
      filename,
      totalContributors,
      readyCount,
      lowReserveCount,
      notReadyCount,
      staleCount,
      isStale,
      destination: destination || undefined,
      emailSent,
    };

    logger.info("cron_export_completed", {
      totalContributors,
      readyCount,
      staleCount,
      filename,
      durationMs,
    });

    // Ping dead-man's switch on success (no-op when CRON_EXPORT_PING_URL unset)
    void pingCronExportSuccess();

    return lastResult;
  } catch (error) {
    const durationMs = Date.now() - now;
    const message = error instanceof Error ? error.message : String(error);

    logger.error("cron_export_failed", { error: message, durationMs });

    await recordAuditLog({
      action: "export.cron.failed",
      actorId: options.actorId ?? null,
      actorLogin: options.actorLogin ?? "scheduler:cron",
      metadata: {
        error: message,
        durationMs,
      },
    });

    lastResult = {
      status: "error",
      startedAt,
      durationMs,
      error: message,
    };

    // Fire alert webhook (no-op when CRON_EXPORT_ALERT_WEBHOOK_URL unset)
    void sendCronExportAlert(lastResult);

    return lastResult;
  } finally {
    if (lockToken) {
      await releaseCronExportLock(lockToken);
    }
  }
}

/**
 * Returns the health / last run result of the cron export without triggering a run.
 */
export function getLastCronExportHealth(): CronExportResult | null {
  return lastResult;
}

/**
 * Reset in-memory rate-limit and health state between test runs.
 */
export function resetCronExportState(): void {
  lastRunAt = null;
  lastResult = null;
}
