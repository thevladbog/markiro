# Target-local backup adapter implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a target-local backup and verified isolated restore under the existing factual production fence.

**Architecture:** Reuse host observers and the backup library. Move the final archive fence observation after verified worker cleanup so an ordinary stopped backup worker cannot require weakening the host network policy. Expose a trusted operator function, with existing deployment lock and exact runtime/connection bindings.

**Tech Stack:** Node 24, Docker, PostgreSQL 17.

**Spec:** docs/superpowers/specs/2026-10-19-platform-target-backup-design.md

## Global Constraints

No server/DNS operations during implementation. No JSON callbacks or caller-provided success observations. Keep the 1 MiB limit, physical identities, private files, snapshot checks and verified cleanup. Root/current-UID and trusted image/source provenance remain explicit operator trust boundaries. No source import, privilege broadening, public remote CLI, image publication or workflow mutation in this task.

## Review Focus

- The archive worker remains attached at the old after-snapshot boundary: cleanup precedes final observation without moving publication earlier.
- A changed target or active foreign writer between observations must fail.
- Concurrent deployment, held/uncertain journal, unreaped subprocess and cleanup uncertainty must fail without admitting recovery evidence.
- A private connection descriptor can name a different database/network than observed: bind all connection fields and runtime identity explicitly.
- An existing historical backup is not fresh target acceptance: operation IDs, hashes and fresh fence observations remain bound.

### Task 1: Target backup and restore under factual fence

**Files:** Modify deploy/platform/backup/archive.mjs; create deploy/platform/host/target-backup.mjs and deploy/platform/test/target-backup.test.mjs; extend deploy/platform/test/backup-archive.test.mjs. Update deploy/platform/backup/README.md and a dated verification document. Avoid changing deploy/platform/host/command.mjs unless a small shared enforcement-hash helper is necessary; prefer no duplicate hashing contract.

**Interfaces:** Export createTargetRecoveryBackup({operation,observationPolicy,hbaPath,hbaSha256,connectionFile,roleMapping,verifySources}, options={}) returning {backup,restoreEvidence,fence}; operation uses existing root/identity/configuration/dockerConfig subset. Production dependencies default to runHostProcess, createHostObservers, observePostgresAdmin, createDatabaseBackup, verifyDatabaseRestore; options may inject trusted process adapters for tests, never serialized observations. Validate actual runtime and connection files. Use withHostState over operation.root across the full action; inspect current journal and reject non-healthy unresolved deployment. Read state helper semantics before deciding uncertainty handling; escalate any incompatible contract to controller.

- [ ] Write failing tests proving final fence runs only after owned archive worker resources are absent; failure of that check publishes neither archive nor success metadata.
- [ ] Move final fence observation after output capture and verified cleanup; preserve generic sanitized errors, retained failure evidence and input cleanup. Run focused archive tests.
- [ ] Write failing target-adapter tests using existing Docker/host fixtures for actual observations, physical mismatch, foreign/active workload, connection retargeting, invalid runtime provenance/executor/architecture, held lock, failed source check and final re-observation. Observe RED.
- [ ] Implement minimal trusted adapter. Generate beganAt/fenceId internally after successful observation, compute the exact existing host fence enforcement hash, invoke the existing archive/restore producers, and independently re-observe after restore. Do not manufacture prepared-target records or relax host inventory. Escalate if the existing lock cannot preserve uncertainty safely.
- [ ] Run focused tests then all deploy/platform/test/*.test.mjs, scoped ESLint/Prettier, git diff --check. Report real tests vs fake process fixtures and actual Linux acceptance separately. Commit only explicit task files.
