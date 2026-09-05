# US-01 — Parties and locations — Design Spec

> Revised 2026-09-04: read the [shared MVP contract](../../us/mvp-contract.md) first. It resolves cross-slice scope and safety rules and supersedes conflicting draft recommendations below. Design only; implementation is not claimed.

**Date:** 2026-09-03

**Status:** Draft for review (not implemented)

**Slice:** US-01 from docs/us/implementation-plan.md; depends on US-00

**Requirements:** LOC-001, LOC-002, LOC-003, LOC-004, LOC-005, LOC-006, LOC-007, LOC-008

**Related:**

- `docs/superpowers/specs/2026-09-03-us-00-regulatory-profile-design.md` — profile gating (`RequireTraceabilityProfile`, `ProfileOnly`), capabilities `traceability.read` / `traceability.master_data.write`, audit shape.
- `docs/superpowers/specs/2026-09-03-us-02-product-profiles-and-lots-design.md` — `TraceabilityLot.source_location_id` / `source_reference` consume the location entity and the LOC-003 variant (owned by US-02).
- `docs/superpowers/specs/2026-09-03-us-03-receiving-and-documents-design.md`, `…-us-04-transformation-design.md`, `…-us-05-shipping-design.md` — call `buildLocationDescriptionSnapshot` at finalization (LOC-004) and `locationsShareAddress` (LOC-007).
- `docs/superpowers/specs/2026-08-28-product-archived-flag-design.md` — "hide, do not delete" idiom reused for parties and locations.
- `docs/us/data-dictionary.md` §2, §3, §4, §7.1, §8, §9, §10; `docs/us/demo-scenario.md` §5.1, §6; `docs/us/acceptance.md` §2.4, C-004; `docs/us/limitations.md`.

## Problem

FSMA 204 KDEs describe **physical locations** (Location Description: business name, phone, street or coordinates, city, state, ZIP, country) that belong to **legal parties**; one supplier can ship from several sites and one processor can own several plants and zones. Markiro's `counterparties` are GS1/Chestny ZNAK partners (mandatory GLN, INN, GS1 prefixes) used for SSCC issuing and tolling — no address, no phone, no roles. US-01 introduces `traceability_parties` and `traceability_locations`, the validator that makes a location export-ready, the snapshot builder later CTE slices freeze at finalization, role filtering, the same-address warning helper and the API/admin pages to manage them, without touching the Russian counterparty model.

## Key facts of the codebase

- `counterparties` (`packages/db/src/schema/platform.ts` lines 44–58): `id`, `tenant_id`, `name`, `gln text NOT NULL`, `inn`, `gs1_prefixes text[]`, `notes`, `created_at`; anchor `unique("counterparties_tenant_id_uq").on(tenantId, id)` for composite FKs from `products.default_counterparty_id`, `shifts.counterparty_id`, `shifts.sscc_issuer_counterparty_id`. The module (`apps/api/src/modules/counterparties/`) is cabinet-only (`RequirePermissions(OPERATIONS_READ|OPERATIONS_WRITE)`, `AllowSubscriptionReadOnly("read")`, `RequireSubscriptionWrite`), hard-deletes with 409 on FK violation, and exposes SSCC counter routes keyed by the counterparty GLN. `products.service.ts` uses counterparties to classify GTIN ownership (`own | counterparty | unknown`) — the "product counterparty select". The station mirrors counterparties into SQLite for label rendering (`apps/station/src/lib/mirror.ts`).
- No address or phone model exists for tenant data. The only addresses are Russian billing profiles (`packages/db/src/schema/billing.ts` lines 85–101: `*_address_raw` text plus DaData `jsonb`), which are RU-legal-specific and must not be reused (INT-004 spirit).
- Tenant column helper `tenantId()` (text, `references(() => organization.id)`) is declared locally in `platform.ts` and `product-regulatory.ts`; PKs are `uuid("id").primaryKey().defaultRandom()`; timestamps are `timestamp(..., { withTimezone: true })`; closed sets are `pgEnum`; arrays with a CHECK are an accepted pattern (`label_templates.chz_product_group_codes integer[]`, migration `0111`).
- GS1 GLN validation exists (`hasValidCheckDigit` in `@markiro/domain`, `glnSchema` in `counterparties/dto.ts` and `org-profile/dto.ts`).
- "Hide, do not delete": `products.archived boolean NOT NULL DEFAULT false`, `PATCH /products/:id { archived }`, list query `archived=true|false|all` defaulting to `false` (`apps/api/src/modules/products/dto.ts` lines 30–65).
- Admin CRUD idiom: list page with `AdminPage`, `PageHeader`, `Table`, `EmptyState`, `RowActions` plus a routed `SidePanel` (`apps/admin/src/pages/counterparties/index.tsx`, `CounterpartyPanelRoute.tsx`, `useRoutePanelGuard`), Zod form schema with i18n error keys (`CounterpartyForm.tsx`), TanStack Query hooks with a shared query key (`counterparties/api.ts`), nested routes `new` / `:id/edit` wrapped in `RequireCapability` (`apps/admin/src/app.tsx`). Recent commit `8474e971a` added search fields to pickers; the shared `Select` is Radix-based.
- Audit rows are inserted inline into `tenant_audit_events` (`packages/db/src/schema/team.ts`) with `actorUserId`, `action`, `outcome`, `targetType`, `targetId`, `before`, `after`, `requestId`.
- Media/attachments: `media_assets` (`packages/db/src/schema/media.ts`) with owner XOR and object-storage keys — not needed by US-01 (no location documents); reference documents belong to US-03.
- Cross-tenant tests: `packages/db/test/tenant-isolation.test.ts` inserts two organizations and expects `23503` on a foreign-tenant composite FK; API e2e tests use `apps/api/test/support/auth.ts` (`signUpAndActivate`, `setOnlyOrganizationMemberRole`).
- Synthetic contacts are mandated by `docs/us/demo-scenario.md` §5.1 (Yakima/Portland/Seattle "Example" streets, `+1 xxx-555-01xx`) and §6 (LOC-008, NFR-006).

## Design

### Data model

Additions to `packages/db/src/schema/traceability.ts`; migration `packages/db/migrations/NNNN_traceability_parties_locations.sql` (next free number after US-00; renumber at implementation time to the next free number). Names follow data-dictionary §9.

```sql
CREATE TYPE traceability_location_role AS ENUM (
  'supplier', 'processor', 'ship_from', 'receive_at', 'recipient', 'tlc_source');
CREATE TYPE traceability_address_kind AS ENUM ('street', 'coordinates');

CREATE TABLE traceability_parties (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL REFERENCES organization(id),
  name             text NOT NULL,
  legal_name       text,
  contact_name     text,
  contact_phone    text,
  contact_email    text,
  gln              text,
  ffrn             text,
  url              text,
  notes            text,
  counterparty_id  uuid,
  archived         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT traceability_parties_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT traceability_parties_tenant_counterparty_fk
    FOREIGN KEY (tenant_id, counterparty_id) REFERENCES counterparties(tenant_id, id)
);
CREATE UNIQUE INDEX traceability_parties_tenant_name_active_uq
  ON traceability_parties (tenant_id, lower(name)) WHERE archived = false;

CREATE TABLE traceability_locations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              text NOT NULL REFERENCES organization(id),
  party_id               uuid NOT NULL,
  name                   text NOT NULL,
  business_name          text NOT NULL,
  phone_number           text,
  address_kind           traceability_address_kind NOT NULL DEFAULT 'street',
  street_address         text,
  latitude               numeric(9,6),
  longitude              numeric(9,6),
  city                   text,
  state_or_region        text,
  zip_or_postal_code     text,
  country_code           char(2),
  gln                    text,
  ffrn                   text,
  source_reference_url   text,
  roles                  traceability_location_role[] NOT NULL DEFAULT '{}',
  archived               boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT traceability_locations_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT traceability_locations_tenant_party_fk
    FOREIGN KEY (tenant_id, party_id) REFERENCES traceability_parties(tenant_id, id),
  CONSTRAINT traceability_locations_address_shape CHECK (
    (address_kind = 'street' AND latitude IS NULL AND longitude IS NULL)
    OR (address_kind = 'coordinates' AND street_address IS NULL
        AND latitude IS NOT NULL AND longitude IS NOT NULL)),
  CONSTRAINT traceability_locations_country_upper
    CHECK (country_code IS NULL OR country_code = upper(country_code))
);
CREATE INDEX traceability_locations_tenant_party_idx ON traceability_locations (tenant_id, party_id);
CREATE INDEX traceability_locations_tenant_roles_gin ON traceability_locations USING gin (roles);
```

- `tenant_id` on both tables; the `(tenant_id, id)` UNIQUE anchors let US-02 (`traceability_lots.source_location_id`), US-03/05 (event locations) and US-08 (plan contact party) use composite FKs, mirroring `counterparties_tenant_id_uq`.
- Party ≠ location (LOC-001): a location always belongs to exactly one party; a party may have zero or many locations; CTEs and lots reference `traceability_locations.id`, never a party.
- Location Description (LOC-002, dictionary §7.1): `business_name` is NOT NULL because it is the row's identity in every KDE; the other six description fields are nullable in the database so a `US_GENERIC_LOT_TRACEABILITY` tenant can keep partial master data, and the **validator** (below) is what enforces the applicable domestic or comparable foreign description fields for export-ready use. `street_address` vs. coordinates is discriminated by `address_kind` (dictionary: "one of the two variants; store the type"). `zip_or_postal_code` and `phone_number` are text, never numeric. `country_code` is ISO 3166-1 alpha-2 (upper-case CHECK); display names are derived in the domain, not stored.
- LOC-005 (P1) fields `gln`, `ffrn`, `source_reference_url` exist on both tables as separate nullable columns, format-validated only. FFRN is stored as digits only (11 digits per the FDA registration number format known at baseline `US-REG-2026-09-03`; see OQ-US01-4).
- LOC-006 roles are a Postgres enum array with a GIN index; filtering uses `roles @> ARRAY['supplier']::traceability_location_role[]`. `tlc_source` is a role so US-02 can restrict the source-location picker to it. A join table was considered and rejected (six fixed values, no per-role attributes; same trade-off as `label_templates.chz_product_group_codes`).
- LOC-003: the _alternative TLC source reference_ is a property of the lot (US-02 stores `source_reference` text + `source_reference_kind`), not of a location; US-01 only supplies `source_reference_url` on the location as the URL-type reference the lot may copy. This spec makes no assumption beyond "US-02 will reference `traceability_locations(tenant_id, id)` and may carry a reference instead".
- `counterparty_id` is the optional bridge to the Russian `counterparties` row (OQ-US01-1); nothing reads it in US-01.
- `archived` follows the product idiom; no `DELETE` route exists (dictionary §4: archiving master data never destroys history; snapshots are copies anyway).
- Snapshots are **not** a table of this slice: each CTE slice stores the JSON returned by the builder in its own event row (`jsonb` column), which is what LOC-004 requires ("changing master data does not rewrite a finalized event").

### Domain rules

`packages/domain/src/traceability/location-description.ts` (pure, exported from `@markiro/domain`):

```ts
export type TraceabilityLocationRole =
  "supplier" | "processor" | "ship_from" | "receive_at" | "recipient" | "tlc_source";
export interface LocationDescriptionInput {
  businessName: string;
  phoneNumber: string | null;
  addressKind: "street" | "coordinates";
  streetAddress: string | null;
  latitude: string | null;
  longitude: string | null;
  city: string | null;
  stateOrRegion: string | null;
  zipOrPostalCode: string | null;
  countryCode: string | null;
  gln: string | null;
  ffrn: string | null;
  sourceReferenceUrl: string | null;
}
export type LocationDescriptionIssue = {
  field: keyof LocationDescriptionInput;
  code: "required" | "format";
};
export function validateLocationDescription(
  input,
  mode: "export_ready" | "draft",
): LocationDescriptionIssue[];
export interface LocationDescriptionSnapshot {
  schemaVersion: 1;
  locationId: string;
  partyId: string;
  businessName: string;
  phoneNumber: string;
  address:
    | { kind: "street"; streetAddress: string }
    | { kind: "coordinates"; latitude: string; longitude: string };
  city: string;
  stateOrRegion: string;
  zipOrPostalCode: string;
  countryCode: string;
  countryDisplay: string;
  gln?: string;
  ffrn?: string;
  sourceReferenceUrl?: string;
}
export function buildLocationDescriptionSnapshot(
  location,
): { ok: true; snapshot } | { ok: false; issues };
export function locationsShareAddress(a, b): boolean;
export function isSyntheticContact(value: {
  phone?: string | null;
  email?: string | null;
  url?: string | null;
}): boolean;
```

- `validateLocationDescription(_, "export_ready")` requires all seven fields (business name, phone, street **or** both coordinates, city, state/region, ZIP/postal, country) and format-checks the optional identifiers: GLN 13 digits + `hasValidCheckDigit`; FFRN 11 digits; URL `http(s)` only; phone 3–40 characters from `0-9 + - ( ) . space x ext` **without normalization** (dictionary §7.1: never lose an extension); latitude −90…90 / longitude −180…180 with ≤ 6 decimals; country two upper-case letters. `"draft"` mode applies only the format checks. In the `US_FSMA204_PROCESSOR` profile the API uses `export_ready` on every write (acceptance §2.4 "missing phone/ZIP/country → error in compliance profile"); the generic profile uses `draft` on write and `export_ready` only when a later slice builds a snapshot.
- `buildLocationDescriptionSnapshot` returns a deterministic object with fixed key order and `schemaVersion: 1`; internal fields (`name`, `roles`, `archived`, timestamps, `counterparty_id`) are dropped; `countryDisplay` comes from a small in-domain table (`US → United States`, `CA → Canada`, `MX → Mexico`, fallback = code) so exports are stable across runtimes (OQ-US01-5). It never reads the clock; the caller stamps `finalized_at`.
- `locationsShareAddress` compares the normalized tuple (`lower`, trimmed, whitespace collapsed, punctuation stripped) of street/city/state/ZIP/country, or coordinates rounded to 4 decimals; two locations of _different_ parties at one address still match — the rule is about physical movement, not ownership (LOC-007).
- `isSyntheticContact`: phone contains `555-01\d\d`, e-mail/URL host is `example.com|org|net`. Used by US-01 fixtures and exported for the US-11 fixture scan (LOC-008).

### Contracts and API

Contracts in `packages/platform-contracts/src/traceability/parties.ts` and `locations.ts` (`.strict()`, per OQ-US00-1): `createTraceabilityPartySchema`, `updateTraceabilityPartySchema` (partial, `archived?: boolean`), `traceabilityPartySchema`; `createTraceabilityLocationSchema`, `updateTraceabilityLocationSchema`, `traceabilityLocationSchema`, `listTraceabilityLocationsQuerySchema` (`partyId?`, `roles?: TraceabilityLocationRole[]` — repeated `roles=` query params, optional; a location matches when it carries every listed role, i.e. the `roles @> ARRAY[...]` filter above, so the multi-select chips of the list page need one request; `archived?: "true" | "false" | "all"` default `"false"`, `search?`, `sameAddressAs?: uuid`), `listTraceabilityPartiesQuerySchema` (`archived`, `search`). Location responses include the computed `descriptionStatus: { exportReady: boolean; issues: LocationDescriptionIssue[] }` so every picker can show readiness without a second call.

Module `apps/api/src/modules/traceability/parties/` and `.../locations/` registered by `TraceabilityModule` in `apps/api/src/app.module.ts`; both controllers carry `@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard, TraceabilityProfileGuard)`, `@RequireTraceabilityProfile("US_FSMA204_PROCESSOR", "US_GENERIC_LOT_TRACEABILITY")`, `@AllowSubscriptionReadOnly("read")`, `@ApiCabinetAuth()`, `@ApiTags("traceability")`, and are added to `authorization-metadata.test.ts`.

| Method | Route                         | Policy                                                        | Notes                                                                                       |
| ------ | ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/traceability/parties`       | `traceability.read`                                           | `archived` default false; `search` on name/legal name (ILIKE)                               |
| POST   | `/traceability/parties`       | `traceability.master_data.write` + `RequireSubscriptionWrite` | 409 `party_name_taken` on the partial unique index                                          |
| GET    | `/traceability/parties/:id`   | `traceability.read`                                           | 404 for another tenant's id (tenant-scoped statement)                                       |
| PATCH  | `/traceability/parties/:id`   | `traceability.master_data.write` + write subscription         | partial; `archived: true/false` archives/restores; archiving a party cascades nothing       |
| GET    | `/traceability/locations`     | `traceability.read`                                           | filters above; `sameAddressAs` returns other active locations sharing the address (LOC-007) |
| POST   | `/traceability/locations`     | `traceability.master_data.write` + write subscription         | `partyId` must be an active party of the tenant (404 otherwise); validator per profile      |
| GET    | `/traceability/locations/:id` | `traceability.read`                                           |                                                                                             |
| PATCH  | `/traceability/locations/:id` | `traceability.master_data.write` + write subscription         | validator re-runs on the merged row; `archived` toggles                                     |

- Validation failures are 400 in the existing `validationErrorSchema` shape (`apps/api/src/lib/openapi.ts`) with `issues[]` from the domain validator (`field`, `code`), so the admin maps them to field errors.
- Every query is tenant-scoped in the statement (`and(eq(tenantId), eq(id))`), never by id alone; `partyId` is checked through the composite FK **and** a prior scoped select so the error is 404, not a raw `23503`.
- Idempotency (NFR-005): master data creation is not an event or import; `POST` carries no idempotency key (OQ-US01-6); `PATCH` is idempotent by construction.
- Audit (NFR-003), one `tenant_audit_events` row per mutation inside the transaction: `actorUserId = req.userId`; `action ∈ traceability.party.created | updated | archived | restored, traceability.location.created | updated | archived | restored`; `outcome = "success"`; `targetType = "traceability_party" | "traceability_location"`; `targetId = row.id`; `before`/`after` = the changed fields only (full row on create); `requestId`. Tests assert every field.
- Profile lock: both tables are appended to `TRACEABILITY_PROFILE_LOCK_TABLES` (US-00 rule 5) so a tenant with parties cannot silently flip to `RU_CHZ`.
- OpenAPI: `ApiZodBody` / `ApiZodQuery` / `ApiZodResponse` from `apps/api/src/lib/openapi.ts`; the existing OpenAPI coverage gate must list the new routes.

### Admin UI

Pages under `apps/admin/src/pages/traceability/` (INT-004 lint scope), routes nested under `/traceability` from US-00, each wrapped in `ProfileOnly feature="traceability"` and `RequireCapability`:

- `/traceability/parties` — list (name, legal name, contact, locations count, identifiers badge, archived filter `false|all`, search field as in the counterparty picker), `Add party` button (only with `master_data.write`), row actions edit / archive / restore with `ConfirmDialog`. Side panel `new` and `:partyId/edit` (`PartyPanelRoute`, `PartyForm` with Zod schema mirroring the contract; GLN check-digit error `pages.traceability.parties.form.errors.glnCheckDigit`, FFRN `…ffrnFormat`, URL `…urlFormat`, e-mail `…emailFormat`).
- `/traceability/parties/:partyId` — party card with its locations table and `Add location` preset to the party.
- `/traceability/locations` — list with role filter chips (six roles, multi-select, `aria-pressed`), party filter, archived filter, search; columns: name, business name, party, city/state, roles (text chips), readiness. Readiness is text + icon (`Export-ready` / `Missing: phone, ZIP`), never color alone (NFR-012). Side panel `new` / `:locationId/edit` with `LocationForm`: party select (searchable, active parties only), internal name, business name (prefilled from party name), phone, address kind toggle (radio group) switching between street textarea and latitude/longitude inputs, city, state/region, ZIP/postal, country (select with ISO codes, default `US` for U.S. profiles), roles checkbox group (`fieldset` + `legend`), collapsible "Identifiers" with GLN / FFRN / source reference URL. In the FSMA profile the seven description fields are marked required and the API 400 issues map to field errors; in the generic profile they are optional with the hint "required before this location can be used in a finalized event".
- LOC-007 (P1): the location form shows an `Alert` "Another location already uses this address: … Movement between zones at the same address may not be a Shipping CTE" when `GET /traceability/locations?sameAddressAs=<id>` (or, before save, a client-side `locationsShareAddress` over the loaded list) matches; saving proceeds. The blocking confirmation at shipping time is US-05.
- Empty states: `pages.traceability.parties.emptyTitle/emptyHint` ("Add the processor, its suppliers and recipients"), `pages.traceability.locations.emptyTitle/emptyHint`. Error state reuses `AccessLoadError`-style `EmptyState` with retry.
- Navigation: US-00's `nav.traceability` section gets `nav.traceabilityParties` and `nav.traceabilityLocations` (capability `traceability.read`, feature `traceability`).
- i18n: `pages.traceability.parties.*`, `pages.traceability.locations.*`, `pages.traceability.roles.{supplier,processor,shipFrom,receiveAt,recipient,tlcSource}`, `pages.traceability.readiness.*` in `en.json` and `es.json` (lockstep test).

### Station

Not touched. The station keeps mirroring `counterparties` for labels; traceability locations reach the station only if US-10 decides so.

### Profile gating and RU_CHZ safety

- `RU_CHZ` tenants get 403 `traceability_profile_required` on every route above and never see the pages (nav hidden by `feature`). Both are covered by tests.
- `counterparties`, `products`, `shifts`, the SSCC counters and the station SQLite mirror are not modified; the only link to RU data is the optional `counterparty_id` FK, which is nullable and unused by RU code.
- Migration is additive (two enums, two tables, indexes); `packages/db/test/schema.test.ts` and `tenant-isolation.test.ts` grow, nothing existing changes.

## Testing

- Unit (`packages/domain/test/traceability-location-description.test.ts`): each of the seven fields missing → one `required` issue in `export_ready`, none in `draft`; coordinate variant accepted; phone with `x123` extension preserved verbatim in the snapshot; GLN bad check digit / FFRN 10 digits / `ftp://` URL → `format`; snapshot key order and `schemaVersion` stable (JSON equality against a golden fixture); `locationsShareAddress` positive/negative cases incl. case and punctuation differences and same address across two parties; `isSyntheticContact` accepts the demo-scenario contacts and rejects a non-555 number.
- DB (`packages/db/test/traceability-parties-locations-migration.test.ts`, `schema.test.ts`, `tenant-isolation.test.ts`): fresh migration and upgrade from `0112`; composite FK rejects a location whose `party_id` belongs to tenant B (`23503`); partial unique name index ignores archived rows; address-shape CHECK; `country_upper` CHECK; `counterparty_id` cross-tenant rejected.
- API e2e (`apps/api/test/traceability-parties.e2e.test.ts`, `traceability-locations.e2e.test.ts`): CRUD round trip for the three demo-scenario parties/locations; FSMA tenant `POST` without phone → 400 with `issues[{field:"phoneNumber",code:"required"}]`; generic tenant same body → 201 with `descriptionStatus.exportReady=false`; role filter returns only `supplier`; `sameAddressAs` returns the sibling zone; tenant A reading/patching tenant B's ids → 404; RU tenant → 403 profile; `traceability_receiving` role `POST` → 403 `insufficient_permission`; `traceability_qa` → 201; read-only subscription write → read-only exception; audit rows asserted field by field for create/update/archive/restore; `authorization-metadata.test.ts` extended.
- Admin (`apps/admin/test/traceability-parties.test.tsx`, `traceability-locations.test.tsx`): list/empty/error states; form maps API `issues` to field errors; address kind toggle shows the right inputs; roles fieldset keyboard operable; readiness text present; same-address alert renders; RU access document hides nav; i18n lockstep.
- Negative cases from acceptance §2.4: "Location missing phone/ZIP/country → error in compliance profile", "Cross-tenant ID supplied → denied", "Master data edited after finalization → historical export unchanged" (proved here at the builder level: snapshot is a value, not a reference; the end-to-end regression lives in US-03).

## Evidence

- C-004: screenshots of the parties list, the North River Fresh Foods party card with its locations, and the locations list filtered by role, all with demo-scenario §5.1 fictional data; API/DB extract of the three locations with `descriptionStatus.exportReady = true`.
- Golden snapshot fixture (`packages/domain/test/fixtures/location-snapshot.north-river.json`) referenced by US-03/04/05 tests.
- Verification report (automated / browser / not run: station, hardware, external); `docs/us/requirements-traceability.md` rows LOC-001…LOC-008 updated (LOC-004 and LOC-007 marked partial: builder/helper delivered, enforcement evidenced by US-03/05).

## Out of scope

Lots and the lot-level `source_reference` (US-02); reference documents and attachments (US-03); the shipping-time same-address confirmation (US-05); plan contact person (US-08); CSV import of parties/locations (US-03 INT-002 first appears with receiving; a later extension may reuse the validator); synthetic seed and reset (US-11); any change to `counterparties`, GTIN ownership or SSCC issuing; geocoding or address verification services (INT-007).

## Open questions

| ID         | Question                                                                                                            | Options                                                                                                                                                              | Recommendation                                                                                                                                                                                               | Blocking? |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| OQ-US01-1  | Reuse `counterparties` as the party entity, extend it, or create `traceability_parties` with an optional bridge?    | (a) New table + nullable `counterparty_id` composite FK; (b) add address/phone/roles columns to `counterparties` and drop GLN NOT NULL; (c) new table, no bridge.    | (a): `counterparties` is a GS1/SSCC issuer with mandatory GLN mirrored to the station; changing it risks RU regressions (PRO-003, R-07). The bridge lets a tolling partner appear once in both worlds later. | yes       |
| OQ-US01-2  | Description fields nullable in DB with a profile-aware validator, or NOT NULL for all seven?                        | (a) Nullable + validator (`export_ready` on write in FSMA profile); (b) NOT NULL everywhere.                                                                         | (a): keeps the generic profile usable with partial supplier data and matches acceptance §2.4 wording "in compliance profile"; snapshots are always export-ready.                                             | no        |
| OQ-US01-3  | Roles as `traceability_location_role[]` with GIN index vs. a `traceability_location_roles` join table.              | (a) Enum array; (b) join table with composite FK.                                                                                                                    | (a): six fixed values, no per-role data, precedent `label_templates.chz_product_group_codes`.                                                                                                                | no        |
| OQ-US01-4  | FFRN format: 11 digits, or free text validated only for length?                                                     | (a) `^\d{11}$`; (b) 1–20 free characters.                                                                                                                            | (a) at baseline `US-REG-2026-09-03`; re-check with the FDA source register at each release (REG-012) and relax if the format changes.                                                                        | no        |
| OQ-US01-5  | Country display names: in-domain table (US/CA/MX + fallback) or `Intl.DisplayNames` at render time?                 | (a) Domain table, stored in the snapshot; (b) `Intl.DisplayNames`; (c) code only.                                                                                    | (a): deterministic exports (NFR-010) independent of ICU data; the table grows only when a demo needs it.                                                                                                     | no        |
| OQ-US01-6  | Idempotency key on `POST /traceability/parties` and `POST /traceability/locations`?                                 | (a) None (master data, not an event); (b) optional `idempotencyKey` like shift exports.                                                                              | (a): NFR-005 targets events/imports/exports; the unique name index already blocks accidental duplicates of parties.                                                                                          | no        |
| OQ-US01-7  | Should `PATCH` on a location that already appears in a finalized event be restricted?                               | (a) Always allowed (snapshots protect history); (b) block edits of the seven description fields after first use; (c) allowed with a warning listing affected events. | (c) once US-03 exists; (a) in US-01 since no events exist yet.                                                                                                                                               | no        |
| OQ-US01-8  | Unique active party name per tenant (partial index)?                                                                | (a) Yes, case-insensitive; (b) no uniqueness.                                                                                                                        | (a): prevents duplicate suppliers in pickers and gives the 409 a clear meaning.                                                                                                                              | no        |
| OQ-US01-9  | Does `business_name` default from the party name on the server, or is it always client-supplied?                    | (a) Client-supplied, UI prefills; (b) server falls back to party name when blank.                                                                                    | (a): the snapshot must reflect an explicit, reviewed value.                                                                                                                                                  | no        |
| OQ-US01-10 | Is the `sameAddressAs` query the right home for LOC-007 or should the pure helper be the only deliverable in US-01? | (a) Query + helper; (b) helper only, US-05 adds the query.                                                                                                           | (a): the form warning is cheap and the query is reused unchanged by US-05.                                                                                                                                   | no        |

Foreign locations use comparable regional/postal fields rather than U.S.-only state/ZIP validation. Basic draft records may be incomplete; export-ready validation explains actual missing KDEs. A typed source reference is separate from optional party identifiers and is validated for its required resolution meaning.
