# Timeweb platform preparation

Status: portable preparation plus a protected image publisher. This package has
no host deployment executor. No server, DNS, mail routing, production database or
bucket is changed by configuration preflight or image publication. Infrastructure
approval and protected host deployment remain separate gates. See
[the migration checklist](timeweb-migration.md).

## Package and immutable identities

`deploy/platform/compose.yml` contains only migration, API and edge services. The
API uses the existing `deploy/production/api.Dockerfile`, healthcheck, read-only
root, dropped capabilities and unprivileged runtime. Its `SERVER_PROFILE` is
literally `platform-only`. Only edge exposes ports. The base profile keeps the database and object bucket as external private
resources. The optional compact overlay below places PostgreSQL on the same VM.
Endpoint syntax does not prove network isolation or bucket ACLs.

`deploy/platform/edge.Dockerfile` builds only SaaS-admin and landing. It pins
`VITE_SERVER_PROFILE=platform-only` before the SaaS build and preserves the
network-disabled PDF/A legal artifact verifier and production attestation. The
image identity is `ghcr.io/thevladbog/markiro-platform-edge`, distinct from the
legacy `markiro-edge`. Landing canonical URLs and legal verification links remain
unchanged. SmartCaptcha and analytics remain separate optional external services.

Platform manifest version 1 has exactly these fields: `version`, `serverProfile`,
`uiProfile`, `sourceSha`, `toolingSha`, `api`, `edge`, `workflowRunId`, `createdAt`.
Both profiles equal `platform-only`; SHAs are full lowercase commits; images are
repository-bound sha256 references. The parser reuses legacy immutable
image/run/date validation. Legacy manifest parsing rejects this schema, so it
cannot be fed into the existing production deployment path. Synthetic CI uses
placeholder runtime digests and local SHA tags. Only the protected publisher
below creates release evidence and real registry digest references.

The `release-images.yml` trigger and Node validation now include this package;
its exact legacy manifest, published outputs and `deploy-production.yml` remain
unchanged. The platform edge is built and exercised by the mandatory PR/main CI
bundle job; that legacy publisher exports only the verified legacy images. The
separate `release-platform-images.yml` publishes the platform images after
approval, and does not deploy them. Do not invoke
`deploy/yandex/remote-deploy.mjs` as a shortcut; it has unrelated host and
secret-management responsibilities.

## Protected runtime configuration

Use `deploy/platform/env.example` as the variable inventory. The actual file must
be an explicit absolute path, owned by the executing operator, regular (no file
symlink/hardlink), and mode 0600 or stricter. A system `/tmp` directory alias is
allowed; the final file may not be a symlink. Do not put the runtime file in the
repository, print it, render Compose to shared logs, or source it as shell code.
`KEY=literal-value` syntax is deliberate: no quotes, `export`, interpolation,
multiline values or duplicate keys. Compose uses `env_file.format: raw` so `$` in
credentials is preserved. Require Docker Compose supporting raw env files and
`!override` in the test overlay (2.30 or later).

The preflight deliberately validates TLS-verified PostgreSQL only. Both the base
external-PG profile and compact local-PG overlay preserve that requirement.
Plaintext PostgreSQL is exercised only by the synthetic CI overlay; that overlay
is never a production alternative. Do not remove TLS checks to make startup pass.

The portable preflight is read-only and does not contact infrastructure:

```sh
node deploy/platform/preflight.mjs /absolute/protected/runtime.env /absolute/platform-manifest.json EXPECTED_RUN_ID
```

It checks profile/source/tooling/digest bindings, distinct exact domains and
origins, PostgreSQL `sslmode=verify-full`, exact HTTPS object storage origins,
SMTP TLS settings, required credentials and optional demo/support configuration.
It prints only success or a generic error, never values. There is no metadata,
Lockbox or implicit env-file fallback. Host execution remains deferred; a future
executor must carry this validated file into Compose explicitly and prevent
ambient shell variables from overriding validated image/origin values. If an
endpoint needs a new provider CA, prepare and verify an explicit read-only trust
mount; the reused image's bundled Yandex CA is not proof of Timeweb trust.

`S3_PUBLIC_ORIGIN` is the exact image/presigned origin in SaaS CSP. Path-style
addressing requires it to equal `S3_ENDPOINT`; virtual-host style requires the
bucket-prefixed endpoint origin. The current API presigner has no separate public
endpoint rewrite, so a private endpoint cannot be paired with an unrelated public
origin. Verify signed image downloads separately.
The bucket remains private. Do not use a wildcard, append a path or insert a CSP
directive. The edge entrypoint independently rejects whitespace/control
characters, malformed domains, profile mismatch and source SHA mismatch syntax
before Caddy parses environment substitutions.

Legacy session/pairing secrets are not required or accepted in this package.
The existing `PLATFORM_AUTH_SECRET`, mail encryption key, standalone license
issuer/KID/keyset and support keys must retain their identities where restored
rows or previously issued licenses depend on them. Record protected fingerprints
against the backup manifest before boot; syntax checks cannot establish key
continuity. Set all four standalone license fields together: issuer, KID,
`STANDALONE_LICENSE_PRIVATE_KEY_PEM` and `STANDALONE_LICENSE_KEYSET_JSON`. The
private PEM is a separate single-line value using literal `\n` separators; the
API decodes them. The JSON keyset contains public JWK keys only. Do not put the
private PEM inside that strict public keyset. Preserve other encrypted-data keys
needed by retained history.

## Routes and retirement

SaaS serves `/api/platform/*` and `/api/platform-auth/*`. Landing serves only POST
`/api/demo-requests` to the API; disabled submissions return their existing public
404 contract. Unknown `/api` requests and legacy device/auth/docs routes are
rejected before SPA fallback. Only GET/HEAD may use the SaaS SPA.

The configured exact former admin and kiosk domains serve an HTML retirement
notice to browser GET/HEAD requests, with HTTP 410. Known machine/API paths and
all unsafe methods return JSON 410 even when Accept includes HTML. Retirement
works on HTTP and HTTPS without redirecting POST bodies. It does not replay or
migrate old local queues. Confirm operator communication and old device queue
retention before eventual DNS change. There is no wildcard host or vbtech
upstream in this bundle.

## Optional compact local PostgreSQL runtime

Compose `deploy/platform/compose.yml` **first**, followed by
`deploy/platform/compose.compact.yml`. The base profile remains usable alone for
external PostgreSQL. The compact overlay is local preparation, not a Timeweb host
dispatch or executor. Never add `compose.ci.yml` to a production composition. Images are built and verified in CI, never on the target
VM; API/edge immutable digest and source/tooling bindings still pass preflight.

| Service                               | Memory limit | CPU quota | Node heap |
| ------------------------------------- | -----------: | --------: | --------: |
| API                                   |     1536 MiB |      1.25 |  1024 MiB |
| PostgreSQL 17                         |     1024 MiB |       0.5 |         — |
| Edge                                  |      192 MiB |      0.25 |         — |
| Migration, separate stopped-API phase |      512 MiB |       1.5 |   384 MiB |

Steady-state limits sum to 2752 MiB and 2 CPUs. A 4096 MiB VM retains
1344 MiB for its OS, Docker, filesystem cache and unallocated runtime headroom.
The limits are a budget, not measured peak RSS or capacity acceptance. Migration
runs with PostgreSQL only (2 CPUs combined), with API and edge stopped. Heap is
not total RSS. No CRM, Chatwoot, n8n, Redis or build process shares this budget.
All four services rotate Docker JSON logs at 10 MiB × 3 files per service.

The production platform bootstrap caps the shared Drizzle/API/platform-auth pool
at 6 connections. Better Auth receives that same `db`; it creates no separate
PostgreSQL pool. The platform pg-boss pool is capped at 4 plus its one dedicated
LISTEN client: up to 11 application connections in steady state. Seven platform
workers (nine with transcript support) keep their current one-job defaults. The
report worker explicitly sets `batchSize: 1, localConcurrency: 1` so only one
renderer runs in this single API process. Other queue types can run concurrently;
this is not a global worker semaphore. Legacy profile pool/worker behavior stays
unchanged. The migration runner checks out one client for its complete session;
its pool opens no other connections. CLI/backup/restore sessions are separate and
must not compete with active migrations or exceed the remaining connection budget.

PostgreSQL uses a persistent `postgres-data` named volume and a private internal
`database` network, reachable by API/migration as `db.private:5432`; it publishes
no host port. Edge is not attached to that network. API/migration also retain the
default network for SMTP/S3. PostgreSQL uses 32 connection slots, 256 MiB shared
buffers, 4 MiB work memory per operation, 64 MiB maintenance memory, 32 MiB per
autovacuum worker and a 256 MiB shared-memory mount. Work memory is not a global
cap. WAL targets are 80 MiB minimum/1 GiB maximum; `max_wal_size` is a soft target,
not a disk quota. `fsync`, full-page writes and synchronous commit remain on.
The root is read-only, capabilities dropped and runtime user is Alpine postgres
UID/GID 70. No host path is auto-created for a missing trust/secret mount.

The inventory's five `MARKIRO_POSTGRES_*` variables select an approved immutable
`postgres:17-alpine@sha256:…` digest and existing absolute paths for the CA,
server certificate, server private key and bootstrap password file. Verify the
actual PG17 patch level and UID/GID of the approved digest before dispatch.
The CA is mounted read-only at `/run/markiro-postgres/ca.crt` in both API and
migration. The server certificate/key are mounted only in PostgreSQL, read-only.
The certificate must chain to that CA, be valid for server authentication and
include the exact DNS SAN `db.private`. Both clients use a URL of this shape:

```text
postgresql://APP_ROLE:URL_ENCODED_PASSWORD@db.private:5432/markiro?sslmode=verify-full&sslrootcert=/run/markiro-postgres/ca.crt
```

The HBA file requires peer authentication for local sockets, rejects all non-TLS
TCP and allows TLS TCP only with SCRAM. The bootstrap `postgres` superuser uses
its separate file password. Before restore/migration, provision the intended
application/migration roles and grants through the approved operator procedure;
do not use that bootstrap superuser in the production API URL. The image's init
variables apply only to a new empty volume and do not rotate restored roles or
passwords. Preserve role ownership, extensions and restore permissions. The server
key must be owned by 70:70 mode 0600, or root:70 mode 0640 (PG's root-owned key
exception). Make the bootstrap password file readable only by the required
operator/PostgreSQL identity, and the public certificate/CA readable by runtime
users (API image uses uid 1000). Validate mount ownership on the Linux target;
Mac bind-mount permission behavior is not that proof. Production CA/keys are
supplied by the protected operator process; this package generates none.

For a future approved operation, carry the validated protected runtime file into
Compose explicitly. Reject ambient variable overrides; do not source the file,
print expanded `compose config`, or pass secret values in CLI arguments. The
following command prefix illustrates a clean environment and explicit composition
from the repository root; `--env-file` supplies only Compose interpolation, while
the services' raw `env_file` preserves literal credential dollars:

```sh
env -i PATH="$PATH" MARKIRO_PLATFORM_ENV_FILE=/absolute/protected/runtime.env docker compose \
  --env-file /absolute/protected/runtime.env -p markiro-platform \
  -f deploy/platform/compose.yml -f deploy/platform/compose.compact.yml config --quiet
```

After protected preflight, manifest/image verification, backup/restore acceptance
and explicit deployment approval, use the same prefix/composition for each lifecycle
step. Advance only on success: stop `edge api`; verify no API container or other
writer/legacy worker remains; start/wait only `postgres`; run migration with
`run --rm --no-deps migrate`; after successful migration start/wait `api` with
`up -d --wait --no-deps api`, then `up -d --no-deps edge`. If migration fails, keep
API/edge stopped and retain logs/volume for recovery. Never invoke unqualified
`compose up` on an active stack: its migrate dependency does not stop an already
running API. Never run migration alongside API, and never scale this API beyond
one instance within the budget. A first bootstrap also uses these separate phases.
Stopping/removing containers must preserve named volumes; do not use `down -v`.

A 50 GiB disk is conditional on measured restored database/index size, image
retention, WAL/temp growth, log growth, free-space alarms and restore workspace.
A compressed dump is not the restored size. Keep meaningful free-space headroom;
if the rehearsal cannot fit the database plus temporary restore/index/WAL space,
choose a larger disk before deployment. Do not rely on WAL targets or log rotation
as hard total-disk limits. Back up the database (including role/ownership metadata),
private S3 objects and required encryption/signing/configuration identities to
immutable encrypted storage **outside this VM**, with a separately recoverable
copy outside the hosting account. VM snapshots and the local data volume do not
replace those copies. Verify a fresh isolated restore, exact migration journal,
constraints, sequences and artifact hashes before cutover. Do not delete older
archives to make a rehearsal fit; do not copy a live PGDATA directory as a backup.

## Local verification and CI

Run Node contracts and the existing production/CI gates:

```sh
node --test deploy/platform/test/*.test.mjs
corepack pnpm test:production-bundle:contract
corepack pnpm test:ci-policy
corepack pnpm format:check
```

The mandatory production-bundle CI job builds the platform edge separately and
reuses its already-built API. After the legacy stack has been removed, it runs
`node deploy/platform/ci-stack.mjs --local-ci` with the local image source SHA.
This harness verifies a local Unix Docker endpoint, uses a unique project,
synthetic credentials in a protected temporary file and loopback-only edge ports.
It starts its own Postgres, Mailpit and private SeaweedFS, migrates twice, verifies
HTTP and direct-API negative contracts, checks the exact `pgboss_platform` queue
set and renders login/landing in Chromium. It records screenshots and a JSON
verification record; temporary secrets are removed and only its own Compose
project/volumes are cleaned. SIGINT/SIGTERM abort child commands and enter cleanup;
a hard process/host loss still requires inspecting the exact printed project name
and removing only its resources. Never use Docker prune. The CI overlay is test-only and must never be used
for production. For local runs, build both images using the exact SHA tag before
running the harness; never borrow another task's mutable output or database.

Local composition and synthetic restore proof do not establish Timeweb resource
readiness, genuine SMTP delivery, restored production data correctness, customer
acceptance, physical printing, Windows behavior or factory continuity.

## Required gates before future protected dispatch

1. Approve target resources, private networking, ownership, sizing and backup
   location. CRM/Fucio20crm/n8n/Chatwoot sizing and provisioning are separate future
   work. vbtech is excluded; any retirement of its current service requires its
   own approved plan and release evidence.
2. Restore a verified immutable backup into a new isolated database and private
   bucket, with production workers stopped/disabled and mail directed to an
   approved sink. Preserve backup timestamps, schema/migration journal, row
   counts, sequences, index/constraint checks and object hashes. Test the actual
   Timeweb CA, role permissions, extensions and read/write bucket restrictions.
   Do not interpret a synthetic fixture restore as production restore acceptance.
3. Review restored durable intent before allowing work. `pgboss_platform` is a
   separate queue schema. The permitted workers are mail outbox dispatch,
   reconciliation and retention, subscription status materialization, platform
   report repair/run; pg-boss also creates its internal scheduler queue.
   Optional `SUPPORT_CHAT_ENABLED=true` adds only transcript import/repair when
   all protected Chatwoot parameters are present. Tenant/operator invitation and
   device-activation mail remain rejected by platform composition. Old `pgboss`
   queues must stay untouched and have no legacy worker attached. Outside pg-boss,
   the retained `StandaloneDiagnosticsRetention` timer first calls `purgeExpired`
   60 seconds after boot and then every 24 hours, removing diagnostics past the
   existing 24-month retention. Review/copy that restored history before boot;
   a paused job queue does not disable this timer.
4. Verify immutable key continuity, session origin/cookie behavior, strict
   cross-tenant authorization and audit, SaaS navigation, legal downloads,
   licenses/reports, object URLs and disabled legacy/device routes on the restored
   target. Decide explicitly which pending platform mail/report intents may run;
   startup repair can activate them immediately, while mail retention is scheduled.
5. Verify Timeweb SMTP for `markiro.app`: authentication, TLS/STARTTLS, sender
   identity, bounce/retry behavior, SPF/DKIM/DMARC and actual controlled delivery.
   A Timeweb mailbox exists, but the 2026-10-18 authoritative DNS observation
   found no public MX/SPF/DMARC. Inventory and separately approve sender records
   in the authoritative zone; see the dated migration checklist. Preserve mail
   records during subsequent web cutover.
6. Approve a single writer cutover window. Fence the old writable application and
   legacy workers before enabling target writes, verify the final delta/backup,
   then explicitly approve DNS/TLS changes. Preserve recovery copies and old
   immutable releases; never run both profiles against one writable database.
7. Use the reviewed protected platform publisher below only after main CI and
   approval. Implement and review a separate host dispatch workflow before any
   host mutation. Bind exact successful source/tooling workflow runs, immutable
   API/platform-edge digests, profiles and manifest into candidate/healthy state.
   Validate provenance and profile before host mutation. Reject `api-only` when
   current and requested server/UI profiles differ, or either profile is absent.
   Do not infer legacy profile for an unknown state.
8. Make rollback profile-aware: a rollback into legacy can restart old workers
   and expose retired surfaces. Require a compatible snapshot, queue/intent
   disposition, key continuity and explicit operator approval for such a change.
   Same-profile rollback must still verify schema compatibility, migration state,
   exact digests and public negative/positive smoke. After new writes, DNS reversal
   alone is not a lossless rollback; reconcile data before changing the writer.

No host executor, provisioning, DNS action or server mutation is included. The
protected publisher is a separately approved registry operation.

## Protected platform image publication

`Publish platform images` (`release-platform-images.yml`) accepts one required
string input, `ci_run_id`. Dispatch from **main only**, after the publisher itself
is merged. Its immutable dispatch `github.sha` is both source and tooling SHA.
Select a successful `CI` push run on main in this repository for exactly that SHA;
PR CI and a successful run for an earlier main commit do not qualify. The resolver
reads the exact successful run attempt and every jobs page, and requires both
`production-bundle` and `ci-required` to have completed successfully. Skipped
mandatory jobs fail the gate. No alternate source SHA input exists.

For example, after independently selecting and checking the numeric run ID:

```sh
gh workflow run release-platform-images.yml --ref main -f ci_run_id=CI_RUN_ID
```

`main` can move between selection and dispatch; in that case the SHA mismatch
fails safely. Inspect the actual dispatch SHA before approving publication. The
build job uses only contents/actions read permission. It builds Linux amd64 API
and platform edge once, captures IDs before the synthetic harness, checks them
afterward and retags those IDs as
`platform-<sourceSha>-<workflowRunId>-<workflowRunAttempt>`. Local SHA build tags
are never pushed. The workflow preserves the existing public landing build
variables. It uploads only `images.tar` and strict `verified-images.json` in
`markiro-platform-images-<runId>-<attempt>`, with one-day retention and no overwrite.
The three allowlisted harness files are kept separately, including on failure.

The dependent publish job waits at the existing **production-deploy** environment
(required reviewers and main-only policy observed 2026-10-18). It receives only
contents:read and packages:write, uses no host secrets, downloads the exact
artifact ID emitted by its build job, verifies profiles/SHAs/run/attempt/CI
identity and regular-file SHA256 before loading, then compares both loaded IDs.
GHCR login happens only after load validation. Both IDs are checked again before
each push. There is no rebuild, SSH, provider operation or deployment step.

After approval, inspect the workflow conclusion and the immutable artifact ID for
`markiro-platform-release-<runId>-<attempt>`. Download that specific ID from the
selected run (the GitHub artifact API is
`GET /repos/OWNER/REPO/actions/artifacts/ARTIFACT_ID/zip`); do not select a mutable
artifact name from a different run. This 90-day artifact contains
`platform-manifest.json` and `release-evidence.json`. Confirm `status: complete`,
all six identities, both verified IDs and archive hash, and both repository-bound
published digests against the manifest. Independently inspect the exact GHCR
digest references before approving any host delivery. Version-1 platform manifest
validation remains separate from legacy manifest validation.

If either push or digest resolution fails, the job fails and uploads only
`markiro-platform-incomplete-<runId>-<attempt>` with sanitized partial evidence.
A pushed tag may exist even though there is no complete release. Never deploy
from partial evidence. If approval outlasts the one-day image retention, or a job
rerun changes `github.run_attempt`, rerun **all jobs** so build and publish share
the same new attempt. A publish-only rerun cannot reuse old-attempt evidence.

The thin CLI uses explicit path arguments; identity values come from GitHub's
runner environment and validated step outputs:

| Verb and arguments                   | Purpose                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `fetch-ci DIRECTORY`                 | Authenticated HTTPS download of run/attempt jobs, then validate; `GH_TOKEN` is environment-only |
| `validate-ci DIRECTORY`              | Validate downloaded `run.json` and complete `jobs.json` against repository/SHA/CI run           |
| `capture FILE`                       | Save exact local SHA-tag IDs before the harness                                                 |
| `export DIRECTORY CAPTURE_FILE`      | Recheck tested IDs, tag by ID and export archive plus evidence into a new directory             |
| `verify DIRECTORY`                   | Validate strict evidence and archive hash without Docker load                                   |
| `load DIRECTORY`                     | Verify first, load archive, compare exact image IDs                                             |
| `publish DIRECTORY OUTPUT_DIRECTORY` | Reverify archive and IDs, push, resolve digests and write release into a new directory          |

Invoke as `node deploy/platform/release-images.mjs VERB ...`. Expected environment:
`RELEASE_SHA`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `CI_RUN_ID`, `CI_RUN_ATTEMPT`;
CI resolution additionally needs `GITHUB_REPOSITORY` and `GH_TOKEN`. CI validation
writes canonical `ci-run-id`/`ci-run-attempt` to `GITHUB_OUTPUT` when present. Keep
credentials masked and out of arguments. The image archive is large; hash
verification streams bytes. Use a fresh isolated Docker daemon for an independent
`load` check. Publication is registry evidence only; it proves no target restore,
Timeweb capacity, DNS/TLS, SMTP delivery or production installation.
