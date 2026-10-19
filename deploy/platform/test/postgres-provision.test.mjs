import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "markiro-provision-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sqlFile = join(directory, "roles.sql");
  await writeFile(sqlFile, "PRIVATE-SQL-PASSWORD", { mode: 0o600 });
  return sqlFile;
}

test("private SQL reaches PostgreSQL identity by stdin without credential arguments", async (t) => {
  const { provisionRoles } = await import("../postgres/provision.mjs");
  for (const compose of [false, true])
    await provisionRoles({
      compose,
      executable: process.execPath,
      prefix: [
        "-e",
        `
      const assert = require('node:assert/strict');
      assert.deepEqual(process.argv.slice(1), ['exec','${compose ? "-T" : "-i"}','--user','postgres','owned-postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','markiro']);
      let input = ''; process.stdin.on('data', b => input += b);
      process.stdin.on('end', () => assert.equal(input, 'PRIVATE-SQL-PASSWORD'));
    `,
        "--",
      ],
      container: "owned-postgres",
      env: { PATH: process.env.PATH },
      sqlFile: await fixture(t),
    });
});

test("failed SQL delivery never exposes echoed private SQL", async (t) => {
  const { provisionRoles } = await import("../postgres/provision.mjs");
  await assert.rejects(
    provisionRoles({
      executable: process.execPath,
      prefix: [
        "-e",
        "process.stdin.pipe(process.stderr); process.stdin.on('end', () => process.exit(1));",
        "--",
      ],
      container: "owned-postgres",
      env: {},
      sqlFile: await fixture(t),
    }),
    (error) =>
      error.message === "Private PostgreSQL role provisioning failed." && error.cause === undefined,
  );
});

test("role provisioning rejects nonprivate input before executing", async (t) => {
  const { provisionRoles } = await import("../postgres/provision.mjs");
  const sqlFile = await fixture(t);
  const { chmod } = await import("node:fs/promises");
  await chmod(sqlFile, 0o644);
  await assert.rejects(
    provisionRoles({
      executable: process.execPath,
      prefix: ["-e", "process.stdin.resume();", "--"],
      container: "postgres",
      env: {},
      sqlFile,
    }),
    /Private PostgreSQL role provisioning failed/,
  );
});
