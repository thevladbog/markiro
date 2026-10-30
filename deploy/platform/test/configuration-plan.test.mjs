import assert from "node:assert/strict";
import test from "node:test";
import { validateConfigurationPlan } from "../host/configuration-plan.mjs";
import { configurationPlanFixture } from "./configuration-plan-fixture.mjs";

test("configuration plan binds unchanged production and a fresh private runtime", () => {
  const p = configurationPlanFixture();
  assert.equal(validateConfigurationPlan(p), p);
});

test("configuration plan rejects missing authority, paths, guards and ambiguous identities", () => {
  const changes = [
    (p) => {
      p.executorCi.runAttempt = "2";
    },
    (p) => {
      p.before.acceptedOperationId = p.operationId;
    },
    (p) => {
      p.containers.postgres.id = p.before.api.id;
    },
    (p) => {
      p.runtime.path = p.before.runtime.path;
    },
    (p) => {
      p.runtime.path = p.runtime.path.replace("runtime.env", "../runtime.env");
    },
    (p) => {
      p.compose.files.push("/tmp/evil.yml");
    },
    (p) => {
      p.compose.beforeConfigHash = p.compose.afterConfigHash;
    },
    (p) => {
      p.guards.pop();
    },
    (p) => {
      p.guards.push(p.guards[0]);
    },
    (p) => {
      p.guards[0].path = "../secret";
    },
    (p) => {
      p.previousReceiptSha256 = "a".repeat(64);
    },
    (p) => {
      p.workers.push(p.containers.edge);
    },
    (p) => {
      p.unknown = "DO-NOT-PRINT-SECRET";
    },
    (p) => {
      Object.defineProperty(p, "hidden", { value: "DO-NOT-PRINT-SECRET" });
    },
  ];
  for (const change of changes) {
    const p = configurationPlanFixture();
    change(p);
    assert.throws(
      () => validateConfigurationPlan(p),
      (e) => !/DO-NOT-PRINT|\/tmp\/evil/.test(e.message),
    );
  }
});
