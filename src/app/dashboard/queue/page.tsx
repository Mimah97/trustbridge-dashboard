"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RefreshCw, RotateCw } from "lucide-react";
import { useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { SorobanOutboxDeadLetterPanel } from "@/components/SorobanOutboxDeadLetterPanel";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatRelativeTime } from "@/lib/utils";

interface FailedJob {
  id: string;
  type: string;
  status: string;
  error: string | null;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface DlqResponse {
  jobs: FailedJob[];
  count: number;
}

export default function DeadLetterQueuePage() {
  const queryClient = useQueryClient();
  const [jobToRetry, setJobToRetry] = useState<FailedJob | null>(null);

  const dlqQuery = useQuery({
    queryKey: ["queue", "dlq"],
    queryFn: async () => {
      const response = await fetch("/api/contributors/queue/dlq");
      if (!response.ok) throw new Error("Failed to load failed jobs");
      return (await response.json()) as DlqResponse;
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const response = await fetch(
        `/api/contributors/queue/dlq/${jobId}/retry`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? "Retry failed");
      }
      return (await response.json()) as { job: { id: string } };
    },
    onSuccess: () => {
      setJobToRetry(null);
      void queryClient.invalidateQueries({ queryKey: ["queue", "dlq"] });
    },
  });

  const jobs = dlqQuery.data?.jobs ?? [];

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Dead-letter queue</h1>
          <p className="mt-2 text-muted-foreground">
            Recheck and email jobs that failed after all retries. Fix the
            underlying cause, then re-queue.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => dlqQuery.refetch()}
          disabled={dlqQuery.isFetching}
        >
          {dlqQuery.isFetching ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      <SorobanOutboxDeadLetterPanel />

      {retryMutation.isError ? (
        <p className="mb-4 text-sm text-destructive" role="alert">
          {(retryMutation.error as Error).message}
        </p>
      ) : null}

      {dlqQuery.isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading failed jobs…
        </div>
      ) : dlqQuery.isError ? (
        <p className="text-destructive">
          Could not load the dead-letter queue. Try again.
        </p>
      ) : jobs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
            <AlertTriangle className="h-8 w-8 text-muted-foreground/60" />
            <p className="font-medium text-foreground">No failed jobs</p>
            <p className="text-sm">
              Every recheck and email job has completed successfully.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {jobs.map((job) => (
            <Card key={job.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                <div className="min-w-0">
                  <CardTitle className="font-mono text-sm">{job.type}</CardTitle>
                  <CardDescription className="mt-1 space-x-2">
                    <span className="font-mono">{job.id}</span>
                    <span>·</span>
                    <span>failed {formatRelativeTime(job.completedAt)}</span>
                    {job.attempts > 0 ? (
                      <>
                        <span>·</span>
                        <span>{job.attempts} previous retr{job.attempts === 1 ? "y" : "ies"}</span>
                      </>
                    ) : null}
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  onClick={() => setJobToRetry(job)}
                  disabled={
                    retryMutation.isPending &&
                    retryMutation.variables === job.id
                  }
                  data-testid={`retry-job-${job.id}`}
                  aria-label={`Retry job ${job.id}`}
                >
                  {retryMutation.isPending &&
                  retryMutation.variables === job.id ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCw className="mr-2 h-4 w-4" />
                  )}
                  Retry
                </Button>
              </CardHeader>
              <CardContent>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs text-muted-foreground">
                  {job.error ?? "(no error message recorded)"}
                </pre>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={jobToRetry !== null}
        title="Retry failed DLQ job?"
        description={
          jobToRetry ? (
            <>
              Re-queueing job <strong className="font-mono">{jobToRetry.id}</strong> ({jobToRetry.type}) will reset its status to pending and re-execute it immediately in the background worker.
            </>
          ) : (
            "Re-queueing this failed job will reset its status to pending and re-execute it in the background worker."
          )
        }
        warning="Ensure the underlying issue has been resolved. Retrying a poison job may cause repeated failures, trigger duplicate notifications, or consume rate limits."
        confirmLabel="Retry job"
        cancelLabel="Cancel"
        pending={retryMutation.isPending}
        onConfirm={() => {
          if (jobToRetry) {
            retryMutation.mutate(jobToRetry.id);
          }
        }}
        onCancel={() => {
          if (!retryMutation.isPending) {
            setJobToRetry(null);
          }
        }}
      />
    </main>
  );
}
