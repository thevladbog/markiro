import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * What `export.sql` may be, checked without a database: it runs against the
 * owner's restored copy of the cloud and must be able to change nothing there.
 * (The live test in export-sql.test.mjs proves the transaction refuses a write.)
 */
const sql = readFileSync(new URL("../export.sql", import.meta.url), "utf8");

/** The script without comments and without the inside of string literals. */
const bare = sql.replace(/--[^\n]*/gu, "").replace(/'(?:[^']|'')*'/gu, "''");
const statements = bare
  .split(";")
  .map((statement) => statement.replace(/\s+/gu, " ").trim())
  .filter((statement) => statement !== "");

test("export.sql is one read-only repeatable-read transaction around one SELECT", () => {
  assert.equal(statements.length, 3, statements.map((each) => each.slice(0, 40)).join(" | "));
  assert.equal(statements[0], "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.match(statements[1], /^WITH prefixes AS \(/u);
  assert.equal(statements[2], "COMMIT");
});

test("export.sql holds no statement, function or psql command that writes", () => {
  const forbidden =
    /\b(?:insert|update|delete|drop|create|alter|truncate|grant|revoke|copy|vacuum|analyze|lock|call|do|merge|refresh|reindex|cluster|comment|set|reset|notify|listen|prepare|execute|into|nextval|setval|lastval|set_config|pg_[a-z_]+|lo_[a-z_]+|dblink[a-z_]*)\b/iu;
  const found = forbidden.exec(bare);
  assert.equal(found, null, `export.sql uses ${found?.[0]}`);
  assert.doesNotMatch(bare, /^\s*\\/mu, "export.sql runs a psql meta-command");
  // The tenant arrives as a psql variable, quoted by psql, never spliced into text.
  assert.doesNotMatch(bare, /:tenant_id\b/u);
  assert.ok(bare.includes(":''"), "the tenant variable is quoted");
});
