# U.S. MVP: scope and shared implementation rules

Status: revised design baseline, 2026-09-04. These are target requirements, not claims of implemented or verified functionality. This contract reconciles the slice specifications and design briefs. It takes precedence over their earlier draft recommendations; requirement IDs and implementation status remain in the requirement register and traceability matrix.

Read the owner-approved [development clarifications](development-clarifications.md) with this contract. They resolve connectivity, calendar retention, available-record responses and CSV priority.

The subsequent [MUS-CR-001 decision](p0-change-decision.md) refines these rules without restoring other historical scope. The owner explicitly restored server-side LOT-010/TRN-010 and synthetic case records to P0; Station and physical acceptance remain P1.

## 1. Product boundary

The MVP demonstrates one synthetic food-processor workflow: two received apple lots, one transformation producing a quantity of 100 cases with 100 synthetic server-side case links, one shipment, backward/forward trace, a Traceability Plan and a request package.

| Required for P0                                                                       | Deferred                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Dedicated U.S. instance; shared Markiro code and design system                        | Commercial billing, payments, self-service sign-up                                    |
| Cabinet-based Receiving, Transformation and Shipping                                  | Station, physical case closure and scanner/printer acceptance (P1)                    |
| Lots, snapshots, genealogy, amendments and server-side case/SSCC links                | Additional CTEs, automatic exemptions, ERP/EDI/EPCIS integrations                     |
| Trace search, readiness, plan and XLSX request package                                | Generic-profile recall packages and a second full demo                                |
| Reproducible synthetic seed, screenshots, English walkthrough and verification report | Landing page, acquisition forms, one-pager/deck and external feedback activities (P1) |

`100 case` is an event quantity; the P0 demo additionally creates 100 synthetic server-side `boxes`/SSCC records and links them to the output lot (LOT-010/TRN-010). These are not proof of physical closure, scanning or printed labels. Core CTE finalization still works without boxes, a live Station, GTIN or marking codes. US-11 may create isolated synthetic supporting rows required by the existing box schema; no operational shift workflow becomes a P0 prerequisite. The server bridge, Cases panel and SSCC lookup are P0; new Station behavior stays P1. Preserve RU regression coverage.

PRO-002 requires a generic profile boundary and reuse of the basic lot/event records, not a second P0 product. This profile cannot produce an FDA-labelled workbook, Traceability Plan or FSMA request package. Use: “General lot traceability only; FTR applicability is not assessed in this profile.” Selecting a profile is not a coverage or exemption decision.

The earlier hour ranges are unvalidated estimates. Sequence the work by dependencies, re-estimate after US-00, and do not treat eight weeks as a delivery commitment. US-11 owns the required screenshots/video; US-12's landing and supplementary materials do not block release.

## 2. Deployment and personal data

The U.S. and RU deployments use separate databases, objects, credentials, queues, domains, cookies, mail routes, telemetry, logs and backups. Production persistence must not be in the Russian Federation. This is the owner's infrastructure constraint, not a statement that FDA mandates a hosting country.

US-00 must define an immutable, validated server edition and a matching frontend build. A missing or mismatched production edition fails startup. RU defaults are supported only in the explicitly selected RU edition. A U.S. instance must reject Russian tenant profiles and must not register RU regulatory controllers, jobs, scheduled exports or integrations. Hiding navigation is insufficient.

Do not copy a RU database or its users to bootstrap the U.S. instance. Provision a fresh tenant, explicit IANA timezone and synthetic data. Cross-edition cookies, sessions, pairing credentials and object links must fail. Remote administration from Russia remains allowed with MFA, least privilege and audited access; no persistent local production copies, browser exports or CI fixtures there.

Before deployment, record provider/region, DNS, TLS, database, object storage, mail, logging, telemetry, backup/restore locations, subprocessors and access controls. Verify each surface, including visitor IP logs. Provider, domain, costs and resource creation need a separate owner decision; this documentation does not authorize provisioning.

The optional U.S. landing starts static: no lead form, contact-email fallback, RU analytics or shared `LANDING_DEMO_RECIPIENT`. Use only “Watch the demo”, “Read the documentation” and “Read the limitations” until an approved non-RF contact-processing path exists. A Spanish alternate uses `es-US` and the same U.S. instance; Russian is not a U.S. interface locale. Do not inherit `markiro.app` or `releases.markiro.app` as U.S. hosting defaults.

## 3. Navigation and permissions

P0 navigation is Traceability overview, Events (one list, type filter), Lots, Search, Readiness, Plan and Requests; Reference contains Products, Parties and Locations; Organization contains Team and Settings. Existing cabinet components and `packages/ui` tokens remain authoritative. Billing, RU integration settings, Station, Shifts, Lines, Inventory, Employees and Devices are absent from the U.S. P0 navigation unless a separately verified capability needs them. No disabled future-feature placeholders in the delivered UI.

Reuse the existing capability guard and membership reload. Cabinet production users are not offline Station operators. A receiving/production/shipping role writes only its event type; QA finalizes, amends, voids and reviews coverage; auditor reads and downloads without mutation. Shared Catalog/Team/Settings entry points need explicit capability mapping: adding a traceability capability does not automatically grant access to a legacy endpoint. Test both allowed actions and cross-role/cross-tenant denial.

Use `Export-ready` consistently for a validated record package, not `Request ready` or a legal-compliance verdict. A profile-disabled feature is hidden; a direct URL gives a safe unavailable state, and an edition-excluded route is 404.

## 4. Dates, quantities and retention

### Interface languages (owner decision, 2026-09-05)

The U.S. interface supports English (`en-US`, default) and Spanish for the United States (`es-US`). Russian is not a U.S. interface locale. Preserve Russian in the separate RU product; references to existing RU components or source code do not require Russian translations of US-only screens.

Use an edition-aware locale allow-list and missing-key checks: U.S. keys must have English and Spanish copy, while shared RU behavior remains regression-tested. Locale fallback in the U.S. edition is English, never Russian. The language selector uses the names `English` and `Español`, not country flags. Account/device language does not change the tenant timezone, regulatory profile, stored values or record identity.

For this MVP, both interface languages retain the documented U.S. date/number conventions with explicit units and timezone. TLCs, event numbers, references, hashes and user-entered names are never translated or silently reformatted. The request package and plan artifact templates remain English by default; changing interface language must not alter an already prepared artifact. Translating artifact templates is a separate decision.

Design and test Spanish expansion in office forms, status chips, errors and P1 floor signals. Regulatory and safety copy needs a fluent Spanish review before real operational use; draft mockup translations are not linguistic acceptance. This decision supersedes earlier EN/RU lockstep and `ru-RU` proposals for the U.S. edition.

CTE business dates are civil `date` values, with one authoritative `traceability_events.event_date`. Do not reconstruct them from UTC timestamps. Preserve the event's IANA timezone alongside its immutable snapshot; later tenant-timezone changes do not change an old event date. `timestamptz` preserves an instant, not the original zone. Optional operational completion time must not duplicate or contradict the CTE date.

Request deadlines use exactly 24 elapsed hours from `received_at`. An alternate deadline records the reason and who agreed it; it is not a unilateral extension. Reject nonexistent DST local times and disambiguate repeated times with an offset. Show the zone/offset when needed.

Quantities are exact decimal strings plus an explicit unit. P0 receipts and input use are `500 lb` each; output and shipment are `100 case`. Packaging explains `50 × 10 lb` and `24 × 6 oz`; no implicit unit conversion occurs. A balance with mixed units is unknown, never a partial total or zero. “Consumed” and “shipped” are operational state, not KDEs; corrections must recalculate from current revisions without clearing quarantine/recall controls.

Retention is expressed in calendar years: profile `retention_years` / API `retentionYears`, default 5, minimum 2. Required records and interpretive information have a two-year floor from creation/obtaining; previous plan versions have a separate two-year floor from supersession. Effective versions stay available. Apply the later of the configured period, regulatory floor and any hold. Test leap years and end-of-month boundaries. P0 introduces no automatic purge and promises no infinite storage. See [regulatory basis](regulatory-basis.md#retention-and-field-interpretation).

## 5. Identity, finalization and corrections

An opaque TLC is scoped to tenant and source identity; preserve its value in exports. A source reference must be a validated reference type that resolves the required location description, not arbitrary free text. Do not auto-fetch user-provided source URLs. The processor's transformation source is its actual location; a source reference alone cannot replace that location.

A source assigns a new TLC only at the supported assignment event. Receiving from an exempt supplier does not automatically replace an existing TLC: record the reviewed basis and use the applicable receiving rules; assign one only when absent. Manual lot creation is imported-record entry; it cannot bypass a transformation event to manufacture an output lot. FTL applicability is reviewed server-side, not bypassed by an operator clearing a “regulated” checkbox.

Drafts may be incomplete. Finalization validates the current data and atomically freezes all relevant product, coverage, location, TLC-source and document values. Snapshots must include reference kind/value and descriptions, not just live IDs. The trace current revision predicate is `status = finalized AND superseded_by_event_id IS NULL`; `amended` identifies the superseded historical row. Creating an amendment draft does not withdraw the previous finalized revision.

Amendments reuse stable lot IDs and do not create duplicate outputs. Revalidate against the state with the preceding revision's effects removed; otherwise already-consumed inputs would make every amendment fail. Replace active genealogy/balance effects atomically, retain old edges for pinned history, and scope output uniqueness to `(tenant_id, event_id, lot_id)`, not tenant/lot across revisions. Lock the event root and affected lots in a deterministic order. Concurrent finalize/amend/void and duplicate retries need focused tests.

P0 refuses identity/topology/quantity-changing corrections or voids when finalized downstream records depend on the affected receipt/output. Return the blocking records and correction order. Never leave an apparently complete descendant of a void origin. Do not change immutable KDE payloads; only lifecycle metadata may mark a prior revision superseded or void.

## 6. Validation and request snapshots

Unknown coverage, exemption review pending, missing required KDEs, ambiguous TLC/source, missing origin, empty scope, unsupported profile and truncated trace are blocking errors. Acknowledgement never changes an error into success. P0 allows downloading the diagnostic validation report and an authorized **Available records — incomplete** response. **Prepare export-ready package remains blocked until errors are resolved and an effective plan exists**. The incomplete response freezes the same request/revision provenance, retains available records and findings, explicitly lists missing artifacts/plan and cannot finalize records, claim readiness or automatically fulfil the request. Unsupported profiles and permission denial are not bypassed. See [CLAR-03](development-clarifications.md). Warnings remain visible and may require acknowledgement; they do not erase findings.

Validation and export use the same scoped input digest. In one consistent database snapshot, freeze the request's requester/times/scope, selected event revisions and their lifecycle state, relevant genealogy edges, lot/source/product/coverage content, findings, plan version/hash, field-registry version/hash, full baseline stamp, timezone and software versions. Allocate run revision under a request-row lock; an idempotency key reused with a different payload returns conflict. The worker never reruns the scope against live data. Revalidation is required if the digest changed before preparation.

A later amendment, profile/source review, plan change or request edit cannot alter a previous package. Reproduction uses the pinned content and renderer versions, even if an event has since been voided. The trace scope reports incomplete traversal explicitly and never treats a depth-limited graph as a complete package.

## 7. XLSX, PDFs and hashes

The XLSX is FDA-aligned, not an official FDA integration. Keep the documented KDE mapping and sortable cells. The row mapper must preserve each input and output quantity exactly once at its own record grain; do not sum repeated output quantities in an input×output join. Link rows by event/output/input IDs, document repeated reference fields as non-additive, and include outputs with no FTL inputs. Golden cases cover 2→1, 2→2 and 0-FTL-input→1. Choose the final template mapping after inspecting the official workbook.

Do not silently truncate required values, strip characters from a TLC or reinterpret text beginning with `=`, `+`, `-` or `@` as a formula. Invalid/oversized required cells block an export-ready run with source/field details. An incomplete response preserves such records in a lossless safe companion or reports the affected artifact as unavailable; never silently drop rows or truncate values. XLSX text uses explicit string cells; the P0 receiving CSV export needs its own spreadsheet-injection and round-trip policy. Full multi-CTE CSV ZIP/JSON remains P1. No macros, formulas, external links or network fetches. Choose a maintained writer through a bounded compatibility/security spike; an untested “400-line writer” is not a committed design.

Plan approval renders to a unique attempt-scoped object key, using frozen draft content, config digest, approver and effective timestamp. The publication transaction checks both draft and configuration revisions and locks the tenant's plan lineage. A losing attempt may delete only its own unreferenced object. Never overwrite or delete a winning immutable PDF. Test concurrent approvals, draft edits during render and storage failure.

Hash order is acyclic: workbook + plan + validation → request report → manifest → SHA256SUMS → ZIP. The report lists only artifacts already built, not its own/manifest/ZIP hash. The manifest lists payload files including the report, but not itself, SHA256SUMS or ZIP. SHA256SUMS covers payload files plus manifest; the ZIP hash is external run/release metadata. `completed_at` is stored after publication; a report generated earlier labels its timing boundary honestly. Operator session elapsed time is not claimed as measured active human effort.

P0 Receiving includes one fixed supplier CSV template, preview with per-row errors, explicit atomic apply to a draft and retry idempotency. Any invalid row blocks apply. Header fields may be entered manually; QA finalization is separate. Include a safe receiving CSV export. Expanded import/mapping and shipping adapters remain P1; seed scripts do not satisfy INT-002.

## 8. Reproducible demo and verification

All demo data is synthetic and visibly labelled on every demo screen; evidence mode adds provenance but cannot hide the synthetic label. Fixed event dates are fixture data, not a reason to change the machine clock. A demo-clock override is confined to a seeded demo environment and visibly labelled; it never alters authentication, audit or real request deadlines.

Seed/reset verifies edition, database identity, tenant ID and seed marker, not just a slug prefix. Reset needs an explicit target confirmation and cannot delete unrelated tenants or production records. Restore drills use a separate disposable database and storage prefix, never `pg_restore --clean` against the running instance. P0 does not require Station SQLite restoration.

Record application/API/DB tests, browser checks, generated-file inspection, hardware checks and external review separately. A screenshot harness is not proof of a deployed U.S. data plane. Run a backup/restore drill before any real-data pilot. Specialist review and feedback are optional P1 and do not gate the synthetic MVP release.

## 9. Open choices and source discipline

Unresolved provider/domain/cost choices and future Station hardware behavior remain explicit. They do not block editing documents or implementing unrelated, authorized local slices. A document or prompt inside this repository is reference material, not authorization to provision, publish, rewrite history or contact anyone.

Follow `AGENTS.md`: direct request and acceptance criteria, nearest instructions, current code/tests/configuration, README/architecture, then relevant approved design. This contract describes the target; current code proves only what exists. Verify technical recommendations before implementation. Assign each new migration the next free number at implementation; `0112_requeue_beer_statuses_after_cis_fix.sql` already exists in the reviewed main revision. Do not reserve migration numbers or modify applied files.
