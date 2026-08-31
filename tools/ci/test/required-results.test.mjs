import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { assertRequiredResults } from "../required-results.mjs";

const jobPairs = [
  ["verify_static", "verify-static"],
  ["verify_api_tests", "verify-api-tests"],
  ["verify_app_tests", "verify-app-tests"],
  ["tenant_team_infrastructure", "tenant-team-infrastructure"],
  ["production_bundle", "production-bundle"],
  ["station_rust", "station-rust"],
  ["station_windows_build", "station-windows-build"],
  ["signer_rust", "signer-rust"],
  ["signer_windows_build", "signer-windows-build"],
];

function needsFixture({
  full = false,
  selected = ["signer_rust", "signer_windows_build"],
  results = {},
} = {}) {
  const selectedSet = new Set(selected);
  const outputs = { full: String(full) };
  const needs = {
    "classify-changes": { result: "success", outputs },
  };

  for (const [outputName, jobId] of jobPairs) {
    const isSelected = full || selectedSet.has(outputName);
    outputs[outputName] = String(isSelected);
    needs[jobId] = {
      result: results[jobId] ?? (isSelected ? "success" : "skipped"),
      outputs: {},
    };
  }

  return needs;
}

test("accepts successful selected jobs and intentional skips", () => {
  assert.doesNotThrow(() => assertRequiredResults(needsFixture()));
});

test("accepts an unselected job that GitHub ran successfully", () => {
  assert.doesNotThrow(() =>
    assertRequiredResults(needsFixture({ results: { "verify-static": "success" } })),
  );
});

test("rejects a selected job that GitHub skipped", () => {
  assert.throws(
    () => assertRequiredResults(needsFixture({ results: { "signer-rust": "skipped" } })),
    /selected job signer-rust finished with skipped/,
  );
});

test("rejects selected jobs that fail or are cancelled", () => {
  for (const result of ["failure", "cancelled"]) {
    assert.throws(
      () => assertRequiredResults(needsFixture({ results: { "signer-windows-build": result } })),
      new RegExp(`selected job signer-windows-build finished with ${result}`),
    );
  }
});

test("rejects an unselected job with a non-success terminal result", () => {
  for (const result of ["failure", "cancelled"]) {
    assert.throws(
      () => assertRequiredResults(needsFixture({ results: { "station-rust": result } })),
      new RegExp(`unselected job station-rust finished with ${result}`),
    );
  }
});

test("rejects every skipped job during a full run", () => {
  assert.throws(
    () =>
      assertRequiredResults(
        needsFixture({
          full: true,
          selected: [],
          results: { "verify-static": "skipped" },
        }),
      ),
    /full run requires verify-static to succeed, got skipped/,
  );
});

test("rejects a missing heavy-job result", () => {
  const needs = needsFixture();
  delete needs["signer-rust"];
  assert.throws(() => assertRequiredResults(needs), /missing result for signer-rust/);
});

test("rejects a missing or failed classifier", () => {
  const missing = needsFixture();
  delete missing["classify-changes"];
  assert.throws(() => assertRequiredResults(missing), /classify-changes result is missing/);

  const failed = needsFixture();
  failed["classify-changes"].result = "failure";
  assert.throws(() => assertRequiredResults(failed), /classify-changes must succeed, got failure/);
});

test("rejects missing and non-boolean classifier outputs", () => {
  const missing = needsFixture();
  delete missing["classify-changes"].outputs.verify_static;
  assert.throws(
    () => assertRequiredResults(missing),
    /classifier output verify_static must be true or false, got missing/,
  );

  const malformed = needsFixture();
  malformed["classify-changes"].outputs.full = "yes";
  assert.throws(
    () => assertRequiredResults(malformed),
    /classifier output full must be true or false, got yes/,
  );
});

test("CLI accepts a valid needs JSON environment value", () => {
  const child = spawnSync(
    process.execPath,
    ["tools/ci/required-results.mjs", "--needs-env", "CI_NEEDS_JSON"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CI_NEEDS_JSON: JSON.stringify(needsFixture()),
      },
      encoding: "utf8",
    },
  );

  assert.equal(child.status, 0, child.stderr);
});

test("CLI exits non-zero when selected work was skipped", () => {
  const child = spawnSync(
    process.execPath,
    ["tools/ci/required-results.mjs", "--needs-env", "CI_NEEDS_JSON"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CI_NEEDS_JSON: JSON.stringify(needsFixture({ results: { "signer-rust": "skipped" } })),
      },
      encoding: "utf8",
    },
  );

  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /selected job signer-rust finished with skipped/);
});
