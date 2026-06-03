-- =========================================================================
-- auth-jwt — reference users schema + login / register stored functions.
-- =========================================================================
--
-- Apply this alongside the @blueshed/delta/auth-jwt module. Consumers who
-- want a different identity schema (sessions, OAuth, custom tables) can
-- substitute their own `login` / `register` functions and pass the SQL
-- strings via `jwtAuth({ loginSql, registerSql })`.
--
-- Uses pgcrypto for bcrypt. Passwords are stored as bcrypt hashes at an
-- explicit work factor (cost 12 — tune via gen_salt('bf', N)). `login` always
-- runs one crypt() — even for an unknown email it compares against a fixed
-- dummy hash — so its timing does not reveal whether an email is registered.
-- =========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT        NOT NULL,
  email      TEXT        NOT NULL UNIQUE,
  password   TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- register(name, email, password) → { id, name, email }
--   Raises unique_violation (23505) when email already exists.
CREATE OR REPLACE FUNCTION register(p_name TEXT, p_email TEXT, p_password TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  rec users;
BEGIN
  INSERT INTO users (name, email, password)
  VALUES (p_name, p_email, crypt(p_password, gen_salt('bf', 12)))
  RETURNING * INTO rec;
  RETURN jsonb_build_object('id', rec.id, 'name', rec.name, 'email', rec.email);
END;
$$;

-- login(email, password) → { id, name, email } or NULL on bad credentials.
-- Always runs exactly one bcrypt crypt(): when the email is unknown it
-- compares against a fixed dummy hash, so an attacker can't tell a missing
-- account from a wrong password by timing (user-enumeration oracle).
CREATE OR REPLACE FUNCTION login(p_email TEXT, p_password TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  rec    users;
  v_hash TEXT;
  v_ok   BOOLEAN;
  -- A valid throwaway bcrypt hash (cost 12) to spend crypt() time on when the
  -- email doesn't exist. Its plaintext is irrelevant — it just equalises cost.
  c_dummy CONSTANT TEXT := '$2a$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW';
BEGIN
  SELECT * INTO rec FROM users WHERE email = p_email;
  v_hash := COALESCE(rec.password, c_dummy);
  v_ok   := (crypt(p_password, v_hash) = v_hash);
  IF rec.id IS NULL OR NOT v_ok THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object('id', rec.id, 'name', rec.name, 'email', rec.email);
END;
$$;
