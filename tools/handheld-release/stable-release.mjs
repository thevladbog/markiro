import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolveRelease } from "./resolve.mjs";

export const HANDHELD_PUBLISHER_TAG = "refs/tags/handheld-publisher-v1";
export const HANDHELD_SIGNING_CERTIFICATE_SHA256 =
  "27e453b2b40d3d1e4b58917acfb9c6c908036b72d6e48e3759a9e8efd5e6a3f7";
const SHA = /^[a-f0-9]{40}$/u;
const DECIMAL = /^[1-9][0-9]*$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const isId = (value) => Number.isSafeInteger(value) && value > 0;

export function requireMainCiRun(runs, sourceSha, repositoryId) {
  assert.match(sourceSha, SHA);
  assert.match(repositoryId, DECIMAL);
  assert(Array.isArray(runs));
  const run = runs.find(
    (candidate) =>
      candidate &&
      [".github/workflows/ci.yml", ".github/workflows/ci.yml@refs/heads/main"].includes(
        candidate.path,
      ) &&
      String(candidate.repository?.id) === repositoryId &&
      String(candidate.head_repository?.id) === repositoryId &&
      candidate.head_sha === sourceSha &&
      candidate.head_branch === "main" &&
      candidate.event === "push" &&
      candidate.status === "completed" &&
      candidate.conclusion === "success" &&
      isId(candidate.id) &&
      isId(candidate.run_attempt),
  );
  if (!run) throw new Error("current main has no successful exact-source CI run");
  return { id: run.id, attempt: run.run_attempt };
}

export function verifyCiGate(jobs, sourceSha, run) {
  assert(Array.isArray(jobs));
  const gates = jobs.filter((job) => job?.name === "ci-required");
  if (
    gates.length !== 1 ||
    gates[0].run_id !== run.id ||
    gates[0].run_attempt !== run.attempt ||
    gates[0].head_sha !== sourceSha ||
    gates[0].status !== "completed" ||
    gates[0].conclusion !== "success"
  )
    throw new Error("ci-required did not succeed on the exact main CI attempt");
}

export function verifyApkPackage(badging, versionName, versionCode) {
  assert.match(versionName, VERSION);
  assert.match(versionCode, DECIMAL);
  assert(Number(versionCode) <= 2 ** 31 - 1);
  const packages = badging.split(/\r?\n/u).filter((line) => line.startsWith("package: "));
  const expected = `package: name='app.markiro.handheld' versionCode='${versionCode}' versionName='${versionName}'`;
  if (
    packages.length !== 1 ||
    !(packages[0] === expected || packages[0].startsWith(expected + " ")) ||
    /^application-debuggable(?:\r?$|:)/mu.test(badging)
  )
    throw new Error("APK is not the expected non-debuggable Markiro handheld release");
}

export function verifySigningCertificate(output) {
  const lines = output.split(/\r?\n/u);
  const signerCounts = lines.filter((line) => line.startsWith("Number of signers:"));
  const certificates = lines.filter((line) => line.includes("certificate SHA-256 digest:"));
  if (
    signerCounts.length !== 1 ||
    signerCounts[0] !== "Number of signers: 1" ||
    certificates.length !== 1 ||
    ![
      `Signer #1 certificate SHA-256 digest: ${HANDHELD_SIGNING_CERTIFICATE_SHA256}`,
      `V2 Signer: certificate SHA-256 digest: ${HANDHELD_SIGNING_CERTIFICATE_SHA256}`,
    ].includes(certificates[0])
  )
    throw new Error("APK signature does not match the existing handheld release key");
}

async function authorize() {
  const repo = "thevladbog/markiro";
  if (
    process.env.GITHUB_REPOSITORY !== repo ||
    process.env.GITHUB_REF !== HANDHELD_PUBLISHER_TAG ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
  )
    throw new Error("stable handheld release requires the pinned publisher tag");
  const gh = (...args) =>
    JSON.parse(
      execFileSync("gh", ["api", "-X", "GET", ...args], {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
      }),
    );
  const sourceSha = gh(`repos/${repo}/branches/main`).commit?.sha;
  assert.match(sourceSha, SHA);
  const runs = gh(
    `repos/${repo}/actions/workflows/ci.yml/runs`,
    "-f",
    "branch=main",
    "-f",
    "event=push",
    "-f",
    `head_sha=${sourceSha}`,
    "-f",
    "status=success",
    "-F",
    "per_page=100",
  );
  const run = requireMainCiRun(runs.workflow_runs, sourceSha, process.env.GITHUB_REPOSITORY_ID);
  const jobs = gh(
    `repos/${repo}/actions/runs/${run.id}/attempts/${run.attempt}/jobs`,
    "-F",
    "per_page=100",
  );
  assert.equal(jobs.total_count, jobs.jobs.length);
  verifyCiGate(jobs.jobs, sourceSha, run);
  const next = await resolveRelease({ channel: "stable", bump: process.env.BUMP });
  assert.match(next.versionName, VERSION);
  assert(isId(next.versionCode));
  await appendFile(
    process.env.GITHUB_OUTPUT,
    [
      `source_sha=${sourceSha}`,
      `version_name=${next.versionName}`,
      `version_code=${next.versionCode}`,
      `ci_run_id=${run.id}`,
      `ci_run_attempt=${run.attempt}`,
      "",
    ].join("\n"),
  );
}

async function inspectApk(apkPath, versionName, versionCode, aapt, changelogPath) {
  const apk = await lstat(apkPath);
  const changelog = await lstat(changelogPath);
  assert(apk.isFile() && apk.size > 4 && apk.size <= 512 * 1024 * 1024);
  assert(changelog.isFile() && changelog.size <= 65536);
  const output = execFileSync(aapt, ["dump", "badging", apkPath], {
    encoding: "utf8",
    timeout: 60000,
  });
  verifyApkPackage(output, versionName, versionCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "authorize" && !args.length) {
    await authorize();
  } else if (command === "check-apk" && args.length === 5) {
    await inspectApk(...args);
  } else if (command === "check-certificate" && args.length === 2) {
    const [apksigner, apkPath] = args;
    const output = execFileSync(apksigner, ["verify", "--verbose", "--print-certs", apkPath], {
      encoding: "utf8",
      timeout: 60000,
    });
    verifySigningCertificate(output);
    console.log(HANDHELD_SIGNING_CERTIFICATE_SHA256);
  } else {
    throw new Error("unknown handheld stable release command");
  }
}
