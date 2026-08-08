import { readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import process from "node:process";

import { validateProductionDomains } from "../production/production-domain.mjs";
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

function parseAnswers(value, adminDomain, kioskDomain) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  if (Object.keys(value).sort().join(",") !== [adminDomain, kioskDomain].sort().join(","))
    throw invalid();
  for (const domain of [adminDomain, kioskDomain]) {
    const answers = value[domain];
    if (
      !Array.isArray(answers) ||
      answers.length === 0 ||
      answers.some((answer) => typeof answer !== "string" || isIP(answer) === 0) ||
      new Set(answers).size !== answers.length ||
      answers.join(",") !== [...answers].sort().join(",")
    )
      throw invalid();
  }
  if (value[adminDomain].join(",") !== value[kioskDomain].join(",")) throw invalid();
  return value;
}

function sameAnswers(left, right, adminDomain, kioskDomain) {
  return [adminDomain, kioskDomain].every(
    (domain) => left[domain].join(",") === right[domain].join(","),
  );
}

function parseDnsApplyReceipt(text) {
  try {
    const value = JSON.parse(text);
    if (
      !value ||
      Object.keys(value).sort().join(",") !==
        "adminDomain,answers,appliedAt,dnsApplyRunId,kioskDomain,publicDnsEnabled,releaseSha" ||
      value.publicDnsEnabled !== true ||
      !RUN_ID_PATTERN.test(value.dnsApplyRunId) ||
      !SHA_PATTERN.test(value.releaseSha)
    )
      throw invalid();
    validateProductionDomains(value.adminDomain, value.kioskDomain);
    parseAnswers(value.answers, value.adminDomain, value.kioskDomain);
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
  const dnsOptions = dnsOptionsFromEnvironment(environment);
  const approvedAnswers = [...dnsOptions.approvedA, ...dnsOptions.approvedAaaa].sort();
  const expectedAnswers = {
    [dnsOptions.adminDomain]: [...approvedAnswers],
    [dnsOptions.kioskDomain]: [...approvedAnswers],
  };
  if (
    dnsApply.releaseSha !== releaseSha ||
    dnsApply.dnsApplyRunId !== dnsApplyRunId ||
    dnsApply.adminDomain !== dnsOptions.adminDomain ||
    dnsApply.kioskDomain !== dnsOptions.kioskDomain ||
    !sameAnswers(dnsApply.answers, expectedAnswers, dnsOptions.adminDomain, dnsOptions.kioskDomain)
  )
    throw invalid();

  const verification = await dependencies.verifyDns(dnsOptions);
  if (!Number.isSafeInteger(verification?.attempt) || verification.attempt < 1) throw invalid();
  const verifiedAnswers = parseAnswers(
    verification.answers,
    dnsOptions.adminDomain,
    dnsOptions.kioskDomain,
  );
  if (
    !sameAnswers(verifiedAnswers, expectedAnswers, dnsOptions.adminDomain, dnsOptions.kioskDomain)
  )
    throw invalid();
  const verifiedAt = dependencies.now();
  if (verifiedAt <= parseTimestamp(dnsApply.appliedAt)) throw invalid();

  const receipt = {
    adminDomain: dnsOptions.adminDomain,
    answers: verifiedAnswers,
    appliedAt: dnsApply.appliedAt,
    authoritativeServer: dnsOptions.authoritativeServer,
    dnsApplyArtifactDigest,
    dnsApplyRunId,
    kioskDomain: dnsOptions.kioskDomain,
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
