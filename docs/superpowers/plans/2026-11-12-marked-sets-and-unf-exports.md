# Markiro Autonom marked sets and UNF exports implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute this plan. Steps use checkboxes for tracking.

**Goal:** Assemble individually marked cosmetic sets in the Autonom station and handheld, review their composition in the office, and export the agreed files.

**Architecture:** A catalog recipe selects assembly when starting a shift. The host freezes the recipe in the shift snapshot and accepts each completed set as one durable fact. Office exports read accepted facts and the active box and pallet relationships of ordinary shifts.

**Tech Stack:** TypeScript, React, Zod, Rust, SQLx/SQLite, Kotlin and Compose.

**Spec:** [Сборка маркированных наборов и выгрузки для 1С:УНФ](../specs/2026-11-12-marked-sets-and-unf-exports-design.md).

## Global constraints

- Preserve ordinary aggregation and validation, the stored shift snapshot and old protocol readers.
- Keep capture offline and retryable. Report a rejected or conflicting assembly in the office.
- Retain full scanned KM text including GS separators. Keep GTIN and SSCC as strings.
- UNF columns are `Штрихкод или код маркировки` and `Код упаковки`.
- Export the registry for manual submission in the Chestny Znak cabinet. Verify the UNF import separately.

Upgrade the Autonom host before installing clients that speak protocol 9.
The 1.7.0 build leaves the recorded release history intact. The station
replays its reference projection on upgrade so cached set cards include
their recipes.

## Review focus

- A supplier's code can be accepted by a set even without an earlier production scan.
- A repeated upload cannot create a second set and a competing device cannot claim the same mark.
- A premature scan of the set code does not consume it or erase the draft.
- An old device cannot start a set shift as an ordinary validation shift.
- The general UNF CSV keeps an unpalletized box and writes each direct relationship once.

### Task 1: Catalog and authoritative assembly

**Files:** `apps/standalone/host/src/routes/products.rs`, host reference and shift routes, host fact application, a new host migration, `apps/standalone/proto`.

**Interface:** Add optional `setItems: {gtin14, productName, quantity}[]` to products and the frozen shift recipe. Reuse the validation shift transport with a `set-assembly-v1` capability. `set_assembled` carries `assembledAt`, `setCode` and `items`, with the event ID as the set identity. `GET /v1/office/shifts/{id}/sets` returns the recorded result and actual marks.

- [x] Add a host test for a complete recipe, repeat delivery, rejected overfill and competing claims.
- [x] Verify the new test fails, then implement catalog validation, a frozen snapshot and atomic host acceptance.
- [x] Verify protocol 9 fixtures and compatibility with ordinary shifts and older devices.

### Task 2: Autonom office and station

**Files:** `apps/standalone/src/host/{protocol,api,requests}.ts`, `src/local/reference-sync.ts`, Tauri local migrations, `src/office/products`, `src/office/shifts`, `src/floor/shifts`, `src/floor/work`.

- [x] Add a focused red test for ordered assembly states and a test for durable completion/retry.
- [x] Add the product card recipe editor and the office shift set detail. Pass the authoritative records to the export dialog.
- [x] Select the assembly setup through the normal New Shift GTIN lookup. Keep the first scan for selection and require the final Data Matrix to close each set.
- [x] Persist open drafts and queue a complete fact atomically. Show progress, rejected scans and saved/offline feedback.
- [ ] Run standalone focused and package gates.

### Task 3: Handheld

**Files:** `apps/handheld/app/src/main`, unit tests and shared fixture consumers.

- [x] Add red tests for a frozen recipe, premature closure and process restart.
- [x] Support the same capability and wire format. Use scanner events and the durable queue to close and submit a set. Display per-item counters and sync state.
- [ ] Run `testDebugUnitTest`, `lintDebug` and `assembleDebug`. Report physical-device verification separately.

### Task 4: UNF CSV and Chestny Znak registry

**Files:** `packages/domain/src/standalone-exports.ts`, export renderers and tests, `apps/standalone/src/office/exports`, host and Tauri export-file allowlists.

- [x] Add a failing test for the two exact CSV headers, direct-parent relations, and boxes without a pallet. Check the marked set CSV and XLSX registry.
- [x] Implement `[1C][csv] Общая выгрузка`, `[1C][csv] Выгрузка Короба - Коды` and `[1C][csv] Выгрузка Палеты - Короба`. Reuse saved file history for all formats.
- [x] Offer set files for closed assembly shifts with authoritative, conflict-free composition. Verify counts, CSV quoting, GS preservation, and XLSX opening.
- [ ] Verify actual insertion in 1С:УНФ on a separate acceptance run.

### Task 5: Review and pull request

- [ ] Review the integrated diff and run the affected TypeScript, Rust and Android gates.
- [ ] Fetch the target branch and review the complete three-dot diff. Commit, push the task branch and open a PR.
