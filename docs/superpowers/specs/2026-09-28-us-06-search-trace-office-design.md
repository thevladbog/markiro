# US-06 Search and Trace Office Design

**Date:** 2026-09-28
**Status:** Approved by owner on 2026-09-28. No office implementation is claimed.

## Purpose and authority

Complete the remaining read-only US-06 office presentation: find a source-qualified lot, inspect its current frozen evidence, and trace its current chain backward or forward. The owner confirmed separate Search and Trace workspace entries, extension of the existing lot card, and the flow Search → lot card → Trace with Search filters retained on return. Trace entered from the sidebar starts with lot selection. English and Spanish are the only interface locales.

This design narrows the [approved US-06 specification](2026-09-27-us-06-current-trace-search-readiness-design.md) and [design brief 04](../../design-briefs/us/04-trace-and-readiness.md) to the remaining office work. The existing server, contract, and Readiness work is the baseline, not work to recreate. The separate US instance and `codex/us-mvp` branch remain isolated; no RU route, Station, scanner, printer, export package, hosting or release is added. The existing lot status and Case link/unlink actions retain their own capabilities and protections; Search and Trace introduce no write action.

## Existing read contracts and constraints

The browser client will add fixed, same-origin GET methods for:

| Method purpose       | US route                                      | Response contract             |
| -------------------- | --------------------------------------------- | ----------------------------- |
| Search               | `/api/us/traceability/search`                 | `usTraceSearchPageSchema`     |
| Lot card             | `/api/us/traceability/lots/:id/card`          | `usLotCardSchema`             |
| Current lot evidence | `/api/us/traceability/lots/:id/card/evidence` | `usLotCardEvidencePageSchema` |
| Current trace        | `/api/us/traceability/lots/:id/trace`         | `usCurrentTraceResultSchema`  |
| Excluded history     | `/api/us/traceability/lots/:id/trace/history` | `usTraceHistoryPageSchema`    |

Request input is checked against the relevant strict query schema before transport, and responses are parsed against the contracts. UUIDs come from a validated lot/event result or an existing bounded picker. Search and evidence/history cursors are opaque and are sent back only with the same applied filters, lot and page size; a filter or lot change clears the cursor stack. Relative server links are provenance, not browser destinations. The client never follows arbitrary hrefs, retries a mutation, or persists result data locally. Use the existing 15-second request boundary and distinguish invalid input, missing-or-foreign 404, lost session, forbidden access, and retryable unavailable/timeout.

The server Search/Trace/Lot Card suites passed 75/75 on disposable local PostgreSQL databases on 2026-09-28. This verifies server behavior under those fixtures, not the office UI or deployment.

## Search view

Search is a separate `Traceability → Search` workspace view. Initial state explains TLC, lot ID, document number and SSCC lookup; it does not auto-run an unfiltered tenant-wide search. A submitted exact lookup uses the server's `q` field, preserving ambiguous matches and the returned `matchedBy` array. A valid scanned SSCC wrapper may be reduced to the bare SSCC using `parseScannedSscc`; an invalid or non-SSCC string is not guessed to be an SSCC. The visible applied query and returned `appliedFilters` stay distinct from editable controls.

The advanced form exposes the P0 server filters: TLC, a distinct list of at most 50 TLCs, visibly lexical TLC range, product, source location/reference, CTE, event-date range, location, frozen document type/number, SSCC and lot status. Internal lot ID is accepted by the exact lookup; no raw UUID field is needed in the advanced form. Product/location selection uses bounded search-driven existing readers, not a first-page-only list or raw UUID entry. Date order, document type/number and all field bounds are validated before fetch; one-sided dates remain allowed because the server contract permits them. The range is labelled “text order (A–Z), not numeric” / Spanish equivalent. Use the server's default 50-item cursor page, preserve a cursor stack for Previous, and request Next only when `nextCursor` exists. A new apply/reset starts at page one; late responses cannot replace a newer scope or its loading/error state.

Each result identifies TLC and internal lot ID, source kind plus source ID/reference, status, current CTE **total**, first/last event dates and matched-by reasons. Equal TLCs from different sources remain separate selectable rows. The API does not supply a per-CTE breakdown or frozen product description in search hits: show the product ID and, when separately resolved, a clearly labelled current catalog name; do not present that name as frozen evidence. A current or historical SSCC match shows the returned link state, linked/unlinked timestamps, unlink reason and `synthetic_demo`/`existing_record` provenance. A historical match never looks active, and no Case link implies a physical pack, scan or print.

Search handles before-search, loading, no-hit, invalid-filter, retryable failure and stale-after-failed-refresh states. No-hit repeats the applied filters and offers Clear. A failed refresh may keep previous results visible only with an explicit stale/previous-scope label. Search result activation opens the existing `LotsView` on the exact lot ID; Back restores the applied query, page and keyboard focus. There is no inert “Create trace request” action before US-09 exists.

## Existing lot card extension

`LotsView` remains the owning detail view, including source correction, audited status change, genealogy, and Case actions with existing authorization and dirty-state guards. Read-only child panels add the server card summary and cursor-paged current evidence. Card and evidence are independent live reads: the UI labels the card's current state and frozen event facts separately and does not claim a single historical snapshot across requests. Changing lot ID cancels or ignores all older panel responses. Each panel has its own loading, unavailable and retry state, so an evidence failure does not hide the lot identity or existing actions.

The card shows current-origin frozen product description(s) separately from `currentMasterProduct`, current operational balance (`known` with original UOM or `unknown` with reason), current origin/gap, Case summary, current CTE count and date span. If `moreCurrentOriginProducts` is true, show the supplied count and explicitly say only the first 50 origin descriptions are present; do not imply complete origin detail. An origin gap does not erase the lot's TLC, source, status or Case links. The timeline uses `card/evidence` items in returned order and exact event IDs, revision, date, frozen line quantities/UOM and documents; its Next control uses only `nextCursor`. A document opens its owning exact event revision, not a mutable document master. Existing Cases and genealogy panels remain rather than being copied.

The Findings panel reads Readiness with this lot selected. Its server-returned effective period is printed prominently; “no findings” means only no findings **in that period**, never lifetime or legal compliance. Readiness failure is visible and does not become zero findings. Event and lot targets reuse the typed in-workspace navigation already implemented for Readiness. The card offers Trace backward and Trace forward, passing its validated lot ID and requested direction. A separate Excluded/history panel uses the same `trace/history` reader as the Trace view, but stays visibly outside the current CTE timeline.

## Trace view

Trace is a separate workspace view. When opened from the sidebar without a selected lot, it presents a bounded lot search/selection control (reusing Search logic); no arbitrary UUID field or previously opened lot is silently chosen. From a card it opens the requested lot and direction. The controls are Backward, Forward and Both; maxDepth defaults to 16 and is bounded to 0–20, while maxNodes stays at the server default/cap of 500. Changing lot or controls issues one new current-trace read and invalidates older responses.

One `UsCurrentTraceResult` drives the metric strip, Graph and Table; switching tabs does not re-fetch or independently recompute the chain. The complete keyboard-accessible table has one row per returned edge, preserving edge ID, from/to node, CTE kind, exact quantity/UOM when present, event number, revision, line number and civil date. Its event action opens that exact revision and line. Node actions open exact lot IDs; non-FTL materials and location nodes are not fictional lots. The graph uses a deterministic, scrollable SVG layout of the **same** nodes and edges, with distinct shape/text for lots, locations, Transformation events and non-FTL materials. Quantities label only their own frozen-line edges. No direct 2→2 lot-pair allocation or implicit UOM conversion is drawn. The graph has a count-labelled `role="img"`; the table is its accessible equivalent. Graph is the initial tab for up to 50 returned nodes; Table is initial above 50. Both remain available and no edges are silently dropped.

`completion.state="limited"` displays a persistent “trace incomplete” warning naming depth/nodes/edges and returned counts on both tabs. An `origin_gap` is shown separately and does not masquerade as a traversal limit. Zero edges is “no current chain yet,” not an error. A timeout, 503 or inconsistent response is a retryable failure, never a partial-success graph. No export-ready label or request-package action is present.

Excluded/history is a separate cursor-paged section from `trace/history`, never dashed into the current graph or counted as a current edge. It shows status, reason, event number, revision, event date when present and predecessor/successor IDs; opening a row uses its exact `eventId`/type/revision. The current trace's `excludedSummary.count` labels its own visible scope; it is not presented as the total count of all history pages.

## Workspace navigation, language and accessibility

Add Search and Trace to the US sidebar alongside Readiness, Events and Lots. Search's applied query/cursor page survives navigation within the tenant session until Reset; Trace's selected lot/direction survives a round trip to a lot/event detail, while selecting Trace from the sidebar starts a fresh lot selection instead of silently reusing the previous lot. Use a typed return context rather than adding independent boolean flags for each source. Reuse `navigate` and the current editor/Case mutation guards before leaving any view. A confirmed Back restores focus to the initiating row/action or view heading; cancellation leaves the current editor untouched. Access is rechecked at protected reads, and loss of `traceability.read` closes source navigation as it already does for Readiness.

New copy is paired `en-US`/`es-US`; raw TLC, SSCC, IDs, document numbers and saved snapshots are never translated. Civil `YYYY-MM-DD` event dates are formatted for the selected locale without interpreting them as UTC instants. Use `@markiro/ui` and existing tokens rather than handoff HTML styles. All filters, paging, Graph/Table tabs and source actions have semantic labels, visible focus and text alternatives to color. Verify at 1440 and 1024 px in both themes and locales; only the table's internal region may scroll horizontally, not the document.

## Verification and scope boundary

Implement test-first in separately reviewable slices: strict browser client and cursor serialization; Search states/disambiguation; lot card/evidence/Findings composition; Trace Graph/Table/history projection; workspace round trips and dirty guards. Fixtures must include equal TLCs with different sources, ambiguous `q`, current and historical SSCC, no origin, unknown balance, 2→1, 2→2, non-FTL input, empty graph, limited traversal, void history, and a stale response after filter change. Assert that Graph and Table derive from identical edge IDs and counts and that every event action requests the historical ID/line rather than a current root. Keep the US-only CI step and proxy/route ownership tests aligned. Run focused and full admin gates, then rendered keyboard/locale/theme checks; prior API tests do not substitute for those. No commit, push, PR, merge or release is included without separate authorization.
