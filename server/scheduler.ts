/**
 * Per-(store, operation) scheduled admission across replicas through the
 * `scheduled_sync_state` table.
 */

export interface ScheduledSyncPool {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rowCount: number | null; rows: unknown[] }>;
}

export type ScheduledAttemptOutcome = "success" | "error" | "skipped";

/**
 * Claims a due scheduled attempt. The conditional upsert is atomic across
 * replicas: the first caller inserts or updates the row and receives it back;
 * every other caller hits the conflict and fails the WHERE guard, so the
 * statement returns no rows.
 *
 * The retry anchor is the later of `started_at` and `last_success_at`, so a
 * failed or still-running attempt is spaced from its claim while a successful
 * one is spaced from its completion. A crashed run becomes claimable again
 * after the interval.
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
WHERE GREATEST(
    COALESCE(state.started_at, 'epoch'::timestamptz),
    COALESCE(state.last_success_at, 'epoch'::timestamptz)
  )
    <= now() - make_interval(secs => $4::double precision)
  AND ${RECENT_SUCCESS_GATE}
RETURNING store_id, operation, attempt_token
`.trim();

/**
 * Records the terminal outcome of an attempt. The attempt-token guard makes
 * the update a no-op when a newer attempt already claimed the slot, which also
 * prevents duplicate alerts from a stale attempt. `skipped` records a neutral
 * outcome: a child that refused to start because another real run holds the
 * per-(store, operation) advisory lock. It never refreshes `last_success_at`,
 * so the retry stays anchored at the claim time, and it must not alert.
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
