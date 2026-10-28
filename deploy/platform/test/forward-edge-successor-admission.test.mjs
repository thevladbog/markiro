import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { digest } from "../backup/schemas.mjs";
import { validateForwardEdgeSuccessorAdmission } from "../host/forward-edge-successor-admission.mjs";
import { forwardEdgeSuccessorFixture } from "./forward-edge-successor-fixture.mjs";
const validate = (f) =>
  validateForwardEdgeSuccessorAdmission(f.input, {
    failedEdgeBytes: f.failedEdgeBytes,
    history: {
      original: f.originalPredecessorBytes,
      failedUpgrade: f.failedUpgradeBytes,
      failedForward: f.failedForwardBytes,
      failedForwardActivation: f.failedActivationBytes,
    },
    productMigrationProof: f.productMigrationProof,
    now: f.now,
  });
test("genuine seq12 stopped mixed-source predecessor admits exactly one new dispatch-bound generation", async (t) => {
  const f = await forwardEdgeSuccessorFixture(t);
  assert.deepEqual(validate(f), f.input);
  assert.ok(Object.isFrozen(validate(f)));
  f.now += 8 * 3600000;
  assert.deepEqual(validate(f), f.input);
  assert.notEqual(f.input.baseline.containers.api, f.prior.baseline.containers.api);
  assert.equal(f.input.baseline.containers.edge, f.prior.baseline.containers.edge);
});
for (const issue of [
  "fake reader",
  "wrong phase",
  "running source",
  "changed image",
  "changed schema",
  "old api",
  "new edge",
  "wrong run",
  "old executor",
  "changed hash",
])
  test(`failed edge predecessor refuses ${issue}`, async (t) => {
    const f = await forwardEdgeSuccessorFixture(t);
    if (issue === "fake reader") f.failedEdgeBytes = { ...f.failedEdgeBytes };
    if (issue === "wrong run") f.input.dispatch.runId = f.decision.dispatch.runId;
    if (issue === "old executor") {
      f.input.identity.executorSha = f.prior.identity.executorSha;
      f.input.dispatch.toolingSha = f.prior.identity.executorSha;
    }
    if (issue === "old api") f.input.baseline.containers.api = f.prior.baseline.containers.api;
    if (issue === "new edge") f.input.baseline.containers.edge = "e".repeat(64);
    if (issue === "changed hash") f.input.priorEdge.hashes.state = "e".repeat(64);
    const mutate = async (name, fn) => {
      const value = JSON.parse(f.failedEdgeBytes[name]);
      fn(value);
      const raw = Buffer.from(JSON.stringify(value) + "\n");
      const file =
        name === "state"
          ? join(f.root, "forward-recovery-operations", f.prior.identity.operationId, "state.json")
          : join(f.root, `forward-edge-source-${f.prior.identity.operationId}.json`);
      await f.put(file, raw);
      f.failedEdgeBytes = await f.refreshEdge();
      f.input.priorEdge.hashes[name] = digest(raw);
    };
    if (issue === "wrong phase")
      await mutate("state", (v) => {
        v.phase = "api-started";
      });
    if (issue === "running source")
      await mutate("sourceObservation", (v) => {
        v.containers.api.running = true;
      });
    if (issue === "changed image")
      await mutate("sourceObservation", (v) => {
        v.containers.api.imageId = "sha256:" + "e".repeat(64);
      });
    if (issue === "changed schema")
      await mutate("sourceObservation", (v) => {
        v.schema.schemaSha256 = "e".repeat(64);
      });
    assert.throws(() => validate(f));
  });
