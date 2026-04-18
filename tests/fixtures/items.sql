-- =========================================================================
-- Minimal test schema — a single flat `items` collection.
-- Used by tests/postgres.test.ts to exercise delta_open / delta_apply
-- without requiring a consumer domain.
-- =========================================================================

CREATE SEQUENCE IF NOT EXISTS seq_items;

CREATE TABLE IF NOT EXISTS items (
  id    BIGINT  NOT NULL DEFAULT nextval('seq_items'),
  name  TEXT    NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);

-- Register the collection with the delta framework.
INSERT INTO _delta_collections (collection_key, table_name, columns_def, temporal)
VALUES (
  'items',
  'items',
  '{"name":{"type":"text"},"value":{"type":"integer","default":0}}'::jsonb,
  FALSE
)
ON CONFLICT (collection_key) DO UPDATE SET
  table_name  = EXCLUDED.table_name,
  columns_def = EXCLUDED.columns_def,
  temporal    = EXCLUDED.temporal;

-- Register the 'items:' doc as a singleton list over the items collection.
INSERT INTO _delta_docs (prefix, root_collection, include, scope)
VALUES (
  'items:',
  'items',
  ARRAY[]::text[],
  '{}'::jsonb
)
ON CONFLICT (prefix) DO UPDATE SET
  root_collection = EXCLUDED.root_collection,
  include         = EXCLUDED.include,
  scope           = EXCLUDED.scope;
