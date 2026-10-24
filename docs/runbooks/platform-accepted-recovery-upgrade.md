# First upgrade of an accepted Timeweb recovery

This procedure upgrades the accepted recovery to the read-only release catalog.
It is not an ordinary deployment retry and does not enable catalog publishers.
The implementation is described in
[the approved design](../superpowers/specs/2026-10-24-accepted-recovery-upgrade-design.md)
and [execution plan](../superpowers/plans/2026-10-24-accepted-recovery-upgrade.md).

## Acceptance before scheduling maintenance

The operator package must contain all of the following verified evidence:

- Successful exact-head PR checks, independent whole-change review, merge and
  successful exact-main executor CI. Product source and publisher artifact are
  selected independently from the executor; a new main publisher is not a
  substitute for the accepted product selection.
- A successful isolated return rehearsal with the reviewed old API/edge images,
  an isolated restored PostgreSQL database, generated credentials and proved
  blocked external egress. Record image IDs, source closure, exact container IDs,
  schema fingerprints, health/TLS results and owned cleanup. Unit/fake-daemon
  tests alone are not this rehearsal. The rehearsal cannot authorize production.
- Fresh read-only observation of actual old containers, physical PG system and
  volume, full old configuration, schema/migration fingerprint, target lock,
  accepted predecessor journals and available capacity.
- A reviewed immutable operator package for the new operation, source closure,
  executor worker, old return path, fresh backup/isolated restore, independent
  encrypted Mac and Timeweb copies, key checks and candidate configuration.
  Catalog writers remain `false`; unproven namespaces remain closed.
- An agreed maintenance window. Explain that API/edge remain stopped while fresh
  backup, restore and independent copies are verified. The planned interval is
  not a guaranteed upper bound. Return needs its own fresh approval and is
  prohibited once migration may have started.

Do not infer any of these gates from the presence of this runbook or from a
merged implementation. Store the actual evidence in the operation journal.

## Isolated rehearsal

Run `node deploy/platform/upgrade-ci.mjs --local-ci` from the reviewed checkout.
The local Docker CLI must resolve to a Unix socket and the pinned Docker-in-Docker
image declared in `upgrade-ci-guards.mjs` must already be available. The harness
uses its own uniquely labelled container and named volume; it does not mount the
host Docker socket or host directories. It downloads the three pinned old images
before disconnecting its only staging network. No application is launched until
network attachments and default routes are absent and a real TCP egress probe is
refused. The normal inner application networks remain unchanged.

All credentials, TLS keys and database contents are generated for the rehearsal.
The old schema is initialized by the pinned old migrator and restored from a
custom-format dump before the retained API and edge start. The production return
coordinator, exact-ID command adapter, full old observer and schema observer then
exercise stop/return against that isolated daemon. GitHub approvals, historical
journals and backup admission records in this test are synthetic and provide no
production authorization or fresh production backup evidence. Local TLS uses a
private Caddy CA and `.localhost` names, so it does not verify public DNS or ACME.

The required `production-bundle` CI job runs this rehearsal serially after the
failed-activation recovery check and before the platform stack. Its
`platform-upgrade-return-evidence` artifact contains only the safe result JSON,
including the fixed failing stage and command category after a failed run.
A failed result remains a failed CI gate and cannot establish return acceptance.
The private rehearsal directory is never an artifact. The exact old executor
Git objects must be present in the checkout before starting.

The printed private result path records actual image IDs, source hashes,
container IDs, schema, checks and cleanup status. Only a completed result with
successful owned cleanup is a rehearsal pass. A failure preserves private
bounded diagnostics; inspect them before another run. Never upload the private
root, environment files or generated keys. Cleanup rechecks both the exact outer
container ID and volume identity/label before removing either; it never prunes a
shared daemon. A partially created or changed resource requires inspection.

## Authority and immutable paths

Use one new operation UUID throughout all phases. Preserve the original ordinary
state and the accepted recovery's state, preparation, consumption and activation
operation at their existing paths, with their exact bytes and identities. Do not
retire them, relabel their executor or patch an expired input.

Under `/opt/markiro-platform`:

| Path                                               | Purpose                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `upgrade-bootstrap/<executor-sha>/`                | Exact reviewed Git source closure, installed independently before delivery   |
| `upgrade-operations/<uuid>/<phase>/operation.json` | Private immutable input for `prepare`, `activate` or `return-old`            |
| `state/upgrade-installed-executor-<uuid>.json`     | Complete source hashes, exact executor CI and original installation dispatch |
| `state/upgrade-backup-runtime-<uuid>.json`         | Separate verified live-source backup worker authority                        |
| `state/upgrade-index.json`                         | Durable target-wide first-upgrade ownership; never automatically removed     |
| `state/upgrade-operations/<uuid>/state.json`       | Entered/completed phases and monotonic migration latch                       |
| `state/.deploy.lock`                               | Shared ordinary/recovery/upgrade process and durability lock                 |

Do not precreate the state journal's operation directory. The guarded store
creates it exclusively. This directory differs from the input directory beside
`state/`. Files are private, owners and canonical paths are checked, and inputs
are create-only. Preserve all previous backup runtimes and copied evidence.

Each delivery creates `delivery.json`, then `execution-fence.json`, and finally
`command-started.json` in its phase input directory. They remain after success,
failure or a lost response. They are not retry controls to remove manually.

## Protected phase dispatch

Use `.github/workflows/upgrade-platform.yml` on `main`. The workflow serializes
with every platform production operation through `timeweb-platform-production`
and requires the existing `production-deploy` environment.

Every phase needs a **new run, attempt 1**, with the exact reviewed executor SHA,
its successful main CI run/attempt, accepted product source SHA, publisher
run/attempt, immutable artifact ID and the same new operation UUID. The dispatch
SHA must equal the executor SHA. If main has moved, do not substitute another
executor silently.

Immediately record the run URL. Provision and verify the immutable phase inputs
before requesting approval from the second account. The stored actor, distinct
human reviewer and environment identities must match the live GitHub approval.
Do not approve the actor's own deployment or rerun an old workflow. GitHub review
history is run-scoped; attempt 1 prevents reusing an earlier attempt's approval.

The workflow keeps private keys and tokens on stdin/private files, never command
arguments or artifacts. Its receiver verifies the complete Git source bundle
against the preinstalled receipt; it cannot install or replace executor files.
Exact publisher artifact/ZIP, image manifests, executor CI, current dispatch and
protected approval are checked again on the host before execution.

## Prepare

Prepare admission binds the five predecessor byte hashes, old/candidate
configuration hashes, target and operation identities, executor CI, reviewed
plan, new dispatch and an expiry no more than an hour ahead. The recorded old
runtime includes all three retained container IDs and a database schema/migration
fingerprint before any stop.

The guarded sequence admits the operation, stops the exact old edge then API,
proves they are stopped with PostgreSQL unchanged, and runs an actual-source
backup plus isolated restore. It durably records the backup, restore and fence
proofs. It neither starts candidate apps nor migrates the active database.

After `backup-verified`, independently read the actual journal/proofs. Create new
unique encrypted Mac and Timeweb copy children and verify complete authenticated
reads, hashes and the required storage permissions/version identities. Preserve
old copies. Do not upload the recovery key or reuse historical expired evidence.

## Activate

Create a separate fresh activation admission tied to the exact current prepared
journal bytes and sequence. Supply the complete verified backup/restore,
independent-copy, key, source-hold, retained-intent and candidate configuration
proofs. Do not patch the prepare admission to make it fresh.

After its independent protected approval, activation verifies the prepared target
and source closure, pulls exact images and durably sets `migrationEntered`
**before** spawning the migrator. It verifies migration and roles, then starts the
candidate API and edge. Observers select the entire old or candidate authority by
exact retained IDs; image equality alone is insufficient. New apps must replace
the old application IDs; PostgreSQL retains its physical identity.

Accept success only after the actual terminal `healthy` journal, independent
external strict-TLS/admin/API checks and source/operation identity verification.
This does not prove installed devices have updated, or that release DNS/history
and public bytes are correct. Continue those separate catalog/release gates.

## Return before migration

Return requires its own new protected `return-old` run and fresh admission,
bound to the current exact prepared or known failed-before-migration journal.
It never restarts an already consumed return phase.

Before every action it verifies predecessor bytes, both configurations, exact old
container IDs, physical database and unchanged schema/migration fingerprint.
It starts the exact retained old API, then edge, without recreating either.
Health readiness may wait only while Docker reports `starting`; missing or
`unhealthy` status is a refusal. Old health and strict TLS must pass before the
terminal `returned-old` result is accepted. Independently confirm external health.

A missing/recreated/changed old container, changed schema, foreign workload,
unknown producer termination or uncertain durability denies return. The durable
migration latch always denies return, including a migrator that failed to spawn.
There is no automatic SQL restore or post-migration old-version rollback.

## Failure and lost responses

Preserve exact logs privately, all journals, phase inputs, backup/copy evidence
and source installations. First inspect the recorded phase, latch, lock,
containers and process termination read-only. Do not redispatch, reprovision,
change UUID, remove a fence/lock or edit a journal to get another attempt.

For a proved pre-migration failure, prepare the fresh protected return URL only
after safe-return checks pass. If approval/input expiry occurred with old apps
stopped, do not claim availability until the return has actually succeeded.

After migration may have started, failure remains terminal for separate reviewed
reconciliation. Known-outcome cleanup can stop only fully observed candidate
workloads and the owned migrator; retained old IDs are excluded. Unknown outcomes
retain the lock and prohibit competing cleanup. A lost success response is
resolved from the immutable terminal evidence, not by executing the phase again.
