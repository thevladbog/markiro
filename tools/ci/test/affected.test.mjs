import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { classifyChangedFiles, HEAVY_JOBS, OPTIONAL_JOBS } from "../affected.mjs";

const jobNames = [
  "verify_static",
  "verify_api_tests",
  "verify_app_tests",
  "tenant_team_infrastructure",
  "production_bundle",
  "platform_contracts",
  "station_rust",
  "station_windows_build",
  "signer_rust",
  "signer_windows_build",
  "handheld_android",
  "standalone_rust",
  "standalone_windows_build",
  "standalone_app_tests",
  "landing_browser",
  "landing_lighthouse",
  "saas_admin_browser",
  // Optional: classified here, but outside ci-required.
  "cabinet_station_galleries",
];

const signerOnly = {
  full: false,
  jobs: {
    verify_static: false,
    verify_api_tests: false,
    verify_app_tests: false,
    tenant_team_infrastructure: false,
    production_bundle: false,
    platform_contracts: false,
    station_rust: false,
    station_windows_build: false,
    signer_rust: true,
    signer_windows_build: true,
    handheld_android: false,
    standalone_rust: false,
    standalone_windows_build: false,
    standalone_app_tests: false,
    landing_browser: false,
    landing_lighthouse: false,
    saas_admin_browser: false,
    cabinet_station_galleries: false,
  },
};

function enabledJobs(result) {
  assert.deepEqual(Object.keys(result.jobs), jobNames);
  return Object.entries(result.jobs)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}

test("the cabinet and station galleries are classified but never required", () => {
  assert.deepEqual(OPTIONAL_JOBS, ["cabinet_station_galleries"]);
  assert.deepEqual([...HEAVY_JOBS, ...OPTIONAL_JOBS], jobNames);
  for (const job of OPTIONAL_JOBS) assert.ok(!HEAVY_JOBS.includes(job), job);
});

test("the platform contracts run whenever production_bundle does, and only then", () => {
  for (const path of [
    "deploy/platform/ci-stack.mjs",
    "deploy/production/api.Dockerfile",
    "apps/landing/src/pages/index.astro",
    "packages/db/src/schema/products.ts",
    "apps/admin/src/App.tsx",
    "apps/signer/src/App.tsx",
    "docs/architecture.md",
  ]) {
    const { jobs } = classifyChangedFiles([path]);
    assert.equal(jobs.platform_contracts, jobs.production_bundle, path);
  }
});

test("a Signer version bump does not select unrelated product jobs", () => {
  assert.deepEqual(classifyChangedFiles(["apps/signer/src-tauri/tauri.conf.json"]), signerOnly);
});

test("an empty diff fails closed to every job", () => {
  const result = classifyChangedFiles([]);
  assert.equal(result.full, true);
  assert.deepEqual(enabledJobs(result), jobNames);
});

test("an unknown source area fails closed to every job", () => {
  const result = classifyChangedFiles(["services/new-worker/src/index.ts"]);
  assert.equal(result.full, true);
  assert.deepEqual(enabledJobs(result), jobNames);
});

test("absolute and parent-traversal paths fail closed", () => {
  for (const path of ["/tmp/source.ts", "apps/admin/../api/src/main.ts"]) {
    const result = classifyChangedFiles([path]);
    assert.equal(result.full, true, path);
    assert.deepEqual(enabledJobs(result), jobNames, path);
  }
});

test("Signer UI changes include JavaScript verification and both native builds", () => {
  const result = classifyChangedFiles(["apps/signer/src/App.tsx"]);
  assert.equal(result.full, false);
  assert.deepEqual(enabledJobs(result), [
    "verify_static",
    "verify_app_tests",
    "signer_rust",
    "signer_windows_build",
  ]);
});

test("Station native and web changes select different downstream work", () => {
  const native = classifyChangedFiles(["apps/station/src-tauri/src/scanner.rs"]);
  assert.deepEqual(enabledJobs(native), ["station_rust", "station_windows_build"]);

  const web = classifyChangedFiles(["apps/station/src/App.tsx"]);
  // The cloud station is no longer served, so no platform image depends on it.
  assert.deepEqual(enabledJobs(web), [
    "verify_static",
    "verify_app_tests",
    "station_rust",
    "station_windows_build",
    "cabinet_station_galleries",
  ]);
});

test("Standalone native and web changes select their jobs; its Vitest suite has its own job", () => {
  for (const path of [
    "apps/standalone/host/src/server.rs",
    "apps/standalone/loadtest/src/run.rs",
    "apps/standalone/src-tauri/src/lib.rs",
    "apps/standalone/Cargo.lock",
  ]) {
    assert.deepEqual(
      enabledJobs(classifyChangedFiles([path])),
      ["standalone_rust", "standalone_windows_build"],
      path,
    );
  }
  for (const path of [
    "apps/standalone/src/app/App.tsx",
    "apps/standalone/src-tauri/migrations/0001_reference_data.sql",
    "apps/standalone/src-tauri/tests/fixtures/local-sql.json",
  ]) {
    assert.deepEqual(
      enabledJobs(classifyChangedFiles([path])),
      ["verify_static", "standalone_rust", "standalone_windows_build", "standalone_app_tests"],
      path,
    );
  }
});

test("a changed wire fixture of the standalone protocol also runs the Android job that reads it", () => {
  for (const path of [
    "apps/standalone/proto/fixtures/hello.json",
    "apps/standalone/proto/fixtures/pallet-events-request.json",
  ]) {
    const result = classifyChangedFiles([path]);
    assert.equal(result.full, false, path);
    assert.deepEqual(
      enabledJobs(result),
      [
        "verify_static",
        "handheld_android",
        "standalone_rust",
        "standalone_windows_build",
        "standalone_app_tests",
      ],
      path,
    );
  }
  // The host's and the shell's own sources still do not run it.
  assert.deepEqual(enabledJobs(classifyChangedFiles(["apps/standalone/proto/src/lib.rs"])), [
    "verify_static",
    "standalone_rust",
    "standalone_windows_build",
    "standalone_app_tests",
  ]);
});

test("application changes select their documented jobs", () => {
  const cases = [
    [
      "apps/api/src/main.ts",
      [
        "verify_static",
        "verify_api_tests",
        "tenant_team_infrastructure",
        "production_bundle",
        "platform_contracts",
        "saas_admin_browser",
      ],
    ],
    // The cabinet and the kiosk are no longer served online: no platform image
    // or required browser job depends on them, only the optional galleries.
    ["apps/admin/src/App.tsx", ["verify_static", "verify_app_tests", "cabinet_station_galleries"]],
    ["apps/kiosk/src/App.tsx", ["verify_static", "verify_app_tests", "cabinet_station_galleries"]],
    [
      "apps/landing/src/pages/index.astro",
      [
        "verify_static",
        "verify_app_tests",
        "production_bundle",
        "platform_contracts",
        "landing_browser",
        "landing_lighthouse",
      ],
    ],
    [
      "apps/saas-admin/src/App.tsx",
      [
        "verify_static",
        "verify_app_tests",
        "production_bundle",
        "platform_contracts",
        "saas_admin_browser",
      ],
    ],
  ];

  for (const [path, expected] of cases) {
    assert.deepEqual(enabledJobs(classifyChangedFiles([path])), expected, path);
  }
});

test("the demo-form source allow-list also runs the landing suite that renders the forms", () => {
  assert.deepEqual(
    enabledJobs(
      classifyChangedFiles(["apps/api/src/modules/demo-requests/demo-request-routes.ts"]),
    ),
    [
      "verify_static",
      "verify_api_tests",
      "verify_app_tests",
      "tenant_team_infrastructure",
      "production_bundle",
      "platform_contracts",
      "saas_admin_browser",
    ],
  );
});

test("shared packages fan out to their current consumers", () => {
  const cases = [
    [
      "packages/ui/src/Button.tsx",
      [
        "verify_static",
        "verify_app_tests",
        "production_bundle",
        "platform_contracts",
        "station_rust",
        "station_windows_build",
        "signer_rust",
        "signer_windows_build",
        "standalone_rust",
        "standalone_windows_build",
        "standalone_app_tests",
        "landing_browser",
        "landing_lighthouse",
        "saas_admin_browser",
        "cabinet_station_galleries",
      ],
    ],
    [
      "packages/domain/src/gtin.ts",
      [
        "verify_static",
        "verify_api_tests",
        "verify_app_tests",
        "production_bundle",
        "platform_contracts",
        "station_rust",
        "station_windows_build",
        "standalone_rust",
        "standalone_windows_build",
        "standalone_app_tests",
        "landing_browser",
        "landing_lighthouse",
        "saas_admin_browser",
        "cabinet_station_galleries",
      ],
    ],
    [
      "packages/db/src/schema/products.ts",
      [
        "verify_static",
        "verify_api_tests",
        "verify_app_tests",
        "tenant_team_infrastructure",
        "production_bundle",
        "platform_contracts",
        "station_rust",
        "station_windows_build",
        "saas_admin_browser",
        "cabinet_station_galleries",
      ],
    ],
    [
      "packages/email/src/index.ts",
      [
        "verify_static",
        "verify_api_tests",
        "tenant_team_infrastructure",
        "production_bundle",
        "platform_contracts",
        "saas_admin_browser",
      ],
    ],
    [
      "packages/legal-documents/src/index.ts",
      [
        "verify_static",
        "verify_api_tests",
        "verify_app_tests",
        "production_bundle",
        "platform_contracts",
        "landing_browser",
        "landing_lighthouse",
        "saas_admin_browser",
      ],
    ],
    [
      "packages/platform-contracts/src/commercial.ts",
      [
        "verify_static",
        "verify_api_tests",
        "verify_app_tests",
        "production_bundle",
        "platform_contracts",
        "landing_browser",
        "landing_lighthouse",
        "saas_admin_browser",
        "cabinet_station_galleries",
      ],
    ],
  ];

  for (const [path, expected] of cases) {
    assert.deepEqual(enabledJobs(classifyChangedFiles([path])), expected, path);
  }
});

test("only the mirrored CHZ Signer contract selects native Signer verification", () => {
  for (const path of [
    "packages/platform-contracts/src/chz-signer.ts",
    "packages/platform-contracts/fixtures/chz-signer/pair-response.json",
  ]) {
    assert.deepEqual(
      enabledJobs(classifyChangedFiles([path])),
      [
        "verify_static",
        "verify_api_tests",
        "verify_app_tests",
        "production_bundle",
        "platform_contracts",
        "signer_rust",
        "signer_windows_build",
        "landing_browser",
        "landing_lighthouse",
        "saas_admin_browser",
        "cabinet_station_galleries",
      ],
      path,
    );
  }
});

test("shared Station recovery contract and fixtures select handheld verification", () => {
  for (const path of [
    "packages/platform-contracts/src/station-recovery.ts",
    "packages/platform-contracts/fixtures/station-recovery/requests.json",
    "packages/platform-contracts/fixtures/station-recovery/responses.json",
  ]) {
    assert.deepEqual(
      enabledJobs(classifyChangedFiles([path])),
      [
        "verify_static",
        "verify_api_tests",
        "verify_app_tests",
        "production_bundle",
        "platform_contracts",
        "handheld_android",
        "landing_browser",
        "landing_lighthouse",
        "saas_admin_browser",
        "cabinet_station_galleries",
      ],
      path,
    );
  }
});

test("deployment and release tooling selects its consuming jobs", () => {
  const cases = [
    ["deploy/production/preflight.mjs", ["production_bundle", "platform_contracts"]],
    ["deploy/platform/ci-stack.mjs", ["production_bundle", "platform_contracts"]],
    [
      "tools/production-browser/tests/landing-seo.spec.ts",
      ["landing_browser", "landing_lighthouse", "saas_admin_browser", "cabinet_station_galleries"],
    ],
    // ci-stack.mjs smokes the platform stack in the Chromium this package installs.
    [
      "tools/production-browser/pnpm-lock.yaml",
      [
        "production_bundle",
        "platform_contracts",
        "landing_browser",
        "landing_lighthouse",
        "saas_admin_browser",
        "cabinet_station_galleries",
      ],
    ],
    ["tools/station-release/build-manifest.mjs", ["station_rust", "station_windows_build"]],
    ["tools/signer-release/build-manifest.mjs", ["signer_rust", "signer_windows_build"]],
    ["tools/standalone-release/smoke.ps1", ["standalone_rust", "standalone_windows_build"]],
    ["tools/standalone-support/decrypt.mjs", ["verify_static", "standalone_app_tests"]],
  ];

  for (const [path, expected] of cases) {
    assert.deepEqual(enabledJobs(classifyChangedFiles([path])), expected, path);
  }
});

test("the cloud → standalone export runs its Node tests and its SQL against the cloud schema", () => {
  for (const path of [
    "tools/standalone-export/export.sql",
    "tools/standalone-export/test/fixtures/seed-cloud.sql",
  ]) {
    assert.deepEqual(
      enabledJobs(classifyChangedFiles([path])),
      ["verify_static", "verify_api_tests"],
      path,
    );
  }
});

test("the files the export tool compares itself with select the Node job that runs it", () => {
  // The SSCC serial fixture and the golden file are read by tools/standalone-export/test;
  // packages/domain's SSCC code is what its equivalence test imports.
  for (const path of [
    "apps/standalone/proto/fixtures/sscc-serials.json",
    "apps/standalone/proto/fixtures/cloud-export-file.json",
    "packages/domain/src/gs1/sscc.ts",
  ]) {
    assert.ok(enabledJobs(classifyChangedFiles([path])).includes("verify_static"), path);
  }
});

test("documentation-only changes select no heavy job", () => {
  const result = classifyChangedFiles([
    "README.md",
    "docs/architecture.md",
    ".github/pull_request_template.md",
  ]);
  assert.equal(result.full, false);
  assert.deepEqual(enabledJobs(result), []);
});

test("root toolchain and workflow changes select the complete workflow", () => {
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "turbo.json",
    ".npmrc",
    "patches/minimatch@3.1.5.patch",
    "tsconfig.base.json",
    "eslint.config.mjs",
    ".prettierrc.json",
    ".github/workflows/ci.yml",
    ".github/workflows/new-workflow.yml",
    ".github/workflows/deploy-production.yaml",
    // The retired Yandex deploy workflow lost its narrow route with the workflow.
    ".github/workflows/deploy-production.yml",
    "tools/ci/affected.mjs",
    "tools/ci/required-results.mjs",
    "tools/ci/test/affected.test.mjs",
  ]) {
    const result = classifyChangedFiles([path]);
    assert.equal(result.full, true, path);
    assert.deepEqual(enabledJobs(result), jobNames, path);
  }
});

test("routes handheld app changes to the Android job only", () => {
  const result = classifyChangedFiles([
    "apps/handheld/app/src/main/AndroidManifest.xml",
    "apps/handheld/gradle/libs.versions.toml",
  ]);
  assert.equal(result.full, false);
  assert.deepEqual(enabledJobs(result), ["handheld_android"]);
});

test("multiple changed paths union their selected jobs", () => {
  const result = classifyChangedFiles([
    "apps/signer/src-tauri/tauri.conf.json",
    "apps/admin/src/App.tsx",
  ]);
  assert.equal(result.full, false);
  assert.deepEqual(enabledJobs(result), [
    "verify_static",
    "verify_app_tests",
    "signer_rust",
    "signer_windows_build",
    "cabinet_station_galleries",
  ]);
});

test("CLI writes exact GitHub outputs for a NUL-delimited diff", () => {
  const directory = mkdtempSync(join(tmpdir(), "markiro-ci-policy-"));
  const outputPath = join(directory, "github-output.txt");
  const child = spawnSync(
    process.execPath,
    ["tools/ci/affected.mjs", "--stdin-zero", "--github-output", outputPath],
    {
      cwd: process.cwd(),
      input: Buffer.from("apps/signer/src-tauri/tauri.conf.json\0docs/architecture.md\0"),
      encoding: "utf8",
    },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    readFileSync(outputPath, "utf8"),
    [
      "full=false",
      "verify_static=false",
      "verify_api_tests=false",
      "verify_app_tests=false",
      "tenant_team_infrastructure=false",
      "production_bundle=false",
      "platform_contracts=false",
      "station_rust=false",
      "station_windows_build=false",
      "signer_rust=true",
      "signer_windows_build=true",
      "handheld_android=false",
      "standalone_rust=false",
      "standalone_windows_build=false",
      "standalone_app_tests=false",
      "landing_browser=false",
      "landing_lighthouse=false",
      "saas_admin_browser=false",
      "cabinet_station_galleries=false",
      "",
    ].join("\n"),
  );
});

test("CLI full mode writes every output as true", () => {
  const directory = mkdtempSync(join(tmpdir(), "markiro-ci-policy-"));
  const outputPath = join(directory, "github-output.txt");
  const child = spawnSync(
    process.execPath,
    ["tools/ci/affected.mjs", "--full", "--github-output", outputPath],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    readFileSync(outputPath, "utf8"),
    ["full=true", ...jobNames.map((name) => `${name}=true`), ""].join("\n"),
  );
});

test("validation reprocessing wire producers select Android parity", () => {
  for (const path of [
    "packages/domain/src/validation-reprocessing.ts",
    "packages/domain/src/validation-reprocessing-fixtures.ts",
    "packages/domain/src/product-labels/contracts.ts",
    "packages/domain/scripts/export-validation-reprocessing-fixtures.mjs",
    "packages/domain/test/validation-reprocessing-fixtures.test.ts",
  ])
    assert.equal(classifyChangedFiles([path]).jobs.handheld_android, true, path);
});

test("offline grant protocol and signed fixture changes exercise every native consumer", () => {
  for (const path of [
    "packages/domain/src/offline-grants/types.ts",
    "packages/domain/src/product-labels/km.ts",
    "packages/domain/test/offline-grant-evidence-fixture.test.ts",
    "apps/handheld/app/src/test/resources/grant-evidence-digests.json",
    "apps/handheld/tools/generate-grant-evidence-fixtures.mjs",
    "packages/domain/test/offline-grants-decision.test.ts",
    "packages/platform-contracts/src/offline-grants.ts",
    "packages/platform-contracts/fixtures/offline-grants-v1.json",
    "packages/platform-contracts/fixtures/offline-grant-budgets-v1.json",
    "packages/platform-contracts/tools/generate-offline-grant-fixtures.mjs",
    "apps/handheld/app/src/test/resources/offline-grants-v1.json",
    "apps/handheld/app/src/test/resources/offline-grant-budgets-v1.json",
  ]) {
    const result = classifyChangedFiles([path]);
    assert.equal(result.full, false, path);
    assert.deepEqual(
      enabledJobs(result),
      [
        "verify_static",
        "verify_api_tests",
        "verify_app_tests",
        "production_bundle",
        "platform_contracts",
        "station_rust",
        "station_windows_build",
        "handheld_android",
        "standalone_rust",
        "standalone_windows_build",
        "standalone_app_tests",
        "landing_browser",
        "landing_lighthouse",
        "saas_admin_browser",
        "cabinet_station_galleries",
      ],
      path,
    );
  }
});

test("the standalone Windows printer harness selects both Station native gates", () => {
  const result = classifyChangedFiles(["tools/station-printer-tests/lib.rs"]);
  assert.equal(result.full, false);
  const jobs = enabledJobs(result);
  assert.ok(jobs.includes("station_rust"));
  assert.ok(jobs.includes("station_windows_build"));
});
