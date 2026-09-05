# U.S. Design Brief 00 — Project Overview

The [2026-09-05 design baseline](08-design-baseline.md) maps the finalized 128-screen Pencil atlas to these briefs and records implementation decisions and verification limits. US-00 development has started with shared domain rules; runtime integration is not yet implemented.

> Revised 2026-09-04: read the [shared MVP contract](../../us/mvp-contract.md) first. It resolves cross-slice scope and safety rules and supersedes conflicting draft recommendations below. Design only; implementation is not claimed.

> Read this first. It opens a **new series** under `docs/design-briefs/us/`
> for the U.S. adaptation of Markiro. The series is a **delta** to the RU
> briefs 00–09 and to the accepted Figma design system: same brand, same
> tokens, same office and floor modes, same components. What is new is a
> bounded area of the admin panel ("Traceability"), a small floor-mode delta on
> the line station, U.S. language, U.S. formats and a strict claims vocabulary.
> EN primary, U.S. Spanish secondary; light + dark; office mode desktop-first 1440
> (adaptive to 1024/768), floor mode 1280×800 tablet. Do not redesign anything
> that already exists — extend it.

## What we are building

**Markiro U.S. Traceability** is an intentionally bounded MVP demonstrator for
small and mid-sized U.S. food processors. It is designed to support applicable
FSMA 204 (FDA Food Traceability Rule) recordkeeping and recall-readiness
workflows. It reuses the Markiro codebase and design system but runs as a
separate U.S. deployment. It must never claim production readiness, FDA
approval, certification or guaranteed compliance (see the wording matrix below
— it is binding for every string you draw).

A tenant runs under exactly one **regulatory profile**, and the profile decides
what the interface shows:

| Profile                       | Who                                                        | Shows                                                                                                                 | Hides                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `US_FSMA204_PROCESSOR`        | A processor handling foods on the Food Traceability List   | Traceability area with three CTEs, FTL coverage review, TLC, Traceability Plan, trace requests, FDA-aligned workbook. | Chestny ZNAK, GIS MT, EGAIS, 1C sections; RU-only settings (INN, CHZ product group defaults, pickup policy).                                       |
| `US_GENERIC_LOT_TRACEABILITY` | Any other food or beverage maker (Scenario B: craft cider) | The same lot, event, search and readiness screens with generic labels ("Lot", "lot source"), optional case identity.  | Everything FTR-specific: coverage review, Traceability Plan, trace requests; every screen states "FTR applicability not assessed in this profile". |

The U.S. deployment allows only these two profiles. The active profile is
visible on every screen as a text badge in the header (`US · FSMA 204` or
`US · Generic`). Country and deployment edition are not tenant settings.

### P0 scope (what the mockups must cover)

1. **Master data:** parties (legal organizations) and their physical
   locations with the full FDA Location Description; product traceability
   profile with a manually reviewed FTL coverage status and a structured
   Product Description.
2. **Three critical tracking events (CTEs):** Receiving, Transformation,
   Shipping — each a draft-then-finalize record with grouped KDEs, reference
   documents, a completeness panel, and Amend / Void after finalization.
3. **Lots:** a traceability lot carries an opaque TLC, a TLC source (location
   or reference), an assignment basis and a lifecycle. Lots are created by
   Receiving and Transformation; Shipping never creates one.
4. **Genealogy and trace:** backward and forward trace from any lot, as a
   graph and as a table with identical counts; search by TLC, reference,
   SSCC or product.
5. **Data readiness:** a sweep that lists missing or inconsistent fields per
   record. The score is "Data readiness" — explanatory, never a compliance
   score.
6. **Traceability Plan:** versioned, derived from configuration plus
   narrative, approved into an effective PDF; previous versions retained.
7. **Trace request:** requester, received time, a **24-hour due time** with
   live countdown, scope, dry-run validation, then "Prepare package" — an
   FDA-aligned sortable workbook, the plan PDF, a validation report and a
   manifest, prepared in the U.S. instance.

### Explicitly out of scope — must not appear in the UI as if it existed

- Harvesting, Cooling, Initial Packing and First Land-Based Receiving CTEs
  (the overview screen names them as out of scope; no menu item, no stub form).
- An exemptions or waivers engine; automatic coverage decisions.
- Direct FDA submission, Safety Reporting Portal integration, any "Send to
  FDA" button. The verb is always "Prepare".
- EPCIS/CBV adapter (allowed mention: "EPCIS integration is outside the MVP scope").
- Mandatory item-level serialization, RFID or case-by-case scanning.
- Commercial billing, payment and self-service sign-up; SOC 2 badges.
- A receiving or shipping mode on the station (P2).

## Who it is for

**Buyer:** owner or plant manager of a small or medium U.S. food processor,
1–3 sites, no IT department, often one QA person who also "does compliance".
They have read that an FDA request must be answered within 24 hours and want a
tool that makes that a routine, not a crisis.

**Users** (names are used throughout the series; from `docs/us/demo-scenario.md`):

| Persona                   | Where                | Needs                                                                                                              |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Owner / Tenant Admin      | Admin panel          | Pick the profile, set timezone and retention, add locations and roles, glance at readiness. Does this once.        |
| QA / Traceability Manager | Admin panel          | Review FTL coverage, define TLC practice, finalize / amend / void events, own the Plan, run trace requests. Daily. |
| Receiving Operator        | Admin panel (office) | Record an inbound delivery: lots, quantities, source, ASN/BOL. Fast form, clear "what is still missing".           |
| Production Operator       | Line station (floor) | Runs the shift; in P1 sees the output lot on the work screen and links closed cases to it.                         |
| Shipping Operator         | Admin panel (office) | Pick lot, quantity, cases and recipient; attach BOL/invoice. Must be stopped from inventing a new TLC.             |
| Auditor / Read-only       | Admin panel          | Reads history, revisions, artifacts and hashes. Never edits. Needs to see immutability, not be told about it.      |

## The two products touched

1. **Admin panel (office mode)** gets a new top-level sidebar section
   **Traceability** with an overview page and the screens listed in briefs
   02–05. It also gets a "Regulatory profile" block in Settings and a header
   badge. Five RU items disappear for U.S. profiles: Codes, Conflicts, Pickup,
   Disaggregation, Integrations. Shared operational pages do not automatically carry over: the P0 navigation allow-list is in the shared MVP contract.
2. **Line station (floor mode)** gets a small P1 delta (brief 06): a
   "Traceability lot" card on the aggregation work screen, a warn/block
   full-screen state when a case cannot be linked to the lot, a "Not linked"
   chip, English locale with U.S. dates, and two English 4×6 in stock label
   templates. No new task flows.

## Hard requirements (apply to every U.S. screen)

- **Language:** English (`en-US`) primary, U.S. Spanish (`es-US`) secondary.
  Every U.S. key has EN/ES copy; check Spanish expansion on key screens at 1024 px.
  No Russian U.S. interface or transliterated legacy terms. See brief 01.
- **Themes:** light and dark from day one, office and floor.
- **U.S. formats:** dates `MM/DD/YYYY` in the tenant timezone (with the zone
  shown where it matters); quantities as decimal + explicit unit (`500 lb`,
  `100 case`, `24 cup`) with no silent conversion; phone `+1 (509) 555-0101`
  stored and shown as typed; addresses with state code and ZIP; country. Full
  rules in brief 01.
- **Wording:** every status, banner, button, tooltip and export text uses only
  the "Allowed" column. The matrix from `docs/us/limitations.md`:

| Allowed                                                             | Not allowed                      |
| ------------------------------------------------------------------- | -------------------------------- |
| Designed to support applicable FSMA 204 recordkeeping requirements. | FDA approved / FDA certified.    |
| FDA-aligned electronic sortable spreadsheet.                        | Official FDA integration.        |
| Traceability readiness demonstrator.                                | Guarantees compliance.           |
| Lot-level workflow with optional case scanning.                     | FDA requires serialization/SSCC. |
| EPCIS integration is outside the MVP scope.                         | EPCIS is required by FDA.        |

Public regulatory claims remain within the limitations matrix. A specialist review does not automatically unlock stronger claims. Content tests distinguish affirmative claims from the exact approved negated disclaimer, negative-test examples and ordinary actions such as “Approve version”.

- **Accessibility (NFR-012):** keyboard operation for every flow, visible
  focus, every input labelled, status never by color alone (icon or shape +
  text), WCAG AA in both themes; floor mode AAA for signals.
- **States for every screen:** empty, loading, error, offline/stale — plus the
  domain states: `draft / finalized / amended / void` for events;
  `blocked: complete data first` when Finalize is disabled by the
  completeness panel; `blocked by profile` when a feature does not exist in
  the active profile (hidden in nav, explained if reached by URL).
- **Immutability is visible, not implied:** a finalized record has no Edit or
  Delete. It has Amend (creates revision N+1 with a mandatory reason) and Void
  (keeps the record, adds reason and actor). Prior revisions stay readable and
  linked. Exports and packages are frozen revisions with hashes shown in the
  UI.

## Regulatory vocabulary designers must get right

| Term                | Plain-English meaning for the screen                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| FTR                 | The FDA Food Traceability Rule (21 CFR Part 1 Subpart S). Never abbreviated as "the FDA rule" in UI.                                                  |
| FTL                 | Food Traceability List — the FDA list of foods the rule covers. Fresh-cut fruits are included; the generic profile makes no applicability assessment. |
| CTE                 | Critical Tracking Event — a moment that must be recorded. P0 has three: Receiving, Transformation, Shipping.                                          |
| KDE                 | Key Data Element — a field that must be recorded for a CTE. Forms group fields by KDE group.                                                          |
| TLC                 | Traceability Lot Code — the lot identifier. An opaque string; we never impose a format or assume global uniqueness.                                   |
| TLC source          | The physical location where the TLC was assigned (or a reference that lets FDA find it). Every lot must have one.                                     |
| Lot                 | A traceability lot: product + TLC + source + basis + status. Not a shift, not a box.                                                                  |
| Case / SSCC         | Optional case identity from the existing Markiro box layer. Never mandatory; wording is "optional case scanning".                                     |
| Traceability Plan   | A versioned document describing how the processor keeps records, identifies FTL foods and assigns TLCs, with a contact.                               |
| Trace request       | A mock (or real) request for records; has a received time and a 24-hour due time; ends in a package prepared in the U.S. instance.                    |
| Regulatory baseline | The dated set of FDA sources the product was built against (`US-REG-2026-09-03`); stamped on profile, plan and exports.                               |
| Data readiness      | The completeness sweep and its score. Never "compliance score".                                                                                       |

## Deliverables for the U.S. series

| #   | Brief                            | Produces                                                                                                                                      |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 00  | Project overview (this)          | Shared context, vocabulary, hard rules                                                                                                        |
| 01  | Language, formats and adaptation | EN copy rules, claims matrix with microcopy, terminology map, U.S. formats, status chip vocabulary, baseline stamp and disclaimer patterns    |
| 02  | Onboarding and master data       | Regulatory profile in Settings, Traceability overview, parties, locations (Location Description), product FTL review card, lots list and card |
| 03  | CTE events                       | Receiving, Transformation, Shipping: list, form, detail; completeness panel; Finalize / Amend / Void dialogs; revision history; documents     |
| 04  | Trace and readiness              | Trace search, lot trace (graph + table), lot card panels, Data readiness page                                                                 |
| 05  | Plan and trace request           | Plan versions and editor with derived sections, PDF preview; trace request list, four-step wizard, 24-hour countdown, package and artifacts   |
| 06  | Station lot link                 | Floor-mode delta: lot card on the work screen, warn/block link states, "Not linked" chip, U.S. label templates, locale, station settings page |
| 07  | Landing and demo assets          | `/en/us-food-traceability/` page sections, video poster and one-pager wording — all under the claims matrix                                   |

## What already exists and must be reused

Do not draw new primitives for any of these; instance the library:

- **Sidebar navigation and sections** (brief 03) — Traceability is one more
  section, drawn like Production or Reference.
- **Tables** with sorting, filters, pagination, empty/loading/error/stale
  variants (briefs 02, 03).
- **Side panels** for create/edit next to a list (brief 03 catalog and
  counterparties; brief 08 channel settings).
- **Status chips** — the existing `ok / error / warn / info / neutral` chip
  with glyph + text (brief 02). Brief 01 maps every U.S. status onto these.
- **Banners / inline alerts** (brief 03 billing banners, brief 08 journal
  surfaces) for revision notices, configuration-changed and stale warnings.
- **Empty states** with a single primary action (brief 03 cross-cutting).
- **Confirm dialogs** for destructive or irreversible actions (brief 03) —
  reused for Finalize, Void, Approve plan, Prepare package.
- **Journal / revision list** pattern from brief 08 (time, actor, outcome,
  one-line summary, expandable detail) — reused for revision history and
  export runs.
- **Definition grid** and left-border timeline from the code card (brief 03
  History & codes) — reused for lot cards and KDE read-only views.
- **Floor-mode signals** (brief 04): full-screen confirm/blocked states,
  status bar chips, 64 px targets — reused for the lot-link warn/block.
- **Secret-shown-once and hash display** (briefs 07, 08) — reused for SHA-256
  of artifacts.

## How the U.S. deployment relates to the RU product

- One codebase and one design system serve two deployments. The U.S. build
  contains the Traceability navigation and no country switch. The Russian
  deployment keeps its current navigation and behavior.
- Shared screens (Catalog, Shifts, Labels, Devices, Team, Settings) gain small
  profile-aware inserts: a coverage column and FTL review side panel in the
  catalog, a "Traceability (U.S.)" field group in the label editor, a
  "Regulatory profile" block in Settings, five new roles in Team. These are
  drawn as additions inside existing layouts.
- **One design language, do not fork the design system.** No U.S.-only accent,
  no second icon style, no second chip family. If a U.S. screen seems to need
  a component the library lacks, propose it as a library addition that RU
  screens could also use — and say so in the brief's questions.
- A synthetic demo tenant runs in **evidence mode**: a persistent top ribbon
  `Synthetic demo · us-demo-2026.09/01 · build a1b2c3d · baseline US-REG-2026-09-03 · 09/17/2026`
  (text only, `role="status"`) and the route path in every page footer. Draw
  it once in brief 02; every later screenshot may carry it.

## Questions for the designer (series-level)

1. Should the U.S. product get any visual differentiation beyond the header
   badge, or none at all? Our default is none so it remains recognizably Markiro.
2. The existing `warn` chip glyph (⧉) was designed for "duplicate". U.S.
   screens use `warn` for "needs attention" — do we need a second glyph
   variant in the library, or a neutral attention glyph for both products?
3. The evidence ribbon plus billing banners plus a revision banner could stack
   three bars on one page. Propose a stacking order and a collapse rule.

## P0 handoff corrections

Use the navigation and capability matrix in the shared contract. No Billing, acquisition form or Station controls in P0. Server-side case-link controls, Cases panel and SSCC lookup are P0. Show the 100-case quantity separately from 100 synthetic linked records; do not imply scans or physical closure. `packages/ui` is the token/component source of truth; Figma and historical HTML are references. The synthetic-data badge is permanent. Every shown action must map to an authorized API, not merely a role label.
