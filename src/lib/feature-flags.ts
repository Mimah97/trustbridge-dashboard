import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Feature flags for the TrustBridge Dashboard (issue #201).
 *
 * Resolution order for every flag:
 *   1. Environment override  — `FEATURE_FLAG_<KEY>` (e.g. FEATURE_FLAG_BATCH_RECHECK)
 *   2. Database row          — only when `FEATURE_FLAGS_DB_ENABLED` is truthy
 *   3. Built-in default      — the `default` field below
 *
 * "Fail closed" for risky writes: when the DB source is enabled but unreadable
 * (connection error, migration not applied, …) a `risky` flag resolves to
 * `false` regardless of its default, so a database outage can never silently
 * open a dangerous code path.
 *
 * DB reads are cached in-process for `FEATURE_FLAGS_CACHE_TTL_MS` (default 30s).
 * Call {@link clearFeatureFlagCache} after writing a flag so the change is
 * visible immediately in the current process.
 */

export type FeatureFlagKey =
  | "batch_recheck"
  | "invite_generation"
  | "dlq_retry"
  | "maintenance_mode"
  | "otel_traces"
  | "freeze_window";

interface FlagDefinition {
  description: string;
  /** Value used when there is no env override and no usable DB row. */
  default: boolean;
  /**
   * Risky flags gate mutating / destructive behaviour. They fail closed: if
   * the DB source is enabled but unreadable, the flag resolves to `false`.
   */
  risky: boolean;
}

export const FEATURE_FLAGS: Record<FeatureFlagKey, FlagDefinition> = {
  batch_recheck: {
    description:
      "Allow maintainers to enqueue a full batch recheck of every contributor.",
    default: true,
    risky: true,
  },
  invite_generation: {
    description: "Allow maintainers to generate invite codes.",
    default: true,
    risky: true,
  },
  dlq_retry: {
    description:
      "Allow maintainers to retry failed jobs and Soroban outbox items from their dead-letter queues.",
    default: true,
    risky: true,
  },
  maintenance_mode: {
    description:
      "Serve the maintenance banner and 503 mutating APIs. The MAINTENANCE=1 env var does the same and is the recommended kill switch.",
    default: false,
    risky: true,
  },
  otel_traces: {
    description:
      "Emit OpenTelemetry-style spans for API routes, Prisma and Horizon calls. Also toggled by OTEL_TRACES_ENABLED.",
    default: false,
    risky: false,
  },
  freeze_window: {
    description:
      "Enforce wave freeze-window blocking on mutating APIs. When OFF, freeze-window helpers never block requests regardless of FREEZE_WINDOW_* env vars.",
    default: true,
    risky: true,
  },
};

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[];

const TRUTHY = new Set(["1", "true", "on", "yes", "enabled"]);
const FALSY = new Set(["0", "false", "off", "no", "disabled"]);

function parseBoolEnv(raw: string | undefined): boolean | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "") return undefined;
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return undefined;
}

function envOverride(key: FeatureFlagKey): boolean | undefined {
  return parseBoolEnv(process.env[`FEATURE_FLAG_${key.toUpperCase()}`]);
}

function dbSourceEnabled(): boolean {
  return parseBoolEnv(process.env.FEATURE_FLAGS_DB_ENABLED) === true;
}

function cacheTtlMs(): number {
  const n = Number.parseInt(process.env.FEATURE_FLAGS_CACHE_TTL_MS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

interface DbCacheEntry {
  /** null value => DB source enabled but the read failed (fail-closed path). */
  flags: Map<string, boolean> | null;
  expiresAt: number;
}

let dbCache: DbCacheEntry | null = null;

/** Drop the cached DB snapshot so the next read hits the database again. */
export function clearFeatureFlagCache(): void {
  dbCache = null;
}

async function readDbFlags(): Promise<Map<string, boolean> | null> {
  const now = Date.now();
  if (dbCache && dbCache.expiresAt > now) return dbCache.flags;

  try {
    const rows = await prisma.featureFlag.findMany({
      select: { key: true, enabled: true },
    });
    const map = new Map<string, boolean>();
    for (const row of rows) map.set(row.key, row.enabled);
    dbCache = { flags: map, expiresAt: now + cacheTtlMs() };
    return map;
  } catch (error) {
    console.error("[feature-flags] database read failed; failing closed", error);
    // Cache the failure briefly so a hard DB outage doesn't hammer the pool.
    dbCache = { flags: null, expiresAt: now + Math.min(cacheTtlMs(), 5_000) };
    return null;
  }
}

export type FlagSource = "env" | "db" | "default" | "fail-closed";

/**
 * Human-readable label for a flag source, for the admin read-only panel.
 */
export function flagSourceLabel(source: FlagSource): string {
  switch (source) {
    case "env":
      return "Environment override";
    case "db":
      return "Database";
    case "default":
      return "Built-in default";
    case "fail-closed":
      return "Fail-closed (DB unreadable)";
  }
}

export interface ResolvedFlag {
  key: FeatureFlagKey;
  description: string;
  enabled: boolean;
  source: FlagSource;
  risky: boolean;
}

function resolve(
  key: FeatureFlagKey,
  dbFlags: Map<string, boolean> | null,
): ResolvedFlag {
  const def = FEATURE_FLAGS[key];
  const base = { key, description: def.description, risky: def.risky };

  const override = envOverride(key);
  if (override !== undefined) {
    return { ...base, enabled: override, source: "env" };
  }

  if (dbSourceEnabled()) {
    if (dbFlags === null) {
      // Unreadable DB source: risky flags fail closed, others fall back to default.
      return {
        ...base,
        enabled: def.risky ? false : def.default,
        source: "fail-closed",
      };
    }
    const dbVal = dbFlags.get(key);
    if (dbVal !== undefined) {
      return { ...base, enabled: dbVal, source: "db" };
    }
  }

  return { ...base, enabled: def.default, source: "default" };
}

/**
 * Resolve a single feature flag. Safe to call on every request — the DB read
 * (when enabled) is cached in-process.
 */
export async function isFeatureEnabled(key: FeatureFlagKey): Promise<boolean> {
  if (!(key in FEATURE_FLAGS)) return false;

  // Fast path: an env override short-circuits before touching the database.
  const override = envOverride(key);
  if (override !== undefined) return override;

  const dbFlags = dbSourceEnabled() ? await readDbFlags() : null;
  return resolve(key, dbFlags).enabled;
}

/**
 * Env-only resolution: env override, otherwise the built-in default. Never
 * touches the database, so it is safe from the Edge middleware runtime.
 */
export function isFeatureEnabledFromEnv(key: FeatureFlagKey): boolean {
  if (!(key in FEATURE_FLAGS)) return false;
  const override = envOverride(key);
  if (override !== undefined) return override;
  return FEATURE_FLAGS[key].default;
}

/** Resolve every known flag, including its source — for docs / an admin view. */
export async function getAllFeatureFlags(): Promise<ResolvedFlag[]> {
  const dbFlags = dbSourceEnabled() ? await readDbFlags() : null;
  return FEATURE_FLAG_KEYS.map((key) => resolve(key, dbFlags));
}

/**
 * Upsert a flag into the database source and clear the cache.
 * Throws when the DB source is disabled — callers should surface that to the
 * admin UI rather than silently no-op.
 */
export async function setFeatureFlag(
  key: FeatureFlagKey,
  enabled: boolean,
  updatedById?: string,
): Promise<void> {
  if (!(key in FEATURE_FLAGS)) {
    throw new Error(`Unknown feature flag: ${key}`);
  }
  if (!dbSourceEnabled()) {
    throw new Error(
      "FEATURE_FLAGS_DB_ENABLED is not set; database flag writes are disabled.",
    );
  }
  await prisma.featureFlag.upsert({
    where: { key },
    create: {
      key,
      enabled,
      description: FEATURE_FLAGS[key].description,
      updatedById: updatedById ?? null,
    },
    update: { enabled, updatedById: updatedById ?? null },
  });
  clearFeatureFlagCache();
}
