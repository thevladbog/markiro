import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { classifyChangedFiles } from "../affected.mjs";

const jobNames = [
  "verify_static",
  "verify_api_tests",
  "verify_app_tests",
  "tenant_team_infrastructure",
  "production_bundle",
  "station_rust",
  "station_windows_build",
  "signer_rust",
  "signer_windows_build",
];

const signerOnly = {
  full: false,
  jobs: {
    verify_static: false,
    verify_api_tests: false,
    verify_app_tests: false,
    tenant_team_infrastructure: false,
    production_bundle: false,
    station_rust: false,
    station_windows_build: false,
    signer_rust: true,
    signer_windows_build: true,
  },
};

function enabledJobs(result) {
  assert.deepEqual(Object.keys(result.jobs), jobNames);
  return Object.entries(result.jobs)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}

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
  assert.deepEqual(enabledJobs(web), [
    "verify_static",
    "verify_app_tests",
    "production_bundle",
    "station_rust",
    "station_windows_build",
  ]);
});

test("application changes select their documented jobs", () => {
  const cases = [
    [
      "apps/api/src/main.ts",
      ["verify_static", "verify_api_tests", "tenant_team_infrastructure", "production_bundle"],
    ],
    ["apps/admin/src/App.tsx", ["verify_static", "verify_app_tests", "production_bundle"]],
    ["apps/kiosk/src/App.tsx", ["verify_static", "verify_app_tests", "production_bundle"]],
    [
      "apps/landing/src/pages/index.astro",
      ["verify_static", "verify_app_tests", "production_bundle"],
    ],
    ["apps/saas-admin/src/App.tsx", ["verify_static", "verify_app_tests", "production_bundle"]],
  ];

  for (const [path, expected] of cases) {
    assert.deepEqual(enabledJobs(classifyChangedFiles([path])), expected, path);
  }
});

test("shared packages fan out to their current consumers", () => {
  const cases = [
    [
      "packages/ui/src/Button.tsx",
      [
        "verify_static",
        "verify_app_tests",
        "production_bundle",
        "station_rust",
        "station_windows_build",
        "signer_rust",
        "signer_windows_build",
      ],
    ],
    [
      "packages/domain/src/gtin.ts",
      [
        "verify_static",
        "verify_api_tests",
        "verify_app_tests",
        "production_bundle",
        "station_rust",
        "station_windows_build",
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
        "station_rust",
        "station_windows_build",
      ],
    ],
    [
      "packages/email/src/index.ts",
      ["verify_static", "verify_api_tests", "tenant_team_infrastructure", "production_bundle"],
    ],
    [
      "packages/legal-documents/src/index.ts",
      ["verify_static", "verify_api_tests", "verify_app_tests", "production_bundle"],
    ],
    [
      "packages/platform-contracts/src/chz-signer.ts",
      [
        "verify_static",
        "verify_api_tests",
        "verify_app_tests",
        "production_bundle",
        "signer_rust",
        "signer_windows_build",
      ],
    ],
  ];

  for (const [path, expected] of cases) {
    assert.deepEqual(enabledJobs(classifyChangedFiles([path])), expected, path);
  }
});

test("deployment and release tooling selects its consuming jobs", () => {
  const cases = [
    ["deploy/production/preflight.mjs", ["production_bundle"]],
    ["infra/yandex/main.tf", ["production_bundle"]],
    ["tools/production-browser/tests/docs.spec.ts", ["production_bundle"]],
    ["tools/station-release/build-manifest.mjs", ["station_rust", "station_windows_build"]],
    ["tools/signer-release/build-manifest.mjs", ["signer_rust", "signer_windows_build"]],
  ];

  for (const [path, expected] of cases) {
    assert.deepEqual(enabledJobs(classifyChangedFiles([path])), expected, path);
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
  ]) {
    const result = classifyChangedFiles([path]);
    assert.equal(result.full, true, path);
    assert.deepEqual(enabledJobs(result), jobNames, path);
  }
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
    "production_bundle",
    "signer_rust",
    "signer_windows_build",
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
      "station_rust=false",
      "station_windows_build=false",
      "signer_rust=true",
      "signer_windows_build=true",
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
