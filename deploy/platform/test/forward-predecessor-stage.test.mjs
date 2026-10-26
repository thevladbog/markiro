import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { privateFixture } from "./host-fixtures.mjs";
import { stageForwardPredecessor, priorForwardExecutor } from "../forward-ci-predecessor.mjs";
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
