import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as yaml from "js-yaml";

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

function terraformNestedBlocks(source, name) {
  const blocks = [];
  const declaration = new RegExp(`\\b${name}\\s*\\{`, "g");

  for (const match of source.matchAll(declaration)) {
    const openingBrace = source.indexOf("{", match.index);
    let depth = 0;

    for (let index = openingBrace; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      if (depth === 0) {
        blocks.push(source.slice(match.index, index + 1));
        break;
      }
    }
  }

  return blocks;
}

function terraformObjectEntry(source, name) {
  const declaration = new RegExp(`^\\s*${name}\\s*=\\s*\\{`, "m").exec(source);
  assert.ok(declaration, `missing object entry ${name}`);

  const openingBrace = source.indexOf("{", declaration.index);
  let depth = 0;

  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(declaration.index, index + 1);
  }

  assert.fail(`unterminated object entry ${name}`);
}

function hasPublicCidr(ingress) {
  for (const list of ingress.matchAll(
    /\b(?:v4_cidr_blocks|v6_cidr_blocks)\s*=\s*\[([\s\S]*?)\]/g,
  )) {
    for (const cidr of list[1].matchAll(/"([^"]+)"/g)) {
      if (cidr[1] === "0.0.0.0/0" || cidr[1] === "::/0") return true;
    }
  }

  return false;
}

function ingressRules(securityGroup) {
  return terraformNestedBlocks(securityGroup, "ingress")
    .map((ingress) => {
      const protocol = /\bprotocol\s*=\s*"([^"]+)"/.exec(ingress);
      const fromPort = /\bfrom_port\s*=\s*(\d+)/.exec(ingress);
      const toPort = /\bto_port\s*=\s*(\d+)/.exec(ingress);

      assert.ok(protocol?.[1], "ingress must declare a protocol");
      assert.ok(fromPort?.[1], "ingress must have an explicit from_port");
      assert.ok(toPort?.[1], "ingress must have an explicit to_port");
      return {
        fromPort: Number(fromPort[1]),
        protocol: protocol[1],
        toPort: Number(toPort[1]),
      };
    })
    .sort((left, right) => left.fromPort - right.fromPort || left.toPort - right.toPort);
}

function hasCloudInitCredentialPayload(cloudInit) {
  return (
    /^\s*(?:github[_-]?(?:token|registration)|runtime[_-]?secret|secret|password|token)\s*:\s*[^$\s]/im.test(
      cloudInit,
    ) ||
    /\b(?:[A-Z][A-Z0-9]*_)?(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)\s*=\s*(?!"?\$\{?[A-Z_]+\}?)[^\s"']+/i.test(
      cloudInit,
    )
  );
}

function replaceTerraformResource(source, type, name, mutate) {
  const block = terraformResourceBlock(source, type, name);
  return source.replace(block, mutate(block));
}

function terraformJsonencodePolicy(resource) {
  const assignment = /\bpolicy\s*=\s*jsonencode\s*\(/.exec(resource);
  assert.ok(assignment, "bucket policy must use jsonencode");

  const openingParenthesis = resource.indexOf("(", assignment.index);
  let depth = 0;
  let escaped = false;
  let inString = false;

  for (let index = openingParenthesis; index < resource.length; index += 1) {
    const character = resource[index];
    if (inString) {
      if (character === '"' && !escaped) inString = false;
      escaped = character === "\\" && !escaped;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0) return parseTerraformLiteral(resource.slice(openingParenthesis + 1, index));
  }

  assert.fail("unterminated jsonencode policy");
}

function parseTerraformLiteral(source) {
  const tokens = [];

  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if ("{}[]=,".includes(character)) {
      tokens.push({ type: character, value: character });
      index += 1;
      continue;
    }
    if (character === '"') {
      let end = index + 1;
      let escaped = false;
      for (; end < source.length; end += 1) {
        if (source[end] === '"' && !escaped) break;
        escaped = source[end] === "\\" && !escaped;
      }
      assert.ok(end < source.length, "unterminated Terraform string");
      tokens.push({ type: "value", value: JSON.parse(source.slice(index, end + 1)) });
      index = end + 1;
      continue;
    }

    const identifier = /^[A-Za-z0-9_.-]+/.exec(source.slice(index));
    assert.ok(
      identifier,
      `unsupported Terraform policy token near ${source.slice(index, index + 16)}`,
    );
    tokens.push({ type: "value", value: identifier[0] });
    index += identifier[0].length;
  }

  let cursor = 0;
  const take = (type) => {
    const token = tokens[cursor];
    assert.equal(token?.type, type, `expected ${type} in Terraform jsonencode policy`);
    cursor += 1;
    return token;
  };
  const parseValue = () => {
    const token = tokens[cursor];
    assert.ok(token, "expected Terraform policy value");
    if (token.type === "value") {
      cursor += 1;
      return token.value;
    }
    if (token.type === "{") {
      cursor += 1;
      const object = {};
      while (tokens[cursor]?.type !== "}") {
        const key = take("value").value;
        take("=");
        object[key] = parseValue();
        if (tokens[cursor]?.type === ",") cursor += 1;
      }
      take("}");
      return object;
    }
    if (token.type === "[") {
      cursor += 1;
      const values = [];
      while (tokens[cursor]?.type !== "]") {
        values.push(parseValue());
        if (tokens[cursor]?.type === ",") cursor += 1;
      }
      take("]");
      return values;
    }
    assert.fail(`unexpected ${token.type} in Terraform jsonencode policy`);
  };

  const parsed = parseValue();
  assert.equal(cursor, tokens.length, "Terraform jsonencode policy has trailing content");
  return parsed;
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
    3,
    "exact production controller, production runner, and infrastructure credentials are required",
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
    variables,
    /variable\s+"github_infrastructure_environment"\s*\{[\s\S]*?condition\s*=\s*var\.github_infrastructure_environment\s*==\s*"production-infrastructure"/,
  );
  assert.match(
    iam,
    /github_subject\s*=\s*"repo:\$\{var\.github_repository\}:environment:\$\{var\.github_environment\}"/,
  );
  assert.match(
    iam,
    /github_infrastructure_subject\s*=\s*"repo:\$\{var\.github_repository\}:environment:\$\{var\.github_infrastructure_environment\}"/,
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

  const infrastructureCredential = terraformResourceBlock(
    iam,
    "yandex_iam_workload_identity_federated_credential",
    "github_infrastructure",
  );
  assert.match(
    infrastructureCredential,
    /service_account_id\s*=\s*yandex_iam_service_account\.terraform\.id/,
  );
  assert.match(
    infrastructureCredential,
    /federation_id\s*=\s*yandex_iam_workload_identity_oidc_federation\.github\.id/,
  );
  assert.match(
    infrastructureCredential,
    /external_subject_id\s*=\s*local\.github_infrastructure_subject/,
  );

  const federationUse = terraformResourceBlock(
    iam,
    "yandex_iam_workload_identity_oidc_federation_iam_binding",
    "terraform_user",
  );
  assert.match(federationUse, /role\s*=\s*"iam\.workloadIdentityFederations\.user"/);
  assert.match(
    federationUse,
    /members\s*=\s*\[[\s\S]*?serviceAccount:\$\{yandex_iam_service_account\.terraform\.id\}[\s\S]*?serviceAccount:\$\{yandex_iam_service_account\.runner\.id\}[\s\S]*?\]/,
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

function assertPrivateNetworkAndCompute({
  network,
  networkOutputs,
  compute,
  computeOutputs,
  appCloudInit,
  runnerCloudInit,
  production,
  productionOutputs,
}) {
  const securityGroups = ["alb", "app", "data", "runner"];

  for (const moduleSource of [network, compute]) {
    assert.match(
      moduleSource,
      /terraform\s*\{[\s\S]*?required_providers\s*\{[\s\S]*?yandex\s*=\s*\{[\s\S]*?source\s*=\s*"yandex-cloud\/yandex"[\s\S]*?version\s*=\s*"= 0\.215\.0"/,
    );
  }

  assert.match(network, /resource\s+"yandex_vpc_network"\s+"production"\s*\{/);
  for (const subnet of ["alb", "app", "data", "management"]) {
    assert.match(network, new RegExp(`resource\\s+"yandex_vpc_subnet"\\s+"${subnet}"\\s*\\{`));
  }
  for (const securityGroup of securityGroups) {
    assert.match(
      network,
      new RegExp(`resource\\s+"yandex_vpc_security_group"\\s+"${securityGroup}"\\s*\\{`),
    );
  }

  assert.match(
    network,
    /resource\s+"yandex_vpc_gateway"\s+"nat"\s*\{[\s\S]*?shared_egress_gateway\s*\{/,
  );
  assert.match(
    network,
    /resource\s+"yandex_vpc_route_table"\s+"private_egress"\s*\{[\s\S]*?destination_prefix\s*=\s*"0\.0\.0\.0\/0"[\s\S]*?gateway_id\s*=\s*yandex_vpc_gateway\.nat\.id/,
  );

  const albSecurityGroup = terraformResourceBlock(network, "yandex_vpc_security_group", "alb");
  assert.match(
    albSecurityGroup,
    /from_port\s*=\s*80[\s\S]*?v4_cidr_blocks\s*=\s*\["0\.0\.0\.0\/0"\]/,
  );
  assert.match(
    albSecurityGroup,
    /from_port\s*=\s*443[\s\S]*?v4_cidr_blocks\s*=\s*\["0\.0\.0\.0\/0"\]/,
  );
  assert.deepEqual(ingressRules(albSecurityGroup), [
    { fromPort: 80, protocol: "TCP", toPort: 80 },
    { fromPort: 443, protocol: "TCP", toPort: 443 },
  ]);
  for (const securityGroup of ["app", "data", "runner"]) {
    for (const ingress of terraformNestedBlocks(
      terraformResourceBlock(network, "yandex_vpc_security_group", securityGroup),
      "ingress",
    )) {
      assert.equal(hasPublicCidr(ingress), false, `${securityGroup} must not have public ingress`);
    }
  }

  const appSecurityGroup = terraformResourceBlock(network, "yandex_vpc_security_group", "app");
  assert.match(
    appSecurityGroup,
    /from_port\s*=\s*8080[\s\S]*?security_group_id\s*=\s*yandex_vpc_security_group\.alb\.id/,
  );
  assert.match(
    appSecurityGroup,
    /from_port\s*=\s*22[\s\S]*?security_group_id\s*=\s*yandex_vpc_security_group\.runner\.id/,
  );
  const dataSecurityGroup = terraformResourceBlock(network, "yandex_vpc_security_group", "data");
  assert.match(
    dataSecurityGroup,
    /from_port\s*=\s*6432[\s\S]*?security_group_id\s*=\s*yandex_vpc_security_group\.app\.id/,
  );
  const appIngress = terraformNestedBlocks(appSecurityGroup, "ingress");
  const sshIngress = appIngress.find((ingress) => /from_port\s*=\s*22/.test(ingress));
  const appPortIngress = appIngress.find((ingress) => /from_port\s*=\s*8080/.test(ingress));
  const dataIngress = terraformNestedBlocks(dataSecurityGroup, "ingress").find((ingress) =>
    /from_port\s*=\s*6432/.test(ingress),
  );
  assert.ok(sshIngress, "app security group must define an SSH ingress rule");
  assert.ok(appPortIngress, "app security group must define an application ingress rule");
  assert.ok(dataIngress, "data security group must define a PostgreSQL ingress rule");
  assert.doesNotMatch(sshIngress, /v4_cidr_blocks\s*=/);
  assert.doesNotMatch(appPortIngress, /v4_cidr_blocks\s*=/);
  assert.doesNotMatch(dataIngress, /v4_cidr_blocks\s*=/);

  assert.match(
    compute,
    /data\s+"yandex_compute_image"\s+"ubuntu_lts"\s*\{[\s\S]*?family\s*=\s*var\.ubuntu_lts_image_family/,
  );
  for (const instance of ["app", "runner"]) {
    const resource = terraformResourceBlock(compute, "yandex_compute_instance", instance);
    assert.match(resource, /nat\s*=\s*false/);
    assert.match(resource, /enable-oslogin\s*=\s*true/);
    assert.match(resource, /serial-port-enable\s*=\s*false/);
    assert.match(
      resource,
      /boot_disk\s*\{[\s\S]*?initialize_params\s*\{[\s\S]*?image_id\s*=\s*data\.yandex_compute_image\.ubuntu_lts\.id/,
    );
    assert.match(resource, /kms_key_id\s*=\s*var\.kms_key_id/);
    assert.doesNotMatch(
      resource,
      /metadata\s*=\s*\{[\s\S]*?\b(?:github[_-]?(?:token|registration)|runtime[_-]?secret|secret|password|token)\s*=/i,
      "instance metadata must not contain a runtime credential payload",
    );
  }
  assert.doesNotMatch(compute, /nat\s*=\s*true/);
  assert.match(
    compute,
    /resource\s+"yandex_alb_target_group"\s+"app"\s*\{[\s\S]*?ip_address\s*=\s*yandex_compute_instance\.app\.network_interface\.0\.ip_address/,
  );

  assert.equal(
    hasCloudInitCredentialPayload(appCloudInit),
    false,
    "app cloud-init must not embed a credential payload",
  );
  assert.equal(
    hasCloudInitCredentialPayload(runnerCloudInit),
    false,
    "runner cloud-init must not embed a credential payload",
  );
  assert.match(
    runnerCloudInit,
    /path:\s*\/usr\/local\/lib\/markiro\/runner-jit[\s\S]*?permissions:\s*"0755"[\s\S]*?generate-jitconfig/,
  );
  assert.match(runnerCloudInit, /\/etc\/systemd\/system\/markiro-runner\.service/);
  assert.match(runnerCloudInit, /systemctl\s+enable\s+markiro-runner\.service/);
  assert.doesNotMatch(runnerCloudInit, /systemctl\s+start\s+markiro-runner\.service/);
  assert.match(runnerCloudInit, /markiro-runner-bootstrap-complete/);
  assert.doesNotMatch(runnerCloudInit, /markiro-runner-ready/);
  assert.match(runnerCloudInit, /power_state\s*:\s*[\s\S]*?mode\s*:\s*poweroff/);

  assert.match(computeOutputs, /output\s+"app_private_ip"\s*\{/);
  assert.match(computeOutputs, /output\s+"app_target_group_id"\s*\{/);
  assert.match(computeOutputs, /output\s+"runner_instance_id"\s*\{/);
  assert.doesNotMatch(computeOutputs, /nat_ip_address|public.*ip/i);
  assert.match(networkOutputs, /output\s+"app_subnet_id"\s*\{/);
  assert.match(production, /module\s+"network"\s*\{/);
  assert.match(production, /module\s+"compute"\s*\{/);
  assert.match(productionOutputs, /output\s+"app_private_ip"\s*\{/);
  assert.match(productionOutputs, /output\s+"app_target_group_id"\s*\{/);
  assert.match(productionOutputs, /output\s+"runner_instance_id"\s*\{/);
  assert.doesNotMatch(productionOutputs, /nat_ip_address/i);
}

async function privateNetworkAndComputeSources() {
  const [
    network,
    networkOutputs,
    compute,
    computeOutputs,
    appCloudInit,
    runnerCloudInit,
    production,
    productionOutputs,
  ] = await Promise.all([
    readRepositoryFile("infra/yandex/modules/network/main.tf"),
    readRepositoryFile("infra/yandex/modules/network/outputs.tf"),
    readRepositoryFile("infra/yandex/modules/compute/main.tf"),
    readRepositoryFile("infra/yandex/modules/compute/outputs.tf"),
    readRepositoryFile("infra/yandex/modules/compute/cloud-init-app.yaml.tftpl"),
    readRepositoryFile("infra/yandex/modules/compute/cloud-init-runner.yaml.tftpl"),
    readRepositoryFile("infra/yandex/production/main.tf"),
    readRepositoryFile("infra/yandex/production/outputs.tf"),
  ]);

  return {
    network,
    networkOutputs,
    compute,
    computeOutputs,
    appCloudInit,
    runnerCloudInit,
    production,
    productionOutputs,
  };
}

function assertProtectedIngress({
  ingress,
  ingressOutputs,
  ingressVariables,
  production,
  productionOutputs,
  productionVariables,
}) {
  const allIngress = [ingress, ingressOutputs, ingressVariables].join("\n");

  const publicAddress = terraformResourceBlock(ingress, "yandex_vpc_address", "markiro");
  assert.match(publicAddress, /external_ipv4_address\s*\{/);
  assert.doesNotMatch(publicAddress, /internal_ipv4_address|ipv6/i);

  const certificate = terraformResourceBlock(ingress, "yandex_cm_certificate", "markiro");
  assert.match(certificate, /domains\s*=\s*\[var\.domain\]/);
  assert.match(
    certificate,
    /managed\s*\{[\s\S]*?challenge_type\s*=\s*"DNS_CNAME"[\s\S]*?challenge_count\s*=\s*1/,
  );
  const certificateValidation = terraformResourceBlock(
    ingress,
    "yandex_dns_recordset",
    "certificate_validation",
  );
  assert.match(certificateValidation, /count\s*=\s*1/);
  assert.match(certificateValidation, /challenges\[count\.index\]/);
  assert.doesNotMatch(certificateValidation, /for_each/);
  assert.match(
    ingress,
    /data\s+"yandex_cm_certificate"\s+"issued"\s*\{[\s\S]*?certificate_id\s*=\s*yandex_cm_certificate\.markiro\.id[\s\S]*?wait_validation\s*=\s*true[\s\S]*?depends_on\s*=\s*\[yandex_dns_recordset\.certificate_validation\]/,
  );

  const backendGroup = terraformResourceBlock(ingress, "yandex_alb_backend_group", "app");
  assert.match(backendGroup, /target_group_ids\s*=\s*\[var\.app_target_group_id\]/);
  assert.match(backendGroup, /port\s*=\s*8080/);
  assert.match(backendGroup, /path\s*=\s*"\/health\/ready"/);
  assert.match(backendGroup, /host\s*=\s*var\.domain/);
  assert.doesNotMatch(backendGroup, /path\s*=\s*"\/health"|\/api(?:\W|$)|port\s*=\s*443/);

  const router = terraformResourceBlock(ingress, "yandex_alb_http_router", "markiro");
  assert.match(router, /name\s*=\s*"markiro-production"/);

  const virtualHost = terraformResourceBlock(ingress, "yandex_alb_virtual_host", "markiro");
  assert.match(virtualHost, /authority\s*=\s*\[var\.domain\]/);
  assert.match(virtualHost, /backend_group_id\s*=\s*yandex_alb_backend_group\.app\.id/);
  assert.match(
    virtualHost,
    /route_options\s*\{[\s\S]*?security_profile_id\s*=\s*yandex_sws_security_profile\.markiro\.id/,
  );
  assert.doesNotMatch(virtualHost, /disable_security_profile\s*=\s*true/);

  const loadBalancer = terraformResourceBlock(ingress, "yandex_alb_load_balancer", "markiro");
  assert.match(loadBalancer, /ports\s*=\s*\[80\][\s\S]*?http_to_https\s*=\s*true/);
  assert.match(
    loadBalancer,
    /ports\s*=\s*\[443\][\s\S]*?certificate_ids\s*=\s*\[data\.yandex_cm_certificate\.issued\.id\][\s\S]*?http_router_id\s*=\s*yandex_alb_http_router\.markiro\.id/,
  );
  assert.match(
    loadBalancer,
    /external_ipv4_address\s*\{[\s\S]*?address\s*=\s*yandex_vpc_address\.markiro\.external_ipv4_address\.0\.address/,
  );
  assert.doesNotMatch(loadBalancer, /external_ipv6_address/);

  const rateLimiter = terraformResourceBlock(
    ingress,
    "yandex_sws_advanced_rate_limiter_profile",
    "markiro",
  );
  for (const ruleName of ["global-request-rate", "per-ip-request-rate"]) {
    assert.match(rateLimiter, new RegExp(`name\\s*=\\s*"${ruleName}"`));
  }
  assert.match(rateLimiter, /limit\s*=\s*var\.global_rate_limit/);
  assert.match(rateLimiter, /limit\s*=\s*var\.per_ip_rate_limit/);
  assert.match(rateLimiter, /simple_characteristic\s*\{[\s\S]*?type\s*=\s*"IP"/);

  const securityProfile = terraformResourceBlock(ingress, "yandex_sws_security_profile", "markiro");
  assert.match(securityProfile, /default_action\s*=\s*"ALLOW"/);
  assert.match(
    securityProfile,
    /advanced_rate_limiter_profile_id\s*=\s*yandex_sws_advanced_rate_limiter_profile\.markiro\.id/,
  );
  assert.doesNotMatch(securityProfile, /analyze_request_body|size_limit/i);

  const publicDns = terraformResourceBlock(ingress, "yandex_dns_recordset", "application");
  assert.match(publicDns, /count\s*=\s*var\.public_dns_enabled\s*\?\s*1\s*:\s*0/);
  assert.match(publicDns, /type\s*=\s*"A"/);
  assert.doesNotMatch(publicDns, /AAAA/);
  assert.match(ingressVariables, /variable\s+"public_dns_enabled"\s*\{[\s\S]*?default\s*=\s*false/);
  for (const variable of ["global_rate_limit", "per_ip_rate_limit"]) {
    assert.match(
      ingressVariables,
      new RegExp(
        `variable\\s+"${variable}"\\s*\\{[\\s\\S]*?type\\s*=\\s*number[\\s\\S]*?condition\\s*=[\\s\\S]*?var\\.${variable}\\s*==\\s*floor\\(var\\.${variable}\\)`,
      ),
    );
    assert.match(
      productionVariables,
      new RegExp(
        `variable\\s+"${variable}"\\s*\\{[\\s\\S]*?type\\s*=\\s*number[\\s\\S]*?condition\\s*=[\\s\\S]*?var\\.${variable}\\s*==\\s*floor\\(var\\.${variable}\\)`,
      ),
    );
  }

  for (const output of [
    "reserved_ipv4_address",
    "certificate_id",
    "certificate_status",
    "load_balancer_id",
    "load_balancer_address",
    "backend_group_id",
    "security_profile_id",
    "approved_a_records",
  ]) {
    assert.match(ingressOutputs, new RegExp(`output\\s+"${output}"\\s*\\{`));
    assert.match(productionOutputs, new RegExp(`output\\s+"${output}"\\s*\\{`));
  }

  assert.match(production, /module\s+"ingress"\s*\{/);
  for (const variable of [
    "domain",
    "dns_zone_id",
    "public_dns_enabled",
    "global_rate_limit",
    "per_ip_rate_limit",
  ]) {
    assert.match(productionVariables, new RegExp(`variable\\s+"${variable}"\\s*\\{`));
  }
  assert.doesNotMatch(allIngress, /(?:api|backend)[_-]?(?:url|address).*443/i);
}

async function protectedIngressSources() {
  const [
    ingress,
    ingressOutputs,
    ingressVariables,
    production,
    productionOutputs,
    productionVariables,
  ] = await Promise.all([
    readRepositoryFile("infra/yandex/modules/ingress/main.tf"),
    readRepositoryFile("infra/yandex/modules/ingress/outputs.tf"),
    readRepositoryFile("infra/yandex/modules/ingress/variables.tf"),
    readRepositoryFile("infra/yandex/production/main.tf"),
    readRepositoryFile("infra/yandex/production/outputs.tf"),
    readRepositoryFile("infra/yandex/production/variables.tf"),
  ]);

  return {
    ingress,
    ingressOutputs,
    ingressVariables,
    production,
    productionOutputs,
    productionVariables,
  };
}

function assertProtectedManagedData({
  postgres,
  postgresOutputs,
  postgresVariables,
  storage,
  storageOutputs,
  storageVariables,
  production,
  productionOutputs,
  productionVariables,
}) {
  const allHcl = [
    postgres,
    postgresOutputs,
    postgresVariables,
    storage,
    storageOutputs,
    storageVariables,
    production,
    productionOutputs,
    productionVariables,
  ].join("\n");

  for (const moduleSource of [postgres, storage]) {
    assert.match(
      moduleSource,
      /terraform\s*\{[\s\S]*?required_providers\s*\{[\s\S]*?yandex\s*=\s*\{[\s\S]*?source\s*=\s*"yandex-cloud\/yandex"[\s\S]*?version\s*=\s*"= 0\.215\.0"/,
    );
  }

  const cluster = terraformResourceBlock(postgres, "yandex_mdb_postgresql_cluster", "production");
  const database = terraformResourceBlock(
    postgres,
    "yandex_mdb_postgresql_database",
    "application",
  );
  assert.match(cluster, /version\s*=\s*"17"/);
  assert.match(cluster, /backup_retain_period_days\s*=\s*14/);
  assert.match(cluster, /backup_window_start\s*\{/);
  assert.match(cluster, /maintenance_window\s*\{/);
  assert.equal(terraformNestedBlocks(cluster, "host").length, 1, "PostgreSQL must have one host");
  assert.match(cluster, /host\s*\{[\s\S]*?subnet_id\s*=\s*var\.data_subnet_id/);
  assert.match(cluster, /host\s*\{[\s\S]*?assign_public_ip\s*=\s*false/);
  assert.doesNotMatch(cluster, /assign_public_ip\s*=\s*true/);
  assert.match(cluster, /disk_encryption_key_id\s*=\s*var\.kms_key_id/);
  assert.match(cluster, /lifecycle\s*\{[\s\S]*?prevent_destroy\s*=\s*true/);
  assert.match(database, /owner\s*=\s*var\.database_name/);
  assert.match(
    postgresVariables,
    /variable\s+"database_disk_size_gb"\s*\{[\s\S]*?condition\s*=\s*var\.database_disk_size_gb\s*>=\s*50/,
  );

  for (const bucketName of ["media", "audit"]) {
    const bucket = terraformResourceBlock(storage, "yandex_storage_bucket", bucketName);
    assert.match(bucket, /force_destroy\s*=\s*false/);
    assert.match(bucket, /anonymous_access_flags\s*\{[\s\S]*?\bread\s*=\s*false/);
    assert.match(bucket, /anonymous_access_flags\s*\{[\s\S]*?\blist\s*=\s*false/);
    assert.match(bucket, /anonymous_access_flags\s*\{[\s\S]*?\bconfig_read\s*=\s*false/);
    const versioning = terraformNestedBlocks(bucket, "versioning");
    assert.equal(versioning.length, 1, `${bucketName} bucket must define versioning`);
    assert.match(versioning[0], /enabled\s*=\s*true/);
    assert.match(bucket, /lifecycle\s*\{[\s\S]*?prevent_destroy\s*=\s*true/);
    assert.match(bucket, /kms_master_key_id\s*=\s*var\.kms_key_id/);
    assert.match(bucket, /sse_algorithm\s*=\s*"aws:kms"/);
  }

  const media = terraformResourceBlock(storage, "yandex_storage_bucket", "media");
  const mediaLifecycleRules = terraformNestedBlocks(media, "lifecycle_rule");
  assert.equal(mediaLifecycleRules.length, 1, "media must have exactly one lifecycle rule");
  const noncurrentExpirations = terraformNestedBlocks(
    mediaLifecycleRules[0],
    "noncurrent_version_expiration",
  );
  assert.equal(noncurrentExpirations.length, 1, "media must expire one noncurrent version set");
  assert.match(noncurrentExpirations[0], /days\s*=\s*30/);
  assert.match(mediaLifecycleRules[0], /abort_incomplete_multipart_upload_days\s*=\s*7/);
  assert.doesNotMatch(mediaLifecycleRules[0], /\bexpiration\s*\{/);
  assert.doesNotMatch(mediaLifecycleRules[0], /\b(?:noncurrent_version_)?transition\s*\{/);

  const bucketPolicies = [
    ...storage.matchAll(/resource\s+"yandex_storage_bucket_policy"\s+"([^"]+)"/g),
  ]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(bucketPolicies, ["audit_writer", "media_app"]);
  assert.doesNotMatch(storage, /yandex_storage_bucket_iam_binding/);

  const mediaPolicy = terraformResourceBlock(storage, "yandex_storage_bucket_policy", "media_app");
  assert.match(mediaPolicy, /bucket\s*=\s*yandex_storage_bucket\.media\.bucket/);
  assert.deepEqual(terraformJsonencodePolicy(mediaPolicy), {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowApplicationMediaObjects",
        Effect: "Allow",
        Principal: { CanonicalUser: "var.app_service_account_id" },
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: ["arn:aws:s3:::${yandex_storage_bucket.media.bucket}/*"],
      },
      {
        Sid: "AllowApplicationMediaBucketList",
        Effect: "Allow",
        Principal: { CanonicalUser: "var.app_service_account_id" },
        Action: ["s3:ListBucket"],
        Resource: ["arn:aws:s3:::${yandex_storage_bucket.media.bucket}"],
      },
    ],
  });

  const auditPolicy = terraformResourceBlock(
    storage,
    "yandex_storage_bucket_policy",
    "audit_writer",
  );
  assert.match(auditPolicy, /bucket\s*=\s*yandex_storage_bucket\.audit\.bucket/);
  assert.deepEqual(terraformJsonencodePolicy(auditPolicy), {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowAuditArchiveWrites",
        Effect: "Allow",
        Principal: { CanonicalUser: "var.audit_service_account_id" },
        Action: ["s3:PutObject"],
        Resource: ["arn:aws:s3:::${yandex_storage_bucket.audit.bucket}/*"],
      },
    ],
  });

  const mediaKms = terraformResourceBlock(
    storage,
    "yandex_kms_symmetric_key_iam_member",
    "media_app",
  );
  assert.match(mediaKms, /symmetric_key_id\s*=\s*var\.kms_key_id/);
  assert.match(mediaKms, /role\s*=\s*"kms\.keys\.encrypterDecrypter"/);
  assert.match(mediaKms, /member\s*=\s*"serviceAccount:\$\{var\.app_service_account_id\}"/);
  const auditKms = terraformResourceBlock(
    storage,
    "yandex_kms_symmetric_key_iam_member",
    "audit_writer",
  );
  assert.match(auditKms, /symmetric_key_id\s*=\s*var\.kms_key_id/);
  assert.match(auditKms, /role\s*=\s*"kms\.keys\.encrypter"/);
  assert.match(auditKms, /member\s*=\s*"serviceAccount:\$\{var\.audit_service_account_id\}"/);

  assert.match(production, /module\s+"postgres"\s*\{/);
  assert.match(production, /module\s+"object_storage"\s*\{/);
  for (const output of [
    "postgres_cluster_id",
    "postgres_database_id",
    "postgres_fqdn",
    "media_bucket_name",
    "audit_bucket_name",
  ]) {
    assert.match(productionOutputs, new RegExp(`output\\s+"${output}"\\s*\\{`));
  }
  assert.doesNotMatch(productionOutputs, /password|access_key|secret/i);
  assert.doesNotMatch(postgresVariables, /variable\s+"(?:database_)?owner"/);
  assert.doesNotMatch(allHcl, /resource\s+"yandex_mdb_postgresql_user"/);
  assert.doesNotMatch(allHcl, /resource\s+"yandex_iam_service_account_(?:static_)?access_key"/);
  assert.doesNotMatch(allHcl, /resource\s+"yandex_lockbox_secret_version"/);
  assert.doesNotMatch(allHcl, /resource\s+"yandex_resourcemanager_folder_iam_/);
  assert.doesNotMatch(allHcl, /\bpassword\s*=/i);
  assert.doesNotMatch(allHcl, /\b(?:access_key|secret_key)\s*=/i);
}

async function managedDataSources() {
  const [
    postgres,
    postgresOutputs,
    postgresVariables,
    storage,
    storageOutputs,
    storageVariables,
    production,
    productionOutputs,
    productionVariables,
  ] = await Promise.all([
    readRepositoryFile("infra/yandex/modules/postgres/main.tf"),
    readRepositoryFile("infra/yandex/modules/postgres/outputs.tf"),
    readRepositoryFile("infra/yandex/modules/postgres/variables.tf"),
    readRepositoryFile("infra/yandex/modules/object-storage/main.tf"),
    readRepositoryFile("infra/yandex/modules/object-storage/outputs.tf"),
    readRepositoryFile("infra/yandex/modules/object-storage/variables.tf"),
    readRepositoryFile("infra/yandex/production/main.tf"),
    readRepositoryFile("infra/yandex/production/outputs.tf"),
    readRepositoryFile("infra/yandex/production/variables.tf"),
  ]);

  return {
    postgres,
    postgresOutputs,
    postgresVariables,
    storage,
    storageOutputs,
    storageVariables,
    production,
    productionOutputs,
    productionVariables,
  };
}

const requiredObservabilityAlerts = [
  "alb_healthy_backend",
  "alb_5xx",
  "alb_latency",
  "sws_deny",
  "sws_arl",
  "vm_cpu",
  "vm_memory",
  "vm_disk",
  "postgres_availability",
  "postgres_storage",
  "postgres_connections",
  "postgres_backup_age",
  "certificate_risk",
  "readiness_optional_dependency_degradation",
  "deployment_failure",
  "runner_overrun",
];

function assertProtectedObservability({
  observability,
  observabilityOutputs,
  observabilityVariables,
  ingress,
  storage,
  storageVariables,
  production,
  productionOutputs,
  productionVariables,
  readme,
}) {
  assert.match(
    observability,
    /required_providers\s*\{[\s\S]*?source\s*=\s*"yandex-cloud\/yandex"[\s\S]*?version\s*=\s*"= 0\.215\.0"/,
  );

  for (const groupName of ["application", "security", "audit"]) {
    const group = terraformResourceBlock(observability, "yandex_logging_group", groupName);
    assert.match(group, /retention_period\s*=\s*"336h"/);
  }
  assert.equal(
    [...observability.matchAll(/resource\s+"yandex_logging_group"\s+"([^"]+)"/g)].length,
    3,
    "application, security, and audit must use separate log groups",
  );

  const auditBucket = terraformResourceBlock(storage, "yandex_storage_bucket", "audit");
  const auditLifecycleRules = terraformNestedBlocks(auditBucket, "lifecycle_rule");
  assert.equal(auditLifecycleRules.length, 1, "audit archive must have exactly one lifecycle rule");
  assert.match(auditLifecycleRules[0], /expiration\s*\{[\s\S]*?days\s*=\s*90/);
  assert.match(auditLifecycleRules[0], /noncurrent_version_expiration\s*\{[\s\S]*?days\s*=\s*90/);
  assert.match(auditBucket, /versioning\s*\{[\s\S]*?enabled\s*=\s*true/);
  assert.match(auditBucket, /lifecycle\s*\{[\s\S]*?prevent_destroy\s*=\s*true/);

  for (const [boundary, variables] of [
    ["object storage", storageVariables],
    ["observability", observabilityVariables],
    ["production", productionVariables],
  ]) {
    assert.match(variables, /variable\s+"state_bucket_name"\s*\{/);
    assert.match(
      variables,
      /length\(trimspace\(var\.state_bucket_name\)\)\s*>\s*0/,
      `${boundary} must reject a blank state bucket name`,
    );
    assert.match(
      variables,
      /var\.state_bucket_name\s*!=\s*var\.media_bucket_name/,
      `${boundary} must keep state and media buckets distinct`,
    );
    assert.match(
      variables,
      /var\.state_bucket_name\s*!=\s*var\.audit_bucket_name/,
      `${boundary} must keep state and audit buckets distinct`,
    );
    assert.match(
      variables,
      /var\.audit_bucket_name\s*!=\s*var\.media_bucket_name/,
      `${boundary} must keep audit and media buckets distinct`,
    );
  }

  const trails = [
    terraformResourceBlock(observability, "yandex_audit_trails_trail", "realtime"),
    terraformResourceBlock(observability, "yandex_audit_trails_trail", "archive"),
  ];
  assert.equal(
    [...observability.matchAll(/resource\s+"yandex_audit_trails_trail"\s+"([^"]+)"/g)].length,
    2,
    "one-destination provider schema requires exactly two trails",
  );
  assert.match(trails[0], /logging_destination\s*\{[\s\S]*?yandex_logging_group\.audit\.id/);
  assert.doesNotMatch(trails[0], /storage_destination\s*\{/);
  assert.match(
    trails[1],
    /storage_destination\s*\{[\s\S]*?bucket_name\s*=\s*var\.audit_bucket_name/,
  );
  assert.doesNotMatch(trails[1], /logging_destination\s*\{/);

  for (const trail of trails) {
    assert.match(
      trail,
      /management_events_filter\s*\{[\s\S]*?resource_id\s*=\s*var\.folder_id[\s\S]*?resource_type\s*=\s*"resource-manager\.folder"/,
    );
    assert.match(
      trail,
      /data_events_filter\s*\{[\s\S]*?service\s*=\s*"lockbox"[\s\S]*?included_events\s*=\s*local\.lockbox_data_events[\s\S]*?for_each\s*=\s*var\.lockbox_secret_ids[\s\S]*?resource_type\s*=\s*"lockbox\.secret"/,
    );
    assert.match(
      trail,
      /data_events_filter\s*\{[\s\S]*?service\s*=\s*"storage"[\s\S]*?included_events\s*=\s*local\.media_data_events[\s\S]*?resource_id\s*=\s*var\.media_bucket_name[\s\S]*?resource_type\s*=\s*"storage\.bucket"/,
    );
    assert.doesNotMatch(
      trail,
      /data_events_filter\s*\{[\s\S]*?service\s*=\s*"storage"[\s\S]*?resource_id\s*=\s*var\.audit_bucket_name/,
    );
  }
  assert.match(observability, /yandex\.cloud\.audit\.lockbox\.GetPayload/);
  assert.match(observability, /yandex\.cloud\.audit\.lockbox\.GetPayloadEx/);
  for (const event of ["ObjectCreate", "ObjectUpdate", "ObjectDelete", "ObjectGet"]) {
    assert.match(observability, new RegExp(`yandex\\.cloud\\.audit\\.storage\\.${event}`));
  }

  const loadBalancer = terraformResourceBlock(ingress, "yandex_alb_load_balancer", "markiro");
  const securityProfile = terraformResourceBlock(ingress, "yandex_sws_security_profile", "markiro");
  assert.match(loadBalancer, /log_group_id\s*=\s*var\.application_log_group_id/);
  assert.match(securityProfile, /log_group_id\s*=\s*var\.security_log_group_id/);

  for (const variables of [observabilityVariables, productionVariables]) {
    assert.match(
      variables,
      /variable\s+"notification_channel_id"\s*\{[\s\S]*?condition\s*=\s*length\(trimspace\(var\.notification_channel_id\)\)\s*>\s*0/,
    );
    assert.match(variables, /variable\s+"alert_ids"\s*\{/);
    assert.match(variables, /toset\(keys\(var\.alert_ids\)\)\s*==\s*toset\(\[/);
    assert.match(
      variables,
      /alltrue\(\[for alert_id in values\(var\.alert_ids\) : length\(trimspace\(alert_id\)\) > 0\]\)/,
    );
    assert.match(
      variables,
      /length\(toset\(values\(var\.alert_ids\)\)\)\s*==\s*length\(var\.alert_ids\)/,
    );
  }

  for (const category of requiredObservabilityAlerts) {
    const spec = terraformObjectEntry(observability, category);
    assert.match(spec, new RegExp(`category\\s*=\\s*"${category}"`));
    assert.match(spec, /metric\s*=\s*"[^\n]+"/);
    assert.match(spec, /query\s*=\s*"[^\n]+"/);
    assert.match(spec, /comparison\s*=\s*"(?:GREATER_THAN|LESS_THAN)"/);
    assert.match(spec, /warning_threshold\s*=\s*[0-9.]+/);
    assert.match(spec, /alarm_threshold\s*=\s*[0-9.]+/);
    assert.match(spec, /evaluation_window\s*=\s*"[^"]+"/);
    assert.match(spec, /notification_channel_id\s*=\s*var\.notification_channel_id/);
    assert.match(observabilityVariables, new RegExp(`"${category}"`));
    assert.match(productionVariables, new RegExp(`"${category}"`));
  }

  const dashboard = terraformResourceBlock(
    observability,
    "yandex_monitoring_dashboard",
    "production",
  );
  assert.match(dashboard, /for_each\s*=\s*local\.alert_specs/);
  assert.match(dashboard, /query\s*=\s*widgets\.value\.query/);

  for (const output of [
    "application_log_group_id",
    "security_log_group_id",
    "audit_log_group_id",
    "audit_trail_ids",
    "dashboard_id",
    "alert_ids",
    "alert_specs",
  ]) {
    assert.match(observabilityOutputs, new RegExp(`output\\s+"${output}"\\s*\\{`));
    assert.match(productionOutputs, new RegExp(`output\\s+"${output}"\\s*\\{`));
  }

  assert.match(production, /module\s+"observability"\s*\{/);
  assert.match(production, /notification_channel_id\s*=\s*var\.notification_channel_id/);
  assert.match(production, /alert_ids\s*=\s*var\.alert_ids/);
  assert.match(production, /audit_bucket_name\s*=\s*module\.object_storage\.audit_bucket_name/);
  assert.match(production, /media_bucket_name\s*=\s*module\.object_storage\.media_bucket_name/);
  assert.equal(
    [...production.matchAll(/state_bucket_name\s*=\s*var\.state_bucket_name/g)].length,
    2,
    "production must pass the protected state bucket name to both validation boundaries",
  );
  assert.doesNotMatch(production, /(?:resource|data)\s+"yandex_storage_bucket"\s+"state"/);
  assert.match(productionVariables, /variable\s+"notification_channel_id"\s*\{/);
  assert.match(productionVariables, /variable\s+"alert_ids"\s*\{/);
  assert.match(
    readme,
    /provider 0\.215\.0 does not expose a Monitoring alert resource[\s\S]*?must not proceed[\s\S]*?alert_ids/i,
  );
  assert.match(
    readme,
    /state_bucket_name[\s\S]*?bootstrap output[\s\S]*?does\s+not\s+create\s+or\s+read/i,
  );
}

async function observabilitySources() {
  const [
    observability,
    observabilityOutputs,
    observabilityVariables,
    ingress,
    storage,
    storageVariables,
    production,
    productionOutputs,
    productionVariables,
    readme,
  ] = await Promise.all([
    readRepositoryFile("infra/yandex/modules/observability/main.tf"),
    readRepositoryFile("infra/yandex/modules/observability/outputs.tf"),
    readRepositoryFile("infra/yandex/modules/observability/variables.tf"),
    readRepositoryFile("infra/yandex/modules/ingress/main.tf"),
    readRepositoryFile("infra/yandex/modules/object-storage/main.tf"),
    readRepositoryFile("infra/yandex/modules/object-storage/variables.tf"),
    readRepositoryFile("infra/yandex/production/main.tf"),
    readRepositoryFile("infra/yandex/production/outputs.tf"),
    readRepositoryFile("infra/yandex/production/variables.tf"),
    readRepositoryFile("infra/yandex/README.md"),
  ]);

  return {
    observability,
    observabilityOutputs,
    observabilityVariables,
    ingress,
    storage,
    storageVariables,
    production,
    productionOutputs,
    productionVariables,
    readme,
  };
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

function workflowCommands(job) {
  return (job.steps ?? [])
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
}

function mutateWorkflowSource(source, mutate) {
  const workflow = yaml.load(source, { schema: yaml.JSON_SCHEMA });
  mutate(workflow);
  return yaml.dump(workflow, { noRefs: true, schema: yaml.JSON_SCHEMA });
}

function assertProtectedInfrastructureWorkflow(source) {
  const workflow = yaml.load(source, { schema: yaml.JSON_SCHEMA });

  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency.group, "markiro-yandex-production-state");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal("pull_request_target" in workflow.on, false);
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);

  const dispatchInputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(dispatchInputs.target_sha, {
    description: "Exact current main commit to plan and apply",
    required: true,
    type: "string",
  });
  assert.equal(dispatchInputs.enable_public_dns.type, "boolean");
  assert.equal(dispatchInputs.enable_public_dns.default, false);
  assert.equal(dispatchInputs.enable_public_dns.required, true);

  const { apply, dns_approval: dnsApproval, plan, validate } = workflow.jobs;
  assert.deepEqual(validate.permissions, { contents: "read" });
  assert.deepEqual(plan.permissions, { contents: "read", "id-token": "write" });
  assert.deepEqual(apply.permissions, { contents: "read", "id-token": "write" });
  assert.equal(plan.environment, "production-infrastructure");
  assert.equal(apply.environment, "production-infrastructure");
  assert.equal(dnsApproval.environment, "production-public-dns");
  assert.match(dnsApproval.if, /enable_public_dns\s*==\s*true/);
  assert.match(plan.if, /needs\.dns_approval\.result/);
  assert.match(apply.if, /github\.event_name\s*==\s*'workflow_dispatch'/);
  assert.deepEqual(apply.needs, ["plan"]);

  const validateSource = JSON.stringify(validate);
  assert.doesNotMatch(
    validateSource,
    /id-token|secrets\.|vars\.|ACTIONS_ID_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|YC_TOKEN|lockbox|auth\.yandex/i,
  );
  const validateCommands = workflowCommands(validate);
  assert.match(validateCommands, /terraform fmt -check -recursive infra\/yandex/);
  assert.match(validateCommands, /check-toolchain\.mjs/);
  assert.equal((validateCommands.match(/init -backend=false -lockfile=readonly/g) ?? []).length, 2);
  assert.equal(
    (
      validateCommands.match(
        /terraform -chdir=infra\/yandex\/(?:bootstrap|production) validate/g,
      ) ?? []
    ).length,
    2,
  );
  assert.match(validateCommands, /pnpm test:yandex-infra:contract/);

  const createPlanIndex = plan.steps.findIndex((step) => step.id === "create-plan");
  const uploadPlanIndex = plan.steps.findIndex((step) => step.id === "plan-artifact");
  const cleanupPlanIndex = plan.steps.findIndex(
    (step) => step.name === "Remove saved plan and temporary Terraform data",
  );
  assert.ok(createPlanIndex >= 0);
  assert.ok(uploadPlanIndex > createPlanIndex, "saved plan must be uploaded after creation");
  assert.ok(cleanupPlanIndex > uploadPlanIndex, "saved plan cleanup must run after upload");
  const createPlanStep = plan.steps[createPlanIndex];
  const cleanupPlanStep = plan.steps[cleanupPlanIndex];
  assert.equal(cleanupPlanStep.if, "always()");
  assert.match(cleanupPlanStep.run, /rm -rf -- "\$\{RUNNER_TEMP:\?\}\/yandex-infrastructure-plan"/);
  assert.doesNotMatch(createPlanStep.run, /rm -rf[^\n]*yandex-infrastructure-plan/);
  assert.match(createPlanStep.run, /unset [^\n]*TF_DATA_DIR/);
  assert.match(
    createPlanStep.run,
    /rm -rf -- "\$\{RUNNER_TEMP:\?\}\/yandex-production-terraform-data"/,
  );

  const planCommands = workflowCommands(plan);
  assert.match(planCommands, /git rev-parse HEAD/);
  assert.match(planCommands, /refs\/heads\/main/);
  assert.match(planCommands, /\[\[ "\$target_sha" == "\$dispatch_sha" \]\]/);
  assert.match(planCommands, /ACTIONS_ID_TOKEN_REQUEST_URL/);
  assert.match(planCommands, /https:\/\/auth\.yandex\.cloud\/oauth\/token/);
  assert.match(
    planCommands,
    /https:\/\/payload\.lockbox\.api\.cloud\.yandex\.net\/lockbox\/v1\/secrets/,
  );
  assert.match(planCommands, /entries \| type == "array" and length == 2/);
  assert.match(planCommands, /::add-mask::\$aws_access_key_id/);
  assert.match(planCommands, /::add-mask::\$aws_secret_access_key/);
  assert.match(planCommands, /trap cleanup EXIT/);
  assert.match(planCommands, /unset [^\n]*YC_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY/);
  assert.match(planCommands, /terraform -chdir=infra\/yandex\/production init/);
  assert.match(planCommands, /terraform -chdir=infra\/yandex\/production plan -json/);
  assert.match(planCommands, /validate-plan-summary\.mjs/);
  assert.match(planCommands, /sha256sum/);

  const downloadPlanIndex = apply.steps.findIndex(
    (step) => step.name === "Download the exact saved plan",
  );
  const applyStepIndex = apply.steps.findIndex(
    (step) => step.name === "Verify evidence, authenticate, and apply only the saved plan",
  );
  const finalApplyCleanupIndex = apply.steps.findIndex(
    (step) => step.name === "Remove downloaded plan and temporary Terraform data",
  );
  assert.ok(downloadPlanIndex >= 0);
  assert.ok(applyStepIndex > downloadPlanIndex, "saved plan must be applied after download");
  assert.ok(
    finalApplyCleanupIndex > applyStepIndex,
    "final apply cleanup must run after download and apply",
  );
  const applyStep = apply.steps[applyStepIndex];
  const finalApplyCleanupStep = apply.steps[finalApplyCleanupIndex];
  assert.ok(applyStep);
  assert.equal(finalApplyCleanupStep.if, "always()");
  assert.deepEqual(
    finalApplyCleanupStep.run
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("rm -rf")),
    [
      'rm -rf -- "${RUNNER_TEMP:?}/yandex-infrastructure-plan"',
      'rm -rf -- "${RUNNER_TEMP:?}/yandex-production-terraform-data"',
    ],
  );
  assert.doesNotMatch(finalApplyCleanupStep.run, /\bunset\b/);
  assert.match(applyStep.run, /unset [^\n]*TF_DATA_DIR/);
  assert.match(applyStep.run, /rm -rf -- "\$\{RUNNER_TEMP:\?\}\/yandex-production-terraform-data"/);
  assert.match(applyStep.run, /rm -rf -- "\$\{RUNNER_TEMP:\?\}\/yandex-infrastructure-plan"/);

  const applyCommands = workflowCommands(apply);
  assert.match(applyCommands, /git rev-parse HEAD/);
  assert.match(applyCommands, /\[\[ "\$target_sha" == "\$dispatch_sha" \]\]/);
  assert.match(applyCommands, /artifact_sha256/);
  assert.match(applyCommands, /sha256sum/);
  assert.match(applyCommands, /trap cleanup EXIT/);
  assert.match(applyCommands, /unset [^\n]*YC_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY/);
  assert.match(applyCommands, /terraform -chdir=infra\/yandex\/production apply/);
  assert.match(applyCommands, /saved\.tfplan/);

  const allCommands = [validateCommands, planCommands, applyCommands].join("\n");
  assert.doesNotMatch(allCommands, /pull_request_target/);
  assert.doesNotMatch(allCommands, /-auto-approve/);
  assert.doesNotMatch(allCommands, /terraform\s+(?:-[^\s]+\s+)*output\b/);
  assert.doesNotMatch(allCommands, /terraform\s+(?:-[^\s]+\s+)*show\s+-json\b/);
  assert.doesNotMatch(allCommands, /-var=["']?public_dns_enabled=true/);
  assert.match(planCommands, /public_dns_enabled=\$public_dns_enabled/);
  assert.match(planCommands, /ENABLE_PUBLIC_DNS/);
  assert.deepEqual(
    [planCommands, applyCommands].flatMap((commands) =>
      commands
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("rm -rf")),
    ),
    [
      'rm -rf -- "${RUNNER_TEMP:?}/yandex-production-terraform-data"',
      'rm -rf -- "${RUNNER_TEMP:?}/yandex-infrastructure-plan"',
      'rm -rf -- "${RUNNER_TEMP:?}/yandex-production-terraform-data"',
      'rm -rf -- "${RUNNER_TEMP:?}/yandex-infrastructure-plan"',
      'rm -rf -- "${RUNNER_TEMP:?}/yandex-infrastructure-plan"',
      'rm -rf -- "${RUNNER_TEMP:?}/yandex-production-terraform-data"',
    ],
    "recursive cleanup must stay confined to exact runner-temporary directories",
  );

  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.uses !== "string") continue;
      assert.match(
        step.uses,
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/,
        `action must use an immutable commit SHA: ${step.uses}`,
      );
    }
  }

  return workflow;
}

test("infrastructure workflow keeps PR validation untrusted and state operations protected", async () => {
  assertProtectedInfrastructureWorkflow(
    await readRepositoryFile(".github/workflows/yandex-infrastructure.yml"),
  );
});

test("infrastructure workflow contract rejects security-boundary mutations", async () => {
  const source = await readRepositoryFile(".github/workflows/yandex-infrastructure.yml");
  const mutations = new Map([
    [
      "PR credentials",
      source.replace(
        "validate:\n",
        'validate:\n    permissions:\n      contents: read\n      id-token: "write"\n',
      ),
    ],
    [
      "cancellable concurrency",
      source.replace("cancel-in-progress: false", "cancel-in-progress: true"),
    ],
    [
      "PR apply",
      source.replace(
        "if: github.event_name == 'workflow_dispatch' && needs.plan.result == 'success'",
        "if: github.event_name == 'pull_request' && needs.plan.result == 'success'",
      ),
    ],
    [
      "missing environment",
      source.replace("environment: production-infrastructure", "environment: unprotected", 1),
    ],
    ["stale commit", source.replace('[[ "$target_sha" == "$dispatch_sha" ]]\n', "")],
    ["unmasked HMAC", source.replace('echo "::add-mask::$aws_secret_access_key"\n', "")],
    ["DNS default true", source.replace("default: false", "default: true")],
    [
      "broad permissions",
      source.replace("permissions:\n  contents: read", "permissions:\n  contents: write"),
    ],
    [
      "mutable action",
      source.replace(
        "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        "actions/checkout@v4",
      ),
    ],
    ["missing cleanup", source.replace("trap cleanup EXIT\n", "", 1)],
    [
      "missing TF_DATA_DIR removal",
      mutateWorkflowSource(source, (workflow) => {
        const step = workflow.jobs.plan.steps.find((candidate) => candidate.id === "create-plan");
        step.run = step.run.replace(
          'rm -rf -- "${RUNNER_TEMP:?}/yandex-production-terraform-data"\n',
          "",
        );
      }),
    ],
    [
      "missing apply artifact removal",
      mutateWorkflowSource(source, (workflow) => {
        const step = workflow.jobs.apply.steps.find((candidate) =>
          candidate.name?.startsWith("Verify evidence"),
        );
        step.run = step.run.replace(
          'rm -rf -- "${RUNNER_TEMP:?}/yandex-infrastructure-plan"\n',
          "",
        );
      }),
    ],
    [
      "missing always plan-artifact cleanup",
      mutateWorkflowSource(source, (workflow) => {
        const step = workflow.jobs.plan.steps.find((candidate) =>
          candidate.name?.startsWith("Remove saved plan"),
        );
        if (step) delete step.if;
      }),
    ],
    [
      "cleanup before upload",
      mutateWorkflowSource(source, (workflow) => {
        const steps = workflow.jobs.plan.steps;
        const cleanupIndex = steps.findIndex((step) => step.name?.startsWith("Remove saved plan"));
        if (cleanupIndex >= 0) {
          const [cleanup] = steps.splice(cleanupIndex, 1);
          const uploadIndex = steps.findIndex((step) => step.id === "plan-artifact");
          steps.splice(uploadIndex, 0, cleanup);
        }
      }),
    ],
    [
      "missing final apply cleanup",
      mutateWorkflowSource(source, (workflow) => {
        workflow.jobs.apply.steps = workflow.jobs.apply.steps.filter(
          (step) => step.name !== "Remove downloaded plan and temporary Terraform data",
        );
      }),
    ],
    [
      "final apply cleanup before download",
      mutateWorkflowSource(source, (workflow) => {
        const steps = workflow.jobs.apply.steps;
        const cleanupIndex = steps.findIndex(
          (step) => step.name === "Remove downloaded plan and temporary Terraform data",
        );
        if (cleanupIndex >= 0) {
          const [cleanup] = steps.splice(cleanupIndex, 1);
          const downloadIndex = steps.findIndex(
            (step) => step.name === "Download the exact saved plan",
          );
          steps.splice(downloadIndex, 0, cleanup);
        }
      }),
    ],
    [
      "final apply cleanup is not always",
      mutateWorkflowSource(source, (workflow) => {
        const step = workflow.jobs.apply.steps.find(
          (candidate) => candidate.name === "Remove downloaded plan and temporary Terraform data",
        );
        if (step) step.if = "success()";
      }),
    ],
  ]);

  for (const [name, mutation] of mutations) {
    assert.notEqual(mutation, source, "security mutation fixture must change the workflow");
    assert.throws(() => assertProtectedInfrastructureWorkflow(mutation), name);
  }
});

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

test("production network and compute keep application and runner traffic private", async () => {
  assertPrivateNetworkAndCompute(await privateNetworkAndComputeSources());
});

test("deployment runner uses exact production federation, VM-scoped operator, and one-use JIT boot", async () => {
  const iam = await readRepositoryFile("infra/yandex/modules/iam/main.tf");
  const compute = await readRepositoryFile("infra/yandex/modules/compute/main.tf");
  const cloudInit = await readRepositoryFile(
    "infra/yandex/modules/compute/cloud-init-runner.yaml.tftpl",
  );
  const appCloudInit = await readRepositoryFile(
    "infra/yandex/modules/compute/cloud-init-app.yaml.tftpl",
  );
  const remoteDeploy = await readRepositoryFile("deploy/yandex/remote-deploy.mjs");
  const unit = await readRepositoryFile("deploy/yandex/systemd/markiro-runner.service");

  const credential = terraformResourceBlock(
    iam,
    "yandex_iam_workload_identity_federated_credential",
    "github_production_runner",
  );
  assert.match(credential, /service_account_id\s*=\s*yandex_iam_service_account\.runner\.id/);
  assert.match(credential, /external_subject_id\s*=\s*local\.github_subject/);
  const federationUse = terraformResourceBlock(
    iam,
    "yandex_iam_workload_identity_oidc_federation_iam_binding",
    "terraform_user",
  );
  assert.match(federationUse, /yandex_iam_service_account\.terraform\.id/);
  assert.match(federationUse, /yandex_iam_service_account\.runner\.id/);

  const operator = terraformResourceBlock(
    compute,
    "yandex_compute_instance_iam_binding",
    "runner_operator",
  );
  assert.match(operator, /instance_id\s*=\s*yandex_compute_instance\.runner\.id/);
  assert.match(operator, /role\s*=\s*"compute\.operator"/);
  assert.match(operator, /serviceAccount:\$\{var\.runner_service_account_id\}/);
  assert.doesNotMatch(
    compute,
    /yandex_resourcemanager_folder_iam_(?:member|binding)[\s\S]*role\s*=\s*"compute\.(?:operator|editor|admin)"/,
  );
  const appLogin = terraformResourceBlock(
    compute,
    "yandex_compute_instance_iam_binding",
    "runner_app_os_login",
  );
  assert.match(appLogin, /instance_id\s*=\s*yandex_compute_instance\.app\.id/);
  assert.match(appLogin, /role\s*=\s*"compute\.osAdminLogin"/);
  const albViewer = terraformResourceBlock(
    compute,
    "yandex_resourcemanager_folder_iam_member",
    "runner_alb_viewer",
  );
  assert.match(albViewer, /role\s*=\s*"alb\.viewer"/);

  assert.match(cloudInit, /RUNNER_VERSION=2\.336\.0/);
  assert.match(
    cloudInit,
    /RUNNER_SHA256=04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d/,
  );
  assert.match(cloudInit, /sha256sum --check --status/);
  assert.match(cloudInit, /markiro-runner\.service/);
  assert.doesNotMatch(cloudInit, /GITHUB_RUNNER_ADMIN_TOKEN\s*[:=]\s*[^$\s]/);
  assert.match(appCloudInit, /MARKIRO_SSH_HOST_KEY.*\/dev\/ttyS0/);
  assert.match(appCloudInit, /ssh_host_(?:ed25519|rsa)_key\.pub/);
  assert.doesNotMatch(appCloudInit, /ssh_host_(?:ed25519|rsa)_key(?!\.pub)/);
  assert.match(cloudInit, /YC_VERSION=1\.23\.0/);
  assert.match(
    cloudInit,
    /YC_SHA256=3e287905b63685847aa77f17f92bf7156037cc63b9a42c6cd901db69a61604c9/,
  );
  assert.match(cloudInit, /release\/\$YC_VERSION\/linux\/amd64\/yc/);
  assert.match(cloudInit, /yc version --semantic/);
  assert.doesNotMatch(cloudInit, /release\/yc_linux_amd64\.tar\.gz/);
  assert.match(remoteDeploy, /StrictHostKeyChecking=yes/);
  assert.doesNotMatch(remoteDeploy, /StrictHostKeyChecking=accept-new/);

  assert.match(unit, /RuntimeDirectory=markiro-runner/);
  assert.match(unit, /ExecStart=\/usr\/local\/lib\/markiro\/runner-jit/);
  assert.match(unit, /ExecStopPost=\+\/usr\/sbin\/poweroff/);
  assert.match(unit, /TimeoutStartSec=45min/);
});

test("runner delivery bootstrap rejects mutable yc and unauthenticated SSH host-key mutations", async () => {
  const runner = await readRepositoryFile(
    "infra/yandex/modules/compute/cloud-init-runner.yaml.tftpl",
  );
  const app = await readRepositoryFile("infra/yandex/modules/compute/cloud-init-app.yaml.tftpl");
  const remote = await readRepositoryFile("deploy/yandex/remote-deploy.mjs");
  const assertContract = ({ runnerSource, appSource, remoteSource }) => {
    assert.match(runnerSource, /YC_VERSION=1\.23\.0/);
    assert.match(runnerSource, /YC_SHA256=[0-9a-f]{64}/);
    assert.match(runnerSource, /sha256sum --check --status/);
    assert.match(runnerSource, /yc version --semantic/);
    assert.match(appSource, /MARKIRO_SSH_HOST_KEY.*\/dev\/ttyS0/);
    assert.match(remoteSource, /StrictHostKeyChecking=yes/);
    assert.doesNotMatch(remoteSource, /accept-new/);
  };

  assertContract({ runnerSource: runner, appSource: app, remoteSource: remote });
  for (const [name, runnerSource, appSource, remoteSource] of [
    ["yc version", runner.replace("YC_VERSION=1.23.0", "YC_VERSION=latest"), app, remote],
    ["yc checksum", runner.replace(/YC_SHA256=[0-9a-f]{64}/, "YC_SHA256="), app, remote],
    ["host-key serial evidence", runner, app.replace("MARKIRO_SSH_HOST_KEY", "HOST_KEY"), remote],
    [
      "strict host checking",
      runner,
      app,
      remote.replace("StrictHostKeyChecking=yes", "StrictHostKeyChecking=accept-new"),
    ],
  ])
    assert.throws(() => assertContract({ runnerSource, appSource, remoteSource }), undefined, name);
});

test("production managed PostgreSQL and object storage protect durable data", async () => {
  assertProtectedManagedData(await managedDataSources());
});

test("production ingress provides HTTPS-only protected routing through the private app target", async () => {
  assertProtectedIngress(await protectedIngressSources());
});

test("production observability separates logs and audit destinations and defines every alert contract", async () => {
  assertProtectedObservability(await observabilitySources());
});

test("observability contract rejects missing categories, unsafe retention, audit recursion, and incomplete alert wiring", async () => {
  const missingGroup = await observabilitySources();
  missingGroup.observability = missingGroup.observability.replace(
    terraformResourceBlock(missingGroup.observability, "yandex_logging_group", "application"),
    "",
  );
  assert.throws(() => assertProtectedObservability(missingGroup));

  const unlimitedRetention = await observabilitySources();
  unlimitedRetention.observability = unlimitedRetention.observability.replace(
    /retention_period\s*=\s*"336h"/,
    "",
  );
  assert.throws(() => assertProtectedObservability(unlimitedRetention));

  const reusedMediaDestination = await observabilitySources();
  reusedMediaDestination.observability = reusedMediaDestination.observability.replace(
    "bucket_name   = var.audit_bucket_name",
    "bucket_name   = var.media_bucket_name",
  );
  assert.throws(() => assertProtectedObservability(reusedMediaDestination));

  const reusedStateDestination = await observabilitySources();
  reusedStateDestination.observability = reusedStateDestination.observability.replace(
    "bucket_name   = var.audit_bucket_name",
    "bucket_name   = var.state_bucket_name",
  );
  assert.throws(() => assertProtectedObservability(reusedStateDestination));

  const recursiveAuditSource = await observabilitySources();
  recursiveAuditSource.observability = recursiveAuditSource.observability.replace(
    /resource_id\s*=\s*var\.media_bucket_name/g,
    "resource_id   = var.audit_bucket_name",
  );
  assert.throws(() => assertProtectedObservability(recursiveAuditSource));

  const missingAlert = await observabilitySources();
  missingAlert.observability = missingAlert.observability.replace(
    /\n\s*runner_overrun\s*=\s*\{[\s\S]*?\n\s*\}/,
    "",
  );
  assert.throws(() => assertProtectedObservability(missingAlert));

  const missingAlertIdCategory = await observabilitySources();
  missingAlertIdCategory.observabilityVariables =
    missingAlertIdCategory.observabilityVariables.replace('      "runner_overrun",\n', "");
  assert.throws(() => assertProtectedObservability(missingAlertIdCategory));

  const blankAlertIdAccepted = await observabilitySources();
  blankAlertIdAccepted.observabilityVariables = blankAlertIdAccepted.observabilityVariables.replace(
    /\s*&&\s*alltrue\(\[for alert_id in values\(var\.alert_ids\) : length\(trimspace\(alert_id\)\) > 0\]\)/,
    "",
  );
  assert.throws(() => assertProtectedObservability(blankAlertIdAccepted));

  const duplicateAlertIdsAccepted = await observabilitySources();
  duplicateAlertIdsAccepted.observabilityVariables =
    duplicateAlertIdsAccepted.observabilityVariables.replace(
      /\s*&&\s*length\(toset\(values\(var\.alert_ids\)\)\)\s*==\s*length\(var\.alert_ids\)/,
      "",
    );
  assert.throws(() => assertProtectedObservability(duplicateAlertIdsAccepted));

  const duplicateRootAlertIdsAccepted = await observabilitySources();
  duplicateRootAlertIdsAccepted.productionVariables =
    duplicateRootAlertIdsAccepted.productionVariables.replace(
      /\s*&&\s*length\(toset\(values\(var\.alert_ids\)\)\)\s*==\s*length\(var\.alert_ids\)/,
      "",
    );
  assert.throws(() => assertProtectedObservability(duplicateRootAlertIdsAccepted));

  const blankChannelAccepted = await observabilitySources();
  blankChannelAccepted.observabilityVariables = blankChannelAccepted.observabilityVariables.replace(
    /length\(trimspace\(var\.notification_channel_id\)\)\s*>\s*0/,
    "true",
  );
  assert.throws(() => assertProtectedObservability(blankChannelAccepted));

  const blankRootChannelAccepted = await observabilitySources();
  blankRootChannelAccepted.productionVariables =
    blankRootChannelAccepted.productionVariables.replace(
      /length\(trimspace\(var\.notification_channel_id\)\)\s*>\s*0/,
      "true",
    );
  assert.throws(() => assertProtectedObservability(blankRootChannelAccepted));

  const wrongChannel = await observabilitySources();
  wrongChannel.observability = wrongChannel.observability.replace(
    /notification_channel_id\s*=\s*var\.notification_channel_id/,
    'notification_channel_id = "other-channel"',
  );
  assert.throws(() => assertProtectedObservability(wrongChannel));
});

test("production ingress contract rejects bypasses, computed certificate keys, fractional rates, and unsafe defaults", async () => {
  const missingSws = await protectedIngressSources();
  missingSws.ingress = replaceTerraformResource(
    missingSws.ingress,
    "yandex_alb_virtual_host",
    "markiro",
    (block) => block.replace(/\n\s*route_options\s*\{[\s\S]*?\n\s*\}/, ""),
  );
  assert.throws(() => assertProtectedIngress(missingSws));

  const apiBypass = await protectedIngressSources();
  apiBypass.ingress = replaceTerraformResource(
    apiBypass.ingress,
    "yandex_alb_virtual_host",
    "markiro",
    (block) => block.replace("yandex_alb_backend_group.app.id", "var.api_backend_group_id"),
  );
  assert.throws(() => assertProtectedIngress(apiBypass));

  const tlsBackend = await protectedIngressSources();
  tlsBackend.ingress = replaceTerraformResource(
    tlsBackend.ingress,
    "yandex_alb_backend_group",
    "app",
    (block) => block.replace(/port\s*=\s*8080/, "port = 443"),
  );
  assert.throws(() => assertProtectedIngress(tlsBackend));

  const livenessProbe = await protectedIngressSources();
  livenessProbe.ingress = replaceTerraformResource(
    livenessProbe.ingress,
    "yandex_alb_backend_group",
    "app",
    (block) => block.replace("/health/ready", "/health"),
  );
  assert.throws(() => assertProtectedIngress(livenessProbe));

  const publicByDefault = await protectedIngressSources();
  publicByDefault.ingressVariables = publicByDefault.ingressVariables.replace(
    "default     = false",
    "default     = true",
  );
  assert.throws(() => assertProtectedIngress(publicByDefault));

  const ipv6 = await protectedIngressSources();
  ipv6.ingress = replaceTerraformResource(
    ipv6.ingress,
    "yandex_alb_load_balancer",
    "markiro",
    (block) =>
      block.replace(
        "external_ipv4_address {",
        "external_ipv6_address {}\n\n        external_ipv4_address {",
      ),
  );
  assert.throws(() => assertProtectedIngress(ipv6));

  const computedForEach = await protectedIngressSources();
  computedForEach.ingress = replaceTerraformResource(
    computedForEach.ingress,
    "yandex_dns_recordset",
    "certificate_validation",
    (block) =>
      block.replace(
        "count = 1",
        "for_each = { for challenge in yandex_cm_certificate.markiro.challenges : challenge.domain => challenge }",
      ),
  );
  assert.throws(() => assertProtectedIngress(computedForEach));

  const fractionalGlobalRate = await protectedIngressSources();
  fractionalGlobalRate.ingressVariables = fractionalGlobalRate.ingressVariables.replace(
    "var.global_rate_limit == floor(var.global_rate_limit) && ",
    "",
  );
  assert.throws(() => assertProtectedIngress(fractionalGlobalRate));

  const fractionalPerIpRate = await protectedIngressSources();
  fractionalPerIpRate.productionVariables = fractionalPerIpRate.productionVariables.replace(
    "var.per_ip_rate_limit == floor(var.per_ip_rate_limit) && ",
    "",
  );
  assert.throws(() => assertProtectedIngress(fractionalPerIpRate));
});

test("managed-data contract rejects unsafe PostgreSQL, buckets, access, and credentials", async () => {
  const publicPostgres = await managedDataSources();
  publicPostgres.postgres = replaceTerraformResource(
    publicPostgres.postgres,
    "yandex_mdb_postgresql_cluster",
    "production",
    (block) => block.replace(/assign_public_ip\s*=\s*false/, "assign_public_ip = true"),
  );
  assert.throws(() => assertProtectedManagedData(publicPostgres));

  const shortRetention = await managedDataSources();
  shortRetention.postgres = replaceTerraformResource(
    shortRetention.postgres,
    "yandex_mdb_postgresql_cluster",
    "production",
    (block) => block.replace(/backup_retain_period_days\s*=\s*14/, "backup_retain_period_days = 7"),
  );
  assert.throws(() => assertProtectedManagedData(shortRetention));

  const wrongPostgresKms = await managedDataSources();
  wrongPostgresKms.postgres = replaceTerraformResource(
    wrongPostgresKms.postgres,
    "yandex_mdb_postgresql_cluster",
    "production",
    (block) =>
      block.replace(
        /disk_encryption_key_id\s*=\s*var\.kms_key_id/,
        "disk_encryption_key_id = var.other_kms_key_id",
      ),
  );
  assert.throws(() => assertProtectedManagedData(wrongPostgresKms));

  const wrongDatabaseOwner = await managedDataSources();
  wrongDatabaseOwner.postgres = replaceTerraformResource(
    wrongDatabaseOwner.postgres,
    "yandex_mdb_postgresql_database",
    "application",
    (block) => block.replace(/owner\s*=\s*var\.database_name/, "owner = var.other_database_owner"),
  );
  assert.throws(() => assertProtectedManagedData(wrongDatabaseOwner));

  const missingDatabaseOwner = await managedDataSources();
  missingDatabaseOwner.postgres = replaceTerraformResource(
    missingDatabaseOwner.postgres,
    "yandex_mdb_postgresql_database",
    "application",
    (block) => block.replace(/\n\s*owner\s*=\s*var\.database_name/, ""),
  );
  assert.throws(() => assertProtectedManagedData(missingDatabaseOwner));

  const missingPostgresKms = await managedDataSources();
  missingPostgresKms.postgres = replaceTerraformResource(
    missingPostgresKms.postgres,
    "yandex_mdb_postgresql_cluster",
    "production",
    (block) => block.replace(/\n\s*disk_encryption_key_id\s*=\s*var\.kms_key_id/, ""),
  );
  assert.throws(() => assertProtectedManagedData(missingPostgresKms));

  const publicBucket = await managedDataSources();
  publicBucket.storage = replaceTerraformResource(
    publicBucket.storage,
    "yandex_storage_bucket",
    "media",
    (block) => block.replace(/read\s*=\s*false/, "read = true"),
  );
  assert.throws(() => assertProtectedManagedData(publicBucket));

  const unversionedBucket = await managedDataSources();
  unversionedBucket.storage = replaceTerraformResource(
    unversionedBucket.storage,
    "yandex_storage_bucket",
    "media",
    (block) =>
      block.replace(
        /versioning\s*\{\s*enabled\s*=\s*true\s*\}/,
        "versioning {\n    enabled = false\n  }",
      ),
  );
  assert.throws(() => assertProtectedManagedData(unversionedBucket));

  for (const bucketName of ["media", "audit"]) {
    const wrongBucketKms = await managedDataSources();
    wrongBucketKms.storage = replaceTerraformResource(
      wrongBucketKms.storage,
      "yandex_storage_bucket",
      bucketName,
      (block) =>
        block.replace(
          /kms_master_key_id\s*=\s*var\.kms_key_id/,
          "kms_master_key_id = var.other_kms_key_id",
        ),
    );
    assert.throws(() => assertProtectedManagedData(wrongBucketKms));

    const missingBucketKms = await managedDataSources();
    missingBucketKms.storage = replaceTerraformResource(
      missingBucketKms.storage,
      "yandex_storage_bucket",
      bucketName,
      (block) => block.replace(/\n\s*kms_master_key_id\s*=\s*var\.kms_key_id/, ""),
    );
    assert.throws(() => assertProtectedManagedData(missingBucketKms));
  }

  const currentMediaExpiration = await managedDataSources();
  currentMediaExpiration.storage = replaceTerraformResource(
    currentMediaExpiration.storage,
    "yandex_storage_bucket",
    "media",
    (block) =>
      block.replace(
        "noncurrent_version_expiration {",
        "expiration {\n      days = 365\n    }\n\n    noncurrent_version_expiration {",
      ),
  );
  assert.throws(() => assertProtectedManagedData(currentMediaExpiration));

  const broadAppAccess = await managedDataSources();
  broadAppAccess.storage = replaceTerraformResource(
    broadAppAccess.storage,
    "yandex_storage_bucket_policy",
    "media_app",
    (block) => block.replace('"s3:DeleteObject"]', '"s3:DeleteObject", "s3:PutBucketLifecycle"]'),
  );
  assert.throws(() => assertProtectedManagedData(broadAppAccess));

  const wildcardPrincipal = await managedDataSources();
  wildcardPrincipal.storage = replaceTerraformResource(
    wildcardPrincipal.storage,
    "yandex_storage_bucket_policy",
    "media_app",
    (block) => block.replace("CanonicalUser = var.app_service_account_id", 'CanonicalUser = "*"'),
  );
  assert.throws(() => assertProtectedManagedData(wildcardPrincipal));

  const extraPublicStatement = await managedDataSources();
  extraPublicStatement.storage = replaceTerraformResource(
    extraPublicStatement.storage,
    "yandex_storage_bucket_policy",
    "media_app",
    (block) =>
      block.replace(
        "    ]\n  })",
        '      {\n        Sid       = "PublicRead"\n        Effect    = "Allow"\n        Principal = "*"\n        Action    = ["s3:GetObject"]\n        Resource  = ["arn:aws:s3:::public/*"]\n      },\n    ]\n  })',
      ),
  );
  assert.throws(() => assertProtectedManagedData(extraPublicStatement));

  const broadenedAuditAction = await managedDataSources();
  broadenedAuditAction.storage = replaceTerraformResource(
    broadenedAuditAction.storage,
    "yandex_storage_bucket_policy",
    "audit_writer",
    (block) =>
      block.replace('Action    = ["s3:PutObject"]', 'Action = ["s3:PutObject", "s3:GetObject"]'),
  );
  assert.throws(() => assertProtectedManagedData(broadenedAuditAction));

  for (const resourceName of ["media_app", "audit_writer"]) {
    const missingKmsBinding = await managedDataSources();
    const binding = terraformResourceBlock(
      missingKmsBinding.storage,
      "yandex_kms_symmetric_key_iam_member",
      resourceName,
    );
    missingKmsBinding.storage = missingKmsBinding.storage.replace(binding, "");
    assert.throws(() => assertProtectedManagedData(missingKmsBinding));
  }

  const passwordResource = await managedDataSources();
  passwordResource.postgres +=
    '\nresource "yandex_mdb_postgresql_user" "unsafe" { password = "unsafe" }\n';
  assert.throws(() => assertProtectedManagedData(passwordResource));

  const staticKeyResource = await managedDataSources();
  staticKeyResource.storage +=
    '\nresource "yandex_iam_service_account_static_access_key" "unsafe" {}\n';
  assert.throws(() => assertProtectedManagedData(staticKeyResource));
});

test("production private-compute contract rejects public NAT, CIDR SSH, public app traffic, and embedded credentials", async () => {
  const natEnabled = await privateNetworkAndComputeSources();
  natEnabled.compute = replaceTerraformResource(
    natEnabled.compute,
    "yandex_compute_instance",
    "app",
    (block) => block.replace(/nat\s*=\s*false/, "nat = true"),
  );
  assert.throws(() => assertPrivateNetworkAndCompute(natEnabled));

  const cidrSsh = await privateNetworkAndComputeSources();
  cidrSsh.network = replaceTerraformResource(
    cidrSsh.network,
    "yandex_vpc_security_group",
    "app",
    (block) =>
      block.replace(
        "security_group_id = yandex_vpc_security_group.runner.id",
        'v4_cidr_blocks  = ["10.0.0.0/8"]',
      ),
  );
  assert.throws(() => assertPrivateNetworkAndCompute(cidrSsh));

  const publicAppPort = await privateNetworkAndComputeSources();
  publicAppPort.network = replaceTerraformResource(
    publicAppPort.network,
    "yandex_vpc_security_group",
    "app",
    (block) =>
      block.replace(
        "security_group_id = yandex_vpc_security_group.alb.id",
        'v4_cidr_blocks  = ["0.0.0.0/0"]',
      ),
  );
  assert.throws(() => assertPrivateNetworkAndCompute(publicAppPort));

  for (const port of [22, 8080]) {
    const extraAlbPublicIngress = await privateNetworkAndComputeSources();
    extraAlbPublicIngress.network = replaceTerraformResource(
      extraAlbPublicIngress.network,
      "yandex_vpc_security_group",
      "alb",
      (block) =>
        block.replace(
          "\n  egress {",
          '\n  ingress {\n    protocol       = "TCP"\n    from_port      = ' +
            port +
            "\n    to_port        = " +
            port +
            '\n    v4_cidr_blocks = ["0.0.0.0/0"]\n  }\n\n  egress {',
        ),
    );
    assert.throws(() => assertPrivateNetworkAndCompute(extraAlbPublicIngress));
  }

  const rangedAlbPublicIngress = await privateNetworkAndComputeSources();
  rangedAlbPublicIngress.network = replaceTerraformResource(
    rangedAlbPublicIngress.network,
    "yandex_vpc_security_group",
    "alb",
    (block) =>
      block.replace(
        "from_port      = 80\n    to_port        = 80",
        "from_port      = 80\n    to_port        = 8080",
      ),
  );
  assert.throws(() => assertPrivateNetworkAndCompute(rangedAlbPublicIngress));

  const multiCidrPublicIngress = await privateNetworkAndComputeSources();
  multiCidrPublicIngress.network = replaceTerraformResource(
    multiCidrPublicIngress.network,
    "yandex_vpc_security_group",
    "app",
    (block) =>
      block.replace(
        "\n  egress {",
        '\n  ingress {\n    protocol       = "TCP"\n    from_port      = 22\n    to_port        = 22\n    v4_cidr_blocks = ["10.0.0.0/8", "0.0.0.0/0"]\n  }\n\n  egress {',
      ),
  );
  assert.throws(() => assertPrivateNetworkAndCompute(multiCidrPublicIngress));

  const embeddedRunnerCredential = await privateNetworkAndComputeSources();
  embeddedRunnerCredential.runnerCloudInit += "\ngithub_token: unsafe-value\n";
  assert.throws(() => assertPrivateNetworkAndCompute(embeddedRunnerCredential));

  const embeddedCommandCredential = await privateNetworkAndComputeSources();
  embeddedCommandCredential.runnerCloudInit += '\nruncmd:\n  - sh -c "RUNNER_TOKEN=unsafe-value"\n';
  assert.throws(() => assertPrivateNetworkAndCompute(embeddedCommandCredential));

  const embeddedWriteFileCredential = await privateNetworkAndComputeSources();
  embeddedWriteFileCredential.runnerCloudInit = embeddedWriteFileCredential.runnerCloudInit.replace(
    "      #!/usr/bin/env bash",
    "      RUNNER_TOKEN=unsafe-value\n      #!/usr/bin/env bash",
  );
  assert.throws(() => assertPrivateNetworkAndCompute(embeddedWriteFileCredential));

  const embeddedMetadataCredential = await privateNetworkAndComputeSources();
  embeddedMetadataCredential.compute = replaceTerraformResource(
    embeddedMetadataCredential.compute,
    "yandex_compute_instance",
    "app",
    (block) =>
      block.replace(/metadata\s*=\s*\{/, 'metadata = {\n    runtime_secret = "unsafe-value"'),
  );
  assert.throws(() => assertPrivateNetworkAndCompute(embeddedMetadataCredential));
});

function assertRuntimeNodeProvisioning(cloudInit) {
  assert.match(cloudInit, /NODE_VERSION=24\.11\.1/);
  assert.match(
    cloudInit,
    /NODE_SHA256=60e3b0a8500819514aca603487c254298cd776de0698d3cd08f11dba5b8289a8/,
  );
  assert.match(cloudInit, /NODE_ARCH=x64/);
  assert.match(cloudInit, /test "\$\(uname -m\)" = "x86_64"/);
  assert.match(cloudInit, /test "\$\(dpkg --print-architecture\)" = "amd64"/);
  assert.match(cloudInit, /sha256sum --check --status/);
  assert.match(cloudInit, /test "\$\(\/usr\/bin\/node --version\)" = "v\$\$\{NODE_VERSION\}"/);
  assert.doesNotMatch(cloudInit, /curl[^\n]*\|/);
}

test("runtime secret materialization installs coherent assets, verified Node, and reactivating service dependencies", async () => {
  const [
    compute,
    cloudInit,
    runtimeUnit,
    observerUnit,
    observerTimer,
    composeDropIn,
    deployDropIn,
  ] = await Promise.all([
    readRepositoryFile("infra/yandex/modules/compute/main.tf"),
    readRepositoryFile("infra/yandex/modules/compute/cloud-init-app.yaml.tftpl"),
    readRepositoryFile("deploy/yandex/systemd/markiro-runtime-env.service"),
    readRepositoryFile("deploy/yandex/systemd/markiro-readiness-observer.service"),
    readRepositoryFile("deploy/yandex/systemd/markiro-readiness-observer.timer"),
    readRepositoryFile("deploy/yandex/systemd/markiro-compose.service.d/runtime-env.conf"),
    readRepositoryFile("deploy/yandex/systemd/markiro-deploy.service.d/runtime-env.conf"),
  ]);

  assert.match(compute, /runtime_secret_id\s*=\s*var\.runtime_secret_id/);
  for (const asset of [
    "runtime-env.mjs",
    "readiness-observer.mjs",
    "cli-main.mjs",
    ".env.production.example",
  ])
    assert.match(
      compute,
      new RegExp(`deploy/yandex/${asset.replace(".", "\\.")}|${asset.replace(".", "\\.")}`),
    );
  assert.match(cloudInit, /MARKIRO_RUNTIME_SECRET_ID=\$\{runtime_secret_id\}/);
  assert.match(cloudInit, /owner:\s*root:root/g);
  assert.match(cloudInit, /permissions:\s*"0600"/);
  assert.doesNotMatch(cloudInit, /(?:DATABASE_URL|SMTP_PASSWORD|S3_SECRET_ACCESS_KEY)\s*=/);
  assertRuntimeNodeProvisioning(cloudInit);
  assert.match(runtimeUnit, /Before=markiro-compose\.service markiro-deploy\.service/);
  assert.match(runtimeUnit, /ReadWritePaths=\/etc\/markiro/);
  assert.match(runtimeUnit, /NoNewPrivileges=true/);
  assert.doesNotMatch(runtimeUnit, /RemainAfterExit=true/);
  for (const dropIn of [composeDropIn, deployDropIn]) {
    assert.match(dropIn, /Requires=markiro-runtime-env\.service/);
    assert.match(dropIn, /After=markiro-runtime-env\.service/);
  }
  assert.match(observerUnit, /User=markiro-monitor/);
  assert.match(
    observerUnit,
    /ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/markiro\/readiness-observer\.mjs/,
  );
  assert.match(observerTimer, /OnUnitActiveSec=1min/);
  assert.match(observerTimer, /Persistent=true/);
});

test("runtime Node provisioning contract rejects missing checksum or version verification", async () => {
  const cloudInit = await readRepositoryFile(
    "infra/yandex/modules/compute/cloud-init-app.yaml.tftpl",
  );
  const withoutChecksum = cloudInit.replace(
    "NODE_SHA256=60e3b0a8500819514aca603487c254298cd776de0698d3cd08f11dba5b8289a8\n",
    "",
  );
  const withoutChecksumVerification = cloudInit.replace(" | sha256sum --check --status", "");
  const withoutVersionVerification = cloudInit.replace(
    '      test "$(/usr/bin/node --version)" = "v$${NODE_VERSION}"\n',
    "",
  );

  for (const unsafeCloudInit of [
    withoutChecksum,
    withoutChecksumVerification,
    withoutVersionVerification,
  ])
    assert.throws(() => assertRuntimeNodeProvisioning(unsafeCloudInit));
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
