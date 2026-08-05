import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { scanRepositoryLeaks } from "../scripts/scan-repository-leaks.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const terraformRoots = ["bootstrap", "production"];

async function readRepositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function candidateRepositoryFiles(root = repositoryRoot) {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

async function scanFixture(relativePath, contents = "fixture") {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "markiro-infra-contract-"));
  const fixturePath = path.join(fixtureRoot, relativePath);

  try {
    execFileSync("git", ["init", "--quiet"], { cwd: fixtureRoot, stdio: "pipe" });
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, contents, "utf8");
    execFileSync("git", ["add", "--force", "--", relativePath], {
      cwd: fixtureRoot,
      stdio: "pipe",
    });
    return await scanRepositoryLeaks(fixtureRoot, candidateRepositoryFiles(fixtureRoot));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

test("both Terraform roots pin the exact supported toolchain", async () => {
  for (const root of terraformRoots) {
    const versions = await readRepositoryFile(`infra/yandex/${root}/versions.tf`);

    assert.match(versions, /required_version\s*=\s*"= 1\.15\.8"/);
    assert.match(versions, /source\s*=\s*"yandex-cloud\/yandex"/);
    assert.match(versions, /version\s*=\s*"= 0\.215\.0"/);
    assert.doesNotMatch(versions, /latest|>=|~>/);
  }
});

test("provider configuration uses variables and leaves the IAM token to YC_TOKEN", async () => {
  for (const root of terraformRoots) {
    const providers = await readRepositoryFile(`infra/yandex/${root}/providers.tf`);
    const variables = await readRepositoryFile(`infra/yandex/${root}/variables.tf`);

    assert.match(providers, /cloud_id\s*=\s*var\.cloud_id/);
    assert.match(providers, /folder_id\s*=\s*var\.folder_id/);
    assert.equal(/\btoken\s*=/.test(providers), false);
    assert.match(variables, /variable\s+"cloud_id"\s*{/);
    assert.match(variables, /variable\s+"folder_id"\s*{/);
    assert.equal(
      /default\s*=\s*"[^"\s]+"/.test(variables),
      false,
      `${root} input variables must not have nonblank defaults`,
    );
  }
});

test("production uses a credential-free partial S3 backend", async () => {
  const productionVersions = await readRepositoryFile("infra/yandex/production/versions.tf");
  const backendExample = await readRepositoryFile("infra/yandex/production/backend.hcl.example");

  assert.match(productionVersions, /backend\s+"s3"\s*{\s*}/s);
  assert.equal(
    /access_key|secret_key|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/i.test(productionVersions),
    false,
    "the partial backend must not contain authentication settings",
  );
  assert.match(backendExample, /bucket\s*=/);
  assert.match(backendExample, /key\s*=/);
  assert.match(backendExample, /region\s*=/);
  assert.match(backendExample, /storage\.yandexcloud\.net/);
  assert.equal(
    /access_key|secret_key|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/i.test(backendExample),
    false,
    "the backend example must not contain authentication settings",
  );
});

test("Yandex infrastructure ignores local Terraform artifacts but keeps contracts", async () => {
  const gitignore = await readRepositoryFile(".gitignore");

  for (const pattern of [".terraform/", "*.tfstate*", "*.tfplan", "*.auto.tfvars", "backend.hcl"]) {
    assert.match(
      gitignore,
      new RegExp(`^${pattern.replaceAll(".", "\\.").replaceAll("*", ".*")}$`, "m"),
    );
  }
  assert.match(gitignore, /^!.*\.terraform\.lock\.hcl$/m);
  assert.match(gitignore, /^!.*\.example$/m);
});

test("repository candidates contain no state, plans, or credential material", async () => {
  const files = candidateRepositoryFiles();
  const violations = await scanRepositoryLeaks(repositoryRoot, files);

  assert.deepEqual(violations, []);
});

test("repository scanner rejects a committed Terraform state", async () => {
  assert.deepEqual(await scanFixture("infra/yandex/terraform.tfstate"), [
    {
      relativePath: "infra/yandex/terraform.tfstate",
      reason: "forbidden Terraform artifact",
    },
  ]);
});

test("repository scanner rejects a committed Terraform plan", async () => {
  assert.deepEqual(await scanFixture("infra/yandex/release.tfplan"), [
    {
      relativePath: "infra/yandex/release.tfplan",
      reason: "forbidden Terraform artifact",
    },
  ]);
});

test("repository scanner rejects generated backend configuration", async () => {
  assert.deepEqual(await scanFixture("infra/yandex/production/backend.hcl"), [
    {
      relativePath: "infra/yandex/production/backend.hcl",
      reason: "forbidden Terraform artifact",
    },
  ]);
});

test("repository scanner rejects literal credentials in an unlisted extension", async () => {
  const credentialAssignment = `${["to", "ken"].join("")} = ${JSON.stringify(
    ["test", "only", "placeholder"].join("-"),
  )}`;

  assert.deepEqual(await scanFixture("infra/yandex/credentials.txt", credentialAssignment), [
    {
      relativePath: "infra/yandex/credentials.txt",
      reason: "literal credential material",
    },
  ]);
});

test("repository scanner rejects a nonblank secret variable default", async () => {
  const secretVariable = `variable ${JSON.stringify(
    ["to", "ken"].join(""),
  )} { default = ${JSON.stringify(["test", "only", "placeholder"].join("-"))} }`;

  assert.deepEqual(await scanFixture("infra/yandex/variables.tf", secretVariable), [
    {
      relativePath: "infra/yandex/variables.tf",
      reason: "nonblank secret variable default",
    },
  ]);
});

test("toolchain checker accepts the committed exact-version locks", () => {
  execFileSync(process.execPath, ["infra/yandex/scripts/check-toolchain.mjs"], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
});
