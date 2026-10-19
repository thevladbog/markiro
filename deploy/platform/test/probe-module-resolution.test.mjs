import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { privateFixture } from "./host-fixtures.mjs";
import { loadPostgresClient } from "../host/probe-worker.mjs";

test("probe resolves pg from the real pnpm package rather than its symlink location", async (t) => {
  const { root } = await privateFixture(t);
  const virtual = join(root, "node_modules/.pnpm/db/node_modules");
  const db = join(virtual, "@markiro/db");
  await mkdir(db, { recursive: true });
  await mkdir(join(virtual, "pg"), { recursive: true });
  await writeFile(join(db, "package.json"), '{"name":"@markiro/db"}');
  await writeFile(join(virtual, "pg/index.js"), "exports.Client = class Client {};\n");
  await mkdir(join(root, "node_modules/@markiro"), { recursive: true });
  const linked = join(root, "node_modules/@markiro/db");
  await symlink(db, linked);
  const manifest = join(linked, "package.json");
  assert.throws(() => createRequire(manifest)("pg"), { code: "MODULE_NOT_FOUND" });
  assert.equal(loadPostgresClient(manifest).name, "Client");
  assert.throws(() => loadPostgresClient(join(root, "missing/package.json")), { code: "ENOENT" });
});
