# Platform host execution implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the protected execution path needed for the approved Markiro move to one Timeweb 2 vCPU / 4 GiB host, without treating library tests as live migration acceptance.

**Architecture:** Reuse release admission, private configuration, durable state, bounded process execution and prepared-target validators. Add a small execution coordinator, explicit Linux observations/host command, and a protected pinned-SSH delivery workflow. Bootstrap, rehearsal, final writer freeze, DNS switch and Yandex shutdown remain separately recorded operational steps.

**Tech Stack:** Node 24, Docker Compose V2, PostgreSQL 17, GitHub Actions, pinned OpenSSH.

**Spec:** docs/superpowers/specs/2026-10-18-timeweb-host-delivery-design.md

## Global Constraints

- Fixed project `markiro-platform`; only `deploy/platform/compose.yml` then `compose.compact.yml`, never CI overlay, build, unqualified up or down -v.
- Reuse `withHostState`, `runHostProcess`, configuration snapshots and `validatePreparedTarget`; never invent backup acceptance or bypass recovery-required.
- No secrets in stdout, command arguments, artifacts or Git. Minimal explicit process environment; strict SSH host verification, no agent forwarding.
- Start API only after migration success; edge only after API health. Every action has bounded execution and durable entry/completion. After migration entry, failure stops target writers and remains recovery-required; no automatic rollback.
- Actual Linux target, database/volume, fence, TLS, permissions, immutable images and snapshot must be observed independently of caller-provided expected values. Human evidence must stay explicitly operator-attested.
- Tests never change servers, DNS, provider resources, repository protection or real credentials. Current production remains untouched by implementation.
- User approved migration and shutdown by 2026-10-20 00:00 Europe/Moscow; Fucina/Twenty, n8n and Chatwoot are archived and temporarily stopped, not moved. No destructive resource deletion.

## Review Focus

- Daemon workload survives CLI timeout: stop/inspect owned workload; never assume process-group death stops Docker work (Task 1).
- Retargeted volume, changed configuration or expired fence between checks: re-observe before sensitive transitions (Tasks 1/2).
- Untrusted host, path, archive member or SSH argument injection: reject before transfer/remote execution (Task 3).
- Interrupted migration or failed journal write: preserve terminal recovery-required/held lock, never start either app or rollback (Task 1).
- Production evidence forged by serialized callbacks or expected-only checks: fixed trusted observation implementations; local fixtures cannot produce live acceptance (Task 2).

### Task 1: Durable deployment coordinator

**Files:** Create `deploy/platform/host/deploy.mjs`, `deploy/platform/test/host-deploy.test.mjs`.

**Interfaces:** Export `executePreparedDeployment(input, adapters)`; input is an immutable explicit operation record containing root, validated identity, candidate configuration paths and prepared-target record. Adapters are in-process trusted functions for release/image verification, target inspection, prepared-target validation, Compose execution, stopped-workload inspection and smoke. They are never deserialized from JSON. The production command in Task 2 supplies the concrete adapters. Return a sanitized completed identity only when healthy has been durably completed.

- [ ] Write failing tests for exact phase ordering using the real state journal/private files and a trace-recording executor; migration failure must not call API or edge start.
- [ ] Implement coordinator under the existing host lock. Reuse current phase names and configuration identity; validate prior unresolved state before any command. Pull/verify exact images before stopping. Journal every entry before action and completion only on success.
- [ ] Add failure tests for each phase, journal publication failure, expired/changed prepared evidence, config mutation, unexpected active workload, aborted/timed-out migration with a still-running daemon workload, and clean first install. Error output must not expose subprocess output or config values.
- [ ] Preserve conservative failure behavior: no automatic previous-release restart in this initial implementation; record recovery-required and stop/inspect only owned target API/edge. Do not clear the journal or delete data. This is stricter than the optional pre-migration restart in the spec.
- [ ] Run `node --test deploy/platform/test/host-deploy.test.mjs`, then all platform tests, scoped ESLint/Prettier and diff check. Commit only scoped files.

### Task 2: Linux host command and factual observations

**Files:** Create `deploy/platform/host/command.mjs`, `deploy/platform/host/observe.mjs`, `deploy/platform/test/host-command.test.mjs`, `deploy/platform/test/host-observe.test.mjs`. Extend the platform runbook with the exact installed-file contract and operator preparation. Keep modules focused; report an architectural gap instead of fabricating observations.

**Interfaces:** Fixed CLI `node deploy/platform/host/command.mjs OPERATION_DIRECTORY` accepts one validated absolute private operation directory. An exact-schema operation JSON binds installed root, executor SHA, target identity, admitted release, protected runtime/migration configuration, prepared-target/backup/restore evidence and approved observation policy. Export a testable command function; Task 3 transfers the allowlisted tool bundle and invokes only this fixed entry point. Use `executePreparedDeployment` from Task 1.

- [ ] Write failing tests for unknown/missing keys, symlinks, foreign-owned/public files, non-linux/amd64 target, wrong container image/project/volume, changed executor/composition bytes, ambient environment injection and expected-only acceptance.
- [ ] Implement concrete bounded Docker/Compose observations for exact image IDs/platform, compose-labelled workloads and expected volume identity. Recheck stopped writer state at action boundaries; validate configuration/backup bytes using existing functions. Never accept JSON booleans as physical checks.
- [ ] Provide explicit PostgreSQL TLS, role-policy and restored-snapshot observation integration using existing worker/probe patterns; all queries must be read-only. Stop and report to controller if existing inventory cannot represent real production data rather than weakening checks.
- [ ] Use trusted prepared acceptance for the external writer-fence and operator-attested egress/key/off-host facts; require exact producer/provenance/freshness bindings. Clearly document any external enforcement adapter required; no public execute path until its real implementation exists.
- [ ] Test coordinator+command with a local fake Docker executable process (argv/stdin/environment boundaries) and the existing isolated PG harness where needed. Full platform tests, scoped ESLint/Prettier/diff. Commit scoped files.

### Task 3: Pinned protected transport and bootstrap/rehearsal runbook

**Files:** Create `.github/workflows/deploy-platform.yml`, `deploy/platform/transport.mjs`, `deploy/platform/test/transport.test.mjs`; update `tools/ci/test/workflow.test.mjs`, `docs/runbooks/timeweb-platform-preparation.md`, `docs/runbooks/timeweb-migration.md`, and a dated verification record.

**Interfaces:** Main-only workflow on `production-deploy`, with distinctly named Timeweb target variables/secrets. Immutable explicit publisher run/attempt/artifact inputs use existing admission code. Transport accepts only validated host/port/user, pinned known-hosts file and explicit identity; transfers an allowlisted hashed bundle to a unique private directory, then fixed host command from Task 2. Configuration/secrets remain preprovisioned on host and outside artifacts.

- [ ] Write failing transport tests for shell/path injection, wrong host key, ambiguous/extra bundle files, hash mismatch and failed transfer/command. Verify no remote command follows any failed local gate.
- [ ] Implement strict transport using bounded literal argv and fixed quoted remote command structure. Never keyscan/trust-on-first-use or choose legacy target variables. Fail if host is not separately prepared.
- [ ] Add workflow contracts for main-only dispatch, protected environment, exact successful tooling CI, immutable admission and no secret artifacts. Use pinned actions matching repository conventions.
- [ ] Write exact bootstrap and operational checklist: fresh OS/Node/Docker, 2/4/50 budget, TLS/private PG, roles/restore mapping, fencing/egress, key continuity, independent backups, exact-release rehearsal, final source freeze and S3 delta, public DNS/mail/release continuity, rollback ownership and source shutdown. Do not claim these executed.
- [ ] Run platform tests, CI policy tests, production bundle contracts, formatting/diff. Review entire branch against its base. Record unrun live gates explicitly and push/open scoped PR under existing authorization.
