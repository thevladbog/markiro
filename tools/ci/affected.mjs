import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const HEAVY_JOBS = Object.freeze([
  "verify_static",
  "verify_api_tests",
  "verify_app_tests",
  "tenant_team_infrastructure",
  "production_bundle",
  "station_rust",
  "station_windows_build",
  "signer_rust",
  "signer_windows_build",
  "handheld_android",
  "standalone_rust",
  "standalone_windows_build",
  "standalone_app_tests",
]);

const signerJobs = ["signer_rust", "signer_windows_build"];
const stationJobs = ["station_rust", "station_windows_build"];
const standaloneJobs = ["standalone_rust", "standalone_windows_build"];
// The standalone webview's Vitest suite has a runner of its own: inside
// verify-app-tests it pushed that job past its wall-clock budget.
const standaloneAppTests = "standalone_app_tests";

const appJobs = Object.freeze({
  api: ["verify_static", "verify_api_tests", "tenant_team_infrastructure", "production_bundle"],
  admin: ["verify_static", "verify_app_tests", "production_bundle"],
  kiosk: ["verify_static", "verify_app_tests", "production_bundle"],
  landing: ["verify_static", "verify_app_tests", "production_bundle"],
  "saas-admin": ["verify_static", "verify_app_tests", "production_bundle"],
});

const sharedJobs = Object.freeze({
  ui: [
    "verify_static",
    "verify_app_tests",
    "production_bundle",
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
    ...stationJobs,
  ],
  email: ["verify_static", "verify_api_tests", "tenant_team_infrastructure", "production_bundle"],
  "legal-documents": ["verify_static", "verify_api_tests", "verify_app_tests", "production_bundle"],
  "platform-contracts": [
    "verify_static",
    "verify_api_tests",
    "verify_app_tests",
    "production_bundle",
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
    jobs: Object.fromEntries(HEAVY_JOBS.map((job) => [job, full || enabled.has(job)])),
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
  // This protected deployment workflow is covered by the bundle's production
  // and Yandex contract suites. CI policy and other workflows still fail closed.
  if (path === ".github/workflows/deploy-production.yml") return ["production_bundle"];
  if (isRootToolchainPath(path)) return HEAVY_JOBS;

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
    return ["verify_static", "verify_app_tests", "production_bundle", ...stationJobs];
  }

  // Host and shell crates run only the Rust jobs; everything else in the app
  // (webview, protocol fixtures read by both suites, package files) also runs
  // the JavaScript gates: the static checks and the app's own Vitest job
  // (verify-app-tests leaves the standalone suite out). Two directories inside the shell crate are also
  // inputs to the webview's Vitest suite, so they must run both: sqlx
  // migrations under `src-tauri/migrations/` are applied to node:sqlite by
  // `test/support/local-db.ts`, and the SQL-rule fixtures under
  // `src-tauri/tests/fixtures/` (`local-sql.json`) are asserted by both a
  // Rust unit test and `test/local-executor.test.ts`.
  if (path.startsWith("apps/standalone/")) {
    if (
      path.startsWith("apps/standalone/src-tauri/migrations/") ||
      path.startsWith("apps/standalone/src-tauri/tests/fixtures/")
    ) {
      return ["verify_static", ...standaloneJobs, standaloneAppTests];
    }
    if (
      path.startsWith("apps/standalone/host/") ||
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
  if (path.startsWith("tools/production-browser/")) {
    return ["production_bundle"];
  }
  if (path.startsWith("deploy/") || path.startsWith("infra/")) {
    return ["production_bundle"];
  }
  if (path === "compose.production.yml") return ["production_bundle"];

  return null;
}

export function classifyChangedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return buildResult(HEAVY_JOBS, true);
  }

  const enabled = new Set();
  for (const originalPath of files) {
    if (typeof originalPath !== "string") {
      return buildResult(HEAVY_JOBS, true);
    }
    const path = originalPath.replaceAll("\\", "/");
    if (isInvalidPath(path)) return buildResult(HEAVY_JOBS, true);

    const jobs = jobsForPath(path);
    if (jobs === null || jobs === HEAVY_JOBS) {
      return buildResult(HEAVY_JOBS, true);
    }
    for (const job of jobs) enabled.add(job);
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
    ? buildResult(HEAVY_JOBS, true)
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
      ...HEAVY_JOBS.map((job) => `${job}=${String(result.jobs[job])}`),
      "",
    ].join("\n");
    appendFileSync(options.githubOutput, output, "utf8");
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) runCli();
