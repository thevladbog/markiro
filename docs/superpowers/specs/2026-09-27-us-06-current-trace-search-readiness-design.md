# US-06 — Current Trace, Search, Lot Card and Readiness

**Date:** 2026-09-27

**Status:** Written specification approved by the owner on 2026-09-27. No implementation is claimed.

**Scope:** Isolated U.S. edition, P0 read-only traceability views. This design supersedes the technical and UI recommendations in the [2026-09-03 US-06 draft](2026-09-03-us-06-trace-search-completeness-design.md) where they differ.

## Outcome and boundaries

A U.S. tenant can find a lot by TLC, source, product, event date, document reference or SSCC; inspect its frozen event evidence; trace backward to recorded sources and forward to recorded shipments; and see concrete gaps before preparing a request. Graph and table are two views of one server result. The work stays on `codex/us-mvp` in the existing separate U.S. instance and does not mount U.S. routes in the RU application or enable a release.

P0 covers LOT-012 and TRC-001–006, TRC-008–009 in [requirements](../../us/requirements.md). TRC-007 partner expectation profiles and TRC-010 percentage score remain P1. The graph-speed and exact-search targets in [acceptance](../../us/acceptance.md) are measured and reported in P0, not P0 pass gates. US-07 and US-09 may later consume the selected revision and findings contracts; this slice neither prepares a package nor makes a regulatory determination. Station, scanning, printing, item serialization, and live deployment are outside this work.

The [shared MVP contract](../../us/mvp-contract.md) remains authoritative for current-versus-pinned revisions, identity corrections, incomplete responses, dates, quantities and language. A zero-case-link lot can still have a valid CTE trace; the separate 100-synthetic-case acceptance remains independent.

## Existing implementation to extend

- `apps/api/src/deployment/us-development.module.ts` is an explicit U.S. controller allowlist; `UsRuntime` owns its private database connection and stores. New controllers/stores join this allowlist only. `UsSessionGuard` and `authorizeUsMasterData` reload the current U.S. principal/capability; RU cabinet guards and code-search are not used.
- `traceability_events` supplies one civil `event_date`, immutable finalization snapshots, revision/lifecycle fields and tenant-scoped roots. Receiving, Transformation and Shipping already have separate current/history readers. The unified U.S. Events list includes drafts, which is useful for operations but is **not** the current-trace predicate.
- `readTransformationGenealogy` already supports bounded current/pinned queries in repeatable read. `lot_genealogy_edges` stores event/input/output identities, not quantity allocation. The input and output lines in the frozen Transformation snapshot own their respective quantities. In 2→2, each direct input→output edge must therefore remain quantity-free navigation, never an asserted allocation.
- The U.S. office application currently switches Events and Lots inside `apps/admin/src/us/master-data/workspace.tsx`; it does not use the old RU code-search routes. US-06 adds U.S. workspace views and record-opening callbacks without depending on RU pages. If shareable URLs are added later, they must resolve through the same U.S. authorization and view state.
- Existing lot Cases and Transformation genealogy panels remain; US-06 composes rather than replaces them. The server case bridge records active/historical links and synthetic-vs-existing provenance without a Station dependency.

## P0 delivery order

1. **Current trace contract and server**: one tenant-authorized, consistent, bounded read of Receiving → Transformation → Shipping, with graph/table projection and excluded-history summary. This is the first implementation plan and regression gate.
2. **Search and lot card**: source-qualified TLC disambiguation, frozen-document and current/historical SSCC search, current CTE timeline, documents and provenance. Search results open the existing U.S. lot/event views.
3. **Readiness**: pure cross-record rules composed with existing CTE validators, concrete findings/counts and separate draft work. No percentage or legal verdict.
4. **Office presentation**: Graph/Table and Excluded/history views, search, card and readiness inside the U.S. workspace, EN/ES and accessible at 1024 px. Each server phase gets focused API/contract tests before its UI is claimed complete.

Each phase gets a separately reviewed implementation plan. Later phases may consume the trace contract but do not delay the first server read. No phase authorizes deployment or provider provisioning.

## Current trace contract

`GET /api/us/traceability/lots/:id/trace` takes strict `direction=backward|forward|both` (default `both`), `maxDepth` (default 16, hard cap 20) and `maxNodes` (hard cap 500). The server also bounds edges to 2,000; it uses a limit sentinel rather than silently dropping rows. The authorized tenant and actor come only from the verified session, never query input. A foreign or missing lot returns the same 404. The read checks the current U.S. read capability within its repeatable-read transaction, makes no business or audit writes, and does not hydrate frozen event data with mutable current master descriptions.

The current predicate for every CTE is a tenant-matching root whose `current_event_id` points to an event with `status='finalized'` and `superseded_by_event_id IS NULL`. A pending amendment does not withdraw its predecessor. Void, amended, superseded and draft rows are absent from the current graph/table. The server validates the root/row/snapshot relationship rather than treating missing or contradictory storage as a shorter valid chain.

The response contains the root lot, direction, ordered `nodes` and `edges`, current event references, `excludedSummary`, and `completion`. The graph and table render the **same edge array**: one row per edge, no separately computed totals. Each evidence edge carries event ID, event number, revision, frozen line ID/position, CTE date, exact decimal quantity and UOM where that line records them. A node without an owning event (for example a lot identity) identifies its source lot row separately; it does not invent event provenance.

| Evidence                     | Graph form                                                                   | Quantity source       |
| ---------------------------- | ---------------------------------------------------------------------------- | --------------------- |
| Receiving                    | Previous/source location → received lot                                      | Frozen Receiving line |
| Transformation FTL input     | Input lot → Transformation event node                                        | Frozen input line     |
| Transformation non-FTL input | Explicit non-FTL material node → Transformation event node, no synthetic TLC | Frozen input line     |
| Transformation output        | Transformation event node → output lot                                       | Frozen output line    |
| Shipping                     | Shipped lot → recipient location                                             | Frozen Shipping line  |

For 2→2, one Transformation event connects both input lines and both output lines. The four stored lot-to-lot genealogy links may support traversal and a quantity-free navigation list, but they are not four quantity-bearing transfers. Repeated lines remain distinct by source-line identity. Civil dates come from `traceability_events.event_date`; the recorded event timezone is displayed, not recomputed from a later tenant setting. Location, product, source and document labels come from the saved event snapshots.

Traversal is breadth-first by lot hop, deterministic by event ID and line order, cycle-safe and bounded. `maxDepth` counts lot hops; `maxNodes` counts every rendered node kind and the edge cap counts every rendered evidence edge. An event expansion is atomic for the returned graph: it shows all frozen input and output lines, including co-inputs/co-outputs in 2→2, or stops before that event and marks the limit. Backward traversal continues through input lots; forward traversal continues through output lots, rather than treating co-inputs as descendants. If a depth/node/edge limit prevents complete expansion, `completion.state='limited'` names the limit and returned counts; graph and table show the same warning and cannot be treated as a complete request scope. An absent current origin after a permitted void is a separate `origin_gap` finding, not a traversal limit. Database inconsistency or timeout is a retryable error, **not** HTTP 200 with a fabricated partial-success graph.

`GET /api/us/traceability/lots/:id/trace/history` is a separately paginated, read-only view of related draft, amended, superseded and void revisions, with status, reason, predecessor/successor links and frozen-record navigation. Its rows never enter the current graph/table. History pagination uses a stable key/cursor and bounded page size; the current trace response only reports the excluded count relevant to the visible scope. The history endpoint applies the same tenant/capability boundary. A later US-09 pinned request reader will select frozen revision IDs and lifecycle state explicitly; it must not reinterpret the current endpoint as historical reconstruction.

## Search and lot card

`GET /api/us/traceability/search` returns tenant-scoped lot hits with `matchedBy`, source-qualified identity, current-chain counts and first/last civil dates, and normalized applied filters. P0 filters cover exact TLC/list and lexicographic TLC range (visibly labelled text order), internal lot ID, product, CTE, event-date range, location, frozen document type/number, SSCC and lot status. Default page size is 50 and all queries are bounded. Opaque TLCs are not parsed as numbers. If an entered value can match more than one kind, the response keeps every legitimate match with its `matchedBy` evidence instead of choosing a type silently.

Equal TLCs from different source identities return distinct rows with source location/reference shown before selection; no first-match redirect. Document-number search uses the number frozen on the event revision, not a mutable reference-document name. SSCC lookup uses the existing bridge and includes both active and historical links, clearly labelled with link timestamps, unlink reason when present and `synthetic_demo`/`existing_record` provenance. A historical SSCC hit must not be presented as a current case link. Search does not imply that a case was physically packed, scanned or printed.

The lot card composes the existing lot identity/status/source, Cases and genealogy views with the product description snapshot from its current origin where available, a current CTE timeline, frozen document list and findings. Current master values and frozen descriptions are labelled separately. Every timeline/document/finding row opens the exact event and revision that supplied it. Historical revisions appear in a distinct expandable history section. A lot with no current origin remains visible with an explicit origin gap; its ID, TLC, source, status and existing case links are not silently changed. Balance is current operational information with its own UOM/unknown state, not reconstructed historical before/after inventory.

## Readiness

`GET /api/us/traceability/readiness` evaluates an explicit displayed scope (default last 24 months, with date/product/lot filters) over current finalized records in one consistent read. The response has scope, records checked, findings grouped by CTE/product/severity and counts of errors/warnings/info; it has **no percentage or score** in P0. A filtered “no findings” result means no findings **in that displayed scope**, not whole-tenant compliance. Draft work is separately listed as incomplete preparation and never silently counted as finalized KDE evidence.

Pure rules reuse Receiving, Transformation and Shipping finalization validators where their frozen inputs apply, plus cross-record checks for missing current origin, broken event–lot relation, missing/faulty frozen location/product/source pieces, invalid or absent quantities/UOM, required references and TLC/source inconsistency. Each finding has a stable code, severity, field, lot/event/revision/line provenance and a link to the source record. FTL-specific coverage findings run only for `US_FSMA204_PROCESSOR`; generic-profile screens say “General lot traceability only; FTR applicability is not assessed in this profile.” Neither profile receives an automatic legal conclusion.

A current TLC/source mismatch is an error even if the event has a higher revision. An amendment reason explains a historical correction; revision number alone never downgrades an unresolved current mismatch. Historical resolved discrepancies may be shown as history/info, separately from current findings. Partner-specific extras and a percentage score remain P1 and must not be mixed into required P0 elements.

## Office design and states

The U.S. workspace adds Search, Trace and Readiness navigation while preserving the current Events and Lots editors. The trace page has direction/depth controls, one metric strip and Graph/Table tabs over the same response. The graph distinguishes lots, locations, Transformation events and non-FTL materials by shape/text as well as color; the table is the complete keyboard-accessible representation. A separate Excluded/history section shows reasons and exact revision links. There is no “include drafts in current graph” toggle.

Search has input, multi-hit disambiguation, empty, loading, stale-refresh and error states. The card has current and historical timelines, origin-gap and unknown-balance states. Readiness shows concrete findings/counts or a scoped no-data/no-gaps state, with retry on read failure. Both languages are `en-US` and `es-US`; neither raw identifiers nor saved snapshots are translated. Use `@markiro/ui` components/tokens and verify 1024 px, light/dark, keyboard focus and non-color-only statuses. US-06 views add no write controls; existing lot-status and case-link actions remain separate authorized commands owned by their earlier slices.

## Failure policy and verification

Strict malformed input and exceeded request bounds return 400; missing/foreign resources return 404; absent session/current read capability return 401/403; unavailable or inconsistent storage returns a safe retryable 503. A statement timeout is failure, not `completion.state='limited'`. No read logs raw TLC lists or full document content. Any future index migration is additive, based on a query plan and the current schema; this spec does not reserve migration numbers or alter RU tables.

Tests precede implementation in each plan. Contract/domain tests cover strict bounds, deterministic graph/table projection, exact line quantities for 2→1 and 2→2, zero-FTL-input output, cycles and limit semantics. Disposable-PostgreSQL API tests cover all three CTEs, amendment/void/current-root selection, origin gaps, concurrent reads against finalization, cross-tenant 404, role/profile denial, no read-side audit/business writes, document and SSCC history, and error-vs-limit behavior. Admin component/browser checks cover shared counts, source-qualified results, history separation, finding links, EN/ES, 1024 px, light/dark and keyboard access. Timed seed checks report performance separately. No automated test substitutes for live hosting, scanner, printer, physical case or regulatory acceptance.
