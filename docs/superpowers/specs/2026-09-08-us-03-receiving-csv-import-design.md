# US-03 fixed-template Receiving CSV import

**Status:** Product boundary and this written technical specification approved
in chat on 2026-09-08. Implementation checkpoints are recorded in the
[input foundation plan](../plans/2026-09-08-us-03-receiving-csv-input.md).

**Scope:** INT-002 import path in the isolated `codex/us-mvp` worktree. Receiving
CSV export remains a required, separately specified P0 deliverable; this import
increment cannot close INT-002 or US-03 by itself.

## Approved product boundary

- One file creates one new original receiving draft, with at most 100 lines.
- Match a product by exact GTIN or Markiro product ID, and a location by Markiro
  location ID. Never infer identity from names, create reference data, or use
  the historical fallback to external reference/location code/GLN.
- Represent both physical and reference TLC sources and the existing
  receipt-specific exempt-supplier fields.
- Preview creates no business records. Any blocking file/row error prevents
  the entire application. Creation is atomic and never silently drops rows.
- Same operation/content retries return the original result. A new explicit
  operation may represent a separate delivery with identical file bytes.
- Import does not finalize, approve exemptions, assign lots, change balances,
  correct existing receipts or modify current lot identities.

Sources: [CR-04](../../us/p0-change-decision.md#cr-04-operation-identity-not-file-identity),
[CLAR-04](../../us/development-clarifications.md#clar-04-bounded-csv-capability),
the current `receivingDraftSchema`, `receivingDraftItemSchema`,
`traceabilityLotSourceSchema` and `receivingExemptReceiptSchema` under
`packages/platform-contracts/src/traceability/`.

## Architecture and alternatives

Use a bounded parser in `@markiro/domain`, a strict draft adapter in
`@markiro/platform-contracts`, and a tenant-scoped import service in the existing
US Receiving module. Persist preview metadata separately from business records.
On confirmed apply, reuse the existing transactional draft-creation primitives
inside one transaction with the import result and audit.

A browser-only parser followed by the ordinary create endpoint is insufficient:
the server could not prove preview identity, raw-file digest or atomic import
audit. A generic mapping/import engine introduces deferred REC-007/INT-003 scope.
Neither alternative is selected. Do not call the public create endpoint from
inside the import service or nest its existing top-level transaction.

## Supplier template v1

The transport supplies `templateVersion: "markiro-receiving-v1"` separately from
the file. The downloadable template has exactly these English column keys, in
this order; UI explanations are localized to EN/ES:

```text
product_id,product_gtin,lot_link_mode,lot_id,tlc,source_kind,source_location_id,source_reference_url,source_resolved_location_id,quantity,unit_of_measure,exempt_supplier,exempt_reason,exempt_evidence_url,exempt_tlc_handling,proposed_tlc,supplier_lot_reference,notes
```

UTF-8 only, with an optional single leading BOM; comma separator, double-quote
escaping by doubling quotes, LF or CRLF record endings. Embedded comma, quotes
and line endings are allowed only in quoted fields and remain literal data.
Never guess encoding, delimiter, header aliases or decimal locale. Reject
invalid UTF-8, NUL, malformed quoting, bare CR, duplicate/unknown/missing/reordered
columns, zero data records and more than 100 data records. A terminal record
newline is allowed; an extra blank record is a visible row error, not ignored.
Maximum original file size is 256 KiB, checked before parsing. Do not truncate.

Return logical data-row number and original physical start line for each row,
including multiline records. Structural errors that prevent trustworthy row
boundaries reject the file; field-count or field-value errors remain associated
with their explicit data row. A preview must never label a partially parsed file
as applicable.

### Field mapping

| CSV input                                                    | Existing receiving meaning                                                                                                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product_id` / `product_gtin`                                | Exactly one supplied selector; resolve to a tenant-owned active `productId`. GTIN uses current validated canonical GTIN-14 comparison, retaining the supplied spelling in preview. No name fallback. |
| `lot_link_mode`                                              | Explicit `create_on_finalize` or `link_existing`. No inferred default.                                                                                                                               |
| `lot_id`                                                     | Required for `link_existing`, empty for `create_on_finalize`; active tenant-owned lot.                                                                                                               |
| `tlc`                                                        | Received TLC, distinct from an exempt own-assignment proposal.                                                                                                                                       |
| `source_kind`                                                | Empty, `location` or `reference`. Empty requires all four source-detail columns to be empty.                                                                                                         |
| `source_location_id`                                         | Required only for `location`; reference URL/resolved-location cells must then be empty.                                                                                                              |
| `source_reference_url`, `source_resolved_location_id`        | Both required for `reference`, whose `referenceKind` is `web_url`; physical-location cell must be empty. Never fetch the URL.                                                                        |
| `quantity`, `unit_of_measure`                                | Existing exact decimal-string and closed UOM contracts; no rounding, exponent conversion or unit conversion.                                                                                         |
| `exempt_supplier`                                            | Explicit literal `true` or `false`, not locale-specific labels or truthy coercion.                                                                                                                   |
| `exempt_reason`                                              | Existing receipt-level rationale field.                                                                                                                                                              |
| `exempt_evidence_url`, `exempt_tlc_handling`, `proposed_tlc` | Existing nullable `exemptReceipt` fields; handling is empty, `preserve_existing` or `assign_if_missing`. No automatic review/assignment.                                                             |
| `supplier_lot_reference`, `notes`                            | Existing nullable text fields.                                                                                                                                                                       |

An empty nullable cell becomes null, not numeric zero or a guessed value. The
adapter otherwise uses the existing receiving input contracts, including their
length, Unicode, TLC and URL rules. Preserve raw cells alongside proposed saved
values and explicitly show any normalization performed by those contracts;
silent trimming of opaque file values is not a CSV parser responsibility.
Do not erase exemption input simply because its checkbox is false; retain the
same hidden-input behavior as the current editor.

Product selector, link mode and boolean are template requirements. Other missing
values permitted by the current draft model remain visible as draft-only
findings; they do not become fabricated values. Preview eligibility means
"can create a draft", never readiness, regulatory applicability or export
eligibility. Existing saved-data check and QA finalization remain authoritative
for product/source/lot consistency and completeness.

Date received, receiving location, previous source, receiving note, overall notes
and ordered document links are entered through the existing header controls.
Their nullability and limits stay those of `receivingDraftSchema`. Import does
not create a reference document from a filename or a free-text document number.

## Preview and confirmation

The UI uses a grouped sequence within Receiving: select template/file and common
header, inspect rows and findings, then explicitly create the draft. Preview rows
are read-only. Correct the file and preview again; edit the resulting draft
through the current editor only after successful creation.

Suggested US-only routes are `POST /traceability/receiving/imports/preview`,
`GET /traceability/receiving/imports/:id`, and
`POST /traceability/receiving/imports/:id/apply`. They are design, not registered
routes. All require real US session/MFA, current membership/profile and current
Receiving-write capability; no new role grant. The read exposes only tenant-owned
import context to a Receiving writer. Missing and cross-tenant references must
not reveal another tenant's labels or identifiers.

Preview payload contains the version, original file bytes encoded as canonical
base64, and common header. Base64 preserves exact BOM/line-ending/file-hash
identity without introducing multipart infrastructure. Reject noncanonical or
oversized base64 before decoding. Limit only the new preview route to a 512 KiB
JSON body, with a 256 KiB decoded-file cap and existing bounded header schema.
Do not widen other route/body limits. Filename, if supplied for presentation,
is bounded metadata, never a filesystem path or operation identity.

The server parses, resolves tenant-owned references and persists a preview run
with original bytes, SHA-256, version, original header, proposed draft, resolved
IDs, per-row findings, actor, timestamps and a 24-hour apply expiry. Persisted
preview data is access-controlled import context, not a receiving event/lot.
Do not log raw files, cells or URLs. Do not introduce automatic expiry deletion.

Confirmation sends the selected preview ID, expected preview digest and one
operation UUID. Before its first successful application the server reloads
authorization, locks the preview, checks expiry and validates all references
again. If the approved normalized draft or resolution changed, reject as stale
and require a new preview; never silently retarget a GTIN or source. Archive,
role, profile and reference failures create no partial business data.

## Atomicity, retry and audit

Command identity is `(tenantId, "receiving.csv.apply", operationKey)`.
Its SHA-256 input digest covers the template version, original file SHA-256,
common header and approved normalized draft, with deterministic serialization.
Preview ID, filename, expiry and timestamps are not content identity. File hash
is not unique: identical bytes can belong to another explicit delivery.

Serialize concurrent commands through the established operation-lock pattern.
After reloading current authorization, check a remembered command before
first-application validation: a successful retry can still return its immutable
receipt after preview expiry or later edits/finalization. Changed content with
the same key conflicts. Applied preview with a different operation key returns
its existing result rather than creating another draft; another delivery must
start a new preview. No automatic resubmission after page reload/session loss.

First successful application commits the new receiving root/header/items/document
links, operation receipt, applied-preview/result link and exact audit in one
transaction. Extract a narrow transaction-level creation helper from the current
Receiving implementation, preserving existing endpoint behavior and tests.
Reuse current server-owned numbering, UUIDs, captured timezone and actor rules.
Never accept an event ID, tenant, actor, status or review decision from CSV.

Record the existing draft-created audit and a separate import-applied audit,
including tenant, actor, request, import run, event ID, file hash, template,
row count and input digest. A retry appends neither audit again. Preview audit
contains run/hash/count metadata only. A rejected apply must leave receiving,
lot, successful-operation and successful-application audit state unchanged;
existing security denial logging remains distinct from business audit.

After success, the client validates command/key/digest/event identity and reads
the current receiving record. The immutable operation receipt is not a promise
that the resulting event is still a draft. Unknown delivery outcomes retain the
same captured command only in the mounted authenticated flow for explicit retry.

## Boundaries for the matching P0 CSV output

Receiving-record CSV output remains mandatory before INT-002 is complete, but
is not implemented by the parser or by returning the supplier file. Its separate
artifact design must cover draft/finalized/amended/void state, stable event/row
identities, missing values, leading zeros, exact decimal/date/UOM values,
structured sources, exemption inputs and frozen historical values. A downloaded
record must never become an instruction to recreate historical lifecycle state.

CSV quoting alone is not a spreadsheet-safety policy. OWASP documents formula
injection risks and limitations of quote/escape handling after spreadsheet
save/reopen, with no universal sanitizer for every consumer:
[OWASP CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection).
Before implementing output, approve and test an explicitly versioned reversible
text-encoding policy or an explicit safe failure for unsupported values. Never
silently alter TLCs, strip formula-leading characters or reuse the RU exporter
without a compatibility check. No claim of spreadsheet compatibility is made
by this import specification.

## Implementation boundaries and verification

1. **Pure input foundation:** bounded CSV decoder/template in
   `packages/domain/src/traceability/receiving-csv.ts`; strict mapping in
   `packages/platform-contracts/src/traceability/receiving-csv.ts`. TDD covers
   quoting, multiline row locations, BOM/UTF-8, exact limits, empty records,
   header failures, raw/normalized values, typed sources, exemptions and errors.
   No persistence, endpoint, UI or export is part of that first checkpoint.
2. **Preview/apply service:** additive US-only schema/migration and store/HTTP
   tests using owned disposable US databases. Test exact actor/tenant/audit,
   cross-tenant/role denial, invalid-file zero business writes, expired/stale
   preview, concurrent same-key application, changed-content conflict,
   successful retry after lifecycle changes and a new delivery with identical
   file bytes. Rebuild DB before consumer tests. Do not migrate the base DB.
3. **Connected UI:** EN/ES preview/confirmation/errors and current-record recovery,
   with real HTTP/browser proof, lost-response retry, no duplicate creation,
   role/session loss, keyboard and 1440/1024/390 light/dark checks. Add only exact
   reviewed proxy routes; keep release-isolation contracts passing.
4. **CSV output:** separate reviewed artifact contract and spreadsheet/round-trip
   evidence, then reconcile requirements and acceptance for all of INT-002.

For each code checkpoint, use a focused failing test first, then package tests,
typecheck, lint, build and affected consumer tests; retain exact skip/infrastructure
limits. Current five dirty lifecycle-browser/doc files are prior local work and
must be preserved. No commit/push, primary-checkout change, new dependency,
hosted resource, workflow enablement, release or deployment is authorized by
this document. Continue inline sequentially under the owner's selected workflow.

## Self-review

The historical product-name/external-ref and location-code/GLN fallbacks are
explicitly superseded. The design maps to current typed source/exemption fields,
keeps preview applicability separate from finalization, distinguishes operation
identity from file identity, and does not claim CSV output or MVP completion.
The owner subsequently approved this written specification, including the
dialect/transport/preview lifetime and draft-only missing-value boundaries.
