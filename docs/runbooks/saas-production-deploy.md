# SaaS production deploy and rollback

This runbook deploys one digest-pinned Markiro API/edge pair to the single-VM SaaS
production bundle. Run it from a protected deployment checkout at the approved
revision. It does not create cloud resources or authorize public exposure by
itself.

Use a dedicated operator account and a protected change record. Run every code
block with Bash, stop on the first non-zero exit, and do not improvise around a
failed gate. The deployment scripts deliberately emit lifecycle states and
sanitized command failures rather than provider stderr.

## Safety rules

- Never put secret values in tickets, chat, shell arguments copied into a
  ticket, or the rollout record. Do not attach an environment file, session
  cookie, activation link, API key, provider response containing credentials,
  or raw container log to a ticket or chat.
- Never run `docker compose config` without `--quiet`: rendered Compose output
  expands the environment file. The supported validation interface is
  `node deploy/production/preflight.mjs`; it invokes quiet Compose validation
  without printing the result.
- Do not hand-edit containers. Do not hand-edit production rows to repair a
  rollout or first-owner activation. Build a new digest-pinned release or use the
  documented CLI/workflow.
- Migrations are forward-only. Never reverse migrations and never run reverse
  SQL during application rollback.
- Keep `.markiro-releases/` at mode `0700` and every release record at mode
  `0600`. Treat the records as protected operational data because they contain
  registry references and deployment history.

## Common setup and hard gates

Set absolute paths and the approved release inputs. `MARKIRO_ROOT` must be the
protected checkout containing `compose.production.yml` and the production
scripts at the same approved revision.

```bash
set -euo pipefail
umask 077

export MARKIRO_ROOT=/opt/markiro/production-bundle
export MARKIRO_ENV_FILE=/etc/markiro/production.env
export MARKIRO_DOMAIN=app.example.ru
export ACME_EMAIL=ops@example.ru

read -r -p 'Approved 40-character git SHA: ' MARKIRO_IMAGE_TAG
read -r -p 'Approved API digest (sha256:...): ' MARKIRO_API_IMAGE_DIGEST
read -r -p 'Approved edge digest (sha256:...): ' MARKIRO_EDGE_IMAGE_DIGEST
export MARKIRO_IMAGE_TAG MARKIRO_API_IMAGE_DIGEST MARKIRO_EDGE_IMAGE_DIGEST

[[ "$MARKIRO_ROOT" = /* ]]
[[ "$MARKIRO_ENV_FILE" = /* ]]
[[ "$MARKIRO_IMAGE_TAG" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'STOP: the approved release must be a full lowercase 40-character SHA' >&2
  exit 1
}
[[ "$MARKIRO_API_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'STOP: approved API digest must be lowercase sha256 plus 64 hex characters' >&2
  exit 1
}
[[ "$MARKIRO_EDGE_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'STOP: approved edge digest must be lowercase sha256 plus 64 hex characters' >&2
  exit 1
}

cd "$MARKIRO_ROOT"
test -f compose.production.yml
test -f deploy/production/preflight.mjs
test "$(git rev-parse HEAD)" = "$MARKIRO_IMAGE_TAG" || {
  echo 'STOP: the deployment checkout is not the approved image revision' >&2
  exit 1
}
install -d -m 0700 .markiro-releases
```

Copy the SHA and both digest values only from the trusted GitHub Actions release
evidence created after both image pushes succeed. That evidence is the trust
boundary for selecting a preapproved repository digest. SHA tags are mutable
selectors and are retained only as the 40-character release identity; never
substitute a tag for either approved digest. Preflight rejects anything except
the approved full lowercase SHA, two lowercase `sha256:` digest selectors, an
accepted hostname/email, an accessible environment file at mode `0600`, and a
quiet, valid Compose model. Inspect metadata only; never print the file. The
branch below is executable under `set -e` on either supported operator platform.

```bash
case "$(uname -s)" in
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
}
```

Do not continue until an operator has independently opened the managed
PostgreSQL provider's backup view or approved CLI and verified the newest
successful backup belongs to this production database, is restorable, and is
fresh under the production RPO. This provider-neutral bundle cannot query that
control plane. Record the non-secret backup evidence ID and UTC creation time,
then enforce the approved maximum age locally:

```bash
export BACKUP_MAX_AGE_SECONDS=86400
read -r -p 'Verified managed PostgreSQL backup evidence ID: ' DB_BACKUP_EVIDENCE_ID
read -r -p 'Verified backup creation time (YYYY-MM-DDTHH:mm:ss.sssZ): ' DB_BACKUP_CREATED_AT
test -n "$DB_BACKUP_EVIDENCE_ID"
node -e '
  const value = process.argv[1];
  const maximumAge = Number(process.argv[2]);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    console.error("STOP: backup timestamp must be strict ISO-8601 UTC ending in Z");
    process.exit(1);
  }
  const created = new Date(value);
  const age = Date.now() - created.getTime();
  if (created.toISOString() !== value || !Number.isFinite(maximumAge) || age < 0 || age > maximumAge * 1000) {
    console.error("STOP: managed PostgreSQL backup is invalid or stale");
    process.exit(1);
  }
' "$DB_BACKUP_CREATED_AT" "$BACKUP_MAX_AGE_SECONDS"
```

Independently inspect the production object storage policy. Versioning must be
enabled, and retention/lifecycle plus recovery procedures must meet the
approved production policy for avatars and future catalog objects. Record
non-secret policy evidence, not credentials or bucket access URLs:

```bash
read -r -p 'Object storage versioning evidence ID: ' OBJECT_VERSIONING_EVIDENCE_ID
read -r -p 'Object storage retention/recovery evidence ID: ' OBJECT_RETENTION_EVIDENCE_ID
read -r -p 'Versioning and retention verified for the production bucket (yes/no): ' OBJECT_POLICY_VERIFIED
test -n "$OBJECT_VERSIONING_EVIDENCE_ID"
test -n "$OBJECT_RETENTION_EVIDENCE_ID"
test "$OBJECT_POLICY_VERIFIED" = yes || {
  echo 'STOP: object storage versioning/retention is not verified' >&2
  exit 1
}
```

The change record must also contain a reviewed statement that every migration
in the candidate is backward-compatible with the immediately previous API
image. Without that evidence, do not start the deployment: a later application
rollback would not be authorized.

## First deploy

For a new environment, complete the common gates, authenticate Docker to GHCR
through the approved credential helper, and confirm no unrecorded Markiro
containers are being adopted. There is no previous application tag on the
first deploy.

```bash
node deploy/production/preflight.mjs
node deploy/production/deploy.mjs
node deploy/production/smoke.mjs
```

Any non-zero migration, readiness, or smoke result rejects the release. Do not
provision a tenant and do not point public DNS at the host. `deploy.mjs` pulls
both preapproved repository digests, verifies the exact pulled identities,
writes a pending local release record, runs
the migration, starts API, waits for readiness, switches edge, runs public
smoke, and marks the record healthy only after every gate passes.

After success, select the record for this SHA and validate that it contains the
approved SHA plus the two exact approved digests. The values are
non-secret, but the complete record remains in the protected directory. Their
canonical prefixes are `ghcr.io/thevladbog/markiro-api@sha256:` and
`ghcr.io/thevladbog/markiro-edge@sha256:`; a tag-only value is not a digest.

```bash
RELEASE_RECORD="$(find .markiro-releases -maxdepth 1 -type f -name "*-${MARKIRO_IMAGE_TAG}.json" -print | sort | tail -n 1)"
test -n "$RELEASE_RECORD"
chmod 600 "$RELEASE_RECORD"
node - "$RELEASE_RECORD" "$MARKIRO_IMAGE_TAG" "$MARKIRO_API_IMAGE_DIGEST" "$MARKIRO_EDGE_IMAGE_DIGEST" <<'NODE'
const { readFileSync } = require("node:fs");
const [recordPath, approvedTag, approvedApiDigest, approvedEdgeDigest] = process.argv.slice(2);
const record = JSON.parse(readFileSync(recordPath, "utf8"));
const api = `ghcr.io/thevladbog/markiro-api@${approvedApiDigest}`;
const edge = `ghcr.io/thevladbog/markiro-edge@${approvedEdgeDigest}`;
if (record.tag !== approvedTag || record.state !== "healthy" || record.apiDigest !== api || record.edgeDigest !== edge) {
  throw new Error("STOP: healthy release record does not match the approved tag and both digests");
}
console.log(`release record verified: ${record.tag} ${record.apiDigest} ${record.edgeDigest}`);
NODE
```

Attach the 40-character SHA, API digest, edge digest, release-record protected
path, backup/policy evidence IDs, operator, and UTC time to the protected
rollout record. Do not copy the environment file or secrets.

### First-owner provisioning and smoke

Provision the first tenant owner only after API/edge health and the production
smoke above are green. The semantics, idempotency, activation renewal, and role
checks are defined in
[`docs/runbooks/cabinet-rbac-rollout.md`](cabinet-rbac-rollout.md). Collect the
three non-secret inputs with `read`, so their values are not typed as a command,
and run the compiled CLI from the same digest-pinned API image:

```bash
read -r -p 'Owner email: ' OWNER_EMAIL
read -r -p 'Tenant display name: ' TENANT_NAME
read -r -p 'Tenant slug: ' TENANT_SLUG

export PROTECTED_ROLLOUT_DIR=/var/lib/markiro/rollout-records
install -d -m 0700 "$PROTECTED_ROLLOUT_DIR"
OWNER_RESULT_FILE="$(mktemp "$PROTECTED_ROLLOUT_DIR/first-owner.XXXXXX")"
chmod 600 "$OWNER_RESULT_FILE"

docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml run --rm --no-deps api \
  node dist/cli/provision-tenant-owner.js \
  --email "$OWNER_EMAIL" \
  --tenant-name "$TENANT_NAME" \
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
NODE
```

Retain only `tenantId`, `userId`, `memberId`, and `deliveryId` in the protected
rollout record. Do not retain the activation token or setup link. Confirm the
activation email reached the intended mailbox, open the link without copying
it, set the first password, complete the structured profile, and verify the
owner can open the cabinet and `GET /api/access/me` reports the owner role.
Stop if delivery reaches the wrong address, activation fails, the tenant slug
belongs to a different first member, or any role smoke in the cabinet RBAC
runbook fails.

## Routine deploy

Before changing the release SHA or either digest selector, locate the newest healthy `0600` release
record, copy its `tag` into the protected change record as `previousTag`, and
keep both the file and image available through the observation window. Do not
select a failed/pending record or infer a digest from a registry tag.

Complete all common backup, object-storage, permissions, revision, and
backward-compatibility gates for the new SHA, then run:

```bash
node deploy/production/preflight.mjs
node deploy/production/deploy.mjs
node deploy/production/smoke.mjs
```

The bundled smoke verifies the cabinet root and assets, the auth boundary, and
that a station device route and kiosk route are not SPA fallbacks, plus health,
docs/OpenAPI, 1C protocol reachability, security headers, private/non-root API
runtime, and read-only root filesystem. It sends the exact unauthenticated 1C
probe body but does not claim authenticated backend body correlation. Complete
customer-specific authenticated station/kiosk and cabinet role smokes from
the cabinet RBAC runbook before closing the change.

Reject the release immediately if pull, migration, API readiness, edge start,
or smoke fails. Do not mark it healthy manually and do not provision another
first owner as part of a routine deploy.

The `migrate` service uses the exact same digest-pinned API image as `api`. If
migration fails before service replacement, `api` and `edge` containers are not
switched, but the migrator may already have committed a prefix of forward
migrations to the shared database. Treat that database as changed: the
compatibility and rollback gate still applies.

The current Compose project has one `api` service identity and one `edge`
service identity. Recreating the candidate API can leave the old edge proxying
an unavailable service, and replacing edge itself can interrupt requests. This
does not guarantee zero downtime. Rollback means recreate the previous digest
pair after the compatibility gate; a separately addressable blue/green
topology is the next availability slice and is not implemented here.

## Failure decision table

All log commands below are for local inspection. Review and redact credentials,
provider endpoints, cookies, personal data, and payloads before placing a
minimal excerpt in the protected incident record; never paste raw logs into
tickets or chat.

| Failure phase     | What remains running                                                                                                                                               | Safe local evidence                                                                                                                                                                           | Rollback                                                                                                                                            | Exact next command                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull              | The previous API and edge are unchanged; no candidate release record exists if digest resolution never completed.                                                  | `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml ps` and the sanitized deploy error.                                                                                  | Not needed; production images were not switched.                                                                                                    | After registry/network access is fixed and the same SHA remains approved: `node deploy/production/preflight.mjs`, then `node deploy/production/deploy.mjs`.                                        |
| Migration         | Previous API and edge remain running. A candidate record is `failed`; some forward migrations may already be committed.                                            | `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml logs --no-color --tail 200 migrate`; migration logs contain lifecycle/tag output, but still review before recording. | Do not reverse SQL. An image rollback is relevant only if another phase changed an image, and is allowed only with backward-compatibility evidence. | `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml logs --no-color --tail 200 migrate`; investigate database state and ship a reviewed forward fix—do not restart in a loop. |
| API readiness     | The candidate API container was recreated but is not ready; the existing edge image was not deliberately switched and may proxy the unavailable candidate service. | `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml ps` and `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml logs --no-color --tail 200 api`.    | Allowed only after the compatibility gate below.                                                                                                    | `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml logs --no-color --tail 200 api`; then enter **Rollback** if authorized.                                                   |
| Edge start        | The candidate API is ready; edge may be failed/stopped or partly replaced and public service is not accepted.                                                      | `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml ps` and `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml logs --no-color --tail 200 edge`.   | Allowed only after the compatibility gate below.                                                                                                    | `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml logs --no-color --tail 200 edge`; then enter **Rollback** if authorized.                                                  |
| Post-switch smoke | Candidate API and edge are running, but the release record is `failed` and the release is rejected.                                                                | Re-run `node deploy/production/smoke.mjs` once only to capture the stable failing gate; collect reviewed `api`/`edge` log tails locally.                                                      | Allowed only after the compatibility gate below.                                                                                                    | `node deploy/production/smoke.mjs`; if it remains non-zero, enter **Rollback** if authorized.                                                                                                      |

For every phase, a non-zero migration, readiness, or smoke result means reject,
not “accept with warning.” If migration compatibility cannot be proved, keep
the incident contained, block traffic as appropriate, and deliver a forward
fix; image rollback is not safe merely because a previous tag exists.

## Rollback

Rollback changes both images to the exact digests in the previous protected
release record; the previous SHA remains audit identity only. It never reverses
migrations. Before any rollback command, retrieve the failed candidate record
and the recorded previous healthy release from `.markiro-releases/`. Verify
both files are regular `0600` records and that the failed release's migrations
are backward-compatible with the previous API image. Record the compatibility
review ID.

```bash
read -r -p 'Failed candidate release record path: ' FAILED_RELEASE_RECORD
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
  const prefix = `${repository}@sha256:`;
  return typeof value === "string" && value.startsWith(prefix) && /^[0-9a-f]{64}$/.test(value.slice(prefix.length));
};

function readProtectedRecord(label, path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`STOP: ${label} release record must be a regular non-symlink 0600 file`);
  }
  const canonicalPath = realpathSync(path);
  if (dirname(canonicalPath) !== releaseDirectory) {
    throw new Error(`STOP: ${label} release record is outside the protected release directory`);
  }
  const record = JSON.parse(readFileSync(canonicalPath, "utf8"));
  if (
    typeof record.createdAt !== "string" ||
    new Date(record.createdAt).toISOString() !== record.createdAt ||
    basename(canonicalPath) !== `${record.createdAt.replace(/[:.]/g, "-")}-${record.tag}.json`
  ) {
    throw new Error(`STOP: ${label} release record filename or timestamp is invalid`);
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
node deploy/production/preflight.mjs
```

Pull the previous images, then confirm their resolved digests still match the
protected record using the same `docker image inspect` interface as
`deploy.mjs`. Stop on either mismatch. Continue the rollback in this exact
order—forward migrator, API, bounded readiness, edge, smoke:

```bash
docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml pull api edge

ACTUAL_API_DIGESTS="$(docker image inspect --format '{{json .RepoDigests}}' "ghcr.io/thevladbog/markiro-api@${MARKIRO_API_IMAGE_DIGEST}")"
ACTUAL_EDGE_DIGESTS="$(docker image inspect --format '{{json .RepoDigests}}' "ghcr.io/thevladbog/markiro-edge@${MARKIRO_EDGE_IMAGE_DIGEST}")"
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

docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml run --rm migrate
docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml up -d --no-deps api

READY=0
for attempt in $(seq 1 30); do
  if docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml exec -T api \
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

docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml up -d --no-deps edge
node deploy/production/smoke.mjs
```

Stop immediately if the forward migrator, readiness loop, edge start, or smoke
fails. Do not hand-edit containers, do not hand-edit production rows, and do
not retry a failing migration in a loop. Record the rollback tag, both recorded
digests, compatibility evidence ID, commands' exit status, and UTC times in the
protected rollout record.

## Observation window

Before deployment, record an explicit observation-window end time based on the
production change policy. Through that time:

- retain the previous tag and release record together with the candidate
  release record; do not delete either file or prune either image;
- keep backup, object-policy, compatibility, deploy/rollback, smoke, and
  first-owner identifier evidence in the protected rollout location;
- watch API readiness, edge availability/TLS, job failures, mail delivery, S3
  errors, error rate, and customer-critical station/kiosk flows;
- re-run `node deploy/production/smoke.mjs` after any infrastructure change;
- keep public DNS blocked unless the separate gate below is satisfied.

Only the approved retention process may remove previous release artifacts
after the observation window and incident-free sign-off.

## Public DNS go-live gate

The standard Caddy image cannot satisfy the public abuse-control gate: it has
no standard rate-limit directive. Do not create or switch public DNS until one
of these alternatives is deployed and evidenced in front of anonymous routes:

1. a provider/WAF policy with both per-source limits and a global
   anonymous-route limit; or
2. a separately reviewed reproducible custom Caddy image with an exact source
   revision, SBOM, vulnerability scan, and the same per-source/global policy.

The evidence must include rule/revision IDs, the anonymous routes covered,
configured thresholds, UTC test time, and observed allow/throttle behavior.
Application-specific database limits are only a backstop and do not satisfy
this gate. A successful production smoke alone does not satisfy it.

```bash
read -r -p 'Rate-limit control (provider-waf/reviewed-custom-caddy): ' RATE_LIMIT_CONTROL
case "$RATE_LIMIT_CONTROL" in
  provider-waf|reviewed-custom-caddy) ;;
  *) echo 'STOP: no approved public edge rate-limit control' >&2; exit 1 ;;
esac
read -r -p 'Rate-limit verification evidence ID: ' RATE_LIMIT_EVIDENCE_ID
read -r -p 'Per-source and global anonymous-route limits tested (yes/no): ' RATE_LIMITS_VERIFIED
test -n "$RATE_LIMIT_EVIDENCE_ID"
test "$RATE_LIMITS_VERIFIED" = yes || {
  echo 'STOP: do not publish public DNS without verified rate limits' >&2
  exit 1
}
node deploy/production/smoke.mjs
```

After this gate is green, use the separately approved provider DNS change
procedure. This repository intentionally provides no fictional provider
command. Record the DNS change, rate-limit evidence, and post-change smoke in
the protected rollout record.
