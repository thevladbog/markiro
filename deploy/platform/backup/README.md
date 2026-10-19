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
in 64 KiB chunks and exclusively published after fsync. The metadata read limit
remains 1 MiB; oversized inventory fails closed.

Inventory contains sorted roles and attributes, memberships, typed object
identities and owners/ACLs, default privileges, extensions, table row-byte digests
and counts, sequence values and `is_called`, index/constraint state and migration
journal digest/count. Row-byte digests include encrypted column bytes; no rows or
ciphertexts appear in evidence. All metadata and archive bytes are private.

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
1,048,576 bytes. The reviewed current-schema fixture produces 1,015,851 bytes,
leaving 32,725 bytes of headroom. Current-schema growth past that boundary fails
closed; the cap is not increased automatically. Every nested record has exact
keys, scalar types, allowed values and unique typed identities.
Function/procedure definitions use SHA256 of `pg_get_functiondef` bytes. User
triggers retain schema/table/name, SHA256 of `pg_get_triggerdef(oid,true)`, and
exact enabled state (`O`, `D`, `R`, `A`). Internal constraint triggers must remain
enabled normally; constraint definitions and validity capture their semantics.
Column ACLs, RLS policies, custom collations, standalone composite types, role or
database settings, role validity deadlines, foreign servers, large objects,
event triggers, publications and subscriptions are unsupported and rejected.
The database encoding and libc locale are preserved; other locale providers are
rejected. This is a reviewed Markiro restore path, not a general PostgreSQL clone.

Source and restore inventory sessions explicitly set `TimeZone=UTC`,
`DateStyle=ISO,YMD`, `IntervalStyle=postgres`, `bytea_output=hex`,
`extra_float_digits=3`, and `search_path=pg_catalog,public`. Each row is converted
with `row_to_json` under these settings, hashed with PostgreSQL SHA256, ordered
by its hexadecimal digest with C collation, and streamed in 512-row batches into
a table SHA256 and count. Duplicate rows remain duplicate digest entries.
Encrypted bytea columns retain their actual bytes; no application recalculation
or decryption occurs. Sequence values and `is_called` are compared separately.

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
Source traffic
is confined to an owned internal network with no published ports. Restore has
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
