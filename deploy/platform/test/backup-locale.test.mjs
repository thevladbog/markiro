import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import * as locale from "../backup/locale.mjs";
const libc = { encoding: "UTF8", collate: "C", ctype: "C", provider: "c" };
const icu = {
  ...libc,
  provider: "i",
  icuLocale: "en-US",
  icuRules: null,
  collationVersion: "153.136",
  actualCollationVersion: "153.136",
};
test("locale validation preserves exact libc shape and admits genuine ICU metadata", () => {
  assert.deepEqual(locale.validateLocale(libc), libc);
  assert.deepEqual(locale.validateLocale(icu), icu);
  for (const bad of [
    { ...icu, provider: "b" },
    { ...icu, collationVersion: null },
    { ...icu, actualCollationVersion: "" },
    { ...icu, actualCollationVersion: "153.120" },
    { ...icu, icuLocale: "a\0b" },
    { ...icu, icuRules: "x".repeat(65537) },
    { ...icu, extra: true },
    { ...libc, icuLocale: "en-US" },
  ])
    assert.throws(() => locale.validateLocale(bad));
  const missing = { ...icu };
  delete missing.icuRules;
  assert.throws(() => locale.validateLocale(missing));
});
test("catalog capture projects legacy libc and retains genuine ICU fields", async () => {
  for (const value of [libc, icu]) {
    const actual = await locale.captureLocale({
      query: async (sql) => {
        assert.match(sql, /datlocale/);
        assert.match(sql, /daticurules/);
        assert.match(sql, /pg_database_collation_actual_version/);
        return {
          rows: [
            {
              ...value,
              ...(value.provider === "c"
                ? {
                    icuLocale: null,
                    icuRules: null,
                    collationVersion: null,
                    actualCollationVersion: null,
                  }
                : {}),
            },
          ],
        };
      },
    });
    assert.deepEqual(actual, value);
  }
});
test("database SQL safely quotes custom rules and never forges versions", () => {
  const sql = locale.createDatabaseSql({
    name: 'db"name',
    owner: "owner",
    locale: { ...icu, icuRules: "&a < 'b' \\ c;--" },
  });
  assert.match(
    sql,
    /TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' LOCALE_PROVIDER icu ICU_LOCALE 'en-US'/,
  );
  assert.ok(sql.includes("ICU_RULES '&a < ''b'' \\ c;--'"));
  assert.doesNotMatch(sql, /COLLATION_VERSION|REFRESH/i);
  assert.equal(
    locale.createDatabaseSql({ name: "db", owner: "owner", locale: libc }),
    `CREATE DATABASE "db" OWNER "owner" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' LOCALE_PROVIDER libc`,
  );
});
test("early locale comparison fails genuine runtime mismatches", async () => {
  await assert.rejects(
    locale.compareDatabaseLocale(
      {
        query: async () => ({
          rows: [{ ...icu, collationVersion: "153.120", actualCollationVersion: "153.120" }],
        }),
      },
      icu,
    ),
  );
  await locale.compareDatabaseLocale({ query: async () => ({ rows: [icu] }) }, icu);
});
test("ICU restore requires C/C and cannot accept a legacy or unsupported runtime", async () => {
  assert.throws(() => locale.validateLocale({ ...icu, collate: "en_US.UTF-8" }));
  for (const actual of [libc, { ...icu, provider: "b" }, { ...icu, collationVersion: null }]) {
    await assert.rejects(
      locale.compareDatabaseLocale({ query: async () => ({ rows: [actual] }) }, icu),
    );
  }
});

test("worker compares database locale before loading extensions or objects", async () => {
  const worker = await readFile(new URL("../backup/postgres-worker.mjs", import.meta.url), "utf8");
  const create = worker.indexOf("await client.query(createDatabaseSql(database))");
  const compare = worker.indexOf("await compareDatabaseLocale(client, database.locale)");
  const extensions = worker.indexOf("for (const ext of expected.extensions)");
  const restore = worker.indexOf('await processRun("pg_restore"');
  assert.ok(create >= 0 && compare > create && extensions > compare && restore > extensions);
  assert.match(worker.slice(create, compare), /SET standard_conforming_strings=on/);
});
test("empty ICU rules stay distinct from absent rules and locale strings stay bounded", () => {
  assert.match(
    locale.createDatabaseSql({ name: "db", owner: "owner", locale: { ...icu, icuRules: "" } }),
    /ICU_RULES ''$/,
  );
  assert.doesNotMatch(
    locale.createDatabaseSql({ name: "db", owner: "owner", locale: icu }),
    /ICU_RULES/,
  );
  for (const field of ["icuLocale", "collationVersion", "actualCollationVersion"])
    for (const value of ["", "a\0b", "x".repeat(1025)])
      assert.throws(() => locale.validateLocale({ ...icu, [field]: value }));
});
