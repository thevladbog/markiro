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
]);

const signerJobs = ["signer_rust", "signer_windows_build"];
const stationJobs = ["station_rust", "station_windows_build"];

const appJobs = Object.freeze({
  api: ["verify_static", "verify_api_tests", "tenant_team_infrastructure", "production_bundle"],
  admin: ["verify_static", "verify_app_tests", "production_bundle"],
  kiosk: ["verify_static", "verify_app_tests", "production_bundle"],
  landing: ["verify_static", "verify_app_tests", "production_bundle"],
  "saas-admin": ["verify_static", "verify_app_tests", "production_bundle"],
});

const sharedJobs = Object.freeze({
  ui: ["verify_static", "verify_app_tests", "production_bundle", ...stationJobs, ...signerJobs],
  domain: [
    "verify_static",
    "verify_api_tests",
    "verify_app_tests",
    "production_bundle",
    ...stationJobs,
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
    ...signerJobs,
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
  if (isDocumentation(path)) return [];
  if (isRootToolchainPath(path)) return HEAVY_JOBS;

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

  const appMatch = /^apps\/([^/]+)\//u.exec(path);
  if (appMatch) return appJobs[appMatch[1]] ?? null;

  const packageMatch = /^packages\/([^/]+)\//u.exec(path);
  if (packageMatch) return sharedJobs[packageMatch[1]] ?? null;

  if (path.startsWith("tools/signer-release/")) return signerJobs;
  if (path.startsWith("tools/station-release/")) return stationJobs;
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
