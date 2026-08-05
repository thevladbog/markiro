import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import { validateProductionDomain } from "../production/production-domain.mjs";
import { runPublicSmoke } from "../production/smoke.mjs";
import { isMainModule } from "./cli-main.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const EVIDENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

function required(name, environment) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error("post-DNS smoke configuration is incomplete");
  return value;
}

function runId(name, environment) {
  const value = required(name, environment);
  if (!RUN_ID_PATTERN.test(value)) throw new Error("post-DNS smoke evidence is invalid");
  return value;
}

function parseFinalizedRelease(text) {
  try {
    const value = JSON.parse(text);
    if (
      !value ||
      Object.keys(value).sort().join(",") !==
        "deploymentPhase,deploymentRunId,finalizedAt,releaseRunId,releaseSha" ||
      value.deploymentPhase !== "first" ||
      !RUN_ID_PATTERN.test(value.deploymentRunId) ||
      !RUN_ID_PATTERN.test(value.releaseRunId) ||
      !SHA_PATTERN.test(value.releaseSha) ||
      typeof value.finalizedAt !== "string" ||
      new Date(value.finalizedAt).toISOString() !== value.finalizedAt
    )
      throw new Error();
    return value;
  } catch {
    throw new Error("post-DNS smoke evidence is invalid");
  }
}

function parseDnsApply(text) {
  try {
    const value = JSON.parse(text);
    if (
      !value ||
      Object.keys(value).sort().join(",") !==
        "appliedAt,dnsApplyRunId,publicDnsEnabled,releaseSha" ||
      value.publicDnsEnabled !== true ||
      !RUN_ID_PATTERN.test(value.dnsApplyRunId) ||
      !SHA_PATTERN.test(value.releaseSha) ||
      typeof value.appliedAt !== "string" ||
      new Date(value.appliedAt).toISOString() !== value.appliedAt
    )
      throw new Error();
    return value;
  } catch {
    throw new Error("post-DNS smoke evidence is invalid");
  }
}

export async function runPostDnsSmoke(environment = process.env, supplied = {}) {
  const dependencies = {
    readFile,
    writeFile,
    smoke: runPublicSmoke,
    now: () => new Date(),
    ...supplied,
  };
  const domain = validateProductionDomain(environment.MARKIRO_DOMAIN);
  const releaseSha = required("RELEASE_SHA", environment);
  const releaseRunId = runId("RELEASE_RUN_ID", environment);
  const deploymentRunId = runId("DEPLOYMENT_RUN_ID", environment);
  const dnsApplyRunId = runId("DNS_APPLY_RUN_ID", environment);
  const smokeRunId = runId("GITHUB_RUN_ID", environment);
  const evidenceId = required("DNS_CONVERGENCE_EVIDENCE_ID", environment);
  if (!SHA_PATTERN.test(releaseSha) || !EVIDENCE_PATTERN.test(evidenceId))
    throw new Error("post-DNS smoke evidence is invalid");
  const finalized = parseFinalizedRelease(
    await dependencies.readFile(required("FINALIZED_RELEASE_PATH", environment), "utf8"),
  );
  const dnsApply = parseDnsApply(
    await dependencies.readFile(required("DNS_APPLY_RECEIPT_PATH", environment), "utf8"),
  );
  if (
    finalized.releaseSha !== releaseSha ||
    finalized.releaseRunId !== releaseRunId ||
    finalized.deploymentRunId !== deploymentRunId ||
    dnsApply.releaseSha !== releaseSha ||
    dnsApply.dnsApplyRunId !== dnsApplyRunId
  )
    throw new Error("post-DNS smoke evidence is invalid");

  await dependencies.smoke({ baseUrl: `https://${domain}` });
  const receipt = {
    deploymentRunId,
    dnsApplyRunId,
    dnsConvergenceEvidenceId: evidenceId,
    releaseSha,
    smokeRunId,
    verifiedAt: dependencies.now().toISOString(),
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
