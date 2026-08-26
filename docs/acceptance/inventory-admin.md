# Inventory admin automated acceptance

## Result

**PASS — implemented workflow and automated evidence.** The tenant-admin, API, PostgreSQL, and
Station test surfaces cover inventory creation and preparation, six Chestny ZNAK status inputs,
snapshot fixation, multi-device execution, reconciliation and corrections, close/reopen, and the
document job infrastructure. The focused connected journey passed 212 tests in 13 API files. The
full package gates also passed after one stale Station access fixture was updated to include all
facts now required by the frozen manifest contract.

**NOT PASSED — complete-v1 document contract gate.** There are no approved inventory XML/CSV/XLSX
fixtures or XSDs in the repository. The production descriptor and generator registries are
therefore intentionally empty. No production document can be selected or generated, and a real
inventory cannot currently reach `completed`; completion remains fail-closed until at least one
approved format is generated, downloaded, and acknowledged. Synthetic generators below are test
doubles only and are not production compatibility evidence.

**NOT RUN — physical and external acceptance.** This run did not exercise a packaged Windows/Tauri
application, two physical terminals, a HID or serial scanner, a printer/driver, printed barcode or
label readability, touch or gloves, a customer operator, a live object-storage service, or any
Chestny ZNAK submission. Inventory v1 sends no document externally.

## Environment

- macOS host; Node `v24.18.0`; pnpm `11.22.0` from the local Corepack cache.
- Disposable PostgreSQL 16 container with fresh databases migrated through the repository journal.
  No shared or production database was used.
- Tests used repository CHZ CSV fixtures plus bounded synthetic rows constructed with the same
  verified 35-column contract. Document tests injected synthetic generators and in-memory private
  storage; the production registries remained empty.
- No tracked OpenAPI snapshot exists in the repository. OpenAPI was validated by the existing
  generated-document contract tests, so no public snapshot was created or hand-edited.

## Automated journey composition

A DB-backed scenario named `regenerates and completes revision 8 after reopening invalidates
revision 7` now proves the complete document lifecycle in one tenant-authorized sequence. It creates
and processes a selected synthetic run at closed revision 7, downloads its artifact and ZIP,
reopens and verifies invalidation plus revision 8, closes again, creates a new-key revision-8 run,
processes and downloads it, acknowledges the documents, and observes completion at revision 8.

The entire inventory operation is not collapsed into that one test. It spans three trust and
persistence boundaries: cabinet session APIs, Station device/offline behavior, and asynchronous
document publication. Duplicating all established fixtures in one test would bypass or weaken those
boundaries. The following connected and UI suites form the rest of the reproducible journey, with
the test registry substitution confined to document tests.

| Journey stage                                                                                                             | Evidence                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Create one-product inventory and configure line, inclusive dates, check/repack mode, and label template                   | `inventories.e2e.test.ts`, `inventory-preparation.test.tsx`                                                       |
| Upload and select all six statuses, including valid zero-row results                                                      | `inventory-chz-import.test.ts`, `inventory-snapshot.e2e.test.ts`                                                  |
| Freeze counts, parents, source dates, and immutable product/line/capacity facts                                           | `inventory-snapshot.e2e.test.ts`, `inventory-lifecycle.e2e.test.ts`                                               |
| Keep `MOVING_BY_UD` protected and outside expected/destructive groups                                                     | `inventory-snapshot.e2e.test.ts`, `inventory-reconciliation.e2e.test.ts`, `inventory-result-source.test.ts`       |
| Start and expose the frozen task to an assigned line; join/rejoin and cross-line barcode confirmation                     | `inventory-lifecycle.e2e.test.ts`, `station-inventory-access.e2e.test.ts`, `station-inventory-bundle.e2e.test.ts` |
| Synchronize two distinct devices, simple scans, known-box expansion, repack ownership/capacity/date, conflicts, and leave | `station-inventory-sync.e2e.test.ts`, Station inventory work/outbox tests                                         |
| Apply an append-only correction with revision and audit protection                                                        | `inventory-corrections.e2e.test.ts`, `inventory-corrections.test.tsx`                                             |
| Evaluate blockers, leave, close, quarantine late work, and freeze a result revision                                       | `inventory-close.e2e.test.ts`, `inventory-late-events.e2e.test.ts`                                                |
| Generate selected synthetic artifacts, verify SHA-256, deterministic ZIP and manifest, and tenant-scoped downloads        | `inventory-document-runner.test.ts`, `inventory-documents.e2e.test.ts`                                            |
| Reopen, invalidate prior artifacts, increment revision, close again, regenerate, download, acknowledge, and complete      | Exact DB-backed `regenerates and completes revision 8…` scenario in `inventory-documents.e2e.test.ts`             |

The connected snapshot fixture selects six independently stored imports. Its introduced rows include
an inclusive-range pair, an out-of-range row, and a `MOVING_BY_UD` row; the asserted result is two
expected codes and one protected code. Empty APPLIED and other empty slots are accepted only through
the exact known no-results marker. Multi-device tests use distinct authorized device identities and
real PostgreSQL locks. Repack UI tests separately prove 20 fixed positions, mandatory bottle scans,
automatic full-box closure/printing, and no “next box” button.

## Document contract gate

The complete-v1 claim is blocked by design:

- `INVENTORY_DOCUMENT_FORMATS` is an immutable empty production catalog;
- the production generator registry contains no generators;
- `GET /inventory-document-formats` advertises no guessed format;
- unknown/unavailable id-version pairs are rejected;
- completion requires a ready current-revision run whose selected artifacts are all present,
  non-invalidated, downloaded, and explicitly checked;
- reopen invalidates old-revision artifacts transactionally;
- synthetic CSV/ZIP bytes prove job, checksum, archive, retry, and lifecycle mechanics only.

The gate can change to PASS only after every required production format has an approved sanitized
golden fixture (and XSD/schema where applicable), an immutable descriptor version, deterministic
generator output, and an entry in the tested ZIP manifest. The unresolved contract checklist is in
`docs/contracts/inventory-documents/README.md`.

## Commands and results

```text
Focused connected inventory API journey on disposable PostgreSQL:
13 files passed; 212 tests passed

@markiro/domain test / typecheck / lint / build:
29 files passed; 404 tests passed; all remaining gates passed

@markiro/db test / typecheck / lint / build on disposable PostgreSQL:
40 files passed; 256 tests passed; all remaining gates passed

@markiro/api test on a fresh disposable PostgreSQL database:
206 files total: 205 passed, 1 skipped; 2093 tests total: 2091 passed, 2 skipped
@markiro/api typecheck / lint / build: PASS

@markiro/admin test / typecheck / lint / build:
71 files passed; 752 tests passed; all remaining gates passed

@markiro/station test / typecheck / lint / build:
83 files passed; 1192 tests passed; all remaining gates passed
```

The two API skips are the environment-gated local Mailpit/MinIO lifecycle and the explicit
real-command local-infrastructure smoke. The full run used mocked storage at the inventory document
boundary and did not validate MinIO publication or mail delivery. Expected injected-failure logs,
jsdom canvas/navigation diagnostics, five pre-existing Admin hook lint warnings, and existing Vite
large-chunk warnings did not fail their gates.

During the full API gate, four Station task-access assertions first failed with the expected
fail-closed `409` because their handcrafted snapshot/manifest fixture lacked the now-authoritative
box capacity and nullable product metadata. The fixture was updated without changing production
code; its focused rerun passed 6/6, and the subsequent full API run passed on another fresh database.

## Remaining release acceptance

- Approve each required XML/tabular contract and sanitized golden output; then enable its production
  descriptor and generator and repeat the full close/generate/download/complete journey.
- Validate private object-storage publication, presigned individual and ZIP download, reconciliation
  after ambiguous publication, retention, and cleanup against the deployment's actual S3-compatible
  service.
- Run the packaged Windows Station with two physical devices, scanner input, offline/reconnect and
  restart, printer setup, capacity-20 labels, barcode readability, touch/gloves, and a customer
  acceptance script. Record these results separately from automated browser/API evidence.
