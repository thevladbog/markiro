import assert from "node:assert/strict";
import test from "node:test";
import { join, dirname } from "node:path";
import { appendFile, rename } from "node:fs/promises";
import { forwardActivationSuccessorFixture } from "./forward-activation-successor-fixture.mjs";
import { digest } from "../backup/schemas.mjs";
import { readFailedForwardPredecessor } from "../host/forward-successor-admission.mjs";
import {
  failedActivationNames,
  readFailedForwardActivationPredecessor,
  validateForwardActivationSuccessorAdmission,
} from "../host/forward-activation-successor-admission.mjs";
const check = (f) => validateForwardActivationSuccessorAdmission(f.input, f);
test("exact expired seq10 activation admits a distinct successor with both prior forward generations", async (t) => {
  const f = await forwardActivationSuccessorFixture(t);
  assert.equal(JSON.parse(f.failedActivationBytes.state).sequence, 10);
  assert.equal(JSON.parse(f.failedActivationBytes.beforeActivation).sequence, 6);
  assert.equal(JSON.parse(f.failedForwardBytes.state).sequence, 2);
  assert.deepEqual(check(f), f.input);
  await assert.rejects(readFailedForwardPredecessor(f.root, f.prior.identity.operationId));
  assert.ok(failedActivationNames.includes("lockSuccess"));
  assert.ok(failedActivationNames.includes("probeSuccess"));
});
test("JSON clones cannot mint failed activation reader provenance", async (t) => {
  const f = await forwardActivationSuccessorFixture(t);
  assert.throws(() => check({ ...f, failedActivationBytes: { ...f.failedActivationBytes } }));
});
for (const key of [
  "state",
  "beforeActivation",
  "prepareConsumption",
  "activateConsumption",
  "activationOperation",
  "index",
  "failure",
  "lockSuccess",
  "probeSuccess",
  "afterObservation",
  "retainedRuntime",
])
  test(`failed activation rejects swapped ${key}`, async (t) => {
    const f = await forwardActivationSuccessorFixture(t);
    f.failedActivationBytes[key][0] ^= 1;
    assert.throws(() => check(f));
  });
for (const change of [
  "phase",
  "code",
  "consumption",
  "before",
  "self-approval",
  "running-app",
  "replaced-app",
  "worker",
  "probe-unconfirmed",
  "lock-intent",
  "extra-generation",
  "expired",
  "same-executor",
  "same-dispatch",
])
  test(`repinned exact history rejects ${change}`, async (t) => {
    const f = await forwardActivationSuccessorFixture(t);
    const files = {
      phase: [join(f.activationDirectory, "failure.json"), "failure"],
      code: [join(f.activationDirectory, "failure.json"), "failure"],
      consumption: [
        join(
          f.root,
          "forward-recovery-operations",
          f.prior.identity.operationId,
          "activate-consumption.json",
        ),
        "activateConsumption",
      ],
      before: [
        join(
          f.root,
          "forward-recovery-operations",
          f.prior.identity.operationId,
          "before-post-migration-activate.json",
        ),
        "beforeActivation",
      ],
      "self-approval": [join(f.activationDirectory, "operation.json"), "activationOperation"],
      "running-app": [join(f.reconciliation, "after.json"), "afterObservation"],
      "replaced-app": [join(f.reconciliation, "after.json"), "afterObservation"],
      worker: [join(f.reconciliation, "after.json"), "afterObservation"],
      "probe-unconfirmed": [join(f.reconciliation, "probe-success.json"), "probeSuccess"],
      "lock-intent": [join(f.reconciliation, "lock-intent.json"), "lockIntent"],
      "extra-generation": [
        join(f.root, "forward-recovery-operations", f.prior.identity.operationId, "state.json"),
        "state",
      ],
    };
    if (files[change]) {
      const [path, key] = files[change],
        value = JSON.parse(f.failedActivationBytes[key]);
      if (change === "phase") value.phase = "edge-started";
      if (change === "code") value.code = "ERR_HOST_OBSERVATION";
      if (change === "consumption") value.admissionSha256 = "f".repeat(64);
      if (change === "before") value.sequence = 4;
      if (change === "self-approval") value.authorization.reviewerId = value.authorization.actorId;
      if (change === "running-app") value.containers.api.Running = true;
      if (change === "replaced-app") value.containers.edge.id = "f".repeat(64);
      if (change === "worker") value.workers = [{ pid: 123 }];
      if (change === "probe-unconfirmed") value.absent = false;
      if (change === "lock-intent") value.lockSha256 = "f".repeat(64);
      if (change === "extra-generation")
        value.admission.kind = "platform-forward-activation-successor";
      await f.put(path, value);
      if (change === "extra-generation") {
        await assert.rejects(f.refresh(), { code: "ERR_HOST_FORWARD_ADMISSION" });
        return;
      }
      f.failedActivationBytes = await f.refresh();
      f.input.priorActivation.hashes = Object.fromEntries(
        Object.entries(f.failedActivationBytes).map(([k, v]) => [k, digest(v)]),
      );
    }
    if (change === "expired") f.input.expiresAt = new Date(f.now - 1).toISOString();
    if (change === "same-executor") f.input.identity.executorSha = f.prior.identity.executorSha;
    if (change === "same-dispatch") f.input.dispatch = f.decision.dispatch;
    assert.throws(() => check(f));
  });
test("failed activation reader refuses traversal and caller-selected archive", async (t) => {
  const f = await forwardActivationSuccessorFixture(t);
  await assert.rejects(readFailedForwardActivationPredecessor(f.root, "../bad"));
  await assert.rejects(
    readFailedForwardActivationPredecessor(f.root, f.prior.identity.operationId, {
      successorOperationId: "../bad",
      indexFromSuccessorArchive: true,
    }),
  );
});

test("changed installed predecessor source is rejected by the genuine reader", async (t) => {
  const f = await forwardActivationSuccessorFixture(t);
  const source = join(
    dirname(f.root),
    "upgrade-bootstrap",
    f.prior.identity.executorSha,
    "deploy/platform/host/probe-worker.mjs",
  );
  await appendFile(source, "\n// changed after failure\n");
  await assert.rejects(f.refresh(), { code: "ERR_HOST_FORWARD_ADMISSION" });
});
test("restoring the original lock cannot admit a successor", async (t) => {
  const f = await forwardActivationSuccessorFixture(t);
  await rename(join(f.reconciliation, "lock"), join(f.root, ".deploy.lock"));
  await assert.rejects(f.refresh(), { code: "ERR_HOST_FORWARD_ADMISSION" });
});
test("unrecognized phase children reject before admission", async (t) => {
  const f = await forwardActivationSuccessorFixture(t);
  await f.put(join(f.activationDirectory, "unexpected.json"), {});
  await assert.rejects(f.refresh(), { code: "ERR_HOST_FORWARD_ADMISSION" });
});

for (const fault of ["pid", "mount-path", "postgres-image"])
  test(`fully repinned evidence rejects ${fault}`, async (t) => {
    const f = await forwardActivationSuccessorFixture(t);
    const names = [
      "probeInspection",
      "beforeObservation",
      "afterObservation",
      "lockIntent",
      "lockSuccess",
      "probeIntent",
      "probeSuccess",
      "retainedRuntime",
    ];
    const r = Object.fromEntries(
      names.map((name) => [name, JSON.parse(f.failedActivationBytes[name])]),
    );
    if (fault === "pid") r.probeInspection[0].State.Pid = 123;
    if (fault === "mount-path") {
      r.probeInspection[0].Mounts.find((m) => m.Destination === "/input/connections.json").Source =
        `${f.root}/probes/../escape/connections.json`;
      r.probeInspection[0].Mounts.find((m) => m.Destination === "/input/ca.crt").Source = join(
        f.root,
        "escape",
        "ca.crt",
      );
    }
    if (fault === "postgres-image") {
      const imageId = `sha256:${"1".repeat(64)}`;
      r.retainedRuntime.postgresImageId = imageId;
      r.retainedRuntime.images.postgres.Id = imageId;
      r.retainedRuntime.containers.postgres.Image = imageId;
      r.beforeObservation.containers.postgres.imageId = imageId;
      r.afterObservation.containers.postgres.imageId = imageId;
    }
    const probeHash = digest(f.encode(r.probeInspection));
    r.beforeObservation.probe.inspectionSha256 = probeHash;
    r.afterObservation.probe.inspectionSha256 = probeHash;
    r.lockIntent.observationSha256 = digest(f.encode(r.beforeObservation));
    r.lockSuccess.intentSha256 = digest(f.encode(r.lockIntent));
    r.probeIntent.observationSha256 = digest(f.encode(r.beforeObservation));
    r.probeIntent.inspectionSha256 = probeHash;
    r.probeSuccess.intentSha256 = digest(f.encode(r.probeIntent));
    r.probeSuccess.inspectionSha256 = probeHash;
    r.probeSuccess.observationSha256 = digest(f.encode(r.afterObservation));
    const files = {
      probeInspection: "probe-inspection.json",
      beforeObservation: "before.json",
      afterObservation: "after.json",
      lockIntent: "lock-intent.json",
      lockSuccess: "lock-success.json",
      probeIntent: "probe-intent.json",
      probeSuccess: "probe-success.json",
    };
    for (const name of names)
      await f.put(
        name === "retainedRuntime"
          ? join(f.root, `forward-retained-${f.prior.identity.operationId}.json`)
          : join(f.reconciliation, files[name]),
        r[name],
      );
    f.failedActivationBytes = await f.refresh();
    f.input.priorActivation.hashes = Object.fromEntries(
      Object.entries(f.failedActivationBytes).map(([k, v]) => [k, digest(v)]),
    );
    assert.throws(() => check(f));
  });
