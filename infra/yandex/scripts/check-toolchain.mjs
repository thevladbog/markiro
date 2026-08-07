import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const expectedTerraformVersion = "1.15.8";
const expectedProviderVersion = "0.215.0";
const requiredPlatforms = ["linux_amd64", "darwin_arm64"];
const requiredProviderHashes = new Set([
  "XcpKtZSqo9Z2NyMvwXfDcFCzbZkGTF8q4q2otcLgsEs=",
  "D5dxRfp+hEos4MOTLb1riN455KNtdpNeP5MEtA9wX+o=",
]);
const terraformRoots = ["bootstrap", "production"];

function readTerraformVersion() {
  let output;

  try {
    output = execFileSync("terraform", ["version", "-json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const reason = error.code === "ENOENT" ? "terraform was not found" : "terraform version failed";
    throw new Error(`${reason}; install Terraform ${expectedTerraformVersion}`);
  }

  return JSON.parse(output);
}

function providerBlock(lockFile) {
  const match = lockFile.match(
    /provider "registry\.terraform\.io\/yandex-cloud\/yandex" {([\s\S]*?)\n}/,
  );
  assert.ok(match, "Yandex provider is missing from the lock file");
  return match[1];
}

const version = readTerraformVersion();
assert.equal(
  version.terraform_version,
  expectedTerraformVersion,
  `Terraform must be exactly ${expectedTerraformVersion}`,
);
assert.ok(
  requiredPlatforms.includes(version.platform),
  `Terraform must run on ${requiredPlatforms.join(" or ")}`,
);

for (const root of terraformRoots) {
  const lockPath = path.join(repositoryRoot, "infra/yandex", root, ".terraform.lock.hcl");
  const lockFile = await readFile(lockPath, "utf8");
  const block = providerBlock(lockFile);
  const lockedVersion = block.match(/\n\s*version\s*=\s*"([^"]+)"/);
  const constraints = block.match(/\n\s*constraints\s*=\s*"([^"]+)"/);
  const platformHashes = [...block.matchAll(/"h1:([^"]+)"/g)].map(([, hash]) => hash);

  assert.equal(
    lockedVersion?.[1],
    expectedProviderVersion,
    `${root} must lock Yandex provider ${expectedProviderVersion}`,
  );
  assert.equal(
    constraints?.[1],
    expectedProviderVersion,
    `${root} must preserve the exact provider constraint`,
  );
  assert.deepEqual(
    new Set(platformHashes),
    requiredProviderHashes,
    `${root} must contain the exact hashes generated for ${requiredPlatforms.join(" and ")}`,
  );
}

console.log(
  `Terraform ${expectedTerraformVersion} and Yandex provider ${expectedProviderVersion} locks verified for ${requiredPlatforms.join(", ")}.`,
);
