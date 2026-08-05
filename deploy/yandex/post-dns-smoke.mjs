import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import { validateProductionDomain } from "../production/production-domain.mjs";
import { runPublicSmoke } from "../production/smoke.mjs";
import { isMainModule } from "./cli-main.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function invalid() {
  return new Error("post-DNS smoke evidence is invalid");
}

function required(name, environment, pattern = /.+/) {
  const value = environment[name];
  if (typeof value !== "string" || !pattern.test(value)) throw invalid();
  return value;
}

function timestamp(value) {
  if (typeof value !== "string") throw invalid();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw invalid();
  return parsed;
}

function parseExact(text, keys, validate) {
  try {
    const value = JSON.parse(text);
    if (!value || Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
      throw invalid();
    validate(value);
    return value;
  } catch {
    throw invalid();
  }
}

function parseFinalizedRelease(text) {
  return parseExact(
    text,
    ["deploymentPhase", "deploymentRunId", "finalizedAt", "releaseRunId", "releaseSha"],
    (value) => {
      if (
        value.deploymentPhase !== "first" ||
        !RUN_ID_PATTERN.test(value.deploymentRunId) ||
        !RUN_ID_PATTERN.test(value.releaseRunId) ||
        !SHA_PATTERN.test(value.releaseSha)
      )
        throw invalid();
      timestamp(value.finalizedAt);
    },
  );
}

function parseDnsApply(text) {
  return parseExact(
    text,
    ["appliedAt", "dnsApplyRunId", "publicDnsEnabled", "releaseSha"],
    (value) => {
      if (
        value.publicDnsEnabled !== true ||
        !RUN_ID_PATTERN.test(value.dnsApplyRunId) ||
        !SHA_PATTERN.test(value.releaseSha)
      )
        throw invalid();
      timestamp(value.appliedAt);
    },
  );
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseConvergence(text) {
  return parseExact(
    text,
    [
      "appliedAt",
      "approvedA",
      "approvedAaaa",
      "authoritativeServer",
      "dnsApplyArtifactDigest",
      "dnsApplyRunId",
      "domain",
      "publicResolvers",
      "releaseSha",
      "verificationAttempt",
      "verifiedAt",
      "verifierRunAttempt",
      "verifierRunId",
    ],
    (value) => {
      validateProductionDomain(value.domain);
      if (
        !isStringArray(value.approvedA) ||
        !isStringArray(value.approvedAaaa) ||
        !isStringArray(value.publicResolvers) ||
        value.publicResolvers.length === 0 ||
        typeof value.authoritativeServer !== "string" ||
        !DIGEST_PATTERN.test(value.dnsApplyArtifactDigest) ||
        !RUN_ID_PATTERN.test(value.dnsApplyRunId) ||
        !SHA_PATTERN.test(value.releaseSha) ||
        !Number.isSafeInteger(value.verificationAttempt) ||
        value.verificationAttempt < 1 ||
        !RUN_ID_PATTERN.test(value.verifierRunAttempt) ||
        !RUN_ID_PATTERN.test(value.verifierRunId)
      )
        throw invalid();
      timestamp(value.appliedAt);
      timestamp(value.verifiedAt);
    },
  );
}

async function fetchCurrentMainSha(environment) {
  const repository = required(
    "GITHUB_REPOSITORY",
    environment,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  );
  const token = required("GITHUB_TOKEN", environment);
  const response = await fetch(`https://api.github.com/repos/${repository}/git/ref/heads/main`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  if (!response.ok) throw invalid();
  const sha = (await response.json())?.object?.sha;
  if (!SHA_PATTERN.test(sha)) throw invalid();
  return sha;
}

export async function runPostDnsSmoke(environment = process.env, supplied = {}) {
  const dependencies = {
    readFile,
    writeFile,
    smoke: runPublicSmoke,
    currentMainSha: () => fetchCurrentMainSha(environment),
    now: () => new Date(),
    ...supplied,
  };
  const domain = validateProductionDomain(environment.MARKIRO_DOMAIN);
  const releaseSha = required("RELEASE_SHA", environment, SHA_PATTERN);
  const releaseRunId = required("RELEASE_RUN_ID", environment, RUN_ID_PATTERN);
  const deploymentRunId = required("DEPLOYMENT_RUN_ID", environment, RUN_ID_PATTERN);
  const dnsApplyRunId = required("DNS_APPLY_RUN_ID", environment, RUN_ID_PATTERN);
  const dnsVerifierRunId = required("DNS_VERIFIER_RUN_ID", environment, RUN_ID_PATTERN);
  const dnsConvergenceArtifactDigest = required(
    "DNS_CONVERGENCE_ARTIFACT_DIGEST",
    environment,
    DIGEST_PATTERN,
  );
  const smokeRunId = required("GITHUB_RUN_ID", environment, RUN_ID_PATTERN);
  if (environment.GITHUB_REF !== "refs/heads/main" || environment.GITHUB_SHA !== releaseSha)
    throw invalid();

  const finalized = parseFinalizedRelease(
    await dependencies.readFile(required("FINALIZED_RELEASE_PATH", environment), "utf8"),
  );
  const dnsApply = parseDnsApply(
    await dependencies.readFile(required("DNS_APPLY_RECEIPT_PATH", environment), "utf8"),
  );
  const convergence = parseConvergence(
    await dependencies.readFile(required("DNS_CONVERGENCE_RECEIPT_PATH", environment), "utf8"),
  );
  if (
    finalized.releaseSha !== releaseSha ||
    finalized.releaseRunId !== releaseRunId ||
    finalized.deploymentRunId !== deploymentRunId ||
    dnsApply.releaseSha !== releaseSha ||
    dnsApply.dnsApplyRunId !== dnsApplyRunId ||
    convergence.releaseSha !== releaseSha ||
    convergence.dnsApplyRunId !== dnsApplyRunId ||
    convergence.verifierRunId !== dnsVerifierRunId ||
    convergence.dnsApplyArtifactDigest !==
      required("DNS_APPLY_ARTIFACT_DIGEST", environment, DIGEST_PATTERN) ||
    convergence.domain !== domain ||
    convergence.appliedAt !== dnsApply.appliedAt
  )
    throw invalid();

  const finalizedAt = timestamp(finalized.finalizedAt);
  const appliedAt = timestamp(dnsApply.appliedAt);
  const verifiedAt = timestamp(convergence.verifiedAt);
  const smokeStartedAt = dependencies.now();
  if (!(finalizedAt < appliedAt && appliedAt < verifiedAt && verifiedAt < smokeStartedAt))
    throw invalid();
  if ((await dependencies.currentMainSha()) !== releaseSha) throw invalid();
  await dependencies.smoke({ baseUrl: `https://${domain}`, expectedReleaseSha: releaseSha });
  if ((await dependencies.currentMainSha()) !== releaseSha) throw invalid();
  const smokeAt = dependencies.now();
  if (!(verifiedAt < smokeAt)) throw invalid();

  const receipt = {
    appliedAt: dnsApply.appliedAt,
    deploymentRunId,
    dnsApplyArtifactDigest: convergence.dnsApplyArtifactDigest,
    dnsApplyRunId,
    dnsConvergenceArtifactDigest,
    dnsVerifierRunId,
    finalizedAt: finalized.finalizedAt,
    releaseRunId,
    releaseSha,
    smokeAt: smokeAt.toISOString(),
    smokeRunId,
    verifiedAt: convergence.verifiedAt,
  };
  await dependencies.writeFile(
    required("SMOKE_RECEIPT_PATH", environment),
    `${JSON.stringify(receipt)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return receipt;
}

if (isMainModule(import.meta.url)) {
  if (process.argv[2] !== "run") {
    process.stderr.write("post-DNS smoke failed\n");
    process.exitCode = 1;
  } else
    runPostDnsSmoke().catch(() => {
      process.stderr.write("post-DNS smoke failed\n");
      process.exitCode = 1;
    });
}
