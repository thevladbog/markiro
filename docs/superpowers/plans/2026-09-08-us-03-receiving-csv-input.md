# Receiving CSV input foundation implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline, following the
> owner's selected sequential workflow. Steps use checkbox syntax.

**Goal:** Decode the fixed supplier template and validate its rows without any
business writes or claims of tenant-reference resolution.

**Architecture:** Domain code owns bounded byte/CSV syntax and raw row locations.
The contracts adapter owns conversion to existing draft fields and reports
normalization separately. Neither layer reads a database or authorizes apply.

**Tech Stack:** Existing TypeScript, Vitest and Zod; no new dependencies.

**Spec:** [Approved import design](../specs/2026-09-08-us-03-receiving-csv-import-design.md).

## Global constraints

- Work only in `codex/us-mvp`; preserve existing dirty browser/doc work.
- UTF-8, optional leading BOM, comma/doubled-quote dialect, LF/CRLF, 256 KiB.
- Exactly the 18 documented columns and 1–100 logical data rows.
- No inferred identities, numeric conversion, skipped rows or hidden trimming.
- No route, database, UI, CSV output, release, dependency or primary-checkout change.
- No commit/push without a separate owner request.

## Task 1: Bounded raw decoder

Files: create `packages/domain/src/traceability/receiving-csv.ts` and
`packages/domain/test/us-receiving-csv.test.ts`; export from
`packages/domain/src/index.ts`.

Interface: `parseReceivingCsv(bytes: Uint8Array, templateVersion: string)` returns
either a file failure with code/physical line and no partial rows, or ordered raw
rows with `rowNumber`, `lineNumber`, `cells`, and field-count issues.
`RECEIVING_CSV_COLUMNS` and `RECEIVING_CSV_VERSION` identify the fixed dialect.

- [x] Add failing behavior tests through the public package source entry.

```ts
expect(parseReceivingCsv(new Uint8Array([0xff]), "markiro-receiving-v1")).toMatchObject({
  ok: false,
  error: { code: "invalid_utf8" },
});
```

- [x] Exercise hand-written records with doubled quotes, comma/newline cells,
      BOM, CRLF line locations, terminal/extra blank records, bad headers/quotes,
      bare CR, NUL, malformed UTF-8 and both sides of size/row limits. Assert raw
      formula-looking text and decimal spelling unchanged, not a writer round trip.
- [x] Run `pnpm --filter @markiro/domain exec vitest run test/us-receiving-csv.test.ts`
      and observe failure from the missing decoder, then implement a bounded state
      machine with `start`, `unquoted`, `quoted`, `closed` states. A newline finishes
      a record only outside quotes; a closed quote admits only comma/newline/EOF.
- [x] Run focused tests, package tests, typecheck, lint and build. Build before
      the adapter's tests import the public compiled domain entry.

## Task 2: Strict row adapter

Files: create `packages/platform-contracts/src/traceability/receiving-csv.ts` and
`packages/platform-contracts/test/us-receiving-csv.test.ts`; export from
`packages/platform-contracts/src/index.ts`.

Interface: `parseReceivingCsvRow(cells: readonly string[])` returns either
column/code issues, or an unresolved product selector, a validated
`ReceivingDraftItem` (null product ID for a GTIN selector), and normalization
records. An item is not tenant-resolved or approved for persistence.

- [x] Write failing literal fixtures for ID/GTIN selector exclusivity, exact
      GTIN spelling/canonical lookup key, explicit link mode/lot ID rules, boolean
      literals, all source branches, preserved hidden exemption fields, missing
      nullable values, exact quantities/TLC, field limits and normalized text.

```ts
expect(parseReceivingCsvRow([])).toMatchObject({
  ok: false,
  issues: [{ column: null, code: "column_count" }],
});
```

- [x] Run `pnpm --filter @markiro/platform-contracts exec vitest run test/us-receiving-csv.test.ts`
      before implementation. Map fixed-width cells, enforce selector/link/source
      structure, then use `receivingDraftItemSchema.safeParse` for existing rules.
      Retain the original cells; report each transformed input field explicitly.
- [x] Run focused and full contracts tests, typecheck, lint and build; exercise
      existing Receiving consumers if shared contracts change, not merely new exports.
- [x] Run release-isolation contracts, formatting and `git diff --check`.
      Record exact results and exclusions. Mark only delivered tasks complete.

## Following checkpoints

The approved design separately owns preview/apply storage and HTTP, connected UI,
and the P0 CSV output design. Those are not satisfied by this pure foundation.
INT-002 remains in progress until real confirmed import and safe output are proven.
The next pure transport/server-input checkpoint is recorded in the
[server input plan](2026-09-08-us-03-receiving-csv-server-input.md); it does not
implement persisted preview or atomic application.

## Implemented checkpoint — 2026-09-08

Both pure modules and public exports are implemented locally. File parsing
returns raw rows plus structural issues, never an authorization/apply decision.
The adapter returns unresolved ID/GTIN selectors, current validated draft fields
and explicit normalization records. GTIN rows retain a null `productId` until
future tenant-scoped resolution. Existing schemas/validators are reused unchanged.

TDD evidence: 32 decoder tests initially failed on the missing public function,
then passed. The adapter's first 40 tests likewise failed before implementation
and passed afterward. Inline review identified missing normalization records for
UUID case conversion in linked-lot and both source branches; two new tests failed
with those exact records absent, then passed after the reporting-only fix.

Final package runs: domain 1,041/1,041 tests across 51 files, contracts 721/721
across 33 files; no skips. This includes 74 new focused tests. Typecheck (source
and tests), lint and build passed for both packages. Nineteen isolation/entry
contracts and the release-isolation checker passed. No dependency or operational
workflow changed, and there is no local Graphify graph to update.
Repository-wide format checking and the final scoped document/diff checks passed.

No browser, HTTP, database, spreadsheet, hosted or hardware verification was run:
this checkpoint introduces no such surface. Existing non-CSV schemas and their
consumers were not changed; full contracts tests cover existing shared behavior.
The prior browser/doc modifications remain untouched. All new work remains local
and unstaged, without a commit, push, PR or deployment. Next: preview/apply storage
and server contracts under the approved import specification. UI and safe output
remain separate; pure parsing does not satisfy end-to-end INT-002 acceptance.
