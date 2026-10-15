# Plan 2a5, Task 2 report: device-shift protocol layer (Zod schemas, builder, HostApi)

Status: DONE_WITH_CONCERNS (concerns are notes, none blocking)
BASE: dce8f8aeb2c49315eb563e517d8a14f023e49016 (branch claude/2a5-floor, worktree /tmp/claude/wt/2a5-floor)
Commit: 018fc54c5 `feat(standalone): the webview reads a station's shifts, creates one and enters it` (one trailer line, Claude Opus 5.5; `git status --short` empty after).

## What was done

Plan steps 1-7 applied by intent; every plan anchor matched exactly once (no anchor adaptation was needed; see below for counts).

- `src/host/protocol.ts`: `shiftSnapshotProductSchema`, `shiftSnapshotTemplateSchema` (`spec: templateSpecSchema`, the opaque object), `shiftSnapshotSchema`, `deviceShiftSchema`, `deviceShiftsSchema`, `enteredShiftSchema` (= `deviceShiftSchema.extend({ snapshot })`, snapshot required), strict `deviceShiftCreateSchema`, and their types.
- `src/host/requests.ts`: `DeviceShiftInput`, `deviceShiftCreate` (every field, `counterpartyId: null`).
- `src/host/api.ts`: `getDeviceShifts` (GET `/v1/device/shifts`, returns `.shifts`), `createDeviceShift` (POST same path, body), `enterShift` (POST `/v1/device/shifts/{id}/enter`, no body). None passes an `officeToken`, so the shell sends the device key only (`/v1/device/*` is webview-reachable: `webview_may_reach` in `src-tauri/src/device.rs`).
- `test/support/office.tsx`: `fakeHostApi` answers `getDeviceShifts` with `[]`; `createDeviceShift`/`enterShift` fail loudly.

### Contract verification against the host (read, not assumed)

- Fields, nullability and types of `DeviceShift`, `ShiftSnapshot*`, `DeviceShifts`, `DeviceShiftCreate` match `proto/src/lib.rs` (host `Option<u32>` -> `nullable()` for `plannedQty`; `deny_unknown_fields` on `DeviceShiftCreate` -> `.strict()`; the response structs have no `deny_unknown_fields` -> `z.object` strips). `plannedQty`/`boxCapacity` `positive()` agree with `validate::count` (1..max) and with the existing `officeShiftSchema`.
- Strictness choice (explicit and tested): responses are LENIENT at every level (shift, snapshot, snapshot product, snapshot template): a field a newer host adds is dropped, not an error. This is required by the 2a1 final-review note (a frozen snapshot outlives the host that froze it and fields are added as `Option`/default), and by AGENTS.md backward-compat rules. The request body is STRICT like the host. Enums (`status`, `mode`, `createdFrom`) are strict, as in `officeShiftSchema`: an unknown value fails the whole list (same as the office list; noted below).
- The host never serializes `snapshot` in the list (`skip_serializing_if`) and the list test asserts it; the station's list schema has no snapshot field, so `parse(fixture) toEqual fixture` holds in both directions with the Rust fixtures (`device-shifts.json`, `device-shift-entered.json`, `device-shift-create.json` are in the plan's `RESPONSES`/`REQUESTS` tables, which check "parses without losing a field", "tolerates a field added by a newer host" / "rejects an unknown field").
- Layout (256 KiB, `MAX_SPEC_BYTES` in `host/src/validate.rs`): the snapshot schema neither measures nor rebuilds it; `templateSpecSchema` is `z.custom` so the parsed layout is the SAME object (identity test with a ~240 KB layout and Cyrillic filler). The domain parse happens once, at entry (Task 3).
- Error mapping: the three methods go through the existing `HostClient.request`; a test over the real `createTauriHostClient` with a fake `invoke` proves a 409 `conflict` (`shift_busy`, `shift_line`, `shift_status`, `product_inactive`, `template_not_fit`), a 403 `forbidden` and a transport failure arrive as the same `HostError` (kind, code, status, `details.constraint`), and that a 2xx body failing the schema is `invalid_response`, never a shift.

## Anchor adaptations

None. All 18 plan fragments (5+... in protocol.test, 2 in api.test, 2 in office.tsx, 2 in protocol.ts, 2 in requests.ts, 4 in api.ts, plus the test imports) matched exactly once at their step. Differences from the brief's text only in what I added (below). `civilDateTextSchema` is a module-internal `const`, not an export: the brief lists it under "Consumes (`src/host/protocol.ts`)", which is fine because the new schemas live in the same file.

## RED / GREEN

- RED (`vitest run test/protocol.test.ts test/api.test.ts`, plan's tests only): `Test Files 2 failed (2)`, `Tests 7 failed | 208 passed (215)` (exactly the plan's number; the 7: three fixture "parses without losing a field"/"tolerates" pairs for the two response fixtures, the request fixture pair, the builder test; `api.test.ts` failed at import: schemas undefined). Output: `/tmp/claude/t2/red.txt`.
- GREEN (plan's tests only, after step 3): `Test Files 2 passed (2)`, `Tests 269 passed (269)` (the plan's number).
- Final (plan's tests plus mine): `Test Files 2 passed (2)`, `Tests 288 passed (288)` (+19 added by me), `--reporter=verbose`, stderr 0 bytes, no `act(`/unhandled.
- `typecheck` clean, `lint` clean, `prettier --check` on all 6 files clean, `git diff --check` clean; `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`.
- Whole package `test`: `Test Files 2 failed | 78 passed (80)`, `Tests 7 failed | 2213 passed (2220)`, all 7 failures are 5 s timeouts in `test/products-page.test.tsx` (1) and `test/template-editor.test.tsx` (6) under a machine load average of 74-99. Re-run alone: `products-page` 20/20 twice; `template-editor` fails different tests per run at the default 5 s (2 of 97, then 0 of 97 with `--testTimeout=90000`: `Tests 97 passed (97)`). Nothing in those files touches the new code; I did not raise any timeout in the tree. Unproven on an idle machine; please re-run the full suite there.
- Delayed-`setImmediate` stand: not run; the two changed test files render no React component (`office.tsx` is imported only for `fakeHostApi`, which builds `vi.fn`s), so there is no passive-effect race to expose.

## What I added to the plan's tests (and why)

The plan's tests let these survive (shown by mutation): hardcoded `boxCapacity: 12` in the builder (fixture and the plan's typed input both use 12); and everything about field-level schema rules. Added:

- `test/protocol.test.ts`, builder: "sends the capacity, the date and every id the operator chose, not the fixture's" (distinct values, `toStrictEqual`, parse round-trip, exact key set).
- `test/protocol.test.ts`, new `describe("a station's shifts")` (8 tests): list shape; every shift field missing / wrong form / null where not allowed; null where a planned shift has nothing; lenient read with unknown fields at all four levels dropped; entered shift missing any part of its snapshot (top, snapshot, product, template, each key dropped in turn); snapshot field forms and null/zero boundaries (`chzProductGroupCode` 0 ok, `shelfLifeDays` 0 refused, `rev` 0/-1 ok, `spec` array/null/string refused); opaque large layout by identity and odd keys; create body required/optional/null fields and "the line is no field" (`lineId`, `mode`, `palletsEnabled`, `ownerDeviceId` refused).
- `test/api.test.ts`, in `describe("HostApi device shifts")`: list order and empty list; the exact `host_request` call per method over the real Tauri client (`officeToken: null`, body `null` for enter); `it.each` of five conflict refusals passed through with status/constraint; forbidden and transport failures; schema failure -> `invalid_response`; the `fakeHostApi` defaults and that an override beats the default.
- Imports merged (`vi`, `createTauriHostClient`, `HostError`, `fakeHostApi`).

## Mutants (all restored byte-identically: sha256 before/after equal and `cmp` against a copy in `/tmp/claude/t2/before_*`; script `/tmp/claude/t2/mutant.py`, runs `test/protocol.test.ts test/api.test.ts`)

Builder and API (source files `requests.ts` sha c95df99f040c, `api.ts` 06c31aa377ee, restore OK for each):

| Mutant                                               | First failing test (key)                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| M1 builder drops `counterpartyId: null`              | protocol "a station's new shift, with no counterparty..." (plan) and "sends the capacity, the date..."                          |
| M2 builder `boxCapacity: 12` constant                | "sends the capacity, the date and every id the operator chose" ONLY (the plan's test passes this mutant: added)                 |
| M3 builder `plannedQty: null` always                 | plan's builder test + mine                                                                                                      |
| M4 builder drops `requestId`                         | plan's builder test + mine                                                                                                      |
| M5 builder swaps productId/boxTemplateId             | plan's builder test + mine                                                                                                      |
| M6 `enterShift` schema -> `deviceShiftSchema`        | api "reads, creates and enters..." and "rejects a list without its shifts and an entry without its snapshot"                    |
| M7 list path `/v1/device/shift`                      | api "reads, creates and enters..." and "asks the shell for the device routes..."                                                |
| M8 create method PUT                                 | same two                                                                                                                        |
| M9 create sends no body                              | same two                                                                                                                        |
| M10 enter path `/open`                               | same two                                                                                                                        |
| M11 list returns `.shifts.slice(1)`                  | api "reads the list as the shifts alone..."                                                                                     |
| M12 `enterShift` rethrows as a plain `Error`         | api "lets the refusal shift_busy/shift_line/shift_status through..."                                                            |
| M13 `getDeviceShifts` swallows the failure into `[]` | api "lets a refusal of the list through...", "reads a host answer that fails the schema..."                                     |
| M14 `createDeviceShift` rethrows as a plain `Error`  | api "lets the refusal product_inactive/template_not_fit through..."                                                             |
| M15 `enterShift` sends an `officeToken`              | api "reads, creates and enters..." and "asks the shell for the device routes..."                                                |
| F1 fake `getDeviceShifts` refuses                    | api "is stood in for by a fake..."                                                                                              |
| F2 fake `enterShift` answers                         | same                                                                                                                            |
| F3 fake ignores `overrides`                          | same (first version of that test SURVIVED this mutant; strengthened to compare an overriding answer by identity, then it fails) |

Schemas (`protocol.ts` sha c683bd74e179, restore OK for all 30). Each is caught; the first failing test:

| Mutant                                       | Caught by                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| S1 `deviceShiftCreateSchema` not `.strict()` | "request fixture device-shift-create.json > rejects an unknown field" (plan)           |
| S2 snapshot `counterpartyName` not nullable  | "refuse a snapshot field of the wrong form, and take null..."                          |
| S3 `printName` not nullable                  | same                                                                                   |
| S4 `shelfLifeDays` nonnegative               | same                                                                                   |
| S5 `chzProductGroupCode` positive            | same                                                                                   |
| S6 snapshot `spec` -> `z.unknown()`          | same                                                                                   |
| S7 shift `ownerDeviceId` not nullable        | api "reads, creates and enters..." (+2)                                                |
| S8 shift `number` may be empty               | "refuse a shift that lacks a field, and one whose field has the wrong form"            |
| S9 shift schema `.strict()`                  | plan's "tolerates a field added by a newer host" (+1)                                  |
| S10 snapshot schema `.strict()`              | "read the list leniently and drop what a newer host adds..."                           |
| S11 shift `plannedQty` nonnegative           | "refuse a shift that lacks a field..."                                                 |
| S12 shift `boxCapacity` nonnegative          | same                                                                                   |
| S13 `openedAt` any string                    | same                                                                                   |
| S14 `createdFrom` any string                 | same                                                                                   |
| S15 `status` any string                      | same                                                                                   |
| S16 create `boxCapacity` nullable            | "send a new shift with the four required fields..."                                    |
| S17 create `requestId` any string            | same                                                                                   |
| S18 entered `snapshot` optional              | api "rejects a list without its shifts and an entry without its snapshot" (+1)         |
| S19 template `rev` any number (1.5)          | "refuse a snapshot field of the wrong form..."                                         |
| S20 shift `productionDate` any string        | "refuse a shift that lacks a field..."                                                 |
| S21 list `shifts` -> `z.array(z.unknown())`  | api "rejects a list without its shifts..." (+2)                                        |
| S22 create `plannedQty` not nullable         | plan's "request fixture device-shift-create.json > parses without losing a field" (+2) |
| S23 create `counterpartyId` not nullable     | same (+3)                                                                              |
| S24 `palletsEnabled` optional                | "refuse a shift that lacks a field..." (+1)                                            |
| S25 create `plannedQty` zero                 | "send a new shift with the four required fields..."                                    |
| S26 create `boxCapacity` zero                | same                                                                                   |
| S27 shift `lineId` any string                | "refuse a shift that lacks a field..."                                                 |
| S28 snapshot product `id` any string         | "refuse a snapshot field of the wrong form..."                                         |
| S29 template `id` any string                 | same                                                                                   |
| S30 `issuerPrefix` nullable                  | same                                                                                   |

(Earlier I ran the first batch with an unquoted `$T` under zsh, which passed one argument, so those exit-1s were meaningless; I discarded them and re-ran every mutant under bash with the real file list, and checked each has a named FAIL line. The tables above are the valid runs: `/tmp/claude/t2/muts2.out` for S1-S30; the M/F lines are from the re-run.)

## Files changed

`apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/requests.ts`, `apps/standalone/src/host/api.ts`, `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/api.test.ts`, `apps/standalone/test/support/office.tsx` (6 files, +631/-3). Nothing else touched; no scratch file left in the tree.

## Self-review

- No `any`, casts or `!` in sources; Cyrillic only as letters; `import type` / `type` specifiers used.
- Counts: the plan's 7 / 208 / 215 and 269 reproduced exactly; no differences to report.
- Not run: Rust, `build` (the task touches no shell code or embedded dist), browser or hardware checks, a live host (the real host was not called; only fixtures read from the Rust side plus a mocked `invoke`).

## Concerns / notes for later tasks

1. `deviceShiftCreateSchema.requestId` is `z.uuid()`, which accepts upper-case, while the host's `client_uuid` requires lower-case hyphenated (`validate.rs`). The plan's schema was kept; the screen's `crypto.randomUUID()` is lower-case. Task 4/5's form should always mint with `randomUUID()` (an upper-case id would reach the host as `validation_failed`).
2. An unknown `status`/`mode`/`createdFrom` value from a newer host fails the WHOLE list read (same as `officeShiftSchema`); the app will then show `invalid_response` for the shift list rather than skip the one shift. If 2a6+ wants per-shift tolerance, the list schema would need a lenient element; left as in the plan.
3. `deviceShiftCreateSchema.boxCapacity` is not `nullable` although the Rust `Option<u32>` accepts `null`; the builder always sends a number (kept, matches `shiftCreateSchema`).
4. The full-package run showed 7 load-induced 5 s timeouts in two heavy existing files (see GREEN); they pass alone with a longer timeout. A re-run on an idle machine is the honest confirmation.
5. Queued minor 5 (query-plan assertions in both lists) does not apply: this task adds no SQL.
