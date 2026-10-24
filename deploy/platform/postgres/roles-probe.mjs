/** Container-side assertions: only synthetic credentials from the task-private file. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { probePostgres } from "../host/probe-worker.mjs";
import { createRequire } from "node:module";
import { runRuntimeMigrations } from "../../../packages/db/dist/runtime-migrate.js";
const dbRequire = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
const apiRequire = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const { Client } = dbRequire("pg");
const { PgBoss } = apiRequire("pg-boss");
const { appPassword, migratorPassword } = JSON.parse(
  await readFile("/fixture/credentials.json", "utf8"),
);
const ca = await readFile("/fixture/ca.crt", "utf8");
const url = (user, password) => {
  const u = new URL("postgresql://db.private:5432/markiro");
  u.username = user;
  u.password = password;
  u.searchParams.set("sslmode", "verify-full");
  u.searchParams.set("sslrootcert", "/fixture/ca.crt");
  return u.href;
};
const appUrl = url("markiro_app", appPassword);
const migratorUrl = url("markiro_migrator", migratorPassword);
const checks = [];
let postgresVersion;
let phase = "pg-boss default create-schema";
let app, migrator, boss;
try {
  boss = new PgBoss({
    connectionString: appUrl,
    schema: "pgboss_platform",
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => {});
  await assert.rejects(boss.start(), { code: "42501" });
  await boss.stop({ graceful: false });
  boss = undefined;
  phase = "migration";
  for (let i = 0; i < 2; i++)
    await runRuntimeMigrations({
      databaseUrl: migratorUrl,
      migrationsFolder: "/workspace/packages/db/migrations",
      log: () => {},
    });
  checks.push("actual runtime migrations twice as migrator");
  phase = "role policy";
  app = new Client({ connectionString: appUrl });
  migrator = new Client({ connectionString: migratorUrl });
  await app.connect();
  await migrator.connect();
  postgresVersion = (await app.query("SHOW server_version")).rows[0].server_version;
  assert.match(postgresVersion, /^17\./u);
  const flags = await app.query(
    "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname IN ('markiro_app','markiro_migrator') ORDER BY rolname",
  );
  assert.equal(flags.rows.length, 2);
  for (const row of flags.rows)
    for (const key of [
      "rolsuper",
      "rolcreatedb",
      "rolcreaterole",
      "rolreplication",
      "rolbypassrls",
    ])
      assert.equal(row[key], false);
  assert.equal(
    (
      await app.query(
        "SELECT 1 FROM pg_auth_members WHERE member IN ('markiro_app'::regrole, 'markiro_migrator'::regrole)",
      )
    ).rowCount,
    0,
  );
  const owners = await app.query(
    "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p','S','v','m') AND c.relowner <> 'markiro_migrator'::regrole",
  );
  assert.equal(owners.rowCount, 0);
  for (const query of [
    "CREATE TABLE public.forbidden(id int)",
    "ALTER TABLE public.organization ADD COLUMN forbidden int",
    "CREATE ROLE forbidden",
    "SET ROLE markiro_migrator",
    "CREATE SCHEMA forbidden",
    "CREATE TABLE drizzle.forbidden(id int)",
    "SELECT * FROM drizzle.__drizzle_migrations",
    "CREATE TABLE pgboss.forbidden(id int)",
    "SELECT * FROM pgboss.legacy_probe",
    "CREATE DATABASE forbidden",
  ])
    await assert.rejects(app.query(query), (error) => ["42501", "3F000"].includes(error.code));
  checks.push("business and migration ownership, role escalation and schema DDL denial");
  phase = "business DML";
  // Migrator creates a later object AFTER all historical migrations; default ACLs
  // must cover future tables and sequences without another bootstrap grant.
  await migrator.query(
    "CREATE TABLE public.role_privilege_probe(id bigserial PRIMARY KEY, value text NOT NULL)",
  );
  const inserted = await app.query(
    "INSERT INTO public.role_privilege_probe(value) VALUES ($1) RETURNING id",
    ["synthetic"],
  );
  assert.equal(inserted.rowCount, 1);
  assert.equal((await app.query("SELECT id FROM public.role_privilege_probe")).rowCount, 1);
  assert.equal(
    (await app.query("UPDATE public.role_privilege_probe SET value = $1", ["updated"])).rowCount,
    1,
  );
  assert.equal((await app.query("DELETE FROM public.role_privilege_probe")).rowCount, 1);
  await assert.rejects(app.query("TRUNCATE public.role_privilege_probe"), { code: "42501" });
  await migrator.query("DROP TABLE public.role_privilege_probe");
  const organizationId = randomUUID();
  await app.query(
    "INSERT INTO public.organization (id,name,slug,created_at) VALUES ($1,$2,$1,now())",
    [organizationId, "Synthetic role test"],
  );
  assert.equal(
    (await app.query("SELECT id FROM public.organization WHERE id=$1", [organizationId])).rowCount,
    1,
  );
  assert.equal(
    (
      await app.query("UPDATE public.organization SET name=$2 WHERE id=$1", [
        organizationId,
        "Updated synthetic role test",
      ])
    ).rowCount,
    1,
  );
  assert.equal(
    (await app.query("DELETE FROM public.organization WHERE id=$1", [organizationId])).rowCount,
    1,
  );
  checks.push("business reads and future migration DML and sequences via default privileges");
  phase = "pg-boss lifecycle";
  boss = new PgBoss({
    connectionString: appUrl,
    schema: "pgboss_platform",
    createSchema: false,
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => {});
  await boss.start();
  await boss.createQueue("role-probe");
  const id = await boss.send("role-probe", { fixture: true });
  assert.equal(typeof id, "string");
  const jobs = await boss.fetch("role-probe");
  assert.equal(jobs.length, 1);
  await boss.complete("role-probe", id);
  await boss.deleteQueue("role-probe");
  await boss.stop();
  boss = undefined;
  boss = new PgBoss({
    connectionString: appUrl,
    schema: "pgboss_platform",
    createSchema: false,
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => {});
  await boss.start();
  await boss.stop();
  boss = undefined;
  checks.push("pinned pg-boss start/create/send/fetch/complete/delete/restart as app");
  phase = "missing preprovisioned queue schema";
  boss = new PgBoss({
    connectionString: appUrl,
    schema: "missing_queue_schema",
    createSchema: false,
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => {});
  await assert.rejects(boss.start(), { code: "3F000" });
  await boss.stop({ graceful: false });
  boss = undefined;
  phase = "TLS";
  for (const connectionString of [appUrl, migratorUrl]) {
    for (const mode of ["valid", "wrong-host", "untrusted", "plaintext"]) {
      const u = new URL(connectionString);
      u.search = "";
      if (mode === "wrong-host") u.hostname = "wrong.private";
      const client = new Client({
        connectionString: u.href,
        ssl:
          mode === "plaintext"
            ? false
            : { rejectUnauthorized: true, ...(mode === "untrusted" ? {} : { ca }) },
        connectionTimeoutMillis: 5000,
      });
      try {
        if (mode === "valid") {
          await client.connect();
          await client.query("SELECT 1");
        } else
          await assert.rejects(client.connect(), (error) =>
            mode === "wrong-host"
              ? error.code === "ERR_TLS_CERT_ALTNAME_INVALID"
              : mode === "plaintext"
                ? error.code === "28000"
                : ["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(
                    error.code,
                  ),
          );
      } finally {
        await client.end().catch(() => {});
      }
    }
  }
  checks.push("both logins verify CA and hostname; wrong CA, hostname and plaintext denied");
  phase = "catalog append-only host probe";
  const hostProbe = await probePostgres({
    Client,
    input: { appUrl, migrationUrl: migratorUrl },
    ca,
  });
  assert.equal(hostProbe.postgresVersion, postgresVersion);
  assert.equal(hostProbe.tls.san, "db.private");
  phase = "catalog exact privilege negatives";
  const appendOnly = [
    "release_catalog_publications",
    "release_catalog_objects",
    "release_catalog_reservations",
    "release_catalog_channel_events",
    "release_catalog_receipts",
    "release_catalog_oidc_bindings",
  ];
  const mutations = [];
  for (const table of appendOnly) {
    for (const privilege of ["SELECT", "INSERT"])
      mutations.push([
        `REVOKE ${privilege} ON public.${table} FROM markiro_app`,
        `GRANT ${privilege} ON public.${table} TO markiro_app`,
      ]);
    for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"])
      mutations.push([
        `GRANT ${privilege} ON public.${table} TO markiro_app`,
        `REVOKE ${privilege} ON public.${table} FROM markiro_app`,
      ]);
  }
  for (const privilege of ["SELECT", "INSERT", "UPDATE"])
    mutations.push([
      `REVOKE ${privilege} ON public.release_catalog_intents FROM markiro_app`,
      `GRANT ${privilege} ON public.release_catalog_intents TO markiro_app`,
    ]);
  for (const privilege of ["DELETE", "TRUNCATE"])
    mutations.push([
      `GRANT ${privilege} ON public.release_catalog_intents TO markiro_app`,
      `REVOKE ${privilege} ON public.release_catalog_intents FROM markiro_app`,
    ]);
  for (const table of ["release_catalog_channels", "release_catalog_epochs", "organization"])
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"])
      mutations.push([
        `REVOKE ${privilege} ON public.${table} FROM markiro_app`,
        `GRANT ${privilege} ON public.${table} TO markiro_app`,
      ]);
  // Effective grants through PUBLIC are just as dangerous as direct grants.
  mutations.push([
    "GRANT UPDATE ON public.release_catalog_objects TO PUBLIC",
    "REVOKE UPDATE ON public.release_catalog_objects FROM PUBLIC",
  ]);
  // A similarly named future table is not an append-only exception.
  await migrator.query("CREATE TABLE public.release_catalog_future_probe(id int)");
  mutations.push([
    "REVOKE UPDATE, DELETE ON public.release_catalog_future_probe FROM markiro_app",
    "GRANT UPDATE, DELETE ON public.release_catalog_future_probe TO markiro_app",
  ]);
  try {
    for (const [change, restore] of mutations) {
      await migrator.query(change);
      try {
        await assert.rejects(
          probePostgres({ Client, input: { appUrl, migrationUrl: migratorUrl }, ca }),
        );
      } finally {
        await migrator.query(restore);
      }
    }
    await probePostgres({ Client, input: { appUrl, migrationUrl: migratorUrl }, ca });
  } finally {
    await migrator.query("DROP TABLE public.release_catalog_future_probe");
  }
  checks.push(
    "exact append-only catalog privileges accepted and every missing or excess grant rejected",
  );
  phase = "effective host probe privilege negatives";
  await migrator.query("CREATE SEQUENCE public.host_probe_sequence");
  try {
    for (const [revoke, grant] of [
      [
        "REVOKE USAGE ON SCHEMA public FROM markiro_app",
        "GRANT USAGE ON SCHEMA public TO markiro_app",
      ],
      [
        "REVOKE USAGE ON SEQUENCE public.host_probe_sequence FROM markiro_app",
        "GRANT USAGE ON SEQUENCE public.host_probe_sequence TO markiro_app",
      ],
      [
        "REVOKE SELECT ON SEQUENCE public.host_probe_sequence FROM markiro_app",
        "GRANT SELECT ON SEQUENCE public.host_probe_sequence TO markiro_app",
      ],
    ]) {
      await migrator.query(revoke);
      try {
        await assert.rejects(
          probePostgres({ Client, input: { appUrl, migrationUrl: migratorUrl }, ca }),
        );
      } finally {
        await migrator.query(grant);
      }
      await probePostgres({ Client, input: { appUrl, migrationUrl: migratorUrl }, ca });
    }
  } finally {
    await migrator.query("DROP SEQUENCE public.host_probe_sequence");
  }
  checks.push("fixed host probe read-only policy and independent TLS negatives");
  checks.push(
    "effective schema USAGE and current sequence USAGE/SELECT revocation rejected and restored",
  );
  const apiManifest = JSON.parse(
    await readFile(new URL("../../../apps/api/package.json", import.meta.url), "utf8"),
  );
  process.stdout.write(
    JSON.stringify({
      checks,
      postgresVersion,
      pgBossVersion: apiManifest.dependencies["pg-boss"],
    }) + "\n",
  );
} catch (error) {
  // Never emit queries, URLs, credentials or row contents, including assertion diffs.
  let cause = error;
  for (let depth = 0; depth < 5 && cause?.cause; depth++) cause = cause.cause;
  if (typeof error.query === "string") {
    if (/CREATE SCHEMA/i.test(error.query)) phase += " create-schema";
    else if (/CREATE EXTENSION/i.test(error.query)) phase += " create-extension";
    else if (/CREATE TABLE/i.test(error.query)) phase += " create-table";
    else if (/ALTER TABLE/i.test(error.query)) phase += " alter-table";
  }
  if (/permission denied for database/.test(cause?.message ?? "")) phase += " database-privilege";
  process.stderr.write(
    `Role probe failed at ${phase}; code=${/^[A-Z0-9_]{3,48}$/u.test(cause?.code ?? "") ? cause.code : "ASSERTION"}\n`,
  );
  process.exitCode = 1;
} finally {
  await boss?.stop().catch(() => {});
  await app?.end().catch(() => {});
  await migrator?.end().catch(() => {});
}
