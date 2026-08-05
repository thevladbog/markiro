import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { scanRepositoryLeaks } from "../scripts/scan-repository-leaks.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const terraformRoots = ["bootstrap", "production"];
const reviewedNonUtf8Candidates = new Map([
  [
    "apps/api/test/fixtures/commerceml/import-cp1251.xml",
    "12ab20d74e2de16275d2b25104db83d7a9989dd975df3460fdaa19d6f2b47eec",
  ],
  [
    "apps/kiosk/public/icon-192.png",
    "2df023b2b2bf5ef4937ee5326b7648d5078446e0c4c9fc64fd17852c6e64d155",
  ],
  [
    "apps/kiosk/public/icon-512.png",
    "27b6f4caf19eb5e53b5100122351151b4d526894ccf90932620c043da1a245ec",
  ],
  [
    "apps/kiosk/public/icon-maskable-512.png",
    "cae36541e97a1c22d28c55b02715d9adf40113b54db63910acbff36a5836d4b2",
  ],
  [
    "apps/station/src-tauri/icons/128x128.png",
    "05055aee4d39fd8a1e36c662ec81570e5642de71e7c56a4adc21cc656a79ea93",
  ],
  [
    "apps/station/src-tauri/icons/128x128@2x.png",
    "2eea5e93ae86e9f66f0572b772a2a5838a1660e7907701eea378268cd2f412b8",
  ],
  [
    "apps/station/src-tauri/icons/32x32.png",
    "33f22f1b9173cd9d502f3915d58dc55523b63c13e11dc396a698b45932c0ea6f",
  ],
  [
    "apps/station/src-tauri/icons/64x64.png",
    "7973b75a7160bbd662a2a258111ff07086e15aa2086e1236e3bcd436d8b0eee5",
  ],
  [
    "apps/station/src-tauri/icons/icon.icns",
    "970b55a217645966e990bb715b286325735f38f685e32f4707ae6d893a372340",
  ],
  [
    "apps/station/src-tauri/icons/icon.ico",
    "ac677017964ca93519a2206fc27e13a3962a9bf082e3824a324d2ed38466936a",
  ],
  [
    "apps/station/src-tauri/icons/icon.png",
    "24386a483f0c6ca48467cd16e4fc3e49d5712d72d549802ee8a91053a7bdb6de",
  ],
  [
    "docs/superpowers/plans/2026-07-23-pickup-kiosk-a-backend-admin.md",
    "b9a52ee02b06e261de44439b99a09e085b99cae68ac501b0567d519aef38e6bd",
  ],
]);

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
    await writeFile(fixturePath, contents);
    execFileSync("git", ["add", "--force", "--", relativePath], {
      cwd: fixtureRoot,
      stdio: "pipe",
    });
    return await scanRepositoryLeaks(fixtureRoot, candidateRepositoryFiles(fixtureRoot));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function reviewedNonUtf8Violations() {
  const violations = [];

  for (const [relativePath, expectedDigest] of reviewedNonUtf8Candidates) {
    const contents = await readFile(path.join(repositoryRoot, relativePath));
    const actualDigest = createHash("sha256").update(contents).digest("hex");

    assert.equal(
      actualDigest === expectedDigest,
      true,
      `${relativePath} reviewed non-UTF-8 content changed`,
    );
    violations.push({ relativePath, reason: "binary or invalid UTF-8 candidate" });
  }

  return violations.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
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
  const expectedViolations = await reviewedNonUtf8Violations();

  assert.deepEqual(
    violations.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    expectedViolations,
  );
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

test("repository scanner rejects a force-staged credential under a generated path", async () => {
  const credentialAssignment = `${["to", "ken"].join("")} = ${JSON.stringify(
    ["test", "only", "placeholder"].join("-"),
  )}`;

  assert.deepEqual(
    await scanFixture("infra/yandex/.terraform/credentials.txt", credentialAssignment),
    [
      {
        relativePath: "infra/yandex/.terraform/credentials.txt",
        reason: "literal credential material",
      },
    ],
  );
});

test("repository scanner rejects an HCL credential followed by an inline comment", async () => {
  const credentialAssignment = `${["access", "key"].join("_")} = ${JSON.stringify(
    ["test", "only", "placeholder"].join("-"),
  )} # test fixture`;

  assert.deepEqual(await scanFixture("infra/yandex/backend.tf", credentialAssignment), [
    {
      relativePath: "infra/yandex/backend.tf",
      reason: "literal credential material",
    },
  ]);
});

test("repository scanner rejects a YAML credential literal", async () => {
  const credentialAssignment = `${["access", "key"].join("_")}: ${JSON.stringify(
    ["test", "only", "placeholder"].join("-"),
  )}`;

  assert.deepEqual(await scanFixture("infra/yandex/backend.yaml", credentialAssignment), [
    {
      relativePath: "infra/yandex/backend.yaml",
      reason: "literal credential material",
    },
  ]);
});

test("repository scanner rejects a JSON credential literal", async () => {
  const credentialDocument = JSON.stringify({
    [["access", "key"].join("_")]: ["test", "only", "placeholder"].join("-"),
  });

  assert.deepEqual(await scanFixture("infra/yandex/backend.json", credentialDocument), [
    {
      relativePath: "infra/yandex/backend.json",
      reason: "literal credential material",
    },
  ]);
});

test("repository scanner permits runtime credential variable references without values", async () => {
  const runtimeReferences = [
    "AWS_ACCESS_KEY_ID",
    `${["access", "key"].join("_")} = var.backend_access_key`,
  ].join("\n");

  assert.deepEqual(await scanFixture("infra/yandex/runtime-inputs.txt", runtimeReferences), []);
});

test("repository scanner rejects a staged binary candidate without exposing bytes", async () => {
  assert.deepEqual(
    await scanFixture("infra/yandex/binary-candidate.bin", Buffer.from([0x00, 0x01, 0x02, 0x03])),
    [
      {
        relativePath: "infra/yandex/binary-candidate.bin",
        reason: "binary or invalid UTF-8 candidate",
      },
    ],
  );
});

test("repository scanner rejects a staged invalid UTF-8 candidate", async () => {
  assert.deepEqual(
    await scanFixture("infra/yandex/invalid-utf8.bin", Buffer.from([0xff, 0xfe, 0xfd])),
    [
      {
        relativePath: "infra/yandex/invalid-utf8.bin",
        reason: "binary or invalid UTF-8 candidate",
      },
    ],
  );
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
