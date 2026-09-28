-- delta 0.10.0's delta_walk and delta_walk_as, as src/sql/001g-delta-ledger.sql had them at
-- v0.10.0: a database set up then, before a walk could name a change (tests/ledger-0.10.0-sql.test.ts).

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

CREATE OR REPLACE FUNCTION delta_walk_as(
  p_user_id TEXT, p_cursor TEXT, p_who TEXT, p_back BOOLEAN, p_dry BOOLEAN DEFAULT FALSE, p_entry BIGINT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.user_id', p_user_id, true);
  RETURN delta_walk(p_cursor, p_who, p_back, p_dry, p_entry);
END;
$$;
