/**
 * Unit tests for the ContractSyncPanel component (issue #554).
 *
 * ContractSyncPanel is defined inline in `src/app/dashboard/settings/page.tsx`.
 * These tests mount the full settings page with mocked child components and a
 * mocked fetch, then assert on the contract-sync-panel testid.
 *
 * Covers:
 * 1. Success path: mock returns ok lastRun → success badge rendered
 * 2. Error path: mock returns error lastRun → error badge and error message
 * 3. Empty path: mock returns null lastRun → "no sync has run yet" text
 * 4. Polling cleanup: clearInterval is called after unmount
 */

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child components that trigger their own fetches or side effects
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/settings",
}));

vi.mock("@/components/NetworkStatusPanel", () => ({
  NetworkStatusPanel: () => <div data-testid="network-status-panel-mock" />,
}));
vi.mock("@/components/SessionPanel", () => ({
  SessionPanel: () => <div data-testid="session-panel-mock" />,
}));
vi.mock("@/components/ApiKeyPanel", () => ({
  ApiKeyPanel: () => <div data-testid="api-key-panel-mock" />,
}));
vi.mock("@/components/RestorePanel", () => ({
  RestorePanel: () => <div data-testid="restore-panel-mock" />,
}));
vi.mock("@/components/DlqPanel", () => ({
  DlqPanel: () => <div data-testid="dlq-panel-mock" />,
}));

import MaintainerSettingsPage from "@/app/dashboard/settings/page";

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

/** Set up globalThis.fetch so contract-sync returns the given body; all
 *  other requests return properly shaped 200 responses. */
function mockFetch(contractSyncBody: unknown) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/contract-sync")) {
      return new Response(JSON.stringify(contractSyncBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/settings/network")) {
      return new Response(
        JSON.stringify({
          horizonUrl: "https://horizon-testnet.stellar.org",
          horizonNetwork: "testnet",
          sorobanUrl: "https://soroban-testnet.stellar.org",
          sorobanNetwork: "testnet",
          sorobanContractConfigured: false,
          mismatched: false,
          warnings: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.includes("/api/audit")) {
      return new Response(
        JSON.stringify({ entries: [], summary: { total: 0, byAction: {} } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.includes("/api/settings/feature-flags")) {
      return new Response(
        JSON.stringify({ flags: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("ContractSyncPanel", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders a success badge when lastRun.status is ok", async () => {
    mockFetch({
      lastRun: {
        status: "ok",
        startedAt: new Date().toISOString(),
        durationMs: 12,
      },
    });

    renderWithClient(<MaintainerSettingsPage />);

    const panel = await screen.findByTestId("contract-sync-panel");

    await waitFor(() => {
      expect(panel).toHaveTextContent("success");
    });
  });

  it("renders an error badge when lastRun.status is error", async () => {
    mockFetch({
      lastRun: {
        status: "error",
        startedAt: new Date().toISOString(),
        durationMs: 5,
        errors: ["Horizon RPC outage"],
      },
    });

    renderWithClient(<MaintainerSettingsPage />);

    const panel = await screen.findByTestId("contract-sync-panel");

    await waitFor(() => {
      expect(panel).toHaveTextContent("error");
    });
    expect(panel).toHaveTextContent("Horizon RPC outage");
  });

  it('renders "No sync has run yet" when lastRun is null', async () => {
    mockFetch({ lastRun: null });

    renderWithClient(<MaintainerSettingsPage />);

    const panel = await screen.findByTestId("contract-sync-panel");

    await waitFor(() => {
      expect(panel).toHaveTextContent("No sync has run yet");
    });
  });

  it("calls clearInterval after unmount (polling cleanup)", async () => {
    mockFetch({ lastRun: null });

    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const { unmount } = renderWithClient(<MaintainerSettingsPage />);

    await screen.findByTestId("contract-sync-panel");

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
