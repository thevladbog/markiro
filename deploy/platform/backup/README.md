# Private database backup preparation

This library is local preparation, not production recovery acceptance. No public
CLI accepts a server or a database URL. The disposable harness accepts only
`--local-ci`. Off-host encrypted copies and independently available recovery keys
remain separate mandatory operational gates.

The root is canonical, owned by the executor, mode 0700; files are mode 0600.
`createDatabaseBackup({root,operationId,target,connectionFile,writerFence,run})`
returns `{archivePath,archiveSha256,inventoryPath,inventorySha256}`.
`verifyDatabaseRestore({root,operationId,target,backup,roleMapping,run})` returns
`{evidencePath,evidenceSha256}` only after comparison and verified cleanup.
`run` is the bounded `runHostProcess` adapter. The root's private
`backup-runtime.json` holds `{version:1,executorSha,dockerExecutable,endpoint,
image,provenance}`; endpoint is pinned local `unix:///`, image is an immutable
`sha256:` Docker image ID containing PG17 and the reviewed worker code. Provenance
is `local-synthetic` or `live-source`; synthetic proof never admits production.

The connection descriptor is `{version:1,kind:'platform-backup-connection',
operationId,target,service:'backup',serviceFile,passFile,caFile,network}`. Paths
are private absolute files below root. Service fields are explicit host, port,
dbname, user, `sslmode=verify-full`, and the staged `/input/ca.crt` path. Passwords exist only
in the private libpq passfile and never in process arguments, evidence or logs.

`writerFence.observe({operationId,target,boundary})` must independently inspect
an enforced writer fence and returns `{version:1,kind:'platform-writer-fence',
operationId,target,fenceId,enforcementSha256,boundary,beganAt,observedAt,held:true}`.
Boundaries are `before-snapshot` and `after-snapshot`; observations must be fresh
within 30 seconds and retain the same fence ID/enforcement hash. This is a trusted
adapter contract, not a JSON-based mechanism for stopping writers. The producer
also checks database sessions/prepared transactions. Those observations alone do
not prove no writers. The host gate must establish and keep the fence held.

The worker holds a repeatable-read transaction, exports its snapshot for
`pg_dump --snapshot`, and inventories data in the same transaction. Sequences,
which are not MVCC, are read before and after while the external fence remains
held. Dumps go directly to a private file, never stdout. The archive is streamed
in 64 KiB chunks and exclusively published after fsync. Inventory documents have an explicit 2 MiB cap; other control files remain 1 MiB.
Oversized inventory fails closed.

Inventory contains sorted roles and attributes, memberships, typed object
identities and owners/ACLs, default privileges, extensions, table row-byte digests
and counts, sequence values and `is_called`, index/constraint state and migration
journal digest/count, plus independent definition fingerprints. Row-byte digests include encrypted column bytes; no rows or
ciphertexts appear in ordinary table evidence. Release catalog tables are the
explicit exception: their non-secret raw row JSON, local receipt/attempt/ack bytes
and VersionIds are embedded as catalogBackup in the encrypted inventory. The
exact snapshot row hashes/counts and journal metadata are verified. A catalog
backup without its complete local journal cannot pass restore or host gates.
See [catalog recovery](../../../docs/runbooks/release-catalog-recovery.md). All metadata and archive bytes are private.

Role mapping is exhaustive `{version:1,roles:[{source,target}],allowedDeltas:[]}`.
Unsafe source role attributes may only be explicitly removed with
`{kind:'role-attribute',source,attribute,from:true,to:false}`. Membership removals
must explicitly name `{kind:'membership-removal',role,member}`. Missing roles,
collisions, provider grants, unsupported object kinds and implicit privilege
changes fail closed. Restore uses `--no-owner --no-acl`; generated quoted SQL
reconstructs supported ownership and grants using the validated mapping.
Passwords and raw provider role SQL are never replayed.

Completed evidence has exact fields `version,kind,status,operationId,target,
executorSha,provenance,archiveSha256,inventorySha256,roleMappingSha256,
restoredInventorySha256,snapshotId,fence,startedAt,completedAt,runtime,unvalidatedSourceConstraints,checks,
cleanup`. Runtime includes PG17 version, image ID and architecture. The fence
observations bind source snapshot creation. Completion requires actual archive
hashes, complete metadata equality under mapping, and independent absence checks
for operation-labelled temporary containers and volumes. Failure evidence uses
`status:'recovery-required'` and cannot pass `completedEvidence` validation.
Cleanup never prunes globally or removes old archives.

PG17 [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) exports one
database without cluster roles and does not fence writers. Custom archives defer
ownership policy to [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html).
Restoring a database executes source-controlled SQL. The restore container has no
network, no host secrets, no application containers, read-only backup input and
fresh private storage. The worker image and Docker daemon are trusted. Same-UID
or root compromise and a malicious custom `run` adapter are outside this local
filesystem/process trust boundary.

Intentional source `NOT VALID` constraints retain their exact validation state and
definition. Evidence reports `unvalidatedSourceConstraints`; this is not a claim
that all constraints were validated. Newly invalid, missing or differently
validated constraints fail comparison. Invalid/not-ready indexes fail closed.

The supported inventory includes ordinary/partitioned tables, views, materialized
views, sequences, functions/procedures, enum/domain/extension types, and the
`btree_gist` operator, operator-class and operator-family owners. Index and
constraint definitions are stored as SHA256 of canonical-session
`pg_get_indexdef`/`pg_get_constraintdef(oid,true)` bytes; actionable owners and ACLs remain
structured fields. The full private metadata file, including bindings, must fit
1,048,576 bytes. The corrected committed fixture produces a 1,019,906-byte private
file (1,019,905 canonical JSON bytes plus its newline), leaving 28,670 bytes of
headroom. Exact source/image and earlier measurements are recorded in the
[durable verification](../../../docs/verification/2026-10-19-platform-backup-preparation.md). Current-schema growth past that boundary fails
closed; the cap is not increased automatically. Every nested record has exact
keys, scalar types, allowed values and unique typed identities.
Each table/view/materialized-view `sha256` hashes canonical JSON of
ordered live column names, resolved type schema/name and typmod, NOT NULL,
`pg_get_expr(...,true)` default/generation expression, generated/identity mode and
resolved collation; relation kind, partition key/bound, ordered parent identities
and sorted relation options are included. Views additionally include
`pg_get_viewdef(oid,true)`. Physical dropped-column ordinal gaps are deliberately
excluded; logical column order is preserved. No source OIDs, SQL-dump hash or
expression regex normalization enters the fingerprints.

Enums hash ordered labels; domains hash resolved base type/typmod, nullability,
default and collation, plus ordered constraint names/definitions/validation bound
to the specific domain (also retained in the existing constraints inventory). Sequences hash resolved type, start/increment/min/max/cache/cycle and
serial/identity ownership dependency, separately from last_value/is_called.
Other custom base/range/multirange/pseudo types reject; only `btree_gist` base
types are admitted under the trusted extension/version policy, hashing their
storage/category and resolved I/O/modifier/analyzer function identities. The
trusted worker supplies the same extension implementation; fingerprints and the
extension version are not a native binary-code attestation.

Definition-bearing object, index, constraint and trigger records use the compact
`sha256` key for exactly one lowercase 64-hex SHA256 fingerprint. The earlier
unpublished `definitionSha256` key is rejected, not reinterpreted; shortening the
key retains all semantics under the fixed metadata ceiling. Archive/configuration
API fields and table row digests keep their existing meanings. Previous
metadata lacking these fingerprints fails closed and needs a new backup/proof.
Function/procedure definitions use SHA256 of `pg_get_functiondef` bytes. User
triggers retain schema/table/name, SHA256 of `pg_get_triggerdef(oid,true)`, and
exact enabled state (`O`, `D`, `R`, `A`). Internal constraint triggers must remain
enabled normally; constraint definitions and validity capture their semantics.
Column ACLs, RLS policies, custom collations, standalone composite types, role or
database settings, role validity deadlines, foreign servers, large objects,
event triggers, publications and subscriptions are unsupported and rejected.
The database encoding and supported libc or ICU locale metadata are preserved.
ICU restore requires the genuine stored and actual collation versions to match
before object replay; unsupported providers are rejected. This is a reviewed
Markiro restore path, not a general PostgreSQL clone.

Source and restore inventory sessions explicitly set `TimeZone=UTC`,
`DateStyle=ISO,YMD`, `IntervalStyle=postgres`, `bytea_output=hex`,
`extra_float_digits=3`, and `search_path=pg_catalog,public`. Each row is converted
with `row_to_json` under these settings, hashed with PostgreSQL SHA256, ordered
by its hexadecimal digest with C collation, and streamed in 512-row batches into
a table SHA256 and count. Duplicate rows remain duplicate digest entries.
Encrypted bytea columns retain their actual bytes; no application recalculation
or decryption occurs. Sequence values and `is_called` are compared separately. A sequence with a NULL
ACL retains PostgreSQL sequence defaults: its owner has SELECT, UPDATE and USAGE.

Trusted extension members are explicitly assigned their mapped owners. Source
superusers may have granted without explicit schema USAGE. Their safe mapped
roles borrow only USAGE on the exact needed schemas inside the ownership/ACL
transaction; every temporary grant is explicitly revoked before the exact source
schema ACL is recreated. Grants are replayed separately per privilege in
prerequisite order, starting with the object's owner and propagating grant options.
Cycles and grantors without an established grant option fail closed. Completion
still requires full ACL equality.

The local worker runs as UID/GID 999, without Linux capabilities, with no-new-
privileges, a read-only root, read-only input, and only its labelled private data
volume writable. A separate networkless volume initializer uses CHOWN, FOWNER
and DAC_OVERRIDE to prepare Docker/Podman copy ownership, then is removed before
SQL runs. All image-declared volume destinations must be explicitly mounted;
unknown declarations fail closed. PostgreSQL is launched by Docker's detached
exec inside the inspected owned container, never detached from the host runner.
Inspection requires the exact expected mount destinations and read/write modes,
and rejects extra network attachments even when NetworkMode claims `none`.
Cleanup verifies absence of each owned resource after removing it.

`node deploy/platform/backup/backup-ci.mjs --local-ci` builds a private worker
image from existing installed dependencies and current compiled DB migrations,
without installing packages. Its synthetic source runs the Task 2 role policy,
all current migrations and installed pg-boss, then adds renamed owners/grantees,
ACLs/default privileges, a reverse-lexical multihop delegated grant chain,
encrypted bytes and an uncalled sequence. A source-only synthetic probe disables
the current credential-epoch trigger and changes its function body inside a
transaction. Actual inventory recapture rejects each change while rows, journal,
owners and ACLs stay equal; rollback restores the current schema before backup.
The separate guarded schema probe checks NOT NULL and removed/changed defaults
on current station/kiosk credential_epoch and station security_revocation_revision,
plus view, enum, domain, type/typmod, generated/identity, partition and sequence
semantics. Each mutation is source-only inside a savepoint, rejects inventory
equality with rows/journal/owners/ACLs unchanged, and rolls back. It refuses
standalone/host execution before connecting: the Linux container must have matching
operation ID arguments, environment and private fixture marker. The harness also
inspects its exact source image, ownership label, private volume and absence of
published ports before invoking it. Synthetic fixtures retain domain, generated,
identity, dropped-column-gap and partition definitions for the full round trip.
A unit-level restore negative verifies a changed column fingerprint cannot publish
completed evidence even after successful cleanup.
Source traffic is confined to an owned internal network with no published ports. Restore has
network `none`. The harness also rejects changed bytes before creating resources
and runs a deliberately truncated custom archive through real pg_restore to
prove recovery-required evidence and actual resource removal. Production-bundle
CI runs this after the roles/TLS gate and current DB build. Linux arm64 local
evidence does not establish target-host amd64 or live-source recovery acceptance.

The service/passfile adapter deliberately accepts one exact service and one
matching passfile row, with an unescaped base64url-style password of at least 24
characters. Broader libpq service inheritance, wildcards and passfile escaping
are unsupported. The caller provides the held-fence adapter, runtime image ID
and executor SHA from reviewed tooling. Image ID binds the actual worker bytes;
executor SHA must identify the built source revision, not an older dirty-tree base.

Constraint definition hashing uses PostgreSQL's own pretty deparse mode, matching
pg_dump. This matters for BETWEEN combined with AND: PostgreSQL expands BETWEEN
into nested comparisons, while restoring its deparsed SQL can flatten nested
AND nodes. Pretty deparse produces identical SQL bytes for both trees without
removing literals, casts, precedence or validation state. Changed definition
hashes remain a restore failure.

The host integration is `../host/backup-gate.mjs` and
`../host/prepared-target.mjs`; the complete record and trusted-adapter contracts
are documented in the [preparation runbook](../../../docs/runbooks/timeweb-platform-preparation.md#backup-and-prepared-target-library-boundary).
`readVerifiedBackup` is an internal shared byte-verification helper, not a second
acceptance API. `verifyBackupGate` returns only the existing four journal fields.
`validatePreparedTarget` additionally rehashes both credential-bearing candidate
snapshots, verifies role mapping and fresh bound observations, and retains explicit
operator provenance. The journal itself remains a lower-level syntax/state store.
`prepared-ci.mjs` is called only by the synthetic local harness; it creates no live
acceptance. Its CLI timeout probe independently inspects the still-running owned
container, requires actual stop plus held fence, and preserves terminal recovery.

The trusted operator entry point
`../host/target-backup.mjs#createTargetRecoveryBackup` accepts
`{operation,observationPolicy,hbaPath,hbaSha256,connectionFile,roleMapping,verifySources}`
and returns `{backup,restoreEvidence,fence}`. `operation` contains only the existing
`root`, deployment `identity`, candidate `configuration` snapshots and
`dockerConfig` (the root's `docker` directory). The returned fence is the existing
`{fenceId,beganAt,enforcementSha256}` binding for later prepared-target acceptance;
it is created only after a successful factual observation. It does not construct
or admit a prepared-target record.

This function uses concrete host Docker and PostgreSQL observers under the same
`.deploy.lock` as deployment, rejects unresolved journals, and permits only
PostgreSQL at observation boundaries. It pins `/usr/bin/docker`,
`unix:///var/run/docker.sock`, Linux AMD64, `live-source` provenance, and the
operation's executor SHA. The protected connection must select
`db.private:5432/markiro`, the exact observed private database network and the
configured CA bytes. Runtime, connection, service, password, CA and both candidate
snapshots are reread at every boundary. Credentials stay in protected files.

The operator supplies a trusted `verifySources` function that verifies reviewed
installed source bytes and independently checked immutable worker-image provenance;
it is invoked at entry, before snapshot, after archive cleanup and after isolated
restore cleanup. This is a JavaScript trust boundary, never a JSON callback or a
caller-supplied `held` observation. Optional process/machine-ID adapters exist for
trusted tests. The function neither builds nor publishes its worker image.

Archive output is captured and worker resources are verified absent before the
final snapshot fence observation; archive publication still follows that
observation. Isolated restore uses network `none`. No descriptor is returned until
its cleanup and a final physical/database re-observation succeed. Producers attempt
to retain private failure evidence. Unreaped processes, uncertain process durability or
an incomplete archive/restore producer call retain the deployment lock and require
operator recovery. A producer call is considered complete only after successful
cleanup; failure-evidence persistence errors cannot erase that uncertainty. No
additional process commands run after unconfirmed child termination;
a sanitized producer failure alone is never taken as proof of cleanup. Completed
producer files from a later failing outer operation do not admit a prepared target.
Source import, target Linux execution, TLS/effective roles, key continuity, egress,
off-host recovery and deployment admission remain separate operational gates.

The existing synthetic CI harness can preserve its exact tested worker image with
`node deploy/platform/backup/backup-ci.mjs --local-ci --export-image /absolute/new/private-directory`.
Export defaults off. It runs only after all positive/negative backup, restore and
prepared-path checks and verified fixture/worker cleanup succeed. The saved object
is the immutable image built before runtime fixture credentials or data exist;
`docker save` never includes container writable layers or Docker volumes. No
container commit/export, runtime connections, credentials, database dump or table
inventory enters this artifact.

The output directory is new and mode 0700, containing only mode-0600
`recovery-image.tar` and `recovery-image.json`. Export requires the same owned
Linux AMD64 configuration image ID used by the tests. It checks the image before
and after saving, streams the archive hash, and fails closed above 2 GiB or a
1 MiB manifest. Source verification bounds the copied inventory to 2,048 files,
each Git blob to 2 MiB and total repository bytes to 256 MiB. It compares all
working/staged copied source bytes and exact file inventory with `git show` at the
captured checkout SHA before build, then rechecks sources before and after image
save. Added, removed, altered and untracked copied files fail; a HEAD label alone
is insufficient. Existing or symlinked output paths are rejected and preserved.

The manifest identifies synthetic probe/migration source as fixture code. Generated
`runtime-migrate.js` and the generated build recipe have separate byte hashes;
compiled bytes are not asserted to be Git source. Installed `pg`, `drizzle-orm`
and `pg-boss` dependency trees and public Node/PostgreSQL base bytes are covered by
the actual tested image ID. The manifest also records the exact base-image references in the hashed recipe;
the ICU route pins both references by digest. No separate dependency-tree hash is
claimed. The manifest remains `local-synthetic`, including in CI; it never asserts
live target execution or recovery acceptance.

CI retains only these two files for seven days using the existing pinned upload
action after successful harness completion. Pull-request CI may export an image
for verification. Production use requires an independent check of the exact
successful main-push CI run and attempt, repository/source SHA and immutable
artifact ID/digest. The operator must rehash archive bytes, compare source hashes
and generated-byte provenance with that main revision, load only the admitted
archive, and reinspect its exact Linux AMD64 image configuration ID before binding
a protected backup operation. A PR artifact, successful image build, upload, or
synthetic round trip never authorizes a production operation. Application image
publication and its protected gates are unchanged. Actual artifact transfer/load
and target restore remain operational gates.

Use `node deploy/platform/backup/backup-ci.mjs --local-ci --icu` for the separate
Alpine ICU worker, or add `--export-image /absolute/new/private-directory` on
Linux AMD64 after the same checks. The default route remains Bookworm/libc.
The ICU worker uses the target's pinned PostgreSQL Alpine base, with worker-only
UID/GID 999 and a checked PostgreSQL utility compatibility path. Target PostgreSQL
UID 70 and observer identity are unchanged. Compact bootstrap explicitly selects
UTF8, ICU en-US and C/C.

The ICU harness verifies a full default-locale fixture including Unicode values,
a genuine custom-rules database roundtrip, and natural Alpine ICU 153.136 to
Bookworm ICU 153.120 rejection before object replay. Only the negative fixture
copies and rebinds its worker image field to reach that comparison; genuine ICU
metadata and dump bytes stay unchanged. It separately verifies that an unchanged
inventory bound to the wrong image is rejected. Both failures require verified
cleanup and absence of completed evidence. No production validation is relaxed.
CI runs both routes and retains their two-file exports under separate exact paths
and artifact names. ARM64 local runs exercise recovery without production export.
These checks do not accept the separate source ICU upgrade or live target import.
