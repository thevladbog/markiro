import assert from "node:assert/strict";
import test from "node:test";

import { validateTerraformPlanBinding } from "../scripts/terraform-plan-binding.mjs";

const valid = {
  targetSha: "a".repeat(40),
  enablePublicDns: "false",
  enableStationReleasePublicDns: "true",
  planKey: `production/plans/123/2/${"a".repeat(40)}/false-true/production.tfplan`,
  planSha256: "b".repeat(64),
  planVersionId: "binary-version",
  planJsonKey: `production/plans/123/2/${"a".repeat(40)}/false-true/production-plan.json`,
  planJsonSha256: "c".repeat(64),
  planJsonVersionId: "json-version",
  reviewConfirmed: "true",
};

test("binds both exact plan objects to one reviewed run and input set", () => {
  assert.deepEqual(validateTerraformPlanBinding(valid), {
    sourceRunId: "123",
    sourceRunAttempt: "2",
    planPrefix: `production/plans/123/2/${"a".repeat(40)}/false-true/`,
  });
});

test("rejects mismatched key, version, hash, JSON, and incomplete review confirmation", () => {
  for (const mutation of [
    { planKey: valid.planKey.replace("/123/", "/unexpected/") },
    { planVersionId: "" },
    { planJsonVersionId: "null" },
    { planSha256: "d".repeat(63) },
    { planJsonSha256: "e".repeat(65) },
    { planJsonKey: valid.planJsonKey.replace("production-plan.json", "other.json") },
    { targetSha: "f".repeat(40) },
    { enablePublicDns: "true" },
    { reviewConfirmed: "false" },
    { planKey: `${valid.planKey}\n` },
    { planSha256: `${valid.planSha256}\n` },
    { planVersionId: `${valid.planVersionId}\n` },
    { planJsonVersionId: `${valid.planJsonVersionId}\n` },
  ]) {
    assert.throws(
      () => validateTerraformPlanBinding({ ...valid, ...mutation }),
      /invalid Terraform plan escrow binding/,
    );
  }
});
