# Markiro U.S. Traceability — Requirements

- Source: MUS-001 v0.1 (2026-09-03), section 6 (normative table) and section 4.5 (language rules)
- Status: baseline, not yet implemented
- Owner: Vladislav Bogatyrev

This table is normative for implementation. A P0 requirement is complete only when its acceptance evidence exists; per-requirement status lives in [requirements-traceability.md](requirements-traceability.md). The **Basis** column names the source: `FDA-xx` / `GS1-xx` are regulatory or standards sources listed in [regulatory-basis.md](regulatory-basis.md); `PRODUCT`, `MKR-xx`, `CASE`, `DEMO`, `EVIDENCE` and `ROADMAP` mark project decisions or existing Markiro invariants, not legal requirements.

## Priority codes

| Code | Meaning                 | Use                                                                       |
| ---- | ----------------------- | ------------------------------------------------------------------------- |
| P0   | Filing minimum          | Must be implemented and evidenced before the case-ready release freeze.   |
| P1   | Pre-filing strengthener | Desirable before filing; absence does not block the main product exhibit. |
| P2   | Post-filing             | Deliberately deferred so the 3–5 month schedule is not diluted.           |

## Language rules

Every UI string, document, demo narration and public claim must follow this matrix (spec §4.5). A content test or review fails on any entry from the right column (see REG-002, EVD-007).

| Allowed                                                            | Not allowed                     |
| ------------------------------------------------------------------ | ------------------------------- |
| Designed to support applicable FSMA 204 recordkeeping requirements | FDA approved / FDA certified    |
| FDA-aligned electronic sortable spreadsheet                        | Official FDA integration        |
| Traceability readiness demonstrator                                | Guarantees compliance           |
| Lot-level workflow with optional case scanning                     | FDA requires serialization/SSCC |
| EPCIS-ready architecture (future)                                  | EPCIS is required by FDA        |

## REG — Regulatory baseline and claims

| ID      | P   | Requirement                                                                                                      | Acceptance                                                                                                             | Basis         |
| ------- | --- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------- |
| REG-001 | P0  | Store the regulatory baseline version and the date sources were last checked.                                    | The profile and every compliance-oriented export show the baseline ID, date and list of sources.                       | FDA-01        |
| REG-002 | P0  | Use only cautious wording: "designed to support applicable requirements" and "FDA-aligned demonstrator".         | UI, documentation and demo contain no "FDA approved", "certified compliant" or compliance guarantees.                  | FDA-01        |
| REG-003 | P0  | Do not assume the rule applies to every product; coverage is determined against the FTL and possible exemptions. | Every product has a manual coverage status with rationale; `unknown` blocks compliance-ready export.                   | FDA-02        |
| REG-004 | P0  | The P0 version supports only processor CTEs: Receiving, Transformation and Shipping.                             | The processor profile exposes three CTEs; other CTEs are explicitly marked out of scope.                               | FDA-01/FDA-03 |
| REG-005 | P0  | Assign a new TLC only on Transformation or an allowed special scenario; Shipping never creates a new TLC.        | The API rejects an attempt to assign a new TLC in a shipping event; a test covers the rule.                            | FDA-09        |
| REG-006 | P0  | Link every KDE to a specific traceability lot.                                                                   | Every finalized CTE row references `lot_id`; export is not produced when the link is broken.                           | FDA-01        |
| REG-007 | P0  | Create and version a Traceability Plan for the processor.                                                        | A plan can be created, approved, exported, and its previous version retained.                                          | FDA-04        |
| REG-008 | P0  | Support preparing records on request within the 24-hour window without promising automatic submission to FDA.    | A trace request has `due_at`; the package is prepared locally and contains XLSX, plan, validation report and manifest. | FDA-01/FDA-06 |
| REG-009 | P0  | Retain required records for at least 2 years; do not shorten Markiro's existing five-year default.               | Retention policy >= 730 days, previous plan versions >= 730 days; configuration test.                                  | FDA-04        |
| REG-010 | P1  | EPCIS is not a P0 dependency and is not presented as a mandatory FDA format.                                     | P0 works without EPCIS; documentation labels EPCIS as an optional interoperability adapter.                            | FDA-07/GS1-01 |
| REG-011 | P0  | Do not implement automatic legal decisions on exemptions in P0.                                                  | UI offers a manual review status and a source link; the final assessment stays with the user/consultant.               | FDA-01        |
| REG-012 | P0  | Re-verify FDA/GS1 sources before every tagged release.                                                           | The release checklist contains a mandatory source refresh with date, reviewer and diff note.                           | FDA-01        |

## PRO — Profiles and product boundaries

| ID      | P   | Requirement                                                               | Acceptance                                                                                                               | Basis   |
| ------- | --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------- |
| PRO-001 | P0  | Add tenant profile `US_FSMA204_PROCESSOR`.                                | The profile enables U.S. terminology, three CTEs, FTL/TLC/plan/export and excludes Russian regulatory fields by default. | PRODUCT |
| PRO-002 | P0  | Add tenant profile `US_GENERIC_LOT_TRACEABILITY`.                         | The profile supports lot/case/recall without FTR coverage claims.                                                        | PRODUCT |
| PRO-003 | P0  | Keep `RU_CHZ` free of regressions and without renaming existing entities. | Existing RU tests pass; new migrations are additive; feature gating is verified.                                         | MKR-03  |
| PRO-004 | P0  | Add a reproducible synthetic demo tenant and reset.                       | One command creates an identical dataset; a repeated run is idempotent or performs a controlled reset.                   | CASE    |
| PRO-005 | P0  | Separate compliance-oriented and generic traceability workflows.          | The active profile is visible in the UI; the generic workflow generates no FTR coverage claims.                          | PRODUCT |
| PRO-006 | P0  | Add U.S. roles and a capability boundary for traceability workflows.      | Receiving/production/shipping/QA/auditor roles have minimal permissions; denial tests exist.                             | MKR-03  |

## LOC — Parties and locations

| ID      | P   | Requirement                                                                                                                  | Acceptance                                                                                             | Basis         |
| ------- | --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------- |
| LOC-001 | P0  | Separate legal party and physical location.                                                                                  | One party can have several locations; a CTE references the physical location.                          | FDA-03        |
| LOC-002 | P0  | Store the full Location Description: business name, phone, street/coordinates, city, state/region, ZIP/postal code, country. | The validator requires all fields for a case-ready location snapshot.                                  | FDA-05        |
| LOC-003 | P0  | Support a TLC source location and an alternative TLC source reference.                                                       | A lot accepts either a location description or a source reference; export reflects the chosen variant. | FDA-09        |
| LOC-004 | P0  | A location snapshot is captured when a CTE is finalized.                                                                     | Changing master data does not rewrite a finalized event/export; regression test.                       | PRODUCT       |
| LOC-005 | P1  | Support GLN, FDA Food Facility Registration Number and URL as optional identifiers/references.                               | Fields are validated by format but are not mandatory in P0.                                            | FDA-05/GS1-01 |
| LOC-006 | P0  | Support location roles: supplier, processor, ship-from, receive-at, recipient, TLC source.                                   | One location can have several roles; filtering by role works.                                          | PRODUCT       |
| LOC-007 | P1  | Warn about shipping between zones at the same address.                                                                       | UI shows a warning and requires confirmation, because same-address movement may not be a Shipping CTE. | FDA-01        |
| LOC-008 | P0  | Do not include real addresses, contacts or registration numbers in the public demo seed.                                     | The dataset uses fictional names, 555 contacts and example.com.                                        | EVIDENCE      |

## PRD — Product traceability profile and FTL classification

| ID      | P   | Requirement                                                                                                  | Acceptance                                                                                    | Basis    |
| ------- | --- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | -------- |
| PRD-001 | P0  | Extend the existing Product with a separate ProductTraceabilityProfile without duplicating the catalog.      | 1:1 link with `product_id`; the RU catalog stays compatible.                                  | MKR-01   |
| PRD-002 | P0  | Store a Product Description snapshot: product name, brand, commodity, variety, package size, package style.  | All component fields export separately; the snapshot is captured in the event.                | FDA-05   |
| PRD-003 | P0  | Coverage status: `covered`, `contains_ftl_same_form`, `not_covered`, `unknown`, `exemption_review_required`. | Status and rationale are mandatory for the compliance profile; `unknown` blocks final export. | FDA-02   |
| PRD-004 | P0  | Store FTL category, source URL/version, reviewer and review date.                                            | The card shows who/when/why; audit records the status change.                                 | FDA-02   |
| PRD-005 | P1  | Support a manual description of an FTL ingredient retained in the same form.                                 | The user can mark the ingredient and rationale; there is no automatic legal conclusion.       | FDA-02   |
| PRD-006 | P1  | Add `review_due_at` and a quarterly review workflow.                                                         | Overdue classifications appear on the readiness dashboard.                                    | FDA-04   |
| PRD-007 | P0  | GTIN stays an optional product identifier; the FTR workflow does not depend on item serialization.           | A product without GTIN passes the lot-level demo; GTIN/SSCC are used when available.          | FDA-07   |
| PRD-008 | P0  | Store UOM defaults and packaging definitions separately from the product name.                               | Quantity and UOM are mandatory on a CTE item; no implicit conversion in export.               | FDA-03   |
| PRD-009 | P0  | Do not mix the Russian CHZ product group with the U.S. FTL category.                                         | Separate fields/tables; migration and UI do not reuse `chzProductGroupCode` as FTL.           | MKR-03   |
| PRD-010 | P1  | Support an attachment/evidence link for the classification basis.                                            | A memo or URL can be attached; the public demo contains only public source links.             | EVIDENCE |

## LOT — Traceability lots and TLC

| ID      | P   | Requirement                                                                                                                 | Acceptance                                                                                                        | Basis   |
| ------- | --- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| LOT-001 | P0  | Create TraceabilityLot as a separate lot-level entity.                                                                      | A lot has product, TLC, source, assignment basis, dates, status and audit.                                        | FDA-01  |
| LOT-002 | P0  | Store TLC as an opaque string without imposing a single format.                                                             | Configurable length/regex is allowed; the demo uses a readable generated code.                                    | FDA-09  |
| LOT-003 | P0  | A lot must have a TLC source location or a TLC source reference.                                                            | Finalization is impossible without one of the two; the completeness report reflects the gap.                      | FDA-06  |
| LOT-004 | P0  | Store assignment basis: `transformation`, `initial_packing`, `first_land_receiving`, `exempt_supplier_receipt`, `imported`. | Processor P0 creates `transformation`/`imported`/`exempt_supplier_receipt`; other values are reserved.            | FDA-09  |
| LOT-005 | P0  | An imported lot keeps the supplier's TLC without regeneration.                                                              | A receiving item with a supplier creates/links a lot and stores the source snapshot.                              | FDA-09  |
| LOT-006 | P0  | A transformation output receives a new TLC and a source at the processor location.                                          | Finalization generates/validates the output TLC; the source is captured.                                          | FDA-03  |
| LOT-007 | P0  | TLC uniqueness accounts for the source location; do not assume global uniqueness of external TLCs.                          | The DB unique key does not forbid the same TLC from different source locations; the internal UUID is unambiguous. | PRODUCT |
| LOT-008 | P0  | Store lot genealogy as directed input→output edges.                                                                         | Backward/forward trace returns all input and output lots with quantities.                                         | FDA-06  |
| LOT-009 | P0  | Lot lifecycle: `active`, `consumed`, `shipped`, `quarantined`, `recalled`, `archived`.                                      | Status changes are audited; status does not delete history.                                                       | PRODUCT |
| LOT-010 | P0  | Link existing boxes/SSCC to a traceability lot through a separate bridge table.                                             | RU boxes get no breaking changes; one box belongs to one active output lot in P0.                                 | MKR-02  |
| LOT-011 | P1  | Support expiry/best-by and production date as operational fields.                                                           | Fields are visible on the lot card and can be included in labels; they are not presented as FDA KDEs.             | PRODUCT |
| LOT-012 | P0  | Search by TLC, internal lot, product, date, location, reference document and SSCC.                                          | Every search returns the lot card and event chain; tenant isolation tests.                                        | PRODUCT |

## REC — Receiving CTE

| ID      | P   | Requirement                                                                                                                                          | Acceptance                                                                                                   | Basis         |
| ------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------- |
| REC-001 | P0  | Create a Receiving event with draft/finalized/amended/void lifecycle.                                                                                | API and UI create, validate, finalize and correct through amendment.                                         | FDA-03        |
| REC-002 | P0  | A receiving item contains TLC, quantity/UOM, product description, immediate previous source, receiving location/date, TLC source and reference docs. | The completeness validator covers all required fields; golden fixture export.                                | FDA-03        |
| REC-003 | P0  | Support several lots/items in one receiving event.                                                                                                   | One BOL/ASN can contain several lines; each line links to its own lot.                                       | PRODUCT       |
| REC-004 | P0  | Support exempt supplier receipt when a TLC is absent.                                                                                                | The scenario requires a manual flag, source data and assignment of an own TLC; an audit reason is mandatory. | FDA-03/FDA-09 |
| REC-005 | P0  | Keep product/location snapshots at finalization.                                                                                                     | Later master edits do not change the finalized record/export.                                                | PRODUCT       |
| REC-006 | P0  | Reference document type/number are mandatory in the P0 demo.                                                                                         | ASN and BOL from the synthetic fixture are visible on the receiving card and in the XLSX.                    | FDA-03        |
| REC-007 | P1  | CSV import of receiving lines with preview and per-row errors.                                                                                       | Import creates no partial hidden data; accepted/rejected rows are explicit.                                  | PRODUCT       |
| REC-008 | P1  | Defer Station/warehouse offline receiving to P1, but the event model must not prevent it.                                                            | The API domain does not depend on browser-only assumptions; an ADR describes the future offline path.        | MKR-03        |

## TRN — Transformation CTE

| ID      | P   | Requirement                                                                                    | Acceptance                                                                                                 | Basis         |
| ------- | --- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------- |
| TRN-001 | P0  | Create a Transformation event and optionally link it to an existing Markiro shift.             | A closed shift can be selected and a transformation draft created without copying scan data.               | FDA-03/MKR-02 |
| TRN-002 | P0  | Transformation stores each incoming FTL lot, product description and quantity/UOM used.        | The two input lots in the demo are shown and exported separately.                                          | FDA-03        |
| TRN-003 | P0  | Transformation creates one or more output lots with new TLCs.                                  | The output lot contains source location, completion date, product description, quantity/UOM.               | FDA-03        |
| TRN-004 | P0  | Support commingling/repacking/relabeling as a transformation reason.                           | Demo reason=`commingling_and_repacking`; audit and plan describe the procedure.                            | FDA-01        |
| TRN-005 | P0  | Support multiple inputs and outputs and genealogy edges.                                       | Test: 2 input lots → 1 output lot; quantities and edges deterministic.                                     | PRODUCT       |
| TRN-006 | P1  | Show yield/waste, but do not make it a regulatory KDE.                                         | Yield calculation is separated from the FDA export and labeled operational.                                | PRODUCT       |
| TRN-007 | P0  | Completion date is mandatory; timestamps store the timezone.                                   | Export uses the requested date; audit retains timestamp/timezone.                                          | FDA-03        |
| TRN-008 | P0  | Reference docs include work order, batch/production log and optional shift.                    | Demo shows WO and BATCH references; links open internal details.                                           | FDA-03        |
| TRN-009 | P0  | A finalized transformation is immutable; correction creates an amendment/superseding revision. | No UPDATE changes the regulated snapshot; tests compare the previous export.                               | PRODUCT       |
| TRN-010 | P0  | Match the output lot with cases/SSCC formed in the linked shift.                               | The lot card shows 100 synthetic cases; the bridge is queryable/exportable as optional operational detail. | PRODUCT       |
| TRN-011 | P0  | Allow output FTL food from non-FTL inputs without requiring a fake input TLC.                  | The validator requires only actual FTL input lots and still creates the output TLC.                        | FDA-03        |
| TRN-012 | P1  | Provide planned vs actual quantities.                                                          | Finalization requires actual; planned is operational context only.                                         | PRODUCT       |
| TRN-013 | P1  | Show source completeness before finalization.                                                  | UI lists missing TLC, source, quantity and references by line.                                             | FDA-06        |
| TRN-014 | P0  | Synthetic demo transformation: two fresh-cut apple lots into snack cups.                       | Seed and browser test reproduce the exact chain and expected totals.                                       | DEMO          |

## SHP — Shipping CTE

| ID      | P   | Requirement                                                                                                                                  | Acceptance                                                                                    | Basis   |
| ------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------- |
| SHP-001 | P0  | Create a Shipping event with draft/finalized/amended/void lifecycle.                                                                         | API/UI support the lifecycle and audit.                                                       | FDA-03  |
| SHP-002 | P0  | A shipping item contains TLC, quantity/UOM, product description, recipient location, ship-from location/date, TLC source and reference docs. | All required fields are validated and exported.                                               | FDA-03  |
| SHP-003 | P0  | Shipping does not change the TLC.                                                                                                            | An attempt to supply a generated TLC is rejected; the event references an existing lot only.  | FDA-09  |
| SHP-004 | P0  | Support several lots/items and partial-quantity shipping.                                                                                    | Lot balances and event lines represent a partial shipment without rewriting genealogy.        | PRODUCT |
| SHP-005 | P0  | Reference docs: BOL/invoice/ASN or an equivalent type+number.                                                                                | Demo includes BOL and invoice; export retains type/number.                                    | FDA-03  |
| SHP-006 | P1  | Selecting cases/SSCC is optional and may exceed the FTR minimum.                                                                             | Shipping can be lot-quantity only; case scan is a configurable buyer/operational requirement. | FDA-06  |
| SHP-007 | P0  | Outbound completeness check before finalization.                                                                                             | Missing recipient, source, date, TLC source, quantity or refs blocks finalization.            | FDA-06  |
| SHP-008 | P1  | Warning for direct-to-consumer/donation and same-address flows.                                                                              | User must classify the flow; P0 does not make a final legal determination.                    | FDA-01  |
| SHP-009 | P1  | CSV/ASN import/export adapter interface; implementation optional before filing.                                                              | Adapter contract exists; P0 may use manual entry and CSV.                                     | FDA-04  |
| SHP-010 | P0  | Synthetic demo ships 100 cases to one recipient.                                                                                             | Trace forward finds the exact recipient and shipping references.                              | DEMO    |

## DOC — Reference documents

| ID      | P   | Requirement                                                                                            | Acceptance                                                                           | Basis    |
| ------- | --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------- |
| DOC-001 | P0  | ReferenceDocument stores type and number as first-class data.                                          | An event can list multiple documents; type/number are exported separately.           | FDA-05   |
| DOC-002 | P0  | Allow document types BOL, PO, ASN, work order, invoice, database record, batch log and production log. | The dropdown has an extensible vocabulary and "other"; no hard-coded single format.  | FDA-05   |
| DOC-003 | P1  | Optional attachment with object-storage key, content hash and confidentiality class.                   | Attachment is not required for P0; if present, hash and access policy are stored.    | EVIDENCE |
| DOC-004 | P0  | The event snapshot keeps document identifiers even when the attachment is unavailable.                 | Deleting/retiring the binary does not erase the type/number link.                    | PRODUCT  |
| DOC-005 | P0  | No sensitive source documents in the public synthetic demo.                                            | The public seed uses generated PDFs/metadata without real parties or credentials.    | EVIDENCE |
| DOC-006 | P1  | Partner-facing record exchange mapping is versioned.                                                   | A mapping profile has version and effective date; changes do not rewrite old events. | FDA-06   |

## TRC — Trace, search and completeness

| ID      | P   | Requirement                                                                                                | Acceptance                                                                                                   | Basis    |
| ------- | --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------- |
| TRC-001 | P0  | The lot card shows product snapshot, TLC/source, status, CTE timeline and reference documents.             | One page supports human review without SQL.                                                                  | PRODUCT  |
| TRC-002 | P0  | Backward trace from an output lot to all input lots and previous source locations.                         | Demo returns two input lots and the supplier location.                                                       | FDA-06   |
| TRC-003 | P0  | Forward trace from an input/output lot to shipments and recipients.                                        | Demo returns the output lot, shipping event and Harbor Market DC.                                            | FDA-06   |
| TRC-004 | P0  | Graph and tabular views use the same query result.                                                         | Counts/nodes match; browser test snapshots both.                                                             | PRODUCT  |
| TRC-005 | P0  | The readiness dashboard flags missing TLC, TLC source, product/location pieces, quantities and references. | Known gaps are grouped by CTE, product, partner and severity.                                                | FDA-06   |
| TRC-006 | P0  | TLC/TLC source consistency rule.                                                                           | The validator catches a source mismatch across events for the same lot unless a documented amendment exists. | FDA-06   |
| TRC-007 | P1  | A partner expectation profile records inbound/outbound data channel and buyer-specific extras.             | The profile can require case scans without conflating them with FTR minimums.                                | FDA-06   |
| TRC-008 | P0  | Search filters: product, TLC range/list, date range, CTE, location and reference number.                   | A trace request can be built from a search result.                                                           | PRODUCT  |
| TRC-009 | P0  | Every result includes provenance: event ID/revision and source record.                                     | The export validation report can point back to originating records.                                          | EVIDENCE |
| TRC-010 | P1  | The completeness score is explanatory, not a legal compliance score.                                       | UI labels the score as data completeness/readiness and lists the exact missing fields.                       | PRODUCT  |

## RQ — Trace request and readiness drill

| ID     | P   | Requirement                                                                       | Acceptance                                                                                           | Basis           |
| ------ | --- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------- |
| RQ-001 | P0  | Create TraceRequest with requester, `received_at`, `due_at`, scope and status.    | Default `due_at` = `received_at` + 24h; the user may record an agreed alternate deadline.            | FDA-01          |
| RQ-002 | P0  | Scope supports product description, date range, TLC(s) and location(s).           | The synthetic request filters the expected chain only.                                               | FDA-06          |
| RQ-003 | P0  | Dry-run validation before export.                                                 | The system shows missing/ambiguous data and blocks case-ready status until resolved or acknowledged. | FDA-06          |
| RQ-004 | P0  | Record package generation duration and operator.                                  | The mock recall report includes `started_at`, `completed_at`, elapsed, reviewer.                     | EVIDENCE        |
| RQ-005 | P0  | Freeze the request snapshot and export inputs.                                    | Later data edits do not silently replace a prior response; regeneration creates a new revision.      | PRODUCT         |
| RQ-006 | P0  | The package includes workbook, traceability plan, validation report and manifest. | The ZIP lists files and SHA-256; each artifact is reproducible from the request revision.            | FDA-01/EVIDENCE |
| RQ-007 | P0  | No direct upload/email to FDA in P0.                                              | UI says "prepare package"; no production FDA endpoint or credentials.                                | FDA-08          |
| RQ-008 | P1  | QA sign-off workflow.                                                             | A QA reviewer can approve/reject the package with a reason; an audit event is generated.             | PRODUCT         |

## EXP — FDA-aligned export

| ID      | P   | Requirement                                                                                                                                | Acceptance                                                                                              | Basis         |
| ------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------- |
| EXP-001 | P0  | Generate XLSX as the primary FDA-aligned export.                                                                                           | The workbook opens in LibreOffice and Excel; no macros.                                                 | FDA-05        |
| EXP-002 | P0  | Include only relevant CTE tabs plus Metadata, Definitions and Validation.                                                                  | The processor demo contains Receiving, Transformation, Shipping and support tabs.                       | FDA-05        |
| EXP-003 | P0  | Composite Location Description and Product Description are split into separate columns.                                                    | A column-level golden test matches the adapter registry.                                                | FDA-05        |
| EXP-004 | P0  | Receiving/Transformation/Shipping columns map to official KDEs.                                                                            | The data dictionary references the source section and adapter version.                                  | FDA-03/FDA-05 |
| EXP-005 | P0  | Deterministic ordering and normalized formatting.                                                                                          | The same snapshot creates a byte-stable or semantically stable workbook; dates/decimals/UOM consistent. | EVIDENCE      |
| EXP-006 | P0  | The Validation tab lists row, field, severity and source record.                                                                           | No hidden dropped records; the errors/warnings count is shown in Metadata.                              | FDA-06        |
| EXP-007 | P0  | The Metadata tab includes tenant/demo name, request scope, timezone, `generated_at`, software version, regulatory baseline and disclaimer. | All fields are present in the golden fixture.                                                           | EVIDENCE      |
| EXP-008 | P0  | Manifest JSON contains artifact name, size, media type and SHA-256.                                                                        | A verification command confirms the package before evidence capture.                                    | EVIDENCE      |
| EXP-009 | P1  | Also provide CSV ZIP and canonical JSON for integrations/testing.                                                                          | Derived files contain the same rows and IDs as the XLSX; no extra claims.                               | PRODUCT       |
| EXP-010 | P0  | The P0 synthetic package generates in < 60 seconds on the development baseline.                                                            | An automated performance test or timed evidence run records the result.                                 | CASE          |
| EXP-011 | P0  | Keep the official-template adapter versioned, not scattered across UI code.                                                                | A single field registry drives headers, validation and the data dictionary.                             | MKR-03        |
| EXP-012 | P0  | Golden fixtures and expected hashes are reviewed, not blindly regenerated.                                                                 | The PR shows an intentional diff and a reviewer note when the source mapping changes.                   | MKR-03        |

## PLN — Traceability Plan

| ID      | P   | Requirement                                                                                  | Acceptance                                                                                       | Basis    |
| ------- | --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------- |
| PLN-001 | P0  | Create TraceabilityPlan and immutable versions.                                              | A plan has draft/effective/superseded states and an effective date.                              | FDA-04   |
| PLN-002 | P0  | The plan includes record maintenance procedures, formats and locations.                      | The generated PDF names system records, exports, backups and responsible roles.                  | FDA-04   |
| PLN-003 | P0  | The plan includes procedures for identifying FTL foods.                                      | Generated content references the product classification workflow and review cadence.             | FDA-04   |
| PLN-004 | P0  | The plan includes the TLC assignment procedure.                                              | Generated content describes format, assignment trigger and source location.                      | FDA-04   |
| PLN-005 | P0  | The plan includes point of contact name/title/phone.                                         | The synthetic demo uses a fictional QA manager; a real pilot requires an explicit contact.       | FDA-04   |
| PLN-006 | P0  | Processor P0 does not require a farm map, but explains why it is not applicable.             | The PDF marks the farm map as not applicable to the processor profile; no empty mandatory block. | FDA-04   |
| PLN-007 | P0  | Previous plan versions are retained for at least 2 years.                                    | Retention test and version history UI.                                                           | FDA-04   |
| PLN-008 | P0  | Plan content derives from actual tenant configuration with explicit user-editable narrative. | Changes in profile/locations do not silently alter the effective plan.                           | PRODUCT  |
| PLN-009 | P1  | Annual and change-triggered review reminders.                                                | `review_due_at` and a change-impact banner.                                                      | FDA-04   |
| PLN-010 | P0  | The PDF export includes version, effective date, approver and change history.                | The artifact is readable, deterministic and included in the trace request package.               | EVIDENCE |

## STN — Station and labels

| ID      | P   | Requirement                                                                            | Acceptance                                                                                   | Basis   |
| ------- | --- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------- |
| STN-001 | P0  | Preserve existing offline journal/outbox/restart invariants.                           | All existing station tests pass; the new traceability link survives restart and reconnect.   | MKR-03  |
| STN-002 | P1  | A Station shift can receive the output trace lot/TLC snapshot.                         | The operator sees product, TLC, production date and status without a live server dependency. | PRODUCT |
| STN-003 | P1  | A closed case/SSCC can be linked to an output lot locally and synced idempotently.     | Offline case links replay once; duplicates/conflicts are explicit.                           | MKR-03  |
| STN-004 | P1  | TLC mismatch or an expired lot blocks/alerts according to policy.                      | A policy test distinguishes hard block vs warning; audit records the override.               | PRODUCT |
| STN-005 | P1  | A printed label may include human-readable TLC, product, production date and quantity. | Template preview and a physical sample show readable data.                                   | FDA-09  |
| STN-006 | P1  | QR/GS1-128/SSCC remain optional carriers, not legal requirements.                      | The workflow works without a barcode carrier; documentation states optional.                 | FDA-09  |
| STN-007 | P1  | Log print requested/confirmed/skipped and printer identity.                            | The evidence export distinguishes the action from a successful physical print.               | CASE    |
| STN-008 | P1  | Case scan may accelerate shipping selection but is a buyer/operational enhancement.    | Configuration can disable mandatory case scan.                                               | FDA-06  |
| STN-009 | P1  | English station locale and U.S. date/UOM display.                                      | Core demo screens are English; raw stored dates remain ISO.                                  | PRODUCT |
| STN-010 | P2  | Receiving and shipping station modes are deferred unless time remains.                 | The P0 admin workflow remains complete; a future ADR notes the offline extension.            | ROADMAP |

## INT — Integrations and API

| ID      | P   | Requirement                                                                   | Acceptance                                                                         | Basis         |
| ------- | --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------- |
| INT-001 | P0  | Expose the traceability REST API through existing OpenAPI conventions.        | Contracts are strict/shared; auth and tenant policies are declared and tested.     | MKR-03        |
| INT-002 | P0  | Provide CSV import/export with preview and row-level validation.              | The synthetic supplier file imports without manual database edits.                 | PRODUCT       |
| INT-003 | P1  | Partner mapping profiles for column names/UOM/document types.                 | The mapping version is stored with the import/export run.                          | FDA-06        |
| INT-004 | P1  | Keep the CommerceML/1C adapter isolated from U.S. modules.                    | No U.S. domain type depends on CommerceML or CHZ fields.                           | MKR-02        |
| INT-005 | P2  | EPCIS 2.0.1 adapter.                                                          | Deferred; the canonical model can map what/when/where/why/how without blocking P0. | GS1-01/GS1-02 |
| INT-006 | P2  | ASN/EDI integration with a pilot-specific provider.                           | Deferred until partner requirements exist; no speculative vendor lock-in.          | FDA-04        |
| INT-007 | P0  | No runtime dependency on an external FDA/GS1 service for factory operations.  | Demo and Station continue offline; source links are documentation only.            | MKR-03        |
| INT-008 | P1  | Import/export run audit with file hash, row counts, accepted/rejected totals. | Each run has a reproducible record and a downloadable error report.                | EVIDENCE      |

## NFR — Non-functional requirements

| ID      | P   | Requirement                                                                     | Acceptance                                                                         | Basis    |
| ------- | --- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| NFR-001 | P0  | Every business query/write is tenant-scoped and preserves composite tenant FKs. | Cross-tenant tests deny read/write for every new entity.                           | MKR-03   |
| NFR-002 | P0  | Separate cabinet users, station operators and external contacts.                | No identity-domain collapse; exported records contain only necessary actor fields. | MKR-03   |
| NFR-003 | P0  | Audit exact actor, action, target, result, revision and relevant metadata.      | Tests assert fields, not merely row count.                                         | MKR-03   |
| NFR-004 | P0  | Finalized regulated snapshots are immutable; amendments preserve history.       | DB/API prevent destructive update and hidden overwrite.                            | PRODUCT  |
| NFR-005 | P0  | Idempotent event/import/export commands.                                        | Retry with the same idempotency key does not duplicate events, lots or files.      | MKR-03   |
| NFR-006 | P0  | Data minimization and no real PII/secrets in the public demo/evidence.          | Automated fixture scan and manual checklist pass.                                  | EVIDENCE |
| NFR-007 | P0  | Retention, backup and restore are documented and testable.                      | A restore drill recreates one demo tenant and trace request package.               | FDA-01   |
| NFR-008 | P0  | All U.S. dates are stored ISO; display uses tenant timezone and U.S. locale.    | Boundary tests around midnight/DST; XLSX dates stable.                             | PRODUCT  |
| NFR-009 | P0  | Quantity uses decimal plus explicit UOM; no silent conversion.                  | API rejects missing/zero/negative quantity; conversion requires an explicit rule.  | FDA-03   |
| NFR-010 | P0  | Exports are deterministic and free of macros/external links.                    | Security scan and round-trip open test pass.                                       | EVIDENCE |
| NFR-011 | P0  | No CDN/runtime internet dependency in the station workflow.                     | The bundle contains assets; offline test passes.                                   | MKR-03   |
| NFR-012 | P0  | Accessibility: keyboard operation, labels, focus, non-color status.             | Automated and manual core-flow checklist passes.                                   | MKR-03   |
| NFR-013 | P1  | Performance: trace query < 2 s for demo; package < 60 s.                        | A timed acceptance run is saved as evidence.                                       | CASE     |
| NFR-014 | P0  | Backward-compatible migrations only; no rewrite of applied migrations.          | Fresh and upgrade DB paths tested.                                                 | MKR-03   |
| NFR-015 | P0  | Observability uses request IDs and safe logs without confidential payloads.     | Error responses and logs omit TLC lists/full documents unless authorized.          | MKR-03   |

## EVD — Evidence and case package

| ID      | P   | Requirement                                                                                         | Acceptance                                                                                 | Basis    |
| ------- | --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- |
| EVD-001 | P0  | Tagged public release for the case-ready version.                                                   | Release tag, commit SHA, changelog and installer/web build hashes preserved.               | EVIDENCE |
| EVD-002 | P0  | Reproducible demo seed and reset command.                                                           | A reviewer can recreate the dataset and outputs from the README.                           | EVIDENCE |
| EVD-003 | P0  | Capture 12–18 high-quality screenshots of the full flow.                                            | The manifest identifies version, route, fixture and redactions.                            | EVIDENCE |
| EVD-004 | P0  | Create a 5–8 minute English demo video.                                                             | The video follows the approved script, synthetic data only, no compliance overclaim.       | EVIDENCE |
| EVD-005 | P0  | Publish architecture diagram, data dictionary and requirement traceability matrix.                  | Each P0 requirement maps to a test/evidence.                                               | EVIDENCE |
| EVD-006 | P0  | Preserve generated XLSX, plan PDF, trace request report and ZIP manifest.                           | Files validate and hashes are recorded.                                                    | EVIDENCE |
| EVD-007 | P0  | Create a limitations and non-goals statement.                                                       | Public docs list excluded CTEs, exemptions engine, EPCIS and direct FDA integration.       | EVIDENCE |
| EVD-008 | P0  | The evidence package must distinguish automated, browser, Windows/hardware and external validation. | The QA report has separate sections and no unsupported "verified" claims.                  | MKR-03   |
| EVD-009 | P1  | Obtain review from a U.S. food-safety/traceability specialist.                                      | Dated written feedback or a signed review memo addresses scope and terminology.            | CASE     |
| EVD-010 | P1  | Obtain 1–2 authentic letters of interest after a real demo/discussion.                              | Letters describe the author's own problem and interest, not a fabricated purchase promise. | CASE     |
| EVD-011 | P0  | Seal evidence files with SHA-256 using repository evidence tooling.                                 | The verification command passes after packaging.                                           | MKR-03   |
| EVD-012 | P0  | Maintain a source-to-claim register for NIW exhibits.                                               | Every product claim cites a release/test/screenshot/generated artifact or external letter. | CASE     |

## Totals

| Priority | Count |
| -------- | ----- |
| P0       | 132   |
| P1       | 36    |
| P2       | 3     |
| Total    | 171   |
