# Post-migration forward recovery

This path applies only to the reviewed failed upgrade at terminal
`api-started/recovery-required`, sequence 14, with `migrationEntered=true`.
It preserves the already migrated physical PostgreSQL database. It never runs
another migrator, restores SQL over that database, starts old applications, or
returns the old version. A different failure shape needs a separately reviewed
project.

The approved design is
[post-migration-forward-recovery-design](../superpowers/specs/2026-10-25-post-migration-forward-recovery-design.md).
The implementation plan is
[post-migration-forward-recovery](../superpowers/plans/2026-10-25-post-migration-forward-recovery.md).
Implementation, CI, protected deployment and release acceptance are separate gates.

## Required acceptance before production dispatch

Require exact-head PR CI, CodeQL/security checks and independent whole-branch
review, followed by exact merged-main CI. The required `production-bundle` job
runs the existing old-return rehearsal and then
`node deploy/platform/forward-ci.mjs --local-ci` serially. Forward rehearsal must
complete on Linux with actual Docker/PostgreSQL, Linux `renameat2` and both-parent
fsync, a fresh current ICU worker export, actual dump/isolated restore and owned
cleanup. Unit tests and the explicit macOS prerequisite refusal do not satisfy
this gate.

The forward harness uses two fresh isolated nested daemons serially: one reaches
healthy; another injects failure after actual API replacement and verifies exact
owned cleanup. Each applies candidate migrations once to its generated database,
fails canonically before API-up, then executes forward preparation on that same
migrated physical database. There is no retry of a failed forward operation.
The worker archive is staged inside the captured daemon volume under
`/var/lib/docker/markiro-forward-worker.tar`. Its SHA is read back through the live
container namespace before the single image load. DinD mounts a private tmpfs at
`/tmp`; the outer Docker archive API and live processes can see different files
there. The generated private tree therefore uses canonical Linux
`RUNNER_TEMP=/home/runner/work/_temp` (macOS diagnostic base `/private/tmp`),
with a fresh mode-0700 child. Other bases are refused. A non-secret byte probe
must pass archive upload, live exec read and archive download before the tree
or applications are used; later backup input/output copies share that base.

Before application processes, the staging network is disconnected, IPv4/IPv6
default routes are absent, and actual TCP egress must fail. No host socket or
host-directory bind enters the outer daemon. Only generated private inputs and
byte-verified declared source files are streamed in. Inner probe bind mounts
refer only to these isolated generated files.

`platform-forward-recovery-evidence` contains only the safe result JSON. Require
`completed`, `isolated`, `cleanup` and every required check to be true. Inspect
both namespace outcomes, exact image/source/migration identities and private
safe failure stage when a check fails. Failure evidence preserves only allowlisted
compiled stage, error code/class, numeric exit status, executable basename,
command category and finite process-reason category from the shared harness.
Confirmed isolation/cleanup observations remain visible even when acceptance
fails; they never substitute for the complete successful proof. Private directories,
generated keys, database archives, retained container metadata, argv, environment
and raw stdout/stderr are never CI artifacts.
Synthetic GitHub approval, key-custody and offhost attestations are explicitly test
inputs; they do not authorize production or prove real Mac/Timeweb copies. Test
TLS uses a private CA and `.localhost`; it does not verify production DNS/ACME.

## Fresh operation and immutable authorities

Select one new UUID once, after fresh read-only observation and green main.
Pin executor SHA and its exact main CI independently of the already accepted
product source, protected publisher run/attempt, artifact, API/edge manifest
references and registry configuration IDs. A configuration ID is not an image
manifest reference. Automatic publishers on new main do not replace the accepted
product.

Preserve the original five recovered authorities and the failed upgrade's seven
exact authority files, their old source installations, configurations, images,
backup descriptors and copies. The new record kind is
`platform-forward-recovery-host-operation`; only `post-migration-prepare` and
`post-migration-activate` are valid. Its `historicalSources` pins both historical
installation receipts. Those installations are verified using their own executor
roots and file lists, never reinterpreted using the expanded current closure.

Under `/opt/markiro-platform`:

| Path                                               | Purpose                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `upgrade-bootstrap/<new-executor>/`                | New byte-verified source installation, side by side                                |
| `upgrade-operations/<uuid>/<phase>/operation.json` | Immutable phase input and independent protected authorization                      |
| `state/upgrade-installed-executor-<uuid>.json`     | Exact current source closure, executor CI and installation dispatch                |
| `state/forward-backup-runtime-<uuid>.json`         | New verified worker descriptor; old three descriptors remain unchanged             |
| `state/forward-recovery-operations/<uuid>/`        | New journal, consumptions, archived predecessor index and durable handoff receipts |
| `state/forward-retained-<uuid>.json`               | Exclusive private full stopped predecessor container/image metadata                |
| `state/upgrade-index.json`                         | New explicitly typed forward ownership index                                       |
| `state/.deploy.lock`                               | Existing common process/durability lock                                            |

Do not precreate the new journal directory. Do not remove a lock or any delivery,
execution-fence or command-started marker. Do not patch bytes, expiry or sequence.
The canonical guarded prepare creates durable handoff intent, renames only the
old index with `RENAME_NOREPLACE`, fsyncs both parents and verifies bytes,
dev/inode/uid/gid/mode/size/mtime. The new ctime is recorded. Historical operation
trees remain in place. Any handoff uncertainty retains the lock.

## Protected prepare

Use the existing `.github/workflows/upgrade-platform.yml` on exact reviewed main,
phase `post-migration-prepare`, new run, attempt 1. It retains
`production-deploy` and `timeweb-platform-production`; self approval and reruns
are rejected. Immediately record and provide the run URL with approval withheld.
Provision immutable inputs and read them back while the run waits. Request the
second account only when the full package and expiry are ready.

The loader authenticates bytes/history/configuration without a token or process
on receive. After delivery/fence/private stdin token publication, trusted runtime
rechecks live GitHub authorization, product publisher/artifact and executor CI,
then reads complete original migration SQL/journal bytes from an inert exact
pinned API image: copy the bounded journal first, validate its complete ordered
SQL filenames, then copy only those SQL files from the same never-started owned
container. Snapshot JSON is never copied, and per-file/cumulative limits remain
in force. Full ordered migration hashes/timestamps, physical PG/system,
schema and source recipes must match at protected boundaries. Neither row count
nor an operator-supplied digest can replace that proof.

Prepare preserves full actual stopped container/image metadata before any later
Compose replacement. It performs a new live-source dump, full isolated restore
with all ten checks and resource cleanup, and reaches new sequence 6 only after
independent archive/inventory/evidence verification. The migration latch remains
true. An old pre-migration archive is historical evidence, never the current
migrated database baseline.

On success independently inspect canonical state, source/worker provenance,
physical PG/schema/full ledger and actual backup/restore/cleanup. Create new
unique encrypted Mac and Timeweb children, authenticate/decrypt/hash every file
and verify exact S3 VersionIds/full GETs/private ACL/versioning. Preserve all old
copies and independent key custody; never upload the recovery key. The source
applications remain stopped.

## Separate protected activation

Repeat actual key continuity, PG/TLS/role and full ledger checks, retained-intent
projection, source hold and independent copy acceptance. Prepare a fresh immutable
activation decision bound to the exact sequence-6 bytes, new dispatch and expiry.
Use `post-migration-activate` in a separate new attempt-1 run. Provide its URL at
dispatch; request distinct second-account approval only after provisioning and
independent ready-input readback. Do not reuse the prepare approval.

The compiled command surface is API-up, edge-up and smoke. PostgreSQL is never a
target. Normal exact Compose up may replace and remove only the two retained
stopped API/edge containers; it never starts/stops/removes their IDs directly.
Their full metadata, source/configuration, images and historical journals remain
retained. Candidate IDs must be new and recipes exact. Catalog writers remain
false and unproven namespaces closed.

All source/config/image/physical PG/schema/full ledger/backup/copy/key/fence/
projection/approval gates remain. Slow read-only checks precede the final actual
fence and cleanup observations; both retain the strict 30-second limit and the
synchronous check at actual spawn. No timestamp substitution or TTL extension is
allowed. Compare retained job projection immediately before API-up, not after
accepted candidate writers have started; later checks still verify all remaining
authorities.

On failure preserve the first sanitized private diagnostic before cleanup. Only
confirmed owned new probes/candidates may be cleaned; old IDs, PostgreSQL and
archives are excluded. Unknown child termination or durability retains the lock
and forbids competing cleanup. Preserve canonical failed state, daemon/process
outcome and all evidence. Never retry, select another UUID automatically, return
old, restore SQL or edit a journal/index. A subsequent attempt requires a newly
reviewed terminal predecessor.

## Independent live and release acceptance

After successful activation, independently inspect terminal healthy sequence 14,
all source/history/consumption/index evidence, same physical PostgreSQL and full
schema/ledger, exact new API/edge IDs/images/config/network/roles, and strict
external TLS/admin/API responses against intended IP and public DNS. Close
maintenance only after actual acceptance.

Then resume [release hosting](release-hosting.md) and
[handheld releases](handheld-release.md): releases DNS/TLS/read-only resolver,
complete immutable history/reservations under actual protected authorization and
fencing, pinned readback and technical byte-swap, then separately approved writer
epochs and publications. Preserve the already issued Autonom 1.0.0. A CI artifact
for 1.1.0 is not a signed/published installer; Station/handheld/Windows/real-device
acceptance remains separate. Preserve the active nightly backup schedule and
change its source only after the new runtime is actually accepted.
