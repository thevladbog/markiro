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
    postDnsWorkflow: await contents(".github/workflows/yandex-post-dns-smoke.yml"),
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

function markerProcedure(source, marker) {
  const start = source.indexOf(`<!-- runbook-contract:${marker} -->`);
  assert.ok(start >= 0, `missing marker ${marker}`);
  const next = source.indexOf("<!-- runbook-contract:", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

const markerProcedures = {
  "docs/runbooks/yandex-secrets.md": {
    "secrets-inventory": [
      "protected change record",
      "runtime Lockbox payload",
      "AWS_ACCESS_KEY_ID",
      "GITHUB_RUNNER_ADMIN_TOKEN",
      "protected operational system",
    ],
    "secrets-runtime-payload": [
      "Disable terminal recording",
      "input or a protected descriptor",
      "mode `0600`",
      "every and only the keys from",
      "S3 credentials",
      "SMTP credentials",
      "GHCR credentials",
    ],
    "secrets-mode-verification": [
      "expected key names",
      "/etc/markiro/production.env` at mode `0600`",
      "node deploy/production/preflight.mjs",
      "config --quiet",
      "sanitized readiness state",
    ],
    "secrets-rotation": [
      "approved rotation record",
      "standard input or a protected descriptor",
      "Restart or redeploy",
      "Revoke the previous credential",
      "GITHUB_RUNNER_ADMIN_TOKEN",
      "Remove temporary protected files",
    ],
  },
  "docs/runbooks/yandex-recovery.md": {
    "recovery-prerequisites": [
      "approved incident or drill record",
      "target timestamp",
      "distinct temporary PostgreSQL cluster",
      "Disable tracing",
    ],
    "recovery-postgres-pitr": [
      "PITR restore",
      "Create the application owner",
      "normal forward migration command",
      "Verify tenant isolation",
    ],
    "recovery-media-version": [
      "Select the required object version",
      "Restore that version",
      "Verify object metadata",
    ],
    "recovery-state-version": [
      "Select a prior version",
      "Copy it only into an isolated recovery location",
      "Do not initialize a production backend",
    ],
    "recovery-vm": [
      "new reviewed infrastructure plan",
      "no public IP",
      "last known healthy digest pair",
      "single-VM limitation",
    ],
    "recovery-evidence": [
      "observed RTO/RPO",
      "remediation change",
      "separate cleanup approval",
      "cleanup evidence separately",
    ],
  },
};

function assertRunbookContract({ documents, verifier, workflow, postDnsWorkflow }) {
  for (const [runbook, markers] of Object.entries(runbooks)) {
    const source = documents[runbook];
    markersAppearInOrder(source, markers);
    assert.ok(commandBlocks(source).length > 0 || !runbook.includes("bootstrap"));
    for (const commands of commandBlocks(source)) {
      for (const pattern of forbidden) {
        assert.doesNotMatch(commands, pattern, `${runbook} contains a forbidden command`);
      }
    }
  }

  for (const [runbook, procedures] of Object.entries(markerProcedures)) {
    for (const [marker, values] of Object.entries(procedures)) {
      ordered(markerProcedure(documents[runbook], marker), values, `${runbook}:${marker}`);
    }
  }

  const bootstrap = documents["docs/runbooks/yandex-bootstrap.md"];
  assert.match(bootstrap, /production-postgres-owner/);
  assert.match(bootstrap, /install .*Terraform `1\.15\.8`/i);
  assert.match(bootstrap, /terraform version -json/);
  assert.match(bootstrap, /node infra\/yandex\/scripts\/check-toolchain\.mjs/);
  assert.doesNotMatch(bootstrap, /\/private\/tmp\/markiro-terraform/i);
  ordered(
    bootstrap,
    [
      "terraform -chdir=infra/yandex/bootstrap init -input=false -lockfile=readonly",
      "terraform -chdir=infra/yandex/bootstrap plan -out=bootstrap.tfplan",
      "terraform -chdir=infra/yandex/bootstrap apply bootstrap.tfplan",
      "terraform -chdir=infra/yandex/bootstrap init -migrate-state -backend-config=backend.hcl -lockfile=readonly",
    ],
    "bootstrap Terraform procedure",
  );

  const infrastructure = documents["docs/runbooks/yandex-infrastructure-apply.md"];
  assert.match(infrastructure, /production-postgres-owner/);
  for (const input of [
    "target_sha",
    "enable_public_dns=false",
    "postgres_provisioning_phase=cluster",
    "postgres_owner_change_reference=none",
    "postgres_provisioning_phase=database",
    "postgres_owner_change_reference=protected_change_record_id",
  ]) {
    assert.match(infrastructure, new RegExp(input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  ordered(
    infrastructure,
    [
      "postgres_provisioning_phase=cluster\npostgres_owner_change_reference=none",
      "Create the owner",
      "runtime Lockbox",
      "postgres_owner_change_reference=protected_change_record_id",
    ],
    "two-phase PostgreSQL procedure",
  );
  for (const workflowInterface of [
    "postgres_provisioning_phase:",
    "postgres_owner_change_reference:",
    "postgres_owner_approval:",
    "POSTGRES_OWNER_CHANGE_REFERENCE",
    "evidence_postgres_owner_change_reference",
    "github_run_attempt",
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
  ordered(
    goLive,
    [
      "deployment_phase=first",
      "http://127.0.0.1:8080/health/ready",
      "curl --resolve <production-domain>:443:<reserved-alb-ip>",
      "<!-- runbook-contract:go-live-public-dns-apply -->",
      "production-public-smoke",
    ],
    "Yandex first-release ordering",
  );
  assert.doesNotMatch(
    goLive.slice(0, publicDns),
    /public smoke, `finalize`/i,
    "pre-DNS Yandex procedure must not use public-hostname smoke",
  );
  assert.match(goLive.slice(publicDns), /public_dns_enabled=true/);
  ordered(
    goLive.slice(publicDns),
    [
      "node deploy/production/verify-dns.mjs",
      "production-public-smoke",
      "release_sha=<current-main-40-character-sha>",
      "release_run_id=<publish-production-images-run-id>",
      "deployment_run_id=<successful-first-deployment-run-id>",
      "dns_apply_run_id=<successful-approved-dns-apply-run-id>",
      "dns_convergence_evidence_id=<protected-non-secret-evidence-id>",
      "Post-DNS production smoke",
    ],
    "post-DNS public smoke dispatch",
  );
  assert.match(postDnsWorkflow, /environment:\s*production-public-smoke/);
  assert.match(postDnsWorkflow, /node deploy\/yandex\/post-dns-smoke\.mjs run/);
  assert.doesNotMatch(postDnsWorkflow, /remote-deploy|deploy[.]mjs|\bmigrate\b|\bdocker\b/i);
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
    for (const fenceType of ["", "console"]) {
      const mutated = structuredClone(current);
      mutated.documents[firstRunbook] += `\n\`\`\`${fenceType}\n${command}\n\`\`\`\n`;
      assert.throws(() => assertRunbookContract(mutated), `${fenceType}:${command}`);
    }
  }

  for (const input of verifierInputs) {
    const mutated = structuredClone(current);
    mutated.documents["docs/runbooks/yandex-first-go-live.md"] = mutated.documents[
      "docs/runbooks/yandex-first-go-live.md"
    ].replaceAll(input, `REMOVED_${input}`);
    assert.throws(() => assertRunbookContract(mutated), input);
  }

  for (const [runbook, procedures] of Object.entries(markerProcedures)) {
    for (const [marker, values] of Object.entries(procedures)) {
      const mutated = structuredClone(current);
      const missingProcedure = markerProcedure(mutated.documents[runbook], marker);
      mutated.documents[runbook] = mutated.documents[runbook].replace(
        missingProcedure,
        missingProcedure.replace(values[0], "REMOVED_REQUIRED_SEMANTIC"),
      );
      assert.throws(() => assertRunbookContract(mutated), `${runbook}:${marker}:missing`);

      const reordered = structuredClone(current);
      const procedure = markerProcedure(reordered.documents[runbook], marker);
      const first = values[0];
      const second = values[1];
      const swapped = procedure
        .replace(first, "RUNBOOK_ORDER_SENTINEL")
        .replace(second, first)
        .replace("RUNBOOK_ORDER_SENTINEL", second);
      reordered.documents[runbook] = reordered.documents[runbook].replace(procedure, swapped);
      assert.throws(() => assertRunbookContract(reordered), `${runbook}:${marker}:reordered`);
    }
  }
});
