import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StructuredLogger,
  createRequestLogger,
  logger,
  serializeError,
} from "@/lib/logger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture stdout / stderr writes for a test. */
function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });

  return {
    stdout,
    stderr,
    restore() {
      vi.mocked(process.stdout.write).mockRestore();
      vi.mocked(process.stderr.write).mockRestore();
      void origOut; // satisfy linter
      void origErr;
    },
  };
}

function parseLastLine(lines: string[]): Record<string, unknown> {
  const last = lines[lines.length - 1];
  return JSON.parse(last) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// serializeError
// ---------------------------------------------------------------------------

describe("serializeError", () => {
  it("serializes an Error to an object with name, message, stack", () => {
    const err = new Error("boom");
    const result = serializeError(err);
    expect(result.name).toBe("Error");
    expect(result.message).toBe("boom");
    expect(typeof result.stack).toBe("string");
  });

  it("serializes non-Error thrown value as { raw: <string> }", () => {
    expect(serializeError("just a string")).toEqual({ raw: "just a string" });
    expect(serializeError(42)).toEqual({ raw: "42" });
    expect(serializeError(null)).toEqual({ raw: "null" });
  });

  it("includes cause one level deep", () => {
    const cause = new Error("root cause");
    const err = new Error("outer", { cause });
    const result = serializeError(err);
    expect(result.cause).toMatchObject({ name: "Error", message: "root cause" });
  });

  it("serializes non-Error cause as string", () => {
    const err = new Error("err");
    (err as Error & { cause: unknown }).cause = { something: true };
    const result = serializeError(err);
    expect(typeof result.cause).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// StructuredLogger
// ---------------------------------------------------------------------------

describe("StructuredLogger – log levels", () => {
  let cap: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    cap = captureOutput();
  });

  afterEach(() => {
    cap.restore();
    vi.unstubAllEnvs();
  });

  it("info() writes valid JSON to stdout", () => {
    const l = new StructuredLogger("test");
    l.info("hello world", { key: "value" });

    expect(cap.stdout).toHaveLength(1);
    const entry = parseLastLine(cap.stdout);
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("hello world");
    expect(entry.context).toBe("test");
    expect(entry.key).toBe("value");
    expect(typeof entry.timestamp).toBe("string");
  });

  it("warn() writes to stderr", () => {
    const l = new StructuredLogger("test");
    l.warn("caution", { detail: "x" });

    expect(cap.stderr).toHaveLength(1);
    const entry = parseLastLine(cap.stderr);
    expect(entry.level).toBe("warn");
    expect(entry.message).toBe("caution");
  });

  it("error() writes to stderr", () => {
    const l = new StructuredLogger("test");
    l.error("rpc failure", { error: serializeError(new Error("timeout")) });

    expect(cap.stderr).toHaveLength(1);
    const entry = parseLastLine(cap.stderr);
    expect(entry.level).toBe("error");
    expect(entry.message).toBe("rpc failure");
  });

  it("debug() is suppressed when DEBUG is not set", () => {
    delete process.env.DEBUG;
    const l = new StructuredLogger("test");
    l.debug("verbose");

    expect(cap.stdout).toHaveLength(0);
    expect(cap.stderr).toHaveLength(0);
  });

  it("debug() emits when DEBUG=true", () => {
    vi.stubEnv("DEBUG", "true");
    const l = new StructuredLogger("test");
    l.debug("verbose");

    expect(cap.stdout).toHaveLength(1);
    const entry = parseLastLine(cap.stdout);
    expect(entry.level).toBe("debug");
  });
});

describe("StructuredLogger – extra context", () => {
  let cap: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    cap = captureOutput();
  });

  afterEach(() => {
    cap.restore();
  });

  it("merges static extra fields into every log entry", () => {
    const l = new StructuredLogger("app", { requestId: "req-1" });
    l.info("test");

    const entry = parseLastLine(cap.stdout);
    expect(entry.requestId).toBe("req-1");
  });

  it("child() inherits parent extra and adds own fields", () => {
    const parent = new StructuredLogger("app", { requestId: "req-1" });
    const child = parent.child({ subsystem: "soroban" });
    child.info("child log");

    const entry = parseLastLine(cap.stdout);
    expect(entry.requestId).toBe("req-1");
    expect(entry.subsystem).toBe("soroban");
  });

  it("child() does not share mutable state with parent", () => {
    const parent = new StructuredLogger("app", { requestId: "req-1" });
    const child = parent.child({ requestId: "req-child" });

    parent.info("parent log");
    const parentEntry = parseLastLine(cap.stdout);
    expect(parentEntry.requestId).toBe("req-1");

    child.info("child log");
    const childEntry = parseLastLine(cap.stdout);
    expect(childEntry.requestId).toBe("req-child");
  });
});

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

describe("module-level logger singleton", () => {
  let cap: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    cap = captureOutput();
  });

  afterEach(() => {
    cap.restore();
  });

  it("import { logger } resolves without optional chaining", () => {
    // The import itself would throw at module load time if logger is undefined.
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("logger.error emits structured JSON to stderr", () => {
    logger.error("soroban_mirror_failed", {
      error: serializeError(new Error("rpc timeout")),
    });

    expect(cap.stderr.length).toBeGreaterThan(0);
    const entry = parseLastLine(cap.stderr);
    expect(entry.level).toBe("error");
    expect(entry.context).toBe("app");
  });
});

// ---------------------------------------------------------------------------
// createRequestLogger
// ---------------------------------------------------------------------------

describe("createRequestLogger", () => {
  let cap: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    cap = captureOutput();
  });

  afterEach(() => {
    cap.restore();
  });

  it("includes requestId on every entry", () => {
    const reqLog = createRequestLogger("req-abc-123");
    reqLog.info("register_start");

    const entry = parseLastLine(cap.stdout);
    expect(entry.requestId).toBe("req-abc-123");
    expect(entry.context).toBe("request");
  });

  it("different request loggers do not share requestId state", () => {
    const a = createRequestLogger("req-a");
    const b = createRequestLogger("req-b");

    a.info("from A");
    const entryA = parseLastLine(cap.stdout);

    b.info("from B");
    const entryB = parseLastLine(cap.stdout);

    expect(entryA.requestId).toBe("req-a");
    expect(entryB.requestId).toBe("req-b");
  });
});
