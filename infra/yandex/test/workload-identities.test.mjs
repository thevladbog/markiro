import assert from "node:assert/strict";
import test from "node:test";

import { validateWorkloadIdentityIds } from "../scripts/validate-workload-identities.mjs";

const valid = Object.freeze({
  app: "app-id",
  audit: "audit-id",
  controller: "controller-id",
  runner: "runner-id",
  terraform: "terraform-id",
});

test("accepts five nonblank pairwise-distinct workload identity IDs", () => {
  assert.doesNotThrow(() => validateWorkloadIdentityIds(valid));
});

for (const [left, right] of [
  ["app", "audit"],
  ["app", "controller"],
  ["app", "runner"],
  ["app", "terraform"],
  ["audit", "controller"],
  ["audit", "runner"],
  ["audit", "terraform"],
  ["controller", "runner"],
  ["controller", "terraform"],
  ["runner", "terraform"],
])
  test(`rejects the ${left}/${right} identity alias`, () => {
    assert.throws(
      () => validateWorkloadIdentityIds({ ...valid, [right]: valid[left] }),
      /workload service-account IDs are invalid/,
    );
  });

test("rejects blank, missing, or extra identity values without disclosing them", () => {
  for (const identities of [
    { ...valid, app: "" },
    { ...valid, runner: undefined },
    { ...valid, extra: "unexpected" },
  ])
    assert.throws(
      () => validateWorkloadIdentityIds(identities),
      /workload service-account IDs are invalid/,
    );
});
