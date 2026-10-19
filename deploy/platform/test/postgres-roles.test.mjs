import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("explicit provisioning separates business ownership, DML and queue-local DDL", async () => {
  const { roleProvisioningSql } = await import("../postgres/roles.mjs");
  const sql = roleProvisioningSql({
    appPassword: randomBytes(24).toString("hex"),
    migratorPassword: randomBytes(24).toString("hex"),
  }).replace(/PASSWORD [^\n]*/gu, "PASSWORD [redacted];");
  for (const name of ["markiro_app", "markiro_migrator"])
    assert.match(
      sql,
      new RegExp(
        `CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      ),
    );
  assert.match(sql, /Fresh markiro database required/);
  assert.ok(
    sql.indexOf("Fresh markiro database required") < sql.indexOf("CREATE ROLE markiro_app"),
  );
  assert.match(sql, /ALTER SCHEMA public OWNER TO markiro_migrator/);
  assert.match(sql, /CREATE SCHEMA drizzle AUTHORIZATION markiro_migrator/);
  assert.match(sql, /CREATE SCHEMA pgboss_platform AUTHORIZATION markiro_app/);
  assert.match(sql, /REVOKE ALL ON DATABASE markiro FROM PUBLIC/);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE markiro_migrator IN SCHEMA public/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO markiro_app/);
  assert.match(sql, /GRANT USAGE, SELECT ON SEQUENCES TO markiro_app/);
  assert.match(sql, /GRANT CREATE ON DATABASE markiro TO markiro_migrator/);
  assert.doesNotMatch(sql, /GRANT markiro_migrator|GRANT CREATE[^;]+markiro_app|SCHEMA pgboss\s/);
});

test("role provisioning quotes passwords and errors never disclose credentials", async () => {
  const { roleProvisioningSql } = await import("../postgres/roles.mjs");
  const sentinel = "PRIVATE-CREDENTIAL";
  const password = randomBytes(24).toString("hex") + "'\\$#";
  const sql = roleProvisioningSql({ appPassword: password, migratorPassword: password + "other" });
  assert.ok(sql.includes(password.replaceAll("'", "''")));
  for (const value of [
    undefined,
    {},
    { appPassword: sentinel, migratorPassword: "" },
    { appPassword: sentinel + "\0", migratorPassword: sentinel },
  ])
    assert.throws(
      () => roleProvisioningSql(value),
      (error) => !error.message.includes(sentinel),
    );
});

test("production bundle owns the real PostgreSQL role and TLS harness", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /node deploy\/platform\/postgres\/roles-ci\.mjs --local-ci/);
});
