# Inventory document contract approval gate

Inventory result formats are a compliance boundary. A format is public only when its exact external
contract and a sanitized golden fixture are approved and checked in together with its descriptor,
generator, and byte-level tests. Until then it must remain absent from `GET
/inventory-document-formats` and must not be accepted by a document-run request.

Two v1 XML formats are now implemented for manual upload: aggregation of newly formed packages and
disaggregation of old packages. Their official-source provenance, normalized source copies,
sanitized golden fixtures, eligibility rules, and validation boundary are recorded in
[`v1/README.md`](./v1/README.md). They are published as
`inventory_xml_gismt_aggregation` and `inventory_xml_gismt_disaggregation`.
Both golden files pass the available XSD checks; successful upload in the Chestny ZNAK personal
account remains the external acceptance gate.

The TXT, CSV, XLSX, and ZIP sections below remain approval gates and planning labels. They are not
advertised by the production catalog yet.

## Rules shared by every candidate

Approval must record all of the following without relying on an implementation guess:

- [ ] Owner and date of approval, authoritative source URL/file/reference, source version, and
      whether it is an XSD, protocol document, official sample, or customer-approved contract.
- [ ] Exact encoding, byte-order mark policy, Unicode normalization, line endings, final newline,
      field/element order, optionality, null/empty representation, escaping, quoting, delimiters,
      locale, decimal rules, and spreadsheet cell types where applicable.
- [ ] Exact KM representation: canonical raw GS1 value versus printable form, preservation or
      substitution of group separator `0x1D`, crypto-tail policy, and whether GTIN/serial are also
      emitted. Exact SSCC representation: 18 digits versus `(00)`/20-digit form, check digit, and
      parent-child placement.
- [ ] Production-date semantics: configured inclusive `from`/`to`, source production date,
      operator-observed date, missing date, mixed dates inside a box, timezone, and grouping rules.
- [ ] Inclusion/exclusion matrix for every frozen source category: `expected`, `verified`,
      `writeOffCandidates`, `protected`, `ineligible`, `unknown`, `oldBoxes`, `newBoxes`, and
      `observedDateGroups`.
- [ ] Explicit proof that `MOVING_BY_UD` is protected: whether it is omitted or reported as
      non-actionable, and that it can never enter aggregation, write-off, or accounting actions.
- [ ] Treatment of `EMITTED`, `APPLIED`, `INTRODUCED`, `RETIRED`, `WRITTEN_OFF`, and
      `DISAGGREGATION`, including scanned/unscanned and corrected/voided results.
- [ ] Exact filename grammar, transliteration/sanitization, timestamp and timezone, inventory
      number/revision, extension, collision behavior, deterministic ordering, empty-file behavior,
      maximum rows/bytes, part numbering, and whether logical groups may cross part boundaries.
- [ ] Signature/encryption requirement, detached or embedded signature form, certificate identity,
      checksum algorithm and representation, manifest relationship, retention period, deletion
      policy, and regeneration compatibility for a frozen format version.
- [ ] Sanitized golden input and exact golden output contain no customer production KMs, SSCCs,
      credentials, personal data, or secrets; provenance and approval are recorded next to them.
- [ ] Validator evidence is checked in: XSD/schema validation where applicable plus byte-for-byte
      deterministic retry tests and negative fixtures for malformed or forbidden data.

Changing any approved byte-level rule requires a new descriptor version and an explicit migration
and retention decision. A superseded version is not requestable for a new run; already verified
artifacts remain governed by their recorded checksum and retention policy.

## Implemented v1: aggregation XML for new boxes

- [x] Record the official GIS MT/Chestny ZNAK aggregation XSD and sample for this
      product group; record document type/version and required organization/document metadata.
- [x] Approve exact XML declaration, namespaces, root/element order, cardinalities, encoding,
      whitespace, escaping, schema-location policy, and validation command/result.
- [x] Approve each `newBoxes` SSCC representation and deterministic ordering of its verified child
      KMs; define invalidated/open/unprinted boxes and mixed observed-date behavior.
- [x] Confirm `MOVING_BY_UD`, protected, ineligible, unknown, voided, and write-off candidates are
      excluded from aggregation children even when scanned.
- [x] Generate one deterministic, unsplit XML artifact with the existing verified SHA-256 storage
      and retention lifecycle.
- [x] Add sanitized aggregation input/XML golden pair and authoritative validation evidence.
- [ ] Confirm a generated artifact by successful manual upload in the Chestny ZNAK personal
      account.

## Implemented v1: disaggregation XML for old boxes

- [x] Obtain the authoritative disaggregation XSD/sample and define whether one old SSCC, many
      SSCCs, or explicit child KMs are required.
- [x] Approve XML declaration, namespaces, element order/cardinality, encoding, whitespace,
      escaping, and exact old-SSCC representation.
- [x] Define which `oldBoxes` qualify after simple check versus repack, including already
      disaggregated, unknown, invalid, partially scanned, and corrected boxes.
- [x] Confirm protected/`MOVING_BY_UD` contents never cause a destructive disaggregation action
      unless the authoritative protocol explicitly and safely requires representation.
- [x] Generate one deterministic, unsplit XML artifact with the existing verified SHA-256 storage
      and retention lifecycle.
- [x] Add sanitized disaggregation input/XML golden pair and authoritative validation evidence.
- [ ] Confirm a generated artifact by successful manual upload in the Chestny ZNAK personal
      account.

## Candidate: write-off TXT

- [ ] Approve whether each line is a canonical raw KM, printable KM, or another authoritative form;
      define GS separator/crypto-tail policy, UTF-8/BOM, line ending, final newline, and empty file.
- [ ] Define exact inclusion from `writeOffCandidates` and explicit exclusion of verified,
      protected/`MOVING_BY_UD`, ineligible, unknown, and voided scans.
- [ ] Define production-date filtering: configured inclusive range versus observed-date grouping and
      behavior for missing/mismatched dates.
- [ ] Approve ordering, duplicate handling, filenames, maximum lines/bytes, split boundary, part
      numbering, signatures, checksums, manifest entries, and retention.
- [ ] Add sanitized TXT golden input/output and approval evidence.

## Candidate: write-off CSV

- [ ] Approve exact header and columns, delimiter, quote/escape rules, UTF-8/BOM, CRLF/LF, final
      newline, KM/GTIN/serial/date representation, and formula-injection prevention.
- [ ] Define exact inclusion from `writeOffCandidates`; exclude protected/`MOVING_BY_UD`,
      ineligible, unknown, voided, and already retired/written-off rows as contract requires.
- [ ] Define source versus observed production-date columns and inclusive range behavior.
- [ ] Approve ordering, duplicate handling, filenames, row/byte splitting, part numbering,
      signatures, checksums, manifest entries, and retention.
- [ ] Add sanitized CSV golden input/output and approval evidence.

## Candidate: current stock CSV

- [ ] Approve exact header/columns, delimiter, quoting, encoding/BOM, line endings, KM/SSCC and date
      representation, and formula-injection prevention.
- [ ] Define whether current stock contains verified expected codes only or another exact union;
      specify old/new box linkage and unboxed codes.
- [ ] Define protected/`MOVING_BY_UD` treatment explicitly. If visible for reference, it must be
      marked non-actionable and never counted as inventory-adjustment input.
- [ ] Define source and observed-date fields, mismatches, inclusive date range, missing dates, and
      deterministic grouping/order.
- [ ] Approve filenames, row/byte splitting and group boundaries, part numbering, signatures,
      checksums, manifest entries, and retention.
- [ ] Add sanitized current-stock CSV golden input/output and approval evidence.

## Candidate: final boxes CSV

- [ ] Approve exact header/columns, delimiter, quoting, encoding/BOM, line endings, SSCC form,
      child-count/date columns, and formula-injection prevention.
- [ ] Define inclusion of closed valid `newBoxes`, treatment of unchanged `oldBoxes`, and exclusion
      of open, invalidated, failed-print, reprinted, or empty boxes.
- [ ] Define whether child KMs are included, how multiple observed dates are represented, and how
      protected/`MOVING_BY_UD` children affect eligibility and counts.
- [ ] Approve deterministic SSCC ordering, filenames, box-preserving split boundaries, part
      numbering, signatures, checksums, manifest entries, and retention.
- [ ] Add sanitized final-boxes CSV golden input/output and approval evidence.

## Candidate: balances by observed production date CSV

- [ ] Approve exact header/columns, delimiter, quoting, UTF-8/BOM, line endings, numeric/date format,
      totals, empty groups, and formula-injection prevention.
- [ ] Define grouping exclusively from the frozen observed production date, including date changes,
      missing dates, source-date mismatch, inclusive configured range, and timezone independence.
- [ ] Define category/count basis and whether boxes and units are separate; protected/
      `MOVING_BY_UD` must be excluded from actionable balances or separately non-actionable.
- [ ] Approve ordering, filenames, row/byte split semantics, part numbering, signatures, checksums,
      manifest entries, and retention.
- [ ] Add sanitized balances CSV golden input/output and approval evidence.

## Candidate: balances by observed production date XLSX

- [ ] Obtain an authoritative workbook/template or explicit customer-approved workbook contract;
      approve sheet names/order, exact cells/columns, table ranges, types, number/date formats,
      formulas versus values, freeze panes, filters, widths, locale, and workbook metadata.
- [ ] Define observed-date grouping, missing/mismatched dates, inclusive configured range, totals,
      category/count basis, and protected/`MOVING_BY_UD` non-actionability.
- [ ] Approve deterministic ZIP member ordering/timestamps and workbook properties so retries are
      byte-stable, plus formula-injection prevention for all text cells.
- [ ] Approve filenames, maximum workbook rows/sheets, split behavior, part numbering, signatures,
      checksums, manifest entries, and retention.
- [ ] Add sanitized XLSX golden input/output, a human-readable cell-map fixture, and approval
      evidence from at least one independent XLSX reader.

## Package contract: downloadable ZIP and `manifest.json`

The ZIP is a delivery package over selected approved artifacts, not a separately advertised
generator descriptor. It cannot be implemented from the candidate labels above. Approval requires
an exact package contract and a sanitized golden archive:

- [ ] Approve the `manifest.json` schema and schema version: exact top-level fields, artifact entry
      fields, JSON encoding, key order/canonicalization, newline policy, integer bounds, and rules
      for forward/backward compatibility.
- [ ] For every artifact entry, approve the exact archive-relative filename, byte size, lowercase
      SHA-256 digest, MIME type, format id/version, part number, physical row count, code count, and
      box count. Define whether totals are repeated at package level and how they are verified.
- [ ] Approve deterministic artifact and manifest ordering, the position/name of `manifest.json`,
      ZIP member timestamps/timezone, permissions/platform bits, compression method/level, UTF-8
      filename flag, extra fields, comments, and deterministic retry behavior.
- [ ] Define path safety: filenames are relative single-root paths; reject absolute paths, drive
      prefixes, `..`, empty/dot segments, NUL/control characters, separator ambiguity, Unicode
      normalization collisions, case-fold collisions, duplicate member names, and collisions with
      `manifest.json`.
- [ ] Define selection and empty-package behavior: whether zero selected/ready artifacts is rejected
      or produces an archive, whether a manifest-only archive is permitted, and how failed,
      unavailable, invalidated, superseded, or duplicate requested formats are represented or
      rejected.
- [ ] Approve whole-package checksum placement and algorithm, signature/encryption requirements,
      detached versus embedded signature naming, certificate/key identity, password/key delivery,
      and whether encrypted member metadata may remain visible.
- [ ] Approve package filename/version/revision grammar, maximum member count and compressed/
      uncompressed bytes, total expansion-ratio bound, download content type/disposition, retention,
      invalidation on reopen, regeneration, and deletion rules.
- [ ] Add a sanitized golden ZIP containing only approved-format golden artifacts and an exact
      `manifest.json`; include no customer KMs/SSCCs, credentials, personal data, secrets, or
      production identifiers.
- [ ] Record independent validation: safe extraction in at least two maintained ZIP readers,
      duplicate/traversal/collision negative fixtures, recomputed size/SHA-256/count verification,
      manifest schema validation, and byte-for-byte deterministic regeneration.

## Approval record template

Copy this block into the versioned fixture directory only after approval:

```text
Candidate:
Descriptor id/version:
Authority and source version:
Approved by / date:
Sanitization reviewer:
Encoding and byte contract:
KM and SSCC representation:
Date semantics:
Inclusion/exclusion decision (including MOVING_BY_UD):
Filename/splitting rules:
Signature/checksum/retention rules:
Golden input path:
Golden output path:
Validator and result:
```
