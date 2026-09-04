# Markiro U.S. Traceability — Data Dictionary

- Source: MUS-001 v0.1 (2026-09-03), sections 5, 7, appendices A, B, D
- Status: baseline, not yet implemented
- Owner: Vladislav Bogatyrev

This document translates the target architecture, data model and KDE dictionary of
MUS-001 into a reference for the `traceability` bounded context. Requirement IDs
(LOC-, PRD-, LOT-, DOC-, ...) refer to [requirements.md](requirements.md); the
regulatory reasoning behind the KDE sets lives in
[regulatory-basis.md](regulatory-basis.md); the synthetic dataset that exercises this
model is described in [demo-scenario.md](demo-scenario.md); known gaps are listed in
[limitations.md](limitations.md).

## 1. Proposed repository placement

Section 5.1 of MUS-001 proposes the following placement inside the existing monorepo
(a new bounded context, not a fork):

```text
docs/us/
  README.md
  regulatory-basis.md
  requirements.md
  requirements-traceability.md
  data-dictionary.md
  demo-scenario.md
  acceptance.md
  limitations.md
packages/domain/src/traceability/
packages/db/src/schema/traceability.ts
packages/platform-contracts/src/traceability/
apps/api/src/modules/traceability/
apps/admin/src/pages/traceability/
apps/station/src/lib/traceability/
tools/us-demo/
```

## 2. Core entities

Section 5.2 defines thirteen core entities.

| Entity                               | Purpose                              | Key fields / rules                                     |
| ------------------------------------ | ------------------------------------ | ------------------------------------------------------ |
| RegulatoryProfile                    | Active jurisdiction/use-case profile | tenant_id, code, baseline_version, effective_at        |
| TraceabilityParty                    | Organization / counterparty          | name, identifiers, contact                             |
| TraceabilityLocation                 | Physical site                        | full location description, optional GLN/FFRN/reference |
| ProductTraceabilityProfile           | FTL and product description          | coverage status, category, basis, review metadata      |
| TraceabilityLot                      | Lot/TLC and source                   | product, TLC, source, basis, dates, status             |
| TraceabilityEvent                    | Common event shell                   | type, status, location, revision, finalized_at         |
| ReceivingEvent + items               | Inbound CTE                          | source/receive locations, date, lots, quantities, refs |
| TransformationEvent + inputs/outputs | Production CTE                       | input lots, output lots, completion, genealogy         |
| ShippingEvent + items                | Outbound CTE                         | recipient/source, date, lots, quantities, refs         |
| ReferenceDocument                    | Business record metadata             | type, number, optional attachment/hash                 |
| TraceabilityPlanVersion              | Effective plan snapshot              | required sections, contact, version, PDF               |
| TraceRequest / ExportRun             | 24-hour readiness workflow           | scope, due_at, validation, artifacts, hashes           |
| TraceLotBox                          | Bridge to existing boxes/SSCC        | lot_id, box_id, linked_at/by                           |

The profile codes referenced by `RegulatoryProfile.code` are `RU_CHZ`,
`US_FSMA204_PROCESSOR` and `US_GENERIC_LOT_TRACEABILITY` (see
[requirements.md](requirements.md), REG-\* requirements).

## 3. Relationship schema

Section 5.3, reproduced verbatim:

```text
Product 1 ── 1 ProductTraceabilityProfile
Party 1 ── * Location
Product 1 ── * TraceabilityLot
Location 1 ── * TraceabilityLot (TLC source)
ReceivingEvent 1 ── * ReceivingItem ── 1 TraceabilityLot
TransformationEvent 1 ── * InputLot
TransformationEvent 1 ── * OutputLot
InputLot * ── * OutputLot (genealogy edge)
ShippingEvent 1 ── * ShippingItem ── 1 TraceabilityLot
TraceabilityLot 1 ── * TraceLotBox ── 1 existing Box
TraceRequest 1 ── * ExportRun ── * Artifact
```

## 4. Snapshot and immutability rules

Section 5.4:

- Master data is convenient for data entry, but a finalized CTE must store a snapshot
  of the product description and the location description.
- A finalized event is not edited in place. A correction creates an
  amendment/superseding revision with a reason and an actor.
- A trace request pins specific revisions; re-generation creates a new export run.
- Deleting or archiving a master record does not destroy the historical snapshot.

These rules back requirements LOC-004 and PRD-002 in
[requirements.md](requirements.md).

## 5. Identifiers and uniqueness

Section 5.5:

- Internal IDs are UUIDs in the existing project style.
- TLC is an opaque business identifier; an imported TLC may coincide across different
  source locations.
- Recommended unique key: `tenant_id + source_location_id/source_reference_identity + TLC`.
- SSCC remains the 18-digit GS1 identifier of existing Markiro, but it is an optional
  case layer.
- A reference document number is unique only within the context of type/party, not
  globally.

See LOT-002, LOT-003 and LOT-007 in [requirements.md](requirements.md) for the
corresponding acceptance criteria (opaque TLC string, mandatory TLC source location or
TLC source reference, no assumption of global TLC uniqueness).

## 6. Event lifecycle

Section 5.6:

| Status    | Rules                                                                                |
| --------- | ------------------------------------------------------------------------------------ |
| draft     | May be changed; not included in export-ready exports.                                |
| finalized | KDE complete; snapshot immutable; included in trace/export.                          |
| amended   | The old revision is preserved; the new revision references the previous one.         |
| void      | Not deleted; reason and actor are mandatory; export excludes it with an explanation. |

## 7. KDE dictionary

Section 7 of MUS-001 defines the common description blocks and the per-CTE KDE
mappings. The P0 column reads "Yes" for MVP fields, "If applicable" for
conditionally required fields and "No" for optional ones.

### 7.1 Common Location Description

| Field                             | P0  | Validation / note                                                                  |
| --------------------------------- | --- | ---------------------------------------------------------------------------------- |
| business_name                     | Yes | Non-empty; snapshot.                                                               |
| phone_number                      | Yes | International-friendly string; do not normalize in a way that loses the extension. |
| street_address_or_coordinates     | Yes | One of the two variants; store the type.                                           |
| city                              | Yes | Text.                                                                              |
| state_or_region                   | Yes | Text; for U.S. a state code may be used.                                           |
| zip_or_postal_code                | Yes | Text, not integer.                                                                 |
| country                           | Yes | ISO country + display.                                                             |
| gln / ffrn / source_reference_url | No  | Optional identifier/reference; separate fields.                                    |

### 7.2 Common Product Description

| Field           | P0            | Validation / note                                          |
| --------------- | ------------- | ---------------------------------------------------------- |
| product_name    | Yes           | Primary name.                                              |
| brand_name      | If applicable | Nullable, but stored as a separate field.                  |
| commodity       | If applicable | For example fresh-cut fruit.                               |
| variety         | If applicable | For example Red Delicious.                                 |
| packaging_size  | Yes           | Decimal + UOM or a human-readable structured pair.         |
| packaging_style | Yes           | Bag, cup, case, bulk, etc.                                 |
| gtin            | No            | Optional GS1 identifier; does not replace the description. |

### 7.3 Receiving KDE mapping

| Group              | Fields                                                                         |
| ------------------ | ------------------------------------------------------------------------------ |
| Lot                | TLC; TLC source location or source reference.                                  |
| Quantity           | quantity; unit_of_measure.                                                     |
| Product            | product_name; brand_name; commodity; variety; packaging_size; packaging_style. |
| Previous source    | full Location Description for immediate previous source.                       |
| Receiving location | full Location Description where food was received.                             |
| Date               | date_received.                                                                 |
| References         | reference_document_type + reference_document_number; multiple allowed.         |

### 7.4 Transformation KDE mapping

| Group              | Fields                                                     |
| ------------------ | ---------------------------------------------------------- |
| Each input FTL lot | input TLC; input product description; quantity/UOM used.   |
| Output lot         | new TLC; output product description; output quantity/UOM.  |
| Source             | transformation location as TLC source or source reference. |
| Date               | transformation_completed_date.                             |
| References         | work order / batch log / production log type+number.       |
| Genealogy          | explicit links from each input lot to each output lot.     |

### 7.5 Shipping KDE mapping

| Group      | Fields                                                                               |
| ---------- | ------------------------------------------------------------------------------------ |
| Lot        | existing TLC; TLC source location or source reference.                               |
| Quantity   | quantity; unit_of_measure.                                                           |
| Product    | full Product Description.                                                            |
| Recipient  | full Location Description for immediate subsequent recipient, excluding transporter. |
| Ship-from  | full Location Description from which food was shipped.                               |
| Date       | date_shipped.                                                                        |
| References | BOL / invoice / ASN type+number; maintain in record.                                 |

### Field registry

> All header labels, validation rules and XLSX mappings must derive from one versioned
> registry. Separate field lists must not be maintained in the UI, the validator, the
> export and the documentation.

## 8. Proposed API endpoints

Appendix A of MUS-001. All endpoints are proposed; none is implemented yet.

| Method   | Endpoint                            | Purpose                                     |
| -------- | ----------------------------------- | ------------------------------------------- |
| GET/PUT  | /traceability/profile               | Tenant U.S. profile and baseline.           |
| GET/POST | /traceability/parties               | Parties and contacts.                       |
| GET/POST | /traceability/locations             | Physical locations.                         |
| GET/PUT  | /traceability/products/:productId   | FTL/product traceability profile.           |
| GET/POST | /traceability/lots                  | Lots/TLC/source.                            |
| GET/POST | /traceability/receivings            | Receiving event lifecycle.                  |
| GET/POST | /traceability/transformations       | Transformation and genealogy.               |
| GET/POST | /traceability/shipments             | Shipping event lifecycle.                   |
| GET      | /traceability/search                | TLC/product/date/location/reference search. |
| GET      | /traceability/lots/:id/graph        | Backward/forward graph.                     |
| GET/POST | /traceability/plans                 | Traceability Plan versions.                 |
| GET/POST | /traceability/requests              | Trace request workflow.                     |
| POST     | /traceability/requests/:id/validate | Completeness dry-run.                       |
| POST     | /traceability/requests/:id/exports  | Generate package revision.                  |
| GET      | /traceability/exports/:id/download  | Download ZIP/artifact.                      |

## 9. Suggested migration/table names

Appendix B of MUS-001 suggests the following table names:

- `traceability_profiles`
- `traceability_parties`
- `traceability_locations`
- `product_traceability_profiles`
- `traceability_lots`
- `traceability_events`
- `receiving_events`
- `receiving_event_items`
- `transformation_events`
- `transformation_input_lots`
- `transformation_output_lots`
- `lot_genealogy_edges`
- `shipping_events`
- `shipping_event_items`
- `reference_documents`
- `traceability_event_documents`
- `traceability_plan_versions`
- `trace_requests`
- `trace_export_runs`
- `trace_export_artifacts`
- `trace_lot_boxes`

The specific names may be adjusted after studying the current schema conventions, but
the boundary and the semantics must be preserved. Do not create generic "events" without
discriminated contracts and tenant FKs.

## 10. Alignment with current schema conventions

The following conventions were verified in `packages/db/src/schema` and should be
carried over into `packages/db/src/schema/traceability.ts`:

- Every tenant-scoped table carries a `tenant_id` text column referencing
  `organization.id` (`product-regulatory.ts` wraps this in a local `tenantId()`
  helper; `org-profile.ts` declares it inline). Cross-table references are composite
  foreign keys that include `tenant_id` (for example
  `product_regulatory_profiles_tenant_product_fk` on `(tenant_id, product_id)` and
  `org_profiles_box_label_template_tenant_fk`), so a row can never point at another
  tenant's record. The traceability tables must follow the same composite-FK pattern,
  which also satisfies the "tenant FKs" rule of Appendix B.
- Internal primary keys are `uuid("id").primaryKey().defaultRandom()` (as on
  `products`), matching section 5.5 "UUID in the existing project style".
- All timestamps are declared as `timestamp(..., { withTimezone: true })`, with
  `created_at` / `updated_at` defaulting to `now()`. `finalized_at`, `effective_at`,
  `due_at`, `linked_at` and similar traceability columns should use the same form.
- Closed value sets are Postgres enums via `pgEnum` (for example
  `product_attribute_source`, `product_regulatory_proposal_status` in
  `product-regulatory.ts`). Event status (`draft` / `finalized` / `amended` / `void`),
  coverage status and TLC assignment basis are natural candidates for `pgEnum`, which
  gives the "discriminated contracts" required by Appendix B.
- Regulatory attributes are kept apart from the catalog: `product-regulatory.ts`
  defines `product_regulatory_profiles` keyed on `(tenant_id, product_id)` with a
  composite FK to `products`, instead of adding columns to `products`. The
  `ProductTraceabilityProfile` (1:1 with `product_id`, PRD-001) should use the same
  separate-table approach and the same key shape.
- `products.chz_product_group_code` (integer FK to `chz_product_groups.code`, also
  used by `org_box_label_template_defaults`) is the Russian CHZ product group. It must
  not be reused as the FTL category: PRD-009 requires different fields/tables, and
  neither migrations nor UI may reuse `chzProductGroupCode` as FTL.
- `products.gtin14` is currently `char(14) NOT NULL`. Section 7.2 and PRD-007 treat
  GTIN as optional, so the traceability profile must not depend on this column being
  meaningful for the U.S. flow; how the existing NOT NULL constraint interacts with
  U.S.-only products is tracked as open question 1 in [README.md](README.md) and in
  `docs/superpowers/specs/2026-09-03-us-traceability-design.md`.

## 11. Glossary

Appendix D of MUS-001.

| Term                 | Meaning in this specification                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| FTR                  | FDA Food Traceability Rule, 21 CFR Part 1 Subpart S.                                                         |
| FTL                  | Food Traceability List.                                                                                      |
| CTE                  | Critical Tracking Event.                                                                                     |
| KDE                  | Key Data Element.                                                                                            |
| TLC                  | Traceability Lot Code.                                                                                       |
| TLC source           | Physical location where TLC was assigned.                                                                    |
| TLC source reference | Alternative reference allowing FDA access to TLC source location description.                                |
| Lot genealogy        | Directed relation from input lots through transformation to output lots/shipments.                           |
| Export-ready         | Sufficiently implemented and evidenced for inclusion in the working MVP release package; not legal approval. |
| MVP release freeze   | Point at which tagged release and evidence artifacts are locked for independent review.                      |
| Synthetic demo       | Fictional, reproducible dataset containing no real confidential data.                                        |
| P0/P1/P2             | MVP / product hardening / future.                                                                            |
