-- Per-user list isolation via RLS. Copy into init_db/004-app.sql (or similar)
-- and substitute the placeholders: {{APP_ROLE}} / {{TABLE}} / {{USER_COL}}.
--
-- This is the PATTERN — delta's framework SQL handles delta_apply and
-- delta_open; all you need here is the role, its grants, and the policy
-- that binds visibility to `app.user_id`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{{APP_ROLE}}') THEN
    CREATE ROLE {{APP_ROLE}} LOGIN PASSWORD '{{APP_ROLE}}';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE {{DB}} TO {{APP_ROLE}};
GRANT USAGE ON SCHEMA public TO {{APP_ROLE}};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {{APP_ROLE}};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {{APP_ROLE}};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO {{APP_ROLE}};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {{APP_ROLE}};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO {{APP_ROLE}};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO {{APP_ROLE}};

-- FORCE is necessary so even the table owner obeys the policy; the app
-- role has BYPASSRLS off by default, so this also binds doc queries.
ALTER TABLE {{TABLE}} ENABLE ROW LEVEL SECURITY;
ALTER TABLE {{TABLE}} FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS {{TABLE}}_owner ON {{TABLE}};
CREATE POLICY {{TABLE}}_owner ON {{TABLE}}
  FOR ALL
  USING      ({{USER_COL}} = current_setting('app.user_id', true)::bigint)
  WITH CHECK ({{USER_COL}} = current_setting('app.user_id', true)::bigint);
