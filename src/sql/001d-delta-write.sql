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
  v_affected  BIGINT;
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

  -- Only claim a removal that actually happened. The row may already be closed,
  -- or an RLS policy may have silently filtered the UPDATE/DELETE to zero rows —
  -- in which case emitting the op would tell every subscriber to drop a row that
  -- is still in the table, and cascading from it would compound the lie.
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN RETURN v_ops; END IF;

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
-- _delta_cascade_rows: the rows _delta_cascade_remove would take, read before
-- it takes them, in the order it emits their removes -- so who holds each can
-- be asked while every row of every chain is still there.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_cascade_rows(
  p_collection_key TEXT,
  p_id             BIGINT,
  p_include        TEXT[]
) RETURNS JSONB AS $$
DECLARE
  v_coll  RECORD;
  v_view  TEXT;
  v_row   JSONB;
  v_child RECORD;
  v_ref   RECORD;
  v_id    BIGINT;
  v_rows  JSONB := '[]'::jsonb;
BEGIN
  SELECT * INTO v_coll FROM _delta_collections WHERE collection_key = p_collection_key;
  IF NOT FOUND THEN RETURN v_rows; END IF;
  v_view := _delta_source_view(v_coll.table_name, v_coll.temporal);
  EXECUTE format('SELECT to_jsonb(t) FROM %I t WHERE t.id = $1', v_view) INTO v_row USING p_id;
  IF v_row IS NULL THEN RETURN v_rows; END IF;
  v_rows := jsonb_build_array(jsonb_build_object('coll', p_collection_key, 'id', p_id, 'row', _delta_strip_temporal(v_row)));

  FOR v_child IN
    SELECT * FROM _delta_collections
     WHERE parent_collection = p_collection_key AND collection_key = ANY(p_include)
  LOOP
    FOR v_id IN EXECUTE format('SELECT id FROM %I WHERE %I = $1', _delta_source_view(v_child.table_name, v_child.temporal), v_child.parent_fk) USING p_id
    LOOP
      v_rows := v_rows || _delta_cascade_rows(v_child.collection_key, v_id, p_include);
    END LOOP;
  END LOOP;

  FOR v_ref IN
    SELECT c.collection_key, c.table_name, c.temporal, elem->>'fk' AS fk_column
      FROM _delta_collections c, jsonb_array_elements(c.cascade_on) AS elem
     WHERE elem->>'collection' = p_collection_key AND c.collection_key = ANY(p_include)
  LOOP
    FOR v_id IN EXECUTE format('SELECT id FROM %I WHERE %I = $1', _delta_source_view(v_ref.table_name, v_ref.temporal), v_ref.fk_column) USING p_id
    LOOP
      v_rows := v_rows || _delta_cascade_rows(v_ref.collection_key, v_id, p_include);
    END LOOP;
  END LOOP;

  RETURN v_rows;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- _delta_tell: tell every document that holds a row a write changed what
-- changed for it (todo #28), and answer the writer's new version.
--
-- `p_touched` is the write's rows in order, each {coll, id, before, after}:
-- `before` the documents that held it before the write (_delta_holders, asked
-- then), `after` the row as it now is (null when it is gone). For each
-- document that held it before or holds it now: a row that arrives is an add,
-- one that stays a replace, one that leaves a remove -- and where the row is
-- the document's root, a replace of the root (null when it leaves). The
-- writer's document is always told, and told first; each other document is
-- told only what concerns it, with a version of its own, one per write.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_tell(p_writer TEXT, p_touched JSONB)
RETURNS BIGINT AS $$
DECLARE
  v_rows    JSONB := '[]'::jsonb;
  v_t       JSONB;
  v_after   JSONB;
  v_targets TEXT[] := ARRAY[]::text[];
  v_target  TEXT;
  v_def     _delta_docs;
  v_single  BOOLEAN;
  v_told    JSONB;
  v_was     BOOLEAN;
  v_is      BOOLEAN;
  v_root    BOOLEAN;
  v_path    TEXT;
  v_version BIGINT;
BEGIN
  -- who holds each row now, and every document concerned
  FOR v_t IN SELECT jsonb_array_elements(p_touched) LOOP
    v_after := CASE WHEN jsonb_typeof(v_t->'after') = 'object' THEN v_t->'after' END;
    v_t := v_t || jsonb_build_object('holders', to_jsonb(_delta_holders(v_t->>'coll', v_after, p_writer)));
    v_rows := v_rows || jsonb_build_array(v_t);
    v_targets := v_targets
      || ARRAY(SELECT jsonb_array_elements_text(v_t->'before'))
      || ARRAY(SELECT jsonb_array_elements_text(v_t->'holders'));
  END LOOP;

  FOR v_target IN
    SELECT p_writer
    UNION ALL
    SELECT DISTINCT t FROM unnest(v_targets) AS t WHERE t IS DISTINCT FROM p_writer
  LOOP
    v_def := _delta_find_doc(v_target);
    CONTINUE WHEN v_def.prefix IS NULL;
    v_single := (_delta_resolve_scope(v_def, v_target)->>'mode') = 'single';
    v_told := '[]'::jsonb;
    FOR v_t IN SELECT jsonb_array_elements(v_rows) LOOP
      v_was := (v_t->'before') ? v_target;
      v_is  := (v_t->'holders') ? v_target;
      CONTINUE WHEN NOT v_was AND NOT v_is;
      v_root := v_single AND (v_t->>'coll') = v_def.root_collection;
      v_path := CASE WHEN v_root THEN _delta_build_path(v_t->>'coll') ELSE _delta_build_path(v_t->>'coll', v_t->>'id') END;
      IF v_is THEN
        v_told := v_told || jsonb_build_array(jsonb_build_object(
          'op', CASE WHEN v_was OR v_root THEN 'replace' ELSE 'add' END, 'path', v_path, 'value', v_t->'after'));
      ELSIF v_root THEN
        v_told := v_told || jsonb_build_array(jsonb_build_object('op', 'replace', 'path', v_path, 'value', 'null'::jsonb));
      ELSE
        v_told := v_told || jsonb_build_array(jsonb_build_object('op', 'remove', 'path', v_path));
      END IF;
    END LOOP;
    IF v_target = p_writer THEN
      v_version := _delta_bump_and_notify(p_writer, v_told);
    ELSIF jsonb_array_length(v_told) > 0 THEN
      PERFORM _delta_bump_and_notify(v_target, v_told);
    END IF;
  END LOOP;
  RETURN v_version;
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
  v_exists        BOOLEAN;
  v_missing       TEXT;
  v_ts            TIMESTAMPTZ := NOW();
  v_version       BIGINT;
  v_broadcast_ops JSONB := '[]'::jsonb;
  -- the rows this write changes, in order, for _delta_tell: {coll, id, before, after}
  v_touched       JSONB := '[]'::jsonb;
  v_before        TEXT[];
  v_befores       JSONB;
  v_removed       JSONB;
  v_r             JSONB;
  v_rp            TEXT[];
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
      RAISE EXCEPTION 'unknown collection: %', v_coll_key USING ERRCODE = '22023';
    END IF;

    -- Scope guard: an op may only target the doc's root or an included
    -- collection. Defence-in-depth — a client that opened doc A must not write
    -- to an unrelated collection through it. (The TS validateOps enforces the
    -- same pre-flight, but this guards every path into delta_apply, including
    -- SQL-side composition via delta_apply_as.)
    IF v_coll_key IS DISTINCT FROM v_def.root_collection
       AND NOT (v_coll_key = ANY(COALESCE(v_def.include, ARRAY[]::text[]))) THEN
      RAISE EXCEPTION
        'op collection "%" is not part of doc "%" (root: %, include: %)',
        v_coll_key, v_def.prefix, v_def.root_collection, v_def.include
        USING ERRCODE = '22023';
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
      PERFORM _delta_assert_fields(v_coll_key, v_coll.columns_def, v_coll.parent_fk, v_op->'value');

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
        RAISE EXCEPTION 'root row not found: %', v_def.root_collection USING ERRCODE = 'P0002';
      END IF;
      v_before := _delta_holders(v_coll_key, _delta_strip_temporal(v_row), p_doc_name);

      -- Merge partial value
      v_new_row := v_row || (v_op->'value');

      IF v_coll.temporal THEN
        EXECUTE format(
          'UPDATE %I SET valid_to = $2 WHERE id = $1 AND valid_to IS NULL',
          v_coll.table_name
        ) USING v_doc_id, v_ts;

        v_new_row := v_new_row || jsonb_build_object('valid_from', v_ts, 'valid_to', NULL);

        EXECUTE format(
          'INSERT INTO %I AS t SELECT * FROM jsonb_populate_record(null::%I, $1) RETURNING to_jsonb(t)',
          v_coll.table_name, v_coll.table_name
        ) INTO v_new_row USING v_new_row;

        v_new_row := _delta_strip_temporal(v_new_row);
      ELSE
        EXECUTE format('DELETE FROM %I WHERE id = $1', v_coll.table_name) USING v_doc_id;
        EXECUTE format(
          'INSERT INTO %I AS t SELECT * FROM jsonb_populate_record(null::%I, $1) RETURNING to_jsonb(t)',
          v_coll.table_name, v_coll.table_name
        ) INTO v_new_row USING v_new_row;
      END IF;

      v_broadcast_ops := v_broadcast_ops || jsonb_build_array(
        jsonb_build_object('op', 'replace', 'path', _delta_build_path(v_def.root_collection), 'value', v_new_row)
      );
      v_touched := v_touched || jsonb_build_array(jsonb_build_object(
        'coll', v_coll_key, 'id', v_doc_id, 'before', to_jsonb(v_before), 'after', v_new_row));
      CONTINUE;
    END IF;

    -- ---------------------------------------------------------------
    -- Add row:  add /<collection>/<id>
    -- ---------------------------------------------------------------
    IF array_length(v_parts, 1) = 2 AND v_op->>'op' = 'add' THEN
      PERFORM _delta_assert_fields(v_coll_key, v_coll.columns_def, v_coll.parent_fk, v_op->'value');
      v_id_text := v_parts[2];
      -- Auto-generate ID from sequence if path ends with '-'
      IF v_id_text = '-' THEN
        EXECUTE format('SELECT nextval(%L)', 'seq_' || v_coll.table_name) INTO v_id;
      ELSE
        v_id := _delta_row_id(v_coll_key, v_id_text);
        -- An add names a new row. A temporal key is (id, valid_from), so an add
        -- of a live id would insert a second live version of it: refuse it
        -- (SQLSTATE 23505, 409 on the wire), as a plain table's key does.
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1)', v_view) INTO v_exists USING v_id;
        IF v_exists THEN
          RAISE EXCEPTION 'row already exists: % -- replace it, or add to % for a new id',
            _delta_build_path(v_coll_key, v_id::text), _delta_build_path(v_coll_key, '-')
            USING ERRCODE = '23505';
        END IF;
      END IF;
      -- The path names the row, whatever the value says.
      v_new_row := (v_op->'value') || jsonb_build_object('id', v_id);

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

      -- A direct child's FK was just injected above, so it is in scope by
      -- construction. A grandchild's arrives verbatim from the client — without
      -- this check it grafts the new row onto ANOTHER doc's parent.
      IF v_coll.parent_collection IS NOT NULL
         AND v_coll.parent_collection IS DISTINCT FROM v_def.root_collection
         AND NOT _delta_row_in_scope(
               v_def, p_doc_name, v_coll.parent_collection,
               (v_new_row->>v_coll.parent_fk)::BIGINT) THEN
        RAISE EXCEPTION 'row not found: %/%',
          v_coll.parent_collection, COALESCE(v_new_row->>v_coll.parent_fk, '')
          USING ERRCODE = 'P0002';
      END IF;

      -- A required column (not nullable, no declared default) the value leaves
      -- out is the writer's mistake: refuse it (SQLSTATE 23502, 400 on the
      -- wire) rather than store '' / 0 / false for it.
      SELECT string_agg(col_key, ', ' ORDER BY col_key) INTO v_missing
        FROM jsonb_each(v_coll.columns_def) AS x(col_key, col_def)
       WHERE NOT v_new_row ? col_key
         AND NOT COALESCE((col_def->>'nullable')::boolean, false)
         AND NOT col_def ? 'default';
      IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'Required field missing: % (give it a value, or declare a default or make it nullable in the schema)', v_missing
          USING ERRCODE = '23502';
      END IF;

      -- Declared column defaults, for what the value leaves out
      SELECT v_new_row || COALESCE(jsonb_object_agg(col_key, col_def->'default'), '{}'::jsonb)
        INTO v_new_row
        FROM jsonb_each(v_coll.columns_def) AS x(col_key, col_def)
       WHERE NOT v_new_row ? col_key AND col_def ? 'default';

      IF v_coll.temporal THEN
        v_new_row := v_new_row || jsonb_build_object('valid_from', v_ts, 'valid_to', NULL);
      END IF;

      -- Every write here tells the row as stored (RETURNING), not as sent: a
      -- value its column casts (a scope's '1' into an integer, a date into a
      -- timestamptz) is told as a later open reads it, so the broadcast, the
      -- ledger's entry and undo's guard agree with the table.
      EXECUTE format(
        'INSERT INTO %I AS t SELECT * FROM jsonb_populate_record(null::%I, $1) RETURNING to_jsonb(t)',
        v_coll.table_name, v_coll.table_name
      ) INTO v_new_row USING v_new_row;

      -- Strip temporal columns from broadcast
      IF v_coll.temporal THEN
        v_new_row := _delta_strip_temporal(v_new_row);
      END IF;

      v_broadcast_ops := v_broadcast_ops || jsonb_build_array(
        jsonb_build_object('op', 'add', 'path', _delta_build_path(v_coll_key, v_id::text), 'value', v_new_row)
      );
      v_touched := v_touched || jsonb_build_array(jsonb_build_object(
        'coll', v_coll_key, 'id', v_id, 'before', '[]'::jsonb, 'after', v_new_row));
      CONTINUE;
    END IF;

    -- ---------------------------------------------------------------
    -- Remove row:  remove /<collection>/<id>  (+ cascades)
    -- ---------------------------------------------------------------
    IF array_length(v_parts, 1) = 2 AND v_op->>'op' = 'remove' THEN
      v_id := _delta_row_id(v_coll_key, v_parts[2]);
      -- _delta_cascade_remove addresses rows by id alone, so without this gate a
      -- client could name any id and delete a sibling doc's row.
      IF NOT _delta_row_in_scope(v_def, p_doc_name, v_coll_key, v_id) THEN
        RAISE EXCEPTION 'row not found: %/%', v_coll_key, v_id
          USING ERRCODE = 'P0002';
      END IF;
      -- who holds the row and every row the cascade takes, asked before any is gone
      v_befores := '{}'::jsonb;
      FOR v_r IN SELECT jsonb_array_elements(_delta_cascade_rows(v_coll_key, v_id, v_def.include)) LOOP
        v_befores := v_befores || jsonb_build_object(
          (v_r->>'coll') || '/' || (v_r->>'id'), to_jsonb(_delta_holders(v_r->>'coll', v_r->'row', p_doc_name)));
      END LOOP;
      v_removed := _delta_cascade_remove(v_coll_key, v_id, v_def.include);
      v_broadcast_ops := v_broadcast_ops || v_removed;
      FOR v_r IN SELECT jsonb_array_elements(v_removed) LOOP
        v_rp := _delta_split_path(v_r->>'path');
        v_touched := v_touched || jsonb_build_array(jsonb_build_object(
          'coll', v_rp[1], 'id', v_rp[2]::BIGINT,
          'before', COALESCE(v_befores->(v_rp[1] || '/' || v_rp[2]), '[]'::jsonb), 'after', NULL));
      END LOOP;
      CONTINUE;
    END IF;

    -- ---------------------------------------------------------------
    -- Row replace:  replace /<collection>/<id>        (partial row merge)
    -- Field replace: replace /<collection>/<id>/field (single field shorthand)
    -- ---------------------------------------------------------------
    IF (array_length(v_parts, 1) = 2 OR array_length(v_parts, 1) = 3) AND v_op->>'op' = 'replace' THEN
      v_id := _delta_row_id(v_coll_key, v_parts[2]);

      -- Same gate as remove: the row is addressed by bare id, so it must belong
      -- to this doc. (The single-mode root branch above never reaches here — it
      -- targets v_doc_id directly.)
      IF NOT _delta_row_in_scope(v_def, p_doc_name, v_coll_key, v_id) THEN
        RAISE EXCEPTION 'row not found: %/%', v_coll_key, v_id
          USING ERRCODE = 'P0002';
      END IF;

      -- 3-segment: wrap single field into partial row value
      IF array_length(v_parts, 1) = 3 THEN
        v_op := jsonb_set(v_op, '{value}', jsonb_build_object(v_parts[3], v_op->'value'));
      END IF;
      PERFORM _delta_assert_fields(v_coll_key, v_coll.columns_def, v_coll.parent_fk, v_op->'value');

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
        RAISE EXCEPTION 'row not found: %/%', v_coll_key, v_id USING ERRCODE = 'P0002';
      END IF;
      v_before := _delta_holders(v_coll_key, _delta_strip_temporal(v_row), p_doc_name);

      -- Merge partial value into current row
      v_new_row := v_row || (v_op->'value');

      IF v_coll.temporal THEN
        EXECUTE format(
          'UPDATE %I SET valid_to = $2 WHERE id = $1 AND valid_to IS NULL',
          v_coll.table_name
        ) USING v_id, v_ts;

        v_new_row := v_new_row || jsonb_build_object('valid_from', v_ts, 'valid_to', NULL);

        EXECUTE format(
          'INSERT INTO %I AS t SELECT * FROM jsonb_populate_record(null::%I, $1) RETURNING to_jsonb(t)',
          v_coll.table_name, v_coll.table_name
        ) INTO v_new_row USING v_new_row;
      ELSE
        -- Non-temporal: UPDATE with merged row
        EXECUTE format(
          'DELETE FROM %I WHERE id = $1', v_coll.table_name
        ) USING v_id;
        EXECUTE format(
          'INSERT INTO %I AS t SELECT * FROM jsonb_populate_record(null::%I, $1) RETURNING to_jsonb(t)',
          v_coll.table_name, v_coll.table_name
        ) INTO v_new_row USING v_new_row;
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
      v_touched := v_touched || jsonb_build_array(jsonb_build_object(
        'coll', v_coll_key, 'id', v_id, 'before', to_jsonb(v_before), 'after', v_new_row));
      CONTINUE;
    END IF;

    RAISE EXCEPTION 'invalid op: % %', v_op->>'op', v_op->>'path' USING ERRCODE = '22023';
  END LOOP;

  -- Told: the writer's document and every other that holds a row changed,
  -- each what changed for it. The answer (and the ledger) keep the ops as
  -- written, so an undo walks back exactly what was done.
  v_version := _delta_tell(p_doc_name, v_touched);
  RETURN jsonb_build_object('version', v_version, 'ops', v_broadcast_ops);
END;
$$ LANGUAGE plpgsql;
