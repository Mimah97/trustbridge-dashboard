/**
 * Tests for the ContractSyncPanel component (issue #554).
 *
 * The panel is defined inline in `src/app/dashboard/settings/page.tsx`.
 * We re-export it in this file purely for testing purposes by rendering
 * the full page with mocked fetch. The tests cover:
 * - Success path: synced counts are rendered
 * - Error path: error badge and error list rendered
 * - Empty/null lastRun: empty state rendered
 * - Polling cleanup: clearInterval called on unmount
 */

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need to render the ContractSyncPanel; since it's defined inline in
// the settings page, we import the full page and look for the panel.
// But the page also has DlqPanel which will try to fetch — mock that too.

// We'll import just the inline component by importing the full settings page
// and checking the contract-sync-panel testid.

// Mock next/navigation for the page
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/settings",
}));

// Mock all child components that trigger their own fetches or have side effects
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

describe("ContractSyncPanel", () => {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  function mockFetchWithContractSync(contractSyncBody: unknown, otherHandler?: (url: string) => Response | null) {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/contract-sync")) {
        return new Response(JSON.stringify(contractSyncBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Other API calls used by the settings page queries
      if (otherHandler) {
        const resp = otherHandler(url);
        if (resp) return resp;
      }
      // Return properly shaped defaults so the settings page doesn't crash
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

  it("renders synced counts on a success response", async () => {
    mockFetchWithContractSync({
      lastRun: {
        status: "ok",
        startedAt: new Date().toISOString(),
        durationMs: 12,
        synced: 5,
        created: 2,
        updated: 1,
        unchanged: 2,
      },
    });

    renderWithClient(<MaintainerSettingsPage />);

    const panel = await screen.findByTestId("contract-sync-panel");
    expect(panel).toBeInTheDocument();

    // Wait for async fetch to complete and counts to appear
    await waitFor(() => {
      expect(panel).toHaveTextContent("Synced");
    });
    expect(panel).toHaveTextContent("5");
    expect(panel).toHaveTextContent("Created");
    expect(panel).toHaveTextContent("2");
    expect(panel).toHaveTextContent("Updated");
    expect(panel).toHaveTextContent("1");
    expect(panel).toHaveTextContent("Unchanged");
  });

  it("renders error badge and error list on an error response", async () => {
    mockFetchWithContractSync({
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

  it("renders empty state when lastRun is null", async () => {
    mockFetchWithContractSync({ lastRun: null });

    renderWithClient(<MaintainerSettingsPage />);

    const panel = await screen.findByTestId("contract-sync-panel");

    await waitFor(() => {
      expect(panel).toHaveTextContent("No sync has run yet");
    });
    expect(screen.getByTestId("contract-sync-empty")).toBeInTheDocument();
  });

  it("clears the polling interval on unmount", async () => {
    mockFetchWithContractSync({ lastRun: null });

    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const { unmount } = renderWithClient(<MaintainerSettingsPage />);

    await screen.findByTestId("contract-sync-panel");

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
