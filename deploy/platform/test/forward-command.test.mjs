import test from "node:test";
import assert from "node:assert/strict";
import { UPGRADE_BUNDLE_FILES } from "../host/upgrade-command.mjs";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { privateFixture } from "./host-fixtures.mjs";
const forwardFiles = [
  "forward-command-runtime.mjs",
  "forward-retained.mjs",
  "forward-activation-adapters.mjs",
  "forward-activation.mjs",
  "forward-preparation.mjs",
  "forward-observation.mjs",
  "forward-state.mjs",
  "forward-admission.mjs",
  "forward-product.mjs",
  "forward-ledger.mjs",
  "forward-index-handoff.py",
];
test("current upgrade closure declares every forward executable exactly once", () => {
  for (const file of forwardFiles)
    assert.equal(
      UPGRADE_BUNDLE_FILES.filter((p) => p === `deploy/platform/host/${file}`).length,
      1,
      file,
    );
});
test("verified installation can import the entire forward runtime in isolation", async (t) => {
  const f = await privateFixture(t);
  const source = fileURLToPath(new URL("../../../", import.meta.url));
  for (const path of UPGRADE_BUNDLE_FILES) {
    const dest = join(f.root, path);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await copyFile(join(source, path), dest);
  }
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(join(f.root, "deploy/platform/host/forward-command-runtime.mjs")).href)})`,
    ],
    { cwd: f.root, env: { PATH: "/usr/bin:/bin" }, timeout: 10000 },
  );
});
test("unvalidated records cannot execute forward code or inject dependencies", async () => {
  const { executeForwardOperation } = await import("../host/forward-command-runtime.mjs");
  let called = false;
  await assert.rejects(
    executeForwardOperation({
      record: {
        operation: {
          adapters: {
            migrate: () => {
              called = true;
            },
          },
        },
      },
    }),
  );
  assert.equal(called, false);
});
import { forwardCommandFixture } from "./forward-command-fixture.mjs";
import { loadUpgradeOperation } from "../host/upgrade-command.mjs";
import { appendFile, unlink } from "node:fs/promises";
test("forward loader authenticates historical sources without starting a process", async (t) => {
  const f = await forwardCommandFixture(t);
  const loaded = await loadUpgradeOperation(f.directory, f.options);
  assert.equal(loaded.record.phase, "post-migration-prepare");
  assert.deepEqual(f.commands, []);
  await appendFile(
    join(f.root, `forward-backup-runtime-${f.input.identity.operationId}.json`),
    " ",
  );
  await assert.rejects(loaded.verifySources());
});
for (const fault of [
  "missing closure",
  "changed closure",
  "callback",
  "wrong phase",
  "legacy phase",
  "ambient",
  "historical bytes",
  "moved history",
  "expired",
  "target",
  "product",
  "receipt",
])
  test(`forward loader refuses ${fault} before any child`, async (t) => {
    const f = await forwardCommandFixture(t);
    if (fault === "missing closure")
      delete f.receipt.files["deploy/platform/host/forward-ledger.mjs"];
    if (fault === "changed closure")
      await appendFile(join(f.installed, "deploy/platform/host/forward-ledger.mjs"), " ");
    if (fault === "callback") f.record.operation.adapters = { migrate: "unsafe" };
    if (fault === "wrong phase") f.record.phase = "resume";
    if (fault === "legacy phase") f.record.phase = "activate";
    if (fault === "ambient") f.options.ambient = { COMPOSE_FILE: "/foreign" };
    if (fault === "historical bytes")
      await appendFile(
        join(
          dirname(f.root),
          "recovery-bootstrap",
          f.input.originalPredecessor.identity.executorSha,
          "deploy/platform/old.mjs",
        ),
        " ",
      );
    if (fault === "moved history")
      await unlink(
        join(f.root, `upgrade-installed-executor-${f.input.failed.identity.operationId}.json`),
      );
    if (fault === "expired") f.input.expiresAt = new Date(Date.now() - 1).toISOString();
    if (fault === "target") f.input.identity.target.hostId = "f".repeat(32);
    if (fault === "product") f.input.identity.admission.manifest.sourceSha = "e".repeat(40);
    if (fault === "receipt") f.record.historicalSources.failedReceiptSha256 = "e".repeat(64);
    await f.publish();
    await assert.rejects(loadUpgradeOperation(f.directory, f.options));
    assert.deepEqual(f.commands, []);
  });
test("receiver can authenticate a forward envelope before private execution token arrives and never creates a container", async (t) => {
  const f = await forwardCommandFixture(t);
  await unlink(join(f.directory, "github-token"));
  await loadUpgradeOperation(f.directory, f.options);
  assert.deepEqual(f.commands, []);
});

test("execution mints pinned product proof before any ownership or application action", async (t) => {
  const f = await forwardCommandFixture(t);
  const { runUpgradeHostCommand } = await import("../host/upgrade-command.mjs");
  // This loader fixture intentionally does not emulate a live PG daemon.
  // Physical verification must reject after extraction and before handoff.
  await assert.rejects(runUpgradeHostCommand([f.record.phase, f.directory], f.options));
  assert.ok(f.commands.some((r) => r.args[2] === "cp" && r.outputLimitBytes === 16 * 1024 * 1024));
  assert.equal(
    f.commands.some(
      (r) => r.args.includes("up") || r.args.includes("start") || r.args.includes("run"),
    ),
    false,
  );
  await assert.rejects(
    readFile(
      join(
        f.root,
        "forward-recovery-operations",
        f.input.identity.operationId,
        "handoff-intent.json",
      ),
    ),
    { code: "ENOENT" },
  );
});
