# Platform host safety foundations implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare protected configuration snapshots and a crash-safe deployment journal for the future compact Timeweb executor.

**Architecture:** Add small internal Node modules under `deploy/platform/host/`. Configuration is read through the existing preflight, frozen in a private candidate directory and separated from non-secret Compose interpolation. A locked state store owns strict deployment transitions and retains unresolved operations across process restarts. These are library foundations, not a runnable host deployer.

**Tech Stack:** Node 24, native filesystem/crypto, node:test, existing platform validators; no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-18-timeweb-host-delivery-design.md` (implementation order item 2, filesystem/configuration and state portion).

## Global Constraints

- Dedicated target is Linux amd64, 2 vCPU / 4 GiB, local PostgreSQL 17, fixed Compose project `markiro-platform`, server/UI profiles `platform-only`.
- No host CLI/workflow, VM purchase, SSH, Docker execution, source changes, DNS, key generation, database restore or remote writes in this slice.
- Node 24; no new dependencies; preserve existing env/preflight compatibility and the release publisher.
- Private deployment root is pre-created, absolute, canonical, owned by current UID, mode 0700. All descendants used by these modules are private, owned, non-symlink paths. Ancestors must be root/current-user owned and not group/other writable, except a root-owned sticky temporary ancestor outside the private root for isolated tests. Canonical `realpath` test roots avoid macOS `/var` aliases.
- Files are regular, single-link, owned, mode 0600, bounded to 1 MiB; no secret values or raw filesystem errors in returned errors/evidence. Private root ownership is the trust boundary; hostile root/current-UID processes are outside the threat model and must not be claimed as prevented by path checks.
- Acquire an exclusive deployment lock before inspecting mutable state. Do not break a stale lock automatically. File and parent-directory fsync precede success. Any uncertain durable-write outcome leaves the lock for explicit operator investigation.
- Existing user authorization covers local code, commit, push and PR; PR #733 remains unchanged/open. This branch is stacked on its exact reviewed head; no merge or deployment is authorized by the library tests.

## Review Focus

- A safe leaf behind an unsafe parent/symlink must be rejected, not followed.
- Literal dollar/hash/backslash credentials must survive snapshotting and never enter Compose interpolation or error output.
- Concurrent writers and a crash between state writes must leave an unresolved operation or persistent lock, never a fresh healthy candidate.
- A forged phase, backup proof, admission/profile mismatch or changed candidate identity must be rejected before any advancement.
- A post-migration failure must require explicit recovery; marking an old release healthy or clearing a lock is not an implicit rollback.

## Scope and next gate

This deliberately separates safety primitives from the future command orchestrator. No callback named `backupOk` or mocked state transition is treated as backup acceptance. The reviewed backup/restore adapter, distinct application/migration credentials, prepared-target acceptance, bounded process-group runner, exact Compose command orchestration and SSH/workflow are subsequent code gates from the parent design. Tests here prove filesystem/state behavior only. No automatic rollback or recovery-clearing API is introduced.

### Task 1: Protected host configuration snapshots

**Files:**

- Create: `deploy/platform/host/files.mjs`
- Create: `deploy/platform/host/config.mjs`
- Create: `deploy/platform/test/host-config.test.mjs`
- Create: `deploy/platform/test/host-fixtures.mjs`

**Interfaces:**

- `assertPrivateRoot(root): Promise<void>` validates canonical absolute root and ancestors.
- `readPrivateFile(root, relativePath): Promise<Buffer>` validates relative descendant, every directory and bounded file, uses no-follow/nonblock opens and descriptor metadata.
- `writePrivateFile(root, relativePath, bytes, { replace = false } = {}): Promise<void>` uses an exclusive temporary file, fsync, atomic publication (no overwrite by default), directory fsync; errors are generic. Only controlled relative paths, no traversal. Atomic replacement is available only to the locked state store, whose caller owns the directory lock.
- `snapshotHostConfig({ root, candidateId, envFile, manifest }): Promise<{ path, sha256, interpolation }>` uses `readProtectedEnv` and `validateConfig`, rejects unknown configuration keys, writes `candidates/<uuid>/runtime.env` once, returns an absolute path, 64 lower-case hex SHA256 and a frozen non-secret interpolation object. Candidate directory creation is exclusive; no overwrites/reuse.
- `hostChildEnvironment({ interpolation, dockerConfig, ambient }): object` validates expected interpolation keys and absolute protected Docker directory, returns fixed PATH `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, `LANG=C.UTF-8`, explicit `DOCKER_CONFIG`, `COMPOSE_DISABLE_ENV_FILE=1` and only intended interpolation. Reject ambient `COMPOSE_*`, `DOCKER_HOST`, `DOCKER_CONTEXT`, all case variants of HTTP/HTTPS/ALL/NO proxy variables, `NODE_OPTIONS`, `NODE_PATH`, `LD_*`, `DYLD_*`. Never inherit the ambient environment.

- [ ] Step 1: Write failing tests for the interfaces, using private temporary directories and the existing admission fixtures. Prove unsafe parents, symlink/hardlink/oversized/non-regular files, permissive modes, relative/traversal paths and duplicate candidate reuse reject. Verify a snapshot preserves literal `$`, `#`, `\\`, escaped PEM and JSON byte semantics; changing the original file later does not change the snapshot/hash. Assert errors contain no sentinel secret/path.
- [ ] Step 2: Run `node --test deploy/platform/test/host-config.test.mjs`; record expected missing-module/export failures before implementation.
- [ ] Step 3: Implement shared protected filesystem helpers and configuration snapshotting. Inventory allowed runtime keys from `deploy/platform/env.example` (including optional licensing/support/history keys), plus existing disabled worker flags validated by preflight. No blanket prefix allowance. Keep original key values, sort keys deterministically when serializing, include a terminal newline. Snapshot only validated inventory keys. Re-read/validate the snapshot and hash its actual bytes before returning; remove only newly created scratch files on failures, never pre-existing files.
- [ ] Step 4: Compose interpolation allowlist is API/edge digests, four domain names, source SHA, S3 public origin, ACME email, validated PG17 digest, absolute existing PG CA/cert/key/password paths, and snapshot path `MARKIRO_PLATFORM_ENV_FILE`. PG bind files may have container-specific permissions; validate canonical path/non-symlink parents, regular single-link files and no group/other writable bits, without misclaiming TLS/key/UID acceptance. Never include DATABASE_URL, SMTP_PASSWORD, auth/mail/license/support keys. Require the compact PG fields; reject unexpected interpolation keys and ambient injection. Validate values again at child-environment construction instead of trusting an arbitrary object. Tests assert exact returned keys and non-inheritance of GH_TOKEN/HOME/PATH/secret sentinels. Docker config directory is explicit canonical/private; no Docker invocation.
- [ ] Step 5: Run focused tests, then all platform tests and ESLint/Prettier on changed paths. Commit explicit paths as `feat(platform): protect host configuration snapshots`. Report RED/GREEN, files, limits and commit.

### Task 2: Durable deployment journal and failure boundaries

**Files:**

- Create: `deploy/platform/host/state.mjs`
- Create: `deploy/platform/test/host-state.test.mjs`
- Modify: `deploy/platform/test/host-fixtures.mjs`
- Modify: `docs/superpowers/specs/2026-10-18-timeweb-host-delivery-design.md` (accurate implemented/pending status only)
- Modify: `docs/runbooks/timeweb-platform-preparation.md` (library safety contract and explicit pending host gates)

**Interfaces:**

- Consumes Task 1 filesystem helpers unchanged.
- `withHostState(root, callback): Promise<unknown>` acquires `.deploy.lock` exclusively and syncs it before reading state, passes a store to the callback, releases only its own lock after a known durable outcome. Never removes an existing/stale lock. Serialize/reject concurrent method calls; a nested/second instance cannot enter.
- Store methods: `read()`, `begin(identity)`, `enter(phase)`, `complete(phase, proof?)`, `fail()`; all async. No resume/reset/rollback API. `read()` returns a defensive clone of strict validated state, not mutable internal references.
- Identity has exact keys `{ operationId, admission, executorSha, configurationSha256, target }`; operationId is canonical UUID; executorSha is 40 lower-case hex; configurationSha256 is 64 lower-case hex. Target exact keys `{ hostId, databaseId, volumeId }` are bounded safe identifiers `[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}`. Full admission must exactly match the existing `platform-release-admission` record, validate all nested exact keys and cross-bind manifest, verified release, registry, publisher, CI and artifact. Reuse validators where possible; syntax checking is explicitly not fresh online admission or host attestation.
- State exact schema: `{ version: 1, sequence, current, previousHealthy }`. `current` null or `{ identity, phase, status, backup }`; phases in order `admitted`, `images-verified`, `target-stopped`, `backup-verified`, `migrating`, `migrated`, `api-started`, `edge-started`, `healthy`; status `entered`, `completed`, `recovery-required`; backup null until backup completion, then exact proof `{ archiveSha256, restoreEvidenceSha256, target, operationId }`. `previousHealthy` null or prior full healthy current record. Every phase/status relationship and prior identity must be validated, not only JSON shape. State lives at `state.json`; every successful mutation increments sequence and atomically fsyncs it. No timestamps are acceptance evidence.

- [ ] Step 1: Write failing tests for lock contention across distinct processes, stale lock/restart, truncated/unknown/symlink state, illegal phase skipping/repetition, foreign backup target/operation, malformed nested admission and input mutation. Fault-inject every phase entry/completion boundary using callbacks that throw, then reopen the store: unresolved state must block `begin` even after lock release, while a hard-killed owner retains the lock. Assert no test talks to Docker, SSH, production, or GitHub.
- [ ] Step 2: Run `node --test deploy/platform/test/host-state.test.mjs`; record expected missing-module/export failures.
- [ ] Step 3: Implement `begin` only for empty state or a completed healthy current. A new begin records admitted/entered and retains the previous full healthy current; candidate IDs cannot equal a retained operation. Completion must match an entered phase; entry must be the next phase after completed. `complete('backup-verified', proof)` validates hashes/target/operation; all other completions reject extra proof. This is a binding format for the future reviewed backup adapter, not verification of archive bytes/restore itself. `enter('migrating')` requires bound backup. `fail()` on any unresolved phase records recovery-required and prohibits new operations, conservatively retaining the phase and backup. After migration entry there is no code path to mark a prior candidate healthy. Atomic/durability errors keep the lock even if callback catches them. Callback errors without a storage uncertainty may release their own lock, since durable unresolved state remains and prevents retries.
- [ ] Step 4: Tests verify actual on-disk records, 0600/0700 modes, deterministic state after successful handoff, preservation of previous healthy identity, no extra private values in journal/errors, and an actual terminated child process. Add an injectable filesystem test seam only if needed for fsync/rename failure tests; it must not bypass production validation or permit callers to clear uncertainty. Verify a failed parent-directory fsync cannot return success or allow a next operation. Add strict schema validation for impossible state combinations on read.
- [ ] Step 5: Run all platform tests, production bundle contracts, CI policy tests, ESLint on changed JS, `pnpm format:check`, `git diff --check`. Update design status to distinguish published/admitted release, implemented safety libraries and pending command/backup/transport gates. Commit explicit paths as `feat(platform): journal host deployment phases durably`; report RED/GREEN and manual/external limits.
