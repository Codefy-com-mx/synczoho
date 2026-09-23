/**
 * Shared single-flight helpers for the scheduled stock/price syncs.
 *
 * `createTickGuard` keeps one Node process from starting a new scheduler tick
 * while the previous one is still running. `claimScheduledRun` and
 * `finishScheduledRun` make the per-(store, operation) admission decision
 * atomic across replicas through the `scheduled_sync_state` table.
 */

export interface ScheduledSyncPool {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rowCount: number | null; rows: unknown[] }>;
}

export type ScheduledAttemptOutcome = "success" | "error";

/**
 * Claims a due scheduled attempt. The conditional upsert is atomic across
 * replicas: the first caller inserts or updates the row and receives it back;
 * every other caller hits the conflict and fails the WHERE guard, so the
 * statement returns no rows.
 *
 * The retry anchor is `started_at`, falling back to the `last_success_at`
 * recorded by the last successful attempt, so a failed, partial, or
 * still-running attempt is not retried until its configured interval has
 * elapsed. A crash leaves the row marked `running`; the slot becomes
 * claimable again after the interval.
 *
 * The claim is also gated on recent successful `sync_logs` rows for the same
 * store and operation, so a successful manual run postpones the next
 * scheduled run until the configured interval. This matches the original
 * success-anchored cadence and preserves first-deployment behavior without a
 * data backfill. Only `status = 'success'` rows of the exact operation count;
 * failed or unrelated rows never block a claim. The predicate is bounded by
 * `store_id` plus the `created_at` time window, so the existing
 * `idx_sync_logs_store_created (store_id, created_at DESC)` index is
 * sufficient at typical scale; the operation/status filter is a residual
 * scan cost. Any future composite index must be created through a safe
 * operational procedure outside the transactional startup migration.
 */
const RECENT_SUCCESS_GATE = `NOT EXISTS (
  SELECT 1
  FROM sync_logs
  WHERE sync_logs.store_id = $1
    AND sync_logs.operation = $2
    AND sync_logs.status = 'success'
    AND sync_logs.created_at > now() - make_interval(secs => $4::double precision)
)`;

export const CLAIM_SCHEDULED_RUN_SQL = `
INSERT INTO scheduled_sync_state AS state
  (store_id, operation, attempt_token, status, started_at, finished_at, last_error, updated_at)
SELECT $1, $2, $3, 'running', now(), NULL, NULL, now()
WHERE ${RECENT_SUCCESS_GATE}
ON CONFLICT (store_id, operation) DO UPDATE SET
  attempt_token = EXCLUDED.attempt_token,
  status = 'running',
  started_at = now(),
  finished_at = NULL,
  last_error = NULL,
  updated_at = now()
WHERE COALESCE(state.started_at, state.last_success_at, 'epoch'::timestamptz)
    <= now() - make_interval(secs => $4::double precision)
  AND ${RECENT_SUCCESS_GATE}
RETURNING store_id, operation, attempt_token
`.trim();

/**
 * Records the terminal outcome of an attempt. The attempt-token guard makes
 * the update a no-op when a newer attempt already claimed the slot, which also
 * prevents duplicate alerts from a stale attempt.
 */
export const FINISH_SCHEDULED_RUN_SQL = `
UPDATE scheduled_sync_state
SET status = $4,
    finished_at = now(),
    last_success_at = CASE WHEN $4 = 'success' THEN now() ELSE last_success_at END,
    last_error = $5,
    updated_at = now()
WHERE store_id = $1 AND operation = $2 AND attempt_token = $3
RETURNING store_id
`.trim();

export interface ClaimScheduledRunOptions {
  storeId: string;
  operation: string;
  intervalMs: number;
  attemptToken: string;
}

export async function claimScheduledRun(
  pool: ScheduledSyncPool,
  options: ClaimScheduledRunOptions,
): Promise<boolean> {
  const result = await pool.query(CLAIM_SCHEDULED_RUN_SQL, [
    options.storeId,
    options.operation,
    options.attemptToken,
    options.intervalMs / 1000,
  ]);
  return result.rows.length > 0;
}

export interface FinishScheduledRunOptions {
  storeId: string;
  operation: string;
  attemptToken: string;
  outcome: ScheduledAttemptOutcome;
  errorMessage?: string | null;
}

export async function finishScheduledRun(
  pool: ScheduledSyncPool,
  options: FinishScheduledRunOptions,
): Promise<boolean> {
  const result = await pool.query(FINISH_SCHEDULED_RUN_SQL, [
    options.storeId,
    options.operation,
    options.attemptToken,
    options.outcome,
    options.errorMessage ?? null,
  ]);
  return (result.rowCount ?? result.rows.length) > 0;
}

/**
 * Wraps the scheduler entry point so a tick that is still running blocks the
 * next one instead of overlapping it. A hanging child keeps the guard busy;
 * no cancellation or timeout is applied here (SCHED-2 owns child protection).
 */
export function createTickGuard(
  run: () => Promise<void>,
  onSkip?: () => void,
): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) {
      onSkip?.();
      return;
    }
    inFlight = true;
    try {
      await run();
    } finally {
      inFlight = false;
    }
  };
}
