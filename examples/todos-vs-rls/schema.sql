-- =========================================================================
-- examples/todos-vs-rls — schema + seed
-- =========================================================================
-- Three tables: users, teams, todos. Plus team membership. RLS on todos.
--
-- Policy: you see a todo if you own it OR you belong to its team.
-- This is the most restrictive shape RLS alone can enforce: a single
-- predicate over visible columns. Everything *beyond* that predicate
-- (projecting counts, injecting owner_id on write, dispatching on a
-- doc-name) lives outside RLS — that's what the delta side demonstrates.
-- =========================================================================

DROP TABLE IF EXISTS example_todos        CASCADE;
DROP TABLE IF EXISTS example_team_members CASCADE;
DROP TABLE IF EXISTS example_teams        CASCADE;
DROP TABLE IF EXISTS example_users        CASCADE;

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

CREATE TABLE example_todos (
  id         bigserial   PRIMARY KEY,
  owner_id   integer     NOT NULL REFERENCES example_users(id),
  team_id    integer     NOT NULL REFERENCES example_teams(id),
  text       text        NOT NULL,
  done       boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE example_todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE example_todos FORCE  ROW LEVEL SECURITY;

-- Visibility: own rows, OR rows in a team you belong to.
DROP POLICY IF EXISTS example_todos_visibility ON example_todos;
CREATE POLICY example_todos_visibility ON example_todos
  FOR ALL
  USING (
    owner_id = current_setting('app.user_id', true)::int
    OR team_id IN (
      SELECT team_id FROM example_team_members
      WHERE user_id = current_setting('app.user_id', true)::int
    )
  )
  WITH CHECK (
    owner_id = current_setting('app.user_id', true)::int
  );

-- Seed: Alice(1), Bob(2), Carol(3). Platform team(1), Design team(2).
-- Alice + Bob are on platform; Carol is on design; nobody crosses teams.
INSERT INTO example_users VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol');
INSERT INTO example_teams VALUES (1, 'Platform'), (2, 'Design');
INSERT INTO example_team_members VALUES (1, 1), (2, 1), (3, 2);

INSERT INTO example_todos (owner_id, team_id, text, done) VALUES
  (1, 1, 'wire up the bench',        true),
  (1, 1, 'document onOps',           true),
  (1, 1, 'answer dev-team question', false),
  (2, 1, 'review RLS policy',        false),
  (2, 1, 'deploy staging',           false),
  (3, 2, 'redesign landing page',    false);
