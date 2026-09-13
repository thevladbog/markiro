# Validation reprocessing implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Complete tasks with focused failing tests first and independent review. Do not commit or publish; the user's approval covers implementation only.

**Goal:** Allow deliberate processing of codes from closed shifts, once per new validation/duplicate-print shift, with explicit reports and offline recovery.

**Architecture:** Keep `code_registry` as the original ownership authority and add per-shift reprocessing facts. Share one policy and protocol across API, Admin, Station and Handheld. Existing label jobs validate against the appropriate accepted occurrence.

**Tech Stack:** TypeScript/Zod, NestJS/Drizzle/PostgreSQL, React, Station SQLite/Tauri, Kotlin/Room.

**Spec:** `docs/superpowers/specs/2026-09-12-validation-reprocessing-design.md`

## Global Constraints

- `allowPreviouslyAcceptedCodes` is false by default and valid only for `validationPrint.mode = duplicate_dm`; freeze it at shift open.
- Capability `validation-reprocessing-v1` is required for shifts with the setting true.
- One accepted code per tenant/current shift; preserve earliest-scan conflict semantics and idempotent delivery.
- Reprocessing never changes original code ownership, aggregation, production inventory or saved historical exports.
- Original/competing active shifts block reprocessing. Known duplicate refusal happens before printing.
- Full raw KM, GS, crypto tail and immutable print bytes are preserved.
- Offline work remains possible; local absence is not proof of global uniqueness and pending confirmation is explicit.
- Node >=24 and `corepack pnpm` at the repository-declared version. No dependency or lockfile changes.
- No commit, push, PR, deployment or cleanup without a separate request. Work in `.worktrees/validation-reprocessing` only.

## Task 1: Shared policy, persistence, server admission and reports

**Files:** domain `src/product-labels/contracts.ts`, new `src/validation-reprocessing.ts` and fixtures/tests; db `src/schema/platform.ts`, new `src/schema/validation-reprocessing.ts`, exports/config/new migration/tests; API `modules/shifts/{dto,validation-print-policy,shifts.service}.ts`, `modules/station-scans/{dto,station-scans.service,product-label-events}.ts`, new scoped reprocessing admission/history module, `modules/shift-exports/shift-export-source.service.ts`, related OpenAPI/policy/e2e tests.

**Interfaces:**

- `validationPrint` duplicate branch adds `allowPreviouslyAcceptedCodes` (optional input default false, explicit output; legacy parse false).
- Export `VALIDATION_REPROCESSING_PROTOCOL = "validation-reprocessing-v1"`.
- New table `validation_code_reprocessings`: tenantId, shiftId, codeHash, sourceShiftId, terminalId, scannedAt, operatorId; unique tenant/shift/hash and tenant composite FKs.
- Device history endpoint returns paged `{codeHash, shiftId, shiftNumber, shiftStatus, scannedAt}` plus explicit pagination/fetch metadata; tenant and product scope derive from authorised shift, not caller input. Use existing device/controller access conventions and route inventory.
- Sync response exposes occurrence-level decisions sufficient for clients to distinguish accepted first/reprocessed and rejected conflict without guessing. Maintain existing batch response compatibility.
- Validation output contains processed count and separate first/reprocessed counts; repeat details name original shift. Flat export contains unique first+repeat codes. No artificial box export entries.

- [ ] Add failing tests for policy false/default, invalid `none`, freeze and old capabilities.
- [ ] Add focused real PostgreSQL tests: reprocessing preserves registry owner; refuses open source/current-shift duplicate/foreign tenant; accepts one occurrence across concurrent devices and replays; print event binds to reprocessed occurrence; historical output and bytes unchanged.
- [ ] Implement schema and new migration with repository generator; review SQL and tenant keys. Rebuild DB before API tests.
- [ ] Implement admission under existing registry locks; source status checks precede a repeat write. Keep helper in a focused module. Preserve current ordinary claim/displacement semantics for non-repeat paths.
- [ ] Implement history, outcome and report contracts with precise nullable/provenance rules. Update route inventories/OpenAPI.
- [ ] Run domain/db standard gates and API focused tests in an isolated scratch DB with migrations. Run API lint/typecheck/build. Report any broader infrastructure skips.
- [ ] Produce exact interface notes for Tasks 2–4 and a diff package for independent review.

## Task 2: Station policy, local history and repeat acceptance

**Files:** Station `src/lib/{shift-bundle,mirror,journal,sync}.ts`, `src/pages/{WorkScreen,NewShift}.tsx`, duplicate print helpers and RU/EN translations; db SQLite schema/runtime migrations; focused station tests.

**Interfaces:** Consume Task 1 policy/history/outcomes. Add local per-shift processing records without overwriting existing historical `codes_mirror` facts. A replay or same-shift scan cannot create a second unit/job. Preserve pooled SQLite transaction constraints from Station AGENTS.md.

- [ ] Write failing tests for old local code + false refusal/no job, old closed source + true acceptance, same-shift refusal, active source refusal, scan-back bypass and failed/unknown print recovery.
- [ ] Add runtime SQLite migrations and parity tests; persist complete policy/history publication and pending processing occurrences.
- [ ] Fetch authorised paged history during shift preparation; replace only after complete successful download. Keep cached history on failure and expose last-checked/pending confirmation state.
- [ ] Implement pre-print duplicate routing, atomic unit/job persistence and occurrence-based counters. Apply server outcomes without deleting evidence of physical printing.
- [ ] Add setting to station shift creation and freeze during active work; advertise capability after client flow works.
- [ ] Run focused and full Station TypeScript gates, affected DB SQLite tests, host Rust checks when Rust changes. Browser check desktop and narrow screen; physical hardware is separate.
- [ ] Produce report and diff for independent review.

## Task 3: Handheld policy, Room records and repeat scanning

**Files:** Handheld core `storage/{ShiftEntities,ShiftDaos,Migrations,HandheldDatabase}.kt`, `scan/ScanRecorder.kt`, `sync/SyncEngine.kt`, shift DTO/repository, work/duplicate flows, resource translations and focused JVM/Room/ViewModel tests.

**Interfaces:** Consume Task 1 exact contracts and shared fixtures. Local accepted occurrences are scoped by shift/hash; global/history mirror remains separate. Room transaction binds acceptance and queue state and survives restart.

- [ ] Add failing Recorder/ViewModel tests for the same false/true/active/current-shift/scan-back matrix as Station.
- [ ] Add Room migration and DTO default false compatibility. Persist source history and accepted occurrence independently of original local code.
- [ ] Implement paged history publication and pre-print classification; unknown history remains pending server confirmation. Retain offline queue and recovery generation checks.
- [ ] Handle sync acceptance/conflicts at occurrence scope, preserving job history and correct per-shift counters. Advertise capability only with full implementation.
- [ ] Verify shared fixtures and `testDebugUnitTest`, `lintDebug`, `assembleDebug`. State emulator/device/printer checks separately.
- [ ] Produce report and diff for independent review.

## Task 4: Admin setting and readable reprocessing report

**Files:** Admin shifts `api.ts`, `ShiftForm.tsx`, `ShiftDetailsPanel.tsx`, related report components, RU/EN dictionaries and focused tests.

**Interfaces:** Use Task 1 policy and output/detail DTOs. Display the full agreed Russian label and explanatory help. Report processed = first + repeated with source shift links; use @markiro/ui and existing i18n.

- [ ] Add failing form tests for default false, explicit true, print-disabled absence and active-shift immutability.
- [ ] Implement checkbox and policy roundtrip in create/edit; do not mutate historical shifts from the view.
- [ ] Add output breakdown and repeat details with source shift labels; no UUID display fallback.
- [ ] Test report totals and full raw code data; verify retained flat export formats and unchanged historical export re-download.
- [ ] Run Admin standard gates and browser desktop/narrow + both themes; save screenshot evidence.
- [ ] Review the complete branch against the spec, resolve critical/important findings, run cross-package final gates with explicit infrastructure coverage, and report completion without committing or publishing.
