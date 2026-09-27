# US-04 — Transformation on the shared event shell

**Status:** Architecture and written specification approved by the owner on 2026-09-26. No implementation or deployment is claimed.

**Scope:** US-04 (TRN-001..014, LOT-010), following the actual US-03 Receiving implementation and the current [MVP contract](../../us/mvp-contract.md). This document supersedes the 2026-09-03 US-04 draft where they differ. The U.S. edition stays isolated from the RU release and deployment workflows.

## Outcome and boundaries

The office workflow creates a standalone Transformation CTE: source-resolved input lots (received lots in the demonstration), one or more output lots with processor-assigned TLCs, exact quantities and units, completion date and IANA timezone, processor location, reason, documents, and directed input-to-output genealogy. A finalized event has an immutable, self-contained snapshot. It can be amended or voided under the current-revision and downstream-dependency rules in the MVP contract. A Transformation with no FTL input is valid when the output is FTL; no fictitious input TLC is invented.

The P0 demonstration also links 100 synthetic, server-side case/SSCC records to the output lot. Case links are optional operational detail: core CTE finalization works with zero cases, without GTIN, KM, shift, Station, scanner, printing, or physical closure. The bridge does not change RU `boxes`, `box_items`, or Station behavior. Only `en-US` and `es-US` copy is added to U.S. screens.

No production infrastructure, public deployment, merge to main, or release is part of this slice.

## Architecture decision

Keep `traceability_events` as the common event/revision shell. Do not add a parallel `transformation_events` header that duplicates event number, status, lifecycle, business date, timezone, and audit identity. Store Transformation-only reason and operational fields in a typed detail table; store input/output lines in typed child tables. Receiving keeps its existing `receiving_event_roots`, items, documents, snapshots, routes, and public `dateReceived` field.

The alternatives were (a) a second complete event header, which would fork lifecycle and trace semantics, and (b) moving all Receiving root pointers into a new generic root table, which would rewrite a working revision chain. A type-safe self-reference from each event revision to the original event in its own tenant and type, with Receiving and Transformation root-pointer tables remaining type-specific, has the smallest data migration. It still requires a new migration and explicit type-scoping of existing guards; merely allowing a new `type` value would break Receiving.

## Storage and migration

1. Use a new additive migration after the committed US-03 migration sequence; never edit applied migrations. Keep all existing Receiving IDs, root IDs, revision numbers, snapshots, and lot bindings byte-for-byte. Migrate constraints transactionally, with an upgrade test containing both draft and finalized Receiving histories.
2. Replace the event-to-`receiving_event_roots` FK with a deferrable composite self-FK on `(tenant_id, root_event_id, type)` to an original event's unique `(tenant_id, id, type)`. The original revision has `root_event_id = id` and `revision = 1`. This prevents cross-tenant and cross-type roots. Retain a separate, enforced Receiving-root relation for Receiving rows; use a type-conditional generated root key plus FK or an equally strong deferred constraint. A Transformation root has its own typed pointer row. Missing or mismatched typed roots fail at commit, not at a later read.
3. Scope the existing Receiving identity, chain, snapshot/finalization and child guards to Receiving only, without relaxing their behavior on Receiving rows. Add equivalent Transformation identity/lifecycle and typed-child guards. Preserve the one-current/one-pending revision invariants per tenant/root. Prevent a Receiving child row from referencing a Transformation header and vice versa.
4. Remove the global `type <> 'receiving'` integrity tripwires from Receiving basis, readiness, amendment save, and lifecycle commands. Replace them with scoped Receiving-root/child integrity checks and explicit downstream dependency checks. A valid Transformation row must not make an unrelated Receiving command unavailable. A malformed event within a Receiving chain must still fail closed; foreign-tenant and wrong-type IDs remain 404/denied as appropriate.
5. Make `traceability_events.event_date` the sole stored CTE business date. Rename the current physical `date_received` column, not copy it into an independently writable second date. Map the Receiving API's `dateReceived` field to `event_date`; preserve frozen Receiving snapshot keys and bytes. Replace the active Receiving SQL guard definitions that reference `NEW.date_received` with `NEW.event_date` while retaining their version-pinned validation. An upgrade test compares existing event rows and snapshots before/after, other than the column name, and exercises v1/v2/v3 finalization after migration. `finalized_at` remains an instant, never the source of the business date.
6. Transformation detail stores reason (`commingling_and_repacking`, `repacking`, `relabeling`, `processing`, `other`), optional reason note, and optional operational references. Input lines distinguish FTL lot references from documented non-FTL input, with exact decimal quantity string and UOM. Output lines carry stable lot IDs across revisions, product, quantity/UOM, and TLC/source binding. Reference documents use tenant-scoped, typed event links. Tenant-composite keys, indexes and CHECKs cover every new relation.
7. `lot_genealogy_edges` is introduced as revision-attributed, directed input-lot → output-lot evidence. Historical edges remain for pinned revisions; active traversal selects only the current finalized revision of each root. No physical deletion is used to represent amendment or void. The P0 case bridge uses a separate tenant-scoped link table with one active lot per case, audited link/unlink and uniqueness of active SSCC association. The demonstration's cases are synthetic `boxes`/SSCC rows with any isolated supporting rows required by the existing schema; they are clearly marked as synthetic and do not claim scans, physical closure or print verification. The existing RU box schema and operational flows are not changed.

The migration and code are delivered as separately testable changes. The shared-shell compatibility migration and Receiving guard fixes land before any Transformation write route is enabled. `event_date`, typed Transformation storage and finalization follow before the case bridge or UI. Each intermediate state must keep Receiving functional.

## Commands and finalization

Creation, draft save, readiness, finalize, amend and void are tenant-scoped U.S. API commands, with current membership/capability/profile checks at the server boundary. Every mutating command has a stable operation key and payload digest; a key replay with different input conflicts. Save/finalize compare the expected draft and lifecycle versions. Finalization reloads all relevant lots, products, coverage, location and documents in one transaction, locks root and lots in deterministic order, validates exact decimal/UOM data, freezes descriptions/source/reference values, allocates output lot identities and genealogy effects, and writes an exact actor/tenant/action/target/result audit record atomically. Audit failure rolls the transaction back.

The processor's actual location is the source of newly assigned output TLCs. A source reference alone cannot replace it. Non-FTL inputs have quantity and identification but no fabricated TLC. Unknown coverage, unresolved source, missing required KDEs, or unsafe lot identity block finalization. A 2→1, 2→2, and zero-FTL-input→1 event are required rule fixtures.

An amendment draft does not remove the current finalized event. Its finalization reuses output lot IDs, evaluates balance with the predecessor's effects removed, atomically switches active genealogy/balance effects, marks the predecessor amended, and preserves historical snapshots/edges. Existing quarantine/recall controls are not cleared by derived status changes. Identity, topology or quantity changes and void are refused when finalized downstream events depend on the affected lot; the response identifies blockers and correction order. Creating another current or pending revision concurrently is refused. A void never erases prior evidence or leaves an apparently complete descendant.

## Server case bridge and U.S. interface

The case link operates on tenant-owned output lots and synthetic server-side cases with valid SSCCs. It validates one active lot per case, serializes concurrent link/unlink, preserves an audited link history and supports SSCC-to-lot lookup. Case count is a count of active links, not an inferred quantity KDE. Link changes after finalization do not mutate the immutable CTE snapshot. No shift selection, auto-link-on-closure, or Station write path is introduced in P0.

The office UI groups Transformation list/draft/readiness/finalized/history and the output-lot Cases panel into one U.S. workflow. It displays exact quantity with units, date with event timezone, input→output lineage, blocking issues and case-link provenance. English and Spanish copy are complete for these screens; Spanish UI copy is not a substitute for a fluent review before real operations. The RU edition sees none of these routes or locale changes.

## Delivery and acceptance gates

1. **Shared-shell compatibility:** migration fresh/upgrade tests; original Receiving rows/snapshots unchanged; Receiving create/save/finalize/amend/void/basis continue to work with a valid Transformation draft in the same tenant; malformed Receiving chains remain unavailable; wrong-type and cross-tenant IDs fail closed. No Transformation HTTP write yet.
2. **Transformation rules/storage:** domain and contract fixtures, tenant-composite FK tests, version/concurrency/operation-key tests, DB and API package gates. Core finalize succeeds without any cases or shift and freezes a 2→1 event exactly.
3. **Revision and genealogy:** 2→2 and zero-FTL-input fixtures; downstream amendment/void blockers; stable output IDs; pinned history; current traversal, cycle safety and mixed-unit balance behavior; exact audit assertions.
4. **P0 bridge and interface:** 100 synthetic case links, duplicate/cross-tenant denial, SSCC lookup, audited unlink, EN/ES UI and browser walkthrough. The 100-case event quantity and 100 active links are separately asserted. Existing RU regression tests remain green.

Run focused failing tests before each implementation increment, then the relevant package tests, typecheck, lint and build, `git diff --check`, and broad gates appropriate to the final diff. Report skipped DB/browser/external gates explicitly. Neither automated tests nor synthetic cases prove physical line operation, live deployment or regulatory acceptance.

## Explicit non-goals

Station case-only mode, scanner ingestion, label printing, physical SSCC closure, shift-driven auto-linking, direct FDA submission, EPCIS, item serialization, XLSX/request packages, and production rollout are outside US-04 P0. The older draft's shift requirements and RU box integration are historical ideas, not current acceptance criteria.
