import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9._+/=-]{1,256}$/;
const KEY =
  /^(production\/plans\/([0-9]+)\/([1-9][0-9]*)\/([0-9a-f]{40})\/(true|false)-(true|false)\/)production\.tfplan$/;

function invalid() {
  throw new Error("invalid Terraform plan escrow binding");
}

function matchesExactly(value, pattern) {
  const match = typeof value === "string" ? pattern.exec(value) : null;
  return match !== null && match[0] === value;
}

export function validateTerraformPlanBinding(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const expectedKeys = [
    "targetSha",
    "enablePublicDns",
    "enableStationReleasePublicDns",
    "planKey",
    "planSha256",
    "planVersionId",
    "planJsonKey",
    "planJsonSha256",
    "planJsonVersionId",
    "reviewConfirmed",
  ];
  if (Object.keys(input).sort().join(",") !== expectedKeys.sort().join(",")) invalid();
  if (
    !matchesExactly(input.targetSha, SHA) ||
    !["true", "false"].includes(input.enablePublicDns) ||
    !["true", "false"].includes(input.enableStationReleasePublicDns) ||
    !matchesExactly(input.planSha256, SHA256) ||
    !matchesExactly(input.planJsonSha256, SHA256) ||
    !matchesExactly(input.planVersionId, VERSION) ||
    !matchesExactly(input.planJsonVersionId, VERSION) ||
    input.planVersionId === "null" ||
    input.planJsonVersionId === "null" ||
    input.reviewConfirmed !== "true"
  ) {
    invalid();
  }
  const match = KEY.exec(input.planKey);
  if (
    !match ||
    match[0] !== input.planKey ||
    match[4] !== input.targetSha ||
    match[5] !== input.enablePublicDns ||
    match[6] !== input.enableStationReleasePublicDns ||
    input.planJsonKey !== `${match[1]}production-plan.json`
  ) {
    invalid();
  }
  return { sourceRunId: match[2], sourceRunAttempt: match[3], planPrefix: match[1] };
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (command !== "validate" || args.length !== 11) invalid();
  const [
    targetSha,
    enablePublicDns,
    enableStationReleasePublicDns,
    planKey,
    planSha256,
    planVersionId,
    planJsonKey,
    planJsonSha256,
    planJsonVersionId,
    reviewConfirmed,
    outputPath,
  ] = args;
  if (!isAbsolute(outputPath) || resolve(outputPath) !== outputPath) invalid();
  const result = validateTerraformPlanBinding({
    targetSha,
    enablePublicDns,
    enableStationReleasePublicDns,
    planKey,
    planSha256,
    planVersionId,
    planJsonKey,
    planJsonSha256,
    planJsonVersionId,
    reviewConfirmed,
  });
  const handle = await open(outputPath, "wx", 0o600);
  try {
    await handle.writeFile(
      `source_run_id=${result.sourceRunId}\nsource_run_attempt=${result.sourceRunAttempt}\nplan_prefix=${result.planPrefix}\n`,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main();
  } catch {
    process.stderr.write("invalid Terraform plan escrow binding\n");
    process.exitCode = 1;
  }
}
