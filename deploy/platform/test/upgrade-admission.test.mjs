import assert from "node:assert/strict";
import test from "node:test";
import { validateUpgradeAdmission } from "../host/upgrade-admission.mjs";
import { upgradeFixture, rewriteUpgradePredecessor } from "./upgrade-fixture.mjs";

const validate = (f) =>
  validateUpgradeAdmission(f.input, { predecessorBytes: f.predecessorBytes, now: f.now });
const refused = { code: "ERR_HOST_UPGRADE_ADMISSION" };

test("accepted recovery is historical authority, fresh upgrade authorizes a different configuration", () => {
  const f = upgradeFixture();
  const before = structuredClone(f.input);
  const result = validate(f);
  assert.deepEqual(result, before);
  assert.notEqual(result, f.input);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.predecessor.hashes));
  f.input.identity.target.hostId = "changed-after-call";
  assert.deepEqual(result, before);
});
for (const name of [
  "original",
  "acceptedRecovery",
  "preparation",
  "consumption",
  "activationOperation",
]) {
  test(`reject changed exact ${name} bytes even with equivalent JSON`, () => {
    const f = upgradeFixture();
    f.predecessorBytes[name] = Buffer.concat([f.predecessorBytes[name], Buffer.from(" ")]);
    assert.throws(() => validate(f), refused);
  });
}
for (const [name, change] of [
  [
    "failed recovery",
    (f) =>
      rewriteUpgradePredecessor(f, "acceptedRecovery", (v) => {
        v.status = "recovery-required";
      }),
  ],
  [
    "wrong sequence",
    (f) =>
      rewriteUpgradePredecessor(f, "acceptedRecovery", (v) => {
        v.sequence = 15;
      }),
  ],
  [
    "wrong phase",
    (f) =>
      rewriteUpgradePredecessor(f, "acceptedRecovery", (v) => {
        v.phase = "edge-started";
      }),
  ],
  [
    "changed historical backup",
    (f) =>
      rewriteUpgradePredecessor(f, "acceptedRecovery", (v) => {
        v.backup.archiveSha256 = "0".repeat(64);
      }),
  ],
  [
    "changed consumed envelope",
    (f) =>
      rewriteUpgradePredecessor(f, "consumption", (v) => {
        v.activationSha256 = "0".repeat(64);
      }),
  ],
  [
    "changed consumed dispatch",
    (f) =>
      rewriteUpgradePredecessor(f, "consumption", (v) => {
        v.dispatch.runId = "99999";
      }),
  ],
  [
    "changed consumed preparation",
    (f) =>
      rewriteUpgradePredecessor(f, "consumption", (v) => {
        v.preparationSha256 = "0".repeat(64);
      }),
  ],
  [
    "foreign consumed operation",
    (f) =>
      rewriteUpgradePredecessor(f, "consumption", (v) => {
        v.operationId = f.input.identity.operationId;
      }),
  ],
  [
    "changed operation envelope",
    (f) =>
      rewriteUpgradePredecessor(f, "activationOperation", (v) => {
        v.operation.activation.dispatch.runId = "99999";
      }),
  ],
  [
    "changed operation dispatch",
    (f) =>
      rewriteUpgradePredecessor(f, "activationOperation", (v) => {
        v.dispatch.runId = "99999";
      }),
  ],
  [
    "prepare operation instead of activation",
    (f) =>
      rewriteUpgradePredecessor(f, "activationOperation", (v) => {
        v.phase = "prepare";
      }),
  ],
  [
    "unknown historical property",
    (f) =>
      rewriteUpgradePredecessor(f, "acceptedRecovery", (v) => {
        v.bypass = true;
      }),
  ],
  [
    "same recovered UUID",
    (f) => {
      f.input.identity.operationId = f.input.predecessor.identity.operationId;
    },
  ],
  [
    "same original UUID",
    (f) => {
      f.input.identity.operationId = f.records.original.current.identity.operationId;
    },
  ],
  [
    "foreign target",
    (f) => {
      f.input.identity.target.hostId = "foreign";
    },
  ],
  [
    "wrong old config",
    (f) => {
      f.input.oldConfigurationSha256 = "0".repeat(64);
    },
  ],
  [
    "wrong candidate config",
    (f) => {
      f.input.candidateConfigurationSha256 = "0".repeat(64);
    },
  ],
  [
    "wrong executor dispatch",
    (f) => {
      f.input.dispatch.toolingSha = "0".repeat(40);
    },
  ],
  [
    "invalid CI",
    (f) => {
      f.input.executorCi.runId = "00";
    },
  ],
  [
    "expired",
    (f) => {
      f.now = Date.parse(f.input.expiresAt);
    },
  ],
  [
    "over one hour",
    (f) => {
      f.input.expiresAt = "2026-10-24T09:00:00.001Z";
    },
  ],
  [
    "missing reviewed plan",
    (f) => {
      delete f.input.reviewedPlanSha256;
    },
  ],
  [
    "hidden caller property",
    (f) => {
      Object.defineProperty(f.input, "secret", { value: "never-log" });
    },
  ],
  [
    "getter",
    (f) => {
      Object.defineProperty(f.input, "expiresAt", {
        enumerable: true,
        get() {
          throw new Error("must not evaluate");
        },
      });
    },
  ],
  [
    "new arbitrary phase",
    (f) => {
      f.input.phase = "healthy";
    },
  ],
]) {
  test(`upgrade admission rejects ${name}`, () => {
    const f = upgradeFixture();
    change(f);
    assert.throws(() => validate(f), refused);
  });
}
