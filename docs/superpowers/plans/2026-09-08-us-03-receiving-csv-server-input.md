# Receiving CSV server input implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline under the
> owner's selected sequential workflow; use TDD for each task.

**Goal:** Establish strict preview/apply request contracts and server-side file
preparation before persistent preview/application work.

**Architecture:** Portable Zod contracts reject malformed transport before
allocation/decoding. A pure US server helper hashes the original bytes and runs
the existing decoder/row adapter, retaining invalid rows and raw header input.
Neither preparation nor a parsed confirmation authorizes a business operation.

**Tech Stack:** Existing Zod, TypeScript, Node 24 crypto/Buffer, Vitest; no new dependency.

**Spec:** [Approved CSV import specification](../specs/2026-09-08-us-03-receiving-csv-import-design.md).

## Global constraints

- `codex/us-mvp` only; preserve prior dirty work and release locks.
- Original UTF-8 file at most 256 KiB; version `markiro-receiving-v1`.
- Base64 is canonical, padded standard alphabet, without whitespace/data-URL prefixes.
- Current nullable Receiving header rules; strict objects reject server-owned fields.
- No route, body-limit change, DB mutation/migration, UI, deployment or push in this checkpoint.

## Task 1: Strict request contracts

Create `packages/platform-contracts/src/traceability/receiving-csv-commands.ts`
and `packages/platform-contracts/test/us-receiving-csv-commands.test.ts`;
modify the package source entry to export schemas and inferred types.

Interfaces: `receivingCsvPreviewInputSchema` accepts template version,
`fileBase64`, common `header` and optional `fileName` metadata;
`receivingCsvApplyInputSchema` accepts only `operationKey` and
`expectedPreviewDigest` (the run UUID belongs to the path).

- [x] Write public-boundary failing tests, including nonzero pad bits that Node
      would otherwise decode as another representation of the same bytes.

```ts
expect(
  receivingCsvPreviewInputSchema.safeParse({
    templateVersion: "markiro-receiving-v1",
    fileBase64: "Zh==",
    header,
  }).success,
).toBe(false);
```

- [x] Cover valid quanta, absent/extra/middle padding, whitespace/URL-safe alphabet,
      exact 256 KiB limit and same-length encodings that decode above that limit,
      missing/version/type errors, nested tenant/actor/items injection, nullable
      headers, civil dates, document uniqueness, filename controls and digest shape.
- [x] Run the focused test before implementation. Validate base64 length/alphabet,
      decoded byte length and unused pad bits without decoding or unbounded regex
      backtracking. Reuse `receivingDraftSchema.omit({ items: true })` for headers.
- [x] Run full contracts tests, typecheck/lint/build before server consumer tests.

## Task 2: Original-byte preparation

Create `apps/api/src/modules/traceability/receiving/us-receiving-csv-input.ts`
and `apps/api/test/us-receiving-csv-input.test.ts`.

Interface: `prepareUsReceivingCsvFile(input: unknown)` validates the request and
returns normalized request input, an independent raw-header snapshot, original
bytes/SHA-256 and decoded rows with the existing row-adapter result. File errors
are explicit and expose no salvageable row set. It has no database or I/O dependency.

- [x] Write failing tests with hand-written CSV and original-byte SHA-256 fixtures.
      Cover malformed request 400 before decode, invalid UTF-8/file structure, a
      mixed valid/invalid-row file, exact formula/leading-zero text, raw header versus
      normalized header, and BOM/CRLF file identity differences.

```ts
expect(prepareUsReceivingCsvFile({ ...input, fileBase64: "" })).toMatchObject({
  byteSize: 0,
  fileSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  content: { ok: false, error: { code: "no_rows" } },
});
```

- [x] Run `pnpm --filter @markiro/api exec vitest run test/us-receiving-csv-input.test.ts`
      before implementing validation, byte decoding/hash, raw header snapshot and
      domain/contract composition. A request failure uses a safe code, never raw input.
- [x] Run focused server tests, API typecheck/lint/build, isolation tests, formatting
      and diff checks. Report that the full primary API infrastructure suite, HTTP,
      database and browser were not exercised by this pure-input checkpoint.

## Following work

The next implemented checkpoint is documented in the
[preview storage plan](2026-09-08-us-03-receiving-csv-storage.md). It adds the table
and migration only, not an exposed preview/apply service.

Persistent tenant-scoped preview, expiry, reference resolution/revalidation,
atomic draft creation, operation replay and exact audit must consume these
contracts through the approved service design. Register HTTP/proxy routes only
after storage/transaction/denial tests. CSV output remains separate required P0.

## Local implementation checkpoint — 2026-09-08

Implemented strict request schemas plus an internal server byte-preparation
helper. Canonical base64 validation checks unused pad bits and actual decoded
size before allocating bytes, including encodings whose lengths match the
maximum while carrying one or two excess bytes. The original file hash includes
BOM and line endings. Preparation retains raw/normalized common headers and all
row failures without becoming an apply decision or resolving tenant references.

TDD: all 57 new command tests failed on the absent schemas before passing. The
server test first reported a missing file; an empty module then let all 17 tests
run and fail on the missing function before implementation. All 17 subsequently
passed. Known empty/`abc` SHA-256 fixtures, original BOM/CRLF bytes, safe request
errors, mixed rows and independent raw-header snapshots are covered.

Full contracts verification passed 778/778 tests across 34 files with no skips;
contracts source/test typecheck, lint and build passed. Nineteen isolation/entry
contracts and the release-isolation checker passed. The existing API Vite
config-loader warning remains unsuppressed.
API typecheck, lint and build also passed. After dependency builds, the final
server-input rerun passed 17/17 with no skips. Repository-wide format checking
passed; final scoped documentation formatting and diff checks passed afterward.

No route, HTTP body limit, authorization grant, migration, database, UI or
operational workflow changed. Full primary API infrastructure tests and browser,
database, spreadsheet or hosted acceptance were not run: this isolated helper
has no such dependency and those surfaces are not implemented by this checkpoint.
Existing shared schemas were reused unchanged. The approved persistent-preview
and atomic-application work remains open, as do UI and safe receiving CSV output.
Prior dirty work is preserved. Nothing is staged, committed, pushed or deployed.
