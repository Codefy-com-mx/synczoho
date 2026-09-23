CREATE TABLE IF NOT EXISTS zoho_oauth_states (
  nonce text PRIMARY KEY,
  store_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  phase text NOT NULL DEFAULT 'issued',
  organizations jsonb
);
CREATE INDEX IF NOT EXISTS zoho_oauth_states_expires_at_idx ON zoho_oauth_states (expires_at);
ALTER TABLE zoho_connections ADD COLUMN IF NOT EXISTS oauth_nonce text;

ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS webhook_events_ready_idx
  ON webhook_events (next_attempt_at, created_at) WHERE processed = false;

CREATE TABLE IF NOT EXISTS privacy_requests (
  event_id uuid PRIMARY KEY REFERENCES webhook_events(id) ON DELETE CASCADE,
  store_id text NOT NULL,
  request_type text NOT NULL,
  customer_id bigint,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS privacy_requests_pending_idx ON privacy_requests (created_at) WHERE status = 'pending_manual';
