import type { AuditLogEntry } from "@/types";

/** Human-readable labels for known audit actions. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "recheck.single": "Re-checked a contributor",
  "recheck.batch": "Re-checked all contributors",
  "registration.create": "Registered a Stellar address",
  "registration.update": "Updated a Stellar address",
  "registration.delete": "Soft-deleted a registration",
  "registration.restore": "Restored a registration",
  network_config_mismatch_detected: "Detected a Horizon/Soroban network mismatch",
  "contract.sync": "Synced Soroban contract registrations",
  "soroban.outbox.replayed": "Replayed a Soroban outbox item",
  "export.csv": "Exported contributors CSV",
  "export.csv.failed": "Failed to export contributors CSV",
  "export.cron": "Automated nightly treasury CSV export",
  "export.cron.failed": "Automated nightly treasury CSV export failed",
  "export.json": "Exported contributors JSON",
  "export.json.failed": "Failed to export contributors JSON",
  "api_key.created": "Created an API key",
  "api_key.revoked": "Revoked an API key",
  "api_key.use_rejected": "API key use rejected",
  "digest.cron": "Scheduled contributor readiness digest sent",
  "digest.cron.failed": "Scheduled contributor readiness digest failed",
};

export function describeAuditAction(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

/**
 * Shape of a persisted audit row (a subset of the Prisma model). Kept local so
 * this module stays free of `server-only`/Prisma imports and remains testable.
 */
export interface AuditLogRowLike {
  id: string;
  actorId: string | null;
  actorLogin: string | null;
  action: string;
  targetId: string | null;
  targetLabel: string | null;
  metadata: unknown;
  createdAt: Date | string;
}

/** Map a persisted row to the serializable API entry. */
export function toAuditLogEntry(row: AuditLogRowLike): AuditLogEntry {
  const createdAt =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : new Date(row.createdAt).toISOString();

  return {
    id: row.id,
    actorId: row.actorId,
    actorLogin: row.actorLogin,
    action: row.action,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : null,
    createdAt,
  };
}

export interface AuditLogSummary {
  total: number;
  byAction: Record<string, number>;
}

export function summarizeAuditLog(entries: AuditLogEntry[]): AuditLogSummary {
  const byAction: Record<string, number> = {};
  for (const entry of entries) {
    byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
  }
  return { total: entries.length, byAction };
}
