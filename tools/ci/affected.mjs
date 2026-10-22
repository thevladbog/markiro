import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const HEAVY_JOBS = Object.freeze([
  "verify_static",
  "verify_api_tests",
  "verify_app_tests",
  "tenant_team_infrastructure",
  "production_bundle",
  // The deploy/platform Node contracts, split off production-bundle onto two
  // sharded runners; every change that selects production_bundle selects them.
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
]);

// Classified like the jobs above but outside ci-required: the cabinet, kiosk and
// cloud-station galleries keep regression coverage for code that stays in the
// repository while those online surfaces are retired (owner decision 2026-10-21).
export const OPTIONAL_JOBS = Object.freeze(["cabinet_station_galleries"]);

const ALL_JOBS = Object.freeze([...HEAVY_JOBS, ...OPTIONAL_JOBS]);

const signerJobs = ["signer_rust", "signer_windows_build"];
const stationJobs = ["station_rust", "station_windows_build"];
const standaloneJobs = ["standalone_rust", "standalone_windows_build"];
// The standalone webview's Vitest suite has a runner of its own: inside
// verify-app-tests it pushed that job past its wall-clock budget.
const standaloneAppTests = "standalone_app_tests";
const landingJobs = ["landing_browser", "landing_lighthouse"];
// The landing, SaaS-admin and cabinet/station browser suites, each in its own job.
const browserJobs = [...landingJobs, "saas_admin_browser"];
const galleries = "cabinet_station_galleries";

// production_bundle builds what the platform runs: the API image and the
// platform edge (SaaS admin + landing). The cabinet and the kiosk are no longer
// served online, so they own only their app suites and the optional galleries.
const appJobs = Object.freeze({
  // The offers suite prints through the API's billing model and type-checks
  // against its build, so the SaaS-admin browser job follows the API too.
  api: [
    "verify_static",
    "verify_api_tests",
    "tenant_team_infrastructure",
    "production_bundle",
    "saas_admin_browser",
  ],
  admin: ["verify_static", "verify_app_tests", galleries],
  kiosk: ["verify_static", "verify_app_tests", galleries],
  landing: ["verify_static", "verify_app_tests", "production_bundle", ...landingJobs],
  "saas-admin": ["verify_static", "verify_app_tests", "production_bundle", "saas_admin_browser"],
});

const sharedJobs = Object.freeze({
  ui: [
    "verify_static",
    "verify_app_tests",
    "production_bundle",
    ...browserJobs,
    galleries,
    ...stationJobs,
    ...signerJobs,
    ...standaloneJobs,
    standaloneAppTests,
  ],
  domain: [
    "verify_static",
    "verify_api_tests",
    "verify_app_tests",
    "production_bundle",
    ...browserJobs,
    galleries,
    ...stationJobs,
    ...standaloneJobs,
    standaloneAppTests,
  ],
  db: [
    "verify_static",
    "verify_api_tests",
    "verify_app_tests",
    "tenant_team_infrastructure",
    "production_bundle",
    "saas_admin_browser",
    galleries,
    ...stationJobs,
  ],
  email: [
    "verify_static",
    "verify_api_tests",
    "tenant_team_infrastructure",
    "production_bundle",
    "saas_admin_browser",
  ],
  "legal-documents": [
    "verify_static",
    "verify_api_tests",
    "verify_app_tests",
    "production_bundle",
    ...browserJobs,
  ],
  "platform-contracts": [
    "verify_static",
    "verify_api_tests",
    "verify_app_tests",
    "production_bundle",
    ...browserJobs,
    galleries,
  ],
});

const fullRootFiles = new Set([
  ".npmrc",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
]);

function buildResult(enabledJobs, full = false) {
  const enabled = new Set(enabledJobs);
  return {
    full,
    jobs: Object.fromEntries(ALL_JOBS.map((job) => [job, full || enabled.has(job)])),
  };
}

function isInvalidPath(path) {
  return (
    path.length === 0 ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//u.test(path) ||
    path.split("/").includes("..")
  );
}

function isDocumentation(path) {
  return (
    path.startsWith("docs/") ||
    (!path.includes("/") && path.endsWith(".md")) ||
    (/^\.github\/[^/]+\.md$/u.test(path) && !path.startsWith(".github/workflows/"))
  );
}

function isRootToolchainPath(path) {
  if (fullRootFiles.has(path)) return true;
  if (path.startsWith("patches/") || path.startsWith(".github/workflows/")) {
    return true;
  }
  if (path.includes("/")) return false;
  return /^(?:tsconfig(?:\..+)?\.json|eslint(?:\..+)?\.(?:js|mjs|cjs)|\.prettier.+)$/u.test(path);
}

function jobsForPath(path) {
  if (path.startsWith("tools/station-printer-tests/")) return stationJobs;
  if (isDocumentation(path)) return [];
  if (isRootToolchainPath(path)) return ALL_JOBS;

  if (
    path === "packages/platform-contracts/src/chz-signer.ts" ||
    path.startsWith("packages/platform-contracts/fixtures/chz-signer/")
  ) {
    return [...sharedJobs["platform-contracts"], ...signerJobs];
  }

  if (
    path === "packages/platform-contracts/src/station-recovery.ts" ||
    path.startsWith("packages/platform-contracts/fixtures/station-recovery/")
  ) {
    return [...sharedJobs["platform-contracts"], "handheld_android"];
  }

  if (
    path === "packages/domain/src/validation-reprocessing.ts" ||
    path === "packages/domain/src/validation-reprocessing-fixtures.ts" ||
    path === "packages/domain/src/product-labels/contracts.ts" ||
    path === "packages/domain/scripts/export-validation-reprocessing-fixtures.mjs" ||
    path === "packages/domain/test/validation-reprocessing-fixtures.test.ts"
  )
    return [...sharedJobs.domain, "handheld_android"];

  // Shared signed protocol and its mirrored Android fixtures own all native gates.
  if (
    path.startsWith("packages/domain/src/offline-grants/") ||
    path.startsWith("packages/domain/test/offline-grant") ||
    path === "packages/domain/src/product-labels/km.ts" ||
    path === "apps/handheld/app/src/test/resources/grant-evidence-digests.json" ||
    path === "apps/handheld/tools/generate-grant-evidence-fixtures.mjs" ||
    path === "packages/platform-contracts/src/offline-grants.ts" ||
    /^packages\/platform-contracts\/(?:fixtures|tools|test)\/(?:generate-)?offline-grants?[-.]/u.test(
      path,
    ) ||
    /^apps\/handheld\/app\/src\/test\/resources\/offline-grants?[-.]/u.test(path)
  ) {
    return [...sharedJobs.domain, "handheld_android"];
  }

  // The landing render suite checks every page with a demo form against this
  // allow-list, so editing it must also run the app suites.
  if (path === "apps/api/src/modules/demo-requests/demo-request-routes.ts") {
    return [...appJobs.api, "verify_app_tests"];
  }

  if (path.startsWith("apps/signer/")) {
    if (
      path.startsWith("apps/signer/src-tauri/") ||
      path.startsWith("apps/signer/signer-core/") ||
      /^apps\/signer\/Cargo\.(?:toml|lock)$/u.test(path)
    ) {
      return signerJobs;
    }
    return ["verify_static", "verify_app_tests", ...signerJobs];
  }

  if (path.startsWith("apps/station/")) {
    if (path.startsWith("apps/station/src-tauri/")) return stationJobs;
    return ["verify_static", "verify_app_tests", galleries, ...stationJobs];
  }

  // Host and shell crates run only the Rust jobs; everything else in the app
  // (webview, protocol fixtures read by the webview, the host, the shell and the Android app, package files) also runs
  // the JavaScript gates: the static checks and the app's own Vitest job
  // (verify-app-tests leaves the standalone suite out). Two directories inside the shell crate are also
  // inputs to the webview's Vitest suite, so they must run both: sqlx
  // migrations under `src-tauri/migrations/` are applied to node:sqlite by
  // `test/support/local-db.ts`, and the SQL-rule fixtures under
  // `src-tauri/tests/fixtures/` (`local-sql.json`) are asserted by both a
  // Rust unit test and `test/local-executor.test.ts`.
  if (path.startsWith("apps/standalone/")) {
    // The handheld's unit tests read these files (`apps/handheld/app/build.gradle.kts` adds the directory to the test
    // resources): a changed wire fixture must run its Kotlin consumers, or a protocol change passes with Android untested.
    if (path.startsWith("apps/standalone/proto/fixtures/")) {
      return ["verify_static", ...standaloneJobs, standaloneAppTests, "handheld_android"];
    }
    if (
      path.startsWith("apps/standalone/src-tauri/migrations/") ||
      path.startsWith("apps/standalone/src-tauri/tests/fixtures/")
    ) {
      return ["verify_static", ...standaloneJobs, standaloneAppTests];
    }
    if (
      path.startsWith("apps/standalone/host/") ||
      path.startsWith("apps/standalone/loadtest/") ||
      path.startsWith("apps/standalone/src-tauri/") ||
      /^apps\/standalone\/Cargo\.(?:toml|lock)$/u.test(path)
    ) {
      return standaloneJobs;
    }
    return ["verify_static", ...standaloneJobs, standaloneAppTests];
  }

  // The Android app is a Gradle project outside the pnpm workspace: only its own job runs.
  if (path.startsWith("apps/handheld/")) return ["handheld_android"];

  const appMatch = /^apps\/([^/]+)\//u.exec(path);
  if (appMatch) return appJobs[appMatch[1]] ?? null;

  const packageMatch = /^packages\/([^/]+)\//u.exec(path);
  if (packageMatch) return sharedJobs[packageMatch[1]] ?? null;

  if (path.startsWith("tools/signer-release/")) return signerJobs;
  if (path.startsWith("tools/station-release/")) return stationJobs;
  // The installer's contracts and smoke test run in the standalone Windows job.
  if (path.startsWith("tools/standalone-release/")) return standaloneJobs;
  // Node contracts for the Android release, so they run in the Node job -- the
  // handheld job is Gradle-only and has no pnpm.
  if (path.startsWith("tools/handheld-release/")) return ["verify_static"];
  // The cloud → standalone export (plan IMP): its pure tests run in the Node
  // job, its SQL against the migrated cloud schema in the API job.
  if (path.startsWith("tools/standalone-export/")) return ["verify_static", "verify_api_tests"];
  // The maker's decrypting tool: its Node contract (verify_static) and the webview's
  // round-trip test, which opens a token with it (the app tests).
  if (path.startsWith("tools/standalone-support/")) return ["verify_static", standaloneAppTests];
  if (path.startsWith("tools/production-browser/")) {
    // The platform stack's browser smoke (deploy/platform/ci-stack.mjs) runs the
    // Chromium this package installs; the suites themselves have their own jobs.
    if (/^tools\/production-browser\/(?:package\.json|pnpm-lock\.yaml)$/u.test(path)) {
      return ["production_bundle", ...browserJobs, galleries];
    }
    return [...browserJobs, galleries];
  }
  // Portable platform preparation owns the same mandatory bundle gate.
  if (path.startsWith("deploy/platform/")) return ["production_bundle"];
  // The platform release (release-platform-images.yml) still runs the
  // deploy/production contract suite, and the API image is built from there.
  if (path.startsWith("deploy/production/")) return ["production_bundle"];
  // The Yandex runtime is retired (owner decision 2026-10-21): nothing in CI
  // runs it any more, and yandex-infrastructure.yml keeps its own PR checks.
  if (path.startsWith("deploy/yandex/") || path.startsWith("infra/yandex/")) return [];
  if (path === "compose.production.yml") return ["production_bundle"];

  return null;
}

export function classifyChangedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return buildResult(ALL_JOBS, true);
  }

  const enabled = new Set();
  for (const originalPath of files) {
    if (typeof originalPath !== "string") {
      return buildResult(ALL_JOBS, true);
    }
    const path = originalPath.replaceAll("\\", "/");
    if (isInvalidPath(path)) return buildResult(ALL_JOBS, true);

    const jobs = jobsForPath(path);
    if (jobs === null || jobs === ALL_JOBS) {
      return buildResult(ALL_JOBS, true);
    }
    for (const job of jobs) enabled.add(job);
    if (enabled.has("production_bundle")) enabled.add("platform_contracts");
  }

  return buildResult(enabled);
}

function parseArguments(argv) {
  const options = { full: false, stdinZero: false, githubOutput: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--full") {
      options.full = true;
    } else if (argument === "--stdin-zero") {
      options.stdinZero = true;
    } else if (argument === "--github-output") {
      const outputPath = argv[index + 1];
      if (!outputPath) throw new Error("--github-output requires a path");
      options.githubOutput = outputPath;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function runCli() {
  const options = parseArguments(process.argv.slice(2));
  const result = options.full
    ? buildResult(ALL_JOBS, true)
    : classifyChangedFiles(
        options.stdinZero
          ? readFileSync(0)
              .toString("utf8")
              .split("\0")
              .filter((path) => path.length > 0)
          : readFileSync(0, "utf8")
              .split(/\r?\n/u)
              .filter((path) => path.length > 0),
      );

  if (options.githubOutput) {
    const output = [
      `full=${String(result.full)}`,
      ...ALL_JOBS.map((job) => `${job}=${String(result.jobs[job])}`),
      "",
    ].join("\n");
    appendFileSync(options.githubOutput, output, "utf8");
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) runCli();
