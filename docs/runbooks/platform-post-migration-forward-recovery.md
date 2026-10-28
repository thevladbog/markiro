# Post-migration forward recovery

The base admission applies to the reviewed failed upgrade at terminal
`api-started/recovery-required`, sequence 14, with `migrationEntered=true`.
A separately reviewed `platform-forward-admission-successor` variant accepts
exactly one failed base forward preparation at sequence2/admitted/recovery-required,
with the migration latch true and sourceRuntime, backup and preparation all null.
It preserves the already migrated physical PostgreSQL database. It never runs
another migrator, restores SQL over that database, starts old applications, or
returns the old version. A different failure shape needs a separately reviewed
project. The separately approved `platform-forward-activation-successor` accepts
only the exact expired sequence10/api-started/recovery-required successor,
with its canonical sequence6 preparation and both consumed phases preserved.
The owner-authorized `platform-forward-edge-successor` additionally accepts exactly
one later sequence12/edge-started/recovery-required failure of that legacy
activation successor. The new API must be stopped after replacement; the original
edge and PostgreSQL IDs stay exact. A genuine private reader binds all phase,
consumption, handoff, source-closure and stopped-source observation files. The
fixed chain is edge successor → activation successor → pre-backup successor →
failed upgrade → accepted recovery. It cannot recursively accept another edge
successor. Source ownership uses the actual stopped API ID and candidate image;
recipe classification keeps the original predecessor IDs. Both application
services use `--force-recreate` so a stopped same-image source is never restarted.

The successor design and plan are
[pre-backup-forward-successor-design](../superpowers/specs/2026-10-26-pre-backup-forward-successor-design.md)
and [pre-backup-forward-successor](../superpowers/plans/2026-10-26-pre-backup-forward-successor.md).
The genuine private-file reader must prove no retained runtime, activation directory,
activation consumption or extra phase/state files. Its exact13file digest set includes
the prior input, dispatch consumption, installation/runtime receipts, delivery/fence/
command markers, first failure, handoff receipts, current index and older archive;
the job token remains private and is never read into that evidence. Historical
execution-source receipts use their own file lists. New authorization is fresh;
historical expiry is checked historically and never renewed.

The successor archives the CURRENT failed-forward index directly through the
existing locked NOREPLACE/fsync handoff. The older failed-upgrade index stays in
the failed forward operation's own predecessor-index.json. Never restore an older
global index, patch a journal, delete a marker or replay a consumed run. Any
uncertainty retains the shared lock. Each protected phase needs its own new run
and independent approval after immutable inputs and loader readback are ready.
New actual backup/restore and unique encrypted Mac/Timeweb copies remain mandatory.

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
fails canonically before API-up, then executes a base forward admission from the
exact historical Git executor cdae4e1ab3faf57c4941d8373aeba345fa0ef5de. A trusted
publisher502 injection creates only sequence2 before retained capture or backup.
Its own source closure, proof extractor and diagnostics are used, without relabeling
current source bytes. The exact historical9c5240964bcf8869838e5574015d2838f3c42d57 Git closure
then performs actual preparation/backup/isolated restore. Its real DB/TLS probe
is retained as an exact exited container using a CI-only uncertain-transport
injection after successful execution. The historical state coordinator uses a
frozen CI clock to seed the canonical sequence10 expiry before API replacement;
the subsequent successor uses ordinary wall time. The rehearsal preserves the
lock through durable rename receipts and removes only the exact inspected probe
by ID. This is a disposable namespace fixture, never production reconciliation
or approval authority. The current executor authenticates all four historical
closures and hands ownership directly from the failed activation index, with
both older archives unchanged. It performs another actual fresh backup/restore
before the healthy or post-replacement failure outcome.

New forward admissions and activation decisions use version2 with
`authority: "protected-dispatch-once"` and no `expiresAt`. PreparedTarget version3
has the same authority policy. Elapsed time alone does not revoke this single-use
operation. Legacy version1 admissions/decisions and version2 prepared targets
retain their original expiry rules for historical validation; their bytes and
consumption markers are never edited or revived.

Before API/edge Compose-up, production rechecks the exact running protected
GitHub run/attempt, executor and independent approval after asynchronous local
checks. Cancellation, changed sources, changed physical identity, reused
consumption or a lost fence refuse the command. Fresh workload/fence observations
still have their strict30second limit. Natural TLS certificate expiry, key
continuity, exact backup/restore/copy hashes, projection and schema checks remain.
Immutable backup/attestation age does not grant or revoke the run authority.
Ordinary deployment cannot accept PreparedTarget3.

The Linux rehearsal additionally uses the exact0b6ab03da0d560a5946cf5ff3e5b8485d1d124ff
historical closure to prepare a real backup, replace API, then seed the controlled
legacy failure at edge entry and stop only that new API. Its CI-only frozen
coordinator clock never enters installed production inputs. The final current
executor authenticates all five historical cohorts and performs another fresh
actual backup/restore from the mixed stopped source before activation. All older
journals, archives and image/source identities remain bound.

Safe evidence requires both namespace outcomes, full202migration schema and every
mandatory check, including `edgeSuccessor`. Monotonic measurements include product
extraction, preparation and activation, Docker calls and source verifications.
The final product extraction plus complete current activation, including proof
construction and owned failure cleanup, must still fit25minutes. This CI
performance gate is independent of production authorization; it is not a
production wall-clock guarantee. No consumed failed operation is retried.
The worker archive is staged inside the captured daemon volume under
`/var/lib/docker/markiro-forward-worker.tar`. Its SHA is read back through the live
container namespace before the single image load. DinD mounts a private tmpfs at
`/tmp`; the outer Docker archive API and live processes can see different files
there. The generated private tree therefore uses canonical Linux
`RUNNER_TEMP=/home/runner/work/_temp` (macOS diagnostic base `/private/tmp`),
with a fresh mode-0700 child. Other bases are refused. A non-secret byte probe
must pass archive upload, live exec read and archive download before the tree
or applications are used; later backup input/output copies share that base.
Restore input directories use that verified archive-copy boundary, avoiding an
in-memory TAR through the control runner's 1 MiB stdin limit. Local ownership,
file/link/mode checks run before transfer; every received directory must remain
0700 and every file must match its hash, size and mode afterward. The ordinary
process limits remain unchanged. The outer CI job budget is 150 minutes:
run 40296243127 used 69 minutes without completing its first namespace, with
the second required serial scenario and final stack still pending. This is a
resource estimate, not completion evidence. Both scenarios, verified cleanup,
process/operation deadlines and acceptance checks remain required.
The final synthetic activation exercises the nonexpiring dispatch-bound policy.
Protected transport has a120minute job resource budget with bounded child/SSH
execution inside it; these resource limits terminate stalled processes and do
not create an expiry-bearing deployment admission. Individual command/network
bounds and cancellation/termination handling remain enforced.

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
allowed. Each prepared-target boundary samples fence and cleanup together inside
one compiled held action after physical admission; no separate store baseline is
inserted between those observations. Source/held authority is verified before
returning its checked proof, environment/files and freshness closure. Cached
freshness is rechecked immediately after the outer post-baseline; it never grants
spawn authority. After the command guard's physical baseline, a new held action
repeats the complete prepared-target boundary through its inner adapters. It
verifies source authority again, then invokes only the coordinator's fixed Compose
callback with the newly checked environment and freshness closure. The outer
guard's post-command physical check remains unchanged. Compare retained job
projection immediately before API-up, not after
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
