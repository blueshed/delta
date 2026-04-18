-- =========================================================================
-- auth-jwt — reference users schema + login / register stored functions.
-- =========================================================================
--
-- Apply this alongside the @blueshed/delta/auth-jwt module. Consumers who
-- want a different identity schema (sessions, OAuth, custom tables) can
-- substitute their own `login` / `register` functions and pass the SQL
-- strings via `jwtAuth({ loginSql, registerSql })`.
--
-- Uses pgcrypto for bcrypt. Passwords are stored as bcrypt hashes; the
-- login function verifies with `crypt(password, hash)` which is
-- constant-time on match / mismatch.
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
  VALUES (p_name, p_email, crypt(p_password, gen_salt('bf')))
  RETURNING * INTO rec;
  RETURN jsonb_build_object('id', rec.id, 'name', rec.name, 'email', rec.email);
END;
$$;

-- login(email, password) → { id, name, email } or NULL on bad credentials.
CREATE OR REPLACE FUNCTION login(p_email TEXT, p_password TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  rec users;
BEGIN
  SELECT * INTO rec FROM users
  WHERE email = p_email AND password = crypt(p_password, password);
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id', rec.id, 'name', rec.name, 'email', rec.email);
END;
$$;
