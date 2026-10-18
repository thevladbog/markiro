# Standalone replacement import implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task, with
> independent client/UI work following the interfaces below.

**Goal:** Replace test business data with cloud catalogs/history after a verified
backup, retaining licensing and hardware/device configuration.

**Architecture:** Existing catalog transaction plus pending history batch; a
separate dataset epoch fences stale station writes and triggers native purge.

**Tech Stack:** Rust/sqlx/SQLite, Tauri, React/Zod, Kotlin/Compose/Room,
Vitest/Cargo/Gradle.

**Spec:** `docs/superpowers/specs/2026-10-18-standalone-replace-import-design.md`

## Global constraints

- No production mutation, release, push or commit in this task.
- Preserve license clock, device keys, workstation settings and unrelated work.
- No secret data in logs/caches; use existing strict request and file readers.
- Keep old import/file contracts compatible; datasetEpoch is not restoreEpoch.

## Review focus

- Interrupted client after successful commit must resume without a second wipe.
- Failed backup and failed catalog must preserve live test data.
- Old queued SQL/network operations must never enter the replacement generation.
- Canceling history must not open production before duplicate owners are ready.
- Concurrent writer and physically issued counters must survive replacement.

### Task 1: Host replacement transaction

Files: proto/src/cloud_import.rs; host/src/routes/cloud_import.rs;
host/src/import_replace.rs; host/migrations/0049_import_replacement.sql;
host/src/cloud_history/mod.rs; host/src/routes/cloud_history.rs;
host/tests/cloud_import_replace.rs.

- [x] Add failing route tests for dirty-site dry-run, replacement and retention.
- [x] Implement optional request replacement `{ expectedRevision, history }` and
      summary replacement `{ expectedRevision, datasetEpoch, backupFile }` with default omission.
- [x] Make mandatory verified pre-import copy under the write lock, classify
      business tables, clear/import/stage atomically, preserve counter floors.
- [x] Add backup-failure, rollback, pending/cancel and idempotency tests; pass them.

### Task 2: Host generation fence

Files: proto/src/lib.rs; host/src/auth.rs; host/src/server.rs;
host/src/routes/changes.rs; host/tests/import_dataset_epoch.rs.

- [x] Add failing missing/stale generation and in-flight mutation tests.
- [x] Add Hello.datasetEpoch, constant DATASET_EPOCH_HEADER and stored epoch.
- [x] Bind authenticated request generation and recheck it in write transactions;
      keep reads/recovery possible. End streams after epoch change.
- [x] Run focused Cargo tests and shared contract fixtures.

### Task 3: Native reconciliation

Files: src-tauri/src/{local_db.rs,device.rs,host_client.rs,connection.rs,
lib.rs}; src-tauri/migrations; native and webview link/schema tests.

- [x] Pin failing purge/retention, late write and startup epoch header tests.
- [x] Implement immutable loaded epoch, freeze, atomic local purge+persist and
      restart before exposing Online. Preserve pairing/workstation settings.
- [x] Exercise failure/retry and protocol compatibility; update shared fixtures.

### Task 4: Office replacement flow

Files: src/host/cloud-import.ts; src/office/import/; localized strings; focused tests.

- [x] Add failing tests selecting both validated files and explicit confirmation.
- [x] Add replacement mode, dry-run revision, backup result and restart/resume text.
- [x] Reuse streaming history reader/import and keep sensitive content in refs.
- [x] Verify old empty-site flow, blocked/failed cases and ready-after-complete.

### Task 5: Integration verification and documentation

- [x] Run host/native Cargo suites, webview tests/typecheck/lint/build, shared
      contract checks and format/diff checks; investigate actual failures.
- [x] Run replacement with representative fixtures, retain evidence and update
      scoped guide/runbook. Review whole diff; report unrun external gates.

## Verification evidence

- Cargo workspace: 173 suites, 2347 passed, 2 explicitly ignored (dedicated
  PostgreSQL final-state export integration and manual million-scan benchmark).
- After the final host change superseding an obsolete restore hold: 11 focused
  replacement/epoch/cancellation tests passed again.
- Standalone typecheck, lint and build passed. Final full Vitest: 345 files and
  8210 tests passed, 3 files/tests skipped (optional browser-fit checks and the
  dedicated PostgreSQL export artifact replay). The first run exposed an old
  seven-reason assertion after adding the eighth link error; it was corrected,
  all translation assertions retained, and the full suite passed again.
- Final shared Hello fixtures: Rust 90 tests and TypeScript 503 protocol/status
  tests passed, including absent/replaced epochs and the independent restore
  epoch. The Android consumer reads the same replacement fixture.
- Controlled browser replacement: 8 checks, no page errors; restart is simulated
  by remounting Office. Existing history reports: 11 shift formats and two pallet
  XML formats, 13 downloads, no page errors.
- `pnpm format:check`, Cargo formatting and `git diff --check` passed. Existing
  affected-job mapping includes standalone, platform/API/admin and Android
  consumers of the shared fixture; no CI ownership change was needed.
- No Windows installation, physical printer/scanner, real multi-device restart
  or production rollout was exercised. Android Host-mode reconciliation is
  implemented and verified by the standard gates recorded below.
- License/statistics checks and the full API run's unresolved wider-run failure
  are recorded separately in
  `2026-10-18-standalone-license-request-usage-validation.md`; the full API gate is
  not claimed green.

### Android affected consumer

- Add a nullable current dataset epoch to device_config and a nullable target to
  device_recovery (Room 21 -> 22); the pending recovery phase distinguishes an
  explicit target of no epoch.
- Invalidate in-memory recovery admission before recording the pending intent;
  do not clear credentials or reuse revocation/re-pairing. Keep the process epoch
  immutable and complete cleanup only in a fresh process's initialize path.
- Run dataset comparison ahead of restore reconciliation and initial bootstrap;
  attach the startup epoch centrally in the pinned OkHttp client.
- Show a blocking bilingual close/reopen screen until the durable pending state
  can be completed at startup. Exercise late callbacks, interrupted cleanup,
  Room reopen, printer/settings retention, header propagation and cloud denial.
- Verify focused Android tests and standard testDebugUnitTest/lintDebug/
  assembleDebug using the existing JDK 17 and Android SDK; physical handheld and
  printer acceptance remain separate.

### Android verification

- Final standard command `testDebugUnitTest lintDebug assembleDebug` passed using
  JDK 17 and the installed Android SDK: 197 JUnit suites, 1416 tests, zero
  failures/errors/skips; Android lint and debug APK assembly succeeded.
- Focused migration/reset/screen verification passed 25 tests. The final shell
  navigation/reset/screen verification passed 16 tests, including a regression
  that first reproduced pending startup incorrectly choosing pairing and then
  verified successful cleanup retry reaches sign-in with the retained key.
- The initial full run failed 12 assertions: 11 historical fixtures downgraded a
  current Room file without removing the new v22 columns, and one asserted the
  old schema version. The fixtures now reconstruct their earlier schema while
  preserving the original queued-byte assertions; the production migration stays
  strictly additive. A superseded full run was interrupted before the final shell
  fix and is not counted as a completed gate.
- The passing full log includes background Room observer errors after Robolectric
  removes a HostLinkMonitorTest temporary database directory. JUnit reports zero
  errors; this log noise is recorded separately from assertion results.
- Room reopen and failure injection exercise restart/purge semantics. No physical
  Android process close/relaunch, vendor scanner, printer, or production-device
  acceptance was performed.
