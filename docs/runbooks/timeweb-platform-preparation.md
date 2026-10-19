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
its separate file password. `postgres/roles.mjs` prepares private SQL for explicit,
one-time provisioning of a fresh `markiro` database: `markiro_migrator` owns
`public` and `drizzle`; `markiro_app` receives business DML/sequence privileges,
including default privileges for later migrations, and owns `pgboss_platform`.
Both logins have NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION and
NOBYPASSRLS, with no membership between them. Only migrator receives CREATE on
the `markiro` database: Drizzle checks this privilege even for its precreated
schema. This does not grant CREATEDB. Required `btree_gist` is installed by the
bootstrap owner. Existing databases and provider ownership/ACL mapping require
separate restore review; do not use fresh provisioning to rewrite existing roles.
Before restore/migration, provision the approved role/owner mapping;
do not use that bootstrap superuser in the production API URL. The image's init
variables apply only to a new empty volume and do not rotate restored roles or
passwords. Preserve role ownership, extensions and restore permissions. The server
key must be owned by 70:70 mode 0600, or root:70 mode 0640 (PG's root-owned key
exception). Make the bootstrap password file readable only by the required
operator/PostgreSQL identity, and the public certificate/CA readable by runtime
users (API image uses uid 1000). Validate mount ownership on the Linux target;
Mac bind-mount permission behavior is not that proof. Production CA/keys are
supplied by the protected operator process; this package generates none.

Compact and CI overlays explicitly set `PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA=true`
for API only. This disables pg-boss schema creation, while retaining queue-local
DDL, queue migrations and startup repair. A missing precreated schema fails;
there is no broader-grant fallback. The strict optional flag defaults to false
for existing portable/legacy configurations. These changes require a newly built
and admitted API image; older published or locally derived images do not prove
compatibility with this role policy.

For a future approved operation, carry the validated protected runtime file into
Compose explicitly. Reject ambient variable overrides; do not source the file,
print expanded `compose config`, or pass secret values in CLI arguments. The
following command prefix illustrates a clean environment and explicit composition
from the repository root; `interpolation.env` contains only allowlisted non-secret
values from host configuration, never runtime credentials. The services' separate
raw `env_file` inputs preserve literal credential dollars:

```sh
env -i PATH="$PATH" docker compose \
  --env-file /absolute/protected/interpolation.env -p markiro-platform \
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

## Read-only release admission

After the protected publisher has completed successfully, select its exact full
lowercase source SHA, numeric run ID, attempt and release artifact ID. Admission
requires Node 24+, Python 3 (standard-library `zipfile`), and Docker CLI with
`manifest inspect --verbose`. Set `GH_TOKEN` through the operator's protected
process environment with repository Actions read access. Do not put it in command
arguments. Private GHCR images require existing local Docker authentication.
Admission never logs in or changes that configuration.

```bash
node deploy/platform/admit-release.mjs SOURCE_SHA RUN_ID ATTEMPT ARTIFACT_ID OUTPUT_FILE
```

Replace each positional placeholder with the selected value. `OUTPUT_FILE` must
not exist and its parent directory must already exist. The repository is fixed to
`thevladbog/markiro`. The selected publisher must be a successful manual `main`
run of `release-platform-images.yml`; both `build` and `publish` must have succeeded
in that exact attempt. A newer rerun invalidates an older attempt selection.
Admission also revalidates the exact successful main-push CI run and attempt
recorded by the publisher. It rereads the current publisher after validating the
selected attempt's jobs. After both registry checks and temporary cleanup, it
rereads current publisher and CI provenance immediately before creating the
record. These reads retain the same HTTP timeout and response-size bounds and
must still match the selected successful attempts, source and repository checks.

The verifier binds artifact metadata to the selected run, source, branch and
repository IDs, checks its SHA256 against the downloaded ZIP, and reads exactly
`platform-manifest.json` and `release-evidence.json`. ZIP archives are limited to
1 MiB, each member to 256 KiB. Extra entries, links, directories, encryption,
traversal, corrupt CRCs and truncated members fail admission. HTTP reads have
30-second timeouts; JSON responses are capped at 2 MiB with at most 100 pages of
100 jobs. Signed HTTPS download redirects receive no GitHub credentials and are
limited to four blob requests. Temporary archives use a private directory and
are removed before the output record is created.

Registry confirmation is mandatory for both immutable digest references. The
only Docker operation is `docker manifest inspect --verbose REFERENCE`, bounded
to 60 seconds and 1 MiB of output. The parser uses the
[Docker CLI 29.6.1 ImageManifest shape](https://github.com/docker/cli/blob/v29.6.1/cli/manifest/types/types.go):
`Ref`, `Descriptor.digest`, `Descriptor.platform`, and exactly one of
`SchemaV2Manifest` or `OCIManifest`. It requires Linux amd64, the exact requested
repository/digest, and a config digest equal to the captured image ID. Verbose
indexes are arrays and are rejected, including single-member indexes. The older
top-level `Digest`/`Platform` example on Docker's documentation page is not the
supported shape. A future CLI output change fails closed and requires review.

Success exclusively creates a regular mode-0600 JSON file with exactly:

- `version: 1`, `kind: "platform-release-admission"`, and
  `repository: "thevladbog/markiro"`;
- `manifest` and `verified`: the validated original platform manifest and verified
  image evidence, including their original publisher and CI identities;
- `artifact: { id, sha256 }`: canonical artifact ID and lowercase ZIP SHA256;
- `publisher: { runId, runAttempt }` and `ci: { runId, runAttempt }`: canonical
  decimal strings checked against GitHub;
- `registry.api` and `registry.edge`, each exactly
  `{ reference, imageId, platform: "linux/amd64" }`.

This record captures point-in-time verification evidence. The final publisher
and CI reads are sequential observations, not an atomic lock against a rerun
starting afterward. A later rerun requires fresh admission, and any future host
executor must recheck freshness and provenance at its own execution boundary.
The record is not a signature, deployment authorization, restore proof, capacity
acceptance or proof that any host is running the images.
The verifier does not pull/load/push images or contact a deployment host. Running
its tests does not satisfy live admission of an actual protected publication.

Failures print only a phase (`input`, `output`, `publisher`, `artifact`, `archive`,
`evidence`, `ci`, `registry` or `cleanup`) and produce no new success record.
Existing output files are preserved. For `input`/`output`, correct the selection
or choose a new output path. For GitHub/evidence/archive failures, inspect the
selected protected publisher and its immutable artifacts through authenticated
operator tooling; do not edit evidence or substitute another attempt's files.
For `registry`, check existing registry access and the supported Docker output
shape separately. Resolve the cause and rerun with the same explicit identities,
or select a newly completed publication. Never treat a failed admission as
permission to provision, deploy or change DNS.

## Host safety library contract and pending gates

As of 2026-10-19, protected
[publisher run 39169553922, attempt 1](https://github.com/thevladbog/markiro/actions/runs/39169553922)
published source/tooling `6fe44af838fc873cd06c7f0d52a4a5dae77dd7e5`, followed by
independent read-only release admission. Admission tooling PR #733 remains open.
These observations establish release provenance; the local safety tests below
establish filesystem/state behavior. Neither establishes a running target.

`deploy/platform/host/config.mjs` snapshots validated runtime values in private,
immutable `candidates/<uuid>/runtime.env` files and hashes the captured bytes.
`snapshotMigrationConfig` accepts a separate protected input with only
`DATABASE_URL`, the same database/host/port/CA/verify-full TLS, and a distinct
login. It exclusively publishes `migration.env` alongside the runtime snapshot.
Combine runtime interpolation with `MARKIRO_PLATFORM_MIGRATION_ENV_FILE` from
that returned path; runtime-only interpolation cannot construct a host child.
API receives only runtime credentials; migrate receives only its database URL.
The future host gate must bind both actual snapshot hashes: the existing state
`configurationSha256` field does not yet implement that aggregate binding.
Its separate child
configuration permits only validated non-secret interpolation values and rejects
ambient command-injection variables. The shared filesystem helpers require a
pre-created canonical absolute root owned by the executing UID, mode 0700, with
safe ancestors. Descendant directories are 0700 and regular single-link files
are owned, mode 0600, and bounded to 1 MiB. Root/current-UID hostile processes
are outside this private-root trust boundary.

`withHostState(root, callback)` in `deploy/platform/host/state.mjs` exclusively
creates and fsyncs `.deploy.lock` before reading `state.json`. The callback's
store exposes only async `read`, `begin`, `enter`, `complete`, and `fail`.
It rejects concurrent method calls, nested/second owners, escaped store methods,
and drains already-started work before releasing its own lock. It never breaks
an existing lock. State mutations increment a sequence and atomically replace
`state.json` with file and parent-directory fsync before success. Read results
and accepted input identities are independent copies. State/publication errors
expose only `ERR_HOST_STATE`, a generic message and `durabilityUncertain`.
Lock-retirement failures have a distinct sanitized `ERR_HOST_LOCK_RELEASE`,
`durabilityUncertain: false`, `lockRetirementUncertain: true`.

Each root represents one host/database/volume target. A candidate binds a
canonical operation UUID, complete strict admission record, immutable executor
SHA, configuration SHA256 and that target. Admission validation here checks
syntax and cross-bindings; a future executor must separately establish fresh
online provenance. Begin is allowed only for an empty root or a completed
healthy candidate on the same target, retaining the prior full healthy record.
Candidate UUIDs cannot reuse a retained operation. There is no resume, reset,
rollback or recovery-clearing API.

The enforced phases are admitted, images-verified, target-stopped,
backup-verified, migrating, migrated, api-started, edge-started, healthy.
Each phase must be entered before completion and the next phase. Backup
completion requires exact archive/restore-evidence hashes, target and operation
binding. This proof format does not verify archive bytes or a restore. Migration
entry requires that bound record. `fail()` preserves the current phase and any
backup while making it recovery-required; earlier healthy identity is retained
as history and cannot replace the failed candidate. Unresolved records prohibit
a new begin even after normal lock release or restart. A killed owner leaves its
lock. Acquisition or journal-publication uncertainty latches for the owner and
retains the held blocking lock even if the callback catches the error.

Lock retirement starts only after the callback store expires and all writes
are drained and durably synced. The owner unlinks only its own lock, then fsyncs
the directory. A retirement-only failure returns the distinct error above;
it does not make already-synced journal writes uncertain. A successor can
acquire/fsync after unlink while the former owner awaits retirement fsync, so
there is no permanent fence promise for retirement-only failure. The former
owner never restores a lock or removes/changes a successor's lock/state. Its
expired methods remain unusable. The error grants no mutation or recovery
authority: a new `withHostState` acquisition must sync its own lock and read
strict durable state, which still blocks unresolved candidates. A completed
healthy candidate can hand off after a fresh synced acquisition. A crash may
leave a conservative stale lock; do not automatically break it.

Investigate retained state/locks
through a separately reviewed operator recovery procedure; do not delete them
to retry a failed deployment.

Local `postgres/roles-ci.mjs --local-ci` exercises PG17 runtime migrations twice,
actual pinned pg-boss lifecycle, business DML/default ACLs, role/DDL denial,
Compose credential isolation, and both logins' CA/hostname/plaintext rejection.
It requires a verified local Unix Docker endpoint, creates generated credentials
and unique isolated resources, publishes no ports and cleans those resources.
This synthetic proof does not establish existing-data restoration or target AMD64.

The host CLI, exact Compose orchestration,
reviewed backup-byte/isolated-restore verification, aggregate configuration binding,
prepared-target acceptance, SSH transport and protected host workflow
remain pending. Linux filesystem/crash rehearsal, actual target inventory,
PostgreSQL TLS/roles, key continuity, off-host recovery, restored-data capacity,
SMTP/S3/license checks and domain/TLS smoke remain separate acceptance gates.
Pure local library tests invoke no Docker, SSH, GitHub or production service and do
not authorize VM purchase, restore, deployment or DNS cutover.
