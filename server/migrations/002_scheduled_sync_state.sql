-- SCHED-1: durable scheduled admission for stock/price syncs.
--
-- One row per (store_id, operation) anchors scheduled attempts so a claim is
-- atomic across replicas and a failed, partial, or still-running attempt is
-- retried only after the configured interval (hourly/every6h/daily), never on
-- the next 15-minute tick. `started_at` is the retry anchor; `attempt_token`
-- guards the terminal update so a superseded attempt cannot overwrite it. The
-- FK cascades from stores so uninstall/disconnect removes the state row.
--
-- No backfill and no new index are created here. `server/migrate.ts` runs
-- migrations inside a transaction on startup, so a full `sync_logs` scan or an
-- index build could block production writes and boot. First-deployment cadence
-- is preserved by the claim's recent-success gate, which is bounded by
-- `store_id` plus the `created_at` time window and uses the existing
-- `idx_sync_logs_store_created (store_id, created_at DESC)` index. The
-- operation/status filter is a residual scan cost that is acceptable at
-- typical scale; any future composite index must be created through a safe
-- operational procedure outside this transactional startup migration.
CREATE TABLE IF NOT EXISTS scheduled_sync_state (
  store_id text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  operation text NOT NULL,
  attempt_token text,
  status text NOT NULL DEFAULT 'idle',
  started_at timestamptz,
  finished_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, operation),
  CONSTRAINT scheduled_sync_state_status_check CHECK (status IN ('idle', 'running', 'success', 'error'))
);
