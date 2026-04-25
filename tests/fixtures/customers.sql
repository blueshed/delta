-- =========================================================================
-- Test schema for the Postgres isolation property suite. Multi-tenant
-- customers + brands + artworks (FK chain) so the test can prove that
-- writes to one customer's doc never reach another's subscribers.
-- =========================================================================

CREATE SEQUENCE IF NOT EXISTS seq_customers;
CREATE SEQUENCE IF NOT EXISTS seq_brands;
CREATE SEQUENCE IF NOT EXISTS seq_artworks;

CREATE TABLE IF NOT EXISTS customers (
  id    BIGINT  NOT NULL DEFAULT nextval('seq_customers'),
  name  TEXT    NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS brands (
  id            BIGINT  NOT NULL DEFAULT nextval('seq_brands'),
  customers_id  BIGINT  NOT NULL,
  name          TEXT    NOT NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_brands_customers_id ON brands (customers_id);

CREATE TABLE IF NOT EXISTS artworks (
  id        BIGINT  NOT NULL DEFAULT nextval('seq_artworks'),
  brand_id  BIGINT  NOT NULL,
  title     TEXT    NOT NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_artworks_brand_id ON artworks (brand_id);

INSERT INTO _delta_collections (collection_key, table_name, columns_def, parent_collection, parent_fk, temporal)
VALUES
  ('customers', 'customers',
   '{"name":{"type":"text"}}'::jsonb,
   NULL, NULL, FALSE),
  ('brands', 'brands',
   '{"name":{"type":"text"}}'::jsonb,
   'customers', 'customers_id', FALSE),
  ('artworks', 'artworks',
   '{"title":{"type":"text"}}'::jsonb,
   'brands', 'brand_id', FALSE)
ON CONFLICT (collection_key) DO UPDATE SET
  table_name        = EXCLUDED.table_name,
  columns_def       = EXCLUDED.columns_def,
  parent_collection = EXCLUDED.parent_collection,
  parent_fk         = EXCLUDED.parent_fk,
  temporal          = EXCLUDED.temporal;

INSERT INTO _delta_docs (prefix, root_collection, include, scope)
VALUES (
  'customer:',
  'customers',
  ARRAY['brands','artworks']::text[],
  '{}'::jsonb
)
ON CONFLICT (prefix) DO UPDATE SET
  root_collection = EXCLUDED.root_collection,
  include         = EXCLUDED.include,
  scope           = EXCLUDED.scope;
