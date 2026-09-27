# Receiving CSV Preview Storage Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and test-driven-development. The owner selected inline sequential execution; do not dispatch agents or commit/push this checkpoint.

**Goal:** Add independently testable storage for bounded CSV preview evidence without creating receiving business records.

**Architecture:** A new tenant-anchored `receiving_csv_previews` table retains exact bytes, original header, findings and a nullable proposed draft/digest pair. PostgreSQL enforces byte/hash consistency and the fixed preview lifetime; server services remain responsible for authorization, full JSON validation, tenant reference resolution and apply. Generate one additive migration; preserve historical migrations and existing Receiving behavior.

**Tech Stack:** Node 24, pinned pnpm, TypeScript, Drizzle, PostgreSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-us-03-receiving-csv-import-design.md` (approved).

## Global constraints

- Only `codex/us-mvp` in the existing US worktree; release stays locked.
- Template `markiro-receiving-v1`; original file cap 256 KiB; at most 100 data rows.
- Preview lifetime is exactly 24 hours, independent of daylight-saving changes.
- Original bytes/header/findings are retained; a nullable proposal does not hide invalid-file evidence.
- File hash is not unique. Equal files can represent separate explicit deliveries.
- No new dependency, HTTP route, automatic deletion, base DB migration or hosted operation.
- Do not serialize JSON as trusted domain types in the DB package. Consumers must validate it.

## Task 1: Storage contract and additive migration

**Files:**

- Create `packages/db/src/schema/traceability-receiving-csv.ts`.
- Modify `packages/db/src/schema.ts` and `packages/db/drizzle.config.ts` to expose/include it.
- Generate `packages/db/migrations/0127_us_receiving_csv_previews.sql`, its new snapshot and journal entry.
- Create `packages/db/test/us-receiving-csv-schema.test.ts` and `packages/db/test/us-receiving-csv-migration.e2e.test.ts`.

**Interface:** `schema.receivingCsvPreviews` exports `id`, `tenantId`, `templateVersion`, `fileBytes: Buffer`, `byteSize`, `fileSha256`, nullable `fileName`, `originalHeader: unknown`, `findings: unknown`, nullable `proposedDraft: unknown` and `previewDigest`, `rowCount`, `createdBy`, `createdAt`, `expiresAt`. Proposed draft contains resolved IDs; findings preserve raw rows and file/row/reference errors. No receiving event or operation link is created by this storage-only checkpoint. The apply transaction will add its result binding together with the command-receipt integration.

- [x] Write failing schema and real migration tests. Start from migrations through 0124, seed a frozen receipt and a draft with real lots/documents, migrate through 0126, capture exact JSON text of old rows, then migrate the remaining chain. Check table presence with `to_regclass` before using it:

```ts
expect(
  (await fixture.pool.query("SELECT to_regclass('public.receiving_csv_previews') AS name")).rows,
).toEqual([{ name: "receiving_csv_previews" }]);
```

- [x] Run the focused schema exposure/table-presence tests and observe assertion failures, not infrastructure failures.
- [x] Implement the schema with a UUID primary key, unique `(tenant_id,id)`, organization FK, non-unique tenant/time index, and required metadata. Use the existing `customType<{ data: Buffer; driverData: Buffer }>` bytea convention. Check exact size/hash at the storage boundary:

```sql
CHECK (byte_size BETWEEN 0 AND 262144 AND byte_size = octet_length(file_bytes))
CHECK (file_sha256 ~ '^[0-9a-f]{64}$' AND file_sha256 = encode(sha256(file_bytes), 'hex'))
CHECK (isfinite(created_at) AND isfinite(expires_at)
  AND expires_at = created_at + interval '24 hours')
```

Require object-shaped original header/findings; proposal must be a JSON object with a non-null 64-character lowercase digest and 1–100 rows, or both proposal/digest must be SQL null. Row count is 0–100 for retained failures. Bound actor to 1–128 nonblank characters and filename to 1–200 characters without controls. Do not introduce a JSON-schema validator or DB extension.

- [x] Generate with `pnpm --filter @markiro/db exec drizzle-kit generate --name us_receiving_csv_previews`. Review all SQL and the previous/new snapshot diff; reject unrelated schema drift rather than applying it.
- [x] Run real DB round-trip and rejection tests: zero/max bytes, invalid UTF-8 retained as bytes, exact numeric/text spelling in JSON, wrong hash/size/template, malformed JSON shapes, incomplete proposal identity, row limits, unknown tenant, identical file in same/different tenants, explicit tenant-filtered lookup, DST-safe lifetime, expired evidence retention and rollback. Assert old business rows remain byte-identical after migration and preview writes.

## Task 2: Regression and handoff

**Files:** This plan and `docs/us/development-isolation.md`; check-only `.github/workflows/us-development.yml` selection if needed.

- [x] Add the new schema/migration tests to the existing read-only US database test command; preserve all workflow locks and permissions.
- [x] Run DB full test/typecheck/lint/build with `DATABASE_URL` unset and only the guarded US fixture URL set. Any non-US DB tests must skip rather than use the primary database.
- [x] Rebuild DB before affected Receiving API input/store/lifecycle regression tests. Record exact counts and skips separately.
- [x] Run isolation/browser-entry contracts, formatting and `git diff --check`; inspect final scoped diff. Record cleanup and external checks not exercised.
- [x] Document that this is storage only. Preview service resolution/authorization/audit, atomic apply, HTTP, browser and CSV output remain separate uncompleted requirements. Do not close INT-002 or publish anything.

## Local checkpoint — 2026-09-08

The subsequent [internal preview service](2026-09-08-us-03-receiving-csv-preview-service.md)
implements authorization, reference resolution and preview audit over this table.
It does not yet implement apply/result binding or open an HTTP route.

Implemented the 15-column preview table and generated migration0127. Review of
the entire SQL and structural comparison of snapshots0126/0127 found exactly one
added table, no changed existing tables or other schema sections, and a valid
snapshot predecessor. No DB extension is required. Raw header/findings/proposal
JSON stays `unknown` at the storage boundary; this does not certify a proposed
draft or its tenant-owned references.

TDD first failed the schema export assertion and, on a real disposable database,
the table-presence assertion (`null` rather than the expected table). The full
new schema/migration suite then passed 49/49 with no skips. A fixture helper's
inferred UUID-only parameter initially failed typecheck for the intentionally
missing tenant string; its explicit `string` type fixed the test typing without
changing the denial assertion. Final DB source/test typecheck, lint and build
passed.

Full DB verification passed 517 tests in 61 files; 141 cases in 27 files skipped
with the ordinary `DATABASE_URL` intentionally absent. US migration fixtures used
only the explicit guarded US URL. Following DB rebuild, Receiving input/store,
original command and lifecycle suites passed 106/106 in four files, no skips.
The bounded CSV contract suites passed 99/99 in two files. The existing API
Vite config-loader warning remains unsuppressed. The 19 isolation/browser-entry
contracts and release checker passed after the check-only CI selection change.
Repository-wide formatting, final scoped documentation formatting and
`git diff --check` passed. All changes remain unstaged on `codex/us-mvp`.

Read-only cleanup verification found zero `markiro_us_profile_*` fixture databases
and no preview table in base `markiro_us_dev`. Old products, lots, documents,
receiving drafts/frozen history, roots, ordered children, counters and operation
receipts remained identical in the migration fixture, including after preview
writes. Preview insertion rolled back with its enclosing failed transaction.

No preview/apply service, HTTP or browser behavior is exercised by this table.
No full primary API infrastructure suite, spreadsheet or hosted acceptance was
run: those surfaces are outside this storage checkpoint. No automatic deletion,
route, runtime limit, authorization grant, dependency, startup migration, release
workflow or external infrastructure changed. Prior dirty work is preserved;
keep the branch/worktree locally without staging, commit, push or merge.
