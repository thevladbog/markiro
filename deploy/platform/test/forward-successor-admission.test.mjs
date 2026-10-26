import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { forwardSuccessorFixture } from "./forward-successor-fixture.mjs";
import {
  failedForwardNames,
  readFailedForwardPredecessor,
  validateForwardSuccessorAdmission,
} from "../host/forward-successor-admission.mjs";
import { digest } from "../backup/schemas.mjs";
const check = (f) => validateForwardSuccessorAdmission(f.input, f);
test("genuine base-forward store failure admits one distinct canonical successor", async (t) => {
  const f = await forwardSuccessorFixture(t);
  assert.equal(JSON.parse(f.failedForwardBytes.state).sequence, 2);
  assert.equal(JSON.parse(f.failedForwardBytes.state).sourceRuntime, null);
  assert.equal(failedForwardNames.length, 13);
  assert.deepEqual(check(f), f.input);
  assert.equal(JSON.parse(f.failedForwardBytes.index).operationId, f.prior.identity.operationId);
});
test("caller bytes cannot forge filesystem absence provenance", async (t) => {
  const f = await forwardSuccessorFixture(t);
  assert.throws(() => check({ ...f, failedForwardBytes: { ...f.failedForwardBytes } }));
});
for (const field of [
  "sourceRuntime",
  "backup",
  "preparation",
  "sequence",
  "phase",
  "status",
  "migrationEntered",
])
  test(`denies changed prior journal ${field}`, async (t) => {
    const f = await forwardSuccessorFixture(t),
      s = JSON.parse(f.failedForwardBytes.state);
    s[field] =
      { sequence: 3, phase: "source-held", status: "completed", migrationEntered: false }[field] ??
      {};
    await f.put(
      join(f.root, "forward-recovery-operations", f.prior.identity.operationId, "state.json"),
      s,
    );
    f.failedForwardBytes = await f.refresh();
    f.input.priorForward.hashes.state = digest(f.failedForwardBytes.state);
    assert.throws(() => check(f));
  });
for (const path of ["retained", "activation", "consumption", "extra"])
  test(`denies present prior ${path} despite seq2`, async (t) => {
    const f = await forwardSuccessorFixture(t),
      id = f.prior.identity.operationId;
    const relative = {
      retained: `forward-retained-${id}.json`,
      activation: `../upgrade-operations/${id}/post-migration-activate/operation.json`,
      consumption: `forward-recovery-operations/${id}/activate-consumption.json`,
      extra: `forward-recovery-operations/${id}/backup.json`,
    }[path];
    await f.put(join(f.root, relative), {});
    await assert.rejects(f.refresh());
  });
for (const key of [
  "state",
  "prepareConsumption",
  "prepareOperation",
  "failure",
  "index",
  "predecessorIndex",
  "handoffIntent",
  "handoffSuccess",
  "installedExecutor",
  "backupRuntime",
  "delivery",
  "executionFence",
  "commandStarted",
])
  test(`denies unpinned or swapped ${key}`, async (t) => {
    const f = await forwardSuccessorFixture(t);
    f.failedForwardBytes[key][0] ^= 1;
    assert.throws(() => check(f));
  });
for (const change of [
  "recursive",
  "self",
  "executor",
  "dispatch",
  "ci",
  "expired",
  "product",
  "target",
  "configuration",
  "schema",
  "extra",
  "missing",
])
  test(`denies successor ${change}`, async (t) => {
    const f = await forwardSuccessorFixture(t);
    if (change === "recursive") {
      const s = JSON.parse(f.failedForwardBytes.state);
      s.admission.kind = "platform-forward-admission-successor";
      await f.put(
        join(f.root, "forward-recovery-operations", f.prior.identity.operationId, "state.json"),
        s,
      );
      f.failedForwardBytes = await f.refresh();
      f.input.priorForward.hashes.state = digest(f.failedForwardBytes.state);
    }
    if (change === "self") f.input.identity.operationId = f.prior.identity.operationId;
    if (change === "executor") f.input.identity.executorSha = f.prior.identity.executorSha;
    if (change === "dispatch") f.input.dispatch = f.prior.dispatch;
    if (change === "ci") f.input.executorCi = f.prior.executorCi;
    if (change === "expired") f.input.expiresAt = new Date(f.now - 1).toISOString();
    if (change === "product") f.input.identity.admission.manifest.sourceSha = "e".repeat(40);
    if (change === "target") f.input.identity.target.hostId = "other";
    if (change === "configuration") f.input.candidateConfigurationSha256 = "a".repeat(64);
    if (change === "schema") f.input.baseline.schema.migrationCount = "1";
    if (change === "extra") f.input.extra = true;
    if (change === "missing") delete f.input.priorForward.hashes.failure;
    assert.throws(() => check(f));
  });
test("fixed reader rejects traversal and caller-selected archive", async (t) => {
  const f = await forwardSuccessorFixture(t);
  await assert.rejects(readFailedForwardPredecessor(f.root, "../bad"));
  await assert.rejects(
    readFailedForwardPredecessor(f.root, f.prior.identity.operationId, {
      indexFromSuccessorArchive: true,
      successorOperationId: "../bad",
    }),
  );
});

for (const change of [
  "self-approval",
  "replay-attempt",
  "foreign-consumption",
  "foreign-input",
  "foreign-receipt",
  "foreign-runtime",
  "foreign-fence",
  "foreign-marker",
  "uncertain",
  "unknown-child",
  "wrong-boundary",
  "older-index",
  "handoff-index",
  "handoff-inode",
  "unbound-extra",
])
  test(`repinned genuine files still deny ${change}`, async (t) => {
    const f = await forwardSuccessorFixture(t),
      id = f.prior.identity.operationId;
    let key = "prepareOperation",
      record = JSON.parse(f.failedForwardBytes[key]);
    if (change === "self-approval") record.authorization.reviewerId = record.authorization.actorId;
    if (change === "replay-attempt") record.dispatch.runAttempt = "2";
    if (change === "foreign-input") record.operation.admission.dispatch.runId = "111";
    if (change === "foreign-consumption") {
      key = "prepareConsumption";
      record = JSON.parse(f.failedForwardBytes[key]);
      record.admissionSha256 = "f".repeat(64);
    }
    if (change === "foreign-receipt") {
      key = "installedExecutor";
      record = JSON.parse(f.failedForwardBytes[key]);
      record.executorSha = "2".repeat(40);
    }
    if (change === "foreign-runtime") {
      key = "backupRuntime";
      record = JSON.parse(f.failedForwardBytes[key]);
      record.executorSha = "2".repeat(40);
    }
    if (change === "foreign-fence") {
      key = "executionFence";
      record = JSON.parse(f.failedForwardBytes[key]);
      record.dispatch.runId = "111";
    }
    if (change === "foreign-marker") {
      key = "commandStarted";
      record = JSON.parse(f.failedForwardBytes[key]);
      record.operationId = f.input.identity.operationId;
    }
    if (["uncertain", "unknown-child", "wrong-boundary"].includes(change)) {
      key = "failure";
      record = JSON.parse(f.failedForwardBytes[key]);
      if (change === "uncertain") record.durabilityUncertain = true;
      if (change === "unknown-child") record.executable = "docker";
      if (change === "wrong-boundary") record.boundary = "createBackup";
    }
    if (change === "older-index") {
      key = "index";
      record = JSON.parse(f.failedForwardBytes.predecessorIndex);
    }
    if (change === "handoff-index") {
      key = "handoffIntent";
      record = JSON.parse(f.failedForwardBytes[key]);
      record.expectedSha256 = "f".repeat(64);
    }
    if (change === "handoff-inode") {
      key = "handoffSuccess";
      record = JSON.parse(f.failedForwardBytes[key]);
      record.archivedMetadata.ino = "123";
    }
    if (change === "unbound-extra") record.extra = true;
    const stateDir = join(f.root, "forward-recovery-operations", id),
      paths = {
        prepareOperation: join(f.directory, "operation.json"),
        prepareConsumption: join(stateDir, "prepare-consumption.json"),
        installedExecutor: join(f.root, `upgrade-installed-executor-${id}.json`),
        backupRuntime: join(f.root, `forward-backup-runtime-${id}.json`),
        executionFence: join(f.directory, "execution-fence.json"),
        commandStarted: join(f.directory, "command-started.json"),
        failure: join(f.directory, "failure.json"),
        index: join(f.root, "upgrade-index.json"),
        handoffIntent: join(stateDir, "handoff-intent.json"),
        handoffSuccess: join(stateDir, "handoff-success.json"),
      };
    await f.put(paths[key], record);
    f.failedForwardBytes = await f.refresh();
    f.input.priorForward.hashes = Object.fromEntries(
      Object.entries(f.failedForwardBytes).map(([k, v]) => [k, digest(v)]),
    );
    assert.throws(() => check(f));
  });

test("explicit history keeps immediate forward and older upgrade indexes distinct before and after handoff", async (t) => {
  const { readForwardHistory } = await import("../host/forward-history.mjs");
  const { mkdir, rename, writeFile } = await import("node:fs/promises");
  const f = await forwardSuccessorFixture(t),
    before = await readForwardHistory(f.root, f.input);
  assert.deepEqual(before.immediateIndex, f.failedForwardBytes.index);
  assert.deepEqual(before.failedUpgrade.index, f.failedForwardBytes.predecessorIndex);
  assert.notDeepEqual(before.immediateIndex, before.failedUpgrade.index);
  const destination = join(f.root, "forward-recovery-operations", f.input.identity.operationId);
  await mkdir(destination, { mode: 0o700 });
  await rename(join(f.root, "upgrade-index.json"), join(destination, "predecessor-index.json"));
  await writeFile(join(f.root, "upgrade-index.json"), f.encode({ foreign: true }), { mode: 0o600 });
  const after = await readForwardHistory(f.root, f.input, { ownIndexArchive: true });
  assert.deepEqual(after.immediateIndex, before.immediateIndex);
  assert.deepEqual(after.failedUpgrade, before.failedUpgrade);
  assert.deepEqual(
    validateForwardSuccessorAdmission(f.input, { ...f, failedForwardBytes: after.failedForward }),
    f.input,
  );
  await assert.rejects(readForwardHistory(f.root, f.input, { ownIndexArchive: "../../foreign" }));
});

for (const change of [
  "valid",
  "stage",
  "reason",
  "status",
  "bytesSeen",
  "limitBytes",
  "redirectCount",
  "extra",
])
  test(`historical read diagnostic ${change}`, async (t) => {
    const { withAdmissionReadStage, admissionReadFailure } =
      await import("../admission-read-failure.mjs");
    const { sanitizeHostFailure } = await import("../host/failure-diagnostic.mjs");
    const f = await forwardSuccessorFixture(t);
    let error;
    try {
      await withAdmissionReadStage("publisher", async (reject) => reject("http", { status: 502 }));
    } catch (e) {
      error = e;
    }
    const failure = structuredClone(
      sanitizeHostFailure(error, {
        operationId: f.prior.identity.operationId,
        phase: "admitted",
        boundary: "verifyAdmission",
        commandCategory: "validation",
      }),
    );
    if (change === "stage") failure.admissionRead.stage = "secret-query";
    if (change === "reason") failure.admissionRead.reason = "raw body";
    if (change === "status") failure.admissionRead.status = 600;
    if (change === "bytesSeen") failure.admissionRead.bytesSeen = 2097154;
    if (change === "limitBytes") failure.admissionRead.limitBytes = 99999999;
    if (change === "redirectCount") failure.admissionRead.redirectCount = 5;
    if (change === "extra") failure.admissionRead.url = "private-signed-url";
    await f.put(join(f.directory, "failure.json"), failure);
    f.failedForwardBytes = await f.refresh();
    f.input.priorForward.hashes.failure = digest(f.failedForwardBytes.failure);
    if (change === "valid") {
      assert.deepEqual(check(f), f.input);
      assert.equal(admissionReadFailure(JSON.parse(f.failedForwardBytes.failure)), undefined);
    } else assert.throws(() => check(f));
  });
