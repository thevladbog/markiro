# Receiving CSV Apply Binding Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and test-driven-development. The owner selected inline sequential execution. Keep this checkpoint local and unstaged.

**Goal:** Establish tenant- and digest-bound storage for the atomic apply transaction without exposing an incomplete command.

**Architecture:** Add `receiving_csv_applications` as a separate relation from a preview to an existing successful CSV operation. Composite foreign keys pin both sides to the same tenant and content digest; the preview primary key permits only one application. Keep the operation result in its existing table, without duplicating its JSON or event identity. The internal apply command will create the business draft, receipt, binding and audits together in the following service checkpoint.

**Tech Stack:** Node 24, pinned pnpm, TypeScript, Drizzle, PostgreSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-us-03-receiving-csv-import-design.md` (approved).

## Global constraints

- Only the existing `codex/us-mvp` worktree; operational workflows stay locked.
- Command identity is `(tenantId, "receiving.csv.apply", operationKey)`.
- Original file limit 256 KiB, at most 100 rows, exactly 24 hours before first application.
- Equal files are not unique; separate previews and explicit operations can represent new deliveries.
- Expiry, authorization, full receipt JSON validation and current reference resolution belong to the service, not a time-dependent SQL check.
- No HTTP route, body-limit change, client, new dependency, automatic deletion, primary/base database migration or publication.

## Task 1: Additive binding storage

**Files:** Modify `packages/db/src/schema/traceability-receiving-csv.ts` and `packages/db/src/schema/traceability-receiving.ts`. Generate migration0128, its snapshot and journal entry. Create `packages/db/test/us-receiving-csv-apply-schema.test.ts` and `packages/db/test/us-receiving-csv-apply-migration.e2e.test.ts`.

**Interface:** `schema.receivingCsvApplications` exposes required `tenantId`, `previewId`, `command`, `operationKey`, `inputDigest`. `command` defaults to and only permits `receiving.csv.apply`. Primary key is `(tenantId,previewId)`. Composite foreign keys use `(tenantId,previewId,inputDigest)` and `(tenantId,command,operationKey,inputDigest)`. Add the corresponding unique candidate keys to previews and operations; retain the existing operation primary key and event FK.

- [x] Write focused failing export and real migration tests. Build a pre-0125 synthetic draft/frozen specimen, migrate through0127, insert applicable and invalid previews plus old operation JSON, capture exact old state, then migrate the remaining chain.

```ts
expect(
  (await fixture.pool.query("SELECT to_regclass('public.receiving_csv_applications') AS name"))
    .rows,
).toEqual([{ name: "receiving_csv_applications" }]);
```

- [x] Observe red before changing schema. Add the table and composite candidate keys. Extend only the SQL operation command allowlist, not existing application receipt unions.

```sql
PRIMARY KEY (tenant_id, preview_id)
FOREIGN KEY (tenant_id, preview_id, input_digest)
  REFERENCES receiving_csv_previews(tenant_id, id, preview_digest)
FOREIGN KEY (tenant_id, command, operation_key, input_digest)
  REFERENCES receiving_operations(tenant_id, command, operation_key, input_digest)
CHECK (command = 'receiving.csv.apply')
```

- [x] Generate with `pnpm --filter @markiro/db exec drizzle-kit generate --name us_receiving_csv_applications`; inspect every SQL statement and compare snapshots0127/0128 for unrelated drift.
- [x] Test matching binding round trip, foreign tenant on each side, missing/invalid preview, missing operation, mismatched digest on each side, old/unknown command denial, unique-preview enforcement, equal-content independent deliveries, multiple previews referencing one result, bound-parent deletion protection and transaction rollback. Assert migration preserves old records byte-for-byte. Test concurrent competing inserts on one preview: one winner, one uniqueness failure.

## Task 2: Regression and handoff

**Files:** This plan, `docs/us/development-isolation.md`, previous preview-service plan and existing check-only `.github/workflows/us-development.yml` test selection.

- [x] Run focused new and existing CSV migration/schema tests on fixture-owned US databases.
- [x] Run DB package tests/typecheck/lint/build. Rebuild before existing API preview and Receiving command regressions; report infrastructure skips separately.
- [x] Include the new tests in the existing read-only US database check. Run the isolation checker, 19 isolation/browser-entry contracts, formatting and `git diff --check`.
- [x] Confirm fixture cleanup and base DB unchanged. Report storage-only completion: the apply service, transactional draft-helper extraction, strict acknowledgement contract, expiry/replay/reference checks, HTTP/MFA/browser and CSV output remain open. No commit/push or release.

## Self-review

This checkpoint implements the persistence prerequisite of the approved atomic-apply boundary, not the complete apply command. It intentionally does not define a public acknowledgement shape before the service's original-result replay cases are implemented. Tenant/digest keys prevent accidental cross-content joins while preserving the operation key as delivery identity. Existing preview and operation payloads are not rewritten.

## Local checkpoint — 2026-09-08

The subsequent [atomic apply service](2026-09-09-us-03-receiving-csv-apply-service.md)
implements the internal transaction over this binding without opening HTTP/UI.

Implemented the five-column binding relation, two composite candidate keys and
the SQL-only command allowlist extension. Generated migration0128 and reviewed
its entire SQL. Snapshot comparison against0127 shows exactly one added table;
only operation unique/check constraints and preview unique constraints changed
on existing tables. The predecessor link is valid; all other snapshot sections
are unchanged. No extension, JSON rewrite or business-data migration was added.

The initial export and real table-presence assertions failed before schema
implementation. The generated migration then exposed a dependency-order error:
Drizzle emitted the composite FKs before their candidate unique constraints.
The disposable migration test failed with PostgreSQL42830. Reordered only the
new, unpublished migration's statements so candidate keys precede FKs. The next
four-file CSV run passed75/75 without skips. Added further null-bypass,
bound-digest and operation-key regressions, bringing the new suite to34 tests.

Final full DB run passed551 tests across63 files;141 tests across27 files skipped
with ordinary `DATABASE_URL` deliberately absent (90 files,61.35 seconds). All34
new cases ran. The competing-binding case holds the first transaction open,
observes the second waiting through `pg_blocking_pids`, commits the first and
verifies the second fails with23505 and only the first binding remains. Rollback
removes both the new receipt and binding; old draft/frozen/preview/operation
records survive the migration byte-for-byte. This does not prove a service-level
atomic creation of a new draft: no apply service exists yet.

DB source/test typecheck, lint and build passed. After rebuilding DB, seven API
CSV-preview and Receiving original/lifecycle regression files passed158/158 with
no skips (19.26 seconds). Existing API Vite config-loader warning remains visible.
No API source changed; the full ordinary API infrastructure suite was not rerun.
Its prior environment/setup failures remain documented in the
[preview-service checkpoint](2026-09-08-us-03-receiving-csv-preview-service.md#wider-verification-and-limits),
not treated as a green package gate.

The release-isolation checker and19 isolation/browser-entry contracts passed;
repository-wide formatting and `git diff --check` passed. Read-only cleanup
found zero `markiro_us_profile_*` fixture databases and both CSV table lookups
returned null in base `markiro_us_dev`. All test data was synthetic and confined
to invocation-owned disposable databases. No HTTP/browser/manual spreadsheet,
MFA integration, hosted infrastructure or release acceptance was exercised.

The next increment is the internal atomic apply command: reuse transactional
Receiving creation, enforce current authorization and reference/expiry checks,
validate immutable acknowledgement identity, implement both operation-key and
applied-preview replay, and commit draft/receipt/binding/audits together. HTTP,
client confirmation and CSV output remain closed or unimplemented. All changes
remain unstaged in the US worktree; no commit, push, PR, merge or release.
