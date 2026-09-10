# Platform operational report exports

Approved direction: generate operational reports in SaaS admin without production SQL access.

## Scope

Five templates: `shifts`, `shift_operators`, `inventories`, `summary`, `commerceml`.
Durable background generation, private downloadable ZIP containing CSV and a metadata/definitions JSON file, history, retry by creating a new request with the same parameters. No raw SQL interface, raw code/badge/PIN export, or historical CommerceML archive reconstruction.

Explicitly select 1–10 tenants. Inclusive local calendar dates (`fromDate`, `toDate`), IANA `timezone`, maximum 366 days. `periodBasis=events` means events inside that local period; `production_date` is allowed only for shifts/shift_operators and includes all facts of shifts whose production date is in range. Record the precise selection and source snapshot time in every artifact.

Report-appropriate optional filters: lineId, productId, gtin14, operatorId, status; CommerceML outcome. Reject irrelevant filters rather than silently ignoring them. IDs must belong to a selected tenant. Do not load credentials to build filter lists. Snapshot identity names describe current names at generation time, not asserted historical names.

## Privacy and permissions

`identified` includes employee name/ID, `pseudonymous` replaces these with export-local operator labels, `aggregate` removes person-level rows and person-level timestamps. Pseudonymous and aggregate operational reports are not a guarantee of legal anonymization: production identifiers can still permit inference. Badges, PINs, raw scan codes, auth values and integration credentials are excluded in every mode. CommerceML uses an allowlisted projection; do not pass arbitrary JSON/free text through a regex-only scrubber.

New capabilities: reports.read, reports.create, reports.download, reports.identified. Initially grant all four only to platform_admin (deny-by-default); do not expand support/accountant access to production data implicitly. Recheck active platform identity/capabilities at API and download boundaries. Store creator in platform_users namespace. Audit create/download/failure with actor, tenant selection, target and result, no artifact payload. History is creator-scoped.

## Facts and definitions

- Shift number uses immutable month key/sequence plus /S for station, without sequence truncation.
- Accepted unit scans are scan_events verdict=ok; rejected duplicate/wrong_gtin/invalid counts are independent facts. No multiplication when joining scans and boxes.
- Boxes formed have closed_at. SSCC assigned means SSCC-bearing closed boxes, not reserved offline SSCC pools.
- Print confirmation means print_verified_at; reprint requests mean box_exceptions kind=reprint, not physically confirmed labels. Disassembled boxes use disassembled_at, not attempted exception rows.
- Conflicts come from code_conflicts. Inventory duplicate events and per-code claim outcomes are separate measures.
- Shift/operator first/last event span scan time and box opened/closed time; unknown operator is retained without guessing. No badge joins.
- Inventories include active snapshot expected counts, current code-result classifications and selected-period scan/repack facts; distinguish current snapshot values from interval events. Do not claim event-time reconstructions for projections.
- CommerceML journal includes session and event outcomes/timestamps/direction/grain and safe structured error categories. Current temporary-upload presence is not proof a historical file was retained. Missing data is null/unavailable, not inferred zero.

## Durability and resource limits

DB report intent + tenant links, pg-boss scheduling/reconciliation, fenced leases and bounded retries. A crash between intent commit and queue send must recover. Use a read-only repeatable-read transaction for report source data, statement timeout and explicit row/byte limits; never silently truncate. Publish only verified private objects. Download links expire in at most 300 seconds and never outlive the report. Files expire after 7 days; cleanup retries deletion, including failed-attempt objects. No production connection for development/tests.

## Acceptance

Tests cover strict filters, tenant mismatch, platform authorization, metrics without row multiplication, unknown operators, privacy bytes and CSV formula protection, queue failure/restart/lease fencing, download expiry, all five templates, and UI form/history/download/retry. Tests with a local database are separate from live production/1C/S3 acceptance.
