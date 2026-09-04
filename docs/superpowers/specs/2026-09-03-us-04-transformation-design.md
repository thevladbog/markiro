# US-04 — Transformation CTE and shift/box bridge — Design Spec

**Date:** 2026-09-03

**Status:** Draft for review (not implemented)

**Slice:** US-04 from docs/us/implementation-plan.md; depends on US-02 (lots, genealogy edges, product description snapshot) and US-03 (traceability event shell, reference documents, location snapshot)

**Requirements:** TRN-001, TRN-002, TRN-003, TRN-004, TRN-005, TRN-006, TRN-007, TRN-008, TRN-009, TRN-010, TRN-011, TRN-012, TRN-013, TRN-014, LOT-010

**Related:**

- `docs/superpowers/specs/2026-09-03-us-02-product-profiles-and-lots-design.md` — `traceability_lots`, `lot_genealogy_edges`, `buildProductSnapshot`, lot status machine.
- `docs/superpowers/specs/2026-09-03-us-03-receiving-and-documents-design.md` — `traceability_events` shell, `reference_documents`, `traceability_event_documents`, lifecycle helpers.
- `docs/superpowers/specs/2026-09-03-us-00-regulatory-profile-design.md` — `RequireTraceabilityProfile`, the `traceability.*` capabilities, `ProfileOnly`.
- `docs/superpowers/specs/2026-09-03-us-01-parties-locations-design.md` — `traceability_locations` and `buildLocationDescriptionSnapshot`.
- `docs/superpowers/specs/2026-09-03-us-traceability-design.md` — founding ADR.
- `docs/superpowers/specs/2026-08-28-product-archived-flag-design.md` — draft/archived gates in `createShift`.
- `docs/us/data-dictionary.md` §4, §6, §7.4, §8, §9; `docs/us/demo-scenario.md` §5.2–5.5; `docs/us/acceptance.md` §2.2, §2.4, C-008.

## Problem

A processor turns received lots into new lots. The rule's Transformation CTE needs, per finalized event, every FTL input lot with quantity, every output lot with a new TLC assigned at the processor location, a completion date, reference documents and explicit input→output genealogy. Markiro already has the physical side of this — a shift that closes boxes with SSCCs — and must expose it as optional operational detail without copying scan data or changing the RU box model.

## Key facts of the codebase

- `shifts` (`packages/db/src/schema/platform.ts`): `status` enum `planned | active | closed`, `mode` enum `validation | aggregation`, `product_id` composite FK to `products`, `production_date date` ("declared civil production day"), `planned_date`, `first_box_closure_at`, `opened_at`, `closed_at`, `close_reason`, `number_month_key` + `number_seq` (human number `AUG26-003`), `unique (tenant_id, id)`.
- Close semantics: `POST /shifts/:id/close` is cabinet-only (`@RequirePermissions(OPERATIONS_WRITE)`, `apps/api/src/modules/shifts/shifts.controller.ts`); `ShiftsService.closeShift` moves `active → closed` in one conditional `UPDATE`, stamps `closed_at = now()` and `close_reason` (`closeShiftSchema.reason` min 3). Late scans after close are marked by `late_data_at`. The effective production day used by listings and exports is `coalesce(production_date, planned_date)` (`shifts.service.ts`, `shift-export-source.service.ts`).
- `boxes` (`platform.ts`): `id`, `tenant_id`, `shift_id` (composite FK `boxes_tenant_shift_fk`), `sscc char(18)` nullable with `boxes_tenant_sscc_uq`, `closed_at` (device time), `closure_received_at` (server time), `disassembled_at` (retired box), `print_verified_at`, `print_skipped_at`, `registry_version`; `unique (tenant_id, id)`. A `boxes` row is created when its **first item** arrives and a null `sscc` means the closure has not arrived; a zero-item closure has no `boxes` row at all (see the `first_box_closure_at` comment). `box_items` hold KM code hashes.
- Boxes of a shift are read by `BoxesService.listBoxes` (`apps/api/src/modules/boxes/boxes.service.ts`, `GET /boxes?shiftId=`): tenant-scoped join to `box_items`, `itemCount` excludes displaced/removed items, `disassembledAt` lets a UI exclude retired boxes, ordered `closed_at DESC NULLS FIRST`.
- Station mirror: `boxes_mirror` and `shift_mirror` in `packages/db/src/sqlite/schema.ts` carry no lot fields; `STATION_MIGRATIONS` is additive-only. `shift_mirror.production_date` is already synced.
- Products for shifts: `createShift` rejects `status === "draft"` and `archived` products (`shifts.service.ts`); `ProductsService.computeStatus` requires `chz_product_group_code` for `active` (see OQ-US02-2).
- Audit: `tenant_audit_events` (`packages/db/src/schema/team.ts`) written by services with `action`, `outcome`, `target_type`, `target_id`, `before`, `after`, `request_id`.
- Time zone: `org_profiles.time_zone` (`packages/db/src/schema/org-profile.ts`), default `Europe/Moscow`; U.S. tenants get an explicit zone in US-00.
- Composite-FK and schema test idioms: `packages/db/test/tenant-isolation.test.ts`, `label-template-scope.test.ts`; API e2e bootstrap in `apps/api/test/chz-product-groups.e2e.test.ts` with `signUpAndActivate` from `apps/api/test/support/auth.ts`.

Entities owned by US-03 that this slice uses as specified there (not redesigned here):

- `traceability_events` shell: `id`, `tenant_id`, `type` (`traceability_event_type`), `event_number` from `traceability_event_counters` (transformations get `TRN-YY-NNNN`, kept across revisions), `revision`, `root_event_id`, `previous_revision_id`, `superseded_by_event_id`, `status` (`draft | finalized | amended | void`), `source`, `location_id` → `traceability_locations`, `location_snapshot`, `amendment_reason`, `finalized_at` / `finalized_by_user_id`, `voided_at` / `voided_by_user_id` / `void_reason`, `idempotency_key`, `notes`; `unique (tenant_id, id)`, `unique (tenant_id, root_event_id, revision)`; immutability trigger `traceability_events_immutable_finalized` and helper `traceability_event_is_finalized(tenant_id, event_id)` that subtype and item tables reuse.
- `reference_documents` with `reference_document_type` including `work_order`, `batch_log`, `production_log`, `other`; the link table `traceability_event_documents(tenant_id, event_id, document_id, document_type_snapshot, document_number_snapshot)`; frozen documents answer 409 `document_frozen`.
- Domain helpers `events/lifecycle.ts` (`canTransition`, `nextRevision`) and `quantity.ts` (`parseQuantity`); `buildLocationDescriptionSnapshot` from US-01.

## Design

### Data model

Additive migration `0116_us_traceability_transformation.sql` (after US-03 `0115`; renumber at implementation time to the next free number) in `packages/db/src/schema/traceability.ts`.

Enum `transformation_reason`: `commingling_and_repacking`, `repacking`, `relabeling`, `processing`, `other` (TRN-004). `other` requires `reason_note`.

Enum `trace_lot_box_link_source`: `shift_link`, `manual`, `station` (the last reserved for US-10).

`transformation_events` (one row per event revision):

| Column                                          | Type / rule                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `event_id`, `tenant_id`                         | `event_id` uuid PK; composite FK `(tenant_id, event_id)` → `traceability_events(tenant_id, id)`; `unique (tenant_id, event_id)` (same shape as `receiving_events`) |
| `reason`, `reason_note`                         | enum NOT NULL; text                                                                                                                                                |
| `completed_on`                                  | `date` NOT NULL at finalization (the KDE "transformation completed date", TRN-007)                                                                                 |
| `completed_at`, `completed_time_zone`           | `timestamptz` + IANA text, both set together; zone copied from `org_profiles.time_zone` when the form is saved                                                     |
| `shift_id`                                      | `uuid` nullable; composite FK `transformation_events_tenant_shift_fk` to `shifts(tenant_id, id)` (TRN-001)                                                         |
| `planned_output_quantity`, `planned_output_uom` | `numeric(14,3)` + text, operational (TRN-012, P1)                                                                                                                  |
| `waste_quantity`, `waste_uom`                   | `numeric(14,3)` + text, operational (TRN-006, P1)                                                                                                                  |
| `notes`                                         | text                                                                                                                                                               |

Partial unique `transformation_events_tenant_shift_uq` on `(tenant_id, shift_id) WHERE shift_id IS NOT NULL` is **not** added: amendments create a new revision that links the same shift; uniqueness across non-void latest revisions is a service rule (OQ-US04-9). Whenever a request sets or keeps `shift_id` (create, update, finalize), the service first takes `SELECT … FOR UPDATE` on the `shifts` row, then runs the closed-shift check and the one-active-event-per-shift check, and holds the lock until the event row is written, so two concurrent requests cannot both link the same shift. `transformation_events`, `transformation_input_lots` and `transformation_output_lots` get US-03's immutability trigger keyed on `traceability_event_is_finalized`; `trace_lot_boxes` deliberately does not (OQ-US04-16).

`transformation_input_lots` (TRN-002, TRN-011):

| Column                          | Type / rule                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`                            | `uuid` PK                                                                                                               |
| `tenant_id`, `event_id`         | composite FK to `transformation_events(tenant_id, event_id)`                                                            |
| `line_no`                       | int; unique `(tenant_id, event_id, line_no)`                                                                            |
| `lot_id`                        | `uuid` nullable; composite FK to `traceability_lots(tenant_id, id)`; unique `(tenant_id, event_id, lot_id)` partial     |
| `regulated`                     | boolean NOT NULL; `true` = FTL input that must carry a lot with TLC and source                                          |
| `ingredient_description`        | text; CHECK `lot_id IS NOT NULL OR ingredient_description IS NOT NULL`; CHECK `regulated = false OR lot_id IS NOT NULL` |
| `quantity_used`, `quantity_uom` | `numeric(14,3)` NOT NULL > 0, text NOT NULL                                                                             |
| `consumes_lot`                  | boolean NOT NULL DEFAULT true; drives the `active → consumed` transition (OQ-US04-4)                                    |
| `product_snapshot`              | jsonb; filled at finalization from US-02's builder (input product description)                                          |

`transformation_output_lots` (TRN-003):

| Column                             | Type / rule                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `id`                               | `uuid` PK                                                                                                                 |
| `tenant_id`, `event_id`, `line_no` | as above                                                                                                                  |
| `product_id`                       | composite FK to `products(tenant_id, id)`                                                                                 |
| `tlc`                              | text NOT NULL (normalized by `normalizeTlc`); uniqueness is enforced on the lot row at finalization                       |
| `quantity`, `quantity_uom`         | `numeric(14,3)` NOT NULL > 0, text NOT NULL                                                                               |
| `production_date`, `expiry_date`   | `date`; copied to the lot (LOT-011 operational)                                                                           |
| `lot_id`                           | `uuid` nullable until finalized; composite FK to `traceability_lots(tenant_id, id)`; unique `(tenant_id, lot_id)` partial |
| `product_snapshot`                 | jsonb at finalization                                                                                                     |

`trace_lot_boxes` (LOT-010, TRN-010 — bridge, no change to `boxes`):

| Column                         | Type / rule                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `id`                           | `uuid` PK                                                                             |
| `tenant_id`, `box_id`          | composite FK `trace_lot_boxes_tenant_box_fk` to `boxes(tenant_id, id)`                |
| `lot_id`                       | composite FK to `traceability_lots(tenant_id, id)`                                    |
| `event_id`                     | `uuid` nullable; composite FK to `transformation_events` when created by a shift link |
| `link_source`                  | enum NOT NULL                                                                         |
| `linked_at`, `linked_by`       | `timestamptz` NOT NULL default now; `text` FK `user.id` set null                      |
| `unlinked_at`, `unlink_reason` | `timestamptz`, text; rows are never deleted                                           |

Partial unique `trace_lot_boxes_active_box_uq` on `(tenant_id, box_id) WHERE unlinked_at IS NULL` — one box belongs to at most one active lot. Index `(tenant_id, lot_id) WHERE unlinked_at IS NULL` for the lot card count.

FK additions to US-02 tables in the same migration: `lot_genealogy_edges.transformation_event_id` → `transformation_events(tenant_id, event_id)` composite; `traceability_lots.origin_event_id` stays as US-03 defined it.

### Domain rules

`packages/domain/src/traceability/transformation.ts`, pure and fixture-tested:

- `validateTransformationForFinalization(event, inputs, outputs, documents, profiles, tenantProfileCode)` returns a `CompletenessReport { ok, issues: { scope: "event" | "input" | "output" | "documents", lineNo?, field, code }[] }` (TRN-013). Rules: reason present (`other` needs note); `completed_on` and time zone present; event location present (it becomes the TLC source, LOT-006); at least one output; every output has product, TLC, quantity > 0 and UOM; every `regulated` input has `lot_id`, the lot passes `assertLotFinalizable` (US-02), and the lot status must be `active` (any other status — `quarantined`, `consumed`, `shipped`, `recalled`, `archived` — is rejected with `LOT_NOT_ACTIVE`); quantity > 0 and UOM on every input; at least one reference document of type `work_order`, `batch_log` or `production_log` (OQ-US04-5); under `US_FSMA204_PROCESSOR` every output product's coverage is not in `EXPORT_BLOCKING_COVERAGE` (REG-003, acceptance §2.4) and at least one output is `covered`/`contains_ftl_same_form` or the event is flagged `non_ftl_transformation` (informational). TRN-011: zero regulated inputs is valid; unregulated lines never require a TLC.
- `planGenealogyEdges(inputs, outputs)` — deterministic cross product of regulated inputs × outputs, ordered by `(input.lineNo, output.lineNo)`; `quantityUsed` is set only when there is exactly one output (OQ-US04-3).
- `selectLinkableBoxes(boxes)` — `closedAt != null && sscc != null && disassembledAt == null`, ordered by `sscc`.
- `computeYield(inputs, outputs, waste)` — only when all quantities share one UOM; otherwise returns `{ comparable: false }`; labelled operational (TRN-006, P1).
- `nextRevision(event)` and `amendmentDiff(prev, next)` for the amendment audit payload.

### Contracts and API

Zod in `packages/platform-contracts/src/traceability/transformations.ts`: `transformationReasonSchema`, `transformationInputLineSchema`, `transformationOutputLineSchema`, `createTransformationSchema` (header + optional `shiftId` + lines + document refs), `updateTransformationSchema` (draft only, whole line arrays replace, OQ-US04-10), `transformationDetailSchema` (event shell + lines + `completeness` + `boxes: { linked, total, sample }`), `amendTransformationSchema { reason }`, `voidTransformationSchema { reason }`, `linkLotBoxesSchema { boxIds[] }`.

Controller `apps/api/src/modules/traceability/transformations.controller.ts` (`TenantGuard, AuthorizationGuard, SubscriptionAccessGuard, TraceabilityProfileGuard`; `@RequireTraceabilityProfile("US_FSMA204_PROCESSOR", "US_GENERIC_LOT_TRACEABILITY")`, RU tenants get 403 `traceability_profile_required`):

| Method | Route                                            | Capability (US-00)                  | Behaviour                                                                                                                                                                                                                                      |
| ------ | ------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/traceability/transformations`                  | `traceability.read`                 | List: status, date range, product, lot, shift filters                                                                                                                                                                                          |
| POST   | `/traceability/transformations`                  | `traceability.transformation.write` | Creates the shell row (`type = transformation`, `status = draft`, revision 1, `event_number` from the counter, optional `idempotencyKey` as in US-03) + lines; `shiftId` must be tenant's and `closed` (409 `SHIFT_NOT_CLOSED`, 404 otherwise) |
| GET    | `/traceability/transformations/:id`              | `traceability.read`                 | Detail with completeness report and bridge summary                                                                                                                                                                                             |
| PATCH  | `/traceability/transformations/:id`              | `traceability.transformation.write` | Draft only (409 `EVENT_NOT_DRAFT`); replaces lines; no output lot rows are created yet                                                                                                                                                         |
| GET    | `/traceability/transformations/:id/completeness` | `traceability.read`                 | Dry-run of the validator (TRN-013)                                                                                                                                                                                                             |
| POST   | `/traceability/transformations/:id/finalize`     | `traceability.qa.manage`            | Transactional finalization (below); idempotent: already finalized → 200 same body                                                                                                                                                              |
| POST   | `/traceability/transformations/:id/amend`        | `traceability.qa.manage`            | `nextRevision`: new draft with the same `root_event_id`/`event_number`, `revision + 1`, `previous_revision_id`, mandatory `amendment_reason`; returns the draft (TRN-009)                                                                      |
| POST   | `/traceability/transformations/:id/void`         | `traceability.qa.manage`            | Reason mandatory; 409 `DOWNSTREAM_EXISTS` when an output lot is referenced by a finalized shipping/transformation                                                                                                                              |
| GET    | `/traceability/transformations/shift-candidates` | `traceability.read`                 | Closed shifts of the tenant with product, number, effective production date, linkable box count                                                                                                                                                |
| GET    | `/traceability/lots/:lotId/boxes`                | `traceability.read`                 | Active bridge rows with SSCC (formatted with AI 00 as `BoxDto` does), closed_at, link source                                                                                                                                                   |
| POST   | `/traceability/lots/:lotId/boxes`                | `traceability.transformation.write` | Manual link of `boxIds`; 409 `BOX_ALREADY_LINKED` names the other lot                                                                                                                                                                          |
| POST   | `/traceability/lots/:lotId/boxes/unlink`         | `traceability.transformation.write` | Sets `unlinked_at` + reason                                                                                                                                                                                                                    |

Finalization (one transaction, event row and referenced lot rows locked `FOR UPDATE`, in this order):

1. Run the validator; on failure return 422 `TRANSFORMATION_INCOMPLETE` with the report (no partial writes).
2. Snapshot: `location_snapshot` on the shell (US-01 builder), `product_snapshot` on every line (US-02 builder). Later master-data edits do not touch these rows (data-dictionary §4).
3. For every output line create the `traceability_lots` row: `assignment_basis = transformation`, `source_location_id = event.location_id`, `status = active`, `production_date = line.production_date ?? completed_on`, `origin_event_id = event.id`; a LOT-007 duplicate maps to 409 `TLC_DUPLICATE_AT_SOURCE`. Set `line.lot_id` (LOT-006).
4. Insert `lot_genealogy_edges` from `planGenealogyEdges`; run `wouldCreateCycle` (US-02) defensively.
5. Inputs with `consumes_lot = true`: `active → consumed` through `assertLotTransition`, one audit row each.
6. If `shift_id` is set and there is exactly one output line: insert `trace_lot_boxes` for `selectLinkableBoxes(listBoxes(shift))` with `link_source = shift_link`; a box that already has an active `trace_lot_boxes` row for this same output lot is skipped (a retried finalize or an amended revision must not hit `trace_lot_boxes_active_box_uq`); a box actively linked to a different lot aborts with 409. With several outputs nothing is auto-linked and the response carries `boxes.hint = "manual_link_required"` (OQ-US04-15). No `box_items`, scans or SSCC data are copied (TRN-001).
7. Update the shell through `canTransition`: `status = finalized`, `finalized_at`, `finalized_by_user_id`; if `previous_revision_id` is set, the previous revision becomes `amended` with `superseded_by_event_id` (the only update its immutability trigger permits). Output lot rows are reused across revisions, so bridge rows and edges keep pointing at the same lots; changing an output TLC or product on amendment is rejected with 422 `TLC_CHANGE_REQUIRES_VOID` (consistent with US-02 OQ-US02-13 and US-03 OQ-US03-4).

Audit actions (`target_type = traceability_event`, `target_id = event id`): `traceability.transformation.created`, `.updated`, `.finalized` (after: revision, counts of inputs/outputs/edges/boxes, `completed_on`, zone), `.amended` (before: previous revision id), `.voided` (after: reason, downstream check result); `traceability.lot_box.linked` / `.unlinked` (`target_type = traceability_lot`, after: `{ boxIds, source, eventId }`). Failures of finalize are audited with `outcome: "failure"` and the issue codes.

Idempotency: `finalize` on an already finalized revision returns the stored result; `amend` on a revision that already has an open draft returns that draft (200) instead of creating a second one; manual box link is a no-op for boxes already linked to the same lot.

### Admin UI

`apps/admin/src/pages/traceability/transformations/` (i18n `pages.traceability.transformations.*`, en/ru):

- **List** `/traceability/transformations`: `Table` (date, reason, revision/status chip, inputs → outputs summary, shift number), filters, `EmptyState` with a "New transformation" button gated by `traceability.transformation.write`.
- **Event page** `/traceability/transformations/:id` (`/new` for create): header form — reason `Select` (+ note), completion `DatePicker` with the tenant zone shown as text, location `Combobox` (US-01), shift `Combobox` fed by `shift-candidates` (shows number, product, production date, linkable boxes); **Inputs** table with per-line lot `Combobox` (search by TLC/product from US-02 list), regulated `Checkbox`, ingredient text for unregulated lines, quantity + UOM `Select`, consumes-lot `Checkbox`; **Outputs** table with product `Combobox`, TLC `Input` + "Suggest" button (`formatDemoTlc`, editable), quantity + UOM, production/expiry dates; **Reference documents** section reusing US-03's component (WO and BATCH in the demo); **Completeness panel** (`Alert` list from `/completeness`, refreshed on blur, each item names the line and field and moves focus to it on activation); actions "Save draft", "Finalize" (`ConfirmDialog` restating counts), and after finalization "Amend" and "Void" (reason `Textarea`).
- Read-only finalized view: genealogy summary (input TLC → output TLC), **Cases** panel with linked box count, first/last SSCC and a link to `/boxes?shiftId=` (TRN-010), operational yield block labelled "Operational, not an FDA KDE" (TRN-006), revision history with links to superseded revisions.
- Lot card (US-02) gains the "Cases" count and list from `/traceability/lots/:lotId/boxes` plus manual link/unlink controls.
- Navigation: `nav.traceabilityTransformations` in US-00's `shell.sections.traceability` group (`feature: "traceability"`, capability `traceability.read`); routes wrapped in `RequireCapability` and `ProfileOnly`.
- Accessibility: tables navigable by keyboard with row actions in `RowActions`, status conveyed by chip text, completeness issues are links, dialogs trap focus (`ConfirmDialog`, `Modal`).

### Station

Not touched. The bridge is server-side only; `boxes_mirror` and `shift_mirror` are unchanged. US-10 may later populate `trace_lot_boxes` with `link_source = station`.

### Profile gating and RU_CHZ safety

- New tables only; `boxes`, `box_items`, `shifts` and their services are not modified (LOT-010). `GET /boxes` is consumed as-is.
- Routes are behind `TraceabilityProfileGuard`; RU tenants get 403 `traceability_profile_required` and see no navigation entries (`profileFeatures("RU_CHZ").traceability === false`).
- The transformation module imports `BoxesService` and `ShiftsService` read paths only; a boundary test asserts no import from `exchange/`, `chz-*`, `national-catalog` (INT-004).
- Existing RU suites (`boxes.e2e`, `shifts`, `station-scans`, `sqlite-schema`) run unchanged.

## Testing

- Unit (`packages/domain`): validator matrix (each missing field yields one issue with line scope; TRN-011 case with zero regulated inputs passes; unknown coverage blocks under the processor profile and not under generic); `planGenealogyEdges` 2×1 and 2×2 orders and quantity rule; `selectLinkableBoxes` excludes open, SSCC-less and disassembled boxes; `computeYield` comparable/incomparable; revision helpers.
- DB (`packages/db/test/traceability-transformation-schema.test.ts`): table names, composite FK names (`transformation_events_tenant_shift_fk`, `trace_lot_boxes_tenant_box_fk`), checks, the partial unique on active box links; migration fresh + upgrade; tenant isolation: bridge row pointing at tenant B's box → `23503`; second active link for the same box → `23505`.
- API e2e (`apps/api/test/traceability-transformations.e2e.test.ts`), golden case from `docs/us/demo-scenario.md`: inputs `OSS-260914-A1` 500 lb and `OSS-260914-A2` 500 lb (regulated, imported lots from a seeded receiving), reason `commingling_and_repacking`, completed 2026-09-15 in `America/Los_Angeles`, documents `WO-2026-0915-APPLECUP` and `BATCH-2026-0915-01`, output `NRF-260915-APL01` 100 case (900 lb equivalent recorded as `notes`/waste 100 lb operational), linked closed shift with 100 seeded boxes → finalize 200; assert 2 edges, both inputs `consumed`, output lot `active` with source North River, 100 bridge rows, audit rows; second finalize identical body; PATCH after finalize → 409; amend → new draft revision, finalize it → previous `amended`, previous snapshot bytes unchanged, edges of both revisions present; void with downstream shipping → 409; void without → status `void`, reason stored; shift of another tenant → 404; shift `active` → 409; box already linked → 409; unknown coverage on output product → 422 with issue code; product master renamed after finalize → detail snapshot unchanged (acceptance §2.4).
- Admin (`apps/admin/test`): event form line editing, completeness panel focus movement, finalize dialog, prohibited-phrase content test on new keys.
- Negative cases from `docs/us/acceptance.md` §2.4 covered: TLC without source, unknown FTL status blocks finalization, master data edited after finalization, duplicate finalize (no duplicate lot/edge), cross-tenant id denied.

## Evidence

- C-008: screenshot of the finalized event (two inputs, one output, genealogy summary, 100 cases) and the e2e golden test output; `GET /traceability/transformations/:id` JSON saved as a fixture for US-07's workbook golden file.
- C-006 supplement: `NRF-260915-APL01` lot card showing basis `transformation`, source North River and the Cases panel.
- Audit excerpt (`traceability.transformation.finalized`, `traceability.lot_box.linked`) in the verification report.

## Out of scope

Receiving and shipping events (US-03/US-05), trace graph queries (US-06; this slice only writes edges), XLSX mapping (US-07), station-side case-to-lot linking and label TLC printing (US-10), CSV import of transformation lines, planned-vs-actual workflow beyond the two optional columns, automatic yield-based alerts, any change to `boxes`, `box_items` or the shift close flow.

## Open questions

| ID         | Question                                                                                                                                | Options                                                                                                                                                                      | Recommendation                                                                                                                                                                                                                      | Blocking? |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| OQ-US04-1  | `boxes` rows are only created when a first KM item arrives; U.S. products have no KM codes, so where do the demo's 100 cases come from? | (a) US-11 seed inserts `boxes` rows with SSCC and `closed_at` directly; (b) a "case-only" station mode that closes boxes without items (US-10, P1); (c) drop TRN-010 from P0 | (a) for P0 evidence, (b) as the US-10 path; the bridge design is the same for both. Record in `docs/us/limitations.md` that P0 cases are seeded, not scanned.                                                                       | yes       |
| OQ-US04-2  | U.S. products cannot reach `active` status without a CHZ group and therefore cannot have a shift (OQ-US02-2).                           | resolve in US-02; resolve here                                                                                                                                               | Resolve in US-02 (profile-aware `computeStatus`); this slice assumes it.                                                                                                                                                            | yes       |
| OQ-US04-3  | Edge quantities when an event has several outputs.                                                                                      | (a) quantity only for 1-output events, else null; (b) proportional apportioning by output quantity; (c) user enters per-edge quantities                                      | (a) in P0: no invented numbers in a regulated record; line quantities remain the KDEs. Revisit with (c) if a real partner needs it.                                                                                                 | no        |
| OQ-US04-4  | When does an input lot become `consumed`?                                                                                               | always at finalization; per-line `consumes_lot` flag; never automatic                                                                                                        | Per-line flag defaulting to true; lots carry no running balance, so the operator decides partial use.                                                                                                                               | no        |
| OQ-US04-5  | Reference documents required for finalization: both WO and batch/production log, or at least one?                                       | both; at least one of the three types; none (warning only)                                                                                                                   | At least one of `work_order`, `batch_log`, `production_log`; the demo provides both. TRN-008 lists them as supported, not all mandatory.                                                                                            | no        |
| OQ-US04-6  | Create output `traceability_lots` rows at draft time or at finalization?                                                                | draft (visible early, needs a lot `draft` status not in LOT-009); finalization                                                                                               | Finalization; lots have no draft status and must not appear in searches before they exist.                                                                                                                                          | no        |
| OQ-US04-7  | Amendment and edges: which revision's edges does a trace use, and how is the old revision marked?                                       | keep old edges, filter by event status in US-06; delete old edges; flag column on edges                                                                                      | Keep and filter by event status (`amended`/`void` excluded from traces, included in history). Nothing is deleted.                                                                                                                   | no        |
| OQ-US04-8  | Time zone for `completed_at`: tenant `org_profiles.time_zone` or a location-level zone?                                                 | tenant zone; location zone (US-01 would need a column); user picks                                                                                                           | Tenant zone copied into `completed_time_zone` at save; if US-01 adds a location zone later, prefer it additively.                                                                                                                   | no        |
| OQ-US04-9  | May one closed shift be linked to several transformation events?                                                                        | unique among non-void latest revisions (service rule); DB partial unique; unrestricted                                                                                       | Service rule: one active (non-void, latest) event per shift; amendments keep the link. A DB partial unique cannot express "latest revision".                                                                                        | no        |
| OQ-US04-10 | Line editing API: whole-array replacement in PATCH or per-line endpoints?                                                               | arrays; line CRUD                                                                                                                                                            | Arrays; drafts are small and the form owns the whole document.                                                                                                                                                                      | no        |
| OQ-US04-11 | Should yield/waste be stored (`waste_quantity`) or only computed?                                                                       | store waste, compute yield; compute only                                                                                                                                     | Store waste as entered (the demo's 100 lb loss), compute yield; both labelled operational and excluded from the field registry.                                                                                                     | no        |
| OQ-US04-12 | Which boxes are linkable: only closed with SSCC and not disassembled, or also SSCC-less closures?                                       | strict; include SSCC-less                                                                                                                                                    | Strict; a case without SSCC cannot be referenced on a shipment anyway.                                                                                                                                                              | no        |
| OQ-US04-13 | Void semantics for output lots: archive them, or leave `active` with the event voided?                                                  | archive; leave; block void when lots are used downstream                                                                                                                     | Block when downstream finalized events exist; otherwise transition output lots to `archived` with the void reason in the audit row.                                                                                                 | no        |
| OQ-US04-14 | Migration packaging: one migration for the four tables plus FK additions to US-02's tables, or split?                                   | one; two                                                                                                                                                                     | One migration; the FK additions are additive `ALTER TABLE ... ADD CONSTRAINT` statements.                                                                                                                                           | no        |
| OQ-US04-16 | Should `trace_lot_boxes` be covered by the finalized-event immutability trigger?                                                        | yes (links frozen with the event); no (operational bridge, unlink with reason allowed after finalization)                                                                    | No: the bridge is operational detail (LOT-010), unlink is audited and never deletes; freezing it would force an amendment for a mis-scanned case.                                                                                   | no        |
| OQ-US04-15 | Auto-link boxes on finalization or require an explicit "Link cases" action?                                                             | auto when exactly one output; always explicit                                                                                                                                | Auto for the single-output case (the demo), explicit endpoint otherwise; auto-link failure (box linked to another lot) aborts finalization so the record never half-links; boxes already linked to the same output lot are skipped. | no        |
