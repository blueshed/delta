-- =========================================================================
-- Test schema for the custom-doc (predicate-based membership) suite.
-- One `worlds` parent + `sites` children with lat/lng. The "world:" doc
-- lets us add/update/remove sites; the "sites-in-bbox:" custom doc
-- watches the sites collection and filters by bounding box.
-- =========================================================================

CREATE SEQUENCE IF NOT EXISTS seq_worlds;
CREATE SEQUENCE IF NOT EXISTS seq_sites;

CREATE TABLE IF NOT EXISTS worlds (
  id    BIGINT  NOT NULL DEFAULT nextval('seq_worlds'),
  label TEXT    NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS sites (
  id        BIGINT  NOT NULL DEFAULT nextval('seq_sites'),
  world_id  BIGINT  NOT NULL,
  name      TEXT    NOT NULL,
  lat       REAL    NOT NULL,
  lng       REAL    NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_sites_world_id ON sites (world_id);

-- Collection registration
INSERT INTO _delta_collections (collection_key, table_name, columns_def, parent_collection, parent_fk, temporal)
VALUES
  ('worlds', 'worlds',
   '{"label":{"type":"text"}}'::jsonb,
   NULL, NULL, FALSE),
  ('sites', 'sites',
   '{"name":{"type":"text"},"lat":{"type":"real"},"lng":{"type":"real"}}'::jsonb,
   'worlds', 'world_id', FALSE)
ON CONFLICT (collection_key) DO UPDATE SET
  table_name        = EXCLUDED.table_name,
  columns_def       = EXCLUDED.columns_def,
  parent_collection = EXCLUDED.parent_collection,
  parent_fk         = EXCLUDED.parent_fk,
  temporal          = EXCLUDED.temporal;

-- Doc registration — "world:<id>" exposes the world plus its sites.
INSERT INTO _delta_docs (prefix, root_collection, include, scope)
VALUES (
  'world:',
  'worlds',
  ARRAY['sites']::text[],
  '{}'::jsonb
)
ON CONFLICT (prefix) DO UPDATE SET
  root_collection = EXCLUDED.root_collection,
  include         = EXCLUDED.include,
  scope           = EXCLUDED.scope;
