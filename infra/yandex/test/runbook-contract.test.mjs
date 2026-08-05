import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const runbooks = {
  "docs/runbooks/yandex-bootstrap.md": [
    "bootstrap-prerequisites",
    "bootstrap-local-apply",
    "bootstrap-state-hmac",
    "bootstrap-state-migration",
    "bootstrap-state-verification",
  ],
  "docs/runbooks/yandex-secrets.md": [
    "secrets-inventory",
    "secrets-runtime-payload",
    "secrets-mode-verification",
    "secrets-rotation",
  ],
  "docs/runbooks/yandex-infrastructure-apply.md": [
    "infrastructure-prerequisites",
    "infrastructure-reviewed-plan",
    "infrastructure-approved-apply",
    "infrastructure-drift",
  ],
  "docs/runbooks/yandex-recovery.md": [
    "recovery-prerequisites",
    "recovery-postgres-pitr",
    "recovery-media-version",
    "recovery-state-version",
    "recovery-vm",
    "recovery-evidence",
  ],
  "docs/runbooks/yandex-first-go-live.md": [
    "go-live-gate-01-plan-drift",
    "go-live-gate-02-durable-protection",
    "go-live-gate-03-certificate",
    "go-live-gate-04-alb-waf-arl",
    "go-live-gate-05-alert-specs",
    "go-live-gate-06-backup-restore",
    "go-live-gate-07-smtp-s3",
    "go-live-gate-08-release-manifest",
    "go-live-gate-09-deploy-smoke-rollback",
    "go-live-gate-10-tenant-rbac",
    "go-live-gate-11-notification-delivery",
    "go-live-public-dns-apply",
    "go-live-dns-convergence",
  ],
};
const forbidden = [
  /terraform\s+output\s+-json/i,
  /terraform\s+show\s+-json/i,
  /\bset\s+-x\b/,
  /--password=/i,
  /public_dns_enabled=true\s+-auto-approve/i,
  /docker\s+compose\s+config(?!\s+--quiet(?:\s|$))/i,
];
const forbiddenCommands = [
  "terraform output -json",
  "terraform show -json",
  "set -x",
  "tool --password=unsafe",
  "public_dns_enabled=true -auto-approve",
  "docker compose config",
];
const verifierInputs = [
  "MARKIRO_DOMAIN",
  "MARKIRO_AUTHORITATIVE_DNS_SERVER",
  "MARKIRO_PUBLIC_DNS_RESOLVERS",
  "MARKIRO_APPROVED_DNS_A",
  "MARKIRO_APPROVED_DNS_AAAA",
];

async function contents(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function sources() {
  const documents = await Promise.all(
    Object.keys(runbooks).map(async (runbook) => [runbook, await contents(runbook)]),
  );
  return {
    documents: Object.fromEntries(documents),
    verifier: await contents("deploy/production/verify-dns.mjs"),
    workflow: await contents(".github/workflows/yandex-infrastructure.yml"),
  };
}

function markersAppearInOrder(source, markers) {
  let previous = -1;
  for (const marker of markers) {
    const position = source.indexOf(`<!-- runbook-contract:${marker} -->`);
    assert.ok(position > previous, `missing or unordered marker ${marker}`);
    previous = position;
  }
}

function commandBlocks(source) {
  return [...source.matchAll(/^```[^\n]*\n([\s\S]*?)^```$/gm)].map((match) => match[1]);
}

function ordered(source, values, label) {
  let previous = -1;
  for (const value of values) {
    const position = source.indexOf(value);
    assert.ok(position > previous, `${label} is missing or unordered: ${value}`);
    previous = position;
  }
}

function assertRunbookContract({ documents, verifier, workflow }) {
  for (const [runbook, markers] of Object.entries(runbooks)) {
    const source = documents[runbook];
    markersAppearInOrder(source, markers);
    assert.ok(commandBlocks(source).length > 0 || !runbook.includes("bootstrap"));
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${runbook} contains a forbidden command`);
    }
  }

  const bootstrap = documents["docs/runbooks/yandex-bootstrap.md"];
  assert.match(bootstrap, /install .*Terraform `1\.15\.8`/i);
  assert.match(bootstrap, /terraform version -json/);
  assert.match(bootstrap, /node infra\/yandex\/scripts\/check-toolchain\.mjs/);
  assert.doesNotMatch(bootstrap, /\/private\/tmp\/markiro-terraform/i);
  ordered(
    bootstrap,
    [
      "terraform -chdir=infra/yandex/bootstrap init -backend=false -lockfile=readonly",
      "terraform -chdir=infra/yandex/bootstrap plan -out=bootstrap.tfplan",
      "terraform -chdir=infra/yandex/bootstrap apply bootstrap.tfplan",
      "terraform -chdir=infra/yandex/bootstrap init -migrate-state -backend-config=backend.hcl -lockfile=readonly",
    ],
    "bootstrap Terraform procedure",
  );

  const infrastructure = documents["docs/runbooks/yandex-infrastructure-apply.md"];
  for (const input of [
    "target_sha",
    "enable_public_dns=false",
    "postgres_provisioning_phase=cluster",
    "postgres_owner_boundary=none",
    "postgres_provisioning_phase=database",
    "postgres_owner_boundary=<PROTECTED_CHANGE_EVIDENCE_ID>",
  ]) {
    assert.match(infrastructure, new RegExp(input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  ordered(
    infrastructure,
    [
      "postgres_provisioning_phase=cluster\npostgres_owner_boundary=none",
      "Create the owner",
      "runtime Lockbox",
      "postgres_provisioning_phase=database\npostgres_owner_boundary=<PROTECTED_CHANGE_EVIDENCE_ID>",
    ],
    "two-phase PostgreSQL procedure",
  );
  for (const workflowInterface of [
    "postgres_provisioning_phase:",
    "postgres_owner_boundary:",
    "POSTGRES_OWNER_BOUNDARY",
    "evidence_postgres_owner_boundary",
  ]) {
    assert.match(workflow, new RegExp(workflowInterface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const goLive = documents["docs/runbooks/yandex-first-go-live.md"];
  const publicDns = goLive.indexOf("<!-- runbook-contract:go-live-public-dns-apply -->");
  assert.ok(publicDns >= 0, "missing public DNS apply marker");
  for (let gate = 1; gate <= 11; gate += 1) {
    const marker = `<!-- runbook-contract:go-live-gate-${String(gate).padStart(2, "0")}-`;
    const position = goLive.indexOf(marker);
    assert.ok(position >= 0 && position < publicDns, `gate ${gate} must precede public DNS`);
  }
  assert.match(goLive.slice(publicDns), /public_dns_enabled=true/);
  for (const input of verifierInputs) {
    assert.match(verifier, new RegExp(input));
    assert.match(goLive, new RegExp(`export [^\\n]*\\b${input}\\b`));
    assert.match(goLive, new RegExp(`unset [^\\n]*\\b${input}\\b`));
  }
}

test("Yandex operator runbooks bind ordered procedures to their real interfaces", async () => {
  assertRunbookContract(await sources());
});

test("runbook contract rejects every unsafe command and missing DNS verifier input", async () => {
  const current = await sources();
  const firstRunbook = "docs/runbooks/yandex-bootstrap.md";

  for (const command of forbiddenCommands) {
    const mutated = structuredClone(current);
    mutated.documents[firstRunbook] += `\n\`\`\`console\n${command}\n\`\`\`\n`;
    assert.throws(() => assertRunbookContract(mutated), command);
  }

  for (const input of verifierInputs) {
    const mutated = structuredClone(current);
    mutated.documents["docs/runbooks/yandex-first-go-live.md"] = mutated.documents[
      "docs/runbooks/yandex-first-go-live.md"
    ].replaceAll(input, `REMOVED_${input}`);
    assert.throws(() => assertRunbookContract(mutated), input);
  }
});
