-- =========================================================================
-- examples/todos-vs-rls — the policy, once generateSql has made the table
-- =========================================================================
-- Visibility: you see a todo if you own it OR you belong to its team.
-- A write must be your own. This is the most RLS alone can say: a predicate
-- over the row. Everything beyond it (counts, stamping the owner, which
-- lens a name opens, who may hear a name) lives outside the policy.
-- =========================================================================

ALTER TABLE example_todos
  ADD FOREIGN KEY (owner_id) REFERENCES example_users(id),
  ADD FOREIGN KEY (team_id)  REFERENCES example_teams(id);

ALTER TABLE example_todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE example_todos FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS example_todos_visibility ON example_todos;
CREATE POLICY example_todos_visibility ON example_todos
  FOR ALL
  USING (
    owner_id = NULLIF(current_setting('app.user_id', true), '')::int
    OR team_id IN (
      SELECT team_id FROM example_team_members
      WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::int
    )
  )
  WITH CHECK (
    owner_id = NULLIF(current_setting('app.user_id', true), '')::int
  );

-- The app role reads and writes every table (the framework's too), and RLS
-- decides which rows.
GRANT USAGE ON SCHEMA public TO example_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO example_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO example_app;

INSERT INTO example_todos (owner_id, team_id, text, done) VALUES
  (1, 1, 'wire up the bench',        true),
  (1, 1, 'document onOps',           true),
  (1, 1, 'answer dev-team question', false),
  (2, 1, 'review RLS policy',        false),
  (2, 1, 'deploy staging',           false),
  (3, 2, 'redesign landing page',    false);
