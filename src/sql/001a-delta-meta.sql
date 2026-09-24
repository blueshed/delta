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

-- Build an RFC 6901 JSON Pointer, each segment escaped (~ as ~0, / as ~1).
--   _delta_build_path('sites', '42')  -> '/sites/42'
--   _delta_build_path('venues')       -> '/venues'
CREATE OR REPLACE FUNCTION _delta_build_path(p_collection TEXT, p_id TEXT DEFAULT NULL)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT '/' || replace(replace(p_collection, '~', '~0'), '/', '~1')
      || CASE WHEN p_id IS NULL THEN '' ELSE '/' || replace(replace(p_id, '~', '~0'), '/', '~1') END;
$$;

-- Split an RFC 6901 JSON Pointer into its unescaped segments -- the grammar of
-- splitPath in src/core.ts: '' is the whole document, every other path starts
-- with '/', an empty segment is a key, and a '~' not followed by 0 or 1 is an
-- error. SQLSTATE 22023 (invalid_parameter_value) answers 400 on the wire.
--   _delta_split_path('/sites/42')  -> ARRAY['sites','42']
--   _delta_split_path('/a~1b/c~0d') -> ARRAY['a/b','c~d']
--   _delta_split_path('sites')      -> raises
CREATE OR REPLACE FUNCTION _delta_split_path(p_path TEXT)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_path = '' THEN RETURN ARRAY[]::text[]; END IF;
  IF p_path IS NULL OR left(p_path, 1) <> '/' THEN
    RAISE EXCEPTION 'Invalid JSON Pointer "%": a path starts with "/" ("" is the whole document)', p_path
      USING ERRCODE = '22023';
  END IF;
  IF p_path ~ '~([^01]|$)' THEN
    RAISE EXCEPTION 'Invalid JSON Pointer "%": "~" is written "~0" and "/" is written "~1"', p_path
      USING ERRCODE = '22023';
  END IF;
  RETURN ARRAY(
    SELECT replace(replace(seg, '~1', '/'), '~0', '~')
      FROM unnest(regexp_split_to_array(substr(p_path, 2), '/')) WITH ORDINALITY AS t(seg, n)
     ORDER BY n
  );
END;
$$;

-- A row id from a path segment. This backend keeps BIGINT ids it mints from
-- seq_<table>, so anything else is a client error (SQLSTATE 22P02 → 400) that
-- names the fix.
CREATE OR REPLACE FUNCTION _delta_row_id(p_collection TEXT, p_segment TEXT)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_segment IS NULL OR p_segment !~ '^[0-9]{1,18}$' THEN
    RAISE EXCEPTION 'row id "%" in /%/% is not a number: Postgres mints row ids -- add to /%/- and read the id from the echo',
      p_segment, p_collection, p_segment, p_collection
      USING ERRCODE = '22P02';
  END IF;
  RETURN p_segment::bigint;
END;
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
