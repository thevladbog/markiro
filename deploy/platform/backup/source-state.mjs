import { ensure } from "./schemas.mjs";

export async function noWriters(c, applicationName) {
  const r = await c.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' AND datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid() AND application_name<>$1`,
    [applicationName],
  );
  ensure(r.rows[0].n === 0);
  ensure(
    (
      await c.query(
        "SELECT count(*)::int AS n FROM pg_prepared_xacts WHERE database=current_database()",
      )
    ).rows[0].n === 0,
  );
}
