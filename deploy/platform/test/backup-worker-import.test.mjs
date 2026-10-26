import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { privateFixture } from "./host-fixtures.mjs";

test("staged backup image contains every transitive worker module before any database action", async (t) => {
  const f = await privateFixture(t);
  const runtime = join(f.root, "runtime");
  const source = fileURLToPath(new URL("../", import.meta.url));
  await mkdir(runtime, { mode: 0o700 });
  // This is the existing image's closed source cohort, without dependencies or
  // database credentials. Import the actual worker's relative module graph.
  for (const area of ["backup", "host", "postgres"])
    await cp(join(source, area), join(runtime, area), {
      recursive: true,
      filter: (path) => !path.endsWith("backup-ci.mjs"),
    });
  const worker = pathToFileURL(join(runtime, "backup/postgres-worker.mjs"));
  const text = await readFile(worker, "utf8");
  const imports = [...text.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/gu)].map(
    (match) => new URL(match[1], worker).href,
  );
  assert.ok(imports.length >= 6);
  assert.ok(imports.every((url) => url.startsWith(pathToFileURL(`${runtime}/`).href)));
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await Promise.all(${JSON.stringify(imports)}.map(p => import(p)))`,
    ],
    { cwd: runtime, env: { PATH: "/usr/bin:/bin" }, timeout: 10000, maxBuffer: 65536 },
  );
});
