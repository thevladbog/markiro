# U.S. Design Brief 02 — Onboarding, Profile, Master Data and Lots

> Revised 2026-09-04: read the [shared MVP contract](../../us/mvp-contract.md) first. It resolves cross-slice scope and safety rules and supersedes conflicting draft recommendations below. Design only; implementation is not claimed.

> Second brief of the U.S. series. Office mode, desktop-first 1440px, adaptive to 1024/768.
> Users: Owner / Tenant Admin, QA / Traceability Manager, three operator roles, Auditor (cabinet
> sign-in, never the station). EN primary, U.S. Spanish secondary. Light + dark. **Delta to
> RU brief 03 (admin panel)**: adds a Traceability sidebar section, one Settings card, one
> product-card tab and three page families (parties, locations, lots); nothing else is
> redesigned. Wording follows `docs/us/limitations.md`: readiness, data completeness, "designed
> to support applicable FSMA 204 recordkeeping requirements"; never approved, certified,
> compliant, guaranteed.

## Purpose

Before a single Receiving event can be recorded (events brief 03) the tenant must exist as a
U.S. tenant, know its suppliers and recipients, describe where food physically moves, decide
which products are on the Food Traceability List, and hold lots with Traceability Lot Codes.
This brief is that foundation, grounded in slice specs US-00, US-01, US-02
(`docs/superpowers/specs/2026-09-03-us-0{0,1,2}-*.md`) and `docs/us/data-dictionary.md` §5–7.

## Design principle: master data written to be frozen

In the RU product a counterparty or product card is a convenience that labels and exports read
live. Here a location or product description is a **Key Data Element**: when a Receiving,
Transformation or Shipping event is finalized, the system copies the description as it was that
day into the event, and that copy — not the master record — is what a trace-request package
prints (data dictionary §4). Editing the master record later does not rewrite history;
archiving it does not destroy the copy. Three consequences shape every screen:

- **Readiness is a property of the record.** A location is "export-ready" (the applicable Location
  Description fields present) or "incomplete" with the missing fields named; a product's
  coverage is reviewed or "unknown". Shown on the record, in lists and pickers as text plus
  icon, never color alone.
- **Forms are grouped the way the regulation reads.** Location Description, Product Description
  and Lot (TLC + source) appear under those names, matching the FDA-aligned spreadsheet.
- **Nothing is deleted; identity locks.** Master records are archived, never deleted. A lot
  referenced by a finalized event keeps its TLC, source and product read-only; the correction
  path is a new event, not an edit.

## Screens

### 1. Traceability area: sidebar, header badge, overview

**Sidebar.** The profile is one server fact (`/access/me` carries it) and it reshapes the
sidebar without a switch. For `US_FSMA204_PROCESSOR` and `US_GENERIC_LOT_TRACEABILITY`:

| Section      | P0 navigation                                                                  |
| ------------ | ------------------------------------------------------------------------------ |
| Traceability | Overview, Events, Lots, Search, Readiness, Plan, Requests (last two FSMA only) |
| Reference    | Products, Parties, Locations                                                   |
| Organization | Team and Settings, capability-gated                                            |

Billing and legacy operational menus are absent from the U.S. P0. Station/shift/device pages return only with a separately verified P1 capability.

A user whose only capability is `traceability.read` (a Receiving Operator) lands on
`/traceability`, never on a forbidden page. No country or Russian-profile switch appears in the
U.S. deployment.

**Header badge.** Next to the organization name: `US · FSMA 204` or `US · Generic`. Text, not a
colored dot — the PRO-005 reminder of the regime on every screen.

**Overview page (`/traceability`).** Three regions. (1) _Regulatory baseline stamp_: profile
code with plain-language name, effective date (MM/DD/YYYY), baseline ID `US-REG-2026-09-03`,
verified date, dated source list (`FDA-01 …`) as links, retention calendar years, timezone
(`America/Los_Angeles`), and the fixed footer "Designed to support applicable FSMA 204
recordkeeping requirements. Traceability readiness demonstrator."; under the generic profile
the card reads "Generic lot traceability — no FTR coverage claims". (2) _CTE scope_: Receiving,
Transformation, Shipping in scope; harvesting, cooling, initial packing, first land-based
receiving stated as out of scope; hidden for the generic profile. (3) _Readiness tiles_: "Data
readiness — explanatory, not a compliance score", missing KDEs, lots, open requests — numbers
from the readiness API once US-06 is implemented; omit unavailable tiles.

_Quick actions_: Add party, Add location, Review product coverage, Add imported lot; later
"Record receiving". For a fresh tenant the list doubles as an onboarding checklist (profile with
timezone → processor location export-ready → supplier and recipient → products reviewed → first
receiving) — this brief's proposal, not the spec's.

States to draw: FSMA fresh (checklist, empty tiles); FSMA populated (North River
numbers); generic (statement, no CTE block); loading; profile failed to load (retry); stale.

### 2. Profile settings

A **Regulatory profile** card at the top of Settings: profile select with two one-line descriptions
(`US_FSMA204_PROCESSOR` "U.S. processor — FTL foods, Receiving / Transformation / Shipping";
`US_GENERIC_LOT_TRACEABILITY` "U.S. generic lot
traceability — FTR applicability not assessed in this profile"); baseline ID and verified date, read-only, set
by the server; required U.S. timezone select (New York, Chicago, Denver, Phoenix, Los Angeles,
Anchorage, Honolulu, Puerto Rico), with the hint that every date on every record is shown in this
zone; retention calendar years, default 5 calendar years, floor 2 explained ("kept at least 2 years; default 5"),
`retention_below_minimum` as a field error; a confirm dialog for switching between the two U.S.
profiles.

With a U.S. profile the RU-only settings sections (INN, CHZ category defaults, pickup policy)
are gone; GLN, GS1 prefixes, logo and SSCC counters stay (SSCC is the optional case layer).

**Refused state.** Once U.S. records exist the server refuses a code change
(`profile_has_traceability_records`): draw the select disabled with the inline explanation
"Profile is locked because traceability records exist. A migration is not available in this MVP.", not a toast after
the fact. Whether generic → FSMA stays allowed as the upgrade path is pending (OQ-US00-7).

**Generic statement.** Under `US_GENERIC_LOT_TRACEABILITY` the card carries the fixed sentence
"FTR applicability is not assessed in this profile. The system provides general lot
traceability and production control.", which recurs on the product tab and lot card.

States to draw: FSMA active; generic active; choosing the other U.S. profile; locked; read-only
subscription; error.

### 3. Parties and locations

Two entities, deliberately separate (LOC-001): a **party** is who you deal with; a
**location** is where food physically is — one supplier ships from several packhouses.

**Party list.** Columns: name, legal name, contact, locations count, identifiers text chip
("GLN · FFRN"), optional bridge chip "linked to counterparty"; search, archived filter
(`active | all`), "Add party" only with `master_data.write`; row actions edit, archive /
restore with confirm. No delete anywhere. **Party form** (side panel, as counterparties today):
name (unique among active parties — `party_name_taken` is a field error), legal name, contact
name / phone / e-mail, notes; collapsed "Identifiers": GLN (check-digit error), FDA Food
Facility Registration Number (11 digits), URL; optional link to a RU counterparty. **Party
card**: header, the party's locations table, "Add location" preset to it, History panel.

**Location list.** Role filter chips (six roles, multi-select, `aria-pressed`), party filter,
archived filter, search. Columns: name, business name, party, city / state, roles as text
chips, readiness.

**Location form**, grouped as the regulation reads:

| Group                                            | Fields                                                                                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location                                         | Party (searchable, active only); internal name ("Portland plant"); roles checkbox group: supplier, processor, ship-from, receive-at, recipient, TLC source                         |
| Location Description (required for export-ready) | Business name (prefilled from party, editable); phone; address kind radio: street address **or** coordinates (lat / long); city; state code; ZIP; country (ISO select, default US) |
| Identifiers (optional, collapsed)                | GLN; FDA Food Facility Registration Number; source reference URL                                                                                                                   |

Phone is stored as typed (an extension `x123` survives); placeholder `+1 (503) 555-0120`. ZIP is
text. In the FSMA profile the seven description fields carry "Required for export-ready" and API
`issues[]` map to field errors; in the generic profile they are optional with the hint
"Required before this location can be used in a finalized event". **Readiness indicator** in
list, card and picker: "Export-ready" (check icon) or "Incomplete — missing: phone, ZIP" (warning).

**Same-address warning (P1).** When another active location shares the normalized address, a
non-blocking alert: "Another location already uses this address: Portland plant — Cold room B.
Movement between zones at one address may not be a Shipping event." Saving proceeds.

Demo content (synthetic, LOC-008): Orchard Slice Supply LLC, "Yakima packhouse", 100 Example
Orchard Rd, Yakima, WA 98901, +1 509-555-0101 (supplier, ship-from, TLC source); North River
Fresh Foods LLC, "Portland plant", 500 Example River Pkwy, Portland, OR 97203, +1 503-555-0120
(processor, receive-at, ship-from, TLC source) plus "Cold room B" at the same address; Harbor
Market Distribution Center, 200 Example Harbor Ave, Seattle, WA 98134 (recipient).

States to draw: party list empty ("Add the processor, its suppliers and recipients"), loading,
error, stale, archived view; party card with zero locations; location list filtered by role;
form FSMA (required markers) vs generic (hints); API errors on phone and ZIP; coordinates
variant; incomplete vs export-ready in list and picker; same-address alert; archive confirm;
`party_name_taken`; Auditor read-only.

### 4. Product traceability profile on the product card

Reuse the catalog shell and shared product model; exclude RU-specific controls and actions. For U.S. tenants the product side panel gains a
**Traceability** tab beside the edit form (with no RU regulatory tab in the U.S. edition);
RU-only fields (CHZ product group, EGAIS code, national-catalog lookup) are hidden for U.S.
profiles, and a product no longer needs a CHZ group to leave "Draft".

**Coverage section** (editable only with `traceability.qa.manage`, which per the US-00 role table
belongs to QA / Traceability Manager and to Owner / Tenant Admin — the persona matrix below follows
that table; read-only for others with "Only QA / Traceability Manager or an admin changes
coverage"; the same capability governs lot status changes, US-02 `POST /traceability/lots/:id/status`): status radio group with one-line
explanations (Covered · Contains FTL food in the same form · Not covered · Unknown · Exemption
review required); rationale (required in the FSMA profile once status is not unknown); FTL
category (combobox with suggestions such as "Fruits (fresh-cut)", free text, never the CHZ
group); source URL and version (`US-REG-2026-09-03`); reviewer and review date (read-only,
stamped by the server); review due date, FTL ingredient note, evidence link (P1).

**Blocking communication.** Unknown (the default) and Exemption review required block the
trace-request package: a persistent inline alert at the top of the tab, "Coverage not reviewed
— this product blocks export-ready until a QA reviewer sets its status; available-records export remains explicitly incomplete", and a
"Coverage: unknown" chip in the catalog list. The alert asks for a review and suggests no
answer; the system never decides coverage.

**Product Description section** (editable with `master_data.write`): product name (seeded from
the catalog name), brand, commodity ("fresh-cut fruit"), variety ("Red Delicious"), packaging
size value + unit (`lb, oz, kg, g, each, case, bag, cup, gal, l`), packaging style ("bag",
"cup"), default quantity unit for event lines; snapshot note under the heading.

**Generic profile.** The coverage section is replaced by the fixed statement "Not classified as
FTR-covered; general lot traceability only."; only the description section is editable.

**GTIN becomes optional.** For U.S. profiles the edit form labels it "GTIN (optional)" with the
hint "GTIN is not required for the office workflow. Station support is outside this MVP"; the catalog list shows an em dash plus a text chip "No GTIN". RU tenants see no change.

Demo: "Fresh-Cut Apple Snack Cups" — covered, Fruits (fresh-cut), source FDA-02 /
`US-REG-2026-09-03`, reviewed 09/10/2026, brand North River, variety Red Delicious, 6 oz cup,
default unit case; "Fresh-Cut Red Delicious Apple Slices" — covered, Orchard Slice, 10 lb bag.

States to draw: unknown (blocking alert); covered complete; covered with missing rationale;
exemption review required (blocking); not covered; contains FTL same form; read-only for a
Production Operator; generic statement; review overdue (P1); no-GTIN product; loading; error.

### 5. Lots

**Lot list.** Columns: TLC (monospace, tabular), product, source (location name or reference
text), assignment basis, status chip, production date, origin event ("Receiving 09/14/2026" or
"Manual"). Filters: product, status, basis, source location, TLC search. Empty state: "Lots are
created by Receiving and Transformation events; you can also add an imported lot manually."

**Lot card.** Header: TLC, status chip, "Change status" (QA only). Body groups: _Lot_ (TLC,
assignment basis, TLC source as a location link **or** source reference, identity-lock notice);
_Product_ (Product Description snapshot preview linking to the Traceability tab); _Dates_
(production, expiry / best-by P1, labelled "operational, not an FDA KDE"); _Origin_ (link to
the creating event, or "Created manually by …"); _Genealogy_ (input / output lots linking to
other cards); _Cases_ and _Timeline_ placeholders (box / SSCC count from the transformation
slice; "Events involving this lot" from brief 04); _History_ (audit panel).

**Lifecycle.** active → consumed / shipped / quarantined / recalled / archived; quarantined →
active / recalled / archived; consumed or shipped → recalled / archived; recalled → archived;
archived is terminal. The dialog offers allowed targets only and a mandatory reason (min 3
characters) that lands in History.

**Manual lot creation** (rare, for imports; visually secondary): product picker, TLC text with
no TLC generation button and basis fixed to `imported`; new transformation/exempt-receipt TLCs are assigned only by the appropriate event, source as a segmented choice — TLC source location (picker filtered to
the "TLC source" role, readiness shown) **or** source reference text — and production / expiry
dates. A duplicate per tenant + source + TLC returns `LOT_DUPLICATE`: inline error linking to
the existing lot. The same TLC from two different sources is allowed and must not look wrong.

**Identity-locked state.** Once a finalized event references the lot, TLC, source and product
become read-only with a lock icon and "Identity locked — referenced by Receiving 09/14/2026. To
correct it, check downstream dependencies, then correct the event chain"; status and dates stay editable.

Demo lots: `OSS-260914-A1`, `OSS-260914-A2` — imported, source Yakima packhouse, 50 bags =
500 lb each, origin Receiving 09/14/2026, consumed; `NRF-260915-APL01` — transformation, source
Portland plant, 100 cases = 900 lb, origin Transformation 09/15/2026, shipped after 09/16/2026.

States to draw: list empty / loading / error / stale; list with the three demo lots; card
active (manual, no origin); card identity-locked with genealogy (two inputs → one output);
change-status dialog; refused transition (archived); manual form with location vs reference
source; `LOT_DUPLICATE` with link; reserved basis disabled; generic-profile card; Auditor.

## Who sees and edits what

| Persona                   | Profile settings | Parties / locations | Product description | Coverage review | Lots (create / status) |
| ------------------------- | ---------------- | ------------------- | ------------------- | --------------- | ---------------------- |
| Owner / Tenant Admin      | edit             | edit                | edit                | edit            | create / change        |
| QA / Traceability Manager | read             | edit                | edit                | edit            | create / change        |
| Receiving Operator        | —                | read                | read                | read            | read                   |
| Production Operator       | —                | read                | read                | read            | read                   |
| Shipping Operator         | —                | read                | read                | read            | read                   |
| Auditor / Read-only       | read             | read                | read                | read            | read                   |

Per the US-00 capability table. The existing `manager` edits master data and descriptions but
not coverage or lot status. Hidden actions are removed; "disabled" means allowed but blocked.

## Cross-cutting notes

- **KDE groups on forms.** Location Description, Product Description and Lot (TLC + source) are
  named groups with a caption — one group-header component that brief 03's CTE forms reuse —
  with two textual markers: "Required for export-ready" (seven location fields, packaging size /
  style, TLC + source) and "Optional" (identifiers, brand / commodity / variety, dates).
- **Snapshot note** under every description group: "Finalized events keep a copy of this
  description at finalization; editing here does not change history."
- **Audit trail panel.** Every card ends with a collapsed "History": time (MM/DD/YYYY hh:mm,
  tenant timezone), actor, action, before → after, reason when required. Brief 03 reuses it.
- **Formats and wording.** Dates MM/DD/YYYY in the tenant timezone; quantities decimal + unit
  ("500 lb", "100 case"); phone as entered; ZIP as text; state code; ISO country with display
  name. Only the allowed column of `docs/us/limitations.md`; "Data readiness", never a
  compliance score. Archive, not delete.
- **Accessibility (NFR-012) and Spanish expansion.** Keyboard-only flow, visible focus, labelled
  inputs, roles as a `fieldset` with legend, radio groups for address kind and coverage, status
  never by color alone, WCAG AA in both themes; chips and the badge survive 1.4× string length.
  Standard list states from brief 03 apply.

## How this grows

- **P1 fields land in existing groups**: review due date and its overdue chip, ingredient note,
  evidence link, expiry / best-by, a tenant-level TLC format rule under the TLC field; location
  edits after first use may warn "appears in 3 finalized events" (OQ-US01-7) in the alert slot
  the same-address alert uses. No second kind of card.
- **CSV import previews** (preview → applied / rejected / expired) add "Created by import" as a
  lot origin and reuse the readiness chip per preview row; the manual lot form becomes rare.
- **Partner expectation profiles (TRC-007, P1)** add a party-card section: inbound / outbound
  data channel, "requires case scans", buyer-specific extras — separate from the FTR minimum.
- **Events, cases, timeline, tiles** fill the placeholders reserved on the lot card and the
  overview; nothing is redrawn. The station learns about lots in US-10 (GTIN-optional hint).

## Questions for the designer

1. Is "Traceability" a sidebar section among the others (the spec's choice), or should it define
   the U.S. deployment's primary navigation order?
2. How should the profile select explain the two U.S. options without implying a country switch?
3. Fresh-tenant overview: the onboarding checklist proposed in screen 1, or only quick actions?
4. Where does the `US · FSMA 204` badge sit when the organization name is long at 1024px?
5. Coverage as a radio group with five explained options, or a select with a help drawer, for a
   QA manager reviewing forty products?
6. Refused profile change: disabled select with explanation, or an enabled select whose confirm
   dialog explains the refusal?
7. Same-address warning: alert above the form or under the address field? Identity lock: icon
   per field or one banner on the Lot group?
8. Under the generic profile, is the "FTR applicability not assessed in this profile" sentence a banner on every
   Traceability page, or only on the settings card, product tab and lot card?

## P0 screen corrections

The shared-contract navigation replaces the broad legacy navigation table above: hide Billing, Shifts, Lines, Inventory, Employees and Devices in P0. Do not render readiness/case placeholders as implemented UI. Quick actions follow capabilities; receiving users cannot create master data by opening a picker. For foreign locations collect comparable regional/postal fields, not mandatory U.S. state/ZIP formats. The identity-lock correction dialog must first check finalized downstream dependencies.
