-- =========================================================================
-- Delta-doc: doc lookup, scope resolution, temporal helpers
-- =========================================================================

-- ---------------------------------------------------------------------------
-- _delta_find_doc: match a doc name to its definition
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_find_doc(p_doc_name TEXT)
RETURNS _delta_docs AS $$
  SELECT * FROM _delta_docs
   WHERE p_doc_name LIKE prefix || '%'
   ORDER BY length(prefix) DESC
   LIMIT 1;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- _delta_resolve_scope: turn a doc name + def into WHERE clause + metadata
--
-- Scope binding syntax:  { "column": "op:param" }
--   "=:name"      → column = <value>           (equality)
--   "<=:name"     → column <= <value>           (range)
--   ">=:name"     → column >= <value>           (range)
--   "like:name"   → column ILIKE <value>%       (prefix search)
--   "at:name"     → reserved: temporal snapshot  (not a WHERE condition)
--   ":name"       → shorthand for "=:name"
--
-- Named params are resolved positionally from the colon-separated doc ID.
-- Empty resolved values are skipped (no filter applied for that entry).
--
-- Returns JSONB:
--   { "where":  "SQL WHERE clause",
--     "values": { equality bindings for ADD ops },
--     "mode":   "list" | "single",
--     "at":     "2026-06-01" | null }
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_resolve_scope(p_def _delta_docs, p_doc_name TEXT)
RETURNS JSONB AS $$
DECLARE
  v_doc_id    TEXT;
  v_scope     JSONB;
  v_parts     TEXT[];
  v_key       TEXT;
  v_val       TEXT;
  v_op        TEXT;
  v_param     TEXT;
  v_resolved  TEXT;
  v_where     TEXT := '';
  v_values    JSONB := '{}'::jsonb;
  v_at        TEXT := NULL;
  v_mode      TEXT;
  v_param_map JSONB := '{}'::jsonb;
BEGIN
  v_doc_id := substring(p_doc_name FROM length(p_def.prefix) + 1);
  v_scope  := p_def.scope;

  -- Fail-fast: every scope key must be a real column of the root collection.
  -- Catches typos and the "dotted key" footgun (e.g. "kanban_boards.id")
  -- before they silently produce an always-empty WHERE.
  IF v_scope IS NOT NULL AND v_scope != '{}'::jsonb THEN
    DECLARE
      v_root_coll      RECORD;
      v_bad_key        TEXT;
      v_valid_keys_txt TEXT;
    BEGIN
      SELECT * INTO v_root_coll FROM _delta_collections
       WHERE collection_key = p_def.root_collection;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'doc "%" references unknown root collection: %',
          p_def.prefix, p_def.root_collection
          USING ERRCODE = 'P0001';
      END IF;

      -- "id" is implicit; parent_fk is implicit if set. `at:`-typed values
      -- feed the temporal snapshot marker and don't go through the WHERE,
      -- so their keys (typically `valid_from`) don't need to be real columns.
      SELECT k INTO v_bad_key
        FROM jsonb_each_text(v_scope) AS x(k, val)
       WHERE k != 'id'
         AND k IS DISTINCT FROM v_root_coll.parent_fk
         AND NOT (v_root_coll.columns_def ? k)
         AND val !~ '^at:'
       LIMIT 1;

      IF v_bad_key IS NOT NULL THEN
        SELECT 'id'
             || CASE WHEN v_root_coll.parent_fk IS NOT NULL
                     THEN ', ' || v_root_coll.parent_fk
                     ELSE '' END
             || COALESCE(
                  (SELECT ', ' || string_agg(kk, ', ')
                     FROM jsonb_object_keys(v_root_coll.columns_def) kk),
                  '')
          INTO v_valid_keys_txt;
        RAISE EXCEPTION
          'scope key "%" is not a column of "%" (valid keys: %)',
          v_bad_key, v_root_coll.collection_key, v_valid_keys_txt
          USING ERRCODE = 'P0001';
      END IF;
    END;
  END IF;

  -- Empty scope: default behaviour
  IF v_scope = '{}'::jsonb OR v_scope IS NULL THEN
    IF v_doc_id = '' THEN
      RETURN jsonb_build_object(
        'where', 'TRUE', 'values', '{}'::jsonb, 'mode', 'list', 'at', NULL
      );
    ELSE
      RETURN jsonb_build_object(
        'where', format('id = %L', v_doc_id),
        'values', jsonb_build_object('id', v_doc_id::BIGINT),
        'mode', 'single',
        'at', NULL
      );
    END IF;
  END IF;

  -- Build positional param map from colon-separated doc ID parts.
  -- Params named "id" always get position 1. Remaining params are assigned
  -- in alphabetical order to subsequent positions.
  v_parts := string_to_array(v_doc_id, ':');

  SELECT jsonb_object_agg(p, to_jsonb(COALESCE(v_parts[pos], '')))
  INTO v_param_map
  FROM (
    SELECT DISTINCT param AS p,
           row_number() OVER (ORDER BY (param != 'id'), param) AS pos
    FROM (
      SELECT CASE
        WHEN val ~ '^(at|like):' THEN substring(val FROM '[a-z]+:(.+)$')
        WHEN val ~ '^[<>=!]+:'   THEN substring(val FROM '[<>=!]+:(.+)$')
        ELSE ltrim(val, ':')
      END AS param
      FROM jsonb_each_text(v_scope) AS x(key, val)
    ) params
  ) ordered;

  -- Second pass: process each scope entry using the resolved param map
  FOR v_key, v_val IN SELECT * FROM jsonb_each_text(v_scope)
  LOOP
    -- Parse operator and param name
    IF v_val ~ '^(at):' THEN
      v_op    := 'at';
      v_param := substring(v_val FROM 'at:(.+)$');
    ELSIF v_val ~ '^(like):' THEN
      v_op    := 'like';
      v_param := substring(v_val FROM 'like:(.+)$');
    ELSIF v_val ~ '^[<>=!]+:' THEN
      v_op    := substring(v_val FROM '^([<>=!]+):');
      v_param := substring(v_val FROM '[<>=!]+:(.+)$');
      -- Defence in depth: the regex above only matches `<`, `>`, `=`, `!`
      -- characters, and the scope value is app-controlled (from _delta_docs),
      -- but we still whitelist the final operator so any future exposure of
      -- the scope DSL to user input can't smuggle arbitrary SQL into
      -- `format('%I %s %L', ...)`.
      IF v_op NOT IN ('=', '>=', '<=', '>', '<', '!=') THEN
        RAISE EXCEPTION
          'invalid scope operator "%" (valid: =, >=, <=, >, <, !=, like, at)',
          v_op USING ERRCODE = 'P0001';
      END IF;
    ELSE
      v_op    := '=';
      v_param := ltrim(v_val, ':');
    END IF;

    v_resolved := v_param_map ->> v_param;

    -- Skip empty resolved values (no filter)
    IF v_resolved IS NULL OR v_resolved = '' THEN CONTINUE; END IF;

    -- Handle each operator
    CASE v_op
      WHEN 'at' THEN
        v_at := v_resolved;

      WHEN 'like' THEN
        IF v_where != '' THEN v_where := v_where || ' AND '; END IF;
        v_where := v_where || format('%I ILIKE %L', v_key, v_resolved || '%');

      WHEN '=' THEN
        IF v_where != '' THEN v_where := v_where || ' AND '; END IF;
        v_where := v_where || format('%I = %L', v_key, v_resolved);
        v_values := v_values || jsonb_build_object(v_key, v_resolved);

      ELSE
        -- Range operators: >=, <=, >, <, !=
        IF v_where != '' THEN v_where := v_where || ' AND '; END IF;
        v_where := v_where || format('%I %s %L', v_key, v_op, v_resolved);
    END CASE;
  END LOOP;

  -- Default to no filter if nothing was added
  IF v_where = '' THEN v_where := 'TRUE'; END IF;

  -- Mode: single if we have an id equality, list otherwise
  IF v_values ? 'id' THEN
    v_mode := 'single';
  ELSE
    v_mode := 'list';
  END IF;

  RETURN jsonb_build_object('where', v_where, 'values', v_values, 'mode', v_mode, 'at', v_at);
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- _delta_strip_temporal: remove valid_from/valid_to/override from a JSONB row
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _delta_strip_temporal(p_row JSONB)
RETURNS JSONB AS $$ SELECT p_row - 'valid_from' - 'valid_to' - 'override'; $$ LANGUAGE sql IMMUTABLE;
