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

A DB-backed scenario named `runs one inventory continuously through preparation, two-station work,
correction, both production XML revisions, and completion` proves the requested operation as one
continuous tenant-authorized journey over one inventory. It creates that inventory through the
cabinet API, uploads all six status files (including five valid zero-result exports), fixes one
snapshot, starts the inventory, joins two distinct Station devices, records protected simple work
and eligible old-box-to-new-box repack work, observes a cross-device duplicate conflict, applies an
admin correction, leaves from both devices, and closes normally. The same inventory then traverses
the real production registry, result loader, and document runner for both approved XML formats.

The first document run is verified artifact by artifact and again from the downloaded ZIP: every
stored and archived byte stream is SHA-256 checked against artifact metadata, every complete
`manifest.json` entry is compared with that metadata, eligible repack content is present in the
appropriate aggregation/disaggregation XML, and the protected `MOVING_BY_UD` KM and old SSCC are
absent from both. The journey then reopens the same inventory, proves both first-run artifacts are
invalidated and no longer downloadable, closes at the next result revision, regenerates and fully
re-verifies both XML files and the new ZIP, records the individual and ZIP downloads, and completes
that revision.

The following table identifies what the continuous scenario proves directly. The adjacent suites
remain useful regression depth for branches and UI behavior, but are not used to assemble or
substitute for continuity of the acceptance journey.

| Journey stage                                                                                             | Direct continuous evidence in `inventory-documents.e2e.test.ts`                                                                   |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Create one-product repack inventory with line, inclusive dates, capacity-two product, and label template  | Real `POST /inventories`; returned draft inventory is retained for every later step                                               |
| Upload and select all six statuses, including valid zero-row results                                      | Six real multipart import requests; one three-row INTRODUCED file plus five exact no-results files                                |
| Freeze counts, parents, source dates, and immutable inputs                                                | Real snapshot request; six inputs and stored counts `introduced=3`, `protected=1`, `expected=2`, `packages=2`, `loose=1` asserted |
| Keep `MOVING_BY_UD` protected and outside expected/destructive groups                                     | Frozen code asserted as `protected=true`, `expected=false`; protected KM and parent old SSCC excluded from every generated XML    |
| Start and expose the frozen task to an assigned line                                                      | Real start request followed by joins from two separately paired Station devices                                                   |
| Perform simple and repack work across two devices, including a conflict                                   | Protected simple scan on device B; old-box open, eligible add, new-box close/print on A; duplicate protected scan conflicts on A  |
| Apply a correction, leave from both devices, and close                                                    | Real reprint correction, two successful leave requests, blocker-free close                                                        |
| Generate both production GISMT XML artifacts from eligible repack old/new data and exclude protected data | Production registry plus real result loader/runner; all stored/downloaded/archived bytes and full manifest metadata verified      |
| Reopen, invalidate, advance revision, close, regenerate, download, acknowledge, and complete              | Both first-run artifacts return 404 after reopen; the second run receives the same full verification before completion            |

The continuous snapshot selects six independently stored imports. Its introduced rows comprise an
eligible code in an old box, a protected `MOVING_BY_UD` code in a different old box, and an eligible
loose code, producing exactly two expected codes and one protected code. Empty APPLIED and the four
other empty status slots are accepted only through the exact known no-results marker. The journey
uses distinct authorized device identities and real PostgreSQL locks. Separate Station and admin
suites continue to cover broader offline, UI, capacity-20, audit, quarantine, and error branches.

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
