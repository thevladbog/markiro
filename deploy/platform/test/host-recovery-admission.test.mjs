import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { hostIdentity, backupProof } from "./host-fixtures.mjs";

import { validateRecoveryAdmission } from "../host/recovery-admission.mjs";
const now = Date.parse("2026-10-20T00:00:00Z");
function fixture() {
  const prior = hostIdentity();
  const identity = structuredClone(prior);
  identity.operationId = "aacdbe29-3b3d-4bad-9222-9a8c2701c945";
  identity.executorSha = "b".repeat(40);
  const state = {
    version: 1,
    sequence: 14,
    previousHealthy: null,
    current: {
      identity: prior,
      phase: "api-started",
      status: "recovery-required",
      backup: backupProof(prior),
    },
  };
  const stateBytes = Buffer.from(JSON.stringify(state));
  const input = {
    version: 1,
    kind: "platform-failed-activation-recovery",
    identity,
    predecessor: {
      identity: prior,
      sequence: 14,
      stateSha256: createHash("sha256").update(stateBytes).digest("hex"),
    },
    executorCi: { runId: "123456789", runAttempt: "1" },
    expiresAt: "2026-10-20T00:30:00.000Z",
  };
  return { input, stateBytes, now };
}
function validate(f) {
  return validateRecoveryAdmission(f.input, { stateBytes: f.stateBytes, now: f.now });
}
test("recovery admission binds the failed journal bytes without changing either identity", () => {
  const f = fixture();
  const original = Buffer.from(f.stateBytes);
  const accepted = validate(f);
  assert.deepEqual(accepted, f.input);
  assert.notEqual(accepted, f.input);
  assert.deepEqual(f.stateBytes, original);
});
for (const [name, mutate] of [
  [
    "modified journal bytes",
    (f) => {
      f.stateBytes = Buffer.concat([f.stateBytes, Buffer.from(" ")]);
    },
  ],
  [
    "wrong predecessor sequence",
    (f) => {
      f.input.predecessor.sequence = 13;
    },
  ],
  [
    "wrong predecessor identity",
    (f) => {
      f.input.predecessor.identity.executorSha = "c".repeat(40);
    },
  ],
  [
    "changed configuration",
    (f) => {
      f.input.identity.configurationSha256 = "d".repeat(64);
    },
  ],
  [
    "changed physical target",
    (f) => {
      f.input.identity.target.databaseId = "foreign";
    },
  ],
  [
    "changed product admission",
    (f) => {
      f.input.identity.admission.artifact.id = "99999";
    },
  ],
  [
    "reused operation ID",
    (f) => {
      f.input.identity.operationId = f.input.predecessor.identity.operationId;
    },
  ],
  [
    "expired admission",
    (f) => {
      f.now += 3600000;
    },
  ],
  [
    "unbounded expiry",
    (f) => {
      f.input.expiresAt = "2027-10-20T00:30:00.000Z";
    },
  ],
  [
    "missing executor CI",
    (f) => {
      delete f.input.executorCi;
    },
  ],
  [
    "extra bypass flag",
    (f) => {
      f.input.force = true;
    },
  ],
])
  test(`recovery admission rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(
      () => validate(f),
      (error) => error.code === "ERR_HOST_RECOVERY_ADMISSION",
    );
  });

for (const [name, phase, status, sequence] of [
  ["unresolved migration", "migrating", "recovery-required", 10],
  ["API completion failure", "api-started", "recovery-required", 15],
  ["API still entered", "api-started", "entered", 13],
  ["healthy operation", "healthy", "completed", 18],
])
  test(`recovery refuses ${name} even with a matching journal digest`, () => {
    const f = fixture();
    const state = JSON.parse(f.stateBytes);
    Object.assign(state.current, { phase, status });
    state.sequence = sequence;
    f.stateBytes = Buffer.from(JSON.stringify(state));
    f.input.predecessor.sequence = sequence;
    f.input.predecessor.stateSha256 = createHash("sha256").update(f.stateBytes).digest("hex");
    assert.throws(() => validate(f), { code: "ERR_HOST_RECOVERY_ADMISSION" });
  });

test("recovery refuses a subsequent deployment with previous healthy history", () => {
  const f = fixture();
  const state = JSON.parse(f.stateBytes);
  const identity = hostIdentity();
  state.previousHealthy = {
    identity,
    phase: "healthy",
    status: "completed",
    backup: backupProof(identity),
  };
  state.sequence = 32;
  f.stateBytes = Buffer.from(JSON.stringify(state));
  f.input.predecessor.sequence = 32;
  f.input.predecessor.stateSha256 = createHash("sha256").update(f.stateBytes).digest("hex");
  assert.throws(() => validate(f), { code: "ERR_HOST_RECOVERY_ADMISSION" });
});

test("recovery rejects getters without executing caller code", () => {
  const f = fixture();
  let executed = false;
  Object.defineProperty(f.input, "expiresAt", {
    enumerable: true,
    get() {
      executed = true;
      return "2026-10-20T00:30:00.000Z";
    },
  });
  assert.throws(() => validate(f), { code: "ERR_HOST_RECOVERY_ADMISSION" });
  assert.equal(executed, false);
});
