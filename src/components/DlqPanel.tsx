"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

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
  type: string | null;
  status?: string;
  error: string | null;
  attempts: number;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt: string | null;
}

interface DlqResponse {
  jobs: FailedJob[];
  count: number;
}

const MAX_ERROR_LENGTH = 120;

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

export function DlqPanel() {
  const dlqQuery = useQuery({
    queryKey: ["queue", "dlq"],
    queryFn: async () => {
      const response = await fetch("/api/contributors/queue/dlq");
      if (!response.ok) throw new Error("Failed to load failed jobs");
      return (await response.json()) as DlqResponse;
    },
  });

  return (
    <Card data-testid="dlq-panel">
      <CardHeader>
        <CardTitle>Dead-letter queue</CardTitle>
        <CardDescription>
          Failed background jobs. Manage retries on the queue page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {dlqQuery.isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading failed jobs…
          </div>
        ) : dlqQuery.isError ? (
          <p className="text-destructive" data-testid="dlq-error">
            Failed to load failed jobs
          </p>
        ) : !dlqQuery.data || dlqQuery.data.jobs.length === 0 ? (
          <p className="text-muted-foreground" data-testid="dlq-empty">
            No failed jobs
          </p>
        ) : (
          <ul
            className="divide-y divide-border"
            data-testid="dlq-job-list"
            aria-label="Failed background jobs"
          >
            {dlqQuery.data.jobs.map((job) => {
              const retries = job.attempts ?? 0;
              const retryLabel =
                retries === 1 ? "1 retry" : `${retries} retries`;

              return (
                <li key={job.id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-0.5">
                      <p className="font-mono text-xs font-medium">
                        {job.type ?? "—"}
                      </p>
                      {job.error ? (
                        <p className="text-xs text-muted-foreground">
                          {truncate(job.error, MAX_ERROR_LENGTH)}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">—</p>
                      )}
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <p>{retryLabel}</p>
                      <p>
                        completed:{" "}
                        {job.completedAt
                          ? formatRelativeTime(job.completedAt)
                          : "Never"}
                      </p>
                      {job.createdAt && (
                        <p>created: {formatRelativeTime(job.createdAt)}</p>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <Link
          href="/dashboard/queue"
          className="block text-sm text-primary underline-offset-4 hover:underline"
        >
          View all →
        </Link>
      </CardContent>
    </Card>
  );
}
