# Timeweb compact host delivery design

Status, 2026-10-19: the protected publisher merged in PR #732 and
[publisher run 39169553922, attempt 1](https://github.com/thevladbog/markiro/actions/runs/39169553922)
published source/tooling `6fe44af838fc873cd06c7f0d52a4a5dae77dd7e5`.
Independent read-only admission of that publication completed. Admission tooling
PR #733 remains open; publication/admission is not host acceptance.

Private filesystem/configuration snapshots and the durable deployment-state
library are implemented with local fault-injection tests. The state library binds
strict admission syntax, target and backup-proof identities, retains held locks
on publication uncertainty and conservatively handles stale locks, and blocks
unresolved operations; it performs no commands or
backup verification. Bounded command orchestration, the reviewed backup/restore
adapter, separate database-role configuration, prepared-target acceptance,
protected SSH/workflow and host CLI remain pending. No host operation is
implemented or authorized by these library tests.

## Outcome and boundaries

Deliver a reviewed, digest-bound platform release to a dedicated Markiro Linux
amd64 host with 2 vCPU / 4 GiB and local PostgreSQL 17. Only landing, platform API
and SaaS administration run. The existing source stays writable during isolated
rehearsal. CRM, n8n, Chatwoot hosting, landing redesign, DNS cutover and old-resource
decommissioning remain separate operations.

The implementation must not provision a VM, generate replacement production
keys, restore a live database, dispatch deployment or alter GitHub protection as
a side effect of running tests. Existing production/Yandex executors are not
reused as an entry point. Their immutable state, timeout and command-array patterns
may be reused after reviewing the applicable invariants.

Builder decisions: native Node 24 tooling, Docker Compose V2, existing compact
composition, one host-level deployment lock, additive protected deployment
workflow. No new package dependencies or alternative orchestrator. The code is
reviewed before resource purchase; no build runs on the target host.

## Release admission

Take explicit publisher run ID, attempt and artifact ID, not a latest tag or
artifact name. Resolve GitHub evidence for exactly that successful manual main
run of `.github/workflows/release-platform-images.yml` in this repository.
Both build and publish jobs must succeed in that attempt. Reject a pending
approval, skipped job, failed rerun, fork, different workflow/profile or SHA.
Check complete job pagination and artifact ownership, expiry, exact expected
name and immutable artifact digest before bounded archive extraction. Accept
only `platform-manifest.json` and `release-evidence.json`; reject path traversal,
links, duplicate entries, oversized entries and extra files.

Validate the complete published evidence against the version-1 platform manifest:
source/tooling SHA, publisher run/attempt, successful exact main CI run/attempt,
archive hash, both image IDs and both repository-bound digest references. Recheck
CI using the existing validator. Pull the selected linux/amd64 image digests and
compare their image IDs with the published evidence. This is not merely a parser
for operator-supplied JSON. Preserve a sanitized admission record with artifact
ID/hash and immutable identities. A partial release never becomes a candidate.

The workflow's tooling checkout is also an immutable successful main SHA. Record
its separate executor SHA; do not rewrite the published manifest's tooling SHA
when host tooling advances. Require matching audited source files for the
composition and host executor. The operator selects a complete release; workflow
code is selected by the immutable dispatch SHA and must itself pass main CI.

## Protected transport and prepared target

Use an explicit protected GitHub deployment environment with required reviewers
and main-only policy. Its setup is an operator step, never an unprotected workflow
side effect. Reuse `production-deploy` only with distinctly named Timeweb target
variables/secrets, so legacy host credentials cannot be selected accidentally.

SSH uses a pre-pinned known-hosts entry, strict host checking, explicit identity,
BatchMode, IdentitiesOnly and no agent forwarding. Do not obtain trust using
`ssh-keyscan` during the deployment. Validate host, port and username before
constructing commands; use fixed remote commands and bounded validated arguments,
not caller-supplied shell text. Transfer only an allowlisted tool bundle and
admitted release evidence to a unique private incoming directory. Verify bundle
hash before execution. No `.env`, SSH key or registry token enters artifacts.

A separately reviewed bootstrap installs Node 24 and Docker/Compose, creates a
private deployment root and supplies protected configuration, database TLS,
registry credentials if needed, and recovery files. The executor refuses an
unprepared or ambiguous target. It never installs packages, creates IAM, changes
firewalls or generates production keys opportunistically.

Use an explicit fixed project `markiro-platform`, root-owned/operator-owned
private state and absolute file paths. Validate directory ownership and symlink
boundaries, not just the final env file. Reject pre-existing legacy/unknown stack
ownership. Require a validated host inventory with the target's SSH fingerprint,
architecture and intended database volume identity. No API-only mode is provided.

## Secrets, interpolation and continuity

Read runtime configuration through `readProtectedEnv` and `validateConfig`.
Allowlist expected keys, including separately inventoried optional licensing,
support and encrypted-history keys. Create a private per-candidate snapshot and
bind its hash without logging values. Use a minimal child environment with fixed
PATH, explicit Docker configuration and only intended Compose interpolation
values. Never source the file or print expanded Compose configuration.

Do not rely on Compose interpolation of credential-bearing values: `env_file`
remains raw, and interpolation receives only a separate validated non-secret
allowlist. Test literal dollar signs, hashes and backslashes. Reject ambient
`COMPOSE_*`, `DOCKER_HOST`, `DOCKER_CONTEXT`, proxy and Node injection variables.
Command errors and evidence contain phase identifiers, not raw stdout/stderr.
Protected logs may be retained on the target with explicit restrictive modes.

Require existing key continuity evidence for auth, mail encryption, standalone
license issuer/KID/private key/public keyset and support decryption keys. Syntax
validation cannot establish continuity. Preserve licensing sequences and retained
encrypted records. No fallback to a fresh key or bootstrap superuser.

## Database, backup and recovery gate

Bootstrap and restore are separate from deployment. Validate the approved PG17
image digest, actual UID/GID, CA, server certificate SAN `db.private`, validity,
key pairing and required file modes. Verify TLS with the application role;
untrusted CA, wrong hostname and plaintext must fail. Separate application and
migration credentials: migrations must not require a superuser in the API URL.
The existing common env composition needs an explicit protected migration env
file before separate roles can be claimed.

Before destructive work, stop/fence target writers and verify their absence.
Require a fresh immutable database backup, its checksum and an isolated restore
verification that checks roles, ACL, extensions, default privileges, migrations,
constraints, critical row counts and sequences. The record binds the precise
host/database/volume and stopped-writer boundary. A JSON `backupOk` flag alone is
not proof: the adapter must verify archive bytes and restore evidence produced by
the reviewed backup tool. An off-host encrypted recovery copy with independently
available keys is an operational prerequisite; it is not implied by a local dump.

Restored source data must be isolated before any target API startup: enforce
SMTP/external-service egress restriction outside app flags, inspect retained mail
and report intents, legacy queues and retention timers. An operator-maintained
prepared-target record supplies these independently verified facts and the exact
snapshot identity; the executor validates its freshness and binding, not the
truth of human attestations. Evidence must distinguish automatic checks from
operator acceptance. Source production remains running during rehearsal.

## Durable phases and failure behavior

Acquire an exclusive deployment lock before inspecting mutable state. Do not
break a stale lock automatically. Write versioned, exact-schema atomic records
with file and parent-directory fsync before advancing. States bind the complete
admission record, executor SHA, configuration fingerprint, database/backup
identity, previous healthy candidate and server/UI profiles.

Phases: admitted -> images-verified -> target-stopped -> backup-verified ->
migrating -> migrated -> api-started -> edge-started -> healthy. Persist entry
into a phase before the corresponding command and its completion afterward;
interrupted/in-progress states never imply success. Reject a second operation
while a candidate is unresolved, including after reboot.

Journal publication/acquisition uncertainty latches and retains the held lock.
After all writes are drained and durably synced and the callback store expires,
retirement unlinks only the owner's lock and syncs the directory. A failed
retirement returns distinct sanitized `ERR_HOST_LOCK_RELEASE` with
`durabilityUncertain: false`, `lockRetirementUncertain: true`; it is not a new
uncertainty in already-synced journal contents. The former owner never restores
or removes a successor's lock and its expired store cannot mutate state. Unlink
allows a successor to acquire/fsync before retirement sync finishes, so no
permanent fence is promised for retirement-only failure. A crash can leave a
conservative stale lock that is never automatically broken. New operations
require a fresh synced acquisition and strict validation of durable state;
retirement errors grant no recovery/reset authority.

Order only the reviewed base and compact Compose files. Pull before stopping.
Stop edge/API, prove no target API/worker remains, start/wait PostgreSQL only,
verify the backup gate, run migration with `run --rm --no-deps migrate`, start
API with `up -d --wait --no-deps api`, then edge with `up -d --no-deps edge`.
Never use unqualified `compose up`, `down -v`, volume deletion or a rebuild.
Every process has a bounded timeout and process-group termination before recovery
starts; a background timed-out migration must not continue alongside recovery.

Failures before migration may restart the previous exact same-profile release
only after verifying its configuration, database identity and absence of schema
mutation. At or after migration entry, stop target API/edge and record
`recovery-required`; do not automatically run an older binary or reverse a schema.
An explicit recovery operation needs the accepted snapshot/schema boundary and
writer reconciliation. First install has no prior healthy release. Legacy,
unknown-profile and incomplete prior state always fail closed. This conservative
policy is the chosen default; automatic schema-aware rollback is not in scope.

## Health, rehearsal and acceptance

Local container health is necessary but insufficient. Target smoke must exercise
SaaS login/auth boundary, landing, disabled legacy routes, expected source/profile
headers and no unexpected redirects against the actual domain names. Parameterize
the current synthetic smoke safely; never weaken its negative route assertions.
Enabled demo submissions must not send a real request just for health checking.

Before web DNS cutover, use a separately approved temporary rehearsal hostname
and trusted certificate or supplied trusted TLS certificate, with a transport
pinned to the target IP. Public production DNS is not a dependency of local target
verification. Do not use insecure TLS or add the CI overlay to target Compose.
Record rehearsal acceptance separately from production-domain TLS/public smoke.
A rehearsal configuration does not become a production configuration implicitly.

After host health, separately run representative restored-data capacity tests on
the exact published digests, controlled SMTP/S3 checks, license issuance and
verification, diagnostic decryption and restart/backup recovery. A synthetic
publisher test does not prove the 2 vCPU / 4 GiB host or restored data is accepted.
Final freeze, final deltas, one-writer promotion and DNS require the migration
checklist's cutover gate. Retain the old source and recovery artifacts until
explicit acceptance.

## Implementation order

1. Strict release admission and transport-independent validation with hostile-input
   tests; independently check the first actual publisher output.
2. Protected filesystem/configuration and durable state/command orchestration with
   fault injection at each phase. No public host entry point before these pass.
3. Reviewed backup/restore adapter, separate role configuration and prepared-target
   acceptance format; exercise against disposable local PG17 with real ACLs.
4. Thin protected workflow/SSH transport and host CLI using those components;
   verify pinned-host rejection and complete isolated Linux rehearsal.
5. Only then purchase a suitable available VM, provision, rehearse and seek cutover
   acceptance. Resource availability and price must be refreshed at purchase.

## Restore compatibility observation, 2026-10-18

An isolated local PostgreSQL 17.11 experiment against the current encrypted backup
confirmed that the managed provider's role-grant graph cannot simply be replayed:
a grantor-permission check rejected the raw roles export. A second, deliberately
limited experiment using source-named roles without login or elevated attributes
successfully replayed database owners and object ACLs. Original membership and
role privileges were not reproduced. Both temporary databases had no network,
published ports or application and were removed afterward; source and backups
were unchanged. This supports an explicit role-mapping implementation, not blind
replay of `pg_dumpall` or acceptance of those placeholder roles as production
credentials. Target architecture/TLS and application/migration grants remain
separate gates.
