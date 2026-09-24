-- =========================================================================
-- Delta-doc: the ledger
-- =========================================================================
-- Every write, with its inverse, written in the write's own transaction, by the
-- database every process shares: so undo works across processes. The same
-- entry as the SQLite backend's (src/server/ledger.ts):
--
--   who     the identity that made the change, for the audit
--   cursor  the key undo walks, opaque here (eta passes its session)
--   undoes  the entry this one walked back (undo) or forward again (redo)
--
-- `_delta_ops_log` is a catch-up buffer, pruned within the hour; this is the
-- history, kept.
-- =========================================================================

CREATE TABLE IF NOT EXISTS _delta_ledger (
  id        BIGSERIAL PRIMARY KEY,
  doc_name  TEXT NOT NULL,
  version   BIGINT NOT NULL,
  ops       JSONB NOT NULL,
  inverse   JSONB NOT NULL,
  who       TEXT,
  cursor    TEXT,
  at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  undoes    BIGINT REFERENCES _delta_ledger (id),
  undoable  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_delta_ledger_doc ON _delta_ledger (doc_name, version);
CREATE INDEX IF NOT EXISTS idx_delta_ledger_cursor ON _delta_ledger (cursor);
CREATE INDEX IF NOT EXISTS idx_delta_ledger_undoes ON _delta_ledger (undoes);

-- ---------------------------------------------------------------------------
-- _delta_inverse: what applied ops walked back, read from the document as it
-- was. Applied ops are whole rows (/coll/id) or the root (/coll): an add is
-- removed, a remove added back, a replace replaced by its old self. Reverse
-- order, except that a run of removes (a row and the children its removal
-- cascaded to) comes back in its own order, parent first.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_inverse(p_before JSONB, p_ops JSONB)
RETURNS JSONB AS $$
DECLARE
  v_inverse JSONB := '[]'::jsonb;
  v_run     JSONB := '[]'::jsonb;
  v_op      JSONB;
  v_parts   TEXT[];
  v_prior   JSONB;
BEGIN
  FOR v_op IN SELECT * FROM jsonb_array_elements(COALESCE(p_ops, '[]'::jsonb)) LOOP
    v_parts := _delta_split_path(v_op->>'path');
    IF array_length(v_parts, 1) = 1 THEN
      v_prior := p_before->v_parts[1];
    ELSE
      v_prior := p_before->v_parts[1]->v_parts[2];
    END IF;
    IF v_prior IS NOT NULL AND jsonb_typeof(v_prior) = 'object' THEN
      v_prior := _delta_strip_temporal(v_prior);
    END IF;

    IF v_op->>'op' = 'remove' THEN
      v_run := v_run || jsonb_build_array(jsonb_build_object('op', 'add', 'path', v_op->>'path', 'value', v_prior));
    ELSE
      v_inverse := v_run || v_inverse;
      v_run := '[]'::jsonb;
      IF v_op->>'op' = 'add' THEN
        v_inverse := jsonb_build_array(jsonb_build_object('op', 'remove', 'path', v_op->>'path')) || v_inverse;
      ELSE
        v_inverse := jsonb_build_array(jsonb_build_object('op', 'replace', 'path', v_op->>'path', 'value', v_prior)) || v_inverse;
      END IF;
    END IF;
  END LOOP;
  RETURN v_run || v_inverse;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- delta_apply_logged: delta_apply, with its ledger entry, in one transaction.
-- A lock per document keeps another writer of it from landing between the read
-- the inverse is taken from and the write. Returns delta_apply's {version, ops}
-- with the inverse and the entry's id.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION delta_apply_logged(
  p_doc_name TEXT,
  p_ops      JSONB,
  p_who      TEXT,
  p_cursor   TEXT,
  p_undoable BOOLEAN DEFAULT TRUE,
  p_undoes   BIGINT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_before  JSONB;
  v_result  JSONB;
  v_inverse JSONB;
  v_entry   BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('delta:' || p_doc_name));
  v_before  := COALESCE(delta_open(p_doc_name), '{}'::jsonb);
  v_result  := delta_apply(p_doc_name, p_ops);
  v_inverse := _delta_inverse(v_before, v_result->'ops');
  IF jsonb_array_length(v_result->'ops') > 0 THEN
    INSERT INTO _delta_ledger (doc_name, version, ops, inverse, who, cursor, undoes, undoable)
      VALUES (p_doc_name, (v_result->>'version')::BIGINT, v_result->'ops', v_inverse, p_who, p_cursor, p_undoes, p_undoable)
      RETURNING id INTO v_entry;
  END IF;
  RETURN v_result || jsonb_build_object('inverse', v_inverse, 'entry', v_entry);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- The cursor: undo and redo walk one cursor's entries. An entry's `undoes`
-- links it to the entry it walked, so entries form chains; depth along a chain
-- says which way an entry went (even: forward, odd: back), and the tip -- the
-- entry nothing has walked yet -- is the one that counts. A fresh write ends
-- what could be redone; an entry not undoable (a fact) starts no chain.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_ledger_tip(p_cursor TEXT, p_back BOOLEAN)
RETURNS _delta_ledger AS $$
  WITH RECURSIVE chain(id, depth) AS (
    SELECT id, 0 FROM _delta_ledger WHERE cursor = p_cursor AND undoes IS NULL AND undoable
    UNION ALL
    SELECT l.id, c.depth + 1 FROM _delta_ledger l JOIN chain c ON l.undoes = c.id
  ),
  tips AS (
    SELECT c.id, c.depth FROM chain c
    WHERE NOT EXISTS (SELECT 1 FROM _delta_ledger w WHERE w.undoes = c.id)
  )
  SELECT l.* FROM _delta_ledger l JOIN tips t ON t.id = l.id
  WHERE CASE WHEN p_back THEN t.depth % 2 = 0
        ELSE t.depth % 2 = 1 AND l.undoable   -- a walk recorded as changing nothing is never redone
          AND l.id > COALESCE((SELECT MAX(id) FROM _delta_ledger WHERE cursor = p_cursor AND undoes IS NULL AND undoable), 0)
        END
  ORDER BY l.id DESC
  LIMIT 1;
$$ LANGUAGE sql STABLE;

-- JSON values the same, with JSON null and a missing value the same.
CREATE OR REPLACE FUNCTION _delta_same(a JSONB, b JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(a, 'null'::jsonb) = COALESCE(b, 'null'::jsonb);
$$;

-- _delta_walk_plan: what walking an entry does to the document as it is now
-- -- the rule of planWalk in src/server/ledger.ts. Only the fields the entry
-- changed are set back, each guarded by what the entry left there: a row it
-- changed gets back those fields if each still holds what it wrote; a row it
-- made is removed if it is as it was left; a row it removed comes back if
-- nobody has put one there. A guard that fails is a conflict, by path, and
-- then nothing is walked. Returns { ops } or { ops: [], conflict: [paths] }.
CREATE OR REPLACE FUNCTION _delta_walk_plan(p_entry _delta_ledger)
RETURNS JSONB AS $$
DECLARE
  v_doc      JSONB := COALESCE(delta_open(p_entry.doc_name), '{}'::jsonb);
  v_left     JSONB := '{}'::jsonb;   -- path -> what the entry left there (JSON null: it removed it)
  v_op       JSONB;
  v_parts    TEXT[];
  v_here     JSONB;
  v_wrote    JSONB;
  v_was      JSONB;
  v_fields   TEXT[];
  v_ops      JSONB := '[]'::jsonb;
  v_conflict JSONB := '[]'::jsonb;
BEGIN
  FOR v_op IN SELECT * FROM jsonb_array_elements(p_entry.ops) LOOP
    v_left := v_left || jsonb_build_object(v_op->>'path',
      CASE WHEN v_op->>'op' = 'remove' THEN 'null'::jsonb ELSE v_op->'value' END);
  END LOOP;
  FOR v_op IN SELECT * FROM jsonb_array_elements(p_entry.inverse) LOOP
    v_parts := _delta_split_path(v_op->>'path');
    v_here := CASE WHEN array_length(v_parts, 1) = 1 THEN v_doc->v_parts[1] ELSE v_doc->v_parts[1]->v_parts[2] END;
    IF v_here = 'null'::jsonb THEN v_here := NULL; END IF;
    v_wrote := NULLIF(v_left->(v_op->>'path'), 'null'::jsonb);
    IF v_op->>'op' = 'add' THEN
      IF v_here IS NOT NULL THEN v_conflict := v_conflict || to_jsonb(v_op->>'path');
      ELSE v_ops := v_ops || jsonb_build_array(v_op); END IF;
    ELSIF v_op->>'op' = 'remove' THEN
      IF v_here IS NULL OR EXISTS (
        SELECT 1 FROM jsonb_each(COALESCE(v_wrote, '{}'::jsonb)) w
         WHERE w.key NOT IN ('valid_from', 'valid_to') AND NOT _delta_same(v_here->w.key, w.value)
      ) THEN v_conflict := v_conflict || to_jsonb(v_op->>'path');
      ELSE v_ops := v_ops || jsonb_build_array(v_op); END IF;
    ELSE
      v_was := COALESCE(NULLIF(v_op->'value', 'null'::jsonb), '{}'::jsonb);
      SELECT array_agg(k ORDER BY k) INTO v_fields FROM (
        SELECT jsonb_object_keys(v_was) AS k
        UNION SELECT jsonb_object_keys(COALESCE(v_wrote, '{}'::jsonb))
      ) keys
      WHERE k NOT IN ('valid_from', 'valid_to') AND NOT _delta_same(v_was->k, v_wrote->k);
      CONTINUE WHEN v_fields IS NULL;
      IF v_here IS NULL OR EXISTS (SELECT 1 FROM unnest(v_fields) f WHERE NOT _delta_same(v_here->f, v_wrote->f)) THEN
        v_conflict := v_conflict || to_jsonb(v_op->>'path');
      ELSE
        v_ops := v_ops || jsonb_build_array(jsonb_build_object('op', 'replace', 'path', v_op->>'path',
          'value', (SELECT jsonb_object_agg(f, COALESCE(v_was->f, 'null'::jsonb)) FROM unnest(v_fields) f)));
      END IF;
    END IF;
  END LOOP;
  IF jsonb_array_length(v_conflict) > 0 THEN
    RETURN jsonb_build_object('ops', '[]'::jsonb, 'conflict', v_conflict);
  END IF;
  RETURN jsonb_build_object('ops', v_ops);
END;
$$ LANGUAGE plpgsql STABLE;

-- delta_walk: the cursor's next entry (p_back: the next to undo, else to
-- redo), walked through delta_apply_logged -- by its plan, above -- and
-- recorded as walking it. NULL when there is none.
--   p_dry    answer the plan ({ doc, entry, ops, conflict? }) and walk nothing
--   p_entry  walk only if this is the cursor's next entry (SQLSTATE 40001 → 409)
-- A conflict, a walk the document refuses, or one that changes nothing is
-- recorded all the same (no ops, not undoable: never redone), so the cursor
-- moves on to the entry before it instead of meeting it again for ever.
CREATE OR REPLACE FUNCTION delta_walk(
  p_cursor TEXT, p_who TEXT, p_back BOOLEAN, p_dry BOOLEAN DEFAULT FALSE, p_entry BIGINT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_entry   _delta_ledger;
  v_plan    JSONB;
  v_version BIGINT;
  v_skip    BIGINT;
BEGIN
  IF p_cursor IS NULL THEN RETURN NULL; END IF;
  -- one walker per cursor at a time: two undos pressed at once take two entries, not one twice
  PERFORM pg_advisory_xact_lock(hashtext('delta-cursor:' || p_cursor));
  v_entry := _delta_ledger_tip(p_cursor, p_back);
  IF v_entry.id IS NULL THEN RETURN NULL; END IF;
  IF p_entry IS NOT NULL AND p_entry <> v_entry.id THEN
    RAISE EXCEPTION 'The cursor''s next entry to % is %, not %',
      CASE WHEN p_back THEN 'undo' ELSE 'redo' END, v_entry.id, p_entry USING ERRCODE = '40001';
  END IF;
  -- the document's lock (delta_apply_logged takes it again): no writer lands between plan and walk
  PERFORM pg_advisory_xact_lock(hashtext('delta:' || v_entry.doc_name));
  v_plan := _delta_walk_plan(v_entry);
  IF p_dry THEN RETURN v_plan || jsonb_build_object('doc', v_entry.doc_name, 'entry', v_entry.id); END IF;
  IF NOT v_plan ? 'conflict' AND jsonb_array_length(v_plan->'ops') > 0 THEN
    BEGIN
      RETURN delta_apply_logged(v_entry.doc_name, v_plan->'ops', p_who, p_cursor, TRUE, v_entry.id)
        || jsonb_build_object('doc', v_entry.doc_name);
    EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE '22P02' OR SQLSTATE '23502' OR SQLSTATE '23505' OR SQLSTATE 'P0002' THEN
      v_plan := jsonb_build_object('ops', '[]'::jsonb,
        'conflict', (SELECT jsonb_agg(o->>'path') FROM jsonb_array_elements(v_plan->'ops') o));
    END;
  END IF;
  SELECT COALESCE((SELECT version FROM _delta_versions WHERE doc_name = v_entry.doc_name), 0) INTO v_version;
  INSERT INTO _delta_ledger (doc_name, version, ops, inverse, who, cursor, undoes, undoable)
    VALUES (v_entry.doc_name, v_version, '[]'::jsonb, '[]'::jsonb, p_who, p_cursor, v_entry.id, FALSE)
    RETURNING id INTO v_skip;
  RETURN jsonb_build_object('doc', v_entry.doc_name, 'ops', '[]'::jsonb, 'inverse', '[]'::jsonb, 'version', v_version, 'entry', v_skip)
    || CASE WHEN v_plan ? 'conflict' THEN jsonb_build_object('conflict', v_plan->'conflict') ELSE '{}'::jsonb END;
END;
$$ LANGUAGE plpgsql;

-- delta_undo / delta_redo: delta_walk for the cursor's next entry back or forward.
CREATE OR REPLACE FUNCTION _delta_walk(p_cursor TEXT, p_who TEXT, p_back BOOLEAN)
RETURNS JSONB AS $$ SELECT delta_walk(p_cursor, p_who, p_back); $$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION delta_undo(p_cursor TEXT, p_who TEXT DEFAULT NULL)
RETURNS JSONB AS $$ SELECT _delta_walk(p_cursor, p_who, TRUE); $$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION delta_redo(p_cursor TEXT, p_who TEXT DEFAULT NULL)
RETURNS JSONB AS $$ SELECT _delta_walk(p_cursor, p_who, FALSE); $$ LANGUAGE sql;

-- delta_history: a document's newest entries, each saying whether p_cursor
-- wrote it -- never who did, never a cursor.
CREATE OR REPLACE FUNCTION delta_history(p_doc_name TEXT, p_cursor TEXT, p_limit INT DEFAULT 50)
RETURNS JSONB AS $$
  SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'version')::BIGINT DESC), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'id', id, 'doc', doc_name, 'version', version, 'ops', ops, 'inverse', inverse,
      'at', (EXTRACT(EPOCH FROM at) * 1000)::BIGINT, 'undoable', undoable,
      'mine', p_cursor IS NOT NULL AND cursor = p_cursor
    ) AS e
    FROM _delta_ledger WHERE doc_name = p_doc_name
    ORDER BY version DESC LIMIT p_limit
  ) entries;
$$ LANGUAGE sql STABLE;

-- The same, with row-level security: app.user_id set for the transaction, as
-- delta_apply_as does (001f).
CREATE OR REPLACE FUNCTION delta_apply_logged_as(
  p_user_id TEXT, p_doc_name TEXT, p_ops JSONB, p_who TEXT, p_cursor TEXT,
  p_undoable BOOLEAN DEFAULT TRUE, p_undoes BIGINT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.user_id', p_user_id, true);
  RETURN delta_apply_logged(p_doc_name, p_ops, p_who, p_cursor, p_undoable, p_undoes);
END;
$$;

CREATE OR REPLACE FUNCTION delta_undo_as(p_user_id TEXT, p_cursor TEXT, p_who TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.user_id', p_user_id, true);
  RETURN _delta_walk(p_cursor, p_who, TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION delta_redo_as(p_user_id TEXT, p_cursor TEXT, p_who TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.user_id', p_user_id, true);
  RETURN _delta_walk(p_cursor, p_who, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION delta_walk_as(
  p_user_id TEXT, p_cursor TEXT, p_who TEXT, p_back BOOLEAN, p_dry BOOLEAN DEFAULT FALSE, p_entry BIGINT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.user_id', p_user_id, true);
  RETURN delta_walk(p_cursor, p_who, p_back, p_dry, p_entry);
END;
$$;
