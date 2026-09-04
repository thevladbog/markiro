# US-05 — Shipping CTE — Design Spec

**Date:** 2026-09-03

**Status:** Draft for review (not implemented)

**Slice:** US-05 from docs/us/implementation-plan.md; depends on US-03 (event shell, reference documents, import runs), US-02 (lots, product snapshot builder), US-01 (locations, snapshot builder); optional dependency on US-04 (output lots, `trace_lot_boxes` bridge) for the demo lot and for case selection

**Requirements:** SHP-001, SHP-002, SHP-003, SHP-004, SHP-005, SHP-006 (P1), SHP-007, SHP-008 (P1), SHP-009 (P1), SHP-010

**Related:**

- `docs/superpowers/specs/2026-09-03-us-03-receiving-and-documents-design.md` — `traceability_events` shell, lifecycle, `reference_documents`, `traceability_import_runs`, audit shape (owner; reused verbatim here).
- `docs/superpowers/specs/2026-09-03-us-02-product-profiles-and-lots-design.md` — `traceability_lots`, status enum and `assertLotTransition` (LOT-009), `buildProductDescriptionSnapshot`, `UOM_CODES_V1`.
- `docs/superpowers/specs/2026-09-03-us-00-regulatory-profile-design.md` — capabilities `traceability.shipping.write`, `traceability.qa.manage`, `RequireTraceabilityProfile` guard.
- `docs/superpowers/specs/2026-09-03-us-04-transformation-design.md` — output lot `NRF-260915-APL01`, `trace_lot_boxes` (planned sibling spec).
- `docs/superpowers/specs/2026-09-03-us-01-parties-locations-design.md` — location roles (LOC-006), `buildLocationSnapshot`, same-address detection (LOC-007) (planned sibling spec).
- `docs/us/data-dictionary.md` §7.5 (Shipping KDE mapping), §6 (lifecycle), §8 (`/traceability/shipments`).
- `docs/us/demo-scenario.md` §5 (Shipping 09/16/2026: 100 cases to Harbor Market DC, BOL-0916-H, INV-2026-0916-047).
- `docs/us/acceptance.md` §2.4 ("Shipping tries to create new TLC → Rejected"), checklist C-009.

## Problem

Shipping is the last P0 critical tracking event: it records which existing lot, in what quantity, left which of the tenant's locations on which date to which immediate subsequent recipient, together with the reference documents. The rule that distinguishes it from receiving and transformation is that a shipment never assigns a TLC: the API must make it impossible to introduce a new lot code here. Partial shipments must be representable (a lot can leave in several events) without touching genealogy, and the P0 minimum must stay lot-quantity based, with case/SSCC selection as an optional operational layer.

## Key facts of the codebase

- No shipping or outbound concept exists in the schema or API today. `grep -ri "shipping|отгруз|outbound"` in `packages/db/src/schema` and `apps/api/src/modules` only hits CommerceML order export (`apps/api/src/modules/exchange/commerceml/order-export.ts`, `order-status.ts`) and unrelated DTO text; `docs/architecture.md` does not mention shipping. Everything below is new.
- Event shell and lifecycle: `traceability_events` with `type`, `status draft|finalized|amended|void`, `revision`, `root_event_id`, `previous_revision_id`, `superseded_by_event_id`, `event_date` (exposed as `dateShipped`), `location_id` + `location_snapshot` (the tenant's own site, here ship-from), void/amend columns, immutability trigger, per-type `event_number` (`SHP-YY-NNNN`) — all defined in the US-03 spec and reused unchanged.
- Reference documents: `reference_documents` (`type` enum incl. `bol`, `invoice`, `asn`), `traceability_event_documents` with type/number snapshots, freeze-after-link rule (US-03).
- Boxes and SSCC: `boxes` (`packages/db/src/schema/platform.ts`) carries `sscc char(18)`, `closed_at`, `closure_received_at`, `disassembled_at`, `shift_id`, `unique(tenant_id, id)`; box eligibility classification (closed, shift closed, not disassembled, not in a pickup order) is implemented in `apps/api/src/modules/disaggregation/line-validation.ts` (`validateBoxCandidates`) and can be reused for case selection.
- SSCC lookup UI: `apps/admin/src/pages/code-search/index.tsx` classifies a typed/scanned SSCC via `GET /code-search?q=` (`classifySearch`), handles partial-SSCC multi-match, and renders with `formatSsccHri` from `@markiro/domain`.
- Lot balance: no balance concept exists. `traceability_lots` (US-02 spec) carries `product_id`, `tlc`, `source_location_id`/`source_reference`, `status` (`active, consumed, shipped, quarantined, recalled, archived`, transitions in `assertLotTransition`: `shipped → recalled | archived` only) and `origin_event_id`; it has no quantity column, so the origin quantity is read from the originating line (`receiving_event_items` or US-04 `transformation_output_lots`, OQ-US05-2).
- Draft-only mutation guard, `FOR UPDATE`, `ConflictException({ code })`, audit inserts into `tenant_audit_events` inside the transaction: `apps/api/src/modules/disaggregation/disaggregation.service.ts`.
- Strict contracts: Zod schemas in `packages/platform-contracts` are parsed by `ZodValidationPipe` (`apps/api/src/zod.pipe.ts`), which returns 400 with issue paths; `.strict()` objects reject unknown keys, which is how a supplied `tlc` is refused.
- Admin gating and page conventions as in US-03 (`useCan`, `RequireCapability`, `apiFetch`, `@markiro/ui`, i18n en/ru with missing-key failure).

## Design

### Data model

Additive migration `01NN_us_05_shipping_events.sql` after US-03/US-04. Tables in `packages/db/src/schema/traceability.ts`.

Enums:

- `shipping_flow_kind` (P1, SHP-008): `standard`, `direct_to_consumer`, `donation`, `intra_company_transfer`.

`shipping_events` (subtype, 1:1 with the shell):

| Column                                     | Type / rule                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| event_id                                   | uuid PK; composite FK `(tenant_id, event_id)` → `traceability_events(tenant_id, id)` with `type = 'shipping'` (CHECK via helper function) |
| tenant_id                                  | text NOT NULL                                                                                                                             |
| recipient_location_id                      | uuid NULL → `traceability_locations` (composite); immediate subsequent recipient, never a transporter                                     |
| recipient_location_snapshot                | jsonb NULL; built at finalization                                                                                                         |
| carrier_reference                          | text NULL; operational only (transporter name/PRO number), never exported as a KDE                                                        |
| flow_kind                                  | `shipping_flow_kind` NOT NULL default `standard` (P1)                                                                                     |
| flow_warning_acknowledged_at / _by_user_id | timestamptz / text NULL (P1); set when the user confirms a same-address or non-standard flow warning                                      |

Ship-from is the shell's `location_id`/`location_snapshot` (the tenant's own location with role `ship-from`); `date_shipped` is the shell's `event_date`.

`shipping_event_items`:

| Column              | Type / rule                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| id, tenant_id       | uuid PK; tenant                                                                                                            |
| event_id            | uuid NOT NULL; composite FK → `shipping_events(tenant_id, event_id)`                                                       |
| line_no             | integer NOT NULL; `unique(tenant_id, event_id, line_no)`                                                                   |
| lot_id              | uuid NOT NULL; composite FK → `traceability_lots(tenant_id, id)`; `unique(tenant_id, event_id, lot_id)` (OQ-US05-4)        |
| quantity            | numeric(18,3) NOT NULL CHECK > 0                                                                                           |
| unit_of_measure     | text NOT NULL; code of US-02 `UOM_CODES_V1`                                                                                |
| tlc_snapshot        | text NULL; copied from the lot at finalization                                                                             |
| tlc_source_snapshot | jsonb NULL; `{ kind: "location", location: <Location Description> }` or `{ kind: "reference", reference }` at finalization |
| product_snapshot    | jsonb NULL; US-02 `buildProductDescriptionSnapshot` of the lot's product at finalization                                   |
| notes               | text NULL                                                                                                                  |

There is deliberately no `tlc`, `product_id` or `tlc_source_*` input column: the line identifies an existing lot only (SHP-003). TLC, source and product are derived from the lot and frozen as snapshots at finalization.

`shipping_event_item_boxes` (P1, SHP-006):

| Column                       | Type / rule                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| tenant_id, item_id, box_id   | PK; composite FKs → `shipping_event_items(tenant_id, id)` and `boxes(tenant_id, id)` |
| sscc_snapshot                | char(18) NOT NULL; copied from `boxes.sscc` at link time                             |
| linked_at, linked_by_user_id |                                                                                      |

Partial unique index `(tenant_id, box_id) WHERE <parent event status IN ('finalized')>` cannot be expressed directly; instead the service enforces "a box is in at most one non-void, non-superseded shipping item" under `FOR UPDATE` on the box row, and a nightly consistency check (US-06 readiness) reports violations. Boxes must be linked to the item's lot in `trace_lot_boxes` (US-04); if US-04 is not merged, the table is created but the endpoint answers 409 `case_selection_unavailable`.

Lot balance is not stored. It is computed per lot from finalized, non-superseded events: `origin_quantity − Σ shipping_event_items.quantity − Σ transformation input usage` in the lot's origin UOM; lines with a different UOM are excluded from the balance and flagged (`uom_mismatch` warning). Balance queries are indexed by `(tenant_id, lot_id)` on the item tables.

### Domain rules

`packages/domain/src/traceability/shipping/`:

- `completeness.ts`: `validateShippingCompleteness(input): CompletenessIssue[]` with the same issue shape as receiving. Errors (SHP-007): `event_date` (date shipped) missing; ship-from location missing or description invalid (US-01 validator); recipient missing, invalid, or equal to the ship-from location id; recipient location has role `transporter` only (US-01 roles; if US-01 has no transporter role, this check is dropped); no items; per item: lot not found in tenant, lot status not in `{active, shipped}` (`quarantined`, `recalled` → `lot_blocked`; `consumed`, `archived` → `lot_unavailable`), lot without TLC source location or reference (`lot_source_missing`, LOT-003), lot product traceability profile incomplete or coverage status unknown under `US_FSMA204_PROCESSOR` (`product_coverage_unknown`), quantity/UOM invalid; no reference document of any type under `US_FSMA204_PROCESSOR` (SHP-005; warning under generic, same rule as OQ-US03-7). Warnings: `over_shipment` when quantity exceeds the computed balance (P0 warning, not error; OQ-US05-3), `uom_mismatch`, `same_address_flow` when normalized street + ZIP of ship-from and recipient snapshots match (LOC-007, SHP-008), `non_standard_flow` when `flow_kind` is not `standard`; warnings with `requiresAcknowledgement: true` block finalization until `flow_warning_acknowledged_at` is set (P1).
- `no-new-tlc.ts`: `assertShippingLineHasNoLotIdentity(payload)` — a defensive check used by the service in addition to strict Zod: any of `tlc`, `tlcSourceLocationId`, `tlcSourceReference`, `productId`, `createLot`, `assignTlc` present → `shipping_cannot_assign_tlc`. Unit-tested as the acceptance §2.4 negative case.
- `balance.ts`: `computeLotBalance({ origin, shipments, transformations })` → `{ originQuantity, unit, shipped, consumed, remaining, excludedLines[] }`, pure and deterministic.
- `lot-status.ts`: `deriveLotStatusAfterShipping(lot, balance)` → `shipped` when `remaining <= 0` in origin UOM, otherwise unchanged (`active`); on void/amend the same function recomputes and may return `active` again, which needs a `shipped → active` transition that US-02's `assertLotTransition` table does not list yet (OQ-US05-5). A derived label `partially_shipped` is computed for UI/export from `status = active && shipped > 0` and is not stored (OQ-US05-1).
- `flow-warnings.ts` (P1): same-address normalization (`street_address` lowercase, whitespace collapsed, ZIP first five digits) and the warning copy keys; the copy never states a legal conclusion, only that the user must classify the flow.
- `imports/shipping-csv.ts` (P1, SHP-009): `SHIPPING_CSV_COLUMNS` (`tlc, tlc_source, quantity, unit_of_measure, sscc_list, notes`) where `tlc` + `tlc_source` resolve to an existing lot only; unresolved lot → row rejected with `lot_not_found`, never created. `exportShippingCsv(event)` produces the mirror file for partner exchange.

### Contracts and API

Zod schemas in `packages/platform-contracts/src/traceability/shipping.ts`, all `.strict()`. `shippingItemInputSchema = z.object({ lotId: uuid, quantity: decimalString, unitOfMeasure, notes? }).strict()` — no TLC field exists, so `tlc: "NEW"` fails with a 400 unknown-key issue at `items.0.tlc`.

Controller `apps/api/src/modules/traceability/shipping/shipping.controller.ts` with the same guards, profile gate and idempotency as receiving:

| Method            | Path                                                                                | Capability (US-00 names)             | Notes                                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET               | `/traceability/shipments`                                                           | `traceability.read`                  | Filters `status`, `from`, `to`, `recipientLocationId`, `q`, `includeSuperseded`                                                                                                                                                                   |
| POST              | `/traceability/shipments`                                                           | `traceability.shipping.write`        | Header + `items[]` + `documentIds[]` + `idempotencyKey`                                                                                                                                                                                           |
| GET               | `/traceability/shipments/:id`                                                       | `traceability.read`                  | Includes per-line `balanceBefore/After` and warnings                                                                                                                                                                                              |
| PATCH             | `/traceability/shipments/:id`                                                       | `traceability.shipping.write`        | Draft only                                                                                                                                                                                                                                        |
| POST/PATCH/DELETE | `/traceability/shipments/:id/items[/:itemId]`                                       | `traceability.shipping.write`        | Draft only; lot validated for tenant and status                                                                                                                                                                                                   |
| PUT               | `/traceability/shipments/:id/documents`                                             | `traceability.shipping.write`        |                                                                                                                                                                                                                                                   |
| GET               | `/traceability/shipments/:id/completeness`                                          | `traceability.read`                  | Dry-run                                                                                                                                                                                                                                           |
| POST              | `/traceability/shipments/:id/finalize`                                              | `traceability.qa.manage` (OQ-US03-3) | 409 `event_incomplete`; 409 `flow_warning_unacknowledged` (P1)                                                                                                                                                                                    |
| POST              | `/traceability/shipments/:id/acknowledge-flow-warning`                              | `traceability.shipping.write` (P1)   | Body `{ flowKind }`                                                                                                                                                                                                                               |
| POST              | `/traceability/shipments/:id/amend` / `/void`                                       | `traceability.qa.manage`             | As US-03; lot status recomputed                                                                                                                                                                                                                   |
| GET               | `/traceability/shipments/:id/revisions`                                             | `traceability.read`                  |                                                                                                                                                                                                                                                   |
| GET               | `/traceability/shipments/lot-candidates`                                            | `traceability.read`                  | Query `productId?`, `q` (TLC), `locationId?`; returns lots with status, origin quantity, computed balance, derived `partiallyShipped`                                                                                                             |
| PUT               | `/traceability/shipments/:id/items/:itemId/boxes`                                   | `traceability.shipping.write` (P1)   | Body `{ boxIds[] }` or `{ ssccs[] }`; validates closed, not disassembled, linked to the lot in `trace_lot_boxes`, not in another live shipping item; if `unitOfMeasure = "case"` the UI offers to set `quantity = boxes.length` (never automatic) |
| POST              | `/traceability/shipments/imports` (+ `/:runId`, `/apply`, `/reject`, `/errors.csv`) | write/read (P1, SHP-009)             | Reuses `traceability_import_runs` with `kind = shipping_csv`                                                                                                                                                                                      |
| GET               | `/traceability/shipments/:id/export.csv`                                            | `traceability.read` (P1, SHP-009)    | Partner-facing mirror of the lines; `mapping_version` header                                                                                                                                                                                      |

Finalization transaction (`shipping.service.ts`):

1. `FOR UPDATE` on the shell; assert draft. `FOR UPDATE` on every referenced `traceability_lots` row (ordered by id to avoid deadlocks).
2. Load ship-from and recipient locations, lots with product profiles, balances (finalized non-superseded lines of other events), documents.
3. `validateShippingCompleteness`; errors → 409 `event_incomplete`; unacknowledged blocking warnings → 409 `flow_warning_unacknowledged`.
4. Snapshots: shell `location_snapshot` (ship-from), `recipient_location_snapshot`, per line `tlc_snapshot`, `tlc_source_snapshot`, `product_snapshot`, document snapshots.
5. Shell → `finalized`; previous revision → `amended` when `revision > 1`.
6. For each lot: recompute balance including this event; `deriveLotStatusAfterShipping`; if changed, update `traceability_lots.status` through the US-02 lot service so its own audit row (`traceability.lot.status_changed`, LOT-009) is written.
7. Audit `tenant_audit_events`: `action = "traceability.shipping.finalized"`, `outcome = "success"`, `target_type = "traceability_event"`, `target_id`, `after = { type: "shipping", eventNumber, revision, previousRevisionId, lotIds, lotStatusChanges: [{ lotId, from, to }], documentIds, recipientLocationId }`.

Void of a finalized shipping recomputes balances and may move lots back from `shipped` to `active`, audited the same way. Amendment: the successor's finalization uses balances that exclude the superseded revision.

Rejection cases (tested): payload with `tlc`, `productId`, `createLot` → 400 (strict schema); lot id from another tenant → 404 `lot_not_found`; lot `quarantined` → 409 on finalize (`lot_blocked`), but the draft line can be saved so the operator sees the blocker in the completeness panel.

### Admin UI

`apps/admin/src/pages/traceability/shipping/`: `index.tsx` (list), `ShippingForm.tsx`, `ShippingDetailPage.tsx`, `LotPicker.tsx`, `CaseSelector.tsx` (P1), `FlowWarningDialog.tsx` (P1), `api.ts`; routes `/traceability/shipping`, `/new`, `/:eventId`; navigation `nav.traceability.shipping` gated by profile and `traceability.read`.

- `LotPicker`: combobox over `lot-candidates` with search by TLC; each option shows product, TLC, source, status chip and remaining balance ("100 case remaining"); a lot with status `quarantined`/`recalled` is listed disabled with the reason. There is no "new lot" affordance anywhere on the shipping screens.
- Line editor: lot, quantity, UOM (defaults to the lot's origin UOM), inline over-shipment warning text.
- `CaseSelector` (P1): SSCC input reusing the code-search classify call and `formatSsccHri`; scanned boxes listed with remove buttons; counter "N of M cases in lot"; a "set quantity from cases" button.
- Detail: KDE groups as data-dictionary §7.5, completeness panel, finalize/amend/void dialogs with mandatory reason fields, revision banner, warnings panel with the classification select (P1) and explicit acknowledgement checkbox whose label says the classification is the user's own.
- Lot card link (US-06) shows shipments and the derived "partially shipped" label.
- i18n keys `pages.traceability.shipping.*` in `en.json` and `ru.json`; allowed wording only. Accessibility as US-03 (labels, focus trap, text statuses, keyboard-only pass).

### Station

Not touched. Case selection in P1 is a cabinet feature; a future station outbound scan would post `ssccs[]` to the boxes endpoint through the same contract.

### Profile gating and RU_CHZ safety

- All routes are behind US-00's `RequireTraceabilityProfile` guard; RU tenants see no navigation and get 403 `traceability_profile_required`. No existing table changes; the only reference into the RU domain is the optional composite FK to `boxes(tenant_id, id)`, which is additive and does not alter `boxes`.
- `US_GENERIC_LOT_TRACEABILITY` uses the same screens with the document rule relaxed to a warning and without FTL coverage checks; no FTR wording appears in that profile.
- Proof: RU suite unchanged; e2e asserts an `RU_CHZ` tenant is denied on `/traceability/shipments`; schema test asserts `boxes` columns and constraints are unchanged after the migration.

## Testing

- Domain: `validateShippingCompleteness` per issue code; `assertShippingLineHasNoLotIdentity` rejects every identity key; `computeLotBalance` with partial shipments, mixed UOM exclusion, void/amend exclusion; `deriveLotStatusAfterShipping` transitions `active → shipped → active` (void); same-address normalization (P1).
- DB: schema metadata; fresh + upgrade migration; immutability trigger on `shipping_event_items` after finalization; `quantity > 0` CHECK; composite FK to `boxes` rejects a cross-tenant box.
- API e2e (`apps/api/test/traceability-shipping.e2e.test.ts`): receive lot A (US-03 fixtures, so the suite runs even if US-04 is not merged), ship 20 of 50 bags → lot stays `active`, balance 30, `partiallyShipped = true`; ship the remaining 30 → `shipped`; void the second shipment → `active`; amendment changes quantity and the balance follows the latest revision; negative "shipping tries to create new TLC → rejected" (400 on `tlc`, `productId`, `createLot`; 404 on foreign `lotId`); `quarantined` lot blocks finalization; recipient equal to ship-from blocks; missing BOL/invoice blocks in FSMA profile; cross-tenant recipient location → 404; capability denial; audit rows asserted by fields including `after.lotStatusChanges`; master data edit after finalization leaves the recipient snapshot unchanged.
- Admin tests: lot picker renders balances and disables blocked lots; no create-lot control exists (assert absence); finalize disabled while issues exist; flow warning acknowledgement (P1).
- Demo numbers (SHP-010, C-009): one shipping event `SHP-26-0001`, one line, lot `NRF-260915-APL01`, `100 case`, product snapshot "Fresh-Cut Apple Snack Cups / North River / 6 oz cups, 24 cups/case", ship-from North River Fresh Foods (Portland, OR), recipient Harbor Market Distribution Center (Seattle, WA), `event_date 2026-09-16` (`dateShipped`), documents `BOL-0916-H` (`bol`) and `INV-2026-0916-047` (`invoice`); after finalization the lot status is `shipped` with balance 0 of 100 case; forward trace from either inbound lot (US-06) reaches this event and the recipient. When US-04's bridge exists, the seed links the 100 boxes of the linked shift to the line (P1 detail; the KDE quantity does not depend on it).

## Evidence

- Golden fixture `tools/us-demo/fixtures/shipping-2026-09-16.json` and the completeness output with zero errors.
- Screenshots: shipping list, lot picker with balance, shipping card with recipient, ship-from, BOL/invoice, finalize dialog, lot card showing `shipped`.
- API transcript of the rejected "new TLC" request for the negative-test evidence row.
- Verification report (acceptance §3) and `docs/us/requirements-traceability.md` rows SHP-001…010.

## Out of scope

Transporter records and carrier integrations; ASN/EDI providers (INT-006, P2); EPCIS; automatic legal classification of direct-to-consumer, donation or intra-company flows (the product only warns and records the user's classification); pallet-level (SSCC-of-SSCC) shipping; inventory or ERP-style stock accounting beyond the computed lot balance; returns/receiving-back flows; station outbound scanning (US-10 or later).

## Open questions

| ID         | Question                                                                                                               | Options                                                                                                                                                                     | Recommendation                                                                                                                                     | Blocking? |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| OQ-US05-1  | How does a partial shipment map to LOT-009 statuses, which have no `partially_shipped` value?                          | (a) keep `active` until balance is 0, then `shipped`, derive a "partially shipped" label; (b) add `partially_shipped` to the enum in US-02; (c) `shipped` on first shipment | (a): enum stays as specified; label derived from balance; US-02 need not change                                                                    | no        |
| OQ-US05-2  | Where does the lot's origin quantity/UOM come from for the balance? US-02's lot table has no quantity column           | join the originating line through `origin_event_id` (`receiving_event_items.lot_id`, US-04 `transformation_output_lots`); add `origin_quantity`/`origin_uom` to lots        | join through `origin_event_id`; no lot column, no US-02 change; manual lots (`POST /traceability/lots`) have no balance and show "balance unknown" | no        |
| OQ-US05-3  | Over-shipment (quantity above remaining balance): warning or error?                                                    | warning in P0; error; tenant setting                                                                                                                                        | warning in P0 (balance is operational, not a KDE); tenant setting in P1                                                                            | no        |
| OQ-US05-4  | Same lot on two lines of one shipping event?                                                                           | forbid (`unique(event, lot)`); allow for different UOMs                                                                                                                     | forbid in P0; a second UOM is a second event or a converted quantity                                                                               | no        |
| OQ-US05-5  | US-02's transition table has no `shipped → active`; how does a void/amend that restores balance re-open the lot?       | US-02 adds `shipped → active` (system-only, reason = event id); lot stays `shipped` and only the balance changes; QA re-opens manually                                      | US-02 adds `shipped → active` restricted to the shipping service (audited with the void/amend event id); the validator checks balance, not status  | no        |
| OQ-US05-6  | Does US-01 define a `transporter` role so the validator can reject it as recipient?                                    | US-01 adds the role; US-05 relies on the label "excluding transporter" only                                                                                                 | US-01 adds `transporter` to LOC-006 roles; otherwise the check is a UI hint only                                                                   | no        |
| OQ-US05-7  | Case selection availability when US-04's `trace_lot_boxes` is not merged                                               | hide the feature; create the table and answer 409                                                                                                                           | create the table now, 409 `case_selection_unavailable` until the bridge exists                                                                     | no        |
| OQ-US05-8  | Per-partner "case scans required" flag: read from the US-06 partner expectation profile (TRC-007) or a tenant setting? | partner profile; tenant setting; both                                                                                                                                       | partner profile when US-06 delivers TRC-007; until then no requirement can be configured, matching "never mandatory for FTR minimum"               | no        |
| OQ-US05-9  | Where do `traceability_import_runs` for shipping live in the P0 interface (SHP-009)?                                   | reuse US-03 table with `kind = shipping_csv`; separate table                                                                                                                | reuse; one audit shape for all import runs (INT-008)                                                                                               | no        |
| OQ-US05-10 | Under `US_GENERIC_LOT_TRACEABILITY`, is BOL/invoice/ASN mandatory for finalization?                                    | mandatory; warning only                                                                                                                                                     | warning only, consistent with OQ-US03-7                                                                                                            | no        |
