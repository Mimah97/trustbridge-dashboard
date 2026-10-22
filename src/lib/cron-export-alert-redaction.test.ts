/**
 * Redaction and alert-on-fail tests for the cron export alert path (#648).
 *
 * Covers:
 *   - hard export failures carry a redacted error (no raw G-addresses/secrets)
 *   - benign errors pass through unchanged
 *   - alert delivery failure never throws (must not crash the cron handler)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { redactAlertText, sendCronExportAlert } from "@/lib/cron-export-alert";
import type { CronExportResult } from "@/lib/cron-export";

const ADDRESS = `G${"A".repeat(55)}`;

function failedResult(error: string): CronExportResult {
  return {
    status: "error",
    startedAt: "2026-10-17T02:00:01.000Z",
    durationMs: 1234,
    error,
  };
}

function okResponse() {
  return Promise.resolve(new Response(null, { status: 200 }));
}

describe("redactAlertText", () => {
  it("masks Stellar G-addresses but keeps a triage suffix", () => {
    const redacted = redactAlertText(`payout failed for ${ADDRESS}`);
    expect(redacted).not.toContain(ADDRESS);
    expect(redacted).toContain(`${ADDRESS.slice(0, 5)}...${ADDRESS.slice(-4)}`);
  });

  it("masks api-key-style secrets and bearer tokens", () => {
    const redacted = redactAlertText(
      "auth failed tb_abcdefgh12345678 with Bearer abcdef123456"
    );
    expect(redacted).not.toContain("tb_abcdefgh12345678");
    expect(redacted).toContain("[redacted-secret]");
    expect(redacted).toContain("Bearer [redacted]");
  });

  it("leaves benign errors untouched", () => {
    expect(redactAlertText("Database connection timeout")).toBe(
      "Database connection timeout"
    );
  });
});

describe("sendCronExportAlert redaction (fail path)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    delete process.env.CRON_EXPORT_ALERT_WEBHOOK_URL;
    delete process.env.CRON_EXPORT_ALERT_PAGERDUTY_KEY;
  });

  it("redacts addresses and secrets from the alert payload and text", async () => {
    process.env.CRON_EXPORT_ALERT_WEBHOOK_URL =
      "https://hooks.example.com/alert";
    mockFetch.mockReturnValueOnce(okResponse());

    await sendCronExportAlert(
      failedResult(`stream aborted for ${ADDRESS} key tb_abcdefgh12345678`)
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.error).not.toContain(ADDRESS);
    expect(body.error).not.toContain("tb_abcdefgh12345678");
    expect(body.error).toContain("[redacted-secret]");
    expect(body.text).not.toContain(ADDRESS);
  });

  it("alert delivery failure never throws", async () => {
    process.env.CRON_EXPORT_ALERT_WEBHOOK_URL =
      "https://hooks.example.com/alert";
    mockFetch.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(
      sendCronExportAlert(failedResult("db down"))
    ).resolves.toBeUndefined();
  });
});
