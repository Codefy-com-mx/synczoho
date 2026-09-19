CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL UNIQUE,
  store_name text,
  access_token text NOT NULL,
  user_email text,
  user_id uuid,
  status text NOT NULL DEFAULT 'active',
  suspended boolean NOT NULL DEFAULT false,
  suspended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL,
  tiendanube_product_id bigint NOT NULL,
  name jsonb,
  handle jsonb,
  categories jsonb,
  images jsonb,
  published boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, tiendanube_product_id)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb,
  processed boolean DEFAULT false,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zoho_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL UNIQUE,
  organization_id text,
  organization_name text,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  token_expires_at timestamptz NOT NULL,
  scope text,
  dc text NOT NULL DEFAULT 'com',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_sync_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL,
  zoho_item_id text NOT NULL,
  zoho_sku text,
  zoho_name text,
  tiendanube_product_id bigint,
  status text NOT NULL DEFAULT 'pending',
  last_synced_at timestamptz,
  last_error text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, zoho_item_id)
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL,
  operation text NOT NULL,
  zoho_item_id text,
  tiendanube_product_id bigint,
  status text NOT NULL,
  message text,
  duration_ms integer,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL UNIQUE,
  orders_enabled boolean NOT NULL DEFAULT true,
  orders_create_as_draft boolean NOT NULL DEFAULT true,
  orders_auto_confirm boolean NOT NULL DEFAULT false,
  orders_generate_invoice_on_paid boolean NOT NULL DEFAULT false,
  orders_only_paid boolean NOT NULL DEFAULT false,
  stock_enabled boolean NOT NULL DEFAULT false,
  stock_direction text NOT NULL DEFAULT 'zoho_to_tn',
  stock_priority text NOT NULL DEFAULT 'zoho',
  stock_warehouse_id text,
  customers_auto_sync_on_order boolean NOT NULL DEFAULT true,
  alert_on_error boolean NOT NULL DEFAULT false,
  alert_email text,
  prices_enabled boolean NOT NULL DEFAULT false,
  stock_schedule text NOT NULL DEFAULT 'disabled',
  prices_schedule text NOT NULL DEFAULT 'disabled',
  products_publish_on_import boolean NOT NULL DEFAULT false,
  products_overwrite_existing boolean NOT NULL DEFAULT true,
  products_match_strategy text NOT NULL DEFAULT 'sku',
  products_sync_fields jsonb NOT NULL DEFAULT '{"name":true,"sku":true,"description":true,"price":true,"stock":true,"images":false,"category":false,"weight":false,"dimensions":false,"barcode":false,"brand":false,"tax":false}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_settings_stock_schedule_check CHECK (stock_schedule IN ('disabled', 'hourly', 'every6h', 'daily')),
  CONSTRAINT sync_settings_prices_schedule_check CHECK (prices_schedule IN ('disabled', 'hourly', 'every6h', 'daily'))
);

CREATE TABLE IF NOT EXISTS order_sync_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL,
  tiendanube_order_id bigint NOT NULL,
  zoho_salesorder_id text,
  zoho_invoice_id text,
  status text NOT NULL DEFAULT 'pending',
  last_error text,
  last_synced_at timestamptz,
  payload jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, tiendanube_order_id)
);

CREATE TABLE IF NOT EXISTS customer_sync_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL,
  tiendanube_customer_id bigint,
  email text,
  zoho_contact_id text,
  status text NOT NULL DEFAULT 'pending',
  last_error text,
  last_synced_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, tiendanube_customer_id),
  UNIQUE (store_id, email)
);

CREATE TABLE IF NOT EXISTS stock_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL,
  sku text NOT NULL,
  zoho_item_id text,
  tiendanube_product_id bigint,
  tiendanube_variant_id bigint,
  last_qty integer,
  last_source text,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, sku)
);

CREATE TABLE IF NOT EXISTS category_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL,
  zoho_category text NOT NULL,
  tn_category_id bigint NOT NULL,
  tn_category_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, zoho_category)
);

CREATE INDEX IF NOT EXISTS idx_stores_status ON stores(status);
CREATE INDEX IF NOT EXISTS idx_product_sync_map_store ON product_sync_map(store_id);
CREATE INDEX IF NOT EXISTS idx_product_sync_map_sku ON product_sync_map(store_id, zoho_sku);
CREATE INDEX IF NOT EXISTS idx_product_sync_map_status ON product_sync_map(store_id, status);
CREATE INDEX IF NOT EXISTS idx_sync_logs_store_created ON sync_logs(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_sync_map_store ON order_sync_map(store_id, status);
CREATE INDEX IF NOT EXISTS idx_customer_sync_map_email ON customer_sync_map(store_id, email);
CREATE INDEX IF NOT EXISTS idx_stock_sync_state_store_sku ON stock_sync_state(store_id, sku);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'stores', 'products', 'zoho_connections', 'product_sync_map', 'sync_settings',
    'order_sync_map', 'customer_sync_map', 'stock_sync_state', 'category_mappings'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'update_' || table_name || '_updated_at'
        AND tgrelid = table_name::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
        'update_' || table_name || '_updated_at', table_name
      );
    END IF;
  END LOOP;
END $$;
