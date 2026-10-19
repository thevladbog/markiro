# Platform database recovery preparation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and prove the local PostgreSQL backup/restore gate before connecting the compact host executor to server commands.

**Architecture:** Keep the release admission and host journal from PRs #733/#734 unchanged until those PRs are accepted. First provide bounded host processes, then separate protected runtime/migration credentials, and finally verify real backup bytes through an isolated restore. No public deployment entry point is introduced by this plan.

**Tech Stack:** Node 24 native APIs, PostgreSQL 17, Docker Compose V2, current pinned pg-boss 12.27.0, existing migration/runtime libraries; no new JavaScript dependencies.

**Spec:** `docs/superpowers/specs/2026-10-18-timeweb-host-delivery-design.md`, remaining command-safety prerequisite and database/backup/prepared-target portions of implementation steps 2–3.

## Global Constraints

- Target remains Linux amd64, 2 vCPU / 4 GiB, fixed project `markiro-platform`, local PG17 and platform-only profiles. CRM, n8n and Chatwoot hosting remain excluded.
- This is preparation code and disposable local testing. No merge, VM purchase, SSH, server changes, DNS, production restore, new production keys, deployment dispatch or production credential rotation.
- Reuse the existing worktree. The plan branch starts at reviewed head `30d3e0338d66f2737e086c9e6038ca1d5c9b6bfc`; do not amend or force-push #734 to add this work.
- Preserve existing source and immutable backups. Do not load the user's `.env`, shared development database or production credentials into tests. Tests create unique disposable projects/volumes with generated credentials and no published ports; clean only those resources owned by the test.
- Host files use the existing canonical private-root, ownership, 0700/0600, no-symlink and durable-publication contracts. Large archives must be streamed; the 1 MiB `readPrivateFile` limit must not be raised to accommodate dumps.
- Secrets never enter command arguments, Compose interpolation, public logs or evidence. No shell command strings, ambient Docker/Compose/proxy settings, new dependency, detector exclusion or automatic stale-lock removal.
- Archive and restore evidence are immutable and operation/target-bound. A JSON claim, checksum alone, successful dump or synthetic fixture is not acceptance of production recovery.
- Keep the existing migration history. Do not rewrite applied SQL, disable constraints, drop client data or replay managed-provider superuser/membership grants blindly.

## Current-code findings

- `deploy/platform/compose.yml` gives API and migrate the same raw env file. `host/config.mjs` freezes only that file. A separate URL without a separate validated snapshot and Compose binding would not establish credential isolation.
- `packages/db/src/migrate-cli.ts` reads `DATABASE_URL`; the runtime migrator acquires an advisory lock and can run online migration stages outside a single transaction. A Docker CLI timeout alone is not proof its migration container stopped.
- `apps/api/src/jobs/platform-jobs.service.ts` starts pg-boss and creates queues in `pgboss_platform`. The installed pg-boss defaults enable schema creation/migration. A blanket DML-only application role would break current startup and maintenance behavior.
- The repository has no dedicated PostgreSQL backup/restore implementation under `tools/` or `deploy/`. Existing journal backup hashes are only bindings. Add a reviewed producer/verifier rather than inventing a trusted `backupOk` callback.
- The parent design records a managed-provider role-grant restore failure. Owner/ACL mapping therefore needs an explicit source inventory and an accepted target policy. Do not treat an experiment with placeholder roles as preserved source permissions.

## Review Focus

1. A timed-out CLI can leave a child or Docker container working; prohibit journal advancement until the owned workload is confirmed stopped (Tasks 1 and 4).
2. Distinct usernames can still inherit each other's rights; test actual DDL denial, memberships and pg-boss startup, not URL inequality alone (Task 2).
3. A valid checksum can describe an incomplete or wrong-target dump; verify real restore, source/restore inventories and operation/target binding (Tasks 3–4).
4. Restored role grants or default privileges can silently widen access; enumerate source-to-target changes and reject unexplained owners/ACLs (Task 3).
5. A rehearsal API can send retained mail or prune diagnostics on startup; require independently enforced egress and retained-intent acceptance before API start (Task 4).

---

### Task 1: Bounded command runner and owned-workload stop contract

**Files:** Create `deploy/platform/host/process.mjs`, `deploy/platform/test/host-process.test.mjs`; consume `host/config.mjs` without weakening its environment checks.

**Interfaces:** `runHostProcess({ executable, args, cwd, env, timeoutMs, outputLimitBytes, signal }): Promise<{ stdout: Buffer, stderr: Buffer }>` is internal, uses an absolute executable path and an argument array, never a shell. Require a private canonical cwd, explicit environment, positive safe bounds (`timeoutMs <= 3600000`, `outputLimitBytes <= 1048576`). Output is private in-memory input to validators, never interpolated into errors. Errors expose only `ERR_HOST_PROCESS`, a fixed reason (`spawn`, `exit`, `timeout`, `aborted`, `output-limit`, `termination`) and `terminationConfirmed`.

- [ ] Write tests for literal shell metacharacters, absent ambient credentials, nonzero exit, overflow on each stream, already-aborted signals and spawn failure. A forked process tree that ignores TERM must be killed and reaped before rejection; use IPC to observe termination rather than sleeps as proof.
- [ ] Run `node --test deploy/platform/test/host-process.test.mjs`; record the missing-module RED result.
- [ ] Implement POSIX process-group termination with a 2-second TERM grace and a bounded KILL/reap stage. Reject unsupported platforms explicitly. Never claim this kills a Docker daemon-owned container: the future orchestration must use an operation-labelled, deterministic container name and independently stop/inspect it before recovery. Unconfirmed termination must retain unresolved state.
- [ ] Run focused tests and platform tests on macOS plus Linux CI. A process that escapes the group is outside the trusted-executable model; do not claim arbitrary adversarial containment.
- [ ] Commit explicit files and independently review timeout, output and cleanup behavior before backup integration.

### Task 2: Separate migration configuration and prove database privileges

**Files:** Modify `deploy/platform/compose.yml`, `deploy/platform/env.example`, `deploy/platform/host/config.mjs`, associated `host-config`, `contracts`, `compact`, `ci-stack` and `load` consumers; create `deploy/platform/postgres/roles.mjs`, `deploy/platform/test/postgres-roles.test.mjs` and a disposable local integration harness. Read `apps/api/AGENTS.md` before any API test/code change. Do not modify runtime migrations merely to grant broader privileges.

**Interfaces:** Preserve `snapshotHostConfig` for runtime configuration. Add `snapshotMigrationConfig({ root, candidateId, envFile, runtimeSnapshot }): Promise<{ path, sha256 }>` which reads a separate private input containing only `DATABASE_URL`, requires the same database/TLS endpoint as runtime and a distinct login, then publishes `candidates/<uuid>/migration.env` exclusively. Compose migrate receives `MARKIRO_PLATFORM_MIGRATION_ENV_FILE`; API continues to receive only `MARKIRO_PLATFORM_ENV_FILE`. Add only the validated migration file path to non-secret interpolation. The future aggregate configuration fingerprint must bind both actual snapshot hashes before any host operation.

**Role policy:** Use `markiro_app` and `markiro_migrator` as distinct LOGIN roles with NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION and NOBYPASSRLS, and no membership between them. Migrator owns the business/migration schemas and their mapped objects; API receives required DML/sequence privileges, no business-schema ownership or CREATE. Precreate `pgboss_platform` owned by the API role to support the current queue lifecycle, with no CREATE on the database and no grants on legacy `pgboss`. This deliberately permits queue-local DDL; do not describe the API as globally DML-only. Preinstall required extensions through isolated bootstrap ownership. Roles/password provisioning is a separate explicit operation, never an API-startup fallback.

- [ ] Write failing config tests for missing migration file, symlink/permissive input, same login, different database/CA/host, literal credential characters, unknown keys, snapshot reuse and secret leakage. Assert Compose API never receives migration credentials and migrate never receives license/mail/support keys.
- [ ] Run the focused tests and record RED. Implement the two-snapshot contract and update every exact interpolation-key assertion and synthetic Compose consumer together.
- [ ] Build a synthetic PG17 database under a unique isolated project, apply migrations twice as the migrator, and run the actual pinned pg-boss queue lifecycle as app. Verify business DDL, role creation and SET ROLE to migrator fail for app; expected DML and sequence use succeed, including objects created by a subsequent migration through default privileges.
- [ ] Verify CA/hostname/plaintext rejection with the two roles. Do not log URLs, passwords or query row contents. Fail rather than silently substituting a superuser when a migration needs an additional privilege; review the specific operation first.
- [ ] Run all affected platform contracts, production bundle contracts, CI policy, formatting and scoped lint. Ensure the isolated role harness is included in `production-bundle`; update CI tests if ownership changes. Commit and review this complete compatibility change separately.

### Task 3: Immutable archive and independently verified restore

**Files:** Create `deploy/platform/backup/archive.mjs`, `deploy/platform/backup/inventory.mjs`, `deploy/platform/backup/restore.mjs`, focused tests under `deploy/platform/test/backup-*.test.mjs`, and `deploy/platform/backup/README.md` documenting the trust boundary and resource cleanup. Reuse Task 1, private filesystem helpers and Task 2 role policy.

**Interfaces:** `createDatabaseBackup({ root, operationId, target, connectionFile, writerFence, run }): Promise<{ archivePath, archiveSha256, inventoryPath, inventorySha256 }>` produces an exclusive PG17 custom-format dump and canonical metadata. `verifyDatabaseRestore({ root, operationId, target, backup, roleMapping, run }): Promise<{ evidencePath, evidenceSha256 }>` reads the actual archive and inventory, creates an isolated disposable PG17 target and writes a completed report only after all checks pass. `run` is Task 1's bounded execution adapter; no network-facing CLI is exposed yet. `target` uses the existing `{ hostId, databaseId, volumeId }` identity. `roleMapping` is an explicit exhaustive source-role to target-role mapping with an allowlisted intended ACL delta, not raw executable source SQL.

- [ ] Write tests for changed/truncated archives, unexpected links, wrong target/operation, failed dump, partial restore, mismatched grants/default privileges/owners, missing extensions, invalid indexes/constraints, migration-journal mismatch, count/sequence changes and cleanup failure. Failed or incomplete evidence must never be accepted by the host journal.
- [ ] Run focused tests RED, then implement streaming hash/write/fsync with exclusive publication; store dump bytes only in private files. Do not pass a database URL in process arguments. The connection uses a private libpq service/password file; secrets remain outside evidence and environment inherited by unrelated children.
- [ ] Capture metadata with a stable ordering: role attributes/memberships, per-object owners/ACL/default privileges, extensions, migration journal, validation/index state, table counts and sequence state. Dump/count consistency requires fenced writers and a consistent snapshot; capture sequence state while the fence is held. A timestamp alone does not prove absence of writers.
- [ ] Restore synthetic data on an internal network with no public ports or app containers; check the explicit role mapping before executing any role/grant changes. Compare source and restored inventories under that mapping. Preserve encrypted column bytes and sequence `is_called`; do not emit client data in reports.
- [ ] Prove a real PG17 dump/restore round trip, corrupt-byte rejection and failure cleanup in the disposable harness. Stop/remove only operation-labelled temporary containers/volumes; never use global prune or delete old backups. Publish completion only after cleanup verification, otherwise return recovery-required evidence.
- [ ] Commit and independently review. A separate encrypted off-host copy and independently available recovery key remain mandatory operational gates; this local producer does not itself establish those facts.

### Task 4: Bind verified recovery evidence to prepared target

**Files:** Create `deploy/platform/host/backup-gate.mjs`, `deploy/platform/host/prepared-target.mjs`, focused tests, and update `docs/runbooks/timeweb-platform-preparation.md` and `docs/runbooks/timeweb-migration.md` with implemented versus pending gates.

**Interfaces:** `verifyBackupGate({ root, identity, backup, restoreEvidence }): Promise<BackupProof>` returns exactly the existing `{ archiveSha256, restoreEvidenceSha256, target, operationId }` journal shape only after rehashing immutable bytes and validating Task 3's complete evidence. `validatePreparedTarget(record, expected)` checks an exact versioned record binding target identity, PG17 digest/architecture/UID/GID, certificate fingerprint/expiry/SAN, both role-policy and configuration fingerprints, restored snapshot identity, writer-fence identity, isolated egress acceptance, key-continuity acceptance and off-host recovery reference. Each observation includes producer/tooling identity and distinguishes measured data from operator attestation. Use the same operation ID and require observations after its fence began; future/stale observations or a released fence reject.

- [ ] Write failing tests that mix evidence from different backups/operations/targets, replay before the writer fence, change either configuration snapshot, substitute an operator assertion for an automatic restore result, or omit egress/key/recovery acceptance. Verify rejected evidence cannot complete `backup-verified` in `withHostState`.
- [ ] Implement validation and byte rehashing. Operator acceptance cannot be inferred from JSON shape or local checks; retain the explicit provenance in the result. No automatic acceptance-file creation for live targets.
- [ ] Exercise the integrated path only against the disposable test target, including a timed-out migration container remaining active; prove migration/start/recovery actions do not advance until that workload is confirmed stopped and the fence remains valid.
- [ ] Run complete platform tests, production contracts, CI policy, formatting and final independent review. Report isolated PostgreSQL verification separately from actual target, production data, SMTP/S3, key continuity, capacity and off-host recovery acceptance.
- [ ] Commit the validated library slice. Protected SSH/workflow, complete command orchestration, host CLI, bootstrap and actual Timeweb rehearsal remain the next separate delivery stage; this plan does not dispatch them.

## Coverage and execution boundary

The plan covers process safety, separate protected credentials, target role policy, actual dump/restore verification and a prepared-target gate. Parent requirements for release admission remain owned by #733; durable state/config foundations remain owned by #734. Full Docker orchestration, authenticated transport, host CLI and operator bootstrap remain later work. Recovery clearing, automatic rollback, source freeze, provisioning and DNS cutover are deliberately not implemented here.

Self-review: all four tasks have explicit RED/GREEN and review boundaries; the five review risks are assigned to tests. Snapshot fingerprints include migration credentials without exposing them. Role-policy acceptance exercises pg-boss's real startup requirements. Archive hashes are verified from bytes rather than accepted from a caller. Existing production backups and source remain untouched.

Status: plan only. No implementation steps above have been executed. Local branch preparation does not change the green head of PR #734.
