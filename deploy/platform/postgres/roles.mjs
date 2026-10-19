/** Explicit, one-time provisioning for an empty platform database.
 * Execute as the isolated bootstrap owner, before migrations. Never called by API
 * startup; existing deployments need a separately reviewed ownership mapping.
 * Returned SQL contains credentials: write a private file or stream, never log it.
 */
export function roleProvisioningSql(options) {
  const { appPassword, migratorPassword } = options ?? {};
  for (const password of [appPassword, migratorPassword])
    if (typeof password !== "string" || password.length < 24 || /[\0\r\n]/u.test(password))
      throw new Error("Invalid database role provisioning input.");
  if (appPassword === migratorPassword)
    throw new Error("Invalid database role provisioning input.");
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  return `BEGIN;
SET LOCAL standard_conforming_strings = on;
DO $fresh$
BEGIN
  IF current_database() <> 'markiro'
    OR (SELECT datdba <> current_user::regrole FROM pg_database WHERE datname = current_database())
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('markiro_app', 'markiro_migrator'))
    OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_')
    OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public' AND nspowner NOT IN (current_user::regrole, 'pg_database_owner'::regrole))
    OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace)
    OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace)
    OR EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'public'::regnamespace)
  THEN
    RAISE EXCEPTION 'Fresh markiro database required';
  END IF;
END
$fresh$;
CREATE ROLE markiro_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(appPassword)};
CREATE ROLE markiro_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(migratorPassword)};
REVOKE ALL ON DATABASE markiro FROM PUBLIC;
GRANT CONNECT ON DATABASE markiro TO markiro_app, markiro_migrator;
-- Drizzle executes CREATE SCHEMA IF NOT EXISTS even for a precreated schema.
-- PostgreSQL checks database CREATE first; this is not the CREATEDB role flag.
GRANT CREATE ON DATABASE markiro TO markiro_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO markiro_migrator;
CREATE SCHEMA drizzle AUTHORIZATION markiro_migrator;
CREATE SCHEMA pgboss_platform AUTHORIZATION markiro_app;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
GRANT USAGE ON SCHEMA public TO markiro_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO markiro_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO markiro_app;
ALTER DEFAULT PRIVILEGES FOR ROLE markiro_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO markiro_app;
ALTER DEFAULT PRIVILEGES FOR ROLE markiro_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO markiro_app;
COMMIT;
`;
}
