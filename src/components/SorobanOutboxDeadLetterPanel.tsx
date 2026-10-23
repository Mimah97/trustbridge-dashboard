"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RefreshCw, RotateCw } from "lucide-react";
import { useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatRelativeTime } from "@/lib/utils";

interface SorobanOutboxDeadLetter {
  id: string;
  action: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DeadLettersResponse {
  items: SorobanOutboxDeadLetter[];
  count: number;
}

export function SorobanOutboxDeadLetterPanel() {
  const queryClient = useQueryClient();
  const [itemToReplay, setItemToReplay] = useState<SorobanOutboxDeadLetter | null>(null);
  const [replayNotice, setReplayNotice] = useState<string | null>(null);

  const deadLettersQuery = useQuery({
    queryKey: ["soroban-outbox", "dlq"],
    queryFn: async () => {
      const response = await fetch("/api/soroban/outbox/dlq");
      if (!response.ok) throw new Error("Failed to load Soroban outbox items");
      return (await response.json()) as DeadLettersResponse;
    },
  });

  const replayMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(
        `/api/soroban/outbox/dlq/${encodeURIComponent(id)}/replay`,
        { method: "POST" }
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? "Soroban outbox replay failed");
      }
      return (await response.json()) as { item: { id: string; status: string } };
    },
    onSuccess: (result) => {
      setItemToReplay(null);
      setReplayNotice(
        result.item.status === "COMPLETED"
          ? `Replay completed for ${result.item.id}.`
          : `Replay attempted for ${result.item.id}; the worker will retry if needed.`
      );
      void queryClient.invalidateQueries({ queryKey: ["soroban-outbox", "dlq"] });
    },
  });

  const items = deadLettersQuery.data?.items ?? [];

  return (
    <>
      <Card className="mb-8" data-testid="soroban-outbox-dead-letters">
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-lg">Soroban outbox dead letters</CardTitle>
            <CardDescription className="mt-2">
              Failed registration mirrors scoped to your maintainer organization.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            aria-label="Refresh Soroban outbox dead letters"
            onClick={() => deadLettersQuery.refetch()}
            disabled={deadLettersQuery.isFetching}
          >
            {deadLettersQuery.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </CardHeader>
        <CardContent>
          {replayMutation.isError ? (
            <p className="mb-4 text-sm text-destructive" role="alert">
              {(replayMutation.error as Error).message}
            </p>
          ) : null}
          {replayNotice ? (
            <p className="mb-4 text-sm text-muted-foreground" role="status">
              {replayNotice}
            </p>
          ) : null}

          {deadLettersQuery.isLoading ? (
            <div className="flex items-center py-6 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading Soroban outbox items...
            </div>
          ) : deadLettersQuery.isError ? (
            <p className="text-sm text-destructive" role="alert">
              Could not load Soroban outbox dead letters. Try refreshing.
            </p>
          ) : items.length === 0 ? (
            <div className="flex items-center gap-3 py-4 text-muted-foreground">
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              <p className="text-sm">No failed Soroban outbox items.</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-start justify-between gap-4 py-4 first:pt-0 last:pb-0"
                  data-testid={`soroban-outbox-item-${item.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="font-medium">{item.action}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {item.id}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {item.attempts} attempts
                      </span>
                      <span className="text-xs text-muted-foreground">
                        updated {formatRelativeTime(item.updatedAt)}
                      </span>
                    </div>
                    {item.lastError ? (
                      <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs text-muted-foreground">
                        {item.lastError}
                      </pre>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      setReplayNotice(null);
                      replayMutation.reset();
                      setItemToReplay(item);
                    }}
                    disabled={replayMutation.isPending}
                    data-testid={`replay-soroban-outbox-${item.id}`}
                  >
                    {replayMutation.isPending &&
                    replayMutation.variables === item.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCw className="mr-2 h-4 w-4" />
                    )}
                    Replay
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={itemToReplay !== null}
        title="Replay Soroban outbox item?"
        description={
          itemToReplay ? (
            <>
              Retry <strong>{itemToReplay.action}</strong> item{" "}
              <strong className="font-mono">{itemToReplay.id}</strong>. This
              resets its attempt counter and immediately tries the Soroban mirror.
            </>
          ) : (
            "This resets the attempt counter and immediately retries the Soroban mirror."
          )
        }
        warning="Resolve the original failure first. Replaying sends another registration write to Soroban."
        confirmLabel="Replay item"
        cancelLabel="Cancel"
        pending={replayMutation.isPending}
        onConfirm={() => {
          if (itemToReplay) replayMutation.mutate(itemToReplay.id);
        }}
        onCancel={() => {
          if (!replayMutation.isPending) setItemToReplay(null);
        }}
      />
    </>
  );
}