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
const terraformRoots = ["production"];
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
    "docs/acceptance/screenshots/station-exception-confirm-1280x1024-at-2x.jpg",
    "564a51d06e97ed7335afce1e15922b4f37c2a479e0c627c1a9dab287bcf1ae1a",
  ],
  [
    "docs/acceptance/screenshots/station-login-name-search-1024x768-ru.jpg",
    "a990fdd2a83aad04760a35ac94936083ac33b7bbc6d361e9bf24cbdb5c0e3326",
  ],
  [
    "docs/acceptance/screenshots/station-long-copy-1024x768-en.jpg",
    "c9acd518ecbac86ac9f4f88c84d62f4d57d03de037b36cedd65b86dfe69486f3",
  ],
  [
    "docs/acceptance/screenshots/station-work-aggregation-1280x800-ru.jpg",
    "c9218e2d11ee2536084ed081b95dcd450cead540dc9d500714af81e6a376f8ac",
  ],
  [
    "docs/assets/readme/admin.webp",
    "45f839a00b6a2862f026c5c4955b15531db61d5f853112b0dbb453af9b767d75",
  ],
  [
    "docs/assets/readme/kiosk.webp",
    "a42b51e25673dafa9d1e572af940b7287279a53dd931576cd14b1575028c9296",
  ],
  [
    "docs/assets/readme/station.webp",
    "69e930e4f088da58508c55134e3843c659a6e82499c4be6348673520dc2fcdbf",
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

function terraformDeclarationCount(source, kind, type) {
  return [...source.matchAll(new RegExp(`${kind}\\s+"${type}"\\s+"[^"]+"\\s*\\{`, "g"))].length;
}

function terraformListItems(source) {
  return source
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

function terraformStringMap(source, name) {
  const block = terraformObjectEntry(source, name);
  return Object.fromEntries(
    [...block.matchAll(/^\s*"([^"]+)"\s*=\s*"([^"]+)"\s*$/gm)].map((match) => [match[1], match[2]]),
  );
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

const productionResourceActionRoles = {
  yandex_alb_backend_group: ["alb.resources.manage"],
  yandex_alb_http_router: ["alb.resources.manage"],
  yandex_alb_load_balancer: [
    "alb.resources.manage",
    "certificate-manager.certificates.download-for-alb-tls",
    "vpc.resources.use",
  ],
  yandex_alb_target_group: ["alb.resources.manage"],
  yandex_alb_virtual_host: ["alb.resources.manage"],
  yandex_audit_trails_trail: ["audit-trails.trails.manage"],
  yandex_cm_certificate: ["certificate-manager.certificates.manage"],
  yandex_compute_instance: ["compute.instances-and-access.manage", "vpc.resources.use"],
  yandex_compute_instance_iam_binding: ["compute.instances-and-access.manage"],
  yandex_dns_recordset: ["dns.recordsets.manage"],
  yandex_logging_group: ["logging.groups.manage"],
  yandex_mdb_postgresql_cluster: ["managed-postgresql.resources.manage", "vpc.resources.use"],
  yandex_mdb_postgresql_database: ["managed-postgresql.resources.manage"],
  yandex_monitoring_dashboard: ["monitoring.dashboards.manage"],
  yandex_storage_bucket: ["storage.buckets-and-policies.manage"],
  yandex_storage_bucket_iam_binding: ["storage.buckets-and-policies.manage"],
  yandex_storage_bucket_policy: ["storage.buckets-and-policies.manage"],
  yandex_sws_advanced_rate_limiter_profile: ["smart-web-security.resources.manage"],
  yandex_sws_security_profile: ["smart-web-security.resources.manage"],
  yandex_vpc_address: ["vpc.public-addresses.manage"],
  yandex_vpc_gateway: ["vpc.gateways.manage"],
  yandex_vpc_network: ["vpc.networks-subnets-routes.manage"],
  yandex_vpc_route_table: ["vpc.networks-subnets-routes.manage", "vpc.gateways.attach-to-routes"],
  yandex_vpc_security_group: ["vpc.security-groups.manage"],
  yandex_vpc_subnet: ["vpc.networks-subnets-routes.manage"],
};

const expectedProductionActionRoles = {
  "alb.resources.manage": "alb.editor",
  "audit-trails.trails.manage": "audit-trails.editor",
  "certificate-manager.certificates.download-for-alb-tls":
    "certificate-manager.certificates.downloader",
  "certificate-manager.certificates.manage": "certificate-manager.editor",
  "compute.instances-and-access.manage": "compute.admin",
  "dns.recordsets.manage": "dns.editor",
  "logging.groups.manage": "logging.editor",
  "managed-postgresql.resources.manage": "managed-postgresql.editor",
  "monitoring.dashboards.manage": "monitoring.editor",
  "smart-web-security.resources.manage": "smart-web-security.editor",
  "storage.buckets-and-policies.manage": "storage.admin",
  "vpc.gateways.attach-to-routes": "vpc.gateways.user",
  "vpc.gateways.manage": "vpc.gateways.editor",
  "vpc.networks-subnets-routes.manage": "vpc.privateAdmin",
  "vpc.public-addresses.manage": "vpc.publicAdmin",
  "vpc.resources.use": "vpc.user",
  "vpc.security-groups.manage": "vpc.securityGroups.admin",
};

const expectedEncryptedResourceKeyDependencies = {
  "yandex_compute_instance.app": "kms.keys.user",
  "yandex_compute_instance.runner": "kms.keys.user",
  "yandex_mdb_postgresql_cluster.production": "kms.keys.user",
};

function assertProtectedBootstrap({ bootstrap, iam, outputs, productionResources, variables }) {
  const allHcl = [bootstrap, iam, outputs, variables].join("\n");
  const serviceAccounts = [...iam.matchAll(/resource\s+"yandex_iam_service_account"\s+"([^"]+)"/g)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(serviceAccounts, [
    "app",
    "audit",
    "deployment_controller",
    "runner",
    "state",
    "terraform",
  ]);
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
    "exact production-controller, production-cleanup, and infrastructure credentials are required",
  );

  assert.doesNotMatch(
    allHcl,
    /yandex_iam_service_account_(?:static_)?access_key/,
    "Terraform must not create long-lived service-account access keys",
  );

  const actionRoles = terraformStringMap(iam, "terraform_production_action_roles");
  assert.deepEqual(actionRoles, expectedProductionActionRoles);
  const resourceTypes = [
    ...new Set(
      productionResources.flatMap((source) =>
        [...source.matchAll(/^resource\s+"([^"]+)"\s+"[^"]+"\s*\{/gm)].map((match) => match[1]),
      ),
    ),
  ].sort();
  assert.deepEqual(resourceTypes, Object.keys(productionResourceActionRoles).sort());
  for (const resourceType of resourceTypes) {
    for (const action of productionResourceActionRoles[resourceType])
      assert.ok(actionRoles[action], `${resourceType} action ${action} has no explicit IAM grant`);
  }
  assert.match(
    iam,
    /terraform_folder_roles\s*=\s*toset\(values\(local\.terraform_production_action_roles\)\)/,
  );
  const terraformServiceAccountUser = terraformResourceBlock(
    iam,
    "yandex_iam_service_account_iam_member",
    "terraform_service_account_user",
  );
  assert.match(
    terraformServiceAccountUser,
    /for_each\s*=\s*\{\s*app\s*=\s*yandex_iam_service_account\.app\.id\s*runner\s*=\s*yandex_iam_service_account\.runner\.id\s*audit\s*=\s*yandex_iam_service_account\.audit\.id,?\s*\}/,
  );
  assert.match(terraformServiceAccountUser, /service_account_id\s*=\s*each\.value/);
  const terraformServiceAccountViewer = terraformResourceBlock(
    iam,
    "yandex_iam_service_account_iam_member",
    "terraform_service_account_viewer",
  );
  assert.match(
    terraformServiceAccountViewer,
    /for_each\s*=\s*\{\s*deployment_controller\s*=\s*yandex_iam_service_account\.deployment_controller\.id\s*terraform\s*=\s*yandex_iam_service_account\.terraform\.id,?\s*\}/,
  );
  assert.match(terraformServiceAccountViewer, /service_account_id\s*=\s*each\.value/);
  assert.match(terraformServiceAccountViewer, /role\s*=\s*"viewer"/);
  assert.match(
    terraformServiceAccountViewer,
    /member\s*=\s*"serviceAccount:\$\{yandex_iam_service_account\.terraform\.id\}"/,
  );
  assert.doesNotMatch(iam, /folder_iam_member"\s+"terraform_iam_viewer"/);
  assert.doesNotMatch(iam, /"(?:alb|vpc)\.admin"/);

  const encryptedResources = productionResources
    .flatMap((source) =>
      [...source.matchAll(/^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/gm)].map((match) => ({
        address: `${match[1]}.${match[2]}`,
        block: terraformResourceBlock(source, match[1], match[2]),
      })),
    )
    .filter(({ block }) =>
      /\b(?:kms_key_id|disk_encryption_key_id)\s*=\s*var\.kms_key_id/.test(block),
    )
    .map(({ address }) => address)
    .sort();
  assert.deepEqual(
    encryptedResources,
    Object.keys(expectedEncryptedResourceKeyDependencies).sort(),
  );

  for (const [name, serviceAccount] of [
    ["terraform_key_user", "terraform"],
    ["deployment_controller_runner_key_user", "deployment_controller"],
  ]) {
    const grant = terraformResourceBlock(bootstrap, "yandex_kms_symmetric_key_iam_member", name);
    assert.match(grant, /symmetric_key_id\s*=\s*var\.kms_key_id/);
    assert.match(grant, /role\s*=\s*"kms\.keys\.user"/);
    assert.match(
      grant,
      new RegExp(`serviceAccount:\\$\\{module\\.iam\\.service_account_ids\\.${serviceAccount}\\}`),
    );
  }
  assert.doesNotMatch(
    allHcl,
    /yandex_lockbox_secret_version/,
    "Terraform must create secret containers without payload versions",
  );

  const stateBucket = terraformResourceBlock(bootstrap, "yandex_storage_bucket", "state");
  assert.match(stateBucket, /versioning\s*\{[\s\S]*?enabled\s*=\s*true/);
  assert.match(stateBucket, /lifecycle\s*\{[\s\S]*?prevent_destroy\s*=\s*true/);

  const secretNames = ["runtime", "registry", "state_backend", "runner_registration"];
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
    /variable\s+"github_repository"\s*\{[\s\S]*?condition\s*=\s*var\.github_repository\s*==\s*"thevladbog\/markiro"/,
  );
  assert.match(
    variables,
    /variable\s+"github_repository_owner_id"\s*\{[\s\S]*?condition\s*=\s*var\.github_repository_owner_id\s*==\s*"47273232"/,
  );
  assert.match(
    variables,
    /variable\s+"github_repository_id"\s*\{[\s\S]*?condition\s*=\s*var\.github_repository_id\s*==\s*"1308139775"/,
  );
  assert.match(
    variables,
    /variable\s+"github_controller_environment"\s*\{[\s\S]*?condition\s*=\s*var\.github_controller_environment\s*==\s*"production-controller"/,
  );
  assert.match(
    variables,
    /variable\s+"github_cleanup_environment"\s*\{[\s\S]*?condition\s*=\s*var\.github_cleanup_environment\s*==\s*"production-cleanup"/,
  );
  assert.match(
    variables,
    /variable\s+"github_infrastructure_environment"\s*\{[\s\S]*?condition\s*=\s*var\.github_infrastructure_environment\s*==\s*"production-infrastructure"/,
  );
  assert.match(
    iam,
    /github_controller_subject\s*=\s*"repo:\$\{local\.github_repository_subject\}:environment:\$\{var\.github_controller_environment\}"/,
  );
  assert.match(
    iam,
    /github_cleanup_subject\s*=\s*"repo:\$\{local\.github_repository_subject\}:environment:\$\{var\.github_cleanup_environment\}"/,
  );
  assert.match(
    iam,
    /github_infrastructure_subject\s*=\s*"repo:\$\{local\.github_repository_subject\}:environment:\$\{var\.github_infrastructure_environment\}"/,
  );
  assert.match(
    iam,
    /github_repository_subject\s*=\s*"\$\{local\.github_owner\}@\$\{var\.github_repository_owner_id\}\/\$\{local\.github_repository_name\}@\$\{var\.github_repository_id\}"/,
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
    "github_production_controller",
  );
  assert.match(
    credential,
    /service_account_id\s*=\s*yandex_iam_service_account\.deployment_controller\.id/,
  );
  assert.match(
    credential,
    /federation_id\s*=\s*yandex_iam_workload_identity_oidc_federation\.github\.id/,
  );
  assert.match(credential, /external_subject_id\s*=\s*local\.github_controller_subject/);

  const cleanupCredential = terraformResourceBlock(
    iam,
    "yandex_iam_workload_identity_federated_credential",
    "github_production_cleanup",
  );
  assert.match(
    cleanupCredential,
    /service_account_id\s*=\s*yandex_iam_service_account\.deployment_controller\.id/,
  );
  assert.match(cleanupCredential, /external_subject_id\s*=\s*local\.github_cleanup_subject/);

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
    /members\s*=\s*\[[\s\S]*?serviceAccount:\$\{yandex_iam_service_account\.terraform\.id\}[\s\S]*?serviceAccount:\$\{yandex_iam_service_account\.deployment_controller\.id\}[\s\S]*?\]/,
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
    ["runner_registry", "registry_secret_id", "runner"],
    ["terraform_state_backend", "state_backend_secret_id", "terraform"],
    [
      "deployment_controller_runner_registration",
      "runner_registration_secret_id",
      "deployment_controller",
    ],
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

  const terraformAuditScopeViewer = terraformResourceBlock(
    iam,
    "yandex_lockbox_secret_iam_member",
    "terraform_audit_scope_viewer",
  );
  assert.match(
    terraformAuditScopeViewer,
    /for_each\s*=\s*\{\s*registry\s*=\s*var\.registry_secret_id\s*runner_registration\s*=\s*var\.runner_registration_secret_id\s*runtime\s*=\s*var\.runtime_secret_id,?\s*\}/,
  );
  assert.match(terraformAuditScopeViewer, /secret_id\s*=\s*each\.value/);
  assert.match(terraformAuditScopeViewer, /role\s*=\s*"lockbox\.viewer"/);
  assert.match(
    terraformAuditScopeViewer,
    /member\s*=\s*"serviceAccount:\$\{yandex_iam_service_account\.terraform\.id\}"/,
  );

  assert.doesNotMatch(
    iam,
    /role\s*=\s*"(?:admin|editor)"/,
    "the production Terraform identity must not retain a primitive folder role",
  );
  assert.match(iam, /resource\s+"yandex_iam_service_account"\s+"deployment_controller"/);
  assert.match(
    iam,
    /resource\s+"yandex_iam_workload_identity_federated_credential"\s+"github_production_controller"[\s\S]*?service_account_id\s*=\s*yandex_iam_service_account\.deployment_controller\.id[\s\S]*?external_subject_id\s*=\s*local\.github_controller_subject/,
  );
  assert.doesNotMatch(
    terraformResourceBlock(
      iam,
      "yandex_iam_workload_identity_federated_credential",
      "github_infrastructure",
    ),
    /local\.github_(?:controller|cleanup)_subject/,
    "Terraform federation must remain limited to the infrastructure environment",
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
    "registry_secret_id",
    "state_backend_secret_id",
    "runner_registration_secret_id",
    "audit_log_group_id",
  ]) {
    assert.match(
      terraformOutputBlock(outputs, name),
      /sensitive\s*=\s*true/,
      `${name} must be marked sensitive`,
    );
  }

  const auditScope = terraformResourceBlock(
    bootstrap,
    "yandex_resourcemanager_folder_iam_member",
    "audit_trails_viewer",
  );
  assert.match(auditScope, /role\s*=\s*"audit-trails\.viewer"/);
  assert.match(auditScope, /serviceAccount:\$\{module\.iam\.service_account_ids\.audit\}/);
  const auditDestination = terraformResourceBlock(
    bootstrap,
    "yandex_resourcemanager_folder_iam_member",
    "audit_logging_writer",
  );
  assert.match(auditDestination, /folder_id\s*=\s*var\.folder_id/);
  assert.match(auditDestination, /role\s*=\s*"logging\.writer"/);
  const auditKms = terraformResourceBlock(
    bootstrap,
    "yandex_kms_symmetric_key_iam_member",
    "audit_encrypter",
  );
  assert.match(auditKms, /symmetric_key_id\s*=\s*var\.kms_key_id/);
  assert.match(auditKms, /role\s*=\s*"kms\.keys\.encrypterDecrypter"/);
}

async function bootstrapContractSources() {
  const [bootstrap, iam, outputs, variables, ...productionResources] = await Promise.all([
    readRepositoryFile("infra/yandex/bootstrap/main.tf"),
    readRepositoryFile("infra/yandex/modules/iam/main.tf"),
    readRepositoryFile("infra/yandex/bootstrap/outputs.tf"),
    readRepositoryFile("infra/yandex/bootstrap/variables.tf"),
    ...["compute", "ingress", "network", "object-storage", "observability", "postgres"].map(
      (module) => readRepositoryFile(`infra/yandex/modules/${module}/main.tf`),
    ),
  ]);

  return { bootstrap, iam, outputs, productionResources, variables };
}

function assertRunnerControllerProviderGrants({ bootstrap, compute, controller, iam }) {
  const providerCalls = [
    ...controller.matchAll(/`(https:\/\/(?:compute|mdb|alb)\.api\.cloud\.yandex\.net\/[^`]+)`/g),
  ]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(providerCalls, [
    "https://alb.api.cloud.yandex.net/apploadbalancer/v1/loadBalancers/${loadBalancerId}/targetStates/${backendGroupId}/${targetGroupId}",
    "https://compute.api.cloud.yandex.net/compute/v1/instances/${appInstanceId}",
    "https://compute.api.cloud.yandex.net/compute/v1/instances/${appInstanceId}:serialPortOutput?port=1",
    "https://compute.api.cloud.yandex.net/compute/v1/instances/${id}",
    "https://compute.api.cloud.yandex.net/compute/v1/instances/${id}/updateMetadata",
    "https://compute.api.cloud.yandex.net/compute/v1/instances/${id}:start",
    "https://compute.api.cloud.yandex.net/compute/v1/instances/${id}:stop",
    "https://mdb.api.cloud.yandex.net/managed-postgresql/v1/clusters/${postgresClusterId}/backups",
  ]);

  const runnerEditor = terraformResourceBlock(
    compute,
    "yandex_compute_instance_iam_binding",
    "runner_editor",
  );
  assert.match(runnerEditor, /instance_id\s*=\s*yandex_compute_instance\.runner\.id/);
  assert.match(runnerEditor, /role\s*=\s*"compute\.editor"/);
  assert.match(runnerEditor, /serviceAccount:\$\{var\.deployment_controller_service_account_id\}/);

  const appViewer = terraformResourceBlock(
    compute,
    "yandex_compute_instance_iam_binding",
    "deployment_controller_app_viewer",
  );
  assert.match(appViewer, /instance_id\s*=\s*yandex_compute_instance\.app\.id/);
  assert.match(appViewer, /role\s*=\s*"compute\.viewer"/);
  assert.match(appViewer, /serviceAccount:\$\{var\.deployment_controller_service_account_id\}/);
  assert.match(appViewer, /serviceAccount:\$\{var\.runner_service_account_id\}/);
  assert.doesNotMatch(
    compute,
    /resource\s+"yandex_compute_instance_iam_binding"\s+"runner_app_viewer"/,
  );
  assert.match(
    compute,
    /removed\s*\{[\s\S]*?from\s*=\s*yandex_compute_instance_iam_binding\.runner_app_viewer[\s\S]*?destroy\s*=\s*false[\s\S]*?\}/,
  );

  const runner = terraformResourceBlock(compute, "yandex_compute_instance", "runner");
  assert.match(runner, /kms_key_id\s*=\s*var\.kms_key_id/);
  const runnerKeyUser = terraformResourceBlock(
    bootstrap,
    "yandex_kms_symmetric_key_iam_member",
    "deployment_controller_runner_key_user",
  );
  assert.match(runnerKeyUser, /symmetric_key_id\s*=\s*var\.kms_key_id/);
  assert.match(runnerKeyUser, /role\s*=\s*"kms\.keys\.user"/);
  assert.match(
    runnerKeyUser,
    /serviceAccount:\$\{module\.iam\.service_account_ids\.deployment_controller\}/,
  );

  for (const [name, role] of [
    ["deployment_controller_alb_viewer", "alb.viewer"],
    ["deployment_controller_postgres_viewer", "managed-postgresql.viewer"],
  ]) {
    const grant = terraformResourceBlock(iam, "yandex_resourcemanager_folder_iam_member", name);
    assert.match(grant, new RegExp(`role\\s*=\\s*"${role.replace(".", "\\.")}"`));
    assert.match(
      grant,
      /serviceAccount:\$\{yandex_iam_service_account\.deployment_controller\.id\}/,
    );
  }
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
  const app = terraformResourceBlock(compute, "yandex_compute_instance", "app");
  const appResources = terraformNestedBlocks(app, "resources");
  assert.equal(appResources.length, 1, "app VM must define one exact resource profile");
  for (const [attribute, value] of [
    ["cores", 2],
    ["memory", 4],
    ["core_fraction", 100],
  ]) {
    assert.match(
      appResources[0],
      new RegExp(`^\\s*${attribute}\\s*=\\s*${value}\\s*$`, "m"),
      "app VM must use the approved 2 vCPU / 4 GiB MVP profile",
    );
  }

  const runner = terraformResourceBlock(compute, "yandex_compute_instance", "runner");
  const runnerResources = terraformNestedBlocks(runner, "resources");
  assert.equal(runnerResources.length, 1, "runner VM must define one exact resource profile");
  for (const [attribute, value] of [
    ["cores", 2],
    ["memory", 4],
    ["core_fraction", 100],
  ]) {
    assert.match(
      runnerResources[0],
      new RegExp(`^\\s*${attribute}\\s*=\\s*${value}\\s*$`, "m"),
      "deployment runner must retain its approved 2 vCPU / 4 GiB profile",
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
    /path:\s*\/usr\/local\/lib\/markiro\/runner-jit[\s\S]*?permissions:\s*"0755"[\s\S]*?markiro-runner-jit[\s\S]*?updateMetadata/,
  );
  assert.doesNotMatch(
    runnerCloudInit,
    /generate-jitconfig|runner_registration_secret_id|GITHUB_RUNNER_ADMIN_TOKEN|payload\.lockbox/,
  );
  assert.match(compute, /service_account_id\s*=\s*var\.runner_service_account_id/);
  assert.match(
    compute,
    /members\s*=\s*\[[\s\S]*?var\.deployment_controller_service_account_id[\s\S]*?var\.runner_service_account_id/,
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
  compute,
  ingress,
  ingressOutputs,
  ingressVariables,
  production,
  productionOutputs,
  productionTfvars,
  productionVariables,
}) {
  const allIngress = [ingress, ingressOutputs, ingressVariables].join("\n");

  for (const [type, expected] of [
    ["yandex_vpc_address", 1],
    ["yandex_cm_certificate", 2],
    ["yandex_dns_recordset", 4],
    ["yandex_alb_backend_group", 1],
    ["yandex_sws_advanced_rate_limiter_profile", 1],
    ["yandex_sws_security_profile", 1],
    ["yandex_alb_http_router", 1],
    ["yandex_alb_virtual_host", 1],
    ["yandex_alb_load_balancer", 1],
  ]) {
    assert.equal(
      terraformDeclarationCount(ingress, "resource", type),
      expected,
      `protected ingress must keep exactly ${expected} ${type} resource(s)`,
    );
  }
  assert.equal(
    terraformDeclarationCount(compute, "resource", "yandex_alb_target_group"),
    1,
    "protected ingress must keep exactly one application target group",
  );

  for (const variables of [ingressVariables, productionVariables]) {
    const adminDomainPattern = /condition\s*=\s*can\(regex\("([^"]+)",\s*var\.domain\)\)/.exec(
      variables,
    )?.[1];
    const kioskDomainPattern =
      /condition\s*=\s*can\(regex\("([^"]+)",\s*var\.kiosk_domain\)\)/.exec(variables)?.[1];
    assert.ok(adminDomainPattern, "domain must retain its lowercase-FQDN validation");
    assert.equal(
      kioskDomainPattern,
      adminDomainPattern,
      "kiosk_domain must use the same lowercase-FQDN validation as domain",
    );
    assert.equal(
      [...variables.matchAll(/var\.kiosk_domain\s*!=\s*var\.domain/g)].length,
      1,
      "kiosk_domain must reject the admin domain",
    );
  }

  const publicAddress = terraformResourceBlock(ingress, "yandex_vpc_address", "markiro");
  assert.match(publicAddress, /external_ipv4_address\s*\{/);
  assert.doesNotMatch(publicAddress, /internal_ipv4_address|ipv6/i);

  const certificate = terraformResourceBlock(ingress, "yandex_cm_certificate", "markiro");
  assert.match(certificate, /name\s*=\s*"markiro-production-tls"/);
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

  const kioskCertificate = terraformResourceBlock(ingress, "yandex_cm_certificate", "kiosk");
  assert.match(kioskCertificate, /domains\s*=\s*\[var\.kiosk_domain\]/);
  assert.match(
    kioskCertificate,
    /managed\s*\{[\s\S]*?challenge_type\s*=\s*"DNS_CNAME"[\s\S]*?challenge_count\s*=\s*1/,
  );
  const kioskCertificateValidation = terraformResourceBlock(
    ingress,
    "yandex_dns_recordset",
    "kiosk_certificate_validation",
  );
  assert.match(kioskCertificateValidation, /count\s*=\s*1/);
  assert.match(
    kioskCertificateValidation,
    /yandex_cm_certificate\.kiosk\.challenges\[count\.index\]/,
  );
  assert.doesNotMatch(kioskCertificateValidation, /for_each/);
  assert.match(
    ingress,
    /data\s+"yandex_cm_certificate"\s+"kiosk_issued"\s*\{[\s\S]*?certificate_id\s*=\s*yandex_cm_certificate\.kiosk\.id[\s\S]*?wait_validation\s*=\s*true[\s\S]*?depends_on\s*=\s*\[yandex_dns_recordset\.kiosk_certificate_validation\]/,
  );
  assert.equal(
    terraformDeclarationCount(ingress, "data", "yandex_cm_certificate"),
    2,
    "each authority must have one issued-certificate data source",
  );

  const backendGroup = terraformResourceBlock(ingress, "yandex_alb_backend_group", "app");
  assert.match(backendGroup, /target_group_ids\s*=\s*\[var\.app_target_group_id\]/);
  assert.match(backendGroup, /port\s*=\s*8080/);
  assert.match(backendGroup, /path\s*=\s*"\/health\/ready"/);
  assert.match(backendGroup, /host\s*=\s*var\.domain/);
  assert.doesNotMatch(backendGroup, /path\s*=\s*"\/health"|\/api(?:\W|$)|port\s*=\s*443/);
  assert.equal(
    terraformNestedBlocks(backendGroup, "healthcheck").length,
    1,
    "the shared backend must keep exactly one readiness health check",
  );

  const router = terraformResourceBlock(ingress, "yandex_alb_http_router", "markiro");
  assert.match(router, /name\s*=\s*"markiro-production"/);

  const virtualHost = terraformResourceBlock(ingress, "yandex_alb_virtual_host", "markiro");
  const authorities = /authority\s*=\s*\[([\s\S]*?)\]/.exec(virtualHost)?.[1];
  assert.ok(authorities, "the shared virtual host must declare explicit authorities");
  assert.deepEqual(
    terraformListItems(authorities),
    ["var.domain", "var.kiosk_domain"],
    "the shared virtual host must serve exactly the admin and kiosk authorities",
  );
  assert.match(virtualHost, /backend_group_id\s*=\s*yandex_alb_backend_group\.app\.id/);
  assert.match(
    virtualHost,
    /route_options\s*\{[\s\S]*?security_profile_id\s*=\s*yandex_sws_security_profile\.markiro\.id/,
  );
  assert.doesNotMatch(virtualHost, /disable_security_profile\s*=\s*true/);

  const loadBalancer = terraformResourceBlock(ingress, "yandex_alb_load_balancer", "markiro");
  assert.match(loadBalancer, /ports\s*=\s*\[80\][\s\S]*?http_to_https\s*=\s*true/);
  const httpsListener = terraformNestedBlocks(loadBalancer, "listener").find((listener) =>
    /name\s*=\s*"https"/.test(listener),
  );
  assert.ok(httpsListener, "the shared ALB must keep its HTTPS listener");
  const defaultHandlers = terraformNestedBlocks(httpsListener, "default_handler");
  assert.equal(defaultHandlers.length, 1, "the HTTPS listener must keep one default handler");
  const defaultCertificateIds = /certificate_ids\s*=\s*\[([\s\S]*?)\]/.exec(
    defaultHandlers[0],
  )?.[1];
  assert.ok(defaultCertificateIds, "the HTTPS default handler must declare its certificate ID");
  assert.deepEqual(
    terraformListItems(defaultCertificateIds),
    ["data.yandex_cm_certificate.issued.id"],
    "the HTTPS default handler must present only the admin certificate",
  );
  assert.match(defaultHandlers[0], /http_router_id\s*=\s*yandex_alb_http_router\.markiro\.id/);
  const kioskSniHandlers = terraformNestedBlocks(httpsListener, "sni_handler");
  assert.equal(
    kioskSniHandlers.length,
    1,
    "the HTTPS listener must keep exactly one kiosk SNI handler",
  );
  const kioskSniHandler = kioskSniHandlers[0];
  assert.match(kioskSniHandler, /name\s*=\s*"kiosk"/);
  const kioskServerNames = /server_names\s*=\s*\[([\s\S]*?)\]/.exec(kioskSniHandler)?.[1];
  assert.ok(kioskServerNames, "the kiosk SNI handler must declare its server name");
  assert.deepEqual(
    terraformListItems(kioskServerNames),
    ["var.kiosk_domain"],
    "the kiosk SNI handler must match only the kiosk domain",
  );
  const kioskTlsHandlers = terraformNestedBlocks(kioskSniHandler, "handler");
  assert.equal(kioskTlsHandlers.length, 1, "the kiosk SNI handler must keep one TLS handler");
  const kioskCertificateIds = /certificate_ids\s*=\s*\[([\s\S]*?)\]/.exec(kioskTlsHandlers[0])?.[1];
  assert.ok(kioskCertificateIds, "the kiosk TLS handler must declare its certificate ID");
  assert.deepEqual(
    terraformListItems(kioskCertificateIds),
    ["data.yandex_cm_certificate.kiosk_issued.id"],
    "the kiosk SNI handler must present only the kiosk certificate",
  );
  assert.match(kioskTlsHandlers[0], /http_router_id\s*=\s*yandex_alb_http_router\.markiro\.id/);
  assert.equal(
    terraformNestedBlocks(loadBalancer, "listener").length,
    2,
    "the shared ALB must keep exactly the HTTP redirect and HTTPS listeners",
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
  const rateLimitRules = terraformNestedBlocks(rateLimiter, "advanced_rate_limiter_rule");
  assert.equal(rateLimitRules.length, 2, "ARL must define exactly global and per-IP rules");
  const globalRule = rateLimitRules.find((rule) => /name\s*=\s*"global-request-rate"/.test(rule));
  assert.ok(globalRule, "global ARL rule is required");
  assert.match(
    globalRule,
    /static_quota\s*\{[\s\S]*?limit\s*=\s*var\.global_rate_limit/,
    "global ARL rule must use the global static quota",
  );
  assert.doesNotMatch(globalRule, /dynamic_quota|characteristic/);
  const perIpRule = rateLimitRules.find((rule) => /name\s*=\s*"per-ip-request-rate"/.test(rule));
  assert.ok(perIpRule, "per-IP ARL rule is required");
  assert.match(
    perIpRule,
    /dynamic_quota\s*\{[\s\S]*?limit\s*=\s*var\.per_ip_rate_limit[\s\S]*?simple_characteristic\s*\{[\s\S]*?type\s*=\s*"IP"/,
    "per-IP ARL rule must use the IP-scoped dynamic quota",
  );
  assert.doesNotMatch(perIpRule, /static_quota/);

  const securityProfile = terraformResourceBlock(ingress, "yandex_sws_security_profile", "markiro");
  assert.match(securityProfile, /default_action\s*=\s*"ALLOW"/);
  assert.match(
    securityProfile,
    /advanced_rate_limiter_profile_id\s*=\s*yandex_sws_advanced_rate_limiter_profile\.markiro\.id/,
  );
  const logOptions = terraformNestedBlocks(securityProfile, "log_options");
  assert.equal(logOptions.length, 1, "SWS must define one logging boundary");
  assert.match(logOptions[0], /enable\s*=\s*true/, "SWS logging must stay enabled");
  assert.match(logOptions[0], /log_group_id\s*=\s*var\.security_log_group_id/);
  assert.doesNotMatch(
    allIngress,
    /resource\s+"yandex_sws_waf_profile"/,
    "the one-customer MVP must not provision a WAF profile",
  );
  const rules = terraformNestedBlocks(securityProfile, "security_rule");
  assert.equal(rules.length, 0, "the MVP SWS profile must delegate only to ARL");
  assert.doesNotMatch(securityProfile, /\bwaf\s*\{/);
  assert.doesNotMatch(securityProfile, /smart_protection\s*\{/);
  assert.doesNotMatch(securityProfile, /analyze_request_body|size_limit/i);

  for (const [name, hostname] of [
    ["application", "var.domain"],
    ["kiosk_application", "var.kiosk_domain"],
  ]) {
    const publicDns = terraformResourceBlock(ingress, "yandex_dns_recordset", name);
    assert.match(publicDns, /count\s*=\s*var\.public_dns_enabled\s*\?\s*1\s*:\s*0/);
    assert.match(publicDns, new RegExp(`name\\s*=\\s*${hostname.replace(".", "\\.")}`));
    assert.match(publicDns, /type\s*=\s*"A"/);
    assert.match(
      publicDns,
      /data\s*=\s*\[yandex_vpc_address\.markiro\.external_ipv4_address\.0\.address\]/,
    );
    assert.doesNotMatch(publicDns, /AAAA/);
  }
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
    "kiosk_certificate_id",
    "kiosk_certificate_status",
    "admin_domain",
    "kiosk_domain",
    "load_balancer_id",
    "load_balancer_address",
    "backend_group_id",
    "security_profile_id",
    "rate_limiter_profile_id",
    "approved_a_records",
  ]) {
    assert.match(ingressOutputs, new RegExp(`output\\s+"${output}"\\s*\\{`));
    assert.match(productionOutputs, new RegExp(`output\\s+"${output}"\\s*\\{`));
  }
  for (const outputs of [ingressOutputs, productionOutputs]) {
    assert.doesNotMatch(outputs, /output\s+"waf_profile_id"\s*\{/);
  }

  assert.match(
    terraformOutputBlock(ingressOutputs, "approved_a_records"),
    /value\s*=\s*\[yandex_vpc_address\.markiro\.external_ipv4_address\.0\.address\]/,
  );
  assert.match(terraformOutputBlock(ingressOutputs, "admin_domain"), /value\s*=\s*var\.domain/);
  assert.match(
    terraformOutputBlock(ingressOutputs, "kiosk_domain"),
    /value\s*=\s*var\.kiosk_domain/,
  );
  assert.match(
    terraformOutputBlock(ingressOutputs, "certificate_id"),
    /value\s*=\s*data\.yandex_cm_certificate\.issued\.id/,
  );
  assert.match(
    terraformOutputBlock(ingressOutputs, "certificate_status"),
    /value\s*=\s*data\.yandex_cm_certificate\.issued\.status/,
  );
  assert.match(
    terraformOutputBlock(ingressOutputs, "kiosk_certificate_id"),
    /value\s*=\s*data\.yandex_cm_certificate\.kiosk_issued\.id/,
  );
  assert.match(
    terraformOutputBlock(ingressOutputs, "kiosk_certificate_status"),
    /value\s*=\s*data\.yandex_cm_certificate\.kiosk_issued\.status/,
  );
  for (const output of [
    "certificate_id",
    "certificate_status",
    "kiosk_certificate_id",
    "kiosk_certificate_status",
    "admin_domain",
    "kiosk_domain",
  ]) {
    assert.doesNotMatch(terraformOutputBlock(ingressOutputs, output), /sensitive\s*=\s*true/);
  }

  assert.match(production, /module\s+"ingress"\s*\{/);
  for (const variable of [
    "domain",
    "kiosk_domain",
    "dns_zone_id",
    "public_dns_enabled",
    "global_rate_limit",
    "per_ip_rate_limit",
  ]) {
    assert.match(productionVariables, new RegExp(`variable\\s+"${variable}"\\s*\\{`));
  }
  assert.equal(
    [...production.matchAll(/^\s*kiosk_domain\s*=\s*var\.kiosk_domain\s*$/gm)].length,
    1,
    "production must wire kiosk_domain only to the existing ingress module",
  );
  assert.match(productionTfvars, /^domain\s*=\s*"admin\.markiro\.example\.ru"$/m);
  assert.match(productionTfvars, /^kiosk_domain\s*=\s*"kiosk\.markiro\.example\.ru"$/m);
  assert.match(productionTfvars, /^public_dns_enabled\s*=\s*false$/m);
  for (const [name, value] of [
    ["certificate_id", "module.ingress.certificate_id"],
    ["certificate_status", "module.ingress.certificate_status"],
    ["kiosk_certificate_id", "module.ingress.kiosk_certificate_id"],
    ["kiosk_certificate_status", "module.ingress.kiosk_certificate_status"],
    ["admin_domain", "module.ingress.admin_domain"],
    ["kiosk_domain", "module.ingress.kiosk_domain"],
  ]) {
    assert.match(
      terraformOutputBlock(productionOutputs, name),
      new RegExp(`value\\s*=\\s*${value.replaceAll(".", "\\.")}`),
    );
  }
  assert.doesNotMatch(allIngress, /(?:api|backend)[_-]?(?:url|address).*443/i);
}

async function protectedIngressSources() {
  const [
    compute,
    ingress,
    ingressOutputs,
    ingressVariables,
    production,
    productionOutputs,
    productionTfvars,
    productionVariables,
  ] = await Promise.all([
    readRepositoryFile("infra/yandex/modules/compute/main.tf"),
    readRepositoryFile("infra/yandex/modules/ingress/main.tf"),
    readRepositoryFile("infra/yandex/modules/ingress/outputs.tf"),
    readRepositoryFile("infra/yandex/modules/ingress/variables.tf"),
    readRepositoryFile("infra/yandex/production/main.tf"),
    readRepositoryFile("infra/yandex/production/outputs.tf"),
    readRepositoryFile("infra/yandex/production/terraform.tfvars.example"),
    readRepositoryFile("infra/yandex/production/variables.tf"),
  ]);

  return {
    compute,
    ingress,
    ingressOutputs,
    ingressVariables,
    production,
    productionOutputs,
    productionTfvars,
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
  assert.match(
    cluster,
    /resource_preset_id\s*=\s*"s3-c2-m8"/,
    "PostgreSQL must use the approved 2 vCPU / 8 GiB MVP preset",
  );
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
  const bucketIamBindings = [
    ...storage.matchAll(/resource\s+"yandex_storage_bucket_iam_binding"\s+"([^"]+)"/g),
  ]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(bucketIamBindings, ["audit_uploader"]);
  const auditUploader = terraformResourceBlock(
    storage,
    "yandex_storage_bucket_iam_binding",
    "audit_uploader",
  );
  assert.match(auditUploader, /bucket\s*=\s*yandex_storage_bucket\.audit\.bucket/);
  assert.match(auditUploader, /role\s*=\s*"storage\.uploader"/);
  assert.match(
    auditUploader,
    /members\s*=\s*\["serviceAccount:\$\{var\.audit_service_account_id\}"\]/,
  );
  assert.match(
    terraformOutputBlock(storageOutputs, "audit_bucket_name"),
    /depends_on\s*=\s*\[yandex_storage_bucket_iam_binding\.audit_uploader\]/,
    "the audit destination must wait for its required uploader grant",
  );

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
      {
        Sid: "AllowTerraformMediaManagement",
        Effect: "Allow",
        Principal: { CanonicalUser: "var.terraform_service_account_id" },
        Action: ["s3:*"],
        Resource: [
          "arn:aws:s3:::${yandex_storage_bucket.media.bucket}",
          "arn:aws:s3:::${yandex_storage_bucket.media.bucket}/*",
        ],
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
      {
        Sid: "AllowTerraformAuditManagement",
        Effect: "Allow",
        Principal: { CanonicalUser: "var.terraform_service_account_id" },
        Action: ["s3:*"],
        Resource: [
          "arn:aws:s3:::${yandex_storage_bucket.audit.bucket}",
          "arn:aws:s3:::${yandex_storage_bucket.audit.bucket}/*",
        ],
      },
    ],
  });

  assert.doesNotMatch(storage, /yandex_kms_symmetric_key_iam_member/);

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
  "readiness_required_unavailable",
  "deployment_failure",
  "runner_overrun",
];
const certificateRiskQuery =
  'series_min("certificate.days_until_expiration"{folderId="${var.folder_id}", service="certificate-manager", certificate="${var.certificate_ids[0]}|${var.certificate_ids[1]}"})';

function assertProtectedObservability({
  bootstrap,
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

  for (const [source, groupName] of [
    [production, "application"],
    [observability, "security"],
    [bootstrap, "audit"],
  ]) {
    const group = terraformResourceBlock(source, "yandex_logging_group", groupName);
    assert.match(group, /retention_period\s*=\s*"336h"/);
  }
  assert.equal(
    [bootstrap, production, observability].flatMap((source) => [
      ...source.matchAll(/resource\s+"yandex_logging_group"\s+"([^"]+)"/g),
    ]).length,
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
  assert.match(
    trails[0],
    /logging_destination\s*\{[\s\S]*?log_group_id\s*=\s*var\.audit_log_group_id/,
  );
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
  for (const event of ["ObjectCreate", "ObjectUpdate", "ObjectDelete", "ObjectGetByPresignURL"]) {
    assert.match(observability, new RegExp(`yandex\\.cloud\\.audit\\.storage\\.${event}`));
  }
  assert.doesNotMatch(observability, /yandex\.cloud\.audit\.storage\.ObjectGet"/);

  const loadBalancer = terraformResourceBlock(ingress, "yandex_alb_load_balancer", "markiro");
  const securityProfile = terraformResourceBlock(ingress, "yandex_sws_security_profile", "markiro");
  assert.match(loadBalancer, /log_group_id\s*=\s*var\.application_log_group_id/);
  assert.match(securityProfile, /log_group_id\s*=\s*var\.security_log_group_id/);

  for (const variables of [observabilityVariables, productionVariables]) {
    assert.match(
      variables,
      /variable\s+"notification_channel_id"\s*\{[\s\S]*?var\.observability_phase\s*==\s*"first"[\s\S]*?length\(trimspace\(var\.notification_channel_id\)\)\s*>\s*0/,
    );
    assert.match(variables, /variable\s+"alert_ids"\s*\{/);
    assert.match(variables, /toset\(keys\(var\.alert_ids\)\)\s*==\s*toset\(\[/);
    assert.match(
      variables,
      /alltrue\(\[for alert_id in values\(var\.alert_ids\) : length\(trimspace\(alert_id\)\) > 0\]\)/,
    );
    assert.match(variables, /length\(toset\(values\(var\.alert_ids\)\)\)\s*==\s*16/);
  }

  assert.equal(requiredObservabilityAlerts.length, 16);
  assert.equal(
    [...observability.matchAll(/^\s+category\s*=\s*"[^"]+"$/gm)].length,
    16,
    "observability must keep exactly 16 alert categories",
  );
  assert.doesNotMatch(observability, /certificate_risk_kiosk/);
  assert.match(observabilityVariables, /variable\s+"certificate_ids"\s*\{/);
  assert.match(observabilityVariables, /type\s*=\s*list\(string\)/);
  assert.match(observabilityVariables, /length\(var\.certificate_ids\)\s*==\s*2/);
  assert.match(
    observabilityVariables,
    /alltrue\(\[for certificate_id in var\.certificate_ids : length\(trimspace\(certificate_id\)\) > 0\]\)/,
  );
  assert.match(observabilityVariables, /length\(toset\(var\.certificate_ids\)\)\s*==\s*2/);
  assert.doesNotMatch(observabilityVariables, /variable\s+"certificate_id"\s*\{/);

  const encodedCertificateQuery = observability.match(
    /^\s*certificate_risk_query\s*=\s*"(.+)"$/m,
  )?.[1];
  assert.ok(encodedCertificateQuery, "certificate risk query must be defined once as a local");
  assert.equal(encodedCertificateQuery.replaceAll('\\"', '"'), certificateRiskQuery);

  for (const category of requiredObservabilityAlerts) {
    const spec = terraformObjectEntry(observability, category);
    assert.match(spec, new RegExp(`category\\s*=\\s*"${category}"`));
    assert.match(spec, /metric\s*=\s*"[^\n]+"/);
    const encodedQuery = spec.match(/query\s*=\s*"(.+)"$/m)?.[1];
    const query =
      category === "certificate_risk" ? certificateRiskQuery : encodedQuery?.replaceAll('\\"', '"');
    if (category === "certificate_risk") {
      assert.match(spec, /query\s*=\s*local\.certificate_risk_query/);
    } else {
      assert.ok(encodedQuery, `${category} must expose a parseable Monitoring query`);
    }
    assert.ok(query, `${category} must expose a parseable Monitoring query`);
    const selectors = [...query.matchAll(/(?:"[^"]+"|[A-Za-z][A-Za-z0-9._-]*)\{/g)];
    assert.ok(selectors.length > 0, `${category} must contain a metric selector`);
    assert.doesNotMatch(
      query,
      /(?<!")\b[A-Za-z][A-Za-z0-9._-]*\{/,
      `${category} must quote every metric selector name`,
    );
    assert.equal(
      [...query.matchAll(/folderId="\$\{var\.folder_id\}"/g)].length,
      selectors.length,
      `${category} must scope every metric selector to the production folder`,
    );
    assert.match(spec, /comparison\s*=\s*"(?:GREATER_THAN|LESS_THAN)"/);
    assert.match(spec, /warning_threshold\s*=\s*[0-9.]+/);
    assert.match(spec, /alarm_threshold\s*=\s*[0-9.]+/);
    assert.match(spec, /evaluation_window\s*=\s*"[^"]+"/);
    assert.match(spec, /notification_channel_id\s*=\s*var\.notification_channel_id/);
    assert.match(observabilityVariables, new RegExp(`"${category}"`));
    assert.match(productionVariables, new RegExp(`"${category}"`));
  }

  for (const category of ["alb_healthy_backend", "postgres_availability"]) {
    const spec = terraformObjectEntry(observability, category);
    assert.match(spec, /comparison\s*=\s*"LESS_THAN"/);
    assert.match(spec, /warning_threshold\s*=\s*1(?:\.0+)?\b/);
    assert.match(spec, /alarm_threshold\s*=\s*0\.5\b/);
  }
  for (const category of ["readiness_required_unavailable", "deployment_failure"]) {
    const spec = terraformObjectEntry(observability, category);
    assert.match(spec, /comparison\s*=\s*"GREATER_THAN"/);
    assert.match(spec, /warning_threshold\s*=\s*0(?:\.0+)?\b/);
    assert.match(spec, /alarm_threshold\s*=\s*0\.5\b/);
  }

  const certificateRisk = terraformObjectEntry(observability, "certificate_risk");
  assert.match(certificateRisk, /comparison\s*=\s*"LESS_THAN"/);
  assert.match(certificateRisk, /warning_threshold\s*=\s*30\b/);
  assert.match(certificateRisk, /alarm_threshold\s*=\s*14\b/);
  assert.match(certificateRisk, /evaluation_window\s*=\s*"1h"/);
  assert.match(certificateRisk, /notification_channel_id\s*=\s*var\.notification_channel_id/);

  const dashboard = terraformResourceBlock(
    observability,
    "yandex_monitoring_dashboard",
    "production",
  );
  assert.match(dashboard, /for_each\s*=\s*local\.alert_specs/);
  assert.match(dashboard, /chart_id\s*=\s*replace\(widgets\.key,\s*"_",\s*"-"\)/);
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
  assert.match(
    production,
    /certificate_ids\s*=\s*\[\s*module\.ingress\.certificate_id,\s*module\.ingress\.kiosk_certificate_id,?\s*\]/,
  );
  assert.doesNotMatch(production, /^\s*certificate_id\s*=\s*module\.ingress\.certificate_id$/m);
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
    /provider 0\.215\.0 does not expose a Monitoring alert resource[\s\S]*?observability_phase=first[\s\S]*?alert_ids/i,
  );
  assert.match(
    readme,
    /state_bucket_name[\s\S]*?bootstrap output[\s\S]*?does\s+not\s+create\s+or\s+read/i,
  );
}

async function observabilitySources() {
  const [
    bootstrap,
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
    readRepositoryFile("infra/yandex/bootstrap/main.tf"),
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
    bootstrap,
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

function publicDnsApplyFilter(applyStep) {
  const startMarker = '--arg kiosk_domain "$TF_VAR_kiosk_domain" \'';
  const start = applyStep.run.indexOf(startMarker);
  assert.ok(start >= 0, "public DNS extractor must bind the protected kiosk domain");
  const filterStart = start + startMarker.length;
  const end = applyStep.run.indexOf(
    '\' "$terraform_apply_stream" > "$dns_values_path"',
    filterStart,
  );
  assert.ok(end > filterStart, "public DNS extractor must consume the authenticated apply stream");
  return applyStep.run.slice(filterStart, end).trim();
}

function runPublicDnsApplyFilter(filter, records, approvedType = ["tuple", ["string"]]) {
  const adminDomain = "admin.markiro.example";
  const kioskDomain = "kiosk.markiro.example";
  const events = records.map((record) =>
    record === "outputs"
      ? {
          type: "outputs",
          outputs: {
            admin_domain: { sensitive: false, type: "string", value: adminDomain },
            kiosk_domain: { sensitive: false, type: "string", value: kioskDomain },
            approved_a_records: {
              sensitive: false,
              type: approvedType,
              value: ["203.0.113.10"],
            },
          },
        }
      : record,
  );
  return JSON.parse(
    execFileSync(
      "jq",
      [
        "-s",
        "-e",
        "--arg",
        "admin_domain",
        adminDomain,
        "--arg",
        "kiosk_domain",
        kioskDomain,
        filter,
      ],
      { encoding: "utf8", input: `${events.map(JSON.stringify).join("\n")}\n` },
    ),
  );
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
  assert.deepEqual(dispatchInputs.observability_phase, {
    description: "First provisioning emits alert specs; protected binds reviewed console alert IDs",
    required: true,
    type: "choice",
    default: "protected",
    options: ["first", "protected"],
  });
  assert.deepEqual(dispatchInputs.postgres_provisioning_phase, {
    description: "Create only the required first-provisioning PostgreSQL boundary",
    required: true,
    type: "choice",
    default: "none",
    options: ["none", "cluster", "database"],
  });
  assert.deepEqual(dispatchInputs.postgres_owner_change_reference, {
    description: "Protected non-secret change record reference for the database-owner boundary",
    required: true,
    type: "string",
    default: "none",
  });

  const {
    apply,
    dns_approval: dnsApproval,
    plan,
    postgres_owner_approval: postgresOwnerApproval,
    validate,
  } = workflow.jobs;
  assert.deepEqual(validate.permissions, { contents: "read" });
  assert.deepEqual(plan.permissions, { contents: "read", "id-token": "write" });
  assert.deepEqual(apply.permissions, { contents: "read", "id-token": "write" });
  assert.equal(plan.environment, "production-infrastructure");
  assert.equal(apply.environment, "production-infrastructure");
  assert.equal(plan.env.TF_VAR_domain, "${{ vars.MARKIRO_DOMAIN }}");
  assert.equal(plan.env.TF_VAR_kiosk_domain, "${{ vars.MARKIRO_KIOSK_DOMAIN }}");
  assert.equal(apply.env.TF_VAR_domain, "${{ vars.MARKIRO_DOMAIN }}");
  assert.equal(apply.env.TF_VAR_kiosk_domain, "${{ vars.MARKIRO_KIOSK_DOMAIN }}");
  assert.equal(dnsApproval.environment, "production-public-dns");
  assert.equal(postgresOwnerApproval.environment, "production-postgres-owner");
  assert.deepEqual(postgresOwnerApproval.permissions, { contents: "read" });
  assert.match(postgresOwnerApproval.if, /postgres_provisioning_phase\s*==\s*'database'/);
  assert.match(postgresOwnerApproval.outputs["run-id"], /steps\.attest\.outputs\.run_id/);
  assert.match(postgresOwnerApproval.outputs["run-attempt"], /steps\.attest\.outputs\.run_attempt/);
  assert.match(
    postgresOwnerApproval.outputs["change-reference"],
    /steps\.attest\.outputs\.change_reference/,
  );
  assert.match(dnsApproval.if, /enable_public_dns\s*==\s*true/);
  assert.match(plan.if, /needs\.dns_approval\.result/);
  assert.match(plan.if, /needs\.postgres_owner_approval\.result/);
  assert.deepEqual(plan.needs, ["dns_approval", "postgres_owner_approval"]);
  assert.match(
    apply.if,
    /always\(\)\s*&&\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*needs\.plan\.result\s*==\s*'success'/,
  );
  assert.deepEqual(apply.needs, ["plan"]);
  const postgresOwnerApprovalCommands = workflowCommands(postgresOwnerApproval);
  assert.match(
    postgresOwnerApprovalCommands,
    /POSTGRES_OWNER_CHANGE_REFERENCE.*\^\[a-z\]\[a-z0-9_\]/s,
  );
  assert.match(postgresOwnerApprovalCommands, /GITHUB_RUN_ID/);
  assert.match(postgresOwnerApprovalCommands, /GITHUB_RUN_ATTEMPT/);
  assert.match(postgresOwnerApprovalCommands, /GITHUB_OUTPUT/);

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
    /node infra\/yandex\/scripts\/verify-service-account-provenance\.mjs fetch > "\$identity_path"/,
  );
  assert.match(planCommands, /service_account_provenance_sha256/);
  assert.match(planCommands, /sha256sum "\$identity_path"/);
  assert.match(planCommands, /chmod 600 "\$identity_path"/);
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
  assert.match(planCommands, /POSTGRES_PROVISIONING_PHASE/);
  assert.match(planCommands, /POSTGRES_OWNER_CHANGE_REFERENCE/);
  assert.match(planCommands, /POSTGRES_OWNER_APPROVAL_RUN_ID/);
  assert.match(planCommands, /POSTGRES_OWNER_APPROVAL_RUN_ATTEMPT/);
  assert.match(planCommands, /POSTGRES_OWNER_APPROVAL_RESULT/);
  assert.match(planCommands, /\[\[ "\$POSTGRES_OWNER_APPROVAL_RUN_ID" == "\$GITHUB_RUN_ID" \]\]/);
  assert.match(
    planCommands,
    /\[\[ "\$POSTGRES_OWNER_APPROVAL_RUN_ATTEMPT" == "\$GITHUB_RUN_ATTEMPT" \]\]/,
  );
  assert.match(planCommands, /\^\[a-z\]\[a-z0-9_\]/);
  assert.match(planCommands, /module\.postgres\.yandex_mdb_postgresql_cluster\.production/);
  assert.match(planCommands, /module\.postgres\.yandex_mdb_postgresql_database\.application/);
  assert.match(planCommands, /postgres_owner_change_reference/);
  assert.match(planCommands, /github_run_attempt/);
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
      'rm -rf -- "${RUNNER_TEMP:?}/yandex-alert-specs"',
    ],
  );
  assert.deepEqual(
    finalApplyCleanupStep.run
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("rm -f --")),
    [
      'rm -f -- "${RUNNER_TEMP:?}/public-dns-values.json"',
      'rm -f -- "${RUNNER_TEMP:?}/public-dns-apply.json"',
    ],
    "public DNS values and receipt cleanup must remain exact and unconditional",
  );
  assert.doesNotMatch(finalApplyCleanupStep.run, /\bunset\b/);
  assert.match(applyStep.run, /unset [^\n]*TF_DATA_DIR/);
  assert.match(applyStep.run, /rm -rf -- "\$\{RUNNER_TEMP:\?\}\/yandex-production-terraform-data"/);
  assert.match(applyStep.run, /rm -rf -- "\$\{RUNNER_TEMP:\?\}\/yandex-infrastructure-plan"/);

  const evidencePublicDnsAssignment = applyStep.run
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("evidence_public_dns="));
  assert.ok(evidencePublicDnsAssignment);
  assert.equal(
    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
umask 077
evidence_path="$(mktemp)"
trap 'rm -f "$evidence_path"' EXIT
printf '%s\n' '{"public_dns_enabled":false}' > "$evidence_path"
${evidencePublicDnsAssignment}
printf '%s\\n' "$evidence_public_dns"`,
      ],
      { encoding: "utf8" },
    ),
    "false\n",
    "the apply evidence guard must accept an explicitly disabled public DNS cutover",
  );

  const applyObservabilityCase = applyStep.run.match(
    /case "\$OBSERVABILITY_PHASE" in[\s\S]*?^esac$/m,
  )?.[0];
  assert.ok(applyObservabilityCase);
  execFileSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
OBSERVABILITY_PHASE=first
expected_public_dns=false
TF_VAR_notification_channel_id=
TF_VAR_alert_ids=
${applyObservabilityCase}
[[ -z "\${TF_VAR_notification_channel_id+x}" ]]
[[ -z "\${TF_VAR_alert_ids+x}" ]]`,
    ],
    { stdio: "pipe" },
  );

  const applyCommands = workflowCommands(apply);
  for (const commands of [planCommands, applyCommands]) {
    assert.match(
      commands,
      /if ! github_oidc_token="\$\(curl[\s\S]*?\|\s+jq -er '\.value \| select\(type == "string" and length > 0\)'\)"; then/,
    );
    assert.match(
      commands,
      /if ! iam_token="\$\(curl[\s\S]*?\|\s+jq -er '\.access_token \| select\(type == "string" and length > 0\)'\)"; then/,
    );
    for (const diagnostic of [
      "GitHub main ref authentication failed",
      "GitHub OIDC token request failed",
      "Yandex workload identity token exchange failed",
    ]) {
      assert.equal(
        (commands.match(new RegExp(diagnostic, "g")) ?? []).length,
        1,
        `${diagnostic} must identify its exact authentication boundary`,
      );
    }
    assert.doesNotMatch(
      commands,
      /::error::[^\n]*\$(?:(?:github_oidc_response|github_oidc_token|iam_response|iam_token)\b|\{(?:github_oidc_response|github_oidc_token|iam_response|iam_token)\})/,
    );
  }
  assert.match(applyCommands, /git rev-parse HEAD/);
  assert.match(applyCommands, /\[\[ "\$target_sha" == "\$dispatch_sha" \]\]/);
  assert.match(applyCommands, /artifact_sha256/);
  assert.match(applyCommands, /sha256sum/);
  assert.match(applyCommands, /trap cleanup EXIT/);
  assert.match(applyCommands, /unset [^\n]*YC_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY/);
  assert.match(applyCommands, /terraform -chdir=infra\/yandex\/production apply/);
  assert.match(applyCommands, /saved\.tfplan/);
  assert.match(applyCommands, /POSTGRES_PROVISIONING_PHASE/);
  assert.match(applyCommands, /POSTGRES_OWNER_CHANGE_REFERENCE/);
  assert.match(applyCommands, /evidence_postgres_provisioning_phase/);
  assert.match(applyCommands, /evidence_postgres_owner_change_reference/);
  assert.match(applyCommands, /evidence_github_run_id/);
  assert.match(applyCommands, /evidence_github_run_attempt/);
  assert.match(applyCommands, /evidence_postgres_owner_approval_result/);
  assert.match(applyCommands, /evidence_service_account_provenance_sha256/);
  assert.match(
    applyCommands,
    /\[\[ "\$\(sha256sum "\$identity_path" \| cut -d' ' -f1\)" == "\$evidence_service_account_provenance_sha256" \]\]/,
  );
  assert.match(
    applyCommands,
    /if \[\[ "\$OBSERVABILITY_PHASE" == first && "\$POSTGRES_PROVISIONING_PHASE" == none \]\]; then/,
  );
  assert.match(
    applyCommands,
    /node infra\/yandex\/scripts\/verify-service-account-provenance\.mjs validate < "\$identity_path" > \/dev\/null/,
  );
  assert.match(
    applyCommands,
    /node infra\/yandex\/scripts\/verify-service-account-provenance\.mjs fetch > "\$fresh_identity_path"/,
  );
  assert.match(applyCommands, /cmp --silent "\$identity_path" "\$fresh_identity_path"/);
  assert.ok(
    applyCommands.indexOf("verify-service-account-provenance.mjs fetch") <
      applyCommands.indexOf("terraform -chdir=infra/yandex/production apply"),
    "fresh IAM provenance must be checked before saved-plan apply",
  );
  assert.match(
    applyCommands,
    /terraform -chdir=infra\/yandex\/production apply -json -input=false "\$plan_path" > "\$terraform_apply_stream" 2> "\$terraform_apply_stderr"/,
  );
  assert.match(
    applyCommands,
    /node infra\/yandex\/scripts\/extract-alert-specs\.mjs diagnose < "\$terraform_apply_stream"/,
  );
  assert.match(
    applyCommands,
    /node infra\/yandex\/scripts\/extract-alert-specs\.mjs extract < "\$terraform_apply_stream" > "\$alert_artifact"/,
  );
  assert.match(applyCommands, /rm -f "\$terraform_apply_stream" "\$terraform_apply_stderr"/);
  assert.doesNotMatch(applyCommands, /cat "\$terraform_apply_(?:stream|stderr)"/);
  assert.doesNotMatch(applyCommands, /terraform[^\n]*apply[^\n]*\$plan_path"\s*$/m);

  const publicDnsFilter = publicDnsApplyFilter(applyStep);
  assert.deepEqual(runPublicDnsApplyFilter(publicDnsFilter, ["outputs"]), {
    adminDomain: "admin.markiro.example",
    answers: {
      "admin.markiro.example": ["203.0.113.10"],
      "kiosk.markiro.example": ["203.0.113.10"],
    },
    kioskDomain: "kiosk.markiro.example",
  });
  assert.throws(
    () => runPublicDnsApplyFilter(publicDnsFilter, ["outputs", "outputs"]),
    "public DNS evidence must contain exactly one Terraform outputs event",
  );
  assert.throws(
    () => runPublicDnsApplyFilter(publicDnsFilter, ["outputs"], "string"),
    "approved A records must have the exact Terraform tuple-of-string type",
  );
  assert.throws(() => {
    const event = {
      type: "outputs",
      outputs: {
        admin_domain: {
          sensitive: false,
          type: "string",
          value: "admin.markiro.example",
        },
        kiosk_domain: {
          sensitive: false,
          type: "string",
          value: "kiosk.markiro.example",
        },
        approved_a_records: {
          sensitive: false,
          type: ["tuple", ["string"]],
          value: ["999.999.999.999"],
        },
      },
    };
    execFileSync(
      "jq",
      [
        "-s",
        "-e",
        "--arg",
        "admin_domain",
        "admin.markiro.example",
        "--arg",
        "kiosk_domain",
        "kiosk.markiro.example",
        publicDnsFilter,
      ],
      { encoding: "utf8", input: `${JSON.stringify(event)}\n` },
    );
  }, "public DNS evidence must reject IPv4 octets outside 0..255");

  const alertUploadStep = apply.steps.find(
    (step) => step.name === "Upload exact first-phase alert specifications",
  );
  assert.ok(alertUploadStep);
  assert.equal(
    alertUploadStep.if,
    "inputs.observability_phase == 'first' && inputs.postgres_provisioning_phase == 'none'",
  );
  assert.equal(alertUploadStep.with.path, "${{ runner.temp }}/yandex-alert-specs/alert-specs.json");
  assert.equal(alertUploadStep.with["if-no-files-found"], "error");

  const dnsApplyReceiptStep = apply.steps.find(
    (step) => step.name === "Record exact public DNS apply evidence",
  );
  assert.ok(dnsApplyReceiptStep);
  assert.equal(dnsApplyReceiptStep.if, "inputs.enable_public_dns == true");
  for (const field of ["adminDomain", "answers", "kioskDomain"]) {
    assert.match(dnsApplyReceiptStep.run, new RegExp(field));
  }

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
      'rm -rf -- "${RUNNER_TEMP:?}/yandex-alert-specs"',
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
        "if: always() && github.event_name == 'workflow_dispatch' && needs.plan.result == 'success'",
        "if: always() && github.event_name == 'pull_request' && needs.plan.result == 'success'",
      ),
    ],
    [
      "apply without transitive skip override",
      source.replace(
        "if: always() && github.event_name == 'workflow_dispatch' && needs.plan.result == 'success'",
        "if: github.event_name == 'workflow_dispatch' && needs.plan.result == 'success'",
      ),
    ],
    [
      "missing environment",
      source.replace("environment: production-infrastructure", "environment: unprotected", 1),
    ],
    [
      "missing apply environment",
      mutateWorkflowSource(source, (workflow) => {
        delete workflow.jobs.apply.environment;
      }),
    ],
    [
      "missing plan kiosk domain",
      mutateWorkflowSource(source, (workflow) => {
        delete workflow.jobs.plan.env.TF_VAR_kiosk_domain;
      }),
    ],
    [
      "apply kiosk domain substituted with admin domain",
      mutateWorkflowSource(source, (workflow) => {
        workflow.jobs.apply.env.TF_VAR_kiosk_domain = "${{ vars.MARKIRO_DOMAIN }}";
      }),
    ],
    ["stale commit", source.replace('[[ "$target_sha" == "$dispatch_sha" ]]\n', "")],
    ["unmasked HMAC", source.replace('echo "::add-mask::$aws_secret_access_key"\n', "")],
    ["DNS default true", source.replace("default: false", "default: true")],
    [
      "database phase without protected owner approval",
      mutateWorkflowSource(source, (workflow) => {
        delete workflow.jobs.postgres_owner_approval.environment;
      }),
    ],
    [
      "database phase without immutable owner approval identity",
      source.replace('[[ "$POSTGRES_OWNER_APPROVAL_RUN_ID" == "$GITHUB_RUN_ID" ]]\n', ""),
    ],
    [
      "unbounded PostgreSQL target",
      source.replace("module.postgres.yandex_mdb_postgresql_cluster.production", "module.postgres"),
    ],
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
      "missing plan IAM provenance",
      source.replace(
        'node infra/yandex/scripts/verify-service-account-provenance.mjs fetch > "$identity_path"\n',
        "",
      ),
    ],
    [
      "missing fresh apply IAM provenance comparison",
      source.replace('cmp --silent "$identity_path" "$fresh_identity_path"\n', ""),
    ],
    [
      "tampered plan IAM provenance evidence",
      source.replace(
        '[[ "$(sha256sum "$identity_path" | cut -d\' \' -f1)" == "$evidence_service_account_provenance_sha256" ]]\n',
        "",
      ),
    ],
    [
      "raw Terraform apply output",
      source.replace(
        'terraform -chdir=infra/yandex/production apply -json -input=false "$plan_path" > "$terraform_apply_stream" 2> "$terraform_apply_stderr"',
        'terraform -chdir=infra/yandex/production apply -input=false "$plan_path"',
      ),
    ],
    [
      "public DNS extractor accepts multiple outputs events",
      source.replace("select(($records | length) == 1) |", "select(($records | length) >= 1) |"),
    ],
    [
      "public DNS extractor omits the approved output type",
      source.replace('select($approved.type == ["tuple", ["string"]]) |\n', ""),
    ],
    [
      "public DNS extractor accepts out-of-range IPv4 octets",
      source.replace("(tonumber >= 0 and tonumber <= 255)", "true"),
    ],
    [
      "public DNS extractor maps a different kiosk answer set",
      source.replace(
        "answers: {($admin.value): $answers, ($kiosk.value): $answers}",
        'answers: {($admin.value): $answers, ($kiosk.value): ["203.0.113.11"]}',
      ),
    ],
    [
      "targeted first apply requires alert extraction",
      source.replace(
        'if [[ "$OBSERVABILITY_PHASE" == first && "$POSTGRES_PROVISIONING_PHASE" == none ]]; then',
        'if [[ "$OBSERVABILITY_PHASE" == first ]]; then',
      ),
    ],
    [
      "targeted first apply uploads a missing alert artifact",
      source.replace(
        "if: inputs.observability_phase == 'first' && inputs.postgres_provisioning_phase == 'none'",
        "if: inputs.observability_phase == 'first'",
      ),
    ],
    [
      "broad alert artifact upload",
      source.replace(
        "${{ runner.temp }}/yandex-alert-specs/alert-specs.json",
        "${{ runner.temp }}/yandex-alert-specs",
      ),
    ],
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
    [
      "missing public DNS extracted-values cleanup",
      source.replace('rm -f -- "${RUNNER_TEMP:?}/public-dns-values.json"\n', ""),
    ],
    [
      "missing public DNS receipt cleanup",
      source.replace('rm -f -- "${RUNNER_TEMP:?}/public-dns-apply.json"\n', ""),
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

test("production uses a credential-free partial S3 backend", async () => {
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

test("bootstrap starts with the local backend and introduces S3 only for migration", async () => {
  const [versions, backendTemplate, runbook] = await Promise.all([
    readRepositoryFile("infra/yandex/bootstrap/versions.tf"),
    readRepositoryFile("infra/yandex/bootstrap/backend.tf.example"),
    readRepositoryFile("docs/runbooks/yandex-bootstrap.md"),
  ]);

  assert.doesNotMatch(versions, /backend\s+"s3"/);
  assert.match(backendTemplate, /backend\s+"s3"\s*\{\s*}/s);
  assert.match(
    runbook,
    /cp infra\/yandex\/bootstrap\/backend\.tf\.example infra\/yandex\/bootstrap\/backend\.tf/,
  );
  assert.match(
    runbook,
    /terraform -chdir=infra\/yandex\/bootstrap init -input=false -lockfile=readonly/,
  );
  assert.match(
    runbook,
    /terraform -chdir=infra\/yandex\/bootstrap init -migrate-state -backend-config=backend\.hcl -lockfile=readonly/,
  );
});

test("bootstrap protects state, exact workload identity, secrets, and least privilege", async () => {
  assertProtectedBootstrap(await bootstrapContractSources());
});

test("production network and compute keep application and runner traffic private", async () => {
  assertPrivateNetworkAndCompute(await privateNetworkAndComputeSources());
});

test("deployment runner uses exact production federation, VM-scoped editor, and one-use JIT boot", async () => {
  const iam = await readRepositoryFile("infra/yandex/modules/iam/main.tf");
  const compute = await readRepositoryFile("infra/yandex/modules/compute/main.tf");
  const cloudInit = await readRepositoryFile(
    "infra/yandex/modules/compute/cloud-init-runner.yaml.tftpl",
  );
  const appCloudInit = await readRepositoryFile(
    "infra/yandex/modules/compute/cloud-init-app.yaml.tftpl",
  );
  const remoteDeploy = await readRepositoryFile("deploy/yandex/remote-deploy.mjs");
  const controller = await readRepositoryFile("deploy/yandex/runner-control.mjs");
  const bootstrap = await readRepositoryFile("infra/yandex/bootstrap/main.tf");
  const unit = await readRepositoryFile("deploy/yandex/systemd/markiro-runner.service");

  assertRunnerControllerProviderGrants({ bootstrap, compute, controller, iam });

  const credential = terraformResourceBlock(
    iam,
    "yandex_iam_workload_identity_federated_credential",
    "github_production_controller",
  );
  assert.match(
    credential,
    /service_account_id\s*=\s*yandex_iam_service_account\.deployment_controller\.id/,
  );
  assert.match(credential, /external_subject_id\s*=\s*local\.github_controller_subject/);
  const federationUse = terraformResourceBlock(
    iam,
    "yandex_iam_workload_identity_oidc_federation_iam_binding",
    "terraform_user",
  );
  assert.match(federationUse, /yandex_iam_service_account\.terraform\.id/);
  assert.match(federationUse, /yandex_iam_service_account\.deployment_controller\.id/);
  assert.doesNotMatch(federationUse, /yandex_iam_service_account\.runner\.id/);

  const operator = terraformResourceBlock(
    compute,
    "yandex_compute_instance_iam_binding",
    "runner_editor",
  );
  assert.match(operator, /instance_id\s*=\s*yandex_compute_instance\.runner\.id/);
  assert.match(operator, /role\s*=\s*"compute\.editor"/);
  assert.match(operator, /serviceAccount:\$\{var\.deployment_controller_service_account_id\}/);
  assert.match(operator, /serviceAccount:\$\{var\.runner_service_account_id\}/);
  assert.match(
    terraformResourceBlock(compute, "yandex_compute_instance", "runner"),
    /service_account_id\s*=\s*var\.runner_service_account_id/,
  );
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
  assert.match(appLogin, /serviceAccount:\$\{var\.runner_service_account_id\}/);
  const albViewer = terraformResourceBlock(
    iam,
    "yandex_resourcemanager_folder_iam_member",
    "runner_alb_viewer",
  );
  assert.match(albViewer, /role\s*=\s*"alb\.viewer"/);
  assert.match(albViewer, /serviceAccount:\$\{yandex_iam_service_account\.runner\.id\}/);

  assert.match(cloudInit, /RUNNER_VERSION=2\.336\.0/);
  assert.match(
    cloudInit,
    /RUNNER_SHA256=04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d/,
  );
  assert.match(cloudInit, /sha256sum --check --status/);
  assert.match(cloudInit, /markiro-runner\.service/);
  assert.doesNotMatch(cloudInit, /GITHUB_RUNNER_ADMIN_TOKEN\s*[:=]\s*[^$\s]/);
  assert.doesNotMatch(
    cloudInit,
    /generate-jitconfig|payload\.lockbox|runner_registration_secret_id/,
  );
  assert.match(cloudInit, /attributes\/markiro-runner-jit/);
  assert.match(cloudInit, /updateMetadata/);
  assert.match(controller, /generate-jitconfig/);
  assert.match(controller, /"markiro-runner-jit"/);
  assert.match(controller, /delete:\s*\["markiro-runner-jit"\]/);
  assert.match(appCloudInit, /MARKIRO_SSH_HOST_KEY_V1.*\/dev\/ttyS0/);
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
    assert.match(appSource, /MARKIRO_SSH_HOST_KEY_V1.*\/dev\/ttyS0/);
    assert.match(remoteSource, /StrictHostKeyChecking=yes/);
    assert.doesNotMatch(remoteSource, /accept-new/);
  };

  assertContract({ runnerSource: runner, appSource: app, remoteSource: remote });
  for (const [name, runnerSource, appSource, remoteSource] of [
    ["yc version", runner.replace("YC_VERSION=1.23.0", "YC_VERSION=latest"), app, remote],
    ["yc checksum", runner.replace(/YC_SHA256=[0-9a-f]{64}/, "YC_SHA256="), app, remote],
    ["host-key serial evidence", runner, app.replace("MARKIRO_SSH_HOST_KEY", "HOST_KEY"), remote],
    [
      "host-key marker version",
      runner,
      app.replace("MARKIRO_SSH_HOST_KEY_V1", "MARKIRO_SSH_HOST_KEY_V2"),
      remote,
    ],
    [
      "strict host checking",
      runner,
      app,
      remote.replace("StrictHostKeyChecking=yes", "StrictHostKeyChecking=accept-new"),
    ],
  ])
    assert.throws(() => assertContract({ runnerSource, appSource, remoteSource }), undefined, name);
});

test("runtime foundation pins containers and telemetry and isolates deploy-only registry credentials", async () => {
  const [
    installer,
    appCloudInit,
    runnerCloudInit,
    compute,
    observability,
    remoteDeploy,
    registryAuth,
    agentConfig,
  ] = await Promise.all([
    readRepositoryFile("deploy/yandex/install-container-runtime.sh"),
    readRepositoryFile("infra/yandex/modules/compute/cloud-init-app.yaml.tftpl"),
    readRepositoryFile("infra/yandex/modules/compute/cloud-init-runner.yaml.tftpl"),
    readRepositoryFile("infra/yandex/modules/compute/main.tf"),
    readRepositoryFile("infra/yandex/modules/observability/main.tf"),
    readRepositoryFile("deploy/yandex/remote-deploy.mjs"),
    readRepositoryFile("deploy/yandex/registry-auth.mjs"),
    readRepositoryFile("deploy/yandex/unified-agent-logs.yaml.tftpl"),
  ]);

  assert.match(installer, /DOCKER_VERSION=28\.5\.2/);
  assert.match(
    installer,
    /DOCKER_SHA256=ea90cfd12e1eeb12aa1c971741adb8bd4ed88e2a574eaac13f5029a1dbc6300d/,
  );
  assert.match(installer, /COMPOSE_VERSION=2\.40\.3/);
  assert.match(
    installer,
    /COMPOSE_SHA256=dba9d98e1ba5bfe11d88c99b9bd32fc4a0624a30fafe68eea34d61a3e42fd372/,
  );
  assert.match(installer, /sha256sum --check --status/g);
  for (const cloudInit of [appCloudInit, runnerCloudInit]) {
    assert.doesNotMatch(cloudInit, /docker\.io/);
    assert.match(cloudInit, /install-container-runtime/);
    assert.match(cloudInit, /UA_VERSION=26\.07\.11/);
    assert.match(
      cloudInit,
      /UA_SHA256=30e216b61b44eecb443942b986e44c0d83c0548a1bc6dbebb134067d678e2dc7/,
    );
    assert.match(cloudInit, /unified-agent\.service/);
  }
  assert.match(appCloudInit, /container-runtime\.mjs/);
  assert.match(appCloudInit, /markiro-app-bootstrap-complete/);
  assert.match(compute, /production_compose_b64\s*=\s*base64encode\(file/);

  for (const category of [
    "alb_healthy_backend",
    "postgres_backup_age",
    "readiness_required_unavailable",
  ]) {
    const spec = terraformObjectEntry(observability, category);
    assert.match(spec, /missing_data_behavior\s*=\s*"ALARM"/);
    assert.match(spec, /producer\s*=\s*"[^"]+"/);
  }
  assert.match(
    terraformObjectEntry(observability, "deployment_failure"),
    /missing_data_behavior\s*=\s*"OK"[\s\S]*?producer\s*=\s*"runner:remote-deploy\.mjs"/,
  );
  assert.match(
    terraformObjectEntry(observability, "runner_overrun"),
    /missing_data_behavior\s*=\s*"OK"/,
  );
  assert.match(agentConfig, /plugin:\s*file_input/);
  assert.match(agentConfig, /plugin:\s*linux_metrics/);
  assert.match(agentConfig, /plugin:\s*yc_metrics/);
  assert.match(agentConfig, /plugin:\s*yc_logs/);
  assert.match(agentConfig, /markiro\/observability\.log/);
  assert.match(agentConfig, /read_only_new_lines:\s*true/);
  assert.match(agentConfig, /namespace:\s*sys/);

  assert.match(remoteDeploy, /registry-auth\.mjs run-stdin/);
  assert.match(remoteDeploy, /YC_REGISTRY_SECRET_ID/);
  assert.match(remoteDeploy, /payload\.lockbox\.api\.cloud\.yandex\.net/);
  assert.match(registryAuth, /--password-stdin/);
  assert.match(registryAuth, /DOCKER_CONFIG/);
  assert.match(registryAuth, /docker", \["logout", "ghcr\.io"\]/);
  assert.doesNotMatch(appCloudInit, /GHCR_(?:USERNAME|TOKEN)\s*=/);
  assert.doesNotMatch(appCloudInit, /registry-secret-id|YC_REGISTRY_SECRET_ID/);
});

function assertOperationalApplicationLogDelivery({
  production,
  compute,
  computeVariables,
  observability,
  observabilityVariables,
  agentConfig,
  appCloudInit,
  runnerCloudInit,
}) {
  const applicationGroup = terraformResourceBlock(
    production,
    "yandex_logging_group",
    "application",
  );
  assert.match(applicationGroup, /name\s*=\s*"markiro-production-application"/);
  assert.match(applicationGroup, /retention_period\s*=\s*"336h"/);
  assert.match(computeVariables, /variable\s+"application_log_group_id"/);
  assert.match(observabilityVariables, /variable\s+"application_log_group_id"/);
  assert.match(
    production,
    /module\s+"compute"[\s\S]*?application_log_group_id\s*=\s*yandex_logging_group\.application\.id/,
  );
  assert.match(
    production,
    /module\s+"observability"[\s\S]*?application_log_group_id\s*=\s*yandex_logging_group\.application\.id/,
  );
  assert.equal(
    (compute.match(/application_log_group_id\s*=\s*var\.application_log_group_id/g) ?? []).length,
    2,
    "both VM templates must receive the exact retained application log group",
  );
  assert.match(agentConfig, /log_group_id:\s*\$\{application_log_group_id\}/);
  assert.doesNotMatch(agentConfig, /plugin:\s*yc_logs[\s\S]*?folder_id:/);
  assert.match(agentConfig, /state_directory:\s*\/var\/lib\/yandex\/unified_agent\/markiro/);

  for (const [name, cloudInit] of [
    ["app", appCloudInit],
    ["runner", runnerCloudInit],
  ]) {
    assert.match(cloudInit, /install -d -m 2750 -o root -g unified_agent \/var\/log\/markiro/);
    assert.match(cloudInit, /chown root:unified_agent \/var\/log\/markiro\/observability\.log/);
    assert.match(
      cloudInit,
      /runuser --user unified_agent -- test -r \/var\/log\/markiro\/observability\.log/,
      `${name} bootstrap must prove readability as the exact packaged agent identity`,
    );
    assert.match(
      cloudInit,
      /chown root:unified_agent \/etc\/yandex\/unified_agent\/conf\.d\/markiro-logs\.yml/,
      `${name} bootstrap must make its imported configuration readable to the service`,
    );
    assert.match(
      cloudInit,
      /runuser --user unified_agent -- \/usr\/bin\/unified_agent --config \/etc\/yandex\/unified_agent\/config\.yml check-config/,
      `${name} bootstrap must validate the complete imported agent configuration`,
    );
    assert.match(cloudInit, /systemctl enable --now unified-agent\.service/);
    assert.match(cloudInit, /systemctl is-active --quiet unified-agent\.service/);
  }

  assert.ok(
    runnerCloudInit.indexOf("check-config") <
      runnerCloudInit.indexOf("markiro-runner-bootstrap-complete"),
    "runner check-config must precede its completion marker",
  );
  assert.ok(
    runnerCloudInit.indexOf("systemctl is-active --quiet unified-agent.service") <
      runnerCloudInit.indexOf("markiro-runner-bootstrap-complete"),
    "runner service verification must precede its completion marker",
  );
  assert.doesNotMatch(observability, /resource\s+"yandex_logging_group"\s+"application"/);
}

test("application and runner logs are readable by Unified Agent and target the retained application group", async () => {
  const [
    production,
    compute,
    computeVariables,
    observability,
    observabilityVariables,
    agentConfig,
    appCloudInit,
    runnerCloudInit,
  ] = await Promise.all([
    readRepositoryFile("infra/yandex/production/main.tf"),
    readRepositoryFile("infra/yandex/modules/compute/main.tf"),
    readRepositoryFile("infra/yandex/modules/compute/variables.tf"),
    readRepositoryFile("infra/yandex/modules/observability/main.tf"),
    readRepositoryFile("infra/yandex/modules/observability/variables.tf"),
    readRepositoryFile("deploy/yandex/unified-agent-logs.yaml.tftpl"),
    readRepositoryFile("infra/yandex/modules/compute/cloud-init-app.yaml.tftpl"),
    readRepositoryFile("infra/yandex/modules/compute/cloud-init-runner.yaml.tftpl"),
  ]);

  assertOperationalApplicationLogDelivery({
    production,
    compute,
    computeVariables,
    observability,
    observabilityVariables,
    agentConfig,
    appCloudInit,
    runnerCloudInit,
  });
});

test("custom metric producers run as dedicated non-login users with least filesystem access", async () => {
  const [appCloudInit, runnerCloudInit, appUnit, runnerUnit] = await Promise.all([
    readRepositoryFile("infra/yandex/modules/compute/cloud-init-app.yaml.tftpl"),
    readRepositoryFile("infra/yandex/modules/compute/cloud-init-runner.yaml.tftpl"),
    readRepositoryFile("deploy/yandex/systemd/markiro-monitoring-producer.service"),
    readRepositoryFile("deploy/yandex/systemd/markiro-runner-monitoring.service"),
  ]);

  for (const [name, cloudInit] of [
    ["app", appCloudInit],
    ["runner", runnerCloudInit],
  ]) {
    assert.match(
      cloudInit,
      /name:\s*markiro-monitor[\s\S]*?system:\s*true[\s\S]*?shell:\s*\/usr\/sbin\/nologin/,
      `${name} image must provision the dedicated non-login producer identity`,
    );
    assert.match(
      cloudInit,
      /path:\s*\/etc\/markiro-monitor\/monitoring\.conf[\s\S]*?owner:\s*root:root[\s\S]*?permissions:\s*"0600"/,
      `${name} write_files must not depend on an account created later in cloud-init`,
    );
    assert.match(
      cloudInit,
      /install -d -m 0750 -o root -g markiro-monitor \/etc\/markiro-monitor[\s\S]*?chown root:markiro-monitor \/etc\/markiro-monitor\/monitoring\.conf[\s\S]*?chmod 0640 \/etc\/markiro-monitor\/monitoring\.conf/,
      `${name} runcmd must grant only the dedicated producer read access`,
    );
    assert.match(
      cloudInit,
      /monitoring-producer\.mjs[\s\S]*?permissions:\s*"0755"/,
      `${name} producer executable must be readable without root`,
    );
  }

  for (const unit of [appUnit, runnerUnit]) {
    assert.match(unit, /^User=markiro-monitor$/m);
    assert.match(unit, /^Group=markiro-monitor$/m);
    assert.match(unit, /^EnvironmentFile=\/etc\/markiro-monitor\/monitoring\.conf$/m);
    assert.match(unit, /^CapabilityBoundingSet=$/m);
    assert.match(unit, /^PrivateDevices=true$/m);
    assert.match(unit, /^ProtectKernelModules=true$/m);
    assert.match(unit, /^ProtectKernelTunables=true$/m);
    assert.match(unit, /^ProtectControlGroups=true$/m);
    assert.match(unit, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
    assert.match(
      unit,
      /^ReadOnlyPaths=\/etc\/markiro-monitor\/monitoring\.conf(?: \/proc\/uptime)?$/m,
    );
  }
});

test("production managed PostgreSQL and object storage protect durable data", async () => {
  assertProtectedManagedData(await managedDataSources());
});

test("protected ingress serves the admin and kiosk authorities through one private app edge", async () => {
  assertProtectedIngress(await protectedIngressSources());
});

test("production root wires both ingress hostnames while keeping public DNS disabled", async () => {
  assertProtectedIngress(await protectedIngressSources());
});

test("production observability separates logs and audit destinations and defines every alert contract", async () => {
  assertProtectedObservability(await observabilitySources());
});

test("observability contract rejects missing categories, unsafe retention, audit recursion, and incomplete alert wiring", async () => {
  const missingGroup = await observabilitySources();
  missingGroup.production = missingGroup.production.replace(
    terraformResourceBlock(missingGroup.production, "yandex_logging_group", "application"),
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
      /\s*&&\s*length\(toset\(values\(var\.alert_ids\)\)\)\s*==\s*16/,
      "",
    );
  assert.throws(() => assertProtectedObservability(duplicateAlertIdsAccepted));

  const duplicateRootAlertIdsAccepted = await observabilitySources();
  duplicateRootAlertIdsAccepted.productionVariables =
    duplicateRootAlertIdsAccepted.productionVariables.replace(
      /\s*&&\s*length\(toset\(values\(var\.alert_ids\)\)\)\s*==\s*16/,
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

  const oneCertificate = await observabilitySources();
  oneCertificate.production = oneCertificate.production.replace(
    /^\s*module\.ingress\.kiosk_certificate_id,?\s*$/m,
    "",
  );
  assert.throws(() => assertProtectedObservability(oneCertificate), /certificate_ids/);

  const duplicateCertificates = await observabilitySources();
  duplicateCertificates.production = duplicateCertificates.production.replace(
    "module.ingress.kiosk_certificate_id",
    "module.ingress.certificate_id",
  );
  assert.throws(() => assertProtectedObservability(duplicateCertificates), /certificate_ids/);

  const oneCertificateAccepted = await observabilitySources();
  oneCertificateAccepted.observabilityVariables =
    oneCertificateAccepted.observabilityVariables.replace(
      /length\(var\.certificate_ids\)\s*==\s*2\s*&&\s*/,
      "",
    );
  assert.throws(() => assertProtectedObservability(oneCertificateAccepted), /certificate_ids/);

  const duplicateCertificatesAccepted = await observabilitySources();
  duplicateCertificatesAccepted.observabilityVariables =
    duplicateCertificatesAccepted.observabilityVariables.replace(
      /\s*&&\s*length\(toset\(var\.certificate_ids\)\)\s*==\s*2/,
      "",
    );
  assert.throws(
    () => assertProtectedObservability(duplicateCertificatesAccepted),
    /certificate_ids/,
  );

  const latestExpiringCertificate = await observabilitySources();
  latestExpiringCertificate.observability = latestExpiringCertificate.observability.replace(
    "series_min(",
    "series_max(",
  );
  assert.throws(() => assertProtectedObservability(latestExpiringCertificate));

  const unwrappedCertificateSelector = await observabilitySources();
  unwrappedCertificateSelector.observability = unwrappedCertificateSelector.observability.replace(
    /series_min\((\\"certificate\.days_until_expiration\\"\{[^\n]+\})\)/,
    "$1",
  );
  assert.throws(() => assertProtectedObservability(unwrappedCertificateSelector));

  const kioskOnlyAlert = await observabilitySources();
  kioskOnlyAlert.observability = kioskOnlyAlert.observability.replace(
    /\n    runner_overrun\s*=\s*\{/,
    `
    certificate_risk_kiosk = {
      category                = "certificate_risk_kiosk"
      title                   = "Kiosk certificate expiry risk"
      metric                  = "certificate.days_until_expiration"
      query                   = local.certificate_risk_query
      comparison              = "LESS_THAN"
      warning_threshold       = 30
      alarm_threshold         = 14
      evaluation_window       = "1h"
      notification_channel_id = var.notification_channel_id
    }
    runner_overrun = {`,
  );
  assert.throws(() => assertProtectedObservability(kioskOnlyAlert), /16 alert categories/);
});

test("ingress mutations reject bypasses, duplicate edges, unsafe certificates, and unsafe defaults", async () => {
  for (const variables of ["ingressVariables", "productionVariables"]) {
    const equalDomainsAccepted = await protectedIngressSources();
    equalDomainsAccepted[variables] = equalDomainsAccepted[variables].replace(
      "var.kiosk_domain != var.domain",
      "true",
    );
    assert.throws(
      () => assertProtectedIngress(equalDomainsAccepted),
      /kiosk_domain must reject the admin domain/,
    );
  }

  const combinedReplacementCertificate = await protectedIngressSources();
  combinedReplacementCertificate.ingress = replaceTerraformResource(
    combinedReplacementCertificate.ingress,
    "yandex_cm_certificate",
    "markiro",
    (block) =>
      block.replace("domains   = [var.domain]", "domains   = [var.domain, var.kiosk_domain]"),
  );
  assert.throws(() => assertProtectedIngress(combinedReplacementCertificate));

  const ungatedKioskRecord = await protectedIngressSources();
  ungatedKioskRecord.ingress = replaceTerraformResource(
    ungatedKioskRecord.ingress,
    "yandex_dns_recordset",
    "kiosk_application",
    (block) => block.replace("count = var.public_dns_enabled ? 1 : 0", "count = 1"),
  );
  assert.throws(() => assertProtectedIngress(ungatedKioskRecord));

  for (const [type, name] of [
    ["yandex_vpc_address", "markiro"],
    ["yandex_alb_backend_group", "app"],
    ["yandex_alb_load_balancer", "markiro"],
  ]) {
    const duplicateEdge = await protectedIngressSources();
    duplicateEdge.ingress += terraformResourceBlock(duplicateEdge.ingress, type, name).replace(
      `"${name}"`,
      `"duplicate_${name}"`,
    );
    assert.throws(
      () => assertProtectedIngress(duplicateEdge),
      /protected ingress must keep exactly/,
    );
  }

  const duplicateTargetGroup = await protectedIngressSources();
  duplicateTargetGroup.compute += terraformResourceBlock(
    duplicateTargetGroup.compute,
    "yandex_alb_target_group",
    "app",
  ).replace('"app"', '"duplicate_app"');
  assert.throws(
    () => assertProtectedIngress(duplicateTargetGroup),
    /exactly one application target group/,
  );

  const wildcardAuthority = await protectedIngressSources();
  wildcardAuthority.ingress = replaceTerraformResource(
    wildcardAuthority.ingress,
    "yandex_alb_virtual_host",
    "markiro",
    (block) =>
      block.replace("authority      = [var.domain, var.kiosk_domain]", 'authority      = ["*"]'),
  );
  assert.throws(
    () => assertProtectedIngress(wildcardAuthority),
    /exactly the admin and kiosk authorities/,
  );

  for (const certificateId of [
    "data.yandex_cm_certificate.issued.id",
    "data.yandex_cm_certificate.kiosk_issued.id",
  ]) {
    const missingIssuedCertificate = await protectedIngressSources();
    missingIssuedCertificate.ingress = replaceTerraformResource(
      missingIssuedCertificate.ingress,
      "yandex_alb_load_balancer",
      "markiro",
      (block) => block.replace(new RegExp(`\\s*${certificateId.replaceAll(".", "\\.")},?`), ""),
    );
    assert.throws(
      () => assertProtectedIngress(missingIssuedCertificate),
      /default handler.*certificate|admin certificate|kiosk (TLS handler|certificate)/,
    );
  }

  const kioskSniMatchesAdminDomain = await protectedIngressSources();
  kioskSniMatchesAdminDomain.ingress = replaceTerraformResource(
    kioskSniMatchesAdminDomain.ingress,
    "yandex_alb_load_balancer",
    "markiro",
    (block) => block.replace("server_names = [var.kiosk_domain]", "server_names = [var.domain]"),
  );
  assert.throws(
    () => assertProtectedIngress(kioskSniMatchesAdminDomain),
    /kiosk SNI handler must match only the kiosk domain/,
  );

  const missingSws = await protectedIngressSources();
  missingSws.ingress = replaceTerraformResource(
    missingSws.ingress,
    "yandex_alb_virtual_host",
    "markiro",
    (block) => block.replace(/\n\s*route_options\s*\{[\s\S]*?\n\s*\}/, ""),
  );
  assert.throws(() => assertProtectedIngress(missingSws));

  const reintroducedWafProfile = await protectedIngressSources();
  reintroducedWafProfile.ingress +=
    '\nresource "yandex_sws_waf_profile" "markiro" { folder_id = var.folder_id }\n';
  assert.throws(
    () => assertProtectedIngress(reintroducedWafProfile),
    /must not provision a WAF profile/,
  );

  const reintroducedWafRule = await protectedIngressSources();
  reintroducedWafRule.ingress = replaceTerraformResource(
    reintroducedWafRule.ingress,
    "yandex_sws_security_profile",
    "markiro",
    (block) =>
      block.replace(
        "\n}",
        '\n  security_rule {\n    name = "waf-api"\n    priority = 100\n    waf { mode = "API" }\n  }\n}',
      ),
  );
  assert.throws(() => assertProtectedIngress(reintroducedWafRule), /must delegate only to ARL/);

  const disabledSwsLogging = await protectedIngressSources();
  disabledSwsLogging.ingress = replaceTerraformResource(
    disabledSwsLogging.ingress,
    "yandex_sws_security_profile",
    "markiro",
    (block) => block.replace(/enable\s*=\s*true/, "enable = false"),
  );
  assert.throws(() => assertProtectedIngress(disabledSwsLogging), /SWS logging must stay enabled/);

  const globalRuleWithoutStaticScope = await protectedIngressSources();
  globalRuleWithoutStaticScope.ingress = replaceTerraformResource(
    globalRuleWithoutStaticScope.ingress,
    "yandex_sws_advanced_rate_limiter_profile",
    "markiro",
    (block) => block.replace("static_quota {", "dynamic_quota {"),
  );
  assert.throws(
    () => assertProtectedIngress(globalRuleWithoutStaticScope),
    /global ARL rule must use the global static quota/,
  );

  const perIpRuleWithoutDynamicScope = await protectedIngressSources();
  perIpRuleWithoutDynamicScope.ingress = replaceTerraformResource(
    perIpRuleWithoutDynamicScope.ingress,
    "yandex_sws_advanced_rate_limiter_profile",
    "markiro",
    (block) => block.replace("dynamic_quota {", "static_quota {"),
  );
  assert.throws(
    () => assertProtectedIngress(perIpRuleWithoutDynamicScope),
    /per-IP ARL rule must use the IP-scoped dynamic quota/,
  );

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
  const oversizedPostgres = await managedDataSources();
  oversizedPostgres.postgres = replaceTerraformResource(
    oversizedPostgres.postgres,
    "yandex_mdb_postgresql_cluster",
    "production",
    (block) => block.replace('resource_preset_id = "s3-c2-m8"', 'resource_preset_id = "s2.medium"'),
  );
  assert.throws(
    () => assertProtectedManagedData(oversizedPostgres),
    /approved 2 vCPU \/ 8 GiB MVP preset/,
  );

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
  const oversizedApp = await privateNetworkAndComputeSources();
  oversizedApp.compute = replaceTerraformResource(
    oversizedApp.compute,
    "yandex_compute_instance",
    "app",
    (block) => block.replace(/cores\s*=\s*2/, "cores = 20"),
  );

  const oversizedRunner = await privateNetworkAndComputeSources();
  oversizedRunner.compute = replaceTerraformResource(
    oversizedRunner.compute,
    "yandex_compute_instance",
    "runner",
    (block) => block.replace(/cores\s*=\s*2/, "cores = 20"),
  );
  assert.throws(
    () => assertPrivateNetworkAndCompute(oversizedRunner),
    /deployment runner must retain its approved 2 vCPU \/ 4 GiB profile/,
  );
  assert.throws(
    () => assertPrivateNetworkAndCompute(oversizedApp),
    /approved 2 vCPU \/ 4 GiB MVP profile/,
  );

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

test("production compute resource profiles allow exact attributes in any order", async () => {
  const reorderedProfiles = await privateNetworkAndComputeSources();
  reorderedProfiles.compute = reorderedProfiles.compute.replaceAll(
    "    cores         = 2\n    memory        = 4\n    core_fraction = 100",
    "    memory        = 4\n    core_fraction = 100\n    cores         = 2",
  );
  assert.doesNotThrow(() => assertPrivateNetworkAndCompute(reorderedProfiles));
});

function assertRuntimeNodeProvisioning(cloudInit) {
  const nodeBlock = cloudInit.match(
    /NODE_VERSION=24\.11\.1[\s\S]*?(?=\n  - \|\n      set -eu\n      UA_VERSION)/,
  )?.[0];
  assert.ok(nodeBlock, "Node provisioning block is required");
  assert.match(
    nodeBlock,
    /NODE_SHA256=60e3b0a8500819514aca603487c254298cd776de0698d3cd08f11dba5b8289a8/,
  );
  assert.match(nodeBlock, /NODE_ARCH=x64/);
  assert.match(nodeBlock, /test "\$\(uname -m\)" = "x86_64"/);
  assert.match(nodeBlock, /test "\$\(dpkg --print-architecture\)" = "amd64"/);
  assert.match(nodeBlock, /sha256sum --check --status/);
  assert.match(nodeBlock, /test "\$\(\/usr\/bin\/node --version\)" = "v\$\$\{NODE_VERSION\}"/);
  assert.doesNotMatch(nodeBlock, /curl[^\n]*\|/);
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

test("bootstrap contract rejects an incomplete or broadened production action-role matrix", async () => {
  const missingGatewayGrant = await bootstrapContractSources();
  missingGatewayGrant.iam = missingGatewayGrant.iam.replace(
    /^\s*"vpc\.gateways\.manage"\s*=\s*"vpc\.gateways\.editor"\s*$/m,
    "",
  );
  assert.throws(() => assertProtectedBootstrap(missingGatewayGrant));

  const broadAlbGrant = await bootstrapContractSources();
  broadAlbGrant.iam = broadAlbGrant.iam.replace('"alb.editor"', '"alb.admin"');
  assert.throws(() => assertProtectedBootstrap(broadAlbGrant));
});

test("runner-controller provider-call contract rejects a missing app grant or unknown provider call", async () => {
  const [bootstrap, compute, controller, iam] = await Promise.all([
    readRepositoryFile("infra/yandex/bootstrap/main.tf"),
    readRepositoryFile("infra/yandex/modules/compute/main.tf"),
    readRepositoryFile("deploy/yandex/runner-control.mjs"),
    readRepositoryFile("infra/yandex/modules/iam/main.tf"),
  ]);
  const missingViewer = compute.replace(
    /resource\s+"yandex_compute_instance_iam_binding"\s+"deployment_controller_app_viewer"\s*\{[\s\S]*?\n\}/,
    "",
  );
  assert.throws(() =>
    assertRunnerControllerProviderGrants({ bootstrap, compute: missingViewer, controller, iam }),
  );
  const unknownCall = `${controller}\nconst unsafe = \`https://compute.api.cloud.yandex.net/compute/v1/disks/\${diskId}\`;\n`;
  assert.throws(() =>
    assertRunnerControllerProviderGrants({ bootstrap, compute, controller: unknownCall, iam }),
  );
});

test("encrypted production resources and runner start reject missing or folder-scoped key use", async () => {
  const missingTerraformGrant = await bootstrapContractSources();
  missingTerraformGrant.bootstrap = missingTerraformGrant.bootstrap.replace(
    /resource\s+"yandex_kms_symmetric_key_iam_member"\s+"terraform_key_user"\s*\{[\s\S]*?\n\}/,
    "",
  );
  assert.throws(() => assertProtectedBootstrap(missingTerraformGrant));

  const folderScoped = await bootstrapContractSources();
  folderScoped.bootstrap = folderScoped.bootstrap.replace(
    'resource "yandex_kms_symmetric_key_iam_member" "deployment_controller_runner_key_user"',
    'resource "yandex_resourcemanager_folder_iam_member" "deployment_controller_runner_key_user"',
  );
  assert.throws(() => assertProtectedBootstrap(folderScoped));
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
  const [readme, smoke] = await Promise.all([
    readRepositoryFile("infra/yandex/README.md"),
    readRepositoryFile("infra/yandex/test/bootstrap-state-migration.smoke.mjs"),
  ]);
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
  assert.match(smoke, /import\s+\{\s*assertManagedResourceInState\s*\}/);
  assert.match(smoke, /'terraform \{\\n  backend "s3" \{\}\\n\}\\n'/);
  assert.match(
    smoke,
    /"init",\s*"-migrate-state",\s*"-force-copy",\s*"-input=false",\s*"-backend-config=backend\.hcl"/s,
  );
  assert.equal((smoke.match(/assertManagedResourceInState\(/g) ?? []).length, 2);
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
