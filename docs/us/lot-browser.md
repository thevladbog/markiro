# US lot browser increment

Status: connected locally on 2026-09-06, extended 2026-09-08; development-only, release locked. US-02 remains partial.

## Available behavior

Lots joins Products, Parties and Locations in the isolated US workspace. The registry has 50-row pagination, all six status filters and bounded TLC/source-reference search, not product-name search. Opening a lot reads its current server record. Product/location names are current reference data, explicitly distinguished from historical event snapshots. Stored identity, source, revision, historical actor IDs and organization-time-zone timestamps remain visible.

Users with `traceability.master_data.write` can create an imported lot, including for a GTIN-less product. TLC uses the shared opaque Unicode contract, preserving case and formula-leading text after outer whitespace trimming. Source may be absent, a location, or a typed HTTP(S) reference with its resolved location. Active product/location selectors have bounded search and pagination. Source URLs are text, never fetched or verified.

Source correction keeps UUID, TLC and product unchanged and sends only source, required reason and loaded revision. A locked source has no correction action or unlock route. An unchanged source sends no request. QA status changes independently require `traceability.qa.manage`, use domain-allowed transitions and send status, reason and loaded revision. Manual status changes do not calculate balances or imply event finalization. Authorization and audit remain server-side.

Dirty navigation and page unload warn before discarding input. Pending commands block navigation and repeat submission. EN/ES and theme changes retain drafts. Denied mutations refresh capabilities; read revocation clears protected content and session loss exits the workspace. Transient permission-refresh failure keeps the mounted draft disabled with workspace retry. There is no autosave, browser draft persistence or automatic mutation retry.

Revision conflict, source locking or an uncertain command result requires explicit successful reload before another command. Cancelling the editor does not clear this invalidation. Confirmed reload failure preserves the draft and block. Duplicate responses retain only a validated existing lot UUID; opening it requires confirmation before discarding a dirty draft. Raw server details are never displayed.

The UI follows the approved Pencil registry/detail/controlled-status grouping and existing Markiro components/tokens. Unimplemented event history, genealogy, balances, trace and export actions are not simulated. The generic profile states that FTR applicability is not assessed. This is not a compliance or request-readiness claim.

## Current receiving basis — 2026-09-08

Lot detail now reads the existing tenant-scoped receiving-basis endpoint separately
from the lot record. Current receiving basis / Base de recepción vigente shows the
authoritative count of supporting revisions, their exact receipt/revision links
and linked line numbers. Assignment basis remains a separate historical identity
field. Missing support does not archive the lot, change its status, unlock its
source or establish inventory, completeness or export readiness.

Loading and unavailable responses are not interpreted as missing. The presentation
uses the validated server `state` and `supportCount`, not the current page length.
An empty later page with positive count remains present and offers previous-page
navigation. Pages contain at most 50 revisions, with the contract's 100,000 offset
bound. Refresh resets to the first page; reloading a lot also refreshes support,
even when its record revision did not change. Late reads are ignored after leaving.

Opening a basis link performs a fresh exact-revision GET and checks root, number,
revision and referenced lot/line bindings. Failure keeps the current lot and allows
an explicit GET retry. Receipt-to-lot and lot-to-receipt entry contexts coexist;
return works after successful and failed lot lookups. The existing workspace lock
blocks navigation during an exact-revision read; access and session failures use
existing callbacks. No new writes, role grants, routes or persistent cache.

The connected `us-lots-ui` suite covers count-versus-lines, missing versus active
status, loading/error, positive-count empty pages, exact lookup mismatch/retry,
both return contexts, access revocation, obsolete responses, pending navigation,
unchanged-revision reload and Spanish copy. The read-only real browser companion
`tools/us-development/test/lot-receiving-basis-flow.mjs` verifies real support and
missing support, failed GET recovery, keyboard activation and return, unchanged
complete lot/receipt records and no business writes. EN/ES light/dark at
1440/1024/390 include overflow and 44px mobile basis-control checks. It follows the
existing synthetic MFA fixture; no real or base database is used. Existing Markiro
components and tokens provide the layout, typography and mobile controls.

## Verification and isolation

Only the exact lot collection (optional query), UUID item and UUID `/source` and `/status` proxy paths were added. Item/command queries, malformed IDs, nested/unlock paths and RU routes remain blocked. No backend behavior, migration, dependency, primary application entry or release lock changed in this frontend increment. Previously implemented source-correction backend/migration changes remain local and uncommitted.

Focused tests cover strict commands, safe duplicates, roles/revocation, pending requests, translated drafts, source locks, allowed transitions, failed reload, conflict cancellation and reference-search keyboard submission. Parallel reference lookups prioritize authentication denials over transient failures, including later denials. New-lot detail names do not depend on the previous registry page.

The real Chromium scenario `tools/us-development/test/lot-flow.mjs` runs after real MFA with the disposable US fixture. It creates a GTIN-less imported lot, corrects source, changes status, checks exact before/after audit with actor/tenant/target/reason, and captures EN/ES light/dark layouts at 1440, 1024 and 390 pixels. The combined browser flow checks external requests, page errors and unwanted browser persistence. The real proxy smoke checks anonymous lot command denial and unknown-route refusal. Follow [browser prerequisites](browser-entry.md#verification); ports 3100/5174 and explicit synthetic `US_TEST_DATABASE_URL` are required.

Final counts are in [implementation progress](implementation-plan.md#us-02-connected-lot-ui--2026-09-06). Chromium remains a local check; check-only CI includes focused client/UI tests and the isolated build.

## Limits

Receiving finalization/source latching, frozen snapshots and current receiving
basis are connected locally; broader cross-event completeness, persisted genealogy,
balances, P0 case/SSCC consumers and export remain unfinished. Additional
product/source registry filters are not exposed in this UI increment. No
operational dashboard, package readiness or physical traceability is claimed.

No hosted environment, real data, mail, object storage, hardware, native mobile device or screen reader was tested. Fluent Spanish review remains required before operational use. The full primary API/infrastructure suite was not rerun for this frontend change; its previously documented environment failures remain unresolved. No `.pen` edits, main-checkout edits, commit, push, merge or deployment are included.
