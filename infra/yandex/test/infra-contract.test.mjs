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

function terraformResourceBlock(source, type, name) {
  const declaration = new RegExp(`resource\\s+"${type}"\\s+"${name}"\\s*\\{`).exec(source);

  assert.ok(declaration, `missing resource ${type}.${name}`);

  const openingBrace = source.indexOf("{", declaration.index);
  let depth = 0;

  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(declaration.index, index + 1);
  }

  assert.fail(`unterminated resource ${type}.${name}`);
}

function terraformOutputBlock(source, name) {
  const declaration = new RegExp(`output\\s+"${name}"\\s*\\{`).exec(source);

  assert.ok(declaration, `missing output ${name}`);

  const openingBrace = source.indexOf("{", declaration.index);
  let depth = 0;

  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(declaration.index, index + 1);
  }

  assert.fail(`unterminated output ${name}`);
}

function replaceTerraformResource(source, type, name, mutate) {
  const block = terraformResourceBlock(source, type, name);
  return source.replace(block, mutate(block));
}

function assertProtectedBootstrap({ bootstrap, iam, outputs, variables }) {
  const allHcl = [bootstrap, iam, outputs, variables].join("\n");
  const serviceAccounts = [...iam.matchAll(/resource\s+"yandex_iam_service_account"\s+"([^"]+)"/g)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(serviceAccounts, ["app", "audit", "runner", "state", "terraform"]);
  assert.equal(
    (iam.match(/resource\s+"yandex_iam_workload_identity_oidc_federation"\s+/g) ?? []).length,
    1,
    "exactly one provider-supported OIDC workload identity federation is required",
  );
  assert.equal(
    (iam.match(/resource\s+"yandex_iam_workload_identity_oidc_federation_iam_binding"\s+/g) ?? [])
      .length,
    1,
    "the OIDC federation requires one exact user binding",
  );
  assert.equal(
    (iam.match(/resource\s+"yandex_iam_workload_identity_federated_credential"\s+/g) ?? []).length,
    1,
    "exactly one repository-and-environment credential is required",
  );

  assert.doesNotMatch(
    allHcl,
    /yandex_iam_service_account_(?:static_)?access_key/,
    "Terraform must not create long-lived service-account access keys",
  );
  assert.doesNotMatch(
    allHcl,
    /yandex_lockbox_secret_version/,
    "Terraform must create secret containers without payload versions",
  );

  const stateBucket = terraformResourceBlock(bootstrap, "yandex_storage_bucket", "state");
  assert.match(stateBucket, /versioning\s*\{[\s\S]*?enabled\s*=\s*true/);
  assert.match(stateBucket, /lifecycle\s*\{[\s\S]*?prevent_destroy\s*=\s*true/);

  const secretNames = ["runtime", "state_backend", "runner_registration"];
  const lockboxSecrets = [...bootstrap.matchAll(/resource\s+"yandex_lockbox_secret"\s+"([^"]+)"/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(lockboxSecrets, [...secretNames].sort());
  for (const name of secretNames) {
    assert.match(
      terraformResourceBlock(bootstrap, "yandex_lockbox_secret", name),
      /lifecycle\s*\{[\s\S]*?prevent_destroy\s*=\s*true/,
      `${name} secret container must be protected from destroy`,
    );
  }

  assert.match(
    variables,
    /variable\s+"github_repository"\s*\{[\s\S]*?condition\s*=\s*var\.github_repository\s*==\s*"thevladbog\/q"/,
  );
  assert.match(
    variables,
    /variable\s+"github_environment"\s*\{[\s\S]*?condition\s*=\s*var\.github_environment\s*==\s*"production"/,
  );
  assert.match(
    iam,
    /github_subject\s*=\s*"repo:\$\{var\.github_repository\}:environment:\$\{var\.github_environment\}"/,
  );

  const federation = terraformResourceBlock(
    iam,
    "yandex_iam_workload_identity_oidc_federation",
    "github",
  );
  assert.match(federation, /issuer\s*=\s*"https:\/\/token\.actions\.githubusercontent\.com"/);
  assert.match(
    federation,
    /jwks_url\s*=\s*"https:\/\/token\.actions\.githubusercontent\.com\/\.well-known\/jwks"/,
  );
  assert.match(federation, /disabled\s*=\s*false/);
  assert.match(federation, /audiences\s*=\s*\[local\.github_audience\]/);

  const credential = terraformResourceBlock(
    iam,
    "yandex_iam_workload_identity_federated_credential",
    "github_production",
  );
  assert.match(credential, /service_account_id\s*=\s*yandex_iam_service_account\.terraform\.id/);
  assert.match(
    credential,
    /federation_id\s*=\s*yandex_iam_workload_identity_oidc_federation\.github\.id/,
  );
  assert.match(credential, /external_subject_id\s*=\s*local\.github_subject/);

  const federationUse = terraformResourceBlock(
    iam,
    "yandex_iam_workload_identity_oidc_federation_iam_binding",
    "terraform_user",
  );
  assert.match(federationUse, /role\s*=\s*"iam\.workloadIdentityFederations\.user"/);
  assert.match(
    federationUse,
    /members\s*=\s*\["serviceAccount:\$\{yandex_iam_service_account\.terraform\.id\}"\]/,
  );

  const stateAccess = terraformResourceBlock(
    iam,
    "yandex_storage_bucket_iam_binding",
    "state_backend",
  );
  assert.match(stateAccess, /role\s*=\s*"storage\.editor"/);
  assert.match(
    stateAccess,
    /members\s*=\s*\["serviceAccount:\$\{yandex_iam_service_account\.state\.id\}"\]/,
  );

  const secretReaders = [
    ["app_runtime", "runtime_secret_id", "app"],
    ["terraform_state_backend", "state_backend_secret_id", "terraform"],
    ["runner_registration", "runner_registration_secret_id", "runner"],
  ];
  for (const [resourceName, secretId, serviceAccount] of secretReaders) {
    const binding = terraformResourceBlock(iam, "yandex_lockbox_secret_iam_member", resourceName);
    assert.match(binding, new RegExp(`secret_id\\s*=\\s*var\\.${secretId}`));
    assert.match(binding, /role\s*=\s*"lockbox\.payloadViewer"/);
    assert.match(
      binding,
      new RegExp(
        `member\\s*=\\s*"serviceAccount:\\$\\{yandex_iam_service_account\\.${serviceAccount}\\.id\\}"`,
      ),
    );
  }

  const productionManagement = terraformResourceBlock(
    iam,
    "yandex_resourcemanager_folder_iam_member",
    "terraform_management",
  );
  assert.match(productionManagement, /role\s*=\s*"editor"/);
  assert.match(
    productionManagement,
    /member\s*=\s*"serviceAccount:\$\{yandex_iam_service_account\.terraform\.id\}"/,
  );

  const runtimeAccountReferences =
    /serviceAccount:\$\{yandex_iam_service_account\.(?:app|runner|audit)\.id\}/;
  for (const match of iam.matchAll(/resource\s+"[^"]+"\s+"[^"]+"\s*\{/g)) {
    const opening = match[0].match(/resource\s+"([^"]+)"\s+"([^"]+)"/);
    const block = terraformResourceBlock(iam, opening[1], opening[2]);
    if (runtimeAccountReferences.test(block)) {
      assert.doesNotMatch(
        block,
        /role\s*=\s*"(?:admin|editor)"/,
        "runtime accounts must not receive primitive admin or editor",
      );
    }
  }

  for (const name of [
    "service_account_ids",
    "workload_identity_federation_id",
    "state_bucket_name",
    "runtime_secret_id",
    "state_backend_secret_id",
    "runner_registration_secret_id",
  ]) {
    assert.match(
      terraformOutputBlock(outputs, name),
      /sensitive\s*=\s*true/,
      `${name} must be marked sensitive`,
    );
  }
}

async function bootstrapContractSources() {
  const [bootstrap, iam, outputs, variables] = await Promise.all([
    readRepositoryFile("infra/yandex/bootstrap/main.tf"),
    readRepositoryFile("infra/yandex/modules/iam/main.tf"),
    readRepositoryFile("infra/yandex/bootstrap/outputs.tf"),
    readRepositoryFile("infra/yandex/bootstrap/variables.tf"),
  ]);

  return { bootstrap, iam, outputs, variables };
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

test("both roots use credential-free partial S3 backends", async () => {
  for (const root of terraformRoots) {
    const versions = await readRepositoryFile(`infra/yandex/${root}/versions.tf`);
    const backendExample = await readRepositoryFile(`infra/yandex/${root}/backend.hcl.example`);

    assert.match(versions, /backend\s+"s3"\s*{\s*}/s);
    assert.equal(
      /access_key|secret_key|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/i.test(versions),
      false,
      `${root} partial backend must not contain authentication settings`,
    );
    assert.match(backendExample, /bucket\s*=/);
    assert.match(backendExample, /key\s*=/);
    assert.match(backendExample, /region\s*=/);
    assert.match(backendExample, /storage\.yandexcloud\.net/);
    assert.equal(
      /access_key|secret_key|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/i.test(backendExample),
      false,
      `${root} backend example must not contain authentication settings`,
    );
  }
});

test("bootstrap protects state, exact workload identity, secrets, and least privilege", async () => {
  assertProtectedBootstrap(await bootstrapContractSources());
});

test("bootstrap contract rejects a Terraform-managed static access key", async () => {
  const sources = await bootstrapContractSources();
  sources.iam += '\nresource "yandex_iam_service_account_static_access_key" "unsafe" {}\n';

  assert.throws(() => assertProtectedBootstrap(sources), /long-lived service-account access keys/);
});

test("bootstrap contract rejects a Terraform-managed Lockbox payload version", async () => {
  const sources = await bootstrapContractSources();
  sources.bootstrap += '\nresource "yandex_lockbox_secret_version" "unsafe" {}\n';

  assert.throws(() => assertProtectedBootstrap(sources), /without payload versions/);
});

test("bootstrap contract rejects primitive editor for the app runtime", async () => {
  const sources = await bootstrapContractSources();
  sources.iam = replaceTerraformResource(
    sources.iam,
    "yandex_lockbox_secret_iam_member",
    "app_runtime",
    (block) => block.replace('role      = "lockbox.payloadViewer"', 'role      = "editor"'),
  );

  assert.throws(() => assertProtectedBootstrap(sources), /lockbox\\.payloadViewer|primitive/);
});

test("bootstrap contract rejects disabled state versioning", async () => {
  const sources = await bootstrapContractSources();
  sources.bootstrap = replaceTerraformResource(
    sources.bootstrap,
    "yandex_storage_bucket",
    "state",
    (block) => block.replace("enabled = true", "enabled = false"),
  );

  assert.throws(() => assertProtectedBootstrap(sources), /enabled\\s\*=\\s\*true/);
});

test("bootstrap contract rejects removal of state prevent_destroy", async () => {
  const sources = await bootstrapContractSources();
  sources.bootstrap = replaceTerraformResource(
    sources.bootstrap,
    "yandex_storage_bucket",
    "state",
    (block) => block.replace("prevent_destroy = true", "prevent_destroy = false"),
  );

  assert.throws(() => assertProtectedBootstrap(sources), /prevent_destroy\\s\*=\\s\*true/);
});

test("bootstrap state migration is ordered, credential-safe, and never prints state", async () => {
  const readme = await readRepositoryFile("infra/yandex/README.md");
  const orderedBoundaries = [
    "Local bootstrap plan",
    "Approved bootstrap apply",
    "Out-of-band state HMAC creation",
    "Direct Lockbox upload",
    "Backend migration with environment credentials",
    "Remote object and version verification",
    "Secure deletion of local authoritative state",
  ];
  let previousIndex = -1;

  for (const boundary of orderedBoundaries) {
    const currentIndex = readme.indexOf(boundary);
    assert.ok(currentIndex > previousIndex, `${boundary} must appear in the safe migration order`);
    previousIndex = currentIndex;
  }

  assert.match(
    readme,
    /terraform -chdir=infra\/yandex\/bootstrap init -migrate-state -backend-config=backend\.hcl/,
  );
  assert.doesNotMatch(readme, /terraform\s+(?:show|state\s+pull)/);
  assert.doesNotMatch(
    readme,
    /(?:access_key|secret_key|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)=\S+/i,
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
