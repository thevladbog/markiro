import test from "node:test";
import assert from "node:assert/strict";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { forwardCommandFixture } from "./forward-command-fixture.mjs";
import { runUpgradeHostCommand } from "../host/upgrade-command.mjs";
async function fixture(t, mode) {
  const f = await forwardCommandFixture(t),
    original = f.options.runProcess,
    locks = [],
    cleanupDiagnostics = [];
  const oldIndex = await readFile(join(f.root, "upgrade-index.json"));
  let copyFailed = false;
  f.options.runProcess = async (request, recheck) => {
    locks.push(
      await lstat(join(f.root, ".deploy.lock")).then(
        () => true,
        () => false,
      ),
    );
    const args = request.args;
    if (request.executable === "/usr/bin/docker" && args[2] === "cp" && mode !== "observe") {
      copyFailed = true;
      throw Object.assign(new Error("private-initial-copy-sentinel"), {
        code: "ERR_HOST_PROCESS",
        terminationConfirmed: mode !== "unknown",
      });
    }
    if (copyFailed)
      cleanupDiagnostics.push(
        await readFile(join(f.directory, "failure.json")).then(
          () => true,
          () => false,
        ),
      );
    return original(request, recheck);
  };
  return {
    ...f,
    locks,
    cleanupDiagnostics,
    oldIndex,
    run: () => runUpgradeHostCommand([f.record.phase, f.directory], f.options),
  };
}
test("initializer children all hold the common lock before any typed ownership handoff", async (t) => {
  const f = await fixture(t, "observe");
  await assert.rejects(f.run());
  assert.ok(f.locks.length > 0);
  assert.ok(f.locks.every(Boolean));
  assert.deepEqual(await readFile(join(f.root, "upgrade-index.json")), f.oldIndex);
});
test("initiating extraction diagnostic is durable before confirmed cleanup and never includes raw text", async (t) => {
  const f = await fixture(t, "known");
  await assert.rejects(f.run());
  assert.ok(f.cleanupDiagnostics.length > 0);
  assert.ok(f.cleanupDiagnostics.every(Boolean));
  const bytes = await readFile(join(f.directory, "failure.json")),
    record = JSON.parse(bytes);
  assert.equal(record.operationId, f.input.identity.operationId);
  assert.equal(record.boundary, "verifyImages");
  assert.doesNotMatch(bytes.toString(), /private-initial-copy-sentinel/u);
  assert.equal(
    f.commands.some((r) => r.args[2] === "container" && r.args[3] === "rm"),
    true,
  );
  await assert.rejects(lstat(join(f.root, ".deploy.lock")), { code: "ENOENT" });
});
test("unknown inert extractor termination keeps common lock and issues no cleanup", async (t) => {
  const f = await fixture(t, "unknown");
  await assert.rejects(f.run());
  assert.ok(await lstat(join(f.root, ".deploy.lock")));
  assert.ok(await readFile(join(f.directory, "failure.json")));
  assert.deepEqual(f.cleanupDiagnostics, []);
  assert.deepEqual(await readFile(join(f.root, "upgrade-index.json")), f.oldIndex);
});
test("failed first diagnostic publication retains lock and never competes with cleanup or overwrites evidence", async (t) => {
  const f = await fixture(t, "known"),
    path = join(f.directory, "failure.json");
  await writeFile(path, "retained-first-fixture", { mode: 0o600 });
  await assert.rejects(f.run());
  assert.equal(await readFile(path, "utf8"), "retained-first-fixture");
  assert.ok(await lstat(join(f.root, ".deploy.lock")));
  assert.deepEqual(f.cleanupDiagnostics, []);
  assert.equal(
    f.commands.some((r) => r.args[2] === "container" && r.args[3] === "rm"),
    false,
  );
});
test("initializer authorization failure is diagnosed privately before any child", async (t) => {
  const f = await fixture(t, "observe");
  f.options.request = async () => ({ ok: false, status: 403 });
  await assert.rejects(f.run());
  assert.deepEqual(f.commands, []);
  const record = JSON.parse(await readFile(join(f.directory, "failure.json")));
  assert.equal(record.operationId, f.input.identity.operationId);
  assert.equal(record.boundary, "verifyRelease");
});
