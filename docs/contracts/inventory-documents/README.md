# Inventory document contract approval gate

Inventory result formats are a compliance boundary. A format is public only when its exact external
contract and a sanitized golden fixture are approved and checked in together with its descriptor,
generator, and byte-level tests. Until then it must remain absent from `GET
/inventory-document-formats` and must not be accepted by a document-run request.

There are currently **no approved inventory document fixtures or XSDs**. Consequently the
production catalog is intentionally empty. The candidate names below are planning labels, not API
ids or promises of file compatibility.

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

## Candidate: aggregation XML for new boxes

- [ ] Obtain the authoritative GIS MT/Chestny ZNAK aggregation XSD and accepted sample for this
      product group; record document type/version and required organization/document metadata.
- [ ] Approve exact XML declaration, namespaces, root/element order, cardinalities, encoding,
      whitespace, escaping, schema-location policy, and validation command/result.
- [ ] Approve each `newBoxes` SSCC representation and deterministic ordering of its verified child
      KMs; define invalidated/open/unprinted boxes and mixed observed-date behavior.
- [ ] Confirm `MOVING_BY_UD`, protected, ineligible, unknown, voided, and write-off candidates are
      excluded from aggregation children even when scanned.
- [ ] Approve filenames, maximum boxes/KMs or bytes per part, whether a box may split (normally no),
      part numbering, signatures, checksums, manifest entries, and retention.
- [ ] Add sanitized aggregation input/XML golden pair and authoritative validation evidence.

## Candidate: disaggregation XML for old boxes

- [ ] Obtain the authoritative disaggregation XSD/sample and define whether one old SSCC, many
      SSCCs, or explicit child KMs are required.
- [ ] Approve XML declaration, namespaces, element order/cardinality, encoding, whitespace,
      escaping, and exact old-SSCC representation.
- [ ] Define which `oldBoxes` qualify after simple check versus repack, including already
      disaggregated, unknown, invalid, partially scanned, and corrected boxes.
- [ ] Confirm protected/`MOVING_BY_UD` contents never cause a destructive disaggregation action
      unless the authoritative protocol explicitly and safely requires representation.
- [ ] Approve date semantics, filenames, per-part grouping, no-split rules, signatures, checksums,
      manifest entries, and retention.
- [ ] Add sanitized disaggregation input/XML golden pair and authoritative validation evidence.

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
