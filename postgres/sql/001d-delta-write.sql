-- =========================================================================
-- Delta-doc: cascade removal, delta_apply
-- =========================================================================

-- ---------------------------------------------------------------------------
-- _delta_cascade_remove: remove a row + cascade to children & referencedBy
-- Returns the array of broadcast ops generated.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_cascade_remove(
  p_collection_key TEXT,
  p_id             BIGINT,
  p_include        TEXT[]
) RETURNS JSONB AS $$
DECLARE
  v_coll      RECORD;
  v_view      TEXT;
  v_child     RECORD;
  v_child_row RECORD;
  v_ref       RECORD;
  v_ref_row   RECORD;
  v_ops       JSONB := '[]'::jsonb;
BEGIN
  SELECT * INTO v_coll FROM _delta_collections
   WHERE collection_key = p_collection_key;
  IF NOT FOUND THEN RETURN v_ops; END IF;

  -- Close or delete the row itself
  IF v_coll.temporal THEN
    EXECUTE format(
      'UPDATE %I SET valid_to = NOW() WHERE id = $1 AND valid_to IS NULL',
      v_coll.table_name
    ) USING p_id;
  ELSE
    EXECUTE format('DELETE FROM %I WHERE id = $1', v_coll.table_name)
      USING p_id;
  END IF;

  v_ops := v_ops || jsonb_build_array(
    jsonb_build_object('op', 'remove', 'path', _delta_build_path(p_collection_key, p_id::text))
  );

  -- Cascade via parent relationship (children of this collection)
  FOR v_child IN
    SELECT * FROM _delta_collections
     WHERE parent_collection = p_collection_key
       AND collection_key = ANY(p_include)
  LOOP
    v_view := _delta_source_view(v_child.table_name, v_child.temporal);

    FOR v_child_row IN
      EXECUTE format('SELECT id FROM %I WHERE %I = $1', v_view, v_child.parent_fk)
        USING p_id
    LOOP
      v_ops := v_ops || _delta_cascade_remove(v_child.collection_key, v_child_row.id, p_include);
    END LOOP;
  END LOOP;

  -- Cascade via cascadeOn (referencedBy)
  -- Find collections whose cascade_on references this collection
  FOR v_ref IN
    SELECT c.collection_key, c.table_name, c.temporal,
           elem->>'fk' AS fk_column
      FROM _delta_collections c,
           jsonb_array_elements(c.cascade_on) AS elem
     WHERE elem->>'collection' = p_collection_key
       AND c.collection_key = ANY(p_include)
  LOOP
    v_view := _delta_source_view(v_ref.table_name, v_ref.temporal);

    FOR v_ref_row IN
      EXECUTE format('SELECT id FROM %I WHERE %I = $1', v_view, v_ref.fk_column)
        USING p_id
    LOOP
      v_ops := v_ops || _delta_cascade_remove(v_ref.collection_key, v_ref_row.id, p_include);
    END LOOP;
  END LOOP;

  RETURN v_ops;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- delta_apply: apply delta ops to relational tables, bump version, NOTIFY
--
-- Handles:
--   replace /<root>/field        → temporal update on root row
--   add     /<collection>/<id>   → insert new row
--   remove  /<collection>/<id>   → temporal close + cascades
--   replace /<collection>/<id>/f → temporal update on collection row field
--
-- Returns {version, ops} where ops are the broadcast ops.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION delta_apply(p_doc_name TEXT, p_ops JSONB)
RETURNS JSONB AS $$
DECLARE
  v_def           _delta_docs;
  v_scope         JSONB;
  v_is_list       BOOLEAN;
  v_doc_id        BIGINT;
  v_root_coll     RECORD;
  v_op            JSONB;
  v_parts         TEXT[];
  v_coll_key      TEXT;
  v_coll          RECORD;
  v_view          TEXT;
  v_id            BIGINT;
  v_id_text       TEXT;
  v_field         TEXT;
  v_row           JSONB;
  v_new_row       JSONB;
  v_ts            TIMESTAMPTZ := NOW();
  v_version       BIGINT;
  v_broadcast_ops JSONB := '[]'::jsonb;
BEGIN
  -- Guard: ops must be a JSON array
  IF p_ops IS NULL OR jsonb_typeof(p_ops) != 'array' THEN
    RAISE EXCEPTION 'ops must be a JSON array';
  END IF;

  v_def := _delta_find_doc(p_doc_name);
  IF v_def.prefix IS NULL THEN
    RAISE EXCEPTION 'no doc def for: %', p_doc_name;
  END IF;

  v_scope   := _delta_resolve_scope(v_def, p_doc_name);
  v_is_list := (v_scope->>'mode') = 'list';
  IF NOT v_is_list THEN
    v_doc_id := (v_scope->'values'->>'id')::BIGINT;
  END IF;

  SELECT * INTO v_root_coll FROM _delta_collections
   WHERE collection_key = v_def.root_collection;

  FOR v_op IN SELECT jsonb_array_elements(p_ops)
  LOOP
    v_parts := _delta_split_path(v_op->>'path');
    v_coll_key := v_parts[1];

    SELECT * INTO v_coll FROM _delta_collections
     WHERE collection_key = v_coll_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown collection: %', v_coll_key;
    END IF;

    v_view := _delta_source_view(v_coll.table_name, v_coll.temporal);

    -- ---------------------------------------------------------------
    -- Root replace:  replace /<root>        (partial row merge)
    --                replace /<root>/field   (single field shorthand)
    -- Single-row docs only.
    -- ---------------------------------------------------------------
    IF NOT v_is_list AND v_coll_key = v_def.root_collection
       AND array_length(v_parts, 1) <= 2 AND v_op->>'op' = 'replace'
       AND (array_length(v_parts, 1) = 1
            OR (array_length(v_parts, 1) = 2 AND v_parts[2] ~ '^\d+$' IS FALSE)) THEN

      -- 2-segment /root/field: wrap into partial row
      IF array_length(v_parts, 1) = 2 THEN
        v_op := jsonb_set(v_op, '{value}', jsonb_build_object(v_parts[2], v_op->'value'));
      END IF;

      -- Read + lock
      IF v_coll.temporal THEN
        EXECUTE format(
          'SELECT to_jsonb(t) FROM %I t WHERE t.id = $1 AND valid_to IS NULL FOR UPDATE',
          v_coll.table_name
        ) INTO v_row USING v_doc_id;
      ELSE
        EXECUTE format(
          'SELECT to_jsonb(t) FROM %I t WHERE t.id = $1 FOR UPDATE',
          v_coll.table_name
        ) INTO v_row USING v_doc_id;
      END IF;

      IF v_row IS NULL THEN
        RAISE EXCEPTION 'root row not found: %', v_def.root_collection;
      END IF;

      -- Merge partial value
      v_new_row := v_row || (v_op->'value');

      IF v_coll.temporal THEN
        EXECUTE format(
          'UPDATE %I SET valid_to = $2 WHERE id = $1 AND valid_to IS NULL',
          v_coll.table_name
        ) USING v_doc_id, v_ts;

        v_new_row := v_new_row || jsonb_build_object('valid_from', v_ts, 'valid_to', NULL);

        EXECUTE format(
          'INSERT INTO %I SELECT * FROM jsonb_populate_record(null::%I, $1)',
          v_coll.table_name, v_coll.table_name
        ) USING v_new_row;

        v_new_row := _delta_strip_temporal(v_new_row);
      ELSE
        EXECUTE format('DELETE FROM %I WHERE id = $1', v_coll.table_name) USING v_doc_id;
        EXECUTE format(
          'INSERT INTO %I SELECT * FROM jsonb_populate_record(null::%I, $1)',
          v_coll.table_name, v_coll.table_name
        ) USING v_new_row;
      END IF;

      v_broadcast_ops := v_broadcast_ops || jsonb_build_array(
        jsonb_build_object('op', 'replace', 'path', _delta_build_path(v_def.root_collection), 'value', v_new_row)
      );
      CONTINUE;
    END IF;

    -- ---------------------------------------------------------------
    -- Add row:  add /<collection>/<id>
    -- ---------------------------------------------------------------
    IF array_length(v_parts, 1) = 2 AND v_op->>'op' = 'add' THEN
      v_id_text := v_parts[2];
      -- Auto-generate ID from sequence if path ends with '-'
      IF v_id_text = '-' THEN
        EXECUTE format('SELECT nextval(%L)', 'seq_' || v_coll.table_name) INTO v_id;
      ELSE
        v_id := v_id_text::BIGINT;
      END IF;
      v_new_row := jsonb_build_object('id', v_id) || (v_op->'value');

      -- Set FK: for list-mode root adds, apply scope equality values;
      -- for child collections in single-mode, set FK to root id. In list-mode
      -- child adds (e.g. a product-catalog doc adding a `parts` row) there is
      -- no doc-id to inject, so we trust the parent_fk supplied in the op value.
      IF v_is_list AND v_coll_key = v_def.root_collection THEN
        v_new_row := v_new_row || (v_scope->'values');
      ELSIF v_coll.parent_collection = v_def.root_collection AND v_coll.parent_fk IS NOT NULL
            AND v_doc_id IS NOT NULL THEN
        v_new_row := v_new_row || jsonb_build_object(v_coll.parent_fk, v_doc_id);
      END IF;

      -- Apply column defaults from metadata
      SELECT v_new_row || COALESCE(jsonb_object_agg(
        col_key,
        CASE col_def->>'type'
          WHEN 'text'    THEN to_jsonb(COALESCE(col_def->>'default', ''))
          WHEN 'integer' THEN COALESCE(col_def->'default', '0'::jsonb)
          WHEN 'real'    THEN COALESCE(col_def->'default', '0'::jsonb)
          WHEN 'boolean' THEN COALESCE(col_def->'default', 'false'::jsonb)
          WHEN 'json'    THEN COALESCE(col_def->'default', 'null'::jsonb)
          ELSE to_jsonb(''::text)
        END
      ), '{}'::jsonb)
      INTO v_new_row
      FROM jsonb_each(v_coll.columns_def) AS x(col_key, col_def)
      WHERE NOT v_new_row ? col_key
        AND NOT COALESCE((col_def->>'nullable')::boolean, false);

      IF v_coll.temporal THEN
        v_new_row := v_new_row || jsonb_build_object('valid_from', v_ts, 'valid_to', NULL);
      END IF;

      EXECUTE format(
        'INSERT INTO %I SELECT * FROM jsonb_populate_record(null::%I, $1)',
        v_coll.table_name, v_coll.table_name
      ) USING v_new_row;

      -- Strip temporal columns from broadcast
      IF v_coll.temporal THEN
        v_new_row := _delta_strip_temporal(v_new_row);
      END IF;

      v_broadcast_ops := v_broadcast_ops || jsonb_build_array(
        jsonb_build_object('op', 'add', 'path', _delta_build_path(v_coll_key, v_id::text), 'value', v_new_row)
      );
      CONTINUE;
    END IF;

    -- ---------------------------------------------------------------
    -- Remove row:  remove /<collection>/<id>  (+ cascades)
    -- ---------------------------------------------------------------
    IF array_length(v_parts, 1) = 2 AND v_op->>'op' = 'remove' THEN
      v_id := v_parts[2]::BIGINT;
      v_broadcast_ops := v_broadcast_ops || _delta_cascade_remove(
        v_coll_key, v_id, v_def.include
      );
      CONTINUE;
    END IF;

    -- ---------------------------------------------------------------
    -- Row replace:  replace /<collection>/<id>        (partial row merge)
    -- Field replace: replace /<collection>/<id>/field (single field shorthand)
    -- ---------------------------------------------------------------
    IF (array_length(v_parts, 1) = 2 OR array_length(v_parts, 1) = 3) AND v_op->>'op' = 'replace' THEN
      v_id := v_parts[2]::BIGINT;

      -- 3-segment: wrap single field into partial row value
      IF array_length(v_parts, 1) = 3 THEN
        v_op := jsonb_set(v_op, '{value}', jsonb_build_object(v_parts[3], v_op->'value'));
      END IF;

      IF v_coll.temporal THEN
        EXECUTE format(
          'SELECT to_jsonb(t) FROM %I t WHERE t.id = $1 AND valid_to IS NULL FOR UPDATE',
          v_coll.table_name
        ) INTO v_row USING v_id;
      ELSE
        EXECUTE format(
          'SELECT to_jsonb(t) FROM %I t WHERE t.id = $1 FOR UPDATE',
          v_coll.table_name
        ) INTO v_row USING v_id;
      END IF;

      IF v_row IS NULL THEN
        RAISE EXCEPTION 'row not found: %/%', v_coll_key, v_id;
      END IF;

      -- Merge partial value into current row
      v_new_row := v_row || (v_op->'value');

      IF v_coll.temporal THEN
        EXECUTE format(
          'UPDATE %I SET valid_to = $2 WHERE id = $1 AND valid_to IS NULL',
          v_coll.table_name
        ) USING v_id, v_ts;

        v_new_row := v_new_row || jsonb_build_object('valid_from', v_ts, 'valid_to', NULL);

        EXECUTE format(
          'INSERT INTO %I SELECT * FROM jsonb_populate_record(null::%I, $1)',
          v_coll.table_name, v_coll.table_name
        ) USING v_new_row;
      ELSE
        -- Non-temporal: UPDATE with merged row
        EXECUTE format(
          'DELETE FROM %I WHERE id = $1', v_coll.table_name
        ) USING v_id;
        EXECUTE format(
          'INSERT INTO %I SELECT * FROM jsonb_populate_record(null::%I, $1)',
          v_coll.table_name, v_coll.table_name
        ) USING v_new_row;
      END IF;

      -- Strip temporal from broadcast
      IF v_coll.temporal THEN
        v_new_row := _delta_strip_temporal(v_new_row);
      END IF;

      -- For single-item docs updating the root entity, broadcast as /collection
      -- so the client replaces the direct object (not a Record entry)
      IF NOT v_is_list AND v_coll_key = v_def.root_collection AND v_id = v_doc_id THEN
        v_broadcast_ops := v_broadcast_ops || jsonb_build_array(
          jsonb_build_object('op', 'replace', 'path', _delta_build_path(v_coll_key), 'value', v_new_row)
        );
      ELSE
        v_broadcast_ops := v_broadcast_ops || jsonb_build_array(
          jsonb_build_object('op', 'replace', 'path', _delta_build_path(v_coll_key, v_id::text), 'value', v_new_row)
        );
      END IF;
      CONTINUE;
    END IF;

    RAISE EXCEPTION 'invalid op: % %', v_op->>'op', v_op->>'path';
  END LOOP;

  v_version := _delta_bump_and_notify(p_doc_name, v_broadcast_ops);
  RETURN jsonb_build_object('version', v_version, 'ops', v_broadcast_ops);
END;
$$ LANGUAGE plpgsql;
