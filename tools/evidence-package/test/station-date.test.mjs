import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runCli as executeCli } from "../cli.mjs";
import { captureStationProductionDate } from "../station-date.mjs";

const execFile = promisify(execFileCallback);
const toolRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function temporaryDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "markiro-station-date-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

function seedDatabase(path, rows, schema = "id TEXT PRIMARY KEY, production_date TEXT") {
  const database = new DatabaseSync(path);
  try {
    database.exec(`CREATE TABLE shift_mirror (${schema})`);
    const insert = database.prepare("INSERT INTO shift_mirror (id, production_date) VALUES (?, ?)");
    for (const row of rows) insert.run(row.id, row.productionDate);
  } finally {
    database.close();
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function filesystem(overrides = {}) {
  return { ...fsPromises, constants: fsConstants, ...overrides };
}

function outputCollector() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += chunk;
        return true;
      },
    },
    value: () => value,
  };
}

async function runCli(args) {
  try {
    const result = await execFile(process.execPath, [join(toolRoot, "station-date.mjs"), ...args], {
      encoding: "utf8",
    });
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : -1,
      stderr: error.stderr ?? "",
      stdout: error.stdout ?? "",
    };
  }
}

async function runPnpm(args) {
  try {
    const result = await execFile("corepack", ["pnpm", "evidence:station-date", ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : -1,
      stderr: error.stderr ?? "",
      stdout: error.stdout ?? "",
    };
  }
}

test("captures exactly one shift production date without changing the Station database", async (t) => {
  const root = await temporaryDirectory(t);
  const databasePath = join(root, "station-mirror.db");
  const outputPath = join(root, "station-production-date.json");
  seedDatabase(databasePath, [{ id: "shift-1", productionDate: "2026-08-24" }]);
  const before = sha256(await readFile(databasePath));

  const result = await runCli([databasePath, "shift-1", outputPath]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "Captured Station production date evidence: 1 row\n");
  const output = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(
    { ...output, capturedAt: "<captured>" },
    {
      version: 1,
      source: "station_mirror",
      shiftId: "shift-1",
      productionDate: "2026-08-24",
      capturedAt: "<captured>",
    },
  );
  assert.match(output.capturedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
  assert.equal(sha256(await readFile(databasePath)), before);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("accepts a null production date as an explicit Station value", async (t) => {
  const root = await temporaryDirectory(t);
  const databasePath = join(root, "station-mirror.db");
  const outputPath = join(root, "station-production-date.json");
  seedDatabase(databasePath, [{ id: "shift-null", productionDate: null }]);

  const result = await runCli([databasePath, "shift-null", outputPath]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).productionDate, null);
});

test("rejects zero matching rows and does not create evidence output", async (t) => {
  const root = await temporaryDirectory(t);
  const databasePath = join(root, "station-mirror.db");
  const outputPath = join(root, "station-production-date.json");
  seedDatabase(databasePath, [{ id: "shift-1", productionDate: "2026-08-24" }]);

  const result = await runCli([databasePath, "shift-1' OR 1=1 --", outputPath]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /must return exactly one row/i);
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
});

test("rejects duplicate matching rows and does not create evidence output", async (t) => {
  const root = await temporaryDirectory(t);
  const databasePath = join(root, "station-mirror.db");
  const outputPath = join(root, "station-production-date.json");
  seedDatabase(
    databasePath,
    [
      { id: "shift-1", productionDate: "2026-08-24" },
      { id: "shift-1", productionDate: "2026-08-25" },
    ],
    "id TEXT, production_date TEXT",
  );

  const result = await runCli([databasePath, "shift-1", outputPath]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /must return exactly one row/i);
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
});

test("rejects an incompatible Station schema with an operator-safe error", async (t) => {
  const root = await temporaryDirectory(t);
  const databasePath = join(root, "station-mirror.db");
  const outputPath = join(root, "station-production-date.json");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE shift_mirror (id TEXT PRIMARY KEY)");
  database.close();

  const result = await runCli([databasePath, "shift-1", outputPath]);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "evidence:station-date: Station database schema is incompatible\n");
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
});

for (const productionDate of ["2026-02-30", "24.08.2026", 20260824]) {
  test(`rejects invalid Station production date ${JSON.stringify(productionDate)}`, async (t) => {
    const root = await temporaryDirectory(t);
    const databasePath = join(root, "station-mirror.db");
    const outputPath = join(root, "station-production-date.json");
    seedDatabase(databasePath, [{ id: "shift-1", productionDate }]);

    const result = await runCli([databasePath, "shift-1", outputPath]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /production date must be null or a real YYYY-MM-DD date/i);
    await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  });
}

test("refuses an existing evidence output without changing its bytes", async (t) => {
  const root = await temporaryDirectory(t);
  const databasePath = join(root, "station-mirror.db");
  const outputPath = join(root, "station-production-date.json");
  seedDatabase(databasePath, [{ id: "shift-1", productionDate: "2026-08-24" }]);
  await writeFile(outputPath, "existing evidence\n");

  const result = await runCli([databasePath, "shift-1", outputPath]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /evidence output already exists/i);
  assert.equal(await readFile(outputPath, "utf8"), "existing evidence\n");
});

test("rejects an unsafe evidence output basename before staging", async (t) => {
  const root = await temporaryDirectory(t);
  const databasePath = join(root, "station-mirror.db");
  const unsafeOutputPath = join(root, `${"a".repeat(252)}.json`);
  seedDatabase(databasePath, [{ id: "shift-1", productionDate: "2026-08-24" }]);

  await assert.rejects(
    captureStationProductionDate(databasePath, "shift-1", unsafeOutputPath),
    /evidence output filename is invalid/i,
  );
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("atomically refuses an evidence output created after staging", async (t) => {
  const root = await temporaryDirectory(t);
  const databasePath = join(root, "station-mirror.db");
  const outputPath = join(root, "station-production-date.json");
  const foreignBytes = Buffer.from("foreign concurrent evidence\n");
  seedDatabase(databasePath, [{ id: "shift-1", productionDate: "2026-08-24" }]);
  let interleaved = false;
  const injectedFilesystem = filesystem({
    async link(existingPath, newPath) {
      interleaved = true;
      await writeFile(newPath, foreignBytes, { flag: "wx" });
      return fsPromises.link(existingPath, newPath);
    },
  });
  const stdout = outputCollector();
  const stderr = outputCollector();

  const code = await executeCli({
    action: () =>
      captureStationProductionDate(databasePath, "shift-1", outputPath, {
        filesystem: injectedFilesystem,
      }),
    args: [],
    command: "evidence:station-date",
    expectedArgs: 0,
    formatSuccess: () => "Captured Station production date evidence: 1 row\n",
    stderr: stderr.stream,
    stdout: stdout.stream,
    usage: "unused",
  });

  assert.equal(code, 1);
  assert.equal(stdout.value(), "");
  assert.match(stderr.value(), /evidence output already exists/i);
  assert.equal(interleaved, true);
  assert.deepEqual(await readFile(outputPath), foreignBytes);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("sanitizes and bounds a missing database path failure", async (t) => {
  const root = await temporaryDirectory(t);
  const databasePath = join(root, "secret-station-mirror.db");
  const outputPath = join(root, "station-production-date.json");

  const result = await runCli([databasePath, "shift-1", outputPath]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^evidence:station-date: filesystem operation failed/);
  assert.equal(result.stderr.includes(root), false);
  assert.equal(result.stderr.includes("secret-station-mirror.db"), false);
  assert.ok(Buffer.byteLength(result.stderr) <= 320);
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
});

test("accepts the documented pnpm separator", async (t) => {
  const root = await temporaryDirectory(t);
  const databasePath = join(root, "station-mirror.db");
  const outputPath = join(root, "station-production-date.json");
  seedDatabase(databasePath, [{ id: "shift-1", productionDate: "2026-08-24" }]);

  const result = await runPnpm(["--", databasePath, "shift-1", outputPath]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).shiftId, "shift-1");
});
