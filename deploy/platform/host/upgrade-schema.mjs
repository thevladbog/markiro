import { ensure } from "../backup/schemas.mjs";
import { createDockerCommand, guarded } from "./observe.mjs";
import { withHeldUpgradeState } from "./upgrade-state.mjs";
import { validateUpgradeSchema } from "./upgrade-proofs.mjs";

// Same-cluster pre-migration comparison, not a cross-cluster restore digest.
// Include catalog identities/definitions/ownership/ACLs and password changes,
// but emit only server-side hashes. Never return role secrets or customer rows.
// Vacuum/analyze counters and transaction horizons are not schema changes.
const catalogs = {
  pg_database: ["datfrozenxid", "datminmxid"],
  pg_namespace: [],
  pg_class: [
    "relpages",
    "reltuples",
    "relallvisible",
    "relallfrozen",
    "relfrozenxid",
    "relminmxid",
  ],
  pg_attribute: [],
  pg_attrdef: [],
  pg_type: [],
  pg_enum: [],
  pg_constraint: [],
  pg_index: [],
  pg_proc: [],
  pg_aggregate: [],
  pg_trigger: [],
  pg_rewrite: [],
  pg_depend: [],
  pg_shdepend: [],
  pg_extension: [],
  pg_sequence: [],
  pg_authid: [],
  pg_auth_members: [],
  pg_default_acl: [],
  pg_policy: [],
  pg_inherits: [],
  pg_partitioned_table: [],
  pg_collation: [],
  pg_operator: [],
  pg_opclass: [],
  pg_opfamily: [],
  pg_amop: [],
  pg_amproc: [],
  pg_foreign_server: [],
  pg_foreign_table: [],
  pg_user_mapping: [],
  pg_event_trigger: [],
};
const catalogFields = Object.entries(catalogs).map(([name, excluded]) => {
  const row = `to_jsonb(t) - ARRAY[${excluded.map((k) => `'${k}'`).join(",")}]::text[]`;
  return `'${name}', (SELECT coalesce(jsonb_agg(v ORDER BY v::text COLLATE "C"),'[]'::jsonb) FROM (SELECT ${row} AS v FROM pg_catalog.${name} t) s)`;
});
const digest = (expression) => `encode(sha256(convert_to((${expression})::text,'UTF8')),'hex')`;
// One SQL statement has one MVCC snapshot. An absent migration relation fails
// closed: this first upgrade requires the accepted platform's migration ledger.
export const upgradeSchemaQuery = `SELECT jsonb_build_object(
 'systemId', (SELECT system_identifier::text FROM pg_control_system()),
 'schemaSha256', ${digest(`jsonb_build_object(${catalogFields.join(",\n")})`)},
 'migrationSha256', ${digest(`(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text COLLATE "C"),'[]'::jsonb) FROM drizzle.__drizzle_migrations m)`)},
 'migrationCount', (SELECT count(*)::text FROM drizzle.__drizzle_migrations)
)`;

export function createUpgradeSchemaObserver({ postgresId }, dependencies = {}) {
  ensure(typeof postgresId === "string" && /^[a-f0-9]{64}$/u.test(postgresId));
  return (capability) =>
    guarded(() =>
      withHeldUpgradeState(capability, async (held) => {
        const { root, state } = held;
        if (state.oldRuntime) ensure(state.oldRuntime.containers.postgres === postgresId);
        const command = createDockerCommand(
          { root, dockerConfig: `${root}/docker` },
          dependencies.runProcess,
          dependencies.signal,
        );
        await held.verify();
        const result = await command([
          "exec",
          "--user",
          "70:70",
          "--env",
          "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000",
          "--env",
          "PGCONNECT_TIMEOUT=10",
          postgresId,
          "psql",
          "-X",
          "--no-password",
          "--username",
          "postgres",
          "--dbname",
          "markiro",
          "--tuples-only",
          "--no-align",
          "--command",
          upgradeSchemaQuery,
        ]);
        await held.verify();
        return validateUpgradeSchema(JSON.parse(result.stdout), state.admission.identity);
      }),
    );
}
