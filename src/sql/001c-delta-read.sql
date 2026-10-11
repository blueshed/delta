-- =========================================================================
-- Delta-doc: version tracking, collection loading, delta_open
-- =========================================================================

-- ---------------------------------------------------------------------------
-- _delta_bump_and_notify: bump version, log ops, fire NOTIFY — one place.
-- `p_applied` is the write as applied, for custom documents (the log's
-- `applied`, 001a); the two-argument form logs none, and is heard as told.
-- Nothing to tell anyone (no ops, none applied): no version, as on SQLite --
-- the version it is at.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_bump_and_notify(p_doc TEXT, p_ops JSONB, p_applied JSONB)
RETURNS BIGINT AS $$
DECLARE v_version BIGINT;
BEGIN
  IF jsonb_array_length(p_ops) = 0 AND COALESCE(jsonb_array_length(p_applied), 0) = 0 THEN
    SELECT version INTO v_version FROM _delta_versions WHERE doc_name = p_doc;
    RETURN COALESCE(v_version, 0);
  END IF;

  INSERT INTO _delta_versions (doc_name, version) VALUES (p_doc, 1)
    ON CONFLICT (doc_name) DO UPDATE SET version = _delta_versions.version + 1
    RETURNING version INTO v_version;

  INSERT INTO _delta_ops_log (doc_name, version, ops, applied)
    VALUES (p_doc, v_version, p_ops, p_applied);

  PERFORM pg_notify('delta_changes',
    json_build_object('doc', p_doc, 'v', v_version)::text
  );

  RETURN v_version;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION _delta_bump_and_notify(p_doc TEXT, p_ops JSONB)
RETURNS BIGINT LANGUAGE sql AS $$ SELECT _delta_bump_and_notify(p_doc, p_ops, NULL); $$;

-- ---------------------------------------------------------------------------
-- _delta_load_collection: recursively load a collection's rows as a JSONB map.
-- When p_at is NULL, loads current state. When set, loads at that point in time.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_load_collection(
  p_collection_key TEXT,
  p_root_collection TEXT,
  p_root_id BIGINT,
  p_at TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_coll       RECORD;
  v_source     TEXT;
  v_strip      BOOLEAN;
  v_where      TEXT;
  v_result     JSONB;
  v_parent_map JSONB;
  v_parent_ids BIGINT[];
BEGIN
  SELECT * INTO v_coll FROM _delta_collections
   WHERE collection_key = p_collection_key;
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;

  v_source := _delta_source_view(v_coll.table_name, v_coll.temporal, p_at);
  v_strip  := v_coll.temporal;
  v_where  := CASE WHEN v_coll.temporal AND p_at IS NOT NULL
                   THEN _delta_temporal_where(p_at)
                   ELSE 'TRUE' END;

  -- No parent
  IF v_coll.parent_collection IS NULL THEN
    IF v_strip THEN
      EXECUTE format(
        'SELECT COALESCE(jsonb_object_agg(t.id, _delta_strip_temporal(to_jsonb(t.*))), ''{}''::jsonb) FROM %I t WHERE %s',
        v_source, v_where
      ) INTO v_result;
    ELSE
      EXECUTE format(
        'SELECT COALESCE(jsonb_object_agg(t.id, to_jsonb(t.*)), ''{}''::jsonb) FROM %I t',
        v_source
      ) INTO v_result;
    END IF;
    RETURN v_result;
  END IF;

  -- Direct child of root
  IF v_coll.parent_collection = p_root_collection THEN
    IF v_strip THEN
      EXECUTE format(
        'SELECT COALESCE(jsonb_object_agg(t.id, _delta_strip_temporal(to_jsonb(t.*))), ''{}''::jsonb) FROM %I t WHERE t.%I = $1 AND %s',
        v_source, v_coll.parent_fk, v_where
      ) INTO v_result USING p_root_id;
    ELSE
      EXECUTE format(
        'SELECT COALESCE(jsonb_object_agg(t.id, to_jsonb(t.*)), ''{}''::jsonb) FROM %I t WHERE t.%I = $1',
        v_source, v_coll.parent_fk
      ) INTO v_result USING p_root_id;
    END IF;
    RETURN v_result;
  END IF;

  -- Grandchild+: load parent rows recursively, then filter by their IDs. The
  -- parent is walked whether or not the document includes it; one with no
  -- parent of its own ends the chain short of the root, so nothing under it is
  -- in the document -- as _delta_chain_root and _delta_row_in_scope judge it,
  -- and the SQLite backend reads it (todo #32).
  IF NOT EXISTS (SELECT 1 FROM _delta_collections
                  WHERE collection_key = v_coll.parent_collection
                    AND parent_collection IS NOT NULL) THEN
    RETURN '{}'::jsonb;
  END IF;
  v_parent_map := _delta_load_collection(
    v_coll.parent_collection, p_root_collection, p_root_id, p_at
  );
  SELECT array_agg(k::BIGINT) INTO v_parent_ids
    FROM jsonb_object_keys(v_parent_map) AS k;

  IF v_parent_ids IS NULL THEN RETURN '{}'::jsonb; END IF;

  IF v_strip THEN
    EXECUTE format(
      'SELECT COALESCE(jsonb_object_agg(t.id, _delta_strip_temporal(to_jsonb(t.*))), ''{}''::jsonb) FROM %I t WHERE t.%I = ANY($1) AND %s',
      v_source, v_coll.parent_fk, v_where
    ) INTO v_result USING v_parent_ids;
  ELSE
    EXECUTE format(
      'SELECT COALESCE(jsonb_object_agg(t.id, to_jsonb(t.*)), ''{}''::jsonb) FROM %I t WHERE t.%I = ANY($1)',
      v_source, v_coll.parent_fk
    ) INTO v_result USING v_parent_ids;
  END IF;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- _delta_load_collection_all: load every row of a collection as a JSONB map.
-- Used by list-mode docs' `include` traversal (no FK filter — list mode has
-- no single root id to filter against, so "include" means "load it all").
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_load_collection_all(
  p_collection_key TEXT,
  p_at TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_coll   RECORD;
  v_source TEXT;
  v_result JSONB;
BEGIN
  SELECT * INTO v_coll FROM _delta_collections
   WHERE collection_key = p_collection_key;
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;

  v_source := _delta_source_view(v_coll.table_name, v_coll.temporal, p_at);

  IF v_coll.temporal THEN
    EXECUTE format(
      'SELECT COALESCE(jsonb_object_agg(t.id, _delta_strip_temporal(to_jsonb(t.*))), ''{}''::jsonb) FROM %I t WHERE %s',
      v_source,
      CASE WHEN p_at IS NOT NULL THEN _delta_temporal_where(p_at) ELSE 'TRUE' END
    ) INTO v_result;
  ELSE
    EXECUTE format(
      'SELECT COALESCE(jsonb_object_agg(t.id, to_jsonb(t.*)), ''{}''::jsonb) FROM %I t',
      v_source
    ) INTO v_result;
  END IF;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- Implied documents (todo #34): there before their root row is, as on SQLite.
--
-- _delta_implied_root: the root row an implied document opens with, and its
-- first write makes -- its id, and each column's default (or null where it
-- may be null; else "", 0 or false by its type).
-- _delta_make_implied: make it, in the write's own transaction, unless it is
-- there or the write adds it itself (an undo of its removal).
-- _delta_open_held: the document as a walk guards it -- an implied one whose
-- root row is not there holds no root.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_implied_root(p_def _delta_docs, p_id BIGINT)
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id', p_id) || COALESCE((
    SELECT jsonb_object_agg(k, CASE
             WHEN COALESCE(d->'default', 'null'::jsonb) <> 'null'::jsonb THEN d->'default'
             WHEN (d->>'nullable')::boolean THEN 'null'::jsonb
             WHEN d->>'type' = 'text' THEN '""'::jsonb
             WHEN d->>'type' IN ('integer', 'real') THEN '0'::jsonb
             WHEN d->>'type' = 'boolean' THEN 'false'::jsonb
             ELSE 'null'::jsonb END)
      FROM _delta_collections c, jsonb_each(c.columns_def) AS x(k, d)
     WHERE c.collection_key = p_def.root_collection), '{}'::jsonb);
$$;

CREATE OR REPLACE FUNCTION _delta_make_implied(p_def _delta_docs, p_id BIGINT, p_ops JSONB, p_ts TIMESTAMPTZ)
RETURNS void AS $$
DECLARE
  v_coll   RECORD;
  v_exists BOOLEAN;
  v_row    JSONB;
BEGIN
  IF NOT COALESCE(p_def.implied, FALSE) OR p_id IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_ops) o
              WHERE o->>'op' = 'add' AND o->>'path' ~ '^/[^/]*/[^/]*$'
                AND (_delta_split_path(o->>'path'))[1] = p_def.root_collection) THEN
    RETURN;
  END IF;
  SELECT * INTO v_coll FROM _delta_collections WHERE collection_key = p_def.root_collection;
  IF NOT FOUND THEN RETURN; END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1)', _delta_source_view(v_coll.table_name, v_coll.temporal))
    INTO v_exists USING p_id;
  IF v_exists THEN RETURN; END IF;
  v_row := _delta_implied_root(p_def, p_id);
  IF v_coll.temporal THEN v_row := v_row || jsonb_build_object('valid_from', p_ts, 'valid_to', NULL); END IF;
  EXECUTE format('INSERT INTO %I SELECT * FROM jsonb_populate_record(null::%I, $1)', v_coll.table_name, v_coll.table_name)
    USING v_row;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION _delta_open_held(p_doc_name TEXT)
RETURNS JSONB AS $$
DECLARE
  v_doc    JSONB := COALESCE(_delta_open(p_doc_name, TRUE), '{}'::jsonb);
  v_def    _delta_docs := _delta_find_doc(p_doc_name);
  v_scope  JSONB;
  v_coll   RECORD;
  v_exists BOOLEAN;
BEGIN
  IF NOT COALESCE(v_def.implied, FALSE) THEN RETURN v_doc; END IF;
  v_scope := _delta_resolve_scope(v_def, p_doc_name);
  IF (v_scope->>'mode') <> 'single' THEN RETURN v_doc; END IF;
  SELECT * INTO v_coll FROM _delta_collections WHERE collection_key = v_def.root_collection;
  IF NOT FOUND THEN RETURN v_doc; END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1)', _delta_source_view(v_coll.table_name, v_coll.temporal))
    INTO v_exists USING (v_scope->'values'->>'id')::BIGINT;
  IF v_exists THEN RETURN v_doc; END IF;
  RETURN v_doc || jsonb_build_object(v_def.root_collection, 'null'::jsonb);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- _delta_read_list: a list document -- the root rows `p_where` admits, and
-- each included collection in full (list mode has no single root id to filter
-- against, so "include" means "load it all") -- as they stand (p_at NULL), or
-- a temporal table's as they stood at p_at. delta_open's and delta_open_at's.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_read_list(p_def _delta_docs, p_where TEXT, p_at TIMESTAMPTZ)
RETURNS JSONB AS $$
DECLARE
  v_root     RECORD;
  v_rows     JSONB;
  v_result   JSONB;
  v_coll_key TEXT;
BEGIN
  SELECT * INTO v_root FROM _delta_collections WHERE collection_key = p_def.root_collection;
  EXECUTE format(
    'SELECT COALESCE(jsonb_object_agg(t.id, %s), ''{}''::jsonb) FROM %I t WHERE %s AND %s',
    CASE WHEN v_root.temporal THEN '_delta_strip_temporal(to_jsonb(t.*))' ELSE 'to_jsonb(t.*)' END,
    _delta_source_view(v_root.table_name, v_root.temporal, p_at),
    CASE WHEN v_root.temporal AND p_at IS NOT NULL THEN _delta_temporal_where(p_at) ELSE 'TRUE' END,
    p_where
  ) INTO v_rows;
  v_result := jsonb_build_object(p_def.root_collection, v_rows);
  FOREACH v_coll_key IN ARRAY p_def.include
  LOOP
    v_result := v_result || jsonb_build_object(v_coll_key, _delta_load_collection_all(v_coll_key, p_at));
  END LOOP;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- _delta_show: a row of `p_coll` as a document shows it -- where it names that
-- collection's columns (`held`, todo #70), those, the row's id and its parent
-- key; else whole. _delta_show_doc: each row of a document so (`p_single`: its
-- root is one row, not a map). showRow / showDoc in schema.ts.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_show(p_def _delta_docs, p_coll TEXT, p_row JSONB)
RETURNS JSONB AS $$
  SELECT CASE WHEN NOT COALESCE(p_def.held, '{}'::jsonb) ? p_coll OR jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN p_row
    ELSE (SELECT COALESCE(jsonb_object_agg(f, v), '{}'::jsonb) FROM jsonb_each(p_row) AS e(f, v)
           WHERE f = 'id' OR (p_def.held->p_coll) ? f
              OR f = (SELECT parent_fk FROM _delta_collections WHERE collection_key = p_coll)) END;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION _delta_show_doc(p_def _delta_docs, p_doc JSONB, p_single BOOLEAN)
RETURNS JSONB AS $$
DECLARE
  v_out  JSONB := p_doc;
  v_coll TEXT;
BEGIN
  FOR v_coll IN SELECT jsonb_object_keys(COALESCE(p_def.held, '{}'::jsonb)) LOOP
    CONTINUE WHEN jsonb_typeof(p_doc->v_coll) IS DISTINCT FROM 'object';
    v_out := v_out || jsonb_build_object(v_coll, CASE WHEN p_single AND v_coll = p_def.root_collection THEN _delta_show(p_def, v_coll, p_doc->v_coll)
      ELSE (SELECT COALESCE(jsonb_object_agg(id, _delta_show(p_def, v_coll, r)), '{}'::jsonb) FROM jsonb_each(p_doc->v_coll) AS e(id, r)) END);
  END LOOP;
  RETURN v_out;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- delta_open: load a doc from relational tables, return JSONB + version -- its
-- rows as it shows them (_delta_show_doc). _delta_open(name, TRUE) reads them
-- whole: what the ledger's inverse and a walk's guard read.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_open(p_doc_name TEXT, p_whole BOOLEAN)
RETURNS JSONB AS $$
DECLARE
  v_def       _delta_docs;
  v_resolved  JSONB;
  v_where     TEXT;
  v_mode      TEXT;
  v_at        TIMESTAMPTZ;
  v_doc_id    BIGINT;
  v_root_coll RECORD;
  v_view      TEXT;
  v_root_row  JSONB;
  v_result    JSONB;
  v_coll_key  TEXT;
  v_version   BIGINT;
BEGIN
  v_def := _delta_find_doc(p_doc_name);
  IF v_def.prefix IS NULL THEN
    -- Fail-fast: caller asked for a doc whose prefix isn't registered.
    -- NULL-as-config-error used to mask typos and missing migrations.
    RAISE EXCEPTION 'no doc def for: %', p_doc_name
      USING ERRCODE = 'P0001';
  END IF;

  v_resolved := _delta_resolve_scope(v_def, p_doc_name);
  v_where    := v_resolved->>'where';
  v_mode     := v_resolved->>'mode';
  IF v_resolved->>'at' IS NOT NULL THEN
    v_at := (v_resolved->>'at')::TIMESTAMPTZ;
  END IF;

  SELECT * INTO v_root_coll FROM _delta_collections
   WHERE collection_key = v_def.root_collection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'doc "%" references unknown root collection: %',
      p_doc_name, v_def.root_collection
      USING ERRCODE = 'P0001';
  END IF;

  -- A time in the name (`at:`): the whole document as it stood then, its root
  -- as its included collections, as SQLite reads it.
  v_view := _delta_source_view(v_root_coll.table_name, v_root_coll.temporal, v_at);
  IF v_root_coll.temporal AND v_at IS NOT NULL THEN
    v_where := v_where || ' AND ' || _delta_temporal_where(v_at);
  END IF;

  IF v_mode = 'list' THEN
    v_result := _delta_read_list(v_def, v_resolved->>'where', v_at);
  ELSE
    -- Single mode: one root row + included collections
    v_doc_id := (v_resolved->'values'->>'id')::BIGINT;

    -- the row its name names, where it meets the rest of the name's scope too
    -- (fo-guest:<id>:<email>: that id with that email), as SQLite reads it
    EXECUTE format('SELECT to_jsonb(t.*) FROM %I t WHERE t.id = $1 AND %s', v_view, v_where)
      INTO v_root_row USING v_doc_id;

    IF v_root_row IS NULL AND NOT COALESCE(v_def.implied, FALSE) THEN RETURN NULL; END IF;

    IF v_root_row IS NULL THEN
      -- Implied: there before its root row is -- the root its first write will
      -- make, each included collection empty, as on SQLite. No row is made.
      v_result := jsonb_build_object(v_def.root_collection, _delta_implied_root(v_def, v_doc_id));
      FOREACH v_coll_key IN ARRAY v_def.include
      LOOP
        v_result := v_result || jsonb_build_object(v_coll_key, '{}'::jsonb);
      END LOOP;
    ELSE
      IF v_root_coll.temporal THEN
        v_root_row := _delta_strip_temporal(v_root_row);
      END IF;

      v_result := jsonb_build_object(v_def.root_collection, v_root_row);

      FOREACH v_coll_key IN ARRAY v_def.include
      LOOP
        v_result := v_result || jsonb_build_object(
          v_coll_key,
          _delta_load_collection(v_coll_key, v_def.root_collection, v_doc_id, v_at)
        );
      END LOOP;
    END IF;
  END IF;

  -- Track version
  INSERT INTO _delta_versions (doc_name, version) VALUES (p_doc_name, 0)
    ON CONFLICT (doc_name) DO NOTHING;
  SELECT version INTO v_version FROM _delta_versions WHERE doc_name = p_doc_name;

  IF NOT p_whole THEN v_result := _delta_show_doc(v_def, v_result, v_mode <> 'list'); END IF;
  RETURN v_result || jsonb_build_object('_version', v_version);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION delta_open(p_doc_name TEXT)
RETURNS JSONB LANGUAGE sql AS $$ SELECT _delta_open(p_doc_name, FALSE); $$;

-- ---------------------------------------------------------------------------
-- The documents open now (_delta_held, todo #73): each listener holds the
-- names it has subscribers for, so a write's fan-out asks only those.
-- ---------------------------------------------------------------------------

-- _delta_clear_dead_holders: clear the names of listeners that are gone --
-- those whose connection no longer holds their lock (_delta_holder_start).
CREATE OR REPLACE FUNCTION _delta_clear_dead_holders() RETURNS void LANGUAGE sql AS $$
  DELETE FROM _delta_held WHERE holder IN (
    SELECT holder FROM _delta_held
    EXCEPT
    SELECT objid::bigint::integer FROM pg_locks
     WHERE locktype = 'advisory' AND granted AND objsubid = 2
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid = hashtext('_delta_held')::oid);
$$;

-- _delta_holder_start: a listener starts, on the connection it keeps, as a new
-- holder (`p_holder` NULL) or again after its connection was lost. It takes
-- its lock, clears the names of listeners that are gone, and answers its id.
-- Coming back, the listener asks which of its names are still held: one
-- cleared while it was away may have missed a write.
DROP FUNCTION IF EXISTS _delta_holder_start(INTEGER);   -- its first form answered `kept` too
DROP FUNCTION IF EXISTS _delta_holder_live(INTEGER);
CREATE OR REPLACE FUNCTION _delta_holder_start(p_holder INTEGER) RETURNS INTEGER AS $$
DECLARE v_holder INTEGER := COALESCE(p_holder, nextval('_delta_holder_ids')::INTEGER);
BEGIN
  PERFORM pg_advisory_lock_shared(hashtext('_delta_held'), v_holder);   -- shared: a lost connection may not have ended yet
  PERFORM _delta_clear_dead_holders();
  RETURN v_holder;
END;
$$ LANGUAGE plpgsql;

-- _delta_holder_stop: a listener lets go of every name it holds, and its lock.
CREATE OR REPLACE FUNCTION _delta_holder_stop(p_holder INTEGER) RETURNS void AS $$
BEGIN
  DELETE FROM _delta_held WHERE holder = p_holder;
  PERFORM pg_advisory_unlock_shared(hashtext('_delta_held'), p_holder);
END;
$$ LANGUAGE plpgsql;

-- _delta_hold: listener `p_holder` has `p_doc` open, from before it reads it.
-- It waits for the writes running now that may tell a document of the name's
-- prefix (each holds that prefix's lock, _delta_holders): they asked who holds
-- what without this name, so the read that follows must see what they wrote.
-- A write that asks after this commits sees the name.
CREATE OR REPLACE FUNCTION _delta_hold(p_holder INTEGER, p_doc TEXT) RETURNS void AS $$
BEGIN
  INSERT INTO _delta_held (doc_name, holder) VALUES (p_doc, p_holder) ON CONFLICT DO NOTHING;
  PERFORM pg_advisory_xact_lock(hashtext('_delta_hold'), hashtext(COALESCE((_delta_find_doc(p_doc)).prefix, '')));
END;
$$ LANGUAGE plpgsql;

-- _delta_let_go: listener `p_holder` has `p_doc` open no longer.
CREATE OR REPLACE FUNCTION _delta_let_go(p_holder INTEGER, p_doc TEXT) RETURNS void
LANGUAGE sql AS $$ DELETE FROM _delta_held WHERE doc_name = p_doc AND holder = p_holder; $$;
