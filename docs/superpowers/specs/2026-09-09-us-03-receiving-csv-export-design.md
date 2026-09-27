# US-03 saved Receiving CSV export

**Status:** CSV-first direction and reversible text encoding approved in chat on
2026-09-09. Owner approved this written specification on 2026-09-25. Not implemented.

**Scope:** The Receiving output portion of INT-002, in `codex/us-mvp` only.
XLSX is a later stage. This is not the US-07/US-09 request-response package,
a supplier import template, or a mechanism for restoring business records.

Sources: [CLAR-04](../../us/development-clarifications.md),
[CR-03 and CR-04](../../us/p0-change-decision.md), and the
[approved import boundary](2026-09-08-us-03-receiving-csv-import-design.md).
The current saved-read and finalization schemas under
`packages/platform-contracts/src/traceability/` govern available data.

## Selected approach

Generate one bounded CSV for one explicitly selected saved Receiving revision.
Use reversible, visibly tagged text cells, with typed structured payloads inside
the CSV to preserve information that does not fit flat convenience columns.
This sacrifices ordinary spreadsheet appearance for exact, inspectable data.

Plain CSV with apostrophe-only protection is not selected: quoting does not
provide a universal spreadsheet-safety or save/reopen guarantee. XLSX can offer
better presentation but is a separate renderer and acceptance surface. Do not
defer the required CSV path while implementing it.

Reuse US saved-record reads and access boundaries. Add a pure codec, strict
record adapter, audited server generator and authenticated browser download.
Do not reuse Russian-product exporters without proving their contracts; do not
change them for this increment.

## Saved-state fidelity

- Export `ReceivingLiveRecord` version 2, including its exact identity, revision,
  draft version, lifecycle version, status, actor IDs and timestamps.
- Support original and amendment drafts, finalized and amended snapshots, and
  both void forms: cancelled draft content and voided finalized content.
- Preserve finalized snapshot versions 1, 2 and 3 without upgrading or projecting
  away fields. Retain descriptions, coverage, confirmation findings, receipt
  basis, document issuer snapshots and previous-line/lot bindings when present.
- Drafts contain saved IDs and inputs, not frozen descriptions. Do not hydrate
  current product, lot, source or document labels and present them as historical.
  Draft document rows contain the saved document ID only; finalized document
  rows contain the exact frozen document and issuer entry.
- No trimming, case folding, Unicode normalization, URL fetching, date conversion,
  unit conversion, decimal parsing, rounding or truncation. Use saved-read schemas,
  not input schemas with transformations.
- Preserve array order and distinguish an absent property, explicit null and an
  empty string. Do not infer original supplier CSV selectors or raw inputs that
  were never retained in the selected saved representation.
- Frozen line identity is `(eventId, lineNo)`. Mutable draft line identity is
  `(eventId, draftVersion, one-based array position)`. Do not invent a permanent
  row UUID or claim that a draft position survives editing. Export existing
  `previousLineNo` and `lotBinding` separately in their original payloads.

Exporting a superseded revision must not silently follow `currentEventId`.
Frozen content remains historical, while lifecycle metadata describes the
selected revision at the capture time. A later export may therefore have
different lifecycle metadata without changing its frozen business content.

## File contract v1

Format identifier: `markiro-receiving-export-v1`.
UTF-8 with exactly one initial BOM, comma delimiter, every cell double-quoted,
embedded quotes doubled, CRLF record endings and a final CRLF. No `sep=` line.
The first record contains these fixed English headers, in this order:

```text
format_version,row_type,event_id,revision,draft_version,lifecycle_version,status,content_kind,ordinal,product_id,lot_id,tlc,quantity,unit_of_measure,supplier_lot_reference,source_kind,source_location_id,source_reference_url,source_resolved_location_id,document_id,payload
```

Data records occur in this order:

1. Exactly one `record` row, even for an empty draft.
2. One `item` row per saved item, in saved order; at most 100.
3. One `document` row per saved document association, in saved order; at most 100.

The first eight columns repeat the selected record's format and identity on
every data row. `ordinal` is absent on the record row and one-based on item and
document rows. Item convenience columns are exact projections of the identically
named saved item fields, with snake-case header mapping. Source columns project
the corresponding physical or reference source properties. Document ID projects
the saved ID or frozen `document.documentId`. Inapplicable or missing properties
use `absent:`; a present null uses `null:`. No human-readable fallback labels.

The `payload` column provides lossless reconstruction:

- Record payload: `{ capturedAt, record }`, where `record` is the exact live
  record with `content.draft.items` and `content.draft.documentIds` removed for
  draft content, or `content.snapshot.items` and `content.snapshot.documents`
  removed for finalized content. All other properties remain unchanged.
- Item payload: the entire saved item, including optional properties when present.
- Draft document payload: the saved document ID string.
- Finalized document payload: the entire frozen `{ document, issuer }` entry.

The decoder restores the two removed arrays from ordered rows, validates the
complete saved-record contract and verifies every repeated/convenience column
against that record. Reject mismatches, duplicate/missing ordinals, extra rows,
unknown columns, unsupported versions and invalid payload shapes. Decoding has
no persistence or command side effects. It must never call the supplier importer.
Reject invalid UTF-8, a missing/extra BOM, malformed quoting, unexpected record
endings and extra blank records. Validate bounds before allocating parsed rows.

### Reversible cell encoding

Headers are the fixed keys above; every data cell uses one of these tags:

| Cell                             | Meaning                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `text:` followed by escaped text | Exact string; also the schema-defined textual representation of structural integers |
| `null:`                          | A present null value                                                                |
| `absent:`                        | No applicable property                                                              |
| `json:` followed by escaped JSON | Typed payload; permitted only in the payload column                                 |

Thus `00042` becomes `text:00042`, an empty string becomes `text:`, and the
literal string `null:` becomes `text:null:`. Formula-leading values remain
literal strings, for example `=1+1` becomes `text:=1+1`. Structural integers use
base-10 digits without leading zeros; quantities remain their saved strings.

For text and serialized JSON, escape backslash as `\\`, LF as `\n`, CR as `\r`
and TAB as `\t`; escape remaining Unicode Cc/Cf characters and U+2028/U+2029 as
lowercase `\uXXXX` UTF-16 code units (surrogate pairs for astral code points).
Escape lone surrogates the same way rather than losing them during UTF-8 encoding.
All other characters remain literal. Decode in one pass, accepting only these
canonical escapes; never recursively unescape or interpret decoded text as a
formula. A literal backslash followed by `n` remains distinct from an LF.

Serialize payload JSON deterministically: recursively sort object keys by UTF-16
code-unit order, preserve arrays and string values, and retain JSON types. Only
the finite, safe integers already allowed in the saved schema are numeric;
decimals stay strings. Missing object properties remain absent. Apply the cell
escape layer after JSON serialization and reverse it before JSON parsing.

Every encoded data cell starts with a safe ASCII tag. CSV quoting then protects
the actual separators and quotes; control characters cannot inject new records.
This contract guarantees round-trip of the original generated bytes, not of
arbitrary third-party spreadsheet edits or re-saves.

### Explicit output limits

Reject a cell exceeding 32,767 UTF-16 code units in its encoded, CSV-unquoted form,
an artifact exceeding 16 MiB including BOM, or more than 201 data rows. Evaluate
all limits before audit success and before sending any file bytes.

A large confirmation payload can exceed the cell limit even when the business
record is valid. Return a localized `export_value_too_large` error identifying
the row/column, not its sensitive contents. Do not truncate, split invisibly,
omit warnings or label the record invalid. A later renderer may support it;
this CSV increment must fail explicitly.

The cell bound is conservative; it does not establish application compatibility.
See [Microsoft's documented Excel limits](https://support.microsoft.com/en-us/excel/excel-specifications-and-limits)
and [OWASP's CSV injection guidance](https://owasp.org/www-community/attacks/CSV_Injection).
No universal Excel/LibreOffice save-and-reopen safety claim is made.

## Server boundary and audit

Add an authenticated US-only read endpoint:

```text
GET /traceability/receiving/:id/export.csv?expectedDraftVersion=N&expectedLifecycleVersion=N
```

Require both positive integer versions and reject unknown query fields. Reuse
session, MFA, profile and tenant-membership enforcement; reload membership inside
the transaction and require `traceability.export.read`. Existing owner/admin,
QA and auditor access remains unchanged. Receiving-write access alone does not
grant export access; an auditor does not need write permission to generate CSV.

Within one repeatable-read transaction: authorize, read the tenant-scoped exact
revision, compare expected versions, capture server time, validate and serialize
the complete bounded file, compute SHA-256 over its exact bytes and insert the
generation audit. Commit before responding. Missing/foreign records use existing
non-disclosing behavior; stale versions return 409 and require reload and a new
explicit export action. Concurrent changes after the transaction snapshot do not
invalidate its clearly identified capture; do not claim latest-at-response-time.

Audit action: `traceability.receiving.csv_generated`. Record tenant, actor,
selected event ID, revision, draft/lifecycle versions, status, content kind,
format version, capture time, item/document counts, byte count, SHA-256 and
request ID. Do not include record payloads or source URLs. Generation audit means
the server generated the bytes, not that the user received or opened them.
An audit/transaction failure returns no successful artifact.

No business writes, new export-run table, object storage, background jobs or
business-command idempotency protocol. Explicit retries may create another
generation audit; they must not create or modify Receiving records. No prefetch
or automatic background generation.

Return `text/csv; charset=utf-8`, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, attachment disposition, and an
`X-Markiro-Export-SHA256` header. Filename uses only the validated event UUID and
numeric revision/version identifiers. Configure the existing US CORS allowlist
to expose only the required download metadata headers if cross-origin access
requires it; do not broaden allowed origins.

## Browser behavior

Show **Export CSV** only with export-read capability and a loaded saved record.
Unsaved changes require saving or discarding before export; never imply that
unsaved form state was exported. The action binds the displayed event ID and
both saved versions. Block duplicate clicks while pending.

Before creating a download, bound and validate the response: MIME type, digest,
strict CSV decoder, selected ID and both versions. Download the received original
bytes, not a re-serialized browser copy. Use a temporary object URL and revoke it;
do not store payloads in localStorage, IndexedDB or a service-worker cache.

On stale state offer reload, not silent export of another version. Network,
authorization, integrity and size failures are visible and require an explicit
retry. Discard an in-flight result after session/tenant/record-context change.
EN/ES guidance explains the `text:` notation and that this file is a saved-record
export, not the supplier upload template. Existing themes and layout remain.

## Verification and delivery boundaries

Use focused failing tests before implementation, then package gates and the
isolated synthetic US browser/database harness:

- Codec: prefix collisions, null/absent/empty distinctions, controls, backslashes,
  Unicode and lone surrogates, quotes, delimiters, formula-leading/fullwidth
  strings, leading zeros, date-like strings, large identifiers and exact decimal
  strings; boundary and over-limit cells/files; deterministic bytes and digest.
- Adapter: complete reconstruction of original/amendment drafts and V1/V2/V3
  snapshots, both void forms, zero/100 items, ordered documents and null issuers;
  preserve every available field and reject unknown versions or column tampering.
- Server: each allowed/denied role, MFA/profile enforcement, foreign tenant,
  stale versions, superseded revision selection, frozen-source stability, exact
  audit fields, rollback on audit failure and no business-record mutation.
- Browser: parse the actual downloaded bytes and verify identity/hash, dirty-form
  blocking, pending state, explicit retry, context-change discard, EN/ES and
  responsive light/dark layouts. DOM tests alone are not visual confirmation.
- Excel/LibreOffice opening and save/reopen behavior are separate manual checks
  on named application versions. If unavailable, report them as not performed;
  unit tests do not substitute for spreadsheet application evidence.

Implementation proceeds inline sequentially after written-spec approval. Keep
the US branch isolated. This specification authorizes no commit, push, PR,
merge, release, deployment, workflow dispatch or infrastructure provisioning.
