# Inventory Operational Documents — Design Specification

**Date:** 2026-08-27

**Status:** Approved for implementation planning

**Scope:** Complete the v1 inventory result package with the proven aggregation XML and
deterministic TXT/CSV operational reports. External submission to Chestny ZNAK remains outside
this scope.

## Outcome

A tenant administrator can select any supported final documents on a closed inventory, generate
them as one atomic run, download each artifact separately, or download the complete deterministic
ZIP. The catalog grows without hard-coded document choices in Admin.

The aggregation XML must be byte-equivalent to the XML already used by production shift exports.
That renderer is the accepted interoperability proof: this exact structure has been uploaded to
the external system successfully. Inventory and shift flows keep separate selection rules and
filenames, but share the low-level serializer so the XML contract cannot drift.

## Confirmed product decisions

- Inventory documents are files for download only; v1 does not submit them through an API.
- `MOVING_BY_UD` is protected. Such codes must never enter current-stock, write-off,
  aggregation, disaggregation, box, or balance outputs.
- A document run consumes one closed, frozen `resultRevision` under the existing tenant boundary.
- The administrator chooses formats with checkboxes. Existing individual and ZIP downloads stay.
- Empty TXT/CSV reports are valid artifacts. An XML without an applicable operation fails closed.
- Aggregation switches to a new version of the existing format id. Existing v1 runs remain
  byte-stable and retryable but v1 is not offered for new runs.
- Disaggregation remains at its existing v1 contract.
- No XLSX is added in this slice.

## Architecture

### Shared serializer, separate adapters

`@markiro/domain` gains small deterministic primitives for:

1. validating and formatting a box SSCC as the 20-digit `00`-prefixed value;
2. reducing a canonical KM to the GISMT identification code
   `01<gtin14>21<serial>` by removing the crypto tail;
3. rendering one GISMT `unit_pack` aggregation XML document;
4. encoding line-oriented UTF-8 TXT and semicolon-delimited UTF-8 CSV.

The shift export adapter continues to own shift source selection, line-limit splitting, metrics,
and shift filenames. The inventory adapter continues to own closed-result selection, final-box
eligibility, metrics, and inventory filenames. Neither flow calls the other's high-level runner.
Both aggregation adapters call the same low-level XML serializer.

The shared aggregation serializer emits exactly:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<unit_pack>
    <Document>
        <organisation>
            <id_info>
                <LP_info LP_TIN="..." />
            </id_info>
        </organisation>
        <pack_content>
            <pack_code>00...</pack_code>
            <cis>01...21...</cis>
        </pack_content>
    </Document>
</unit_pack>
```

Indentation, element order, LF line endings, escaping, and the final LF are part of the contract.
The inventory v2 renderer must not add `document_id`, `VerForm`, timestamps, document number,
`action_id`, `version`, or `org_name` because the proven shift XML does not contain them.

### Registry and version compatibility

The registry is keyed by `(formatId, formatVersion)`, not only `formatId`. It exposes two distinct
operations:

- catalog resolution for a new run, which accepts only the current advertised descriptor;
- execution resolution for a frozen run, which also accepts a registered hidden legacy version.

Duplicate `(id, version)` registrations fail startup. At most one advertised version may exist for
an id. A request for a known but non-current version is rejected as superseded, while a queued or
retried historical run continues to resolve its exact registered generator.

`inventory_xml_gismt_aggregation@1` and its current metadata-rich serializer remain registered as
hidden legacy behavior. `inventory_xml_gismt_aggregation@2` is advertised and uses the common
proven serializer. Stored selections and artifact metadata already contain id and version, so
format versioning needs no data rewrite.

## Production catalog

| Format id                                   | Version | Admin label                             | Artifact | Source                                          | Empty result |
| ------------------------------------------- | ------: | --------------------------------------- | -------- | ----------------------------------------------- | ------------ |
| `inventory_xml_gismt_aggregation`           |       2 | `[XML][ГИСМТ] Формирование упаковки`    | XML      | eligible final new boxes                        | fail         |
| `inventory_xml_gismt_disaggregation`        |       1 | `[XML][ГИСМТ] Расформирование упаковки` | XML      | eligible old-box contexts                       | fail         |
| `inventory_txt_write_off`                   |       1 | `[TXT] Коды к списанию`                 | TXT      | write-off candidates                            | zero bytes   |
| `inventory_csv_write_off`                   |       1 | `[CSV] Коды к списанию`                 | CSV      | write-off candidates                            | header only  |
| `inventory_csv_current_stock`               |       1 | `[CSV] Коды на учёт`                    | CSV      | verified current codes                          | header only  |
| `inventory_csv_final_box_contents`          |       1 | `[CSV] Состав итоговых коробов`         | CSV      | eligible final new boxes and their codes        | header only  |
| `inventory_txt_final_boxes`                 |       1 | `[TXT] Номера итоговых коробов`         | TXT      | eligible final new boxes                        | zero bytes   |
| `inventory_csv_balances_by_production_date` |       1 | `[CSV] Остатки по датам производства`   | CSV      | verified current codes and eligible final boxes | header only  |

The exact Russian labels may be reused directly from this table in the server catalog. Admin must
render the returned label, extension, and version and must not add a second local format list.

## Result selection rules

### Verified current codes

For these reports, `verified` means a current, non-voided result classified as `expected`. The
source service already derives this set from expected snapshot rows that were found and whose
current classification is `expected`.

The following never enter a new operational document:

- write-off candidates;
- protected codes, including every `MOVING_BY_UD` code;
- ineligible or unknown codes;
- voided results.

An invalid, open, failed, or otherwise ineligible new box is excluded from box-derived outputs.
Its independently verified codes still belong in current-stock and code balance reports; they do
not disappear merely because the packaging operation is unusable.

`observedDateGroups` currently mixes verified, protected, ineligible, and unknown found codes.
The balances generator must not use that aggregate. It groups `verified` directly and fails if any
verified code has no valid `observedProductionDate`.

### Write-off candidates

Write-off TXT and CSV contain the source service's frozen `writeOffCandidates`: expected
inventory codes not found at close. Protected `MOVING_BY_UD` codes are excluded upstream and are
also denied defensively by the document selection boundary.

### Eligible final boxes

A final new box is eligible only when all of these are true:

- state is `closed`;
- print state is `printed`;
- it contains at least one active item;
- every item resolves to a current verified code;
- no item is protected, ineligible, unknown, voided, missing, or duplicated;
- the box production date is valid and every contained code has that same observed production
  date.

Open, empty, invalidated, partially verified, print-pending, print-failed, and problem boxes are
excluded. The selection is a shared inventory-domain function used by aggregation, box contents,
box numbers, disaggregation context, and balance counts so the formats cannot disagree.

Disaggregation continues to use the old SSCC contexts associated with eligible final boxes,
deduplicated and sorted, after excluding any parent connected to a protected code.

## Byte contracts

All ordering is deterministic and locale-independent. Codes sort by canonical raw bytes after
normalization; boxes sort by normalized 18-digit SSCC before output formatting; balance rows sort
by ISO production date ascending. Duplicate output values are rejected or deduplicated only where
the format explicitly describes a set.

### Codes

TXT and CSV code reports contain the full canonical raw KM, including the GS (`0x1D`) and crypto
tail. They do not use the shortened XML `<cis>` representation.

- TXT is UTF-8 without BOM, one code per line, LF endings, and a final LF when non-empty.
- Empty TXT is exactly zero bytes.
- CSV is UTF-8 with BOM, semicolon delimiter, CRLF endings, and a final CRLF.
- The write-off and current-stock CSV header is `code`.
- An empty CSV is BOM plus `code\r\n`.
- CSV fields use standard double-quote escaping when required. Values remain exact canonical
  identities. KM rows begin with AI `01`, while SSCC, ISO dates, and counts are digit-led, so the
  validated output fields cannot become spreadsheet formulas.

### Final boxes

- `inventory_csv_final_box_contents` header is `box_sscc;code`.
- Each row contains the 20-digit `00`-prefixed SSCC and the full canonical raw KM.
- Empty box-contents CSV is BOM plus `box_sscc;code\r\n`.
- `inventory_txt_final_boxes` contains one 20-digit SSCC per LF-terminated line and no header.
- Empty final-box TXT is exactly zero bytes.

### Balances by production date

The header is `production_date;code_count;box_count`.

- `code_count` counts only verified current codes by `observedProductionDate`.
- `box_count` counts only eligible final boxes by their frozen box production date.
- A date present in either side produces one row; the missing count is `0`.
- Counts are non-negative safe integers serialized in base 10.
- If any verified code has no valid observed production date, generation fails with
  `VERIFIED_PRODUCTION_DATE_MISSING` instead of silently omitting the code.
- Empty balances CSV is BOM plus `production_date;code_count;box_count\r\n`.

### XML

Aggregation v2 validates the tenant INN, validates every SSCC and CIS, strips the KM crypto tail,
and emits one unsplit XML artifact through the common serializer. Given identical ordered boxes
and INN, its bytes must equal `shift_xml_gismt_aggregation@1` exactly.

Disaggregation v1 is unchanged. Both XML formats return `EMPTY_SOURCE` when there is no applicable
operation; they do not generate an empty XML shell.

## Filenames and artifact metadata

Every new inventory filename uses the existing sanitized `inventory-<number>` prefix followed by
a stable ASCII suffix:

- `-aggregation.xml`
- `-disaggregation.xml`
- `-write-off.txt`
- `-write-off.csv`
- `-current-stock.csv`
- `-final-box-contents.csv`
- `-final-boxes.txt`
- `-balances-by-production-date.csv`

Each generator reports exact `rowCount`, `codeCount`, and `boxCount`. A header-only CSV has
`rowCount = 1`; a zero-byte TXT has all three counts at zero. For balances, `rowCount` includes the
header, `codeCount` is the sum represented in `code_count`, and `boxCount` is the sum represented
in `box_count`.

The runner normally rejects zero-byte artifacts. It may accept one only when the registered
generator explicitly declares that its empty TXT is valid and all reported counts are zero.

The applied artifact schema currently enforces `byte_size > 0`. Add a new forward-only migration
that replaces only this check with `byte_size >= 0`, and update the Drizzle schema, API DTO,
OpenAPI, and Admin response parser to accept non-negative sizes. Do not rewrite the applied
inventory document migration. Existing positive-size rows remain valid and require no backfill.

## Run, ZIP, and error behavior

The existing all-or-nothing render boundary remains:

1. resolve every exact selected generator version;
2. load one repeatable-read frozen result source;
3. render and validate every selected artifact before upload;
4. upload verified bytes;
5. publish all artifact rows and the ready run transactionally.

If a selected XML is inapplicable, the whole run fails and no partial package is published. Empty
tabular reports do not fail the run. Existing retry, lease, cleanup, ambiguous-publication
recovery, revision revalidation, invalidation, tenant scoping, and audit behavior stay unchanged.

The deterministic ZIP contract is frozen as internal `schemaVersion: 1`: normalized collision
checks, artifact sort order, fixed timestamps, per-artifact SHA-256, byte counts, metrics, format
id/version, part number, and `manifest.json` layout remain byte-stable. Zero-byte TXT artifacts are
valid ZIP entries with the SHA-256 of empty bytes. No signing or encryption is added.

Safe domain failures gain precise mappings for the new validation cases, including
`VERIFIED_PRODUCTION_DATE_MISSING`; raw KMs, SSCCs, and storage details never enter returned errors
or audit metadata. Infrastructure failures retain the existing retry behavior.

## API and Admin changes

- `GET /inventory-document-formats` advertises the eight current rows in the catalog table and
  never advertises aggregation v1.
- The catalog DTO, OpenAPI schema, Admin response schema, and selection request continue to carry
  exact id/version pairs and the declared MIME types.
- Creation rejects hidden legacy and stale versions. Execution and retry of an already stored run
  resolve its exact historical version.
- The existing `InventoryDocuments` screen remains catalog-driven. It displays the added
  checkboxes and preserves separate artifact download, full ZIP download, retry state, prior
  revision history, and completion acknowledgement.
- Admin adds localized messages for new safe generation errors. There is no new route or bespoke
  form for a particular format.

## Verification

### Domain

- Golden byte equality between aggregation v2 and `shift_xml_gismt_aggregation@1` for the same
  INN and ordered boxes.
- A regression fixture for the exact proven XML structure, indentation, escaping, crypto-tail
  removal, `00` SSCC formatting, LF endings, and final LF.
- Exact TXT/CSV bytes, BOM, CRLF/LF, final newline, GS `0x1D`, quoting, sorting, counts, and empty
  artifacts.
- Final-box eligibility across every excluded state and protected/problem membership.
- Balance grouping across code-only, box-only, and shared dates, plus fail-closed missing date.
- Registry tests for current selection, hidden legacy execution, duplicate `(id, version)`, and
  duplicate advertised id.

### API

- Production catalog returns the eight advertised formats and omits aggregation v1.
- A frozen legacy aggregation v1 run still executes and rerenders byte-identically.
- Closed-revision source selection, tenant denial, `MOVING_BY_UD` exclusion, stale revision,
  atomic XML failure, valid empty tabular artifacts, upload verification, audit, retry, and
  regeneration are covered.
- ZIP and manifest receive a golden test that includes a zero-byte file and freezes schema v1.
- Connected acceptance uses a disposable Postgres instance and real migrations; skipped database
  coverage is reported rather than treated as passing.

### Database

- Schema tests require the named non-negative artifact byte-size check and reject negative sizes.
- A migration test applies the forward migration after the legacy inventory document migrations,
  proves that a zero-byte artifact row is accepted, and proves that a negative row is rejected.
- `@markiro/db` is rebuilt before API tests so consumers do not execute stale compiled schema.

### Admin

- Catalog-provided formats render and can be selected without a local id list.
- Requests preserve exact id/version pairs.
- Individual and ZIP downloads, disabled states, retries, prior revisions, and localized errors
  remain covered.

Final gates are the focused domain/DB/API/Admin tests followed by package test, typecheck, lint,
and build for affected packages, `git diff --check`, and formatting verification. Because DB and
domain exports are consumed by API, `@markiro/db` and `@markiro/domain` are built before API tests.

## Out of scope and external acceptance

- Chestny ZNAK API polling, document submission, and live external acceptance.
- XLSX reports, signing, encryption, and a new archive schema.
- Standalone repacking, kiosk sale/write-off enforcement, or changes to shift workflows.
- Physical Windows Station, scanner, printer, label-stock, and multi-terminal customer acceptance.
- Real production object storage acceptance; automated storage tests use the established test
  boundary and must not be presented as proof of a live S3 installation.

The shared serializers and inventory selection functions are deliberately reusable, so later
standalone repacking can supply its own source adapter without copying the file contracts.
