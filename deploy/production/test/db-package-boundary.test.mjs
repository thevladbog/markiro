import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../..", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("the shared database barrel does not expose the server-only runtime migrator", async () => {
  const barrel = await read("packages/db/src/index.ts");

  assert.doesNotMatch(barrel, /runtime-migrate/);
});

test("the runtime migrator has one explicit server-only package subpath", async () => {
  const packageJson = JSON.parse(await read("packages/db/package.json"));

  assert.deepEqual(packageJson.exports["./runtime-migrate"], {
    types: "./dist/runtime-migrate.d.ts",
    default: "./dist/runtime-migrate.js",
  });
});

test("the packaged migration CLI imports the server implementation directly", async () => {
  const cli = await read("packages/db/src/migrate-cli.ts");

  assert.match(cli, /^import \{ runRuntimeMigrations \} from "\.\/runtime-migrate\.js";$/m);
});
