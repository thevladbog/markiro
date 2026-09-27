# Saved Receiving CSV Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Download one exact, selected saved Receiving revision as a bounded, audited, reversible CSV from the isolated US application.

**Architecture:** A pure platform-contracts codec serializes and validates the saved live record. The existing Receiving store reads and authorizes within a repeatable-read transaction, generates bytes and audits their digest before the controller responds. The US browser client validates those bytes before the view initiates a download.

**Tech Stack:** TypeScript, Zod, Vitest, NestJS, Drizzle/Postgres, React, Vite proxy, Playwright US harness.

**Spec:** [2026-09-09-us-03-receiving-csv-export-design.md](../specs/2026-09-09-us-03-receiving-csv-export-design.md)

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit` on `codex/us-mvp`; preserve all pre-existing dirty work.
- No commit, push, PR, merge, release, workflow dispatch or deployment in this increment.
- Export format `markiro-receiving-export-v1`: fixed header, UTF-8 with one BOM, quoted comma CSV, CRLF, tagged reversible cells.
- One selected event revision, at most 100 items and 100 documents; encoded cell at most 32,767 UTF-16 units; whole artifact at most 16 MiB.
- Keep `traceability.export.read` distinct from Receiving write. Read only tenant-owned records and preserve every saved/frozen field without current-reference hydration.
- User-facing copy is EN/ES. XLSX, supplier re-import, object storage and generic export jobs are outside this plan.
- Use only synthetic, disposable US infrastructure. Run no primary `.env`, RU deploy scripts or production workflows.

## Review Focus

- A literal `=1+1`, a backslash-n sequence and an actual newline must decode to three different original strings; Task 1 tests all three.
- A cancelled draft and a voided finalized revision must retain their different content kinds; Task 1 tests both.
- A reader without export capability must not obtain bytes even if they can read Receiving; Task 2 tests the role boundary.
- A stale lifecycle version must fail before audit or byte delivery; Task 2 tests the version race.
- A response with the correct event ID but modified bytes or SHA must not be downloaded; Task 3 tests both integrity failures.

---

### Task 1: Pure CSV codec and saved-record adapter

**Files:**

- Create: `packages/platform-contracts/src/traceability/receiving-csv-export.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Test: `packages/platform-contracts/test/us-receiving-csv-export.test.ts`

**Interfaces:**

- Consumes: `receivingLiveRecordSchema`, `ReceivingLiveRecord` and the approved file contract.
- Produces: `receivingCsvExportQuerySchema`; `encodeReceivingCsvExport(record: ReceivingLiveRecord, capturedAt: string): Uint8Array`; `decodeReceivingCsvExport(bytes: Uint8Array): {record: ReceivingLiveRecord; capturedAt: string}`; a typed limit/format error.

- [ ] **Step 1: Write a failing round-trip test.** Use `liveFinalized` and the live draft/void fixtures from `test/support/us-receiving-lifecycle-fixture.ts`; assert decoded record equality, exact captured time, fixed header/BOM/CRLF and dangerous `text:` cells. Example assertion:

  ```ts
  const bytes = encodeReceivingCsvExport(liveFinalized, "2026-09-25T00:00:00.000Z");
  expect(decodeReceivingCsvExport(bytes).record).toEqual(liveFinalized);
  expect(bytes.slice(0, 3)).toEqual(Uint8Array.of(0xef, 0xbb, 0xbf));
  ```

- [ ] **Step 2: Run the focused test and observe the missing codec failure.** `pnpm --filter @markiro/platform-contracts exec vitest run test/us-receiving-csv-export.test.ts`.
- [ ] **Step 3: Implement the exact v1 codec.** Verify the strict saved schema before serialization, remove only the two arrays from the record payload, serialize ordered item/document rows, encode all data cells with the four tags and canonical escaping, check per-cell/file/row limits, then implement a bounded strict decoder that restores arrays and checks convenience fields. Export only the named API from `index.ts`.

  ```ts
  const parsed = receivingLiveRecordSchema.parse(record);
  const bytes = new TextEncoder().encode(`\uFEFF${header}\r\n${rows.join("\r\n")}\r\n`);
  if (bytes.byteLength > 16 * 1024 * 1024)
    throw new ReceivingCsvExportError("export_value_too_large");
  return bytes;
  ```

- [ ] **Step 4: Add focused RED/GREEN cases** for draft, amendment, V1/V2/V3 frozen snapshots, both void forms, empty/maximal arrays, missing/null/empty, reference sources, exact decimals/leading zeros, prefix collisions, controls/Unicode, tampered header/columns/ordinals, invalid UTF-8 and limits. Run package test, typecheck, lint and build.

### Task 2: Audited tenant-scoped server endpoint

**Files:**

- Create: `apps/api/src/modules/traceability/receiving/us-receiving-csv-export.ts`
- Modify: `apps/api/src/modules/traceability/receiving/us-receiving-store.ts`, `apps/api/src/deployment/us-receiving.controller.ts`
- Test: `apps/api/test/us-receiving-csv-export.e2e.test.ts`, `apps/api/test/us-receiving-http.e2e.test.ts`

**Interfaces:**

- Consumes: Task 1 codec/query schema, existing `authorizeUsMasterData`, `readReceivingLiveRecord` and audit table.
- Produces: `UsReceivingStore.exportCsv(tenantId, actorUserId, id, query, requestId)` returning `{bytes, sha256, fileName}`; `GET :id/export.csv` with a binary response.

- [ ] **Step 1: Write a failing server test** with synthetic tenant/actor/event. Verify exact bytes decode, audit actor/tenant/target/version/hash/size, and that read-only auditors succeed while receiving-only operators fail.

  ```ts
  const result = await store.exportCsv(
    tenantId,
    auditorId,
    eventId,
    {
      expectedDraftVersion: 1,
      expectedLifecycleVersion: 1,
    },
    requestId,
  );
  expect(decodeReceivingCsvExport(result.bytes).record.id).toBe(eventId);
  ```

- [ ] **Step 2: Run the focused test and observe failure.** `pnpm --filter @markiro/api exec vitest run test/us-receiving-csv-export.e2e.test.ts` against an explicitly owned disposable US database.
- [ ] **Step 3: Implement authorization, capture and audit** in one repeatable-read transaction. Parse strict UUID/query after authorization, read exact selected revision, compare both versions, generate and SHA-256 hash bytes, insert `traceability.receiving.csv_generated` with exact metadata and no record contents. Keep the transaction all-or-nothing. Use a typed 409 for stale state and a localized, content-free error for file limits.

  ```ts
  await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.EXPORT_READ);
  const record = await readReceivingLiveRecord(tx, tenantId, eventId);
  if (
    record.draftVersion !== expectedDraftVersion ||
    record.lifecycle.lifecycleVersion !== expectedLifecycleVersion
  )
    throw new ConflictException({ code: "receiving_export_stale" });
  ```

- [ ] **Step 4: Add controller route and response contract.** Place `@Get(":id/export.csv")` before `@Get(":id")`; set safe attachment filename, `text/csv; charset=utf-8`, `no-store`, `nosniff`, digest header, and return the already committed Buffer without JSON transformation. Document query and responses in OpenAPI.
- [ ] **Step 5: Add RED/GREEN denial and rollback cases** for foreign tenant, wrong role, stale versions, superseded revision selection, limit failure and audit insertion failure. Run focused HTTP/e2e, API package test/typecheck/lint/build.

### Task 3: Verified US browser download client

**Files:**

- Modify: `apps/admin/src/us/client.ts`, `apps/admin/vite.us.config.ts`
- Test: `apps/admin/test/us-receiving-csv-client.test.ts`, `tools/us-development/test/browser-entry.test.mjs`

**Interfaces:**

- Consumes: Task 1 decoder, Task 2 bytes/headers, current same-origin US client.
- Produces: `client.exportReceivingCsv(record)` returning the original verified bytes plus a safe filename; no automatic retry or persistence.

- [ ] **Step 1: Write a failing client test** with an actual encoded fixture and fake `Response`. Assert digest/ID/version verification and rejection of changed bytes, MIME, length, digest and unauthorized/stale responses.

  ```ts
  const result = await client.exportReceivingCsv(expectedRecord);
  expect(decodeReceivingCsvExport(result.bytes).record.id).toBe(expectedRecord.id);
  ```

- [ ] **Step 2: Run focused test and observe failure.** `pnpm --filter @markiro/admin exec vitest run test/us-receiving-csv-client.test.ts`.
- [ ] **Step 3: Implement the binary client.** Build the canonical strict query from the displayed record, use same-origin credentials/no-store/redirect-error and a bounded response read, verify exact SHA-256 over original bytes, decode via Task 1 and compare selected ID/versions before returning. Map safe server errors without exposing raw body data.
- [ ] **Step 4: Open only the exact export path in the US Vite proxy.** Require UUID and exactly two canonical numeric version fields in fixed order; reject duplicates, extra fields, nested paths and imports on that route. Test the allowlist and run admin focused test/typecheck/lint/build.

### Task 4: Receiving action, copy and browser proof

**Files:**

- Create: `apps/admin/src/us/receiving/csv-export.tsx`
- Modify: `apps/admin/src/us/receiving/view.tsx`, `apps/admin/src/us/receiving/editor.tsx`, `apps/admin/src/us/receiving/amendment-editor.tsx`, `apps/admin/src/us/master-data/workspace.tsx`, `apps/admin/src/us/receiving/csv-copy.ts`, `docs/us/receiving-browser.md`, `docs/us/requirements-traceability.md`
- Test: `apps/admin/test/us-receiving-csv-ui.test.tsx`, `tools/us-development/test/receiving-csv-flow.smoke.mjs`

**Interfaces:**

- Consumes: Task 3 verified binary method and current `US_CAPABILITY.EXPORT_READ` from access summary.
- Produces: Export CSV action on saved Receiving draft/frozen detail with EN/ES instructions, pending/error states and dirty-form block.

- [ ] **Step 1: Write a failing UI test** for export-capable saved detail, no action for receiving-write-only access, dirty form, stale response and explicit retry. Assert one download of the same verified bytes.

  ```tsx
  expect(screen.getByRole("button", { name: /export csv/i })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: /export csv/i }));
  expect(screen.getByRole("status")).toHaveTextContent(/download ready/i);
  ```

- [ ] **Step 2: Run focused test and observe failure.** `pnpm --filter @markiro/admin exec vitest run test/us-receiving-csv-ui.test.tsx`.
- [ ] **Step 3: Wire capability, dirty state and download.** Pass `canExport` from current US access; show action only for saved records; require save/discard before export; block duplicate clicks; revoke the temporary object URL after download; discard results after context change. Add localized copy and status messages.
- [ ] **Step 4: Run focused UI and real browser flow.** Parse downloaded bytes with the codec, verify chosen ID, versions, SHA and audit in disposable US DB. Capture EN/ES mobile/desktop light/dark views, inspect actual overflow/focus. Update the traceability matrix only after evidence passes.
- [ ] **Step 5: Final checks.** Run relevant package suites, typecheck/lint/build, `pnpm format:check`, `git diff --check`, isolation contract and scoped browser checks. Report automated versus external spreadsheet checks separately; do not claim Excel/LibreOffice proof without opening the file there.

## Execution

Proceed inline sequentially after owner review of this written plan. The owner already selected inline execution for this US thread. The current task does not authorize committing or publishing the branch.
