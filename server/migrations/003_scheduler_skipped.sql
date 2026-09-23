-- SCHED-2: allow the neutral `skipped` terminal outcome for scheduled
-- attempts.
--
-- A child that refuses to start because another real run already holds the
-- per-(store, operation) advisory lock is neither a success nor a failure. It
-- must not refresh `last_success_at` and must not raise an alert. `started_at`
-- stays the retry anchor, so the next attempt is still gated by the
-- configured interval.
--
-- Migration 002 is intentionally left untouched; this migration only widens
-- the status check constraint, so applying it is safe on any database where
-- 002 already ran.
ALTER TABLE scheduled_sync_state
  DROP CONSTRAINT IF EXISTS scheduled_sync_state_status_check;

ALTER TABLE scheduled_sync_state
  ADD CONSTRAINT scheduled_sync_state_status_check
  CHECK (status IN ('idle', 'running', 'success', 'error', 'skipped'));
