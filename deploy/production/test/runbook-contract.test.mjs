import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const RUNBOOK = "docs/runbooks/saas-production-deploy.md";
const DESIGN = "docs/superpowers/specs/2026-08-04-saas-production-bundle-design.md";
const PLAN = "docs/superpowers/plans/2026-08-04-saas-production-bundle.md";

const DIGEST_PINNED_MIGRATE_CLAIM =
  "The `migrate` service uses the exact same digest-pinned API image as `api`.";
const PARTIAL_MIGRATION_CLAIM =
  "may already have committed a prefix of forward migrations to the shared database";
const UNSWITCHED_CONTAINER_CLAIM = "`api` and `edge` containers are not switched";
const MIGRATION_GATE_CLAIM = "compatibility and rollback gate still applies";

function assertDnsFinalResponseClaims(source, label) {
  assert.match(source, /non-truncated/i, `${label} lacks the final non-truncated DNS contract`);
  assert.match(source, /SOA-only/i, `${label} lacks the SOA-only authority contract`);
  assert.doesNotMatch(
    source,
    /truncated DNS responses? (?:may|can) be accepted/i,
    `${label} must reject truncated DNS responses`,
  );
  assert.doesNotMatch(
    source,
    /non-SOA authority records? (?:are|is) allowed/i,
    `${label} must reject non-SOA empty-family authority records`,
  );
}

const DEPLOY_BLOCK = `node deploy/production/preflight.mjs
node deploy/production/deploy.mjs`;

const MODE_BLOCK = `case "$(uname -s)" in
  Darwin)
    stat -f '%Lp %N' "$MARKIRO_ENV_FILE"
    ENV_FILE_MODE="$(stat -f '%Lp' "$MARKIRO_ENV_FILE")"
    ;;
  Linux)
    stat -c '%a %n' "$MARKIRO_ENV_FILE"
    ENV_FILE_MODE="$(stat -c '%a' "$MARKIRO_ENV_FILE")"
    ;;
  *)
    echo 'STOP: unsupported operating system for mode inspection' >&2
    exit 1
    ;;
esac
test "$ENV_FILE_MODE" = 600 || {
  echo 'STOP: MARKIRO_ENV_FILE mode is not 0600' >&2
  exit 1
}`;

const BACKUP_BLOCK = `export BACKUP_MAX_AGE_SECONDS=86400
read -r -p 'Verified managed PostgreSQL backup evidence ID: ' DB_BACKUP_EVIDENCE_ID
read -r -p 'Verified backup creation time (YYYY-MM-DDTHH:mm:ss.sssZ): ' DB_BACKUP_CREATED_AT
test -n "$DB_BACKUP_EVIDENCE_ID"
node -e '
  const value = process.argv[1];
  const maximumAge = Number(process.argv[2]);
  if (!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(value)) {
    console.error("STOP: backup timestamp must be strict ISO-8601 UTC ending in Z");
    process.exit(1);
  }
  const created = new Date(value);
  const age = Date.now() - created.getTime();
  if (created.toISOString() !== value || !Number.isFinite(maximumAge) || age < 0 || age > maximumAge * 1000) {
    console.error("STOP: managed PostgreSQL backup is invalid or stale");
    process.exit(1);
  }
' "$DB_BACKUP_CREATED_AT" "$BACKUP_MAX_AGE_SECONDS"`;

const OWNER_BLOCK = `read -r -p 'Owner email: ' OWNER_EMAIL
read -r -p 'Tenant display name: ' TENANT_NAME
read -r -p 'Tenant slug: ' TENANT_SLUG

export PROTECTED_ROLLOUT_DIR=/var/lib/markiro/rollout-records
install -d -m 0700 "$PROTECTED_ROLLOUT_DIR"
OWNER_RESULT_FILE="$(mktemp "$PROTECTED_ROLLOUT_DIR/first-owner.XXXXXX")"
chmod 600 "$OWNER_RESULT_FILE"

docker compose --project-name markiro-production --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml run --rm --no-deps api \\
  node dist/cli/provision-tenant-owner.js \\
  --email "$OWNER_EMAIL" \\
  --tenant-name "$TENANT_NAME" \\
  --tenant-slug "$TENANT_SLUG" > "$OWNER_RESULT_FILE"
unset OWNER_EMAIL TENANT_NAME TENANT_SLUG

node - "$OWNER_RESULT_FILE" <<'NODE'
const { readFileSync } = require("node:fs");
const result = JSON.parse(readFileSync(process.argv[2], "utf8"));
const expected = ["deliveryId", "memberId", "tenantId", "userId"];
if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expected) ||
    expected.some((key) => typeof result[key] !== "string" || result[key].length === 0)) {
  throw new Error("STOP: owner provisioning did not return exactly four identifiers");
}
console.log("first-owner identifiers verified");
NODE`;

const ROLLBACK_VALIDATION_BLOCK = `read -r -p 'Failed candidate release record path: ' FAILED_RELEASE_RECORD
read -r -p 'Previous healthy release record path: ' PREVIOUS_RELEASE_RECORD
read -r -p 'Recorded previous healthy 40-character tag: ' PREVIOUS_TAG
read -r -p 'Backward-compatibility review evidence ID: ' MIGRATION_COMPATIBILITY_EVIDENCE_ID
read -r -p 'Failed migrations are compatible with the previous API image (yes/no): ' MIGRATIONS_BACKWARD_COMPATIBLE

[[ "$PREVIOUS_TAG" =~ ^[0-9a-f]{40}$ ]]
test -n "$MIGRATION_COMPATIBILITY_EVIDENCE_ID"
test "$MIGRATIONS_BACKWARD_COMPATIBLE" = yes || {
  echo 'STOP: rollback is forbidden without migration compatibility evidence' >&2
  exit 1
}

read -r MARKIRO_API_IMAGE_DIGEST MARKIRO_EDGE_IMAGE_DIGEST <<< "$(
node - "$MARKIRO_ROOT/.markiro-releases" "$FAILED_RELEASE_RECORD" "$PREVIOUS_RELEASE_RECORD" "$MARKIRO_IMAGE_TAG" "$PREVIOUS_TAG" <<'NODE'
const { lstatSync, readFileSync, realpathSync } = require("node:fs");
const { basename, dirname } = require("node:path");

const [releaseDirectoryInput, failedPath, previousPath, expectedFailedTag, expectedPreviousTag] = process.argv.slice(2);
const releaseDirectory = realpathSync(releaseDirectoryInput);
const sha = /^[0-9a-f]{40}$/;
const digest = (repository, value) => {
  const prefix = \`\${repository}@sha256:\`;
  return typeof value === "string" && value.startsWith(prefix) && /^[0-9a-f]{64}$/.test(value.slice(prefix.length));
};

function readProtectedRecord(label, path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error(\`STOP: \${label} release record must be a regular non-symlink 0600 file\`);
  }
  const canonicalPath = realpathSync(path);
  if (dirname(canonicalPath) !== releaseDirectory) {
    throw new Error(\`STOP: \${label} release record is outside the protected release directory\`);
  }
  const record = JSON.parse(readFileSync(canonicalPath, "utf8"));
  if (
    typeof record.createdAt !== "string" ||
    new Date(record.createdAt).toISOString() !== record.createdAt ||
    basename(canonicalPath) !== \`\${record.createdAt.replace(/[:.]/g, "-")}-\${record.tag}.json\`
  ) {
    throw new Error(\`STOP: \${label} release record filename or timestamp is invalid\`);
  }
  return record;
}

const failed = readProtectedRecord("failed", failedPath);
const previous = readProtectedRecord("previous", previousPath);
if (
  failed.state !== "failed" ||
  failed.tag !== expectedFailedTag ||
  !sha.test(expectedFailedTag) ||
  failed.previousTag !== previous.tag ||
  !digest("ghcr.io/thevladbog/markiro-api", failed.apiDigest) ||
  !digest("ghcr.io/thevladbog/markiro-edge", failed.edgeDigest)
) {
  throw new Error("STOP: failed release record is invalid or not linked to the previous release");
}
if (
  previous.state !== "healthy" ||
  previous.tag !== expectedPreviousTag ||
  !sha.test(previous.tag) ||
  (previous.previousTag !== null && !sha.test(previous.previousTag)) ||
  !digest("ghcr.io/thevladbog/markiro-api", previous.apiDigest) ||
  !digest("ghcr.io/thevladbog/markiro-edge", previous.edgeDigest)
) {
  throw new Error("STOP: previous release record is not the selected healthy digest pair");
}
console.log(previous.apiDigest.slice("ghcr.io/thevladbog/markiro-api@".length), previous.edgeDigest.slice("ghcr.io/thevladbog/markiro-edge@".length));
NODE
)"

MARKIRO_IMAGE_TAG="$PREVIOUS_TAG"
export MARKIRO_IMAGE_TAG MARKIRO_API_IMAGE_DIGEST MARKIRO_EDGE_IMAGE_DIGEST
node deploy/production/preflight.mjs`;

const ROLLBACK_EXECUTION_BLOCK = `docker compose --project-name markiro-production --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml pull api edge

ACTUAL_API_DIGESTS="$(docker image inspect --format '{{json .RepoDigests}}' "ghcr.io/thevladbog/markiro-api@\${MARKIRO_API_IMAGE_DIGEST}")"
ACTUAL_EDGE_DIGESTS="$(docker image inspect --format '{{json .RepoDigests}}' "ghcr.io/thevladbog/markiro-edge@\${MARKIRO_EDGE_IMAGE_DIGEST}")"
node - "$MARKIRO_ROOT/.markiro-releases" "$PREVIOUS_RELEASE_RECORD" "$PREVIOUS_TAG" "$ACTUAL_API_DIGESTS" "$ACTUAL_EDGE_DIGESTS" <<'NODE'
const { lstatSync, readFileSync, realpathSync } = require("node:fs");
const { dirname } = require("node:path");
const [directoryInput, previousPath, expectedTag, actualApiJson, actualEdgeJson] = process.argv.slice(2);
const metadata = lstatSync(previousPath);
if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
  throw new Error("STOP: previous release record changed after validation");
}
const canonicalPath = realpathSync(previousPath);
if (dirname(canonicalPath) !== realpathSync(directoryInput)) {
  throw new Error("STOP: previous release record left the protected release directory");
}
const record = JSON.parse(readFileSync(canonicalPath, "utf8"));
let actualApi;
let actualEdge;
try {
  actualApi = JSON.parse(actualApiJson);
  actualEdge = JSON.parse(actualEdgeJson);
} catch {
  throw new Error("STOP: pulled rollback image digest evidence is invalid");
}
const expectedApi = record.apiDigest;
const expectedEdge = record.edgeDigest;
if (
  record.state !== "healthy" ||
  record.tag !== expectedTag ||
  !Array.isArray(actualApi) ||
  !actualApi.includes(expectedApi) ||
  !Array.isArray(actualEdge) ||
  !actualEdge.includes(expectedEdge)
) {
  throw new Error("STOP: pulled rollback image digest differs from the protected release record");
}
console.log("rollback image digests verified");
NODE

docker compose --project-name markiro-production --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml run --rm migrate
docker compose --project-name markiro-production --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml up -d --no-deps api

READY=0
for attempt in $(seq 1 30); do
  if docker compose --project-name markiro-production --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml exec -T api \\
    node /opt/markiro/healthcheck.mjs; then
    READY=1
    break
  fi
  sleep 2
done
test "$READY" = 1 || {
  echo 'STOP: previous API image did not become ready' >&2
  exit 1
}

docker compose --project-name markiro-production --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml up -d --no-deps edge
node deploy/production/smoke.mjs`;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function section(source, heading) {
  const marker = `## ${heading}`;
  const start = source.indexOf(marker);
  invariant(
    start >= 0 && (start === 0 || source[start - 1] === "\n"),
    `missing ${heading} section`,
  );
  const bodyStart = source.indexOf("\n", start + marker.length);
  const next = source.indexOf("\n## ", bodyStart + 1);
  return source.slice(bodyStart + 1, next < 0 ? source.length : next);
}

function bashBlocks(sectionSource) {
  return [...sectionSource.matchAll(/^```bash\n([\s\S]*?)\n```$/gm)].map((match) => match[1]);
}

function blockContaining(sectionSource, token, label) {
  const matches = bashBlocks(sectionSource).filter((block) => block.includes(token));
  invariant(matches.length === 1, `${label} must have exactly one matching fenced shell block`);
  return matches[0];
}

function assertOrdered(source, tokens, message) {
  let cursor = -1;
  for (const token of tokens) {
    const next = source.indexOf(token, cursor + 1);
    invariant(next > cursor, `${message}: missing or reordered ${token}`);
    cursor = next;
  }
}

function assertRunbook(source) {
  const common = section(source, "Common setup and hard gates");
  const first = section(source, "First deploy");
  const routine = section(source, "Routine deploy");
  const failure = section(source, "Failure decision table");
  const rollback = section(source, "Rollback");
  const observation = section(source, "Observation window");
  const goLive = section(source, "Public DNS go-live gate");

  invariant(
    common.includes("MARKIRO_API_IMAGE_DIGEST") &&
      common.includes("MARKIRO_EDGE_IMAGE_DIGEST") &&
      common.includes("^sha256:[0-9a-f]{64}$"),
    "common setup must validate and export both approved digest selectors",
  );
  invariant(
    /trusted GitHub Actions release\s+evidence[\s\S]{0,120}trust\s+boundary/i.test(common),
    "trusted Actions digest evidence trust boundary is missing",
  );

  invariant(
    blockContaining(common, "ENV_FILE_MODE", "environment mode") === MODE_BLOCK,
    "environment mode inspection must branch exactly for macOS and Linux",
  );
  invariant(
    blockContaining(common, "BACKUP_MAX_AGE_SECONDS", "backup freshness") === BACKUP_BLOCK,
    "backup timestamp validation must require canonical ISO-8601 UTC ending in Z",
  );
  invariant(
    first.includes("managed\nPostgreSQL") || common.includes("managed\nPostgreSQL"),
    "missing managed PostgreSQL backup gate",
  );
  invariant(
    common.includes("object storage policy") && common.includes("Versioning"),
    "missing object-storage policy gate",
  );
  invariant(
    blockContaining(first, "node deploy/production/deploy.mjs", "first deploy") === DEPLOY_BLOCK,
    "first-deploy commands must be exact",
  );
  invariant(
    blockContaining(routine, "node deploy/production/deploy.mjs", "routine deploy") ===
      DEPLOY_BLOCK,
    "routine-deploy commands must be exact",
  );

  const owner = blockContaining(first, "OWNER_RESULT_FILE", "first-owner provisioning");
  invariant(
    owner.includes('mktemp "$PROTECTED_ROLLOUT_DIR/first-owner.XXXXXX"'),
    "first-owner mktemp template must end in XXXXXX",
  );
  invariant(
    owner === OWNER_BLOCK,
    "first-owner provisioning block must be exact and retain only the protected result file",
  );
  const dnsVerification = blockContaining(
    first,
    "node deploy/production/verify-dns.mjs",
    "DNS verification",
  );
  invariant(
    dnsVerification.includes("MARKIRO_APPROVED_DNS_A") &&
      dnsVerification.includes("MARKIRO_APPROVED_DNS_AAAA") &&
      dnsVerification.includes("MARKIRO_AUTHORITATIVE_DNS_SERVER") &&
      dnsVerification.includes("MARKIRO_PUBLIC_DNS_RESOLVERS"),
    "DNS verifier inputs must explicitly cover authoritative/public A and AAAA sets",
  );
  invariant(
    !/dig\s|grep\s+-F/.test(dnsVerification),
    "runbook must delegate DNS response parsing to the executable verifier",
  );

  for (const phase of [
    "Pull",
    "Migration",
    "API readiness",
    "Edge start",
    "Edge/TLS readiness",
    "Post-switch smoke",
  ])
    invariant(
      new RegExp(`\\|\\s*${phase}\\s*\\|`, "i").test(failure),
      `missing ${phase} failure row`,
    );

  const validation = blockContaining(rollback, "FAILED_RELEASE_RECORD", "rollback validation");
  invariant(
    validation.includes("const metadata = lstatSync(path);") &&
      validation.includes("metadata.isSymbolicLink()"),
    "rollback record validation must reject symlinks with lstatSync",
  );
  invariant(
    validation.includes("dirname(canonicalPath) !== releaseDirectory"),
    "rollback record containment must compare the canonical parent exactly",
  );
  invariant(
    validation.includes("failed.previousTag !== previous.tag"),
    "rollback records must link failed.previousTag to previous.tag",
  );
  invariant(
    validation.includes("failed.tag !== expectedFailedTag"),
    "rollback failed record must match the approved candidate SHA",
  );
  invariant(
    validation.includes("value.startsWith(prefix)") &&
      validation.includes("value.slice(prefix.length)"),
    "rollback release digests must use an exact repository prefix",
  );
  invariant(
    validation === ROLLBACK_VALIDATION_BLOCK,
    "rollback validation block must be exact and fail closed before pull",
  );
  invariant(
    validation.includes("MARKIRO_API_IMAGE_DIGEST") &&
      validation.includes("MARKIRO_EDGE_IMAGE_DIGEST") &&
      validation.includes(
        "export MARKIRO_IMAGE_TAG MARKIRO_API_IMAGE_DIGEST MARKIRO_EDGE_IMAGE_DIGEST",
      ),
    "rollback must derive and export both digest selectors before preflight",
  );

  const execution = blockContaining(rollback, "ACTUAL_API_DIGEST", "rollback execution");
  invariant(
    execution.includes("const metadata = lstatSync(previousPath);") &&
      execution.includes("dirname(canonicalPath) !== realpathSync(directoryInput)"),
    "rollback digest check must revalidate the protected record without following symlinks",
  );
  invariant(!/run --rm migrate\s*(?:\|\||;)/.test(execution), "rollback migrate must fail closed");
  invariant(
    execution === ROLLBACK_EXECUTION_BLOCK,
    "rollback command sequence must be exact with no reordered or extra commands",
  );
  invariant(
    execution.includes("{{json .RepoDigests}}") && execution.includes(".includes(expectedApi)"),
    "rollback must verify exact digest membership without array-order assumptions",
  );

  invariant(source.includes("Never reverse migrations"), "reverse migrations must be forbidden");
  invariant(
    source.includes("Do not hand-edit containers"),
    "hand-edited containers must be forbidden",
  );
  invariant(
    source.includes("Do not hand-edit production rows"),
    "hand-edited production rows must be forbidden",
  );
  invariant(
    !bashBlocks(source).some((block) => /docker compose[^\n]* config(?! --quiet)/.test(block)),
    "fenced commands must not render Compose configuration",
  );
  invariant(
    /secret values[\s\S]{0,80}tickets, chat/i.test(source),
    "secret sharing prohibition is missing",
  );
  invariant(
    /previous tag[\s\S]*release record[\s\S]*observation window/i.test(observation),
    "observation window must retain previous release evidence",
  );
  invariant(
    /case\s+"\$RATE_LIMIT_CONTROL"\s+in\s+provider-arl\|reviewed-custom-caddy\)\s*;;/m.test(
      goLive,
    ) &&
      !/provider-waf/.test(goLive) &&
      /per-source/i.test(goLive) &&
      /global\s+anonymous-route/i.test(goLive),
    "provider ARL rate-limit gate is incomplete",
  );
  invariant(
    /standard Caddy image cannot satisfy/i.test(goLive),
    "standard Caddy limitation is missing",
  );
  invariant(
    /separately reviewed reproducible custom Caddy image/i.test(goLive),
    "reviewed custom-Caddy alternative is missing",
  );
  invariant(
    /maintenance[/]deny/i.test(goLive) && /allowlist/i.test(goLive),
    "pre-DNS maintenance deny and smoke allowlist gates are missing",
  );
  invariant(
    /ACME HTTP-01 challenge/i.test(goLive) && /pass-through/i.test(goLive),
    "Caddy ACME pass-through gate is missing",
  );
  invariant(
    /provider terminates TLS/i.test(goLive) && /pre-provisioned certificate/i.test(goLive),
    "provider-terminated TLS alternative is missing",
  );
  invariant(
    /repository intentionally provides no[\s\S]{0,100}provider\s+command/i.test(goLive),
    "provider-specific commands must remain outside the repository",
  );
  invariant(
    !/Do not create or switch public DNS/i.test(source),
    "obsolete no-DNS-before-deploy sequence must be removed",
  );
  assertOrdered(
    first,
    [
      "RATE_LIMITS_VERIFIED",
      "MAINTENANCE_DENY_VERIFIED",
      "SMOKE_SOURCE_ALLOWLISTED",
      "TLS_BOOTSTRAP_VERIFIED",
      "DNS_CHANGE_EVIDENCE_ID",
      "MARKIRO_AUTHORITATIVE_DNS_SERVER",
      "MARKIRO_PUBLIC_DNS_RESOLVERS",
      "MARKIRO_APPROVED_DNS_A",
      "MARKIRO_APPROVED_DNS_AAAA",
      "node deploy/production/verify-dns.mjs",
      "node deploy/production/deploy.mjs",
      "PUBLIC_TRAFFIC_OPENED_EVIDENCE_ID",
    ],
    "first-deploy DNS/ACME sequence",
  );
  invariant(
    /bounded edge[/]TLS\s+readiness/i.test(first) &&
      /exactly one full production smoke/i.test(first),
    "deploy-owned edge readiness and exactly-once smoke are missing",
  );
  invariant(
    /leave maintenance[/]deny active or withdraw DNS/i.test(first),
    "first-deploy failure must remain fail closed",
  );
  invariant(
    /assumes public DNS and valid TLS already exist/i.test(routine),
    "routine deploy must state its DNS/TLS precondition",
  );
  invariant(
    /docs\/runbooks\/cabinet-rbac-rollout\.md/.test(source),
    "cabinet RBAC runbook link is missing",
  );
  invariant(
    source.includes("does not guarantee zero downtime") &&
      source.includes("blue/green") &&
      /recreate the previous digest\s+pair/.test(source),
    "single-service downtime and rollback semantics must be explicit",
  );
}

function assertIdentityClaims(source, label) {
  const normalized = source.replace(/\s+/g, " ");
  invariant(
    normalized.includes("SHA tags are mutable selectors") &&
      /preapproved.{0,160}repository digest/i.test(normalized),
    `${label} must document the digest trust boundary and mutable SHA-tag selector`,
  );
  invariant(
    !/(?:SHA|git SHA|SHA-only)[^\n.]{0,80}(?:immutable tag|immutable image)/i.test(source),
    `${label} must not describe SHA-tag selectors as immutable images`,
  );
  invariant(
    !/\b(?:guarantees|provides) zero downtime/i.test(source),
    `${label} must not claim zero downtime for the single-service deployment`,
  );
  invariant(
    normalized.includes("does not guarantee zero downtime"),
    `${label} must state the single-service downtime limitation explicitly`,
  );
  invariant(
    !/same API image tag/i.test(source),
    `${label} must identify the migrate image by digest, not by a mutable tag`,
  );
  invariant(
    !/previous deployment untouched/i.test(source),
    `${label} must not claim a failed migration leaves the previous deployment untouched`,
  );
  invariant(
    normalized.includes(DIGEST_PINNED_MIGRATE_CLAIM) &&
      normalized.includes(PARTIAL_MIGRATION_CLAIM) &&
      normalized.includes(UNSWITCHED_CONTAINER_CLAIM) &&
      normalized.includes(MIGRATION_GATE_CLAIM),
    `${label} must describe digest-pinned migration identity and partial-commit failure semantics`,
  );
}

function assertPlanPreflightInterface(source) {
  invariant(
    source.includes(
      "Consumes: `MARKIRO_IMAGE_TAG`, `MARKIRO_API_IMAGE_DIGEST`, `MARKIRO_EDGE_IMAGE_DIGEST`, `MARKIRO_DOMAIN`, `ACME_EMAIL`, optional `MARKIRO_ENV_FILE`",
    ),
    "plan preflight interface must list both digest selector inputs",
  );
  invariant(
    source.includes(
      "`PreflightResult` with `imageTag`, `apiImageDigest`, `edgeImageDigest`, `domain`, `acmeEmail`, and `envFile`",
    ),
    "plan preflight interface must list both digest selector outputs",
  );
  for (const property of [
    "MARKIRO_API_IMAGE_DIGEST",
    "MARKIRO_EDGE_IMAGE_DIGEST",
    "apiImageDigest",
    "edgeImageDigest",
  ])
    invariant(
      new RegExp(
        `@property \\{string \\| undefined\\} ${property}|@property \\{string\\} ${property}`,
      ).test(source),
      `plan preflight JSDoc must list ${property}`,
    );
}

function replaceUnique(source, needle, replacement) {
  const occurrences = source.split(needle).length - 1;
  assert.equal(occurrences, 1, `mutation fixture must occur once: ${needle}`);
  return source.replace(needle, replacement);
}

function rejectsMutation(source, name, needle, replacement, message) {
  const mutated = replaceUnique(source, needle, replacement);
  assert.throws(() => assertRunbook(mutated), { message }, name);
}

test("the parsed runbook has exact fail-closed deploy, owner, and rollback procedures", async () => {
  assertRunbook(await readFile(RUNBOOK, "utf8"));
});

test("runbook, design, and plan describe digest identity and single-service downtime truthfully", async () => {
  assertIdentityClaims(await readFile(RUNBOOK, "utf8"), "runbook");
  assertIdentityClaims(await readFile(DESIGN, "utf8"), "design");
  const plan = await readFile(PLAN, "utf8");
  assertIdentityClaims(plan, "plan");
  assertPlanPreflightInterface(plan);
});

test("runbook, design, and plan share the safe first-deploy DNS and ACME ordering", async () => {
  for (const [label, path] of [
    ["runbook", RUNBOOK],
    ["design", DESIGN],
    ["plan", PLAN],
  ]) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /Do not create or switch public DNS/i, `${label} is obsolete`);
    assert.match(source, /maintenance\/deny/i, `${label} lacks the pre-DNS deny gate`);
    assert.match(source, /ACME HTTP-01/i, `${label} lacks the Caddy ACME path`);
    assert.match(source, /authoritative.*public DNS/is, `${label} lacks bounded DNS verification`);
    assert.match(
      source,
      /exact normalized[\s\S]{0,120}A and AAAA/i,
      `${label} lacks exact normalized address-set verification`,
    );
    assert.match(
      source,
      /\+norecurse[\s\S]{0,100}AA flag/i,
      `${label} lacks non-recursive authoritative validation`,
    );
    assert.match(
      source,
      /public[\s\S]{0,140}RA flag/i,
      `${label} lacks recursive public-response validation`,
    );
    assert.match(source, /QR\b/i, `${label} lacks the DNS response-packet validation contract`);
    assert.match(
      source,
      /empty[\s\S]{0,240}NODATA/i,
      `${label} lacks the empty-family NODATA proof contract`,
    );
    assert.match(
      source,
      /SOA[\s\S]{0,180}ancestor/i,
      `${label} lacks the SOA owner ancestor contract`,
    );
    assertDnsFinalResponseClaims(source, label);
    assert.match(
      source,
      /RR\s+owner[\s\S]{0,120}requested domain/i,
      `${label} lacks answer-owner validation`,
    );
    assert.match(source, /edge\/TLS readiness/i, `${label} lacks edge TLS readiness`);
    assert.match(
      source,
      /exactly one full (?:production )?smoke/i,
      `${label} lacks one full smoke`,
    );
  }
  const plan = await readFile(PLAN, "utf8");
  assert.match(
    plan,
    /git add[^\n]*deploy\/production\/verify-dns\.mjs[^\n]*deploy\/production\/test\/dns-verification\.test\.mjs/,
    "plan Task 8 commit must stage the DNS verifier and its executable contract",
  );
});

test("each DNS documentation contract rejects truncated and mixed-authority mutations", async (t) => {
  for (const [label, path] of [
    ["runbook", RUNBOOK],
    ["design", DESIGN],
    ["plan", PLAN],
  ]) {
    const source = await readFile(path, "utf8");

    await t.test(`${label}: truncated response mutation`, () => {
      assert.throws(
        () =>
          assertDnsFinalResponseClaims(
            `${source}\nTruncated DNS responses may be accepted.\n`,
            label,
          ),
        new RegExp(`${label} must reject truncated DNS responses`),
      );
    });

    await t.test(`${label}: mixed authority mutation`, () => {
      assert.throws(
        () =>
          assertDnsFinalResponseClaims(
            `${source}\nNon-SOA authority records are allowed for an empty family.\n`,
            label,
          ),
        new RegExp(`${label} must reject non-SOA empty-family authority records`),
      );
    });
  }
});

test("each documentation contract rejects its own stale identity and migration claims", async (t) => {
  for (const [label, path] of [
    ["runbook", RUNBOOK],
    ["design", DESIGN],
    ["plan", PLAN],
  ]) {
    const source = await readFile(path, "utf8");

    await t.test(`${label}: false zero-downtime mutation`, () => {
      const mutated = `${source}\nThis single-service deployment guarantees zero downtime.\n`;
      assert.throws(
        () => assertIdentityClaims(mutated, label),
        new RegExp(`${label} must not claim zero downtime`),
      );
    });

    await t.test(`${label}: mutable API-tag migration identity mutation`, () => {
      const mutated = `${source}\nThe migrate service uses the same API image tag.\n`;
      assert.throws(
        () => assertIdentityClaims(mutated, label),
        new RegExp(`${label} must identify the migrate image by digest`),
      );
    });

    await t.test(`${label}: previous-deployment-untouched mutation`, () => {
      const mutated = `${source}\nA failed migration leaves the previous deployment untouched.\n`;
      assert.throws(
        () => assertIdentityClaims(mutated, label),
        new RegExp(`${label} must not claim a failed migration`),
      );
    });
  }
});

test("the contract rejects each portability, record-safety, linkage, and command mutation for its own reason", async () => {
  const source = await readFile(RUNBOOK, "utf8");
  const migrate =
    'docker compose --project-name markiro-production --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml run --rm migrate';
  const api =
    'docker compose --project-name markiro-production --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml up -d --no-deps api';

  rejectsMutation(
    source,
    "legacy provider WAF selector",
    "provider-arl|reviewed-custom-caddy",
    "provider-waf|reviewed-custom-caddy",
    "provider ARL rate-limit gate is incomplete",
  );

  const reorderedDns = source
    .replaceAll("MARKIRO_PUBLIC_DNS_RESOLVERS", "PUBLIC_DNS_REORDERED")
    .replace(
      "MARKIRO_AUTHORITATIVE_DNS_SERVER",
      "MARKIRO_PUBLIC_DNS_RESOLVERS MARKIRO_AUTHORITATIVE_DNS_SERVER",
    );
  assert.throws(
    () => assertRunbook(reorderedDns),
    /first-deploy DNS\/ACME sequence/,
    "public DNS cannot be accepted before authoritative DNS",
  );
  assert.throws(
    () => assertRunbook(`${source}\nDo not create or switch public DNS before deploy.\n`),
    /obsolete no-DNS-before-deploy sequence/,
    "the former contradictory DNS prohibition cannot return",
  );
  assert.throws(
    () =>
      assertRunbook(
        source.replace(DEPLOY_BLOCK, `${DEPLOY_BLOCK}\nnode deploy/production/smoke.mjs`),
      ),
    /first-deploy commands must be exact/,
    "first deploy cannot run a second full smoke",
  );

  rejectsMutation(
    source,
    "mktemp suffix",
    "first-owner.XXXXXX",
    "first-owner.XXXXXX.json",
    "first-owner mktemp template must end in XXXXXX",
  );
  rejectsMutation(
    source,
    "platform branch",
    'case "$(uname -s)" in',
    "stat -f '%Lp %N' \"$MARKIRO_ENV_FILE\"",
    "environment mode inspection must branch exactly for macOS and Linux",
  );
  rejectsMutation(
    source,
    "UTC suffix",
    "\\.\\d{3}Z$/",
    "\\.\\d{3}(?:Z|[+-]\\d{2}:\\d{2})$/",
    "backup timestamp validation must require canonical ISO-8601 UTC ending in Z",
  );
  rejectsMutation(
    source,
    "test -e record",
    'node - "$MARKIRO_ROOT/.markiro-releases" "$FAILED_RELEASE_RECORD" "$PREVIOUS_RELEASE_RECORD" "$MARKIRO_IMAGE_TAG" "$PREVIOUS_TAG" <<\'NODE\'',
    'test -e "$FAILED_RELEASE_RECORD"\nnode - "$MARKIRO_ROOT/.markiro-releases" "$FAILED_RELEASE_RECORD" "$PREVIOUS_RELEASE_RECORD" "$MARKIRO_IMAGE_TAG" "$PREVIOUS_TAG" <<\'NODE\'',
    "rollback validation block must be exact and fail closed before pull",
  );
  rejectsMutation(
    source,
    "symlink-unsafe stat",
    "const metadata = lstatSync(path);",
    "const metadata = statSync(path);",
    "rollback record validation must reject symlinks with lstatSync",
  );
  rejectsMutation(
    source,
    "prefix-collision containment",
    "dirname(canonicalPath) !== releaseDirectory",
    "!dirname(canonicalPath).startsWith(releaseDirectory)",
    "rollback record containment must compare the canonical parent exactly",
  );
  rejectsMutation(
    source,
    "missing failed linkage",
    "  failed.previousTag !== previous.tag ||\n",
    "",
    "rollback records must link failed.previousTag to previous.tag",
  );
  rejectsMutation(
    source,
    "wrong failed candidate",
    "  failed.tag !== expectedFailedTag ||\n",
    "",
    "rollback failed record must match the approved candidate SHA",
  );
  rejectsMutation(
    source,
    "deceptive digest repository",
    "value.startsWith(prefix)",
    "value.includes(prefix)",
    "rollback release digests must use an exact repository prefix",
  );
  rejectsMutation(
    source,
    "ignored migration failure",
    migrate,
    `${migrate} || true`,
    "rollback migrate must fail closed",
  );
  rejectsMutation(
    source,
    "reordered migration and API",
    `${migrate}\n${api}`,
    `${api}\n${migrate}`,
    "rollback command sequence must be exact with no reordered or extra commands",
  );
  rejectsMutation(
    source,
    "extra rollback command",
    `${migrate}\n${api}`,
    `${migrate}\ndocker compose --project-name markiro-production --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml restart\n${api}`,
    "rollback command sequence must be exact with no reordered or extra commands",
  );
});
