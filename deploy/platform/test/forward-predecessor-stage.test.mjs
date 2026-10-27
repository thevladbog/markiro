import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { privateFixture } from "./host-fixtures.mjs";
import {
  stageForwardPredecessor,
  priorForwardExecutor,
  stageFailedActivationExecutor,
  failedActivationExecutor,
} from "../forward-ci-predecessor.mjs";
test("rehearsal imports an exact distinct historical Git executor and its own proof/diagnostic modules", async (t) => {
  const f = await privateFixture(t, { nested: true });
  const staged = await stageForwardPredecessor({
    parent: dirname(f.root),
    command: (cmd, args, options) => promisify(execFile)(cmd, args, options),
  });
  assert.equal(staged.executorSha, priorForwardExecutor);
  assert.ok(Object.keys(staged.files).length > 40);
  assert.equal(typeof staged.preparation.executeForwardPreparation, "function");
  assert.equal(typeof staged.product.extractProductMigrationProof, "function");
  let error;
  try {
    await staged.reads.withAdmissionReadStage("publisher", async (reject) =>
      reject("http", { status: 502 }),
    );
  } catch (e) {
    error = e;
  }
  assert.equal(staged.reads.admissionReadFailure(error).stage, "publisher");
  await staged.verify();
});

test("expired activation rehearsal stages exact main9c independently of current and older executor", async (t) => {
  const f = await privateFixture(t, { nested: true });
  const staged = await stageFailedActivationExecutor({
    parent: dirname(f.root),
    command: (cmd, args, options) => promisify(execFile)(cmd, args, options),
  });
  assert.equal(staged.executorSha, "9c5240964bcf8869838e5574015d2838f3c42d57");
  assert.equal(staged.executorSha, failedActivationExecutor);
  assert.notEqual(staged.executorSha, priorForwardExecutor);
  assert.equal(Object.keys(staged.files).length, 83);
  assert.equal(typeof staged.state.withForwardActivationState, "function");
  assert.equal(typeof staged.backup.createHeldForwardBackup, "function");
  assert.equal(typeof staged.command.loadUpgradeOperation, "function");
  assert.equal(
    staged.files["deploy/platform/host/forward-activation-successor-admission.mjs"],
    undefined,
  );
  const { appendFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await appendFile(
    join(staged.installedRoot, "deploy/platform/host/forward-state.mjs"),
    "\n// altered\n",
  );
  await assert.rejects(staged.verify());
});
