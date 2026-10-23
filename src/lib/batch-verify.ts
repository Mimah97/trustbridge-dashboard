/**
 * Batch verification utilities for dashboard.
 * Enables efficient bulk verification of contributor readiness.
 */

export interface VerificationCheckResult {
  username: string;
  stellar_address: string;
  status: 'ready' | 'low_reserve' | 'not_ready' | 'error';
  error_message?: string;
  checks: {
    funded: boolean;
    trustline: boolean;
    reserve: boolean;
  };
  xlm_balance?: string;
  last_checked?: Date;
}

export interface BatchVerificationOptions {
  /**
   * Maximum concurrent verification requests
   */
  concurrency?: number;
  /**
   * Timeout per verification in milliseconds
   */
  timeout?: number;
  /**
   * Whether to skip already verified accounts
   */
  skipVerified?: boolean;
  /**
   * Minimum XLM reserve requirement
   */
  minXlmReserve?: number;
}

/**
 * Serializable snapshot of batch-verify progress.
 *
 * Persisted so that SSE clients reconnecting mid-job can resume from the
 * last known state instead of resetting progress to zero.
 */
export interface BatchVerificationProgress {
  /** Stable identifier for the batch job. */
  jobId: string;
  /** Total number of verifications in the job. */
  total: number;
  /** Number of verifications completed so far. */
  completed: number;
  /** Results collected so far (in completion order). */
  results: VerificationCheckResult[];
  /** Whether the job has finished (successfully or with errors). */
  done: boolean;
  /** ISO timestamp of the last progress update. */
  updatedAt: string;
}

/**
 * Execute multiple verification checks with concurrency control.
 */
export async function batchVerify(
  verifications: Array<{
    username: string;
    stellar_address: string;
  }>,
  verifyFn: (address: string) => Promise<VerificationCheckResult>,
  options: BatchVerificationOptions = {},
): Promise<VerificationCheckResult[]> {
  const { concurrency = 5, timeout = 10_000 } = options;

  const results: VerificationCheckResult[] = [];
  const queue = [...verifications];

  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      try {
        const timeoutPromise = new Promise<VerificationCheckResult>((_, reject) =>
          setTimeout(() => reject(new Error('Verification timeout')), timeout),
        );

        const result = await Promise.race([
          verifyFn(item.stellar_address),
          timeoutPromise,
        ]);

        results.push(result);
      } catch (error) {
        results.push({
          username: item.username,
          stellar_address: item.stellar_address,
          status: 'error',
          error_message: error instanceof Error ? error.message : 'Unknown error',
          checks: {
            funded: false,
            trustline: false,
            reserve: false,
          },
        });
      }
    }
  };

  // Run workers concurrently
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return results;
}

/**
 * Create an initial progress snapshot for a batch-verify job.
 */
export function createBatchProgress(
  jobId: string,
  total: number,
): BatchVerificationProgress {
  return {
    jobId,
    total,
    completed: 0,
    results: [],
    done: false,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Record a completed verification into a progress snapshot.
 *
 * Returns a new snapshot (does not mutate the input) so callers can safely
 * persist and broadcast it to reconnecting SSE clients.
 */
export function recordBatchProgress(
  progress: BatchVerificationProgress,
  result: VerificationCheckResult,
): BatchVerificationProgress {
  const results = [...progress.results, result];
  const completed = results.length;
  return {
    ...progress,
    results,
    completed,
    done: completed >= progress.total,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Mark a progress snapshot as finished.
 */
export function finalizeBatchProgress(
  progress: BatchVerificationProgress,
): BatchVerificationProgress {
  return {
    ...progress,
    done: true,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Validate a persisted progress snapshot (e.g. loaded from storage after a
 * reconnect). Returns a clear, stable error for malformed input.
 */
export function parseBatchProgress(raw: unknown): BatchVerificationProgress {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid batch progress: expected an object');
  }

  const candidate = raw as Partial<BatchVerificationProgress>;

  if (typeof candidate.jobId !== 'string' || candidate.jobId.length === 0) {
    throw new Error('Invalid batch progress: missing jobId');
  }
  if (typeof candidate.total !== 'number' || candidate.total < 0) {
    throw new Error('Invalid batch progress: invalid total');
  }
  if (!Array.isArray(candidate.results)) {
    throw new Error('Invalid batch progress: missing results');
  }

  const results = candidate.results as VerificationCheckResult[];
  const completed =
    typeof candidate.completed === 'number' ? candidate.completed : results.length;

  return {
    jobId: candidate.jobId,
    total: candidate.total,
    completed,
    results,
    done: candidate.done === true || completed >= candidate.total,
    updatedAt:
      typeof candidate.updatedAt === 'string'
        ? candidate.updatedAt
        : new Date().toISOString(),
  };
}

/**
 * Calculate summary statistics for batch verification results.
 */
export function calculateVerificationSummary(results: VerificationCheckResult[]) {
  const total = results.length;
  const ready = results.filter((r) => r.status === 'ready').length;
  const lowReserve = results.filter((r) => r.status === 'low_reserve').length;
  const notReady = results.filter((r) => r.status === 'not_ready').length;
  const errors = results.filter((r) => r.status === 'error').length;

  return {
    total,
    ready,
    lowReserve,
    notReady,
    errors,
    readyPercentage: total > 0 ? Math.round((ready / total) * 100) : 0,
    succeededPercentage: total > 0 ? Math.round(((total - errors) / total) * 100) : 0,
  };
}

/**
 * Filter verification results by status.
 */
export function filterByStatus(
  results: VerificationCheckResult[],
  status: VerificationCheckResult['status'],
): VerificationCheckResult[] {
  return results.filter((r) => r.status === status);
}

/**
 * Sort verification results by readiness.
 */
export function sortByReadiness(
  results: VerificationCheckResult[],
): VerificationCheckResult[] {
  const order: Record<VerificationCheckResult['status'], number> = {
    ready: 0,
    low_reserve: 1,
    not_ready: 2,
    error: 3,
  };

  return [...results].sort((a, b) => order[a.status] - order[b.status]);
}

/**
 * Export verification results as CSV-compatible array of objects.
 */
export function exportAsCSV(
  results: VerificationCheckResult[],
): Array<Record<string, unknown>> {
  return results.map((r) => ({
    username: r.username,
    stellar_address: r.stellar_address,
    status: r.status,
    funded: r.checks.funded,
    trustline: r.checks.trustline,
    reserve: r.checks.reserve,
    xlm_balance: r.xlm_balance || 'N/A',
    last_checked: r.last_checked?.toISOString() || 'N/A',
    error: r.error_message || '',
  }));
}
