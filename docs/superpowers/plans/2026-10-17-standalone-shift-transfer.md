# Standalone final shift transfer implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. The user has approved planning AND implementation; no further handoff approval is required.

**Goal:** Import closed cloud shifts so standalone can display them, generate its existing reports including CHZ XML, detect duplicate codes and disaggregate imported packs.

**Architecture:** Separate cloud final-state tables and an explicit read model, without synthetic production devices/scans. A checksummed streaming export is staged by bounded parts and activated only after complete graph validation. Existing domain report renderers consume imported source rows; current ownership and final report occurrences remain distinct.

**Tech Stack:** Node 24, PostgreSQL/psql, Rust/SQLx/SQLite/Axum, serde/Zod, React, Vitest, existing domain renderers.

**Spec:** `docs/superpowers/specs/2026-10-17-standalone-shift-transfer-design.md`.

## Global Constraints

- Base `b0d505c1fa17c1516fad3007bb4f926ba582a7e5`; work only in this worktree, never Claude's integration. No commit, push, merge, deploy or cleanup of other work without user authorization. Store uncommitted diff evidence per task instead of commit-based review packages.
- Preserve formats 1/2 of catalog import. History has its own format/version. No dependency or lockfile changes. Use Corepack pnpm and isolated build outputs.
- First import after catalog import, before local shifts; one source batch, resume/repeat; no live-cloud writes. Retain all current owner hashes regardless of 12-month report window.
- Preserve GS1 separators, exact canonical code, original numbering, civil dates and origin metadata. No fabricated devices/scans/templates and no silent data drops.
- Current source rules are authoritative, including `validation_code_reprocessings` only for flat formats. A regenerated report never implies submission to CHZ.
- History import/state/cancel and imported-pack disaggregation require current administrator. Reads, new report storage/audit and new conflict review retain existing Admin/Technologist office access; native disaggregation roles are unchanged. Exact audit fields, no code/hash/secret values in logs. Every route is registered in device-kind, license and shell policy inventories.
- Write focused failing tests before behavior. Maintain existing assertions. Full gates once after integration; report external limitations separately.
- Cargo builds use `CARGO_TARGET_DIR=/private/tmp/markiro-shift-import-target CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0` to avoid sharing mutable targets and limit disk usage.

## Review Focus

- Missing canonical code or foreign-tenant joins must fail, not silently shorten the report — Task 1 golden and PostgreSQL tests.
- A partly imported shift must never produce a full-looking report or allow production before activation — Task 2 interruption/startup tests.
- Reprocessed validation occurrences are exported but never acquire ownership — Tasks 1 and 3 flat-versus-box tests.
- Release/reimport must not revive an old owner or free a newer owner's code — Task 3 disaggregation and idempotency tests.
- Generated files must retain original org/product metadata after catalog edits and survive restore — Tasks 3/4 report/storage tests.

## Contract decisions

Task 1 owns `proto/src/cloud_history.rs`, the wire fixture and `src/host/cloud-history.ts`. These establish the exact data contract before Task 2. Suggested names below are binding except where a recorded implementation adjustment is needed.

- `CloudHistoryManifest`: format `markiro-cloud-history`, `formatVersion: 1`, `exportedAt`, `since`, `source: { tenantId, tenantName }`, `organization: { name, inn, gln, timeZone }`, `counts` for six row categories, `parts` with index/checksum/counts, and `checksum` of manifest without checksum. Batch identity is the manifest checksum. Part index starts at 0.
- `CloudHistoryPart`: `index`, `payload: { shifts, codes, boxes, items, pallets, owners }`, `checksum` of index/payload. Up to 5,000 rows and 4 MiB UTF-8 JSON per part; single oversized row is refused. Request ceiling 8 MiB to allow manifest overhead; bounded manifest itself must be validated.
- A shift has `id`, original `number`, `mode`, `productionDate`, `plannedDate`, `openedAt`, `closedAt`, `productId`, `productName`, `gtin14`, `shelfLifeDays`, `lineName`, `palletsEnabled`, `inWindow` and necessary source metadata for existing forms. Nullable source values stay explicit. Boxes/pallets carry source ids, owning shift (pallet nullable for warehouse), SSCC, instants, disassembly state and relationships. Items carry box/hash and final live membership. Codes carry shift/hash/canonical/scannedAt/GTIN/serial and `flatOnly`. Owners carry hash/shift/number/scannedAt/box (nullable) independently of report-window inclusion.
- `CloudHistoryImportRequest { manifest, part, dryRun }`; `CloudHistoryImportState` reports batch/source/status (`pending`/`complete`), received indices, total parts and verified counts, never code data. `CloudHistoryCompleteRequest { batchId }`.
- `POST /v1/office/import/history`, `GET /v1/office/import/history`, `POST /v1/office/import/history/complete`, `POST /v1/office/import/history/cancel` (pending only).
- Read model `/v1/office/cloud-shifts` with indexed pagination, filters and stable ids; `/v1/office/cloud-shifts/{id}`; `/v1/office/cloud-shifts/{id}/export-source`. Dedicated read model avoids pretending it is `OfficeShift` with required local template ids. Shared export storage can keep original globally unique UUIDs; collisions with local objects are refused.
- Extend `ShiftExportRows` additively for `flatOnly` reprocessing if needed, preserving old fixtures/readers. Keep `ExportDialog` reusable through explicit source selection or source adapter, never `as OfficeShift` casts.

### Task 1: Streaming history export and shared contract

**Files:** Create `tools/standalone-export/history.sql`, `history.mjs`, `test/history.test.mjs`, `test/history-sql.test.mjs`; modify CLI and SQL fixtures/static tests as necessary. Create `apps/standalone/proto/src/cloud_history.rs`, `proto/tests/cloud_history.rs`, `proto/fixtures/cloud-history.jsonl`, `src/host/cloud-history.ts`, `test/cloud-history-file.test.ts`; register module exports.

**Interfaces:** Produces manifest/part/request/state Rust types and matching strict Zod schema plus async JSONL reader. CLI `--history [--history-since YYYY-MM-DD]` writes history instead of catalog; ordinary invocation unchanged. Export streaming helper accepts an async iterable of tagged SQL rows and writes an atomic JSONL file. SQL runs one tenant-scoped REPEATABLE READ READ ONLY snapshot, not multiple unrelated queries.

- [x] Write tests: current CLI rejects/has no history, then fixture roundtrip/checksum/size/date/tamper/GS1/flatOnly assertions; first observe failure.
- [x] Implement contract and one golden file readable by Node, Rust and browser, with no sensitive debug output. A raw SQL record stream is chunked under both row and byte limits; no whole-history buffer.
- [x] Implement SQL selection for closed shifts/window, pack closure dependencies, all owners, exact canonical joins, reprocessings and source metadata. Refuse incomplete canonical data and non-clean cloud. Test a second tenant and missing rows against disposable PG if available; explicitly skip without its dedicated URL.
- [x] Add CLI dispatch, whole-file write/no overwrite, owner-only permissions, bounded stderr without raw data, help and summary.
- [x] Run `node --test tools/standalone-export/test/*.test.mjs`, focused Vitest reader test and proto tests. Record actual passes/skips and RED/GREEN evidence; do not commit.

### Task 2: Host staged import and activation

**Files:** Create next free host migration (re-evaluate at execution, expected `0047_cloud_history.sql`), `host/src/cloud_history/` validation/storage/read helpers, `routes/cloud_history.rs`, `host/tests/cloud_history_import.rs`; modify host lib/router/audit/device/license inventories, shift creation/open gates, no-secrets tests and upgrade/backup tests.

**Interfaces:** Consumes Task 1 manifest/parts. Produces import routes/state and committed cloud final-state tables plus a shared query helper for completed cloud ownership. Stage row tables by batch; unique keys prevent duplicates. Complete operation makes one batch visible after validating graph, counts and source. No normal shift/scan/device writes.

- [x] Failing integration tests for valid catalog-associated import, admin-only before body, foreign source/GLN, damaged checksums, repeated part, dryRun, missing part and interrupted restart.
- [x] Implement strict bounded validation (ids/dates/number/hash/canonical consistency/SSCC/relationships) and checksum verification on host, not only UI. Never echo malformed values.
- [x] Require catalog import of same tenant/GLN; initially no local shifts/owners/SSCC blocks. Block new local shift creation/open while pending. Refuse changed manifests/parts; same accepted part answers its stored result without audit/revision or rewriting released data.
- [x] Finalize only complete internally consistent counts/graph, including warehouse pallets and unique global SSCCs; readers see only completed batch. Audit exact actor/action/target/result/counts. Backup carries staging and completion state.
- [x] Run focused host and proto tests, migration upgrade tests and route policy contracts; record evidence, no commit.

### Task 3: Reports, duplicates and imported-pack operations

**Files:** Create `host/src/cloud_history/read.rs` and focused `host/tests/cloud_history_{reports,registry,disaggregation}.rs`; modify owner registry, code route, conflict readers/status, office read/export/form/storage routes, disaggregation validation/apply and additive protocol fields, `src/office/exports/export-source.ts` only where shared source contract requires it; add parity tests.

**Interfaces:** Produces cloud shift list/detail/export-source, cards/form data, stored-export linkage and existing disaggregation support. Preserve local routes. Cloud owner wire remains a valid CodeOwner; `deviceId` uses documented NIL UUID for cloud (no fake device row), `sameDevice: false`. Separate cloud conflicts avoid fake winning scan FK. Cloud imported owner outranks new production after cutover; do not allow a device's backdated timestamp to erase imported ownership.

- [x] Failing tests: online owner lookup, offline accepted scan becomes conflict receipt and office-visible review, no duplicate ownership, reprocessed code does not create an owner.
- [x] Read imported sources using one SQLite snapshot and indexes. Build existing export input including frozen org/product metadata, all full codes, proper flat-only code selection and canonical date fallback. No current catalog substitutions. Add precise refusal for missing report date.
- [x] Connect every applicable TXT/CSV/XML and pallet XML to existing domain generation; compare cloud/standalone outputs with same document identity/time, including null/invalid source states and multiple pallets.
- [x] Extend stored files/export history/pack forms for cloud identities without fabricated shift records. Confirm file readback and backup restore. Read-only lists/cards use real totals and nullable metadata, with pagination.
- [x] Extend normal disaggregation scenario for cloud packs: transaction rereads current links/owners, idempotent release, audit, no resurrection after repeat import. New report reflects changes, previously saved file does not. Foreign/current-owner mismatch never frees another code.
- [x] Run focused Rust/TS parity tests and affected existing export/registry/disaggregation/storage suites; record evidence, no commit.

### Task 4: Office import, shift list/card and complete acceptance

**Files:** Create `src/office/import/CloudHistoryImport.tsx`, `src/office/shifts/CloudShifts.tsx` and focused component tests; modify `CloudImportPage.tsx`, `ShiftsPage.tsx`, API/schema modules, office query keys, export dialog adapter, forms, i18n and shell allowlists. Update scoped AGENTS, runbook and CI affected checks.

**Interfaces:** Consumes Tasks 1–3. Under «Перенос из облака» history preview/check/import/progress/retry; under «Смены» source tab/filter and cloud card. Existing renderers and saved-files controls reused through typed adapters.

- [x] Failing tests: streaming file selection with source/window/counts; incomplete/bad checksum refusal; progress/resume after lost response; server errors; technologist cannot import. File data lives outside persisted caches and no raw code in errors.
- [x] Implement bounded file validation, dryRun of each part, replay/resume and final completion. Production readiness is shown only after complete; do not pretend a partial batch succeeded.
- [x] Implement list/card/pack details, original metadata, generated reports including XML and saved file readback; no edit/reopen action. Use existing UI/i18n tokens. Show precise unsupported/missing-source reason.
- [x] Run component tests including real report generators. Run baseline-relevant full standalone tests/typecheck/lint/build, proto+host tests, export tests on disposable PG, format and diff checks. Only repeat a gate for a new change/failure.
- [x] Browser exercise import → cloud shift → generate each report class → saved files, with real renderer and controlled host fixture. Document actual browser/Windows/hardware boundaries. Update graph only if this worktree contains a local graph.
- [x] Final whole-diff review and fix verification; leave changes uncommitted on task branch for the user's later publication decision.

Completed 2026-10-17. Final review fixes preserve retained cloud pack provenance,
accept valid source timestamps from independent clocks and PostgreSQL offsets,
and make pending handheld warehouse creation retryable. The real PostgreSQL →
JSONL → host → report-renderer acceptance test was run explicitly. Per-task and
final review evidence is retained in
`.superpowers/sdd/2026-10-17-standalone-shift-transfer/`. Deterministic GET/cancel
test synchronization remains nonblocking test debt; Windows, hardware, customer
data and CHZ submission remain separate acceptance gates.
