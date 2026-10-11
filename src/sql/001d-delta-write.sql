-- =========================================================================
-- Delta-doc: cascade removal, delta_apply
-- =========================================================================

-- ---------------------------------------------------------------------------
-- _delta_serial_past: moves a collection's serial (seq_<table>) past an id an
-- add named, never back, so a later add at /- does not meet it (todo #63).
-- setval needs UPDATE on the sequence, and an app role is granted USAGE,
-- SELECT: so it runs as the framework's owner (SECURITY DEFINER), for a table
-- delta knows and an id a path may name, and nothing else.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_serial_past(p_table TEXT, p_id BIGINT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_id > 9007199254740991 OR NOT EXISTS (SELECT 1 FROM _delta_collections WHERE table_name = p_table) THEN
    RETURN;
  END IF;
  EXECUTE format('SELECT setval(%L, $1) FROM %I WHERE $1 >= last_value + is_called::int',
    'seq_' || p_table, 'seq_' || p_table) USING p_id;
END;
$$;
-- the search path it was applied with, and pg_temp last (as _delta_holders, 001b)
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION _delta_serial_past(TEXT, BIGINT) SET search_path = %s, pg_temp', COALESCE(NULLIF(current_setting('search_path'), ''), 'public'));
END $$;

-- ---------------------------------------------------------------------------
-- _delta_cascade_remove: remove a row + cascade to children & referencedBy,
-- as the schema says, whichever document the removal is written through: one
-- that does not include the drinks still takes a course's drinks (no orphans).
-- Returns the array of broadcast ops generated. (Until 0.12.0 it took the
-- writer's include, and left the rest: that form is dropped.)
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS _delta_cascade_remove(TEXT, BIGINT, TEXT[]);
CREATE OR REPLACE FUNCTION _delta_cascade_remove(
  p_collection_key TEXT,
  p_id             BIGINT
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
  LOOP
    v_view := _delta_source_view(v_child.table_name, v_child.temporal);

    FOR v_child_row IN
      EXECUTE format('SELECT id FROM %I WHERE %I = $1', v_view, v_child.parent_fk)
        USING p_id
    LOOP
      v_ops := v_ops || _delta_cascade_remove(v_child.collection_key, v_child_row.id);
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
  LOOP
    v_view := _delta_source_view(v_ref.table_name, v_ref.temporal);

    FOR v_ref_row IN
      EXECUTE format('SELECT id FROM %I WHERE %I = $1', v_view, v_ref.fk_column)
        USING p_id
    LOOP
      v_ops := v_ops || _delta_cascade_remove(v_ref.collection_key, v_ref_row.id);
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

DROP FUNCTION IF EXISTS _delta_cascade_rows(TEXT, BIGINT, TEXT[]);
CREATE OR REPLACE FUNCTION _delta_cascade_rows(
  p_collection_key TEXT,
  p_id             BIGINT
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
  EXECUTE format('SELECT to_jsonb(t.*) FROM %I t WHERE t.id = $1', v_view) INTO v_row USING p_id;
  IF v_row IS NULL THEN RETURN v_rows; END IF;
  v_rows := jsonb_build_array(jsonb_build_object('coll', p_collection_key, 'id', p_id, 'row', _delta_strip_temporal(v_row)));

  FOR v_child IN
    SELECT * FROM _delta_collections
     WHERE parent_collection = p_collection_key
  LOOP
    FOR v_id IN EXECUTE format('SELECT id FROM %I WHERE %I = $1', _delta_source_view(v_child.table_name, v_child.temporal), v_child.parent_fk) USING p_id
    LOOP
      v_rows := v_rows || _delta_cascade_rows(v_child.collection_key, v_id);
    END LOOP;
  END LOOP;

  FOR v_ref IN
    SELECT c.collection_key, c.table_name, c.temporal, elem->>'fk' AS fk_column
      FROM _delta_collections c, jsonb_array_elements(c.cascade_on) AS elem
     WHERE elem->>'collection' = p_collection_key
  LOOP
    FOR v_id IN EXECUTE format('SELECT id FROM %I WHERE %I = $1', _delta_source_view(v_ref.table_name, v_ref.temporal), v_ref.fk_column) USING p_id
    LOOP
      v_rows := v_rows || _delta_cascade_rows(v_ref.collection_key, v_id);
    END LOOP;
  END LOOP;

  RETURN v_rows;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- _delta_hanging_rows: the rows that hang from a row -- its children, theirs,
-- and on down, whichever documents include them -- parent first, each
-- {coll, id, row}. A row moved to another parent takes them along (todo #62;
-- hanging in sqlite.ts).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_hanging_rows(p_collection_key TEXT, p_id BIGINT)
RETURNS JSONB AS $$
DECLARE
  v_child RECORD;
  v_part  JSONB;
  v_rows  JSONB := '[]'::jsonb;
BEGIN
  -- a child collection at a time, in one aggregate: each row by id, the rows under it after it
  FOR v_child IN SELECT * FROM _delta_collections WHERE parent_collection = p_collection_key ORDER BY collection_key COLLATE "C" LOOP
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(e ORDER BY t.id, n), ''[]''::jsonb) FROM %I t,
         jsonb_array_elements(jsonb_build_array(jsonb_build_object(''coll'', %L, ''id'', t.id, ''row'', _delta_strip_temporal(to_jsonb(t.*))))
                              || _delta_hanging_rows(%L, t.id)) WITH ORDINALITY AS x(e, n)
        WHERE t.%I = $1',
      _delta_source_view(v_child.table_name, v_child.temporal), v_child.collection_key, v_child.collection_key, v_child.parent_fk
    ) INTO v_part USING p_id;
    v_rows := v_rows || v_part;
  END LOOP;
  RETURN v_rows;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- _delta_tell: tell every document that holds a row a write changed what
-- changed for it (todo #28), and answer the writer's new version.
--
-- `p_touched` is the write's rows in order, each {coll, id, before, after}:
-- `before` the documents that held it before that touch (_delta_holders, asked
-- then), `after` the row as the touch left it (null when it is gone); a
-- `carried` row hangs under one the write moved, and is told only where it
-- arrives or leaves (todo #62). Each
-- touch is told in turn: the documents that hold the row after it are those
-- that held it at the row's next touch, or after its last, those that hold it
-- once the write is done -- so a row made and then taken out (a drink, with its
-- course) is told its add wherever its remove is told (todo #75; tell in
-- sqlite.ts). For each document that held it before or holds it after: a row
-- that arrives is an add, one that stays a replace, one that leaves a remove --
-- and where the row is the document's root, a replace of the root (null when
-- it leaves). The
-- writer's document is always told, and told first; each other document is
-- told only what concerns it, with a version of its own, one per write.
-- `p_applied`, the write as applied, is logged once, on the writer's entry,
-- for the custom documents that watch the rows (001a's `applied`) -- only where
-- it differs from what the writer is told (a row that left the writer's
-- document, or was never in it); where they agree the entry carries none, and
-- is heard as told. Every other document's entry carries '[]'. The
-- two-argument form logs none.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_tell(p_writer TEXT, p_touched JSONB, p_applied JSONB)
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
  v_next    JSONB := '{}'::jsonb;   -- a row's holders, as its next touch found them
  v_key     TEXT;
  v_i       INT;
BEGIN
  -- who holds each row after each touch, last touch first, and every document concerned
  FOR v_i IN REVERSE COALESCE(jsonb_array_length(p_touched), 0) - 1 .. 0 LOOP
    v_t := p_touched->v_i;
    v_key := (v_t->>'coll') || '/' || (v_t->>'id');
    v_after := CASE WHEN jsonb_typeof(v_t->'after') = 'object' THEN v_t->'after' END;
    v_t := v_t || jsonb_build_object('holders',
      COALESCE(v_next->v_key, to_jsonb(_delta_holders(v_t->>'coll', v_after, p_writer))));
    v_next := v_next || jsonb_build_object(v_key, v_t->'before');
    v_rows := jsonb_build_array(v_t) || v_rows;
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
      CONTINUE WHEN v_was AND v_is AND (v_t ? 'carried');   -- carried along, and held either way: unchanged for it
      v_root := v_single AND (v_t->>'coll') = v_def.root_collection;
      v_path := CASE WHEN v_root THEN _delta_build_path(v_t->>'coll') ELSE _delta_build_path(v_t->>'coll', v_t->>'id') END;
      IF v_is THEN
        v_told := v_told || jsonb_build_array(jsonb_build_object(
          'op', CASE WHEN v_was OR v_root THEN 'replace' ELSE 'add' END, 'path', v_path, 'value', v_t->'after'));
      ELSIF v_root THEN   -- gone: null, or the empty root an implied document then opens with
        v_told := v_told || jsonb_build_array(jsonb_build_object('op', 'replace', 'path', v_path, 'value',
          CASE WHEN COALESCE(v_def.implied, FALSE) THEN _delta_implied_root(v_def, (v_t->>'id')::BIGINT) ELSE 'null'::jsonb END));
      ELSE
        v_told := v_told || jsonb_build_array(jsonb_build_object('op', 'remove', 'path', v_path));
      END IF;
    END LOOP;
    IF v_target = p_writer THEN
      v_version := _delta_bump_and_notify(p_writer, v_told, CASE WHEN p_applied IS DISTINCT FROM v_told THEN p_applied END);
    ELSIF jsonb_array_length(v_told) > 0 THEN
      PERFORM _delta_bump_and_notify(v_target, v_told, CASE WHEN p_applied IS NOT NULL THEN '[]'::jsonb END);
    END IF;
  END LOOP;
  RETURN v_version;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION _delta_tell(p_writer TEXT, p_touched JSONB)
RETURNS BIGINT LANGUAGE sql AS $$ SELECT _delta_tell(p_writer, p_touched, NULL); $$;

-- ---------------------------------------------------------------------------
-- _delta_assert_parent_held: a parent key written (in `p_value`, over the row
-- as it is, `p_row`) moves the row, and only under a parent the document holds,
-- as an add names one: through it, a row is never moved into another
-- document (you may write what you may read), RLS or none. A single
-- document's own root too: it holds no parent of it, so the root moves
-- through a list that holds both (0.10.0 review). A key written as it is, is
-- no move. P0002 (404) when refused.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_assert_parent_held(p_def _delta_docs, p_doc_name TEXT, p_parent_fk TEXT, p_parent TEXT, p_row JSONB, p_value JSONB)
RETURNS void AS $$
BEGIN
  IF p_parent_fk IS NOT NULL
     AND jsonb_typeof(p_value->p_parent_fk) IN ('number', 'string')
     AND (p_value->>p_parent_fk)::BIGINT IS DISTINCT FROM (p_row->>p_parent_fk)::BIGINT
     AND NOT _delta_row_in_scope(p_def, p_doc_name, p_parent, (p_value->>p_parent_fk)::BIGINT) THEN
    RAISE EXCEPTION 'row not found: %/%', p_parent, p_value->>p_parent_fk
      USING ERRCODE = 'P0002';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

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
--
-- `p_walk`: the write is a walk of the ledger, an undo or redo (001g's
-- delta_apply_logged says so for delta_walk). A single document whose root is
-- gone takes no writes but a walk, which may put that root back (todo #43,
-- #59), or its root's add in a write that took it out (todo #61). The
-- two-argument form is no walk.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION delta_apply(p_doc_name TEXT, p_ops JSONB, p_walk BOOLEAN)
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
  v_root_view     TEXT;
  v_opened        BOOLEAN;   -- a single document's root was there as the write began
  v_back          BOOLEAN;   -- this op adds that root back, taken out earlier in the write
  v_root_was      JSONB;     -- that root as this write took it out: added back, it goes under the same parent
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
  v_told_path     TEXT;
  v_run_at        INT;               -- the touched entry of the run of replaces under way
  v_run_carried   BOOLEAN := FALSE;  -- that run has carried the rows under its row along
  v_hung          JSONB;
  v_outside       BOOLEAN;           -- the op's collection is neither the root nor included: a walk's, put back or taken again
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
  -- a document named with a time reads it as it stood: what is written now is not its to write (403)
  IF v_scope->>'at' IS NOT NULL THEN
    RAISE EXCEPTION '% reads % as it stood at %: it takes no writes. Write through a document with no time in its name.',
      p_doc_name, v_def.root_collection, left(v_scope->>'at', 10) USING ERRCODE = '25006';
  END IF;
  v_is_list := (v_scope->>'mode') = 'list';
  IF NOT v_is_list THEN
    v_doc_id := (v_scope->'values'->>'id')::BIGINT;
  END IF;

  SELECT * INTO v_root_coll FROM _delta_collections
   WHERE collection_key = v_def.root_collection;
  v_root_view := _delta_source_view(v_root_coll.table_name, v_root_coll.temporal);

  -- an implied document's first write makes its root row (todo #34), told as a
  -- row carried in: an add to a list of those roots, nothing to the implied
  -- documents, which showed it already (ensureImpliedRoot in sqlite.ts); an
  -- empty write makes nothing
  IF NOT v_is_list AND COALESCE(v_def.implied, FALSE) AND jsonb_array_length(p_ops) > 0 THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1)', v_root_view) INTO v_exists USING v_doc_id;
    PERFORM _delta_make_implied(v_def, v_doc_id, p_ops, v_ts);
    IF NOT v_exists THEN
      EXECUTE format('SELECT _delta_strip_temporal(to_jsonb(t.*)) FROM %I t WHERE t.id = $1', v_root_view) INTO v_row USING v_doc_id;
      IF v_row IS NOT NULL THEN
        v_touched := jsonb_build_array(jsonb_build_object('coll', v_def.root_collection, 'id', v_doc_id, 'after', v_row, 'carried', TRUE,
          'before', COALESCE((SELECT jsonb_agg(n) FROM unnest(_delta_holders(v_def.root_collection, v_row, p_doc_name)) AS n
                               WHERE COALESCE((_delta_find_doc(n)).implied, FALSE)
                                 AND _delta_resolve_scope(_delta_find_doc(n), n)->>'mode' = 'single'), '[]'::jsonb)));
      END IF;
    END IF;
  END IF;

  -- An empty write is asked what each op is (below): a single document whose
  -- root is not there is not found, as on SQLite -- unless implied, or a walk.
  IF jsonb_array_length(p_ops) = 0 AND NOT v_is_list AND NOT COALESCE(p_walk, FALSE) AND NOT COALESCE(v_def.implied, FALSE) THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I t WHERE t.id = $1 AND %s)', v_root_view, v_scope->>'where') INTO v_exists USING v_doc_id;
    IF NOT v_exists THEN
      RAISE EXCEPTION 'document not found: % (its root, %, is not there)',
        p_doc_name, _delta_build_path(v_def.root_collection, v_doc_id::text)
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  FOR v_op IN SELECT jsonb_array_elements(p_ops)
  LOOP
    -- A single document is its root row and what hangs from it. One whose
    -- root is not there -- taken out, through it or another, or never there --
    -- opens as not found, and takes no writes (todo #59): asked before each
    -- op, so an add under a root that is gone makes no orphan. But a write
    -- through a document that opened (its root there as the write began, the
    -- first op's answer; an implied one always opens, todo #34) may add that
    -- root back after taking it out, and
    -- write on through it: a remove and an add of the root in one write is
    -- one row, walked as one (_delta_walk_key). A walk is not asked: an undo
    -- of the root's removal puts it back (todo #43), and a walk of such a
    -- document starts from the root absent, guarded by its plan
    -- (_delta_walk_plan), as SQLite's and ./json's are.
    IF NOT v_is_list AND NOT COALESCE(p_walk, FALSE) THEN   -- a walk not said (null) is none
      -- there, and meeting the whole of its name's scope (a column beside its id), as delta_open reads it
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I t WHERE t.id = $1 AND %s)', v_root_view, v_scope->>'where') INTO v_exists USING v_doc_id;
      v_opened := COALESCE(v_opened, v_exists OR COALESCE(v_def.implied, FALSE));
      v_back := FALSE;
      IF NOT v_exists AND v_opened AND v_op->>'op' = 'add' THEN
        v_parts := _delta_split_path(v_op->>'path');
        v_back := array_length(v_parts, 1) = 2 AND v_parts[1] = v_def.root_collection
                  AND v_parts[2] ~ '^[0-9]+$' AND v_parts[2]::numeric = v_doc_id;
      END IF;
      IF NOT v_exists AND NOT v_back THEN
        RAISE EXCEPTION 'document not found: % (its root, %, is not there)',
          p_doc_name, _delta_build_path(v_def.root_collection, v_doc_id::text)
          USING ERRCODE = 'P0002';
      END IF;
    END IF;

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
    -- A walk may put back, or take again, a row outside the document that its
    -- entry's cascade reached (the schema's, not the include's): its plan
    -- guards it against the tables (_delta_walk_plan).
    v_outside := v_coll_key IS DISTINCT FROM v_def.root_collection
                 AND NOT (v_coll_key = ANY(COALESCE(v_def.include, ARRAY[]::text[])));
    IF v_outside AND NOT (COALESCE(p_walk, FALSE) AND array_length(v_parts, 1) = 2 AND v_op->>'op' IN ('add', 'remove')) THEN
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

      -- 2-segment /root/field: wrap into partial row. A row's id is not a
      -- field: its path (here, the document's name) says it.
      IF array_length(v_parts, 1) = 2 THEN
        IF v_parts[2] = 'id' THEN
          RAISE EXCEPTION 'Unknown field: id (a row keeps the id its path names)' USING ERRCODE = '22023';
        END IF;
        v_op := jsonb_set(v_op, '{value}', jsonb_build_object(v_parts[2], v_op->'value'));
      END IF;
      PERFORM _delta_assert_fields(v_coll_key, v_coll.columns_def, v_coll.parent_fk, v_op->'value');

      -- Read + lock
      IF v_coll.temporal THEN
        EXECUTE format(
          'SELECT to_jsonb(t.*) FROM %I t WHERE t.id = $1 AND valid_to IS NULL FOR UPDATE',
          v_coll.table_name
        ) INTO v_row USING v_doc_id;
      ELSE
        EXECUTE format(
          'SELECT to_jsonb(t.*) FROM %I t WHERE t.id = $1 FOR UPDATE',
          v_coll.table_name
        ) INTO v_row USING v_doc_id;
      END IF;

      IF v_row IS NULL THEN
        RAISE EXCEPTION 'root row not found: %', v_def.root_collection USING ERRCODE = 'P0002';
      END IF;
      PERFORM _delta_assert_parent_held(v_def, p_doc_name, v_coll.parent_fk, v_coll.parent_collection, v_row, v_op->'value');
      v_before := _delta_holders(v_coll_key, _delta_strip_temporal(v_row), p_doc_name);

      -- Merge partial value. The row keeps its id: one in the value is the
      -- document's, as an add's is the path's (it renumbered the row).
      v_new_row := v_row || (v_op->'value') || jsonb_build_object('id', v_doc_id);

      IF v_coll.temporal THEN
        -- One version per write: a version this write made (its valid_from is the
        -- write's NOW()) gives way to the next, rather than closing at the same
        -- instant and colliding with it on (id, valid_from).
        EXECUTE format(
          'DELETE FROM %I WHERE id = $1 AND valid_to IS NULL AND valid_from = $2',
          v_coll.table_name
        ) USING v_doc_id, v_ts;
        EXECUTE format(
          'UPDATE %I SET valid_to = $2 WHERE id = $1 AND valid_to IS NULL',
          v_coll.table_name
        ) USING v_doc_id, v_ts;

        v_new_row := v_new_row || jsonb_build_object('valid_from', v_ts, 'valid_to', NULL);

        EXECUTE format(
          'INSERT INTO %I AS t SELECT * FROM jsonb_populate_record(null::%I, $1) RETURNING to_jsonb(t.*)',
          v_coll.table_name, v_coll.table_name
        ) INTO v_new_row USING v_new_row;

        v_new_row := _delta_strip_temporal(v_new_row);
      ELSE
        EXECUTE format('DELETE FROM %I WHERE id = $1', v_coll.table_name) USING v_doc_id;
        EXECUTE format(
          'INSERT INTO %I AS t SELECT * FROM jsonb_populate_record(null::%I, $1) RETURNING to_jsonb(t.*)',
          v_coll.table_name, v_coll.table_name
        ) INTO v_new_row USING v_new_row;
      END IF;

      -- The root written through its document stays in its scope, as a list's
      -- rows do (below): one written out of the rest of its name's scope -- a
      -- seat of fo-seat-of:1:3 to table 7 -- is refused, and the write undone
      -- (0.10.0 review).
      IF NOT _delta_row_in_scope(v_def, p_doc_name, v_coll_key, v_doc_id) THEN
        RAISE EXCEPTION 'row not found: %/% -- the write would take it out of %',
          v_coll_key, v_doc_id, p_doc_name
          USING ERRCODE = 'P0002';
      END IF;

      -- A replace straight after a replace of the same row is one run: answered,
      -- logged and told once, as the run leaves it (who held it before, the
      -- run's first). SQLite's applyOps keeps the same rule.
      v_told_path := _delta_build_path(v_def.root_collection);
      IF v_broadcast_ops->-1->>'op' = 'replace' AND v_broadcast_ops->-1->>'path' = v_told_path THEN
        v_broadcast_ops := jsonb_set(v_broadcast_ops, '{-1,value}', v_new_row);
        v_touched := jsonb_set(v_touched, ARRAY[v_run_at::text, 'after'], v_new_row);
      ELSE
        v_broadcast_ops := v_broadcast_ops || jsonb_build_array(
          jsonb_build_object('op', 'replace', 'path', v_told_path, 'value', v_new_row)
        );
        v_touched := v_touched || jsonb_build_array(jsonb_build_object(
          'coll', v_coll_key, 'id', v_doc_id, 'before', to_jsonb(v_before), 'after', v_new_row));
        v_run_at := jsonb_array_length(v_touched) - 1;
        v_run_carried := FALSE;
      END IF;
      CONTINUE;
    END IF;

    -- ---------------------------------------------------------------
    -- Add row:  add /<collection>/<id>
    -- ---------------------------------------------------------------
    IF array_length(v_parts, 1) = 2 AND v_op->>'op' = 'add' THEN
      -- ... and it holds one root row, the one its name names: it adds no
      -- other (todo #52). A row it could not read would be told to no one.
      -- Its own it adds only when it is gone (above: taken out earlier in this
      -- write, or by a walk, an undo of its removal); there, the live check
      -- below answers 409.
      IF NOT v_is_list AND v_coll_key = v_def.root_collection
         AND (v_parts[2] !~ '^[0-9]+$' OR v_parts[2]::numeric <> v_doc_id) THEN
        RAISE EXCEPTION 'invalid op: add % -- document % holds one %, its root: add it through a document that lists them',
          v_op->>'path', p_doc_name, v_def.root_collection
          USING ERRCODE = '22023';
      END IF;
      PERFORM _delta_assert_fields(v_coll_key, v_coll.columns_def, v_coll.parent_fk, v_op->'value');
      v_id_text := v_parts[2];
      -- Auto-generate ID from sequence if path ends with '-'
      IF v_id_text = '-' THEN
        EXECUTE format('SELECT nextval(%L)', 'seq_' || v_coll.table_name) INTO v_id;
      ELSE
        v_id := _delta_row_id(v_coll_key, v_id_text);
      END IF;
      -- An add names a new row. A temporal key is (id, valid_from), so nothing
      -- in the table stops a second live version of an id (todo #16): a mint
      -- can meet an id a client named, and two writers through two documents
      -- can name one id at once. A lock on the id, held to commit, and the live
      -- check under it do: a second add waits for the first, then sees its row
      -- (each statement reads what is committed) and is refused (SQLSTATE
      -- 23505, 409 on the wire), as a plain table's key refuses it.
      IF v_coll.temporal THEN
        PERFORM pg_advisory_xact_lock(hashtext('delta-row:' || v_coll.table_name), hashtext(v_id::text));
      END IF;
      IF v_id_text <> '-' OR v_coll.temporal THEN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1)', v_view) INTO v_exists USING v_id;
        IF v_exists THEN
          RAISE EXCEPTION 'row already exists: % -- replace it, or add to % for a new id',
            _delta_build_path(v_coll_key, v_id::text), _delta_build_path(v_coll_key, '-')
            USING ERRCODE = '23505';
        END IF;
      END IF;
      -- The path names the row, whatever the value says.
      v_new_row := (v_op->'value') || jsonb_build_object('id', v_id);

      -- Set FK: for list-mode root adds, apply scope equality values, each as
      -- the scope's condition reads it (_delta_scope_row);
      -- for child collections in single-mode, set FK to root id. In list-mode
      -- child adds (e.g. a product-catalog doc adding a `parts` row) there is
      -- no doc-id to inject, so we trust the parent_fk supplied in the op value.
      IF v_is_list AND v_coll_key = v_def.root_collection THEN
        v_new_row := v_new_row || _delta_scope_row(v_coll.columns_def, v_scope->'values');
      ELSIF v_coll.parent_collection = v_def.root_collection AND v_coll.parent_fk IS NOT NULL
            AND v_doc_id IS NOT NULL THEN
        v_new_row := v_new_row || jsonb_build_object(v_coll.parent_fk, v_doc_id);
      END IF;

      -- A direct child's FK was just injected above, so it is in scope by
      -- construction. A grandchild's arrives verbatim from the client — without
      -- this check it grafts the new row onto ANOTHER doc's parent. A single
      -- document's root row is not under its parent: its value names it.
      IF v_coll.parent_collection IS NOT NULL AND NOT v_outside
         AND v_coll.parent_collection IS DISTINCT FROM v_def.root_collection
         AND (v_is_list OR v_coll_key IS DISTINCT FROM v_def.root_collection)
         AND NOT _delta_row_in_scope(
               v_def, p_doc_name, v_coll.parent_collection,
               (v_new_row->>v_coll.parent_fk)::BIGINT) THEN
        RAISE EXCEPTION 'row not found: %/%',
          v_coll.parent_collection, COALESCE(v_new_row->>v_coll.parent_fk, '')
          USING ERRCODE = 'P0002';
      END IF;

      -- ... and a single document's own root, added back in the write that took
      -- it out, goes back under the parent it had: another would be a move, and
      -- the document holds no parent of its root (0.10.0 review).
      IF NOT v_is_list AND v_coll_key = v_def.root_collection AND v_coll.parent_fk IS NOT NULL
         AND v_root_was IS NOT NULL
         AND (v_new_row->>v_coll.parent_fk)::BIGINT IS DISTINCT FROM (v_root_was->>v_coll.parent_fk)::BIGINT THEN
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
        -- One moment per write: a version this write made and took back (its
        -- valid_from and valid_to both the write's NOW()) never was outside it,
        -- so an add of the same id takes its place rather than colliding with it
        -- on (id, valid_from). SQLite's insertCollectionRow keeps the same rule.
        EXECUTE format(
          'DELETE FROM %I WHERE id = $1 AND valid_from = $2 AND valid_to = $2',
          v_coll.table_name
        ) USING v_id, v_ts;
        v_new_row := v_new_row || jsonb_build_object('valid_from', v_ts, 'valid_to', NULL);
      END IF;

      -- Every write here tells the row as stored (RETURNING), not as sent: a
      -- value its column casts (a scope's '1' into an integer, a date into a
      -- timestamptz) is told as a later open reads it, so the broadcast, the
      -- ledger's entry and undo's guard agree with the table.
      EXECUTE format(
        'INSERT INTO %I AS t SELECT * FROM jsonb_populate_record(null::%I, $1) RETURNING to_jsonb(t.*)',
        v_coll.table_name, v_coll.table_name
      ) INTO v_new_row USING v_new_row;

      -- An id the add named moves the serial past it, so a later /- does not meet it.
      IF v_id_text <> '-' THEN PERFORM _delta_serial_past(v_coll.table_name, v_id); END IF;

      -- A root row added through a document is one it holds: a list's, given
      -- its bindings, must meet the rest of its conditions too (a name like
      -- `So`, a price up to 5), and a single document's own root added back,
      -- the whole of its name's scope. Else it would be made where the writer
      -- cannot read it -- told [] itself, and an add to the lists it does meet
      -- -- so it is refused, and the write undone (0.10.0 review, todo #66).
      IF v_coll_key = v_def.root_collection
         AND NOT _delta_row_in_scope(v_def, p_doc_name, v_coll_key, v_id) THEN
        RAISE EXCEPTION 'row not found: %/% -- the add is not one % holds',
          v_coll_key, v_id, p_doc_name
          USING ERRCODE = 'P0002';
      END IF;

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
      IF NOT v_outside AND NOT _delta_row_in_scope(v_def, p_doc_name, v_coll_key, v_id) THEN
        RAISE EXCEPTION 'row not found: %/%', v_coll_key, v_id
          USING ERRCODE = 'P0002';
      END IF;
      -- who holds the row and every row the cascade takes, asked before any is gone
      v_befores := '{}'::jsonb;
      FOR v_r IN SELECT jsonb_array_elements(_delta_cascade_rows(v_coll_key, v_id)) LOOP
        v_befores := v_befores || jsonb_build_object(
          (v_r->>'coll') || '/' || (v_r->>'id'), to_jsonb(_delta_holders(v_r->>'coll', v_r->'row', p_doc_name)));
        IF NOT v_is_list AND v_r->>'coll' = v_def.root_collection THEN v_root_was := v_r->'row'; END IF;
      END LOOP;
      v_removed := _delta_cascade_remove(v_coll_key, v_id);
      -- A remove of a row that is not there is a 404, as on SQLite and ./json
      -- (the same tables, kept in a JSON file; A6): the scope gate above lets any id of a collection a
      -- document holds whole (one with no parent, a list's include) through,
      -- and the cascade removes nothing (or RLS hid the row from this identity).
      IF jsonb_array_length(v_removed) = 0 THEN
        RAISE EXCEPTION 'row not found: %/%', v_coll_key, v_id
          USING ERRCODE = 'P0002';
      END IF;
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

      -- 3-segment: wrap single field into partial row value. A row's id is
      -- not a field: its path says it.
      IF array_length(v_parts, 1) = 3 THEN
        IF v_parts[3] = 'id' THEN
          RAISE EXCEPTION 'Unknown field: id (a row keeps the id its path names)' USING ERRCODE = '22023';
        END IF;
        v_op := jsonb_set(v_op, '{value}', jsonb_build_object(v_parts[3], v_op->'value'));
      END IF;
      PERFORM _delta_assert_fields(v_coll_key, v_coll.columns_def, v_coll.parent_fk, v_op->'value');

      IF v_coll.temporal THEN
        EXECUTE format(
          'SELECT to_jsonb(t.*) FROM %I t WHERE t.id = $1 AND valid_to IS NULL FOR UPDATE',
          v_coll.table_name
        ) INTO v_row USING v_id;
      ELSE
        EXECUTE format(
          'SELECT to_jsonb(t.*) FROM %I t WHERE t.id = $1 FOR UPDATE',
          v_coll.table_name
        ) INTO v_row USING v_id;
      END IF;

      IF v_row IS NULL THEN
        RAISE EXCEPTION 'row not found: %/%', v_coll_key, v_id USING ERRCODE = 'P0002';
      END IF;
      PERFORM _delta_assert_parent_held(v_def, p_doc_name, v_coll.parent_fk, v_coll.parent_collection, v_row, v_op->'value');
      v_before := _delta_holders(v_coll_key, _delta_strip_temporal(v_row), p_doc_name);

      -- For single-item docs updating the root entity, broadcast as /collection
      -- so the client replaces the direct object (not a Record entry)
      IF NOT v_is_list AND v_coll_key = v_def.root_collection AND v_id = v_doc_id THEN
        v_told_path := _delta_build_path(v_coll_key);
      ELSE
        v_told_path := _delta_build_path(v_coll_key, v_id::text);
      END IF;

      -- A row moved to another parent takes the rows under it along (todo #62):
      -- who holds each is asked before it moves, once a run, and each is told
      -- after the row, where it arrives or leaves (endRun in sqlite.ts).
      v_hung := '[]'::jsonb;
      IF NOT (v_broadcast_ops->-1->>'op' = 'replace' AND v_broadcast_ops->-1->>'path' = v_told_path) THEN
        v_run_carried := FALSE;
      END IF;
      IF NOT v_run_carried AND (v_op->'value') ? v_coll.parent_fk
         AND (v_op->'value'->>v_coll.parent_fk) IS DISTINCT FROM (v_row->>v_coll.parent_fk) THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('coll', r->'coll', 'id', r->'id', 'after', r->'row', 'carried', TRUE,
                                    'before', to_jsonb(_delta_holders(r->>'coll', r->'row', p_doc_name))) ORDER BY n), '[]'::jsonb)
          INTO v_hung FROM jsonb_array_elements(_delta_hanging_rows(v_coll_key, v_id)) WITH ORDINALITY AS e(r, n);
      END IF;

      -- Merge partial value into current row. The row keeps its id: one in
      -- the value is the path's, as an add's is (it renumbered the row).
      v_new_row := v_row || (v_op->'value') || jsonb_build_object('id', v_id);

      IF v_coll.temporal THEN
        -- One version per write: a version this write made (its valid_from is the
        -- write's NOW()) gives way to the next, rather than closing at the same
        -- instant and colliding with it on (id, valid_from).
        EXECUTE format(
          'DELETE FROM %I WHERE id = $1 AND valid_to IS NULL AND valid_from = $2',
          v_coll.table_name
        ) USING v_id, v_ts;
        EXECUTE format(
          'UPDATE %I SET valid_to = $2 WHERE id = $1 AND valid_to IS NULL',
          v_coll.table_name
        ) USING v_id, v_ts;

        v_new_row := v_new_row || jsonb_build_object('valid_from', v_ts, 'valid_to', NULL);

        EXECUTE format(
          'INSERT INTO %I AS t SELECT * FROM jsonb_populate_record(null::%I, $1) RETURNING to_jsonb(t.*)',
          v_coll.table_name, v_coll.table_name
        ) INTO v_new_row USING v_new_row;
      ELSE
        -- Non-temporal: UPDATE with merged row
        EXECUTE format(
          'DELETE FROM %I WHERE id = $1', v_coll.table_name
        ) USING v_id;
        EXECUTE format(
          'INSERT INTO %I AS t SELECT * FROM jsonb_populate_record(null::%I, $1) RETURNING to_jsonb(t.*)',
          v_coll.table_name, v_coll.table_name
        ) INTO v_new_row USING v_new_row;
      END IF;

      -- A list's root row written through the list stays in its scope, as an
      -- add through it is given its bindings: a field, a row or a merge that
      -- takes it out -- into another owner's list by its key, or out of a
      -- condition -- is refused, and the write undone (todo #6's review).
      -- Asked of the row as written, RLS or none; and of a single document's
      -- root named by its id, as above (0.10.0 review).
      IF v_coll_key = v_def.root_collection
         AND NOT _delta_row_in_scope(v_def, p_doc_name, v_coll_key, v_id) THEN
        RAISE EXCEPTION 'row not found: %/% -- the write would take it out of %',
          v_coll_key, v_id, p_doc_name
          USING ERRCODE = 'P0002';
      END IF;

      -- Strip temporal from broadcast
      IF v_coll.temporal THEN
        v_new_row := _delta_strip_temporal(v_new_row);
      END IF;

      -- a replace straight after a replace of the same row: one run, told once (as the root's, above)
      IF v_broadcast_ops->-1->>'op' = 'replace' AND v_broadcast_ops->-1->>'path' = v_told_path THEN
        v_broadcast_ops := jsonb_set(v_broadcast_ops, '{-1,value}', v_new_row);
        v_touched := jsonb_set(v_touched, ARRAY[v_run_at::text, 'after'], v_new_row);
      ELSE
        v_broadcast_ops := v_broadcast_ops || jsonb_build_array(
          jsonb_build_object('op', 'replace', 'path', v_told_path, 'value', v_new_row)
        );
        v_touched := v_touched || jsonb_build_array(jsonb_build_object(
          'coll', v_coll_key, 'id', v_id, 'before', to_jsonb(v_before), 'after', v_new_row));
        v_run_at := jsonb_array_length(v_touched) - 1;
      END IF;
      v_run_carried := v_run_carried OR jsonb_array_length(v_hung) > 0;
      v_touched := v_touched || v_hung;
      CONTINUE;
    END IF;

    RAISE EXCEPTION 'invalid op: % %', v_op->>'op', v_op->>'path' USING ERRCODE = '22023';
  END LOOP;

  -- Told: the writer's document and every other that holds a row changed,
  -- each what changed for it. The answer (and the ledger) keep the ops as
  -- written, so an undo walks back exactly what was done -- and so does the
  -- writer's entry in the log, once, for the custom documents (todo #44).
  v_version := _delta_tell(p_doc_name, v_touched, v_broadcast_ops);
  RETURN jsonb_build_object('version', v_version, 'ops', v_broadcast_ops);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION delta_apply(p_doc_name TEXT, p_ops JSONB)
RETURNS JSONB LANGUAGE sql AS $$ SELECT delta_apply(p_doc_name, p_ops, FALSE); $$;
