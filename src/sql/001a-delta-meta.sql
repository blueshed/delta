-- =========================================================================
-- Delta-doc: metadata tables
-- =========================================================================
-- Runtime schema registry populated by TypeScript (createTables / registerDocs).
-- =========================================================================

CREATE TABLE IF NOT EXISTS _delta_collections (
  collection_key   TEXT PRIMARY KEY,
  table_name       TEXT NOT NULL,
  columns_def      JSONB NOT NULL DEFAULT '{}',
  parent_collection TEXT,
  parent_fk        TEXT,
  temporal         BOOLEAN NOT NULL DEFAULT TRUE,
  cascade_on       JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS _delta_docs (
  prefix           TEXT PRIMARY KEY,
  root_collection  TEXT NOT NULL,
  include          TEXT[] NOT NULL DEFAULT '{}',
  scope            JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS _delta_versions (
  doc_name TEXT PRIMARY KEY,
  version  BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS _delta_ops_log (
  id         BIGSERIAL PRIMARY KEY,
  doc_name   TEXT NOT NULL,
  version    BIGINT NOT NULL,
  ops        JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delta_ops_log_fetch
  ON _delta_ops_log (doc_name, version);

-- =========================================================================
-- Pure helpers — composed by every read/write/ops function below
-- =========================================================================

-- Build a JSON-patch-like path.
--   _delta_build_path('sites', '42')  -> '/sites/42'
--   _delta_build_path('venues')       -> '/venues'
CREATE OR REPLACE FUNCTION _delta_build_path(p_collection TEXT, p_id TEXT DEFAULT NULL)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_id IS NULL THEN '/' || p_collection
              ELSE '/' || p_collection || '/' || p_id END;
$$;

-- Split a path into its parts.
--   _delta_split_path('/sites/42')  -> ARRAY['sites','42']
--   _delta_split_path('/venues')    -> ARRAY['venues']
CREATE OR REPLACE FUNCTION _delta_split_path(p_path TEXT)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT string_to_array(ltrim(p_path, '/'), '/');
$$;

-- Pick the source relation for a collection.
--   temporal + no timestamp → current_<table> view
--   temporal + timestamp    → base <table> (caller filters with _delta_temporal_where)
--   non-temporal            → base <table>
CREATE OR REPLACE FUNCTION _delta_source_view(
  p_table_name TEXT, p_temporal BOOLEAN, p_at TIMESTAMPTZ DEFAULT NULL
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_temporal AND p_at IS NULL THEN 'current_' || p_table_name
    ELSE p_table_name
  END;
$$;

-- Temporal WHERE fragment for embedding into format()-built dynamic SQL.
-- Inlines the timestamp as a %L literal so callers don't need extra param binding.
-- Aliases the row with `p_alias` (default `t`).
CREATE OR REPLACE FUNCTION _delta_temporal_where(
  p_at TIMESTAMPTZ, p_alias TEXT DEFAULT 't'
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT format(
    '%s.valid_from <= %L AND (%s.valid_to IS NULL OR %s.valid_to > %L)',
    p_alias, p_at, p_alias, p_alias, p_at
  );
$$;
