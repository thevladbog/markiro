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

## Protected workflow and private runner boundary

Normal production delivery uses `.github/workflows/deploy-production.yml`. It
accepts only an explicit dispatch naming the exact successful release run ID
and commit, or a successful `Publish production images` `workflow_run` from
`main`. The protected `production` environment must approve the controller,
one-use deploy job, and independent cleanup job. A pull request, tag-shaped
image selector, mutable runner label, or a different release workflow is not a
deployment source.

Populate the bootstrap-created runner-registration Lockbox container out of
band with exactly one text entry named `GITHUB_RUNNER_ADMIN_TOKEN`. Prefer a
GitHub App installation token (a GitHub App user token is also supported). For
the MVP only, a fine-grained PAT is an accepted fallback when it is restricted
to the `thevladbog/q` repository and grants only repository
`Administration: write`, which GitHub requires for repository JIT configuration
and forced stale-runner deletion. Rotate it out of band. Do not copy this token
into a GitHub repository or environment secret, Terraform, cloud-init, VM
metadata, or a ticket. The runner and GitHub-hosted cleanup fetch it directly,
mask it, retain it only in bounded `/run` or runner-temporary files at mode
`0600`, and delete those files before shutdown. Never enable provider or shell
debugging around this flow.

The existing exact `repo:thevladbog/q:environment:production` Terraform
credential remains the production controller credential; the distinct
`production-infrastructure` credential remains unchanged. A second credential
with the same exact `production` subject targets only the runner service
account so GitHub-hosted cleanup can read the runner-only Lockbox payload and
stop the exact runner VM even when the private job never starts. That service
account has `compute.operator` on the runner VM itself, not the folder, and
`compute.osAdminLogin` on the app VM. Yandex provider 0.215.0 has no
load-balancer-resource IAM-binding resource, so read-only `alb.viewer` at folder
scope is the documented provider limitation used only for the post-switch
target-state gate.

The private VM installs GitHub Actions runner `2.336.0` for Linux x64 only after
verifying the official SHA-256
`04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d`.
It installs Yandex Cloud CLI `1.23.0` from the exact official versioned object
`https://storage.yandexcloud.net/yandexcloud-yc/release/1.23.0/linux/amd64/yc`
only after verifying SHA-256
`3e287905b63685847aa77f17f92bf7156037cc63b9a42c6cd901db69a61604c9`,
then requires `yc version --semantic` to equal `1.23.0`. Yandex's official
installer currently selects a mutable stable version and performs a version
check, but Yandex publishes no digest or signature beside this object. The
recorded checksum was measured locally from the exact HTTPS object; it is a
repository-controlled integrity pin, not a vendor-attested checksum.

To upgrade `yc`, two reviewers must independently download the exact versioned
official Linux AMD64 object, independently calculate and compare SHA-256, and
review the reported semantic version. Update the version, object path, checksum,
mutation contract, runbook, and task evidence in one protected change. Never
substitute `release/stable`, `latest`, an unversioned archive, or an installer
whose selected version is resolved at boot.

On each controller-started boot it generates a new deployment ID, requests one
JIT configuration with the matching `markiro-deployment-<id>` label, executes
at most one job, removes registration material, and powers off. The deploy job
exports a one-hour OS Login certificate for the runner service-account profile,
uses only the app VM internal address, and transfers no SSH static key. Configure
`YC_RUNNER_OS_LOGIN` and `YC_ORGANIZATION_ID` for that exact OS Login profile;
there must be no public address on either VM.

The app VM emits only its OpenSSH public host keys as bounded
`MARKIRO_SSH_HOST_KEY` records on the serial console during cloud-init. Before
starting delivery, the controller reads that output through the authenticated
Yandex Compute `serialPortOutput` API using the already-gated short-lived IAM
token. It passes the validated public keys to the private runner, which writes an
exact private `known_hosts` file for the app's internal IP and requires
`StrictHostKeyChecking=yes`. `accept-new`, empty trust stores, and Terraform- or
workflow-managed SSH private keys are prohibited.

Before starting the runner, the controller validates the exact release run,
manifest SHA/digests, app/runner state, fresh managed PostgreSQL backup, and
current ALB target health. The transferred archive contains only
`compose.production.yml`, `deploy/production`, and the validated immutable
`release-manifest.json`, rooted at `/opt/markiro/releases/<commit>`. Runtime
Lockbox refresh and production preflight precede digest pulls; migration
precedes either service switch. Remote `prepare` leaves an append-only pending
candidate only after the candidate API and edge both pass local readiness. The
runner then checks ALB target health and performs the public smoke contract;
only remote `finalize` may mark that exact pending tag and digest pair healthy.
A migration failure switches nothing. Any post-switch local-readiness, ALB,
external-smoke, or finalize failure invokes remote `rollback`, which validates
the exact pending record, redeploys the exact previous healthy API and edge
digest pair without another migration, and verifies both restored services
locally before recording the candidate failed. Pending, healthy, and failed
records are private, exclusive, and never overwritten. The
GitHub-hosted `cleanup` job runs with `always()`, deregisters a stale runner when
present, and stops the VM independently. Cleanup failures are alerted without
replacing the primary deployment failure.

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
first deploy. Complete the **Public DNS go-live gate** below before changing
DNS. In particular, the protected ingress must already enforce the approved
rate limits and maintenance/deny policy while allowing only the recorded
operator or synthetic source used by deployment smoke.

Record the pre-DNS controls. `caddy-acme` means Caddy terminates TLS, so the
provider must transparently pass the ACME HTTP-01 challenge on public port 80
to Caddy without authentication, redirects, or a maintenance response on that
challenge path. `provider-preprovisioned` means the provider terminates TLS;
that path is permitted only with separately reviewed evidence for its
pre-provisioned certificate and custom-edge procedure.

```bash
read -r -p 'Rate-limit verification evidence ID: ' RATE_LIMIT_EVIDENCE_ID
read -r -p 'Per-source and global anonymous-route limits tested (yes/no): ' RATE_LIMITS_VERIFIED
test -n "$RATE_LIMIT_EVIDENCE_ID"
test "$RATE_LIMITS_VERIFIED" = yes

read -r -p 'Maintenance/deny policy evidence ID: ' MAINTENANCE_DENY_EVIDENCE_ID
read -r -p 'Public application traffic is denied while ACME remains possible (yes/no): ' MAINTENANCE_DENY_VERIFIED
test -n "$MAINTENANCE_DENY_EVIDENCE_ID"
test "$MAINTENANCE_DENY_VERIFIED" = yes

read -r -p 'Allowlisted smoke source evidence ID: ' SMOKE_SOURCE_EVIDENCE_ID
read -r -p 'Operator/synthetic smoke source is allowlisted (yes/no): ' SMOKE_SOURCE_ALLOWLISTED
test -n "$SMOKE_SOURCE_EVIDENCE_ID"
test "$SMOKE_SOURCE_ALLOWLISTED" = yes

read -r -p 'TLS termination mode (caddy-acme/provider-preprovisioned): ' TLS_TERMINATION_MODE
case "$TLS_TERMINATION_MODE" in
  caddy-acme)
    read -r -p 'ACME HTTP-01 pass-through evidence ID: ' ACME_PASSTHROUGH_EVIDENCE_ID
    read -r -p 'ACME HTTP-01 challenge pass-through verified on public port 80 (yes/no): ' ACME_PASSTHROUGH_VERIFIED
    test -n "$ACME_PASSTHROUGH_EVIDENCE_ID"
    test "$ACME_PASSTHROUGH_VERIFIED" = yes
    ;;
  provider-preprovisioned)
    read -r -p 'Pre-provisioned certificate evidence ID: ' PREPROVISIONED_CERT_EVIDENCE_ID
    read -r -p 'Reviewed custom-edge procedure evidence ID: ' CUSTOM_EDGE_PROCEDURE_EVIDENCE_ID
    test -n "$PREPROVISIONED_CERT_EVIDENCE_ID"
    test -n "$CUSTOM_EDGE_PROCEDURE_EVIDENCE_ID"
    ;;
  *) echo 'STOP: TLS bootstrap path is not approved' >&2; exit 1 ;;
esac
TLS_BOOTSTRAP_VERIFIED=yes
```

Only after those checks are green, use the approved provider procedure to
create or switch DNS to the protected ingress. This repository intentionally
contains no provider mutation command. Record the change, then verify the
exact normalized A and AAAA answer sets through both an explicit authoritative
server and every approved public recursive resolver. Enter unique,
comma-separated addresses, or the exact word `none` for an unused address
family; at least one family must contain an address. CNAME is not supported by
this procedure. If the protected ingress requires CNAME, stop and obtain a
separately reviewed verifier and rollout policy rather than silently accepting
a different record shape.

```bash
read -r -p 'DNS change evidence ID: ' DNS_CHANGE_EVIDENCE_ID
read -r -p 'Authoritative DNS server: ' MARKIRO_AUTHORITATIVE_DNS_SERVER
read -r -p 'Approved public DNS resolvers (comma-separated): ' MARKIRO_PUBLIC_DNS_RESOLVERS
read -r -p 'Approved A addresses (comma-separated or none): ' MARKIRO_APPROVED_DNS_A
read -r -p 'Approved AAAA addresses (comma-separated or none): ' MARKIRO_APPROVED_DNS_AAAA
test -n "$DNS_CHANGE_EVIDENCE_ID"
export MARKIRO_AUTHORITATIVE_DNS_SERVER MARKIRO_PUBLIC_DNS_RESOLVERS
export MARKIRO_APPROVED_DNS_A MARKIRO_APPROVED_DNS_AAAA
node deploy/production/verify-dns.mjs
unset MARKIRO_AUTHORITATIVE_DNS_SERVER MARKIRO_PUBLIC_DNS_RESOLVERS
unset MARKIRO_APPROVED_DNS_A MARKIRO_APPROVED_DNS_AAAA
```

The verifier queries both address families and requests answer and authority
sections. Its authoritative queries use `+norecurse` and require `NOERROR` plus
the QR and AA flags. Public queries use `+recurse` and require `NOERROR` plus
the QR and RA flags on every public A and AAAA response. For a non-empty
approved family, every A/AAAA RR owner must match the requested domain after
case-insensitive comparison and optional trailing-dot normalization, and the
normalized address set must match exactly. For an approved empty family, both
the authoritative and public response must instead prove NODATA: zero answer
records and a SOA-only authority section containing one or more SOA records;
every SOA owner must be the requested domain or a label-boundary ancestor. An
NS-only or mixed SOA-plus-NS referral is not NODATA proof. Every accepted result
must be the final non-truncated response: the TC flag or a `dig`
truncation/retry diagnostic fails. A cache answer at the authoritative gate,
unrelated or suffix-confusion SOA owner, missing or inconsistent header counts,
parser warning, `SERVFAIL`, malformed record, and unsupported answer type
including CNAME all fail closed.
Comparison is order-independent and TTL-independent; repeated identical DNS
answer rows normalize to one set member, while duplicate approved operator
inputs are rejected. Verification retries the complete gate at most 30 times
with a two-second interval, and each `dig` process is bounded to five seconds.
A mismatch after that budget stops before edge start.

Ports 80 and 443 at the protected ingress must now reach the selected TLS
bootstrap path. Start the release exactly once:

```bash
node deploy/production/preflight.mjs
node deploy/production/deploy.mjs
```

`deploy.mjs` pulls both preapproved repository digests, verifies the exact
pulled identities, writes a pending local release record, runs the migration,
starts API, waits for readiness, starts edge, then performs bounded edge/TLS
readiness polling against `/health/live`. Transient connection, TLS, and HTTP
status failures are retried within that stage's 180-second default budget.
Only after readiness is green does it run exactly one full production smoke
from the allowlisted source and mark the record healthy. Do not invoke
`smoke.mjs` separately in this sequence.

Any non-zero migration, API readiness, edge start, edge/TLS readiness, or smoke
result rejects the release. Do not provision a tenant and do not open public
application traffic. On failure, leave maintenance/deny active or withdraw DNS
with the approved provider procedure; never expose a failed or unverified
release.

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

Only after the healthy record is verified may an operator use the approved
provider procedure to open public application traffic. Record that separately;
the repository deliberately supplies no fictional provider command.

```bash
read -r -p 'Public traffic opened evidence ID: ' PUBLIC_TRAFFIC_OPENED_EVIDENCE_ID
test -n "$PUBLIC_TRAFFIC_OPENED_EVIDENCE_ID"
```

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

Routine deploy assumes public DNS and valid TLS already exist at the protected
ingress. It also assumes the approved provider/WAF or reviewed custom-Caddy
rate limits remain enforced. If DNS, TLS termination, ACME routing, ingress
policy, or the allowlist changes, treat that as a separately approved
infrastructure change and re-enter the relevant first-deploy gates.

Before changing the release SHA or either digest selector, locate the newest healthy `0600` release
record, copy its `tag` into the protected change record as `previousTag`, and
keep both the file and image available through the observation window. Do not
select a failed/pending record or infer a digest from a registry tag.

Complete all common backup, object-storage, permissions, revision, and
backward-compatibility gates for the new SHA, then run:

```bash
node deploy/production/preflight.mjs
node deploy/production/deploy.mjs
```

After edge/TLS readiness is green, `deploy.mjs` runs exactly one full smoke. It
verifies the cabinet root and assets, the auth boundary, and
that a station device route and kiosk route are not SPA fallbacks, plus health,
docs/OpenAPI, 1C protocol reachability, security headers, private/non-root API
runtime, and read-only root filesystem. It sends the exact unauthenticated 1C
probe body but does not claim authenticated backend body correlation. Complete
customer-specific authenticated station/kiosk and cabinet role smokes from
the cabinet RBAC runbook before closing the change.

Reject the release immediately if pull, migration, API readiness, edge start,
edge/TLS readiness, or smoke fails. Do not mark it healthy manually and do not
provision another first owner as part of a routine deploy.

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

| Failure phase      | What remains running                                                                                                                                               | Safe local evidence                                                                                                                                                                           | Rollback                                                                                                                                            | Exact next command                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull               | The previous API and edge are unchanged; no candidate release record exists if digest resolution never completed.                                                  | `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml ps` and the sanitized deploy error.                                                                                  | Not needed; production images were not switched.                                                                                                    | After registry/network access is fixed and the same SHA remains approved: `node deploy/production/preflight.mjs`, then `node deploy/production/deploy.mjs`.                                        |
| Migration          | Previous API and edge remain running. A candidate record is `failed`; some forward migrations may already be committed.                                            | `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml logs --no-color --tail 200 migrate`; migration logs contain lifecycle/tag output, but still review before recording. | Do not reverse SQL. An image rollback is relevant only if another phase changed an image, and is allowed only with backward-compatibility evidence. | `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml logs --no-color --tail 200 migrate`; investigate database state and ship a reviewed forward fix—do not restart in a loop. |
| API readiness      | The candidate API container was recreated but is not ready; the existing edge image was not deliberately switched and may proxy the unavailable candidate service. | `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml ps` and `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml logs --no-color --tail 200 api`.    | Allowed only after the compatibility gate below.                                                                                                    | `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml logs --no-color --tail 200 api`; then enter **Rollback** if authorized.                                                   |
| Edge start         | The candidate API is ready; edge may be failed/stopped or partly replaced and public service is not accepted.                                                      | `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml ps` and `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml logs --no-color --tail 200 edge`.   | Allowed only after the compatibility gate below.                                                                                                    | `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml logs --no-color --tail 200 edge`; then enter **Rollback** if authorized.                                                  |
| Edge/TLS readiness | Candidate API and edge were started, but the public HTTPS liveness endpoint did not become ready inside its bounded stage timeout.                                 | The sanitized deploy error's last cause (`HTTP nnn` or connection/TLS) and reviewed `edge` log tails; do not copy certificate account data.                                                   | Allowed only after the compatibility gate below.                                                                                                    | Keep maintenance/deny active; inspect `docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml logs --no-color --tail 200 edge`, then enter **Rollback** if authorized.            |
| Post-switch smoke  | Candidate API and edge are HTTPS-ready, but the single deploy-owned full smoke failed; the release record is `failed` and the release is rejected.                 | Retain the sanitized failed-smoke gate and collect reviewed `api`/`edge` log tails locally. Do not run another full smoke against the rejected release.                                       | Allowed only after the compatibility gate below.                                                                                                    | Keep maintenance/deny active and enter **Rollback** if authorized.                                                                                                                                 |

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
- require a separately approved, allowlisted smoke after any later
  infrastructure change;
- keep maintenance/deny active until the healthy release and traffic-open
  evidence are both recorded.

Only the approved retention process may remove previous release artifacts
after the observation window and incident-free sign-off.

## Public DNS go-live gate

The standard Caddy image cannot satisfy the public abuse-control gate: it has
no standard rate-limit directive. Before a first-deploy DNS change, one of
these alternatives must be deployed and evidenced in front of anonymous
routes:

1. a provider/WAF policy with both per-source limits and a global
   anonymous-route limit; or
2. a separately reviewed reproducible custom Caddy image with an exact source
   revision, SBOM, vulnerability scan, and the same per-source/global policy.

The evidence must include rule/revision IDs, the anonymous routes covered,
configured thresholds, UTC test time, and observed allow/throttle behavior.
Application-specific database limits are only a backstop and do not satisfy
this gate. A successful production smoke alone does not satisfy it.

Before DNS changes, the same protected ingress must enforce maintenance/deny
for public application traffic, allowlist the operator or synthetic smoke
source, and keep the required certificate bootstrap path reachable. If Caddy
terminates TLS, the ACME HTTP-01 challenge must be transparent pass-through on
public port 80 to Caddy. If the provider terminates TLS, use a separately
verified pre-provisioned certificate and reviewed custom-edge procedure. The
repository intentionally provides no DNS, WAF, certificate, or other provider
command.

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
  echo 'STOP: verified rate limits are required before the DNS change' >&2
  exit 1
}
```

After this gate is green, follow the exact first-deploy sequence: verify the
maintenance/deny and allowlist controls, verify the selected TLS bootstrap,
change DNS through the approved provider procedure, perform bounded
authoritative and public DNS verification, and only then run `deploy.mjs`.
Public application traffic opens only after its healthy release record exists.
