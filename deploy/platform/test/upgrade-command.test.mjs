import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, writeFile, chmod, unlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { loadUpgradeOperation } from "../host/upgrade-command.mjs";
import { upgradeCommandFixture } from "./upgrade-command-fixture.mjs";
test("upgrade loader verifies exact installed closure, predecessor, operation and runtime before returning authority", async (t) => {
  const f = await upgradeCommandFixture(t);
  const loaded = await loadUpgradeOperation(f.directory, f.options);
  assert.equal(loaded.record.kind, "platform-upgrade-host-operation");
  assert.equal(
    loaded.record.operation.admission.identity.operationId,
    f.input.identity.operationId,
  );
  assert.ok(Object.isFrozen(loaded.record.operation.admission));
  assert.deepEqual(f.commands, []);
  await appendFile(join(f.installed, "deploy/platform/host/upgrade-state.mjs"), "\n");
  await assert.rejects(loaded.verifySources());
});
for (const kind of [
  "unknown record key",
  "unknown operation key",
  "unknown phase",
  "wrong dispatch",
  "rerun",
  "self approval",
  "wrong CI",
  "missing source",
  "extra source",
  "changed source",
  "public source",
  "linked source",
  "changed predecessor",
  "changed config",
  "expired",
  "wrong runtime",
  "foreign containers",
  "wrong directory",
  "ambient injection",
])
  test(`upgrade loader denies ${kind} before execution`, async (t) => {
    const f = await upgradeCommandFixture(t);
    if (kind === "unknown record key") f.record.command = "start";
    if (kind === "unknown operation key") f.record.operation.adapters = {};
    if (kind === "unknown phase") f.record.phase = "resume";
    if (kind === "wrong dispatch") f.record.dispatch = { ...f.record.dispatch, runId: "999" };
    if (kind === "rerun") f.record.dispatch.runAttempt = "2";
    if (kind === "self approval")
      f.record.authorization.reviewerId = f.record.authorization.actorId;
    if (kind === "wrong CI") f.receipt.ci = { ...f.receipt.ci, runId: "999" };
    const path = "deploy/platform/host/upgrade-state.mjs";
    if (kind === "missing source") delete f.receipt.files[path];
    if (kind === "extra source") f.receipt.files["extra.mjs"] = "a".repeat(64);
    if (kind === "changed source") await appendFile(join(f.installed, path), "\n");
    if (kind === "public source") await chmod(join(f.installed, path), 0o644);
    if (kind === "linked source") {
      await unlink(join(f.installed, path));
      await symlink(
        join(f.installed, "deploy/platform/host/upgrade-proofs.mjs"),
        join(f.installed, path),
      );
    }
    if (kind === "changed predecessor") await appendFile(join(f.root, "recovery-state.json"), " ");
    if (kind === "changed config")
      await appendFile(f.record.operation.configuration.runtimeSnapshot.path, "UNEXPECTED=value\n");
    if (kind === "expired")
      f.record.operation.admission.expiresAt = new Date(Date.now() - 1).toISOString();
    if (kind === "wrong runtime")
      await writeFile(
        join(f.root, `upgrade-backup-runtime-${f.input.identity.operationId}.json`),
        "{}",
      );
    if (kind === "foreign containers") f.record.operation.predecessorContainers.api = "invalid";
    if (kind === "ambient injection") f.options.ambient = { COMPOSE_FILE: "/foreign.yml" };
    await f.publish();
    await assert.rejects(
      loadUpgradeOperation(
        kind === "wrong directory" ? join(f.directory, "..") : f.directory,
        f.options,
      ),
    );
    assert.deepEqual(f.commands, []);
  });
test("loaded immutable authority detects operation and runtime byte changes", async (t) => {
  const f = await upgradeCommandFixture(t);
  const loaded = await loadUpgradeOperation(f.directory, f.options);
  await appendFile(join(f.directory, "operation.json"), " ");
  await assert.rejects(loaded.verifySources());
});
test("protected prepare refuses failed live release provenance before any stop and retains terminal journal", async (t) => {
  const f = await upgradeCommandFixture(t);
  await writeFile(join(f.directory, "github-token"), "fixture-private-token", { mode: 0o600 });
  const { runUpgradeHostCommand } = await import("../host/upgrade-command.mjs");
  let requests = 0,
    processes = 0;
  await assert.rejects(
    runUpgradeHostCommand(["prepare", f.directory], {
      ...f.options,
      request: async () => {
        requests++;
        return { ok: false, status: 403 };
      },
      runProcess: async () => {
        processes++;
        assert.fail("No process before release admission");
      },
    }),
  );
  assert.equal(requests, 1);
  assert.equal(processes, 0);
  const { readFile } = await import("node:fs/promises");
  const journal = JSON.parse(
    await readFile(join(f.root, "upgrade-operations", f.input.identity.operationId, "state.json")),
  );
  assert.equal(journal.phase, "admitted");
  assert.equal(journal.status, "recovery-required");
  for (const [key, path] of [
    ["original", "state.json"],
    ["acceptedRecovery", "recovery-state.json"],
    ["preparation", "recovery-preparation.json"],
  ])
    assert.deepEqual(await readFile(join(f.root, path)), f.predecessorBytes[key]);
});
test("loaded authority rejects a changed backup runtime before execution", async (t) => {
  const f = await upgradeCommandFixture(t);
  const loaded = await loadUpgradeOperation(f.directory, f.options);
  await appendFile(
    join(f.root, `upgrade-backup-runtime-${f.input.identity.operationId}.json`),
    " ",
  );
  await assert.rejects(loaded.verifySources());
});
test("return command consumes its own fresh phase and denies absent protected approval before starting old apps", async (t) => {
  const f = await upgradeCommandFixture(t);
  const { withUpgradeState } = await import("../host/upgrade-state.mjs");
  const { upgradeOldRuntime, upgradePreparation, upgradeHash } =
    await import("./upgrade-fixture.mjs");
  const { readFile, mkdir } = await import("node:fs/promises");
  const old = upgradeOldRuntime(f.input);
  old.containers = f.predecessorContainers;
  const proof = upgradePreparation(f.input, old);
  await withUpgradeState(f.root, f.input, async (s) => {
    await s.complete("admitted", old);
    await s.enter("old-stopped");
    f.stop();
    await s.complete("old-stopped");
    await s.enter("backup-verified");
    await s.complete("backup-verified", proof.backup, proof);
  });
  const path = join(f.root, "upgrade-operations", f.input.identity.operationId, "state.json");
  const b = await readFile(path);
  f.record.phase = "return-old";
  f.record.dispatch = { ...f.input.dispatch, runId: "987654333" };
  delete f.record.operation.connectionFile;
  delete f.record.operation.roleMapping;
  f.record.operation.decision = {
    version: 1,
    kind: "platform-upgrade-phase",
    phase: "return-old",
    identity: f.input.identity,
    prior: { sequence: 6, sha256: upgradeHash(b) },
    executorCi: f.input.executorCi,
    reviewedPlanSha256: f.input.reviewedPlanSha256,
    dispatch: f.record.dispatch,
    expiresAt: f.input.expiresAt,
  };
  const directory = join(f.directory, "..", "return-old");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "operation.json"), JSON.stringify(f.record), { mode: 0o600 });
  await writeFile(join(directory, "github-token"), "fixture-private-token", { mode: 0o600 });
  const { runUpgradeHostCommand } = await import("../host/upgrade-command.mjs");
  let requests = 0;
  await assert.rejects(
    runUpgradeHostCommand(["return-old", directory], {
      ...f.options,
      request: async () => {
        requests++;
        return { ok: false, status: 403 };
      },
      runProcess: async () => assert.fail("No start before approval"),
    }),
  );
  assert.equal(requests, 1);
  const journal = JSON.parse(await readFile(path));
  assert.equal(journal.phase, "return-admitted");
  assert.equal(journal.status, "recovery-required");
  assert.equal(journal.migrationEntered, false);
});
