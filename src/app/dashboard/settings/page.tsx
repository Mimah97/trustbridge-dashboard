"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { NetworkStatusPanel } from "@/components/NetworkStatusPanel";
import { SessionPanel } from "@/components/SessionPanel";
import { ApiKeyPanel } from "@/components/ApiKeyPanel";
import { RestorePanel } from "@/components/RestorePanel";
import { DlqPanel } from "@/components/DlqPanel";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { describeAuditAction } from "@/lib/audit-format";
import { formatRelativeTime } from "@/lib/utils";
import type { AuditLogEntry, NetworkConfig } from "@/types";

// ContractSyncResult is mirrored here to avoid importing from the server-only
// contract-sync module (which has `import "server-only"` at the top).
interface ContractSyncResult {
  status: "ok" | "error" | "skipped";
  startedAt: string;
  durationMs: number;
  synced?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  errors?: string[];
}

interface AuditLogResponse {
  entries: AuditLogEntry[];
  summary: { total: number; byAction: Record<string, number> };
}

interface FeatureFlagEntry {
  key: string;
  enabled: boolean;
  value?: boolean;
  source: string;
  description?: string;
}

interface FeatureFlagsResponse {
  flags: FeatureFlagEntry[];
}

// ---------------------------------------------------------------------------
// ContractSyncPanel — polls /api/contract-sync every 30 s (issue #554)
// ---------------------------------------------------------------------------

type SyncStatus = "loading" | "success" | "error" | "skipped" | "empty";

function ContractSyncPanel() {
  const [status, setStatus] = useState<SyncStatus>("loading");
  const [lastRun, setLastRun] = useState<ContractSyncResult | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const response = await fetch("/api/contract-sync");
        if (!mounted) return;
        if (!response.ok) {
          setStatus("error");
          setFetchError(`HTTP ${response.status}`);
          return;
        }
        const data = (await response.json()) as { lastRun: ContractSyncResult | null };
        if (!mounted) return;
        if (!data.lastRun) {
          setLastRun(null);
          setStatus("empty");
        } else if (data.lastRun.status === "ok") {
          setLastRun(data.lastRun);
          setStatus("success");
        } else if (data.lastRun.status === "error") {
          setLastRun(data.lastRun);
          setStatus("error");
        } else if (data.lastRun.status === "skipped") {
          setLastRun(data.lastRun);
          setStatus("skipped");
        }
        setFetchError(null);
      } catch (err) {
        if (!mounted) return;
        setStatus("error");
        setFetchError(err instanceof Error ? err.message : "Fetch failed");
      }
    }

    void poll();
    const id = setInterval(() => void poll(), 30_000);

    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  const badgeVariant: Record<SyncStatus, "ready" | "secondary" | "destructive"> = {
    loading: "secondary",
    success: "ready",
    error: "destructive",
    skipped: "secondary",
    empty: "secondary",
  };

  return (
    <Card data-testid="contract-sync-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          {status === "loading" ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : status === "success" ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" />
          ) : (
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
          )}
          Contract sync
        </CardTitle>
        <CardDescription>
          Status of the most recent Soroban contract-to-Postgres sync run.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {status === "loading" && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading sync status…
          </div>
        )}

        {status !== "loading" && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Status:</span>
            <Badge variant={badgeVariant[status]}>{status}</Badge>
          </div>
        )}

        {status === "empty" && (
          <p className="text-muted-foreground" data-testid="contract-sync-empty">
            No sync has run yet.
          </p>
        )}

        {fetchError && (
          <p className="text-destructive">{fetchError}</p>
        )}

        {lastRun && status !== "empty" && (
          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            {lastRun.synced != null && (
              <>
                <div>
                  <dt className="text-muted-foreground">Synced</dt>
                  <dd className="font-medium">{lastRun.synced}</dd>
                </div>
              </>
            )}
            {lastRun.created != null && (
              <div>
                <dt className="text-muted-foreground">Created</dt>
                <dd className="font-medium">{lastRun.created}</dd>
              </div>
            )}
            {lastRun.updated != null && (
              <div>
                <dt className="text-muted-foreground">Updated</dt>
                <dd className="font-medium">{lastRun.updated}</dd>
              </div>
            )}
            {lastRun.unchanged != null && (
              <div>
                <dt className="text-muted-foreground">Unchanged</dt>
                <dd className="font-medium">{lastRun.unchanged}</dd>
              </div>
            )}
          </dl>
        )}

        {lastRun?.errors && lastRun.errors.length > 0 && (
          <ul className="space-y-1 text-xs text-destructive">
            {lastRun.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        {lastRun?.startedAt && (
          <p className="text-xs text-muted-foreground">
            Last run {formatRelativeTime(lastRun.startedAt)}
            {lastRun.durationMs != null ? ` (${lastRun.durationMs} ms)` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// MaintainerSettingsPage
// ---------------------------------------------------------------------------

export default function MaintainerSettingsPage() {
  const [replayBody, setReplayBody] = useState(`{
  "action": "added",
  "member": { "login": "octocat", "id": 1 },
  "organization": { "login": "trustbridge" },
  "sender": { "login": "maintainer" }
}`);
  const [replaySignature, setReplaySignature] = useState("");
  const [replayStatus, setReplayStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [isReplaying, setIsReplaying] = useState(false);

  const networkQuery = useQuery({
    queryKey: ["network-config"],
    queryFn: async () => {
      const response = await fetch("/api/settings/network");
      if (!response.ok) throw new Error("Failed to load network config");
      return (await response.json()) as NetworkConfig;
    },
  });

  const auditQuery = useQuery({
    queryKey: ["audit-log"],
    queryFn: async () => {
      const response = await fetch("/api/audit?limit=25");
      if (!response.ok) throw new Error("Failed to load audit log");
      return (await response.json()) as AuditLogResponse;
    },
  });

  const featureFlagsQuery = useQuery({
    queryKey: ["feature-flags"],
    queryFn: async () => {
      const response = await fetch("/api/settings/feature-flags");
      if (!response.ok) throw new Error("Failed to load feature flags");
      return (await response.json()) as FeatureFlagsResponse;
    },
  });

  const handleReplay = async () => {
    setIsReplaying(true);
    setReplayStatus(null);

    try {
      const response = await fetch("/api/webhooks/github-org-membership/replay", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(replaySignature ? { "X-Hub-Signature-256": replaySignature } : {}),
        },
        body: replayBody,
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Replay failed");
      }

      setReplayStatus({
        type: "success",
        message: `Replay accepted for ${payload.status ?? "event"}.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Replay failed";
      setReplayStatus({ type: "error", message });
    } finally {
      setIsReplaying(false);
    }
  };

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Maintainer settings</h1>
        <p className="mt-2 text-muted-foreground">
          Network configuration and recent maintainer activity for this
          TrustBridge deployment.
        </p>
      </div>

      <div className="mb-8">
        <SessionPanel />
      </div>

      <div className="mb-8">
        {networkQuery.isLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            Loading network configuration...
          </div>
        ) : networkQuery.isError ? (
          <p className="text-destructive">
            Failed to load network configuration.
          </p>
        ) : networkQuery.data ? (
          <NetworkStatusPanel config={networkQuery.data} />
        ) : null}
      </div>

      <div className="mb-8">
        <ContractSyncPanel />
      </div>

      <div className="mb-8">
        <DlqPanel />
      </div>

      <div className="mb-8">
        <ApiKeyPanel />
      </div>

      <Card className="mb-8" data-testid="webhook-replay-panel">
        <CardHeader>
          <CardTitle>GitHub org webhook replay</CardTitle>
          <CardDescription>
            Re-submit a recent GitHub organization membership event. Replay is
            restricted to admin maintainers and signature verification remains on
            by default.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="replay-payload" className="text-sm font-medium">
              Event payload
            </label>
            <textarea
              id="replay-payload"
              data-testid="webhook-replay-payload"
              value={replayBody}
              onChange={(event) => setReplayBody(event.target.value)}
              rows={12}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              spellCheck={false}
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="replay-signature" className="text-sm font-medium">
              Optional signature
            </label>
            <input
              id="replay-signature"
              data-testid="webhook-replay-signature"
              type="text"
              value={replaySignature}
              onChange={(event) => setReplaySignature(event.target.value)}
              placeholder="sha256=..."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="webhook-replay-submit"
              onClick={handleReplay}
              disabled={isReplaying}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {isReplaying ? "Replaying..." : "Replay event"}
            </button>

            {replayStatus && (
              <span
                role="status"
                data-testid="webhook-replay-status"
                className={
                  replayStatus.type === "success"
                    ? "text-sm text-emerald-600"
                    : "text-sm text-destructive"
                }
              >
                {replayStatus.message}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="mb-8">
        <RestorePanel />
      </div>

      <Card className="mb-8" data-testid="feature-flags-panel">
        <CardHeader>
          <CardTitle>Feature flags</CardTitle>
          <CardDescription>
            Read-only view of resolved feature flags for this deployment.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {featureFlagsQuery.isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Loading feature flags...
            </div>
          ) : featureFlagsQuery.isError ? (
            <p className="text-destructive">Failed to load feature flags.</p>
          ) : !featureFlagsQuery.data ||
            featureFlagsQuery.data.flags.length === 0 ? (
            <p className="text-muted-foreground">No feature flags configured.</p>
          ) : (
            <ul className="divide-y divide-border">
              {featureFlagsQuery.data.flags.map((flag) => (
                <li
                  key={flag.key}
                  className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{flag.key}</span>
                    <Badge variant={(flag.enabled ?? flag.value) ? "default" : "secondary"}>
                      {(flag.enabled ?? flag.value) ? "enabled" : "disabled"}
                    </Badge>
                  </div>
                  <span className="text-muted-foreground">{flag.source}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            Rechecks, registrations, and configuration events recorded for
            this deployment, newest first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {auditQuery.isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Loading activity...
            </div>
          ) : auditQuery.isError ? (
            <p className="text-destructive">Failed to load audit log.</p>
          ) : !auditQuery.data || auditQuery.data.entries.length === 0 ? (
            <p className="text-muted-foreground">No activity recorded yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {auditQuery.data.entries.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">
                      {describeAuditAction(entry.action)}
                    </Badge>
                    {entry.targetLabel && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {entry.targetLabel}
                      </span>
                    )}
                    {entry.actorLogin && (
                      <span className="text-muted-foreground">
                        by @{entry.actorLogin}
                      </span>
                    )}
                  </div>
                  <span className="text-muted-foreground">
                    {formatRelativeTime(entry.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
