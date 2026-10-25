import { randomUUID } from "node:crypto";
import { mkdir, writeFile, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { privateFixture } from "./host-fixtures.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  validateForwardAdmission,
  validateForwardDecision,
  readFailedUpgradePredecessor,
} from "../host/forward-admission.mjs";
import { forwardFixture, forwardPrepared, forwardDecision } from "./forward-fixture.mjs";
import { upgradeBytes, upgradeHash } from "./upgrade-fixture.mjs";
const validate = (f) => validateForwardAdmission(f.input, f);
test("forward admission authenticates full seq14 failed chain without reusing historical authorization", () => {
  const f = forwardFixture();
  assert.deepEqual(validate(f), f.input);
  assert.ok(Object.isFrozen(validate(f)));
});
for (const kind of [
  "pre-migration",
  "healthy",
  "entered",
  "unknown-phase",
  "sequence",
  "before",
  "consumption",
  "prepare-consumption",
  "operation",
  "approval",
  "physical",
  "schema",
  "product",
  "source",
  "config",
  "index",
  "same-run",
  "same-uuid",
  "old-executor",
  "attempt",
  "expired",
  "long-ttl",
  "original",
])
  test(`forward admission denies ${kind}`, () => {
    const f = forwardFixture();
    const change = (name, action) => {
      const r = JSON.parse(f.failedBytes[name]);
      action(r);
      f.failedBytes[name] = upgradeBytes(r);
      f.input.failed.hashes[name] = upgradeHash(f.failedBytes[name]);
    };
    if (kind === "pre-migration")
      change("state", (s) => {
        s.migrationEntered = false;
      });
    if (kind === "healthy")
      change("state", (s) => {
        s.status = "completed";
      });
    if (kind === "entered")
      change("state", (s) => {
        s.status = "entered";
      });
    if (kind === "unknown-phase")
      change("state", (s) => {
        s.phase = "unknown";
      });
    if (kind === "sequence")
      change("state", (s) => {
        s.sequence = 12;
      });
    if (kind === "before")
      change("beforeActivate", (s) => {
        s.backup.archiveSha256 = "a".repeat(64);
      });
    if (kind === "consumption")
      change("activateConsumption", (s) => {
        s.dispatch.runId = "555";
      });
    if (kind === "prepare-consumption")
      change("prepareConsumption", (s) => {
        s.admissionSha256 = "a".repeat(64);
      });
    if (kind === "operation")
      change("activateOperation", (s) => {
        s.operation.decision.dispatch.runId = "555";
      });
    if (kind === "approval")
      change("activateOperation", (s) => {
        s.authorization.reviewerId = s.authorization.actorId;
      });
    if (kind === "physical") f.input.baseline.containers.postgres = "f".repeat(64);
    if (kind === "schema") f.input.baseline.schema.systemId = "foreign-db";
    if (kind === "product")
      f.productMigrationProof = { ...f.productMigrationProof, proofSha256: "f".repeat(64) };
    if (kind === "source") f.input.identity.admission.manifest.sourceSha = "e".repeat(40);
    if (kind === "config") f.input.failedConfigurationSha256 = "f".repeat(64);
    if (kind === "index")
      change("index", (s) => {
        s.stateSha256 = "a".repeat(64);
      });
    if (kind === "same-run") f.input.dispatch.runId = f.records.state.decision.dispatch.runId;
    if (kind === "same-uuid")
      f.input.identity.operationId = f.records.state.admission.identity.operationId;
    if (kind === "old-executor") {
      f.input.identity.executorSha = f.records.state.admission.identity.executorSha;
      f.input.dispatch.toolingSha = f.input.identity.executorSha;
    }
    if (kind === "attempt") f.input.dispatch.runAttempt = "2";
    if (kind === "expired") f.now = Date.parse(f.input.expiresAt);
    if (kind === "long-ttl") f.input.expiresAt = new Date(f.now + 3600001).toISOString();
    if (kind === "original") f.originalPredecessorBytes.original = Buffer.from("{}");
    assert.throws(() => validate(f));
  });
test("activation is a separate fresh protected decision over the exact completed preparation", () => {
  const f = forwardFixture(),
    prior = forwardPrepared(f),
    decision = forwardDecision(f, prior);
  assert.deepEqual(
    validateForwardDecision(decision, { prior, priorBytes: upgradeBytes(prior), now: f.now }),
    decision,
  );
  for (const patch of [
    { expiresAt: new Date(f.now).toISOString() },
    { phase: "activate" },
    { phase: "return-old" },
    { dispatch: f.input.dispatch },
    { prior: { sequence: 6, sha256: "a".repeat(64) } },
  ])
    assert.throws(() =>
      validateForwardDecision(
        { ...decision, ...patch },
        { prior, priorBytes: upgradeBytes(prior), now: f.now },
      ),
    );
});

test("failed predecessor reader preserves all exact bytes at fixed state and input paths", async (t) => {
  const f = forwardFixture(),
    directory = await privateFixture(t, { nested: true });
  const id = f.records.state.admission.identity.operationId;
  const prefix = join(directory.root, "upgrade-operations", id);
  const paths = {
    state: join(prefix, "state.json"),
    beforeActivate: join(prefix, "before-activate.json"),
    prepareConsumption: join(prefix, "prepare-consumption.json"),
    activateConsumption: join(prefix, "activate-consumption.json"),
    index: join(directory.root, "upgrade-index.json"),
    prepareOperation: join(
      dirname(directory.root),
      "upgrade-operations",
      id,
      "prepare",
      "operation.json",
    ),
    activateOperation: join(
      dirname(directory.root),
      "upgrade-operations",
      id,
      "activate",
      "operation.json",
    ),
  };
  for (const [key, path] of Object.entries(paths)) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, f.failedBytes[key], { mode: 0o600 });
  }
  assert.deepEqual(await readFailedUpgradePredecessor(directory.root, id), f.failedBytes);
  await assert.rejects(readFailedUpgradePredecessor(directory.root, "../escape"));
  await unlink(paths.prepareConsumption);
  await symlink(paths.state, paths.prepareConsumption);
  await assert.rejects(readFailedUpgradePredecessor(directory.root, id));
});

test("configuration snapshot identity remains separate from deployment operation identity", () => {
  const f = forwardFixture(),
    candidateId = randomUUID();
  for (const name of ["prepareOperation", "activateOperation"]) {
    const record = JSON.parse(f.failedBytes[name]);
    record.operation.configuration.candidateId = candidateId;
    f.failedBytes[name] = upgradeBytes(record);
    f.input.failed.hashes[name] = upgradeHash(f.failedBytes[name]);
  }
  assert.deepEqual(validate(f), f.input);
});
