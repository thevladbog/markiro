# Inventory admin automated acceptance

## Result

**PASS — implemented workflow and the two approved production XML formats.** The tenant-admin,
API, PostgreSQL, and Station test surfaces cover inventory creation and preparation, six Chestny
ZNAK status inputs, snapshot fixation, multi-device execution, reconciliation and corrections,
close/reopen, and the document lifecycle. A focused DB-backed acceptance now drives
`inventory_xml_gismt_aggregation` v1 and `inventory_xml_gismt_disaggregation` v1 through the real
production registry and API runner from a frozen closed result revision to verified private
artifacts, individual downloads, a checksummed ZIP manifest, reopen invalidation, regeneration,
and completion.

**NOT PASSED — complete-v1 document contract gate.** TXT, CSV, and XLSX inventory formats remain
unapproved and absent from the production descriptor and generator registries. The two approved
XML formats are real production outputs, but they do not justify a complete-v1 claim for the wider
planned document set. No missing tabular format is advertised, generated, or implied by this
acceptance result.

**NOT RUN — physical and external acceptance.** This run did not exercise a packaged Windows/Tauri
application, two physical terminals, a HID or serial scanner, a printer/driver, printed barcode or
label readability, touch or gloves, a customer operator, a live object-storage service, or any
Chestny ZNAK submission. Inventory v1 sends no document externally.

## Environment

- macOS host; Node `v24.18.0`; pnpm `11.22.0` from the local Corepack cache.
- Disposable PostgreSQL 16 container with fresh databases migrated through the repository journal.
  No shared or production database was used.
- Tests used repository CHZ CSV fixtures plus bounded synthetic rows constructed with the same
  verified 35-column contract. The production document acceptance used real PostgreSQL result
  rows and the production generator registry; object publication stayed at an in-memory private
  storage boundary so exact bytes, checksums, presigned paths, and ZIP contents could be inspected.
  Other document endpoint tests still use synthetic generators for failure and lifecycle branches.
- No tracked OpenAPI snapshot exists in the repository. OpenAPI was validated by the existing
  generated-document contract tests, so no public snapshot was created or hand-edited.

## Automated journey composition

A DB-backed scenario named `runs both approved GISMT XML formats through the closed-revision API
lifecycle and excludes MOVING_BY_UD` proves the production document lifecycle in one
tenant-authorized sequence. It creates a repack source with eligible and protected old/new boxes,
selects both production XML formats at closed revision 7, runs the actual result loader and runner,
recomputes each artifact checksum, exercises both individual downloads and the ZIP download,
verifies every `manifest.json` entry and archived byte stream, and proves that the protected KM and
its old/new SSCCs occur in neither XML. It then reopens, verifies both artifacts are invalidated and
revision 8 is established, closes, regenerates both formats with a new idempotency key, downloads
the new ZIP, and completes revision 8.

The entire inventory operation is not collapsed into that one test. It spans three trust and
persistence boundaries: cabinet session APIs, Station device/offline behavior, and asynchronous
document publication. Duplicating all established fixtures in one test would bypass or weaken those
boundaries. The following connected and UI suites form the rest of the reproducible journey, with
the test registry substitution confined to document tests.

| Journey stage                                                                                                                                                 | Evidence                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Create one-product inventory and configure line, inclusive dates, check/repack mode, and label template                                                       | `inventories.e2e.test.ts`, `inventory-preparation.test.tsx`                                                       |
| Upload and select all six statuses, including valid zero-row results                                                                                          | `inventory-chz-import.test.ts`, `inventory-snapshot.e2e.test.ts`                                                  |
| Freeze counts, parents, source dates, and immutable product/line/capacity facts                                                                               | `inventory-snapshot.e2e.test.ts`, `inventory-lifecycle.e2e.test.ts`                                               |
| Keep `MOVING_BY_UD` protected and outside expected/destructive groups                                                                                         | `inventory-snapshot.e2e.test.ts`, `inventory-reconciliation.e2e.test.ts`, `inventory-result-source.test.ts`       |
| Start and expose the frozen task to an assigned line; join/rejoin and cross-line barcode confirmation                                                         | `inventory-lifecycle.e2e.test.ts`, `station-inventory-access.e2e.test.ts`, `station-inventory-bundle.e2e.test.ts` |
| Synchronize two distinct devices, simple scans, known-box expansion, repack ownership/capacity/date, conflicts, and leave                                     | `station-inventory-sync.e2e.test.ts`, Station inventory work/outbox tests                                         |
| Apply an append-only correction with revision and audit protection                                                                                            | `inventory-corrections.e2e.test.ts`, `inventory-corrections.test.tsx`                                             |
| Evaluate blockers, leave, close, quarantine late work, and freeze a result revision                                                                           | `inventory-close.e2e.test.ts`, `inventory-late-events.e2e.test.ts`                                                |
| Generate both production GISMT XML artifacts from repack old/new boxes, exclude protected contents, verify SHA-256, ZIP manifest, and tenant-scoped downloads | Exact DB-backed `runs both approved GISMT XML formats…` scenario in `inventory-documents.e2e.test.ts`             |
| Reopen, invalidate both production artifacts, increment revision, close again, regenerate, download, acknowledge, and complete                                | The same production scenario plus the synthetic lifecycle regression in `inventory-documents.e2e.test.ts`         |

The connected snapshot fixture selects six independently stored imports. Its introduced rows include
an inclusive-range pair, an out-of-range row, and a `MOVING_BY_UD` row; the asserted result is two
expected codes and one protected code. Empty APPLIED and other empty slots are accepted only through
the exact known no-results marker. Multi-device tests use distinct authorized device identities and
real PostgreSQL locks. Repack UI tests separately prove 20 fixed positions, mandatory bottle scans,
automatic full-box closure/printing, and no “next box” button.

## Document contract gate

The production XML slice passes while the complete-v1 claim remains blocked by design:

- `INVENTORY_DOCUMENT_FORMATS` and the production generator registry contain exactly
  `inventory_xml_gismt_aggregation` v1 and `inventory_xml_gismt_disaggregation` v1;
- `GET /inventory-document-formats` advertises those two approved formats and no guessed TXT, CSV,
  or XLSX format;
- both XML generators have sanitized golden fixtures and available XSD validation, and both now
  traverse the production API runner and tested ZIP manifest;
- unknown, unavailable, and superseded id-version pairs remain rejected;
- completion requires a ready current-revision run whose selected artifacts are all present,
  non-invalidated, downloaded, and explicitly checked;
- reopen invalidates old-revision artifacts transactionally;
- synthetic CSV/ZIP bytes in other tests prove infrastructure branches only and are not promoted
  to production formats.

The wider gate can change to complete-v1 only after every required TXT, CSV, and XLSX format has an
approved sanitized golden fixture (and schema where applicable), an immutable descriptor version,
deterministic generator output, and an entry in the tested ZIP manifest. The unresolved contract
checklist is in `docs/contracts/inventory-documents/README.md`.

## Commands and results

```text
Production document API acceptance on disposable PostgreSQL:
inventory-documents.e2e.test.ts: 15 tests passed (focused production scenario: 1 passed)

Production document domain and runner regression suites:
inventory-documents.test.ts + inventory-document-generators.test.ts: 12 tests passed
inventory-document-runner.test.ts: 16 tests passed

@markiro/domain test / typecheck / lint / build:
30 files passed; 409 tests passed; all remaining gates passed

@markiro/db test / typecheck / lint / build on disposable PostgreSQL:
41 files passed; 258 tests passed; all remaining gates passed

@markiro/api test on a fresh disposable PostgreSQL database:
206 files total: 205 passed, 1 skipped; 2095 tests total: 2093 passed, 2 skipped
@markiro/api typecheck / lint / build: PASS

@markiro/admin test / typecheck / lint / build:
71 files passed; 752 tests passed; all remaining gates passed

@markiro/station test / typecheck / lint / build:
83 files passed; 1194 tests passed; all remaining gates passed
```

The two API skips are the environment-gated local Mailpit/MinIO lifecycle and the explicit
real-command local-infrastructure smoke. The full run used mocked storage at the inventory document
boundary and did not validate MinIO publication or mail delivery. Admin DOM/component tests passed,
but no live-browser or visual acceptance was run. Expected injected-failure logs, jsdom
canvas/navigation diagnostics, five inherited Admin hook lint warnings, and existing Vite
large-chunk warnings did not fail their gates.

## Remaining release acceptance

- Validate the two generated XML files by manual upload to the intended Chestny ZNAK/GIS MT portal;
  automated XSD and lifecycle evidence does not establish live portal acceptance.
- Approve each required TXT, CSV, and XLSX contract and sanitized golden output before enabling its
  production descriptor and generator; none is currently present or claimed.
- Validate private object-storage publication, presigned individual and ZIP download, reconciliation
  after ambiguous publication, retention, and cleanup against the deployment's actual S3-compatible
  service.
- Run the packaged Windows Station with two physical devices, scanner input, offline/reconnect and
  restart, printer setup, capacity-20 labels, barcode readability, touch/gloves, and a customer
  acceptance script. Record these results separately from automated browser/API evidence.
