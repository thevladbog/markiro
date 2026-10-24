import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertRequiredResults } from "../required-results.mjs";

const jobPairs = [
  ["verify_static", "verify-static"],
  ["verify_api_tests", "verify-api-tests"],
  ["verify_app_tests", "verify-app-tests"],
  ["tenant_team_infrastructure", "tenant-team-infrastructure"],
  ["production_bundle", "production-bundle"],
  ["platform_contracts", "platform-contracts"],
  ["station_rust", "station-rust"],
  ["station_windows_build", "station-windows-build"],
  ["signer_rust", "signer-rust"],
  ["signer_windows_build", "signer-windows-build"],
  ["handheld_android", "handheld-android"],
  ["standalone_rust", "standalone-rust"],
  ["standalone_windows_build", "standalone-windows-build"],
  // The Windows test half of the standalone build shares the installer half's output.
  ["standalone_windows_build", "standalone-windows-tests"],
  ["standalone_app_tests", "standalone-app-tests"],
  ["landing_browser", "landing-browser"],
  ["landing_lighthouse", "landing-lighthouse"],
  ["saas_admin_browser", "saas-admin-browser"],
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

test("the standalone app's Vitest job is required: cancelled by its budget or missing, it fails the gate", () => {
  const selected = ["verify_static", "standalone_app_tests"];
  assert.doesNotThrow(() => assertRequiredResults(needsFixture({ selected })));
  assert.throws(
    () =>
      assertRequiredResults(
        needsFixture({ selected, results: { "standalone-app-tests": "cancelled" } }),
      ),
    /selected job standalone-app-tests finished with cancelled/,
  );
  const missing = needsFixture({ selected });
  delete missing["standalone-app-tests"];
  assert.throws(() => assertRequiredResults(missing), /missing result for standalone-app-tests/);
});

test("the standalone Windows tests job decides the gate exactly like the installer job it shares an output with", () => {
  const selected = ["standalone_rust", "standalone_windows_build"];
  assert.doesNotThrow(() => assertRequiredResults(needsFixture({ selected })));
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.throws(
      () =>
        assertRequiredResults(
          needsFixture({ selected, results: { "standalone-windows-tests": result } }),
        ),
      new RegExp(`selected job standalone-windows-tests finished with ${result}`),
    );
  }
  // Unselected: both halves skip, and the gate passes.
  const unselected = needsFixture({ selected: ["verify_static"] });
  assert.equal(unselected["standalone-windows-tests"].result, "skipped");
  assert.doesNotThrow(() => assertRequiredResults(unselected));
  assert.throws(
    () =>
      assertRequiredResults(
        needsFixture({
          selected: ["verify_static"],
          results: { "standalone-windows-tests": "failure" },
        }),
      ),
    /unselected job standalone-windows-tests finished with failure/,
  );
  assert.throws(
    () =>
      assertRequiredResults(
        needsFixture({
          full: true,
          selected: [],
          results: { "standalone-windows-tests": "skipped" },
        }),
      ),
    /full run requires standalone-windows-tests to succeed, got skipped/,
  );
  const missing = needsFixture({ selected });
  delete missing["standalone-windows-tests"];
  assert.throws(
    () => assertRequiredResults(missing),
    /missing result for standalone-windows-tests/,
  );
});

test("a failed landing build fails the gate through the selected browser jobs it skips", () => {
  // landing-build is not a classifier output of its own: when it fails, GitHub
  // skips landing-browser and landing-lighthouse, and a skipped selected job fails.
  const selected = ["landing_browser", "landing_lighthouse"];
  assert.doesNotThrow(() => assertRequiredResults(needsFixture({ selected })));
  assert.throws(
    () =>
      assertRequiredResults(
        needsFixture({
          selected,
          results: { "landing-browser": "skipped", "landing-lighthouse": "skipped" },
        }),
      ),
    /selected job landing-browser finished with skipped/,
  );
});

test("the optional cabinet and station galleries never decide the required result", () => {
  // ci-required does not need them, so neither their result nor their absence counts.
  for (const full of [false, true]) {
    const needs = needsFixture({ full, selected: full ? [] : ["verify_static"] });
    needs["classify-changes"].outputs.cabinet_station_galleries = "true";
    assert.equal(needs["cabinet-galleries"], undefined);
    assert.doesNotThrow(() => assertRequiredResults(needs));
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

test("CLI publishes a true result and summary for a valid needs payload", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "markiro-ci-required-"));
  const outputPath = join(directory, "github-output.txt");
  const summaryPath = join(directory, "github-summary.md");
  t.after(() => rmSync(directory, { force: true, recursive: true }));

  const child = spawnSync(
    process.execPath,
    ["tools/ci/required-results.mjs", "--needs-env", "CI_NEEDS_JSON"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CI_NEEDS_JSON: JSON.stringify(needsFixture()),
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      encoding: "utf8",
    },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.equal(readFileSync(outputPath, "utf8"), "result=true\n");
  assert.match(readFileSync(summaryPath, "utf8"), /Required CI result: `true`/);
});

test("CLI publishes a false result and summary when selected work was skipped", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "markiro-ci-required-"));
  const outputPath = join(directory, "github-output.txt");
  const summaryPath = join(directory, "github-summary.md");
  t.after(() => rmSync(directory, { force: true, recursive: true }));

  const child = spawnSync(
    process.execPath,
    ["tools/ci/required-results.mjs", "--needs-env", "CI_NEEDS_JSON"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CI_NEEDS_JSON: JSON.stringify(needsFixture({ results: { "signer-rust": "skipped" } })),
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      encoding: "utf8",
    },
  );

  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /selected job signer-rust finished with skipped/);
  assert.equal(readFileSync(outputPath, "utf8"), "result=false\n");
  assert.match(readFileSync(summaryPath, "utf8"), /Required CI result: `false`/);
  assert.match(readFileSync(summaryPath, "utf8"), /selected job signer-rust finished with skipped/);
});
