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

-- _delta_fetch_log: the listener's catch-up -- delta_fetch_ops' rows, each with
-- the write it carries for the custom documents (`applied`, 001a).
CREATE OR REPLACE FUNCTION _delta_fetch_log(p_doc_name TEXT, p_since BIGINT)
RETURNS TABLE(version BIGINT, ops JSONB, applied JSONB) AS $$
  SELECT l.version, l.ops, l.applied
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
  IF v_def.prefix IS NULL THEN
    RAISE EXCEPTION 'no doc def for: %', p_doc_name
      USING ERRCODE = 'P0001';
  END IF;

  v_resolved := _delta_resolve_scope(v_def, p_doc_name);
  v_mode     := v_resolved->>'mode';

  SELECT * INTO v_root_coll FROM _delta_collections
   WHERE collection_key = v_def.root_collection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'doc "%" references unknown root collection: %',
      p_doc_name, v_def.root_collection
      USING ERRCODE = 'P0001';
  END IF;

  -- List mode (todo #74): as delta_open reads a list, at p_at -- each row as it shows (todo #70).
  IF v_mode = 'list' THEN RETURN _delta_show_doc(v_def, _delta_read_list(v_def, v_resolved->>'where', p_at), FALSE); END IF;

  v_doc_id := (v_resolved->'values'->>'id')::BIGINT;

  -- the root as it stood, where it met the whole of its name's scope then
  -- (a column beside its id), as delta_open reads it now
  IF v_root_coll.temporal THEN
    EXECUTE format(
      'SELECT to_jsonb(t.*) FROM %I t WHERE t.id = $1 AND %s AND %s',
      v_root_coll.table_name, _delta_temporal_where(p_at), v_resolved->>'where'
    ) INTO v_root_row USING v_doc_id;
    v_root_row := _delta_strip_temporal(v_root_row);
  ELSE
    EXECUTE format('SELECT to_jsonb(t.*) FROM %I t WHERE t.id = $1 AND %s', v_root_coll.table_name, v_resolved->>'where')
      INTO v_root_row USING v_doc_id;
  END IF;

  v_root_row := _delta_declared(v_def.root_collection, v_root_row);
  IF v_root_row IS NULL THEN RETURN NULL; END IF;

  v_result := jsonb_build_object(v_def.root_collection, v_root_row);

  FOREACH v_coll_key IN ARRAY v_def.include
  LOOP
    v_result := v_result || jsonb_build_object(
      v_coll_key,
      _delta_load_collection(v_coll_key, v_def.root_collection, v_doc_id, p_at)
    );
  END LOOP;

  RETURN _delta_show_doc(v_def, v_result, TRUE);
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- delta_prune_ops: clean up old log entries -- and the names nobody holds
-- open (todo #73): the rows of listeners that are gone, and the version of a
-- name no listener holds, with nothing left of it in the log or the ledger.
-- Opened again, it starts a fresh copy at 0. The table lock keeps an open from
-- holding a name between the question and the delete. Answers the log
-- entries cleared.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION delta_prune_ops(p_keep INTERVAL DEFAULT '1 hour')
RETURNS BIGINT AS $$
DECLARE v_count BIGINT;
BEGIN
  DELETE FROM _delta_ops_log WHERE created_at < NOW() - p_keep;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  LOCK TABLE _delta_held IN SHARE ROW EXCLUSIVE MODE;
  PERFORM _delta_clear_dead_holders();
  DELETE FROM _delta_versions v
   WHERE NOT EXISTS (SELECT 1 FROM _delta_held h WHERE h.doc_name = v.doc_name)
     AND NOT EXISTS (SELECT 1 FROM _delta_ops_log l WHERE l.doc_name = v.doc_name)
     AND NOT EXISTS (SELECT 1 FROM _delta_ledger g WHERE g.doc_name = v.doc_name);
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
