import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const terraformRoots = ["bootstrap", "production"];

async function readRepositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function candidateRepositoryFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
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
  const leakedArtifacts = files.filter((file) =>
    /(?:\.tfstate(?:\.|$)|\.tfplan$|(?:^|\/)backend\.hcl$)/.test(file),
  );

  assert.deepEqual(leakedArtifacts, []);

  for (const relativePath of files.filter((candidate) =>
    /\.(?:tf|hcl|tfvars|md|mjs|json|ya?ml|sh)$/.test(candidate),
  )) {
    const file = path.join(repositoryRoot, relativePath);
    const contents = await readFile(file, "utf8");
    const hasLiteralCredential =
      /(?:access_key|secret_key|token)\s*=\s*["'][^"'\s$<>]+["']/i.test(contents) ||
      /(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|YC_TOKEN)\s*=\s*["']?[^\s"'$<>]+/i.test(contents);
    const hasNonblankSecretDefault =
      /variable\s+"(?:token|access_key|secret_key|password)"\s*{[^}]*default\s*=\s*["'][^"'\s]+["']/is.test(
        contents,
      );

    assert.equal(
      hasLiteralCredential,
      false,
      `${relativePath} contains literal credential material`,
    );
    assert.equal(
      hasNonblankSecretDefault,
      false,
      `${relativePath} contains a nonblank secret variable default`,
    );
  }
});

test("toolchain checker accepts the committed exact-version locks", () => {
  execFileSync(process.execPath, ["infra/yandex/scripts/check-toolchain.mjs"], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
});
