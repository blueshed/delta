-- =========================================================================
-- Delta-doc: identity-wrapped call variants (1-RTT hot path)
-- =========================================================================
--
-- Every authenticated doc operation is logically two things:
--   1. Scope the session: `SELECT set_config('app.user_id', <id>, true)`
--   2. Call the op:       `SELECT delta_apply(...)` / `delta_open(...)`
--
-- The naive client does this as two separate round-trips inside an explicit
-- BEGIN / COMMIT — four RTTs per op. These wrappers collapse it to one:
-- the SELECT's implicit transaction scopes `set_config(..., true)`, which
-- RLS policies read via `current_setting('app.user_id', true)`.
--
--   SELECT delta_apply_as('42', 'todos:42', '[{...}]'::jsonb);
--
-- No explicit transaction, no client-side set_config, no client checkout.
-- =========================================================================

CREATE OR REPLACE FUNCTION delta_open_as(p_user_id TEXT, p_doc_name TEXT)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.user_id', p_user_id, true);
  RETURN delta_open(p_doc_name);
END
$$;

CREATE OR REPLACE FUNCTION delta_apply_as(p_user_id TEXT, p_doc_name TEXT, p_ops jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.user_id', p_user_id, true);
  RETURN delta_apply(p_doc_name, p_ops);
END
$$;

CREATE OR REPLACE FUNCTION delta_open_at_as(p_user_id TEXT, p_doc_name TEXT, p_at TIMESTAMPTZ)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.user_id', p_user_id, true);
  RETURN delta_open_at(p_doc_name, p_at);
END
$$;
