import "server-only";

/**
 * Structured logger for server-side use.
 *
 * Design constraints:
 * - **Server-only** — `import "server-only"` prevents accidental bundle
 *   inclusion on the client. Use `createRequestLogger` for per-request
 *   context; use the module-level `logger` singleton for library code that
 *   has no request context (e.g. soroban-register, background-queue workers).
 * - **JSON log shape** — every emit is a single `JSON.stringify` call so that
 *   log collectors (Datadog, Papertrail, etc.) can parse structured fields.
 * - **Tree-shake friendly** — the module-level `logger` is a plain `const`
 *   that Next.js can DCE from server bundles when unused. No global side
 *   effects on import.
 * - **Context isolation** — each `StructuredLogger` instance owns its own
 *   `context` object; concurrent requests using `createRequestLogger` never
 *   share mutable state.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  [key: string]: unknown;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  context: string;
  timestamp: string;
  /** Structured key/value metadata attached by the caller. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// serializeError
// ---------------------------------------------------------------------------

/**
 * Safely serialize any thrown value to a plain object so it can be embedded
 * in a JSON log entry without losing the message or stack.
 *
 * Large `cause` chains are truncated to a single level to bound log size.
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { raw: String(error) };
  }

  const serialized: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };

  // Include cause, but only one level deep to avoid unbounded recursion.
  if ("cause" in error && error.cause !== undefined) {
    const cause = error.cause;
    serialized.cause =
      cause instanceof Error
        ? { name: cause.name, message: cause.message }
        : String(cause);
  }

  return serialized;
}

// ---------------------------------------------------------------------------
// StructuredLogger
// ---------------------------------------------------------------------------

/**
 * Emit a single structured JSON log line to stdout/stderr.
 *
 * Usage:
 * ```ts
 * import { logger } from "@/lib/logger";
 * logger.info("soroban_mirror_attempted", { stellarAddress, contractId });
 * logger.error("soroban_mirror_failed", { stellarAddress, error: serializeError(err) });
 * ```
 */
export class StructuredLogger {
  /**
   * @param context - A short identifier for the subsystem, e.g. "app",
   *   "soroban-register", "queue-worker". Included in every log entry so
   *   filters can narrow to a specific subsystem.
   * @param extra - Static key/value pairs merged into every log entry emitted
   *   by this instance (e.g. `{ requestId }` for per-request loggers).
   */
  constructor(
    private readonly context: string,
    private readonly extra: LogContext = {}
  ) {}

  debug(message: string, meta?: LogContext): void {
    if (process.env.DEBUG === "true") {
      this.emit("debug", message, meta);
    }
  }

  info(message: string, meta?: LogContext): void {
    this.emit("info", message, meta);
  }

  warn(message: string, meta?: LogContext): void {
    this.emit("warn", message, meta);
  }

  error(message: string, meta?: LogContext): void {
    this.emit("error", message, meta);
  }

  /**
   * Return a child logger that inherits this instance's context string and
   * extra fields, merged with the additional `childExtra` fields. The child
   * does **not** share mutable state with the parent.
   */
  child(childExtra: LogContext): StructuredLogger {
    return new StructuredLogger(this.context, {
      ...this.extra,
      ...childExtra,
    });
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private emit(level: LogLevel, message: string, meta?: LogContext): void {
    const entry: LogEntry = {
      level,
      message,
      context: this.context,
      timestamp: new Date().toISOString(),
      ...this.extra,
      ...meta,
    };

    const line = JSON.stringify(entry);

    // Route errors/warnings to stderr so process monitors can capture them
    // separately from informational output.
    if (level === "error" || level === "warn") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/**
 * Application-wide logger singleton. Import this wherever structured logging
 * is needed in library code that has no per-request context.
 *
 * For HTTP routes, prefer `createRequestLogger(requestId)` so that all log
 * lines for a single request share a `requestId` field and can be correlated
 * in log collectors.
 *
 * ```ts
 * import { logger } from "@/lib/logger";
 * logger.info("startup", { env: process.env.NODE_ENV });
 * ```
 */
export const logger = new StructuredLogger("app");

// ---------------------------------------------------------------------------
// createRequestLogger
// ---------------------------------------------------------------------------

/**
 * Create a per-request child logger that includes `requestId` in every log
 * entry. Use this inside Next.js route handlers and server actions where a
 * request identifier is available.
 *
 * ```ts
 * const reqLogger = createRequestLogger(crypto.randomUUID());
 * reqLogger.info("register_start", { userId, stellarAddress });
 * ```
 */
export function createRequestLogger(requestId: string): StructuredLogger {
  return new StructuredLogger("request", { requestId });
import { NextRequest, NextResponse } from "next/server";

export interface StructuredLog {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  context: string;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

/**
 * Structured logging utility for request/response tracking and debugging.
 * Logs are emitted to stdout in JSON format for aggregation and analysis.
 *
 * Pass a `requestId` to the constructor (or via `withRequestId()`) to include
 * the ID in every log entry emitted by that instance — making it trivial to
 * grep all entries belonging to a single HTTP request.
 */
export class StructuredLogger {
  private context: string;
  private requestId?: string;

  constructor(context: string, requestId?: string) {
    this.context = context;
    this.requestId = requestId;
  }

  /**
   * Return a new logger that is identical to this one but carries the given
   * request ID. Useful when you need to hand off a scoped logger to a helper.
   */
  withRequestId(requestId: string): StructuredLogger {
    return new StructuredLogger(this.context, requestId);
  }

  private formatLog(
    level: StructuredLog["level"],
    message: string,
    details?: Record<string, unknown>
  ): StructuredLog {
    const entry: StructuredLog = {
      timestamp: new Date().toISOString(),
      level,
      context: this.context,
      message,
    };
    if (this.requestId) {
      entry.requestId = this.requestId;
    }
    if (details !== undefined) {
      entry.details = details;
    }
    return entry;
  }

  info(message: string, details?: Record<string, unknown>) {
    const log = this.formatLog("info", message, details);
    console.log(JSON.stringify(log));
  }

  warn(message: string, details?: Record<string, unknown>) {
    const log = this.formatLog("warn", message, details);
    console.warn(JSON.stringify(log));
  }

  error(message: string, details?: Record<string, unknown>) {
    const log = this.formatLog("error", message, details);
    console.error(JSON.stringify(log));
  }

  debug(message: string, details?: Record<string, unknown>) {
    const log = this.formatLog("debug", message, details);
    const debugFlag = process.env.DEBUG?.trim().toLowerCase();
    // Treat unset / empty / explicit falsey values as off; only truthy flags enable debug.
    if (debugFlag && debugFlag !== "0" && debugFlag !== "false" && debugFlag !== "off") {
      console.log(JSON.stringify(log));
    }
  }
}

/**
 * Serialize an unknown thrown value into a plain, log-friendly shape so that
 * structured log entries never lose the underlying error information.
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

/**
 * Middleware for logging incoming requests with structured format.
 * Logs method, path, origin, and user agent.
 */
export function createRequestLogger(context: string) {
  const logger = new StructuredLogger(context);

  return function logRequest(request: NextRequest) {
    const method = request.method;
    const pathname = request.nextUrl.pathname;
    const searchParams = request.nextUrl.searchParams.toString();
    const userAgent = request.headers.get("user-agent") ?? "unknown";
    const origin = request.headers.get("origin") ?? "unknown";

    logger.info("incoming_request", {
      method,
      pathname,
      searchParams: searchParams ? searchParams : undefined,
      userAgent,
      origin,
    });
  };
}

/**
 * Log API response with status, duration, and optional error details.
 */
export function logResponse(
  logger: StructuredLogger,
  response: NextResponse,
  duration: number,
  details?: Record<string, unknown>
) {
  logger.info("outgoing_response", {
    status: response.status,
    duration: `${duration}ms`,
    ...details,
  });
}

/**
 * Log Horizon API call with request/response details.
 */
export function logHorizonCall(
  logger: StructuredLogger,
  method: string,
  endpoint: string,
  duration: number,
  success: boolean,
  error?: string
) {
  if (success) {
    logger.info("horizon_request_success", {
      method,
      endpoint,
      duration: `${duration}ms`,
    });
  } else {
    logger.error("horizon_request_failed", {
      method,
      endpoint,
      duration: `${duration}ms`,
      error,
    });
  }
}

/**
 * Log database query with operation type and duration.
 */
export function logDatabaseQuery(
  logger: StructuredLogger,
  operation: string,
  duration: number,
  rowsAffected?: number
) {
  logger.debug("database_query", {
    operation,
    duration: `${duration}ms`,
    rowsAffected,
  });
}
