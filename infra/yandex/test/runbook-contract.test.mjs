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

async function contents(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
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
  return [...source.matchAll(/^```(?:bash|sh|shell)\n([\s\S]*?)^```$/gm)].map((match) => match[1]);
}

test("Yandex operator runbooks have their required ordered procedures", async () => {
  for (const [runbook, markers] of Object.entries(runbooks)) {
    markersAppearInOrder(await contents(runbook), markers);
  }
});

test("runbooks keep secret and rendered-state hazards out of commands", async () => {
  const forbidden = [
    /terraform\s+output\s+-json/i,
    /terraform\s+show\s+-json/i,
    /\bset\s+-x\b/,
    /--password=/i,
    /public_dns_enabled=true\s+-auto-approve/i,
  ];

  for (const runbook of Object.keys(runbooks)) {
    for (const commands of commandBlocks(await contents(runbook))) {
      for (const pattern of forbidden) {
        assert.doesNotMatch(commands, pattern, `${runbook} contains a forbidden command`);
      }
      assert.doesNotMatch(
        commands,
        /docker\s+compose\s+config(?!\s+--quiet(?:\s|$))/i,
        `${runbook} may validate Compose only with docker compose config --quiet`,
      );
    }
  }
});

test("the go-live runbook cannot publish DNS before its eleven gates", async () => {
  const source = await contents("docs/runbooks/yandex-first-go-live.md");
  const publicDns = source.indexOf("<!-- runbook-contract:go-live-public-dns-apply -->");
  assert.ok(publicDns >= 0, "missing public DNS apply marker");

  for (let gate = 1; gate <= 11; gate += 1) {
    const marker = `<!-- runbook-contract:go-live-gate-${String(gate).padStart(2, "0")}-`;
    const position = source.indexOf(marker);
    assert.ok(position >= 0 && position < publicDns, `gate ${gate} must precede public DNS`);
  }

  assert.match(source.slice(publicDns), /public_dns_enabled=true/);
});
