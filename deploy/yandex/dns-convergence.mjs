import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import { dnsOptionsFromEnvironment, verifyDnsConvergence } from "../production/verify-dns.mjs";
import { isMainModule } from "./cli-main.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function invalid() {
  return new Error("DNS convergence evidence is invalid");
}

function required(name, environment, pattern) {
  const value = environment[name];
  if (typeof value !== "string" || !pattern.test(value)) throw invalid();
  return value;
}

function parseTimestamp(value) {
  if (typeof value !== "string") throw invalid();
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf()) || timestamp.toISOString() !== value) throw invalid();
  return timestamp;
}

function parseDnsApplyReceipt(text) {
  try {
    const value = JSON.parse(text);
    if (
      !value ||
      Object.keys(value).sort().join(",") !==
        "appliedAt,dnsApplyRunId,publicDnsEnabled,releaseSha" ||
      value.publicDnsEnabled !== true ||
      !RUN_ID_PATTERN.test(value.dnsApplyRunId) ||
      !SHA_PATTERN.test(value.releaseSha)
    )
      throw invalid();
    parseTimestamp(value.appliedAt);
    return value;
  } catch {
    throw invalid();
  }
}

export async function runDnsConvergence(environment = process.env, supplied = {}) {
  const dependencies = {
    readFile,
    writeFile,
    verifyDns: verifyDnsConvergence,
    now: () => new Date(),
    ...supplied,
  };
  const releaseSha = required("RELEASE_SHA", environment, SHA_PATTERN);
  const dnsApplyRunId = required("DNS_APPLY_RUN_ID", environment, RUN_ID_PATTERN);
  const dnsApplyArtifactDigest = required("DNS_APPLY_ARTIFACT_DIGEST", environment, DIGEST_PATTERN);
  const verifierRunId = required("GITHUB_RUN_ID", environment, RUN_ID_PATTERN);
  const verifierRunAttempt = required("GITHUB_RUN_ATTEMPT", environment, RUN_ID_PATTERN);
  if (environment.GITHUB_REF !== "refs/heads/main" || environment.GITHUB_SHA !== releaseSha)
    throw invalid();
  const dnsApply = parseDnsApplyReceipt(
    await dependencies.readFile(required("DNS_APPLY_RECEIPT_PATH", environment, /.+/), "utf8"),
  );
  if (dnsApply.releaseSha !== releaseSha || dnsApply.dnsApplyRunId !== dnsApplyRunId)
    throw invalid();

  const dnsOptions = dnsOptionsFromEnvironment(environment);
  const verification = await dependencies.verifyDns(dnsOptions);
  if (!Number.isSafeInteger(verification?.attempt) || verification.attempt < 1) throw invalid();
  const verifiedAt = dependencies.now();
  if (verifiedAt <= parseTimestamp(dnsApply.appliedAt)) throw invalid();

  const receipt = {
    appliedAt: dnsApply.appliedAt,
    approvedA: dnsOptions.approvedA,
    approvedAaaa: dnsOptions.approvedAaaa,
    authoritativeServer: dnsOptions.authoritativeServer,
    dnsApplyArtifactDigest,
    dnsApplyRunId,
    domain: dnsOptions.domain,
    publicResolvers: dnsOptions.publicResolvers,
    releaseSha,
    verificationAttempt: verification.attempt,
    verifiedAt: verifiedAt.toISOString(),
    verifierRunAttempt,
    verifierRunId,
  };
  await dependencies.writeFile(
    required("DNS_CONVERGENCE_RECEIPT_PATH", environment, /.+/),
    `${JSON.stringify(receipt)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return receipt;
}

if (isMainModule(import.meta.url)) {
  if (process.argv[2] !== "run") {
    process.stderr.write("DNS convergence verification failed\n");
    process.exitCode = 1;
  } else
    runDnsConvergence().catch(() => {
      process.stderr.write("DNS convergence verification failed\n");
      process.exitCode = 1;
    });
}
