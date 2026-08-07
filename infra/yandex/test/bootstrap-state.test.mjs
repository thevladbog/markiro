import assert from "node:assert/strict";
import test from "node:test";

import { assertManagedResourceInState } from "./bootstrap-state.mjs";

const realTerraformStateShape = JSON.stringify({
  version: 4,
  terraform_version: "1.15.8",
  serial: 1,
  lineage: "00000000-0000-0000-0000-000000000000",
  outputs: {},
  resources: [
    {
      mode: "managed",
      type: "terraform_data",
      name: "bootstrap",
      provider: 'provider["terraform.io/builtin/terraform"]',
      instances: [{ schema_version: 0, attributes: { input: "local-first" } }],
    },
  ],
  check_results: null,
});

test("state resource assertion parses Terraform type and name", () => {
  assert.doesNotThrow(() =>
    assertManagedResourceInState(
      realTerraformStateShape,
      "terraform_data",
      "bootstrap",
      "local state",
    ),
  );
});

test("state resource assertion rejects address-like text without the managed resource", () => {
  for (const unsafeState of [
    JSON.stringify({ resources: [], note: "terraform_data.bootstrap" }),
    JSON.stringify({ resources: [{ mode: "managed", type: "terraform_data", name: "other" }] }),
    JSON.stringify({ resources: [{ mode: "data", type: "terraform_data", name: "bootstrap" }] }),
    "not-json terraform_data.bootstrap",
  ])
    assert.throws(() =>
      assertManagedResourceInState(unsafeState, "terraform_data", "bootstrap", "remote state"),
    );
});
