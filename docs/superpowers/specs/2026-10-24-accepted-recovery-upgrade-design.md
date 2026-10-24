# Safe first catalog upgrade from the accepted Timeweb recovery

Status: owner approved the availability policy and sequential implementation plan on 2026-10-24; not executable or approved for production. Current catalog PR #795 remains a separate reviewed change. No existing deployment, journal, runtime snapshot, backup, key, or release is changed by this document.

## Purpose and measured starting point

Enable the approved read-only immutable release resolver on the existing Timeweb host. Preserve the full accepted recovery history and exact old configuration while changing application images and adding catalog configuration/mounts. Do not redesign the general deployment system, reopen unknown release namespaces, publish a new release, or enable catalog writers.

Fresh safe evidence: `catalog-transition-observation.json` and `accepted-recovery-authority.json` in `/tmp/markiro-release-preparation-20261024`. The original ordinary journal is sequence 14/api-started/recovery-required; the recovery sidecar is sequence 16/healthy/completed. Its preparation hash, activation envelope, dispatch and operation ID agree with the retained protected operation and consumption receipt. Original/recovery bytes, file metadata and runtime snapshot paths/hashes are retained. Live API/PG are healthy and edge is running, product source 0d30c7341bc9dfcabafaf60cb4a9b9173e56736d. No catalog mounts/configuration exist. These observations establish prerequisites, not fresh deployment authorization.

Three source-confirmed barriers:

- `host/deploy.mjs:116` admits production prepared-target version 2 only with an empty ordinary journal.
- `host/state.mjs:begin` rejects unresolved ordinary state; it does not consume successful recovery as its predecessor.
- `host/observe.mjs` selects a previous image/provenance but candidate configuration for non-provenance environment and mounts.

Existing recovery commands also reject a changed product/configuration and are one-shot. Neither ordinary nor recovery dispatch is a safe upgrade command for this host. New directories with an empty journal, archive-and-reset, relabelling the original operation as healthy, or manually replacing containers are rejected alternatives.

## Proposed authority and scope (builder choices)

Add an explicit accepted-recovery upgrade mode to protected platform orchestration, with separate `prepare` and `activate` phases, sharing the existing `timeweb-platform-production` concurrency group and production-deploy environment. Keep ordinary first-deploy and failed-recovery paths unchanged. The implementation must use installed, exact-main-CI-verified modules and data-only immutable operation records, not arbitrary shell callbacks.

An upgrade admission binds: a new operation UUID; exact predecessor original/recovery/preparation/consumption/activation-operation hashes; target host/docker/database/volume identity; predecessor product/image/configuration authority; candidate product publisher manifest and executor CI; candidate configuration hash; dispatch identity; deadline; reviewed transition-plan digest. The retained original recovery must be healthy/completed with valid structural phase/sequence, and the consumption hash must authenticate the exact activation bytes, preparation and dispatch. Old expiry is historical: it never authorizes a new action. Fresh admission and protected approval do.

All original journal, preparation, consumption, operation and runtime-snapshot bytes remain immutable in their existing locations. The upgrade gets a fixed per-operation private journal and exclusive consumption receipt; the target-wide `.deploy.lock` still serializes every mutation and drains producers before release. An existing entered/failed/uncertain upgrade cannot be resumed, overwritten, hidden by selecting another UUID, or ignored. A durable target-wide upgrade index identifies that outstanding operation. The index is published under the same lock before any external action. Every action rechecks predecessor/index/journal integrity and current admission. Crash ordering and uncertainty must fail closed with retained evidence.

Success records the new healthy deployment separately; it does not rewrite the old failed journal. This extension covers the first transition from the exact accepted recovery. Future upgrades must explicitly consume the new healthy authority; no claim that ordinary deployment magically starts working afterward. No generic bypass flag or automatic retirement API.

## Old and candidate configuration boundaries

Carry both configurations as separately byte-bound private snapshots. Before stopping old API/edge, verify exact old images, entrypoint/Cmd, environment, ports, networks, mounts, target/database identity and old configuration hash. Unknown containers/configuration/mounts reject the operation. After stop, verify the same exact owned old containers are stopped; postgres remains unchanged and healthy. Candidate configuration becomes authoritative only for the owned migration container and new API/edge in their entered phases.

Do not relax full-environment equality or use a union of old/new permitted mounts. Observations choose a complete old or candidate authority according to journal phase and exact container identity. Same-image configuration changes still use the phase/identity authority, never an image-ID heuristic alone. Secret values remain in protected snapshots and process stdin; diagnostics show hashes and key names only.

## Protected sequence and downtime

1. Before prepare approval: exact merged-main CI/artifact verification; measured capacities; schema/migration inspection; verified old authority; complete candidate configuration with catalog writers disabled, all namespaces initially closed, fixed OIDC pins and private mounts; immutable plan/operation input hashes. Deliver the prepared workflow URL and explicitly state the maintenance interval.
2. Protected prepare: acquire target lock, publish/consume the new admission, verify old runtime, stop only exact owned API/edge, prove writer fence, create a new backup of the actual current Timeweb database, perform isolated restore with ownership/ACL and catalog evidence checks, retain the backup and immutable preparation proof. No source Yandex dependency and no restore into the active database. Leave API/edge stopped while preparing independent encrypted Mac/Timeweb copies; report downtime clearly. Production approval authorizes the maintenance interval. It has a planned duration, not a guaranteed maximum: failed or expired activation leaves applications stopped until separately verified recovery.
3. Before activate approval: full authenticated/hash verification of new independent copies, recovery-key custody/continuity, fresh fence and source-hold, current image/artifact/configuration/IAM/lifecycle evidence, expiry and migration compatibility. Bind these to a distinct activation consumption receipt. Preparation alone cannot start applications or run schema migrations.
4. Protected activate: recheck everything, apply candidate migrations through the existing isolated migrator role and exact owned container, verify schema and roles, start candidate API then edge, perform host checks and strict external TLS checks. Journal every entered/completed phase durably. Catalog writers remain disabled. Existing immutable history/reservations are imported only through separately reviewed catalog operator authority.
5. Only after full external resolver proof and intended TLS: change releases DNS. A technical versioned fixture must demonstrate that overwriting current S3 bytes does not change bound public bytes. No mutable-S3 rollback. Namespace activation and actual release workflows retain their independent history/signing/protected gates.

Failures never repeat automatically. Unknown process termination/durable writes retain the target lock. Known terminal failure retains its journal and stops only workloads started by this upgrade. Old apps are not automatically restarted after a possibly applied migration. If preparation fails before migration, a separately checked exact-old-runtime recovery may be proposed; it is not a hidden side effect. Backup/copies and all old authority files remain intact.

## Required tests and operational acceptance

RED then GREEN, serially:

- Admit exact accepted recovery; reject failed/incomplete/foreign recovery, changed preparation/consumption/operation bytes, wrong dispatch/product/config/target, expired or reused new admission, mismatched fresh approval, uncertain/outstanding upgrade.
- Crash/fault injection at each index/receipt/journal write and fsync; no command before durable admission; forgotten async producer drains; no second UUID bypass; no old file changes; one target lock across ordinary/recovery/upgrade paths.
- Running and stopped old API/edge with different candidate image/config/mounts; same-image configuration-only upgrade; foreign/mixed env or mounts rejected; exact phase selects authority; postgres unaffected.
- Actual isolated PostgreSQL source backup and restore, migration and runtime-role ACLs; rollback boundary and stale backup rejection; catalog inventory/ledger preservation and writer fence.
- Fresh copy/key/fence proof before activation; prepare cannot migrate/start; failed activate cannot re-run; changed bytes/deadline between awaits reject immediately before process spawn.
- Existing ordinary/recovery tests unchanged; source closure, workflow input/permission/concurrency tests, production bundle contracts, actual Caddy and exact-main CI.

One independent review of this transition implementation and concrete operation package is required before any production execution. The catalog implementation's prior review does not approve this new authority path. Physical Windows/Android/device acceptance remains separate.

## Owner availability decision (2026-10-24)

The approved catalog plan assumed an existing protected upgrade path. Current source and host prove that path is absent. This proposal adds a narrowly scoped protected first-upgrade capability and a maintenance window spanning the fenced backup/copy/activation phases. The owner chose: prepare and verify return of the exact old version before migration, and agree the maintenance window before starting. Exact production approvals still occur only after concrete inputs are ready. Current PR CI/review/merge preparation can continue independently.

## Independent builder check

Read-only review by /root/release_catalog_design_check found this suitable for user agreement, with one owner decision: the planned maintenance duration and whether a fail-closed overrun is acceptable. A hard upper bound cannot be promised while copy verification and a second protected approval occur with applications stopped. If that is unacceptable, prepare and verify exact-old-runtime recovery before migration before beginning the maintenance window. Once migrations may have run, there is no automatic old-version restart. Review is not production approval.

## Required pre-migration return

The old API and edge containers remain present, stopped and unmodified throughout prepare and the wait for activation. Record and recheck exact container IDs, image IDs, full old configuration, mounts, networks, ownership, database identity and migration/schema fingerprint. The only pre-migration return action starts those exact retained containers, API then edge, with the separately authenticated old authority, verifies old host health and external TLS, and records a terminal `returned-old` result. It never recreates a missing or changed old container.

Return is a separately consumed protected `return-old` phase of the same upgrade operation. Its admission is fresh and tied to the original prepare plus current observed bytes, so expired activation does not authorize new work. Before maintenance, prepare its trusted code and rehearse against isolated owned containers and an isolated restored database with denied external egress and test credentials. Record the old image hashes and the limits of that rehearsal; it is not proof of an actual production return. During maintenance, a prepare failure or expiry must immediately provide the ready return workflow URL if all safe-return checks pass. Do not leave an unprepared rescue path as the only availability option. The maintenance window and the need for approval of `return-old` are stated before prepare approval.

A durable monotonic `migrationEntered` latch is written and fsynced BEFORE spawning any migrator. Once present, even if the process fails to spawn or reports failure, `return-old` is prohibited. Missing/ambiguous journal durability, changed schema/migration fingerprint, changed predecessor/container/configuration, a foreign active workload, or unconfirmed producer termination also prohibit it. Return and activation race under the same target lock and cannot both consume preparation. No automatic return after migration, no restoring a backup over the active database, and no restart based solely on a failed CI result. A lost successful return response is reconciled read-only from its retained terminal receipt; it does not start containers again.
