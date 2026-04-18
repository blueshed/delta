-- =========================================================================
-- Delta-doc: version tracking, collection loading, delta_open
-- =========================================================================

-- ---------------------------------------------------------------------------
-- _delta_bump_and_notify: bump version, log ops, fire NOTIFY — one place
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_bump_and_notify(p_doc TEXT, p_ops JSONB)
RETURNS BIGINT AS $$
DECLARE v_version BIGINT;
BEGIN
  INSERT INTO _delta_versions (doc_name, version) VALUES (p_doc, 1)
    ON CONFLICT (doc_name) DO UPDATE SET version = _delta_versions.version + 1
    RETURNING version INTO v_version;

  INSERT INTO _delta_ops_log (doc_name, version, ops)
    VALUES (p_doc, v_version, p_ops);

  PERFORM pg_notify('delta_changes',
    json_build_object('doc', p_doc, 'v', v_version)::text
  );

  RETURN v_version;
END;
$$ LANGUAGE plpgsql;

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
        'SELECT COALESCE(jsonb_object_agg(t.id, _delta_strip_temporal(to_jsonb(t))), ''{}''::jsonb) FROM %I t WHERE %s',
        v_source, v_where
      ) INTO v_result;
    ELSE
      EXECUTE format(
        'SELECT COALESCE(jsonb_object_agg(t.id, to_jsonb(t)), ''{}''::jsonb) FROM %I t',
        v_source
      ) INTO v_result;
    END IF;
    RETURN v_result;
  END IF;

  -- Direct child of root
  IF v_coll.parent_collection = p_root_collection THEN
    IF v_strip THEN
      EXECUTE format(
        'SELECT COALESCE(jsonb_object_agg(t.id, _delta_strip_temporal(to_jsonb(t))), ''{}''::jsonb) FROM %I t WHERE t.%I = $1 AND %s',
        v_source, v_coll.parent_fk, v_where
      ) INTO v_result USING p_root_id;
    ELSE
      EXECUTE format(
        'SELECT COALESCE(jsonb_object_agg(t.id, to_jsonb(t)), ''{}''::jsonb) FROM %I t WHERE t.%I = $1',
        v_source, v_coll.parent_fk
      ) INTO v_result USING p_root_id;
    END IF;
    RETURN v_result;
  END IF;

  -- Grandchild+: load parent rows recursively, then filter by their IDs
  v_parent_map := _delta_load_collection(
    v_coll.parent_collection, p_root_collection, p_root_id, p_at
  );
  SELECT array_agg(k::BIGINT) INTO v_parent_ids
    FROM jsonb_object_keys(v_parent_map) AS k;

  IF v_parent_ids IS NULL THEN RETURN '{}'::jsonb; END IF;

  IF v_strip THEN
    EXECUTE format(
      'SELECT COALESCE(jsonb_object_agg(t.id, _delta_strip_temporal(to_jsonb(t))), ''{}''::jsonb) FROM %I t WHERE t.%I = ANY($1) AND %s',
      v_source, v_coll.parent_fk, v_where
    ) INTO v_result USING v_parent_ids;
  ELSE
    EXECUTE format(
      'SELECT COALESCE(jsonb_object_agg(t.id, to_jsonb(t)), ''{}''::jsonb) FROM %I t WHERE t.%I = ANY($1)',
      v_source, v_coll.parent_fk
    ) INTO v_result USING v_parent_ids;
  END IF;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- delta_open: load a doc from relational tables, return JSONB + version
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION delta_open(p_doc_name TEXT)
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
  v_root_map  JSONB;
  v_result    JSONB;
  v_coll_key  TEXT;
  v_version   BIGINT;
BEGIN
  v_def := _delta_find_doc(p_doc_name);
  IF v_def.prefix IS NULL THEN RETURN NULL; END IF;

  v_resolved := _delta_resolve_scope(v_def, p_doc_name);
  v_where    := v_resolved->>'where';
  v_mode     := v_resolved->>'mode';
  IF v_resolved->>'at' IS NOT NULL THEN
    v_at := (v_resolved->>'at')::TIMESTAMPTZ;
  END IF;

  SELECT * INTO v_root_coll FROM _delta_collections
   WHERE collection_key = v_def.root_collection;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_view := _delta_source_view(v_root_coll.table_name, v_root_coll.temporal);

  IF v_mode = 'list' THEN
    -- List mode: return all matching rows as a map
    IF v_root_coll.temporal THEN
      EXECUTE format(
        'SELECT COALESCE(jsonb_object_agg(t.id, _delta_strip_temporal(to_jsonb(t))), ''{}''::jsonb) FROM %I t WHERE %s',
        v_view, v_where
      ) INTO v_root_map;
    ELSE
      EXECUTE format(
        'SELECT COALESCE(jsonb_object_agg(t.id, to_jsonb(t)), ''{}''::jsonb) FROM %I t WHERE %s',
        v_view, v_where
      ) INTO v_root_map;
    END IF;

    v_result := jsonb_build_object(v_def.root_collection, v_root_map);

  ELSE
    -- Single mode: one root row + included collections
    v_doc_id := (v_resolved->'values'->>'id')::BIGINT;

    EXECUTE format('SELECT to_jsonb(t) FROM %I t WHERE t.id = $1', v_view)
      INTO v_root_row USING v_doc_id;

    IF v_root_row IS NULL THEN RETURN NULL; END IF;

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

  -- Track version
  INSERT INTO _delta_versions (doc_name, version) VALUES (p_doc_name, 0)
    ON CONFLICT (doc_name) DO NOTHING;
  SELECT version INTO v_version FROM _delta_versions WHERE doc_name = p_doc_name;

  RETURN v_result || jsonb_build_object('_version', v_version);
END;
$$ LANGUAGE plpgsql;
