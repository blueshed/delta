-- =========================================================================
-- Delta-doc: catch-up, time-travel, pruning, snapshots
-- =========================================================================

-- ---------------------------------------------------------------------------
-- delta_fetch_ops: catch-up — get ops since a given version
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION delta_fetch_ops(p_doc_name TEXT, p_since BIGINT)
RETURNS TABLE(version BIGINT, ops JSONB) AS $$
  SELECT l.version, l.ops
    FROM _delta_ops_log l
   WHERE l.doc_name = p_doc_name AND l.version > p_since
   ORDER BY l.version
   LIMIT 1000;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- delta_open_at: time-travel — load a doc as it existed at a point in time
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION delta_open_at(p_doc_name TEXT, p_at TIMESTAMPTZ)
RETURNS JSONB AS $$
DECLARE
  v_def       _delta_docs;
  v_resolved  JSONB;
  v_mode      TEXT;
  v_doc_id    BIGINT;
  v_root_coll RECORD;
  v_root_row  JSONB;
  v_result    JSONB;
  v_coll_key  TEXT;
BEGIN
  v_def := _delta_find_doc(p_doc_name);
  IF v_def.prefix IS NULL THEN RETURN NULL; END IF;

  v_resolved := _delta_resolve_scope(v_def, p_doc_name);
  v_mode     := v_resolved->>'mode';

  -- open_at only supports single-mode docs
  IF v_mode != 'single' THEN RETURN NULL; END IF;

  v_doc_id := (v_resolved->'values'->>'id')::BIGINT;

  SELECT * INTO v_root_coll FROM _delta_collections
   WHERE collection_key = v_def.root_collection;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_root_coll.temporal THEN
    EXECUTE format(
      'SELECT to_jsonb(t) FROM %I t WHERE t.id = $1 AND %s',
      v_root_coll.table_name, _delta_temporal_where(p_at)
    ) INTO v_root_row USING v_doc_id;
    v_root_row := _delta_strip_temporal(v_root_row);
  ELSE
    EXECUTE format('SELECT to_jsonb(t) FROM %I t WHERE t.id = $1', v_root_coll.table_name)
      INTO v_root_row USING v_doc_id;
  END IF;

  IF v_root_row IS NULL THEN RETURN NULL; END IF;

  v_result := jsonb_build_object(v_def.root_collection, v_root_row);

  FOREACH v_coll_key IN ARRAY v_def.include
  LOOP
    v_result := v_result || jsonb_build_object(
      v_coll_key,
      _delta_load_collection(v_coll_key, v_def.root_collection, v_doc_id, p_at)
    );
  END LOOP;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- delta_prune_ops: clean up old log entries
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION delta_prune_ops(p_keep INTERVAL DEFAULT '1 hour')
RETURNS BIGINT AS $$
DECLARE v_count BIGINT;
BEGIN
  DELETE FROM _delta_ops_log WHERE created_at < NOW() - p_keep;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Snapshots
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS _delta_snapshots (
  name       TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION delta_snapshot(p_name TEXT, p_at TIMESTAMPTZ DEFAULT NOW())
RETURNS TIMESTAMPTZ AS $$
BEGIN
  INSERT INTO _delta_snapshots (name, created_at) VALUES (p_name, p_at)
    ON CONFLICT (name) DO UPDATE SET created_at = p_at;
  RETURN p_at;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION delta_resolve_snapshot(p_name TEXT)
RETURNS TIMESTAMPTZ AS $$
  SELECT created_at FROM _delta_snapshots WHERE name = p_name;
$$ LANGUAGE sql STABLE;
