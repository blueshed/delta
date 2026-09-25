-- =========================================================================
-- examples/todos-vs-rls — the tables delta does not manage, and the role
-- =========================================================================
-- Users, teams and who is on which team: reference data, read by both sides,
-- written by neither. The todos table is delta's: `generateSql` makes it from
-- the schema in setup.ts, and rls.sql puts the policy on it.
--
-- The compose stack's `delta` role is a superuser, so RLS never holds it.
-- Both sides therefore read and write as `example_app`: no superuser, no
-- BYPASSRLS, so the policy really does filter (the admin pool only sets up).
-- =========================================================================

DROP TABLE IF EXISTS example_todos        CASCADE;
DROP SEQUENCE IF EXISTS seq_example_todos;
DROP TABLE IF EXISTS example_team_members CASCADE;
DROP TABLE IF EXISTS example_teams        CASCADE;
DROP TABLE IF EXISTS example_users        CASCADE;
-- the framework's record of the example's documents, from a previous run
DELETE FROM _delta_versions WHERE doc_name LIKE 'todos-%';
DELETE FROM _delta_ops_log  WHERE doc_name LIKE 'todos-%';

CREATE TABLE example_users (
  id   integer PRIMARY KEY,
  name text    NOT NULL
);

CREATE TABLE example_teams (
  id   integer PRIMARY KEY,
  name text    NOT NULL
);

CREATE TABLE example_team_members (
  user_id integer NOT NULL REFERENCES example_users(id),
  team_id integer NOT NULL REFERENCES example_teams(id),
  PRIMARY KEY (user_id, team_id)
);

-- Seed: Alice(1), Bob(2), Carol(3). Platform team(1), Design team(2).
-- Alice + Bob are on platform; Carol is on design; nobody crosses teams.
INSERT INTO example_users VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol');
INSERT INTO example_teams VALUES (1, 'Platform'), (2, 'Design');
INSERT INTO example_team_members VALUES (1, 1), (2, 1), (3, 2);

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'example_app') THEN
    CREATE ROLE example_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'example_app';
  END IF;
END $$;
