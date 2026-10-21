/**
 * Tests for the DlqPanel component (issue #557).
 *
 * Covers:
 * - Normal display with jobs
 * - Empty state (no failed jobs)
 * - API error state
 * - Missing/partial fields handled gracefully
 */

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DlqPanel } from "@/components/DlqPanel";

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

const MOCK_JOBS = [
  {
    id: "job-abc-123",
    type: "recheck.batch",
    status: "failed",
    error: "Horizon rate limit exceeded after 3 attempts",
    attempts: 3,
    createdAt: new Date("2026-08-01T10:00:00Z").toISOString(),
    startedAt: new Date("2026-08-01T10:00:01Z").toISOString(),
    completedAt: new Date("2026-08-01T10:00:05Z").toISOString(),
  },
];

describe("DlqPanel", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders job type and error when jobs are returned", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ jobs: MOCK_JOBS, count: MOCK_JOBS.length }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    renderWithClient(<DlqPanel />);

    const panel = await screen.findByTestId("dlq-panel");
    await waitFor(() => {
      expect(screen.getByTestId("dlq-job-list")).toBeInTheDocument();
    });

    expect(panel).toHaveTextContent("recheck.batch");
    expect(panel).toHaveTextContent("Horizon rate limit exceeded");
    expect(panel).toHaveTextContent("3 retries");
  });

  it("renders empty state when no failed jobs are returned", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ jobs: [], count: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    renderWithClient(<DlqPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("dlq-empty")).toBeInTheDocument();
    });
    expect(screen.getByTestId("dlq-empty")).toHaveTextContent("No failed jobs");
  });

  it("renders error state when the API returns an error", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: "Forbidden" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      )
    );

    renderWithClient(<DlqPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("dlq-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("dlq-error")).toHaveTextContent("Failed to load failed jobs");
  });

  it("handles missing/partial fields without throwing", async () => {
    const partialJob = {
      id: "job-partial",
      type: null,
      error: null,
      attempts: 0,
      completedAt: null,
    };

    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ jobs: [partialJob], count: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    renderWithClient(<DlqPanel />);

    const panel = await screen.findByTestId("dlq-panel");
    await waitFor(() => {
      expect(screen.getByTestId("dlq-job-list")).toBeInTheDocument();
    });

    // Should render "—" for missing type and not crash
    expect(panel).toHaveTextContent("—");
    // 0 retries — rendered as "0 retries" or similar
    expect(panel).toHaveTextContent("0 retr");
    // completedAt is null — formatRelativeTime returns "Never"
    expect(panel).toHaveTextContent("Never");
  });
});
