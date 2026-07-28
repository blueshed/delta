-- =========================================================================
-- Test schema for write-scoping (tests/write-scope.test.ts).
--
-- Three levels, so the parent-FK walk in `_delta_row_in_scope` is exercised
-- past a single hop:
--
--   tenants  (root)
--     └── projects  (direct child — FK injected server-side on add)
--           └── notes  (grandchild — FK arrives from the client on add)
--
-- Two sibling docs of the same prefix (`tenant:1`, `tenant:2`) then stand in
-- for two tenants that must not be able to reach each other's rows.
-- =========================================================================

CREATE SEQUENCE IF NOT EXISTS seq_tenants;
CREATE SEQUENCE IF NOT EXISTS seq_projects;
CREATE SEQUENCE IF NOT EXISTS seq_notes;

CREATE TABLE IF NOT EXISTS tenants (
  id   BIGINT NOT NULL DEFAULT nextval('seq_tenants'),
  name TEXT   NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS projects (
  id        BIGINT NOT NULL DEFAULT nextval('seq_projects'),
  tenant_id BIGINT NOT NULL,
  title     TEXT   NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS notes (
  id         BIGINT NOT NULL DEFAULT nextval('seq_notes'),
  project_id BIGINT NOT NULL,
  body       TEXT   NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_projects_tenant_id ON projects (tenant_id);
CREATE INDEX IF NOT EXISTS idx_notes_project_id   ON notes (project_id);

INSERT INTO _delta_collections
  (collection_key, table_name, columns_def, parent_collection, parent_fk, temporal)
VALUES
  ('tenants',  'tenants',  '{"name":{"type":"text"}}'::jsonb,   NULL,       NULL,         FALSE),
  ('projects', 'projects', '{"title":{"type":"text"}}'::jsonb,  'tenants',  'tenant_id',  FALSE),
  ('notes',    'notes',    '{"body":{"type":"text"}}'::jsonb,   'projects', 'project_id', FALSE)
ON CONFLICT (collection_key) DO UPDATE SET
  table_name        = EXCLUDED.table_name,
  columns_def       = EXCLUDED.columns_def,
  parent_collection = EXCLUDED.parent_collection,
  parent_fk         = EXCLUDED.parent_fk,
  temporal          = EXCLUDED.temporal;

INSERT INTO _delta_docs (prefix, root_collection, include, scope)
VALUES ('tenant:', 'tenants', '{"projects","notes"}', '{}'::jsonb)
ON CONFLICT (prefix) DO UPDATE SET
  root_collection = EXCLUDED.root_collection,
  include         = EXCLUDED.include,
  scope           = EXCLUDED.scope;
