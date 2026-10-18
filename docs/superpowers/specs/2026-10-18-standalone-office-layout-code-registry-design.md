# Standalone office layout and imported-code search

## Accepted direction

The owner asked to correct alignment, missing spacing and inconsistent density throughout
the standalone office, using the update screen and imported-shift list as examples. Preserve
the incumbent identity. The owner explicitly selected one shared code-results table with
an All / Local / From cloud source filter. This continues the accepted final-state cloud
migration: imported facts must be searchable without fabricating a local scan journal.

## Office layout

- Reuse existing tokens, office-stack, ListCard, filter/date controls and pagination.
- Keep 8px within related groups, 16px between groups, existing card insets and table density.
- Give AboutPage section wrappers and nested update steps explicit layout. Group package
  status/facts, notes, actions and manual diagnostics. Secondary buttons must not stretch.
- Replace source text links with styled semantic route links and an obvious active state.
- Bring imported-shift lists into the native list pattern. Audit representative catalog,
  import, backup, license and code pages for the same wrapper/action problems.
- Preserve dark/light themes, copy, keyboard navigation and long path/hash visibility.
- Verify 1280x720 dark, 1024x768/reduced effective viewport, 1920x1080 light. Batch initial
  captures, fix as a batch, then at most one visual confirmation pass.

## Search behavior and compatibility

The office uses new read-only routes GET /v1/office/code-registry and
GET /v1/office/code-registry/{codeHash}. The existing /v1/office/codes routes and DTOs
retain their local-only behavior for older clients. Additive routes keep protocol 6/minimum 1.
All office roles may read; device-only, handheld and revoked sessions may not.

The new search accepts the existing codeHash, GTIN, SSCC, shift and instant-period criteria,
plus source=all|local|cloud (default all). It returns one stable chronological list, 50 rows
per host page, globally capped at 10,000 matches. Count and page share a read transaction.
The UI retains its existing page-size adapter, URL/hash privacy and explicit-period behavior.
Typing a criterion over the default seven-day period continues to search all time.

Rows are discriminated as {source:'local',item:OfficeCodeItem} or
{source:'cloud',item:CloudCodeItem}. Cloud rows never receive fake scan/device/operator IDs.
CloudCodeItem has an opaque stable id, codeHash, nullable canonical/gtin14/serial, scannedAt,
sourceTimeZone, state=owned|released|historical, nullable releasedAt, original shiftId/number,
shiftAvailable, nullable productionDate/productName/lineName and nullable box/pallet IDs,
SSCCs/close/disassembly times with explicit availability flags. Missing source metadata stays
null. Links are emitted only for imported objects actually present in the accepted snapshot.

Read completed batches only. Include cloud_history_codes occurrences, including flat-only
historical repeats. Include owner-only provenance for hashes absent from code rows: it remains
findable by exact hash, known shift number or original timestamp even outside the report window.
Do not duplicate an owner as an extra occurrence when that hash already has code rows.
Unknown identity on owner-only records cannot match a GTIN criterion.
Flat-only records may omit their separate GTIN field while retaining it in a
validated canonical code. Use that canonical GTIN as the indexed search key,
preserving the original nullable response metadata and stored snapshot.

Use indexed driver queries for hash, GTIN, SSCC, shift and time; add a new SQLite index migration
where needed. Select/count compact match keys and hydrate only the final 50 rows in bounded
batch queries. Do not load/sort full histories in JavaScript or Rust. A source with no matching
SSCC/shift must not suppress matches from the other source. Stable ties include source and key.

## Code card and truth of ownership

CodeRegistryCard contains codeHash, nullable local OfficeCodeCard, cloud CloudCodeItem[],
cloudCapped and nullable currentOwner CodeRegistryItem. Current ownership is read across both
sources independently of the display filter. After imported-box disaggregation, the old cloud
occurrence is released; a later native scan is the current owner. Flat historical repeats are
never shown as current owners. Do not claim a code is free merely because local ownerScanId
is null while cloud ownership exists. Limit cloud occurrences to 1,000 and signal truncation.

Present known identity and global ownership once, with separate local-journal and imported-
snapshot sections. Imported metadata is an original final-state snapshot, not a fabricated
event timeline. Preserve source timezone; if unsupported, show the original ISO instant and
zone explicitly instead of silently using the current profile zone. Date criteria remain
absolute intervals computed from the office organization's existing period controls.

Existing imported data becomes searchable after the software update and index migration;
no new export or reimport is required. No import, ownership, duplicate checking or report
generation writes change. No cloud/API/PostgreSQL changes or new dependencies are needed.

## Verification

Pin pending-batch exclusion, legacy API compatibility, source filters, owner-only provenance,
flat repeats, released/repacked ownership, missing frozen fields, unavailable links, mixed
pagination/cap/ties, all criteria combinations and indexed query plans. Mirror Rust/TypeScript
DTOs through fixtures and test URL privacy and source changes. Exercise the real office in
the controlled browser harness, including populated/empty/error results and update extremes.
Physical Windows/WebView2, scanners and printers remain separate acceptance.

## Release requested by the owner

Release as 1.0.0 on the stable channel. Integration into standalone/pilot-mvp may
use a direct fast-forward without a PR. Dispatch the existing CI explicitly after
pushing a non-main branch, verify the exact source SHA and Windows artifact, and
sign the update locally with the established tooling. Cloud production and the
handheld APK have no changes in this task.
