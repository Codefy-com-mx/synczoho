-- Homologación Tiendanube: caché de catálogo, mapeo de locations (MultiCD)
-- y dirección de sincronización de precios.
CREATE TABLE IF NOT EXISTS tn_variants (
  store_id text NOT NULL,
  product_id bigint NOT NULL,
  variant_id bigint NOT NULL,
  sku text,
  price numeric,
  promotional_price numeric,
  inventory_levels jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, variant_id)
);

CREATE TABLE IF NOT EXISTS tn_categories (
  store_id text NOT NULL,
  id bigint NOT NULL,
  name jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, id)
);

CREATE TABLE IF NOT EXISTS location_mappings (
  store_id text NOT NULL,
  tn_location_id text NOT NULL,
  tn_location_name text,
  zoho_location_id text,
  zoho_location_name text,
  PRIMARY KEY (store_id, tn_location_id)
);

CREATE INDEX IF NOT EXISTS idx_tn_variants_store_sku ON tn_variants(store_id, sku);
CREATE INDEX IF NOT EXISTS idx_tn_variants_store_product ON tn_variants(store_id, product_id);

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS catalog_status text NOT NULL DEFAULT 'pending'
    CHECK (catalog_status IN ('pending', 'ready', 'stale')),
  ADD COLUMN IF NOT EXISTS catalog_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS scopes text;

ALTER TABLE sync_settings
  ADD COLUMN IF NOT EXISTS prices_direction text NOT NULL DEFAULT 'zoho_to_tn'
    CHECK (prices_direction IN ('zoho_to_tn', 'tn_to_zoho'));
