import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SorobanOutboxDeadLetterPanel } from "@/components/SorobanOutboxDeadLetterPanel";

const failedItem = {
  id: "outbox-failed-1",
  action: "register",
  attempts: 5,
  lastError: "Soroban RPC timed out",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
};

function renderWithClient() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SorobanOutboxDeadLetterPanel />
    </QueryClientProvider>
  );
}

describe("Soroban outbox dead-letter panel", () => {
  const originalFetch = globalThis.fetch;
  let replayStatus = 200;

  beforeEach(() => {
    vi.clearAllMocks();
    replayStatus = 200;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/soroban/outbox/dlq") {
        return new Response(JSON.stringify({ items: [failedItem], count: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/outbox-failed-1/replay") && init?.method === "POST") {
        return new Response(
          JSON.stringify(
            replayStatus === 200
              ? { item: { id: failedItem.id, status: "COMPLETED" } }
              : { error: "Soroban outbox replay could not be completed" }
          ),
          {
            status: replayStatus,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("requires confirmation before replay and reports success", async () => {
    const user = userEvent.setup();
    renderWithClient();

    await user.click(await screen.findByTestId("replay-soroban-outbox-outbox-failed-1"));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(/immediately tries the Soroban mirror/i)).toBeInTheDocument();
    expect(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([, init]) => init?.method === "POST"
      )
    ).toHaveLength(0);

    await user.click(screen.getByTestId("confirm-dialog-confirm"));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Replay completed for outbox-failed-1."
    );
    await waitFor(() => {
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(
          ([url, init]) =>
            String(url).endsWith("/outbox-failed-1/replay") &&
            init?.method === "POST"
        )
      ).toBe(true);
    });
  });

  it("shows an actionable error when replay is unavailable", async () => {
    replayStatus = 503;
    const user = userEvent.setup();
    renderWithClient();

    await user.click(await screen.findByTestId("replay-soroban-outbox-outbox-failed-1"));
    await user.click(screen.getByTestId("confirm-dialog-confirm"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Soroban outbox replay could not be completed"
    );
  });
});