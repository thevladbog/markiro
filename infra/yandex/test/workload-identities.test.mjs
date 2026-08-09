import assert from "node:assert/strict";
import test from "node:test";

import { validateWorkloadIdentityIds } from "../scripts/validate-workload-identities.mjs";

const valid = Object.freeze({
  app: "app-id",
  audit: "audit-id",
  controller: "controller-id",
  terraform: "terraform-id",
});

test("accepts four nonblank pairwise-distinct workload identity IDs", () => {
  assert.doesNotThrow(() => validateWorkloadIdentityIds(valid));
});

for (const [left, right] of [
  ["app", "audit"],
  ["app", "controller"],
  ["app", "terraform"],
  ["audit", "controller"],
  ["audit", "terraform"],
  ["controller", "terraform"],
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
    { ...valid, controller: undefined },
    { ...valid, runner: "retired" },
    { ...valid, extra: "unexpected" },
  ])
    assert.throws(
      () => validateWorkloadIdentityIds(identities),
      /workload service-account IDs are invalid/,
    );
});
