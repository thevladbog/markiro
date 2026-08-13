# Kiosk SSCC orders SDD ledger

Identity: plan `docs/superpowers/plans/2026-08-13-kiosk-sscc-orders.md`, spec `docs/superpowers/specs/2026-08-13-kiosk-self-service-redesign-design.md`, base `ac7c4590dfd373c560d5cb3a1ffb13fd32d747d5`.

## Preflight

| Task | Status | Dependencies and overlap | Preflight ruling |
| --- | --- | --- | --- |
| 1. Domain SSCC normalization | completed | Feeds kiosk classification in Task 6 | Parse one bounded wrapper stack; classifier trims once and delegates; GS/oversize/check-digit failures remain unknown. |
| 2. DB registry versioning and provenance | completed | Shares `boxes.updatedAt` with Task 3; schema consumed by Tasks 4-5 | Migration follows existing journal as `0037`; assert named composite tenant FKs and cross-tenant denial, not total FK counts. Preserve order snapshots independently of later production-box exceptions. |
| 3. Stamp every box mutation | completed | Must finish before Task 4 delta semantics | Cover every production mutation found in station scans and box exceptions, including insert/displace/remove/close/disassemble. Advance in the same transaction as the eligibility change. |
| 4. Compact device registry | in progress | Reads Task 2 cursor and Task 3 timestamps; shares eligibility rules with Task 5 | One tenant-wide eligibility predicate for closed, active, unchanged, non-empty, one-product boxes. Cursor binds `(since, until, updatedAt, id)` so bounds cannot change between pages. |
| 5. Atomic box order admission | pending | Uses Tasks 2 and 4; DTO/error contract consumed by Task 6 | Resolve boxes, expand member KMs, apply bottle limits, persist provenance and consume admission inside the existing employee/day advisory-locked transaction. Do not accept client product, quantity, price or KM membership. Preserve legacy item-only proof hashing. |
| 6. Offline kiosk registry and queue | pending | Uses Tasks 1, 4, 5 | Activate staged registry only after a complete download; keep old snapshot on failure. Queue canonical SSCC only; validate and minimize durable conflict details; preserve legacy queued `badgeCode`. |
| 7. Slice gates and review | pending | All tasks | Verify migration path, cross-tenant denial, old-client compatibility, offline refresh failure, all-or-none conflicts and package gates before whole-plan review. |

## Cross-task interfaces

| Producer | Consumer | Shared contract | Verification |
| --- | --- | --- | --- |
| Task 1 | Task 6 | Canonical 18-digit SSCC from approved scanner wrappers | Domain table tests plus kiosk scan/cart tests |
| Task 2 | Task 3 | `boxes.updatedAt` is the registry change clock | Schema/migration tests plus mutation advancement e2e |
| Task 3 | Task 4 | Every eligibility-changing mutation advances `(updatedAt, id)` | Delta add/remove/update tests around all mutation classes |
| Task 4 | Task 5 | Registry and order admission use the same tenant-scoped eligibility definition | Shared resolver/query helper tests and stale-registry rejection |
| Task 2 | Task 5 | Order-box snapshot and expanded item provenance | Composite FK/cross-tenant tests and order insertion e2e |
| Task 5 | Task 6 | Canonical `boxes: string[]`, all-or-none conflict details, admission proof | API contract tests and durable kiosk queue tests |

## Decisions

1. SSCC box admission remains inside the existing employee/day advisory-lock transaction introduced by the policy plan. Cost if wrong: longer lock hold time for box orders; benefit is no cross-kiosk limit race and one atomic decision.
2. Old item-only admission proofs retain their historical canonical body. `boxes` participates only when the new field is present, so previously attested offline requests remain replayable. Cost if wrong: two canonicalization branches during the compatibility horizon.
3. The registry delta cursor binds the fixed lower and upper snapshot bounds, not only the last row. Cost if wrong: larger opaque cursor; benefit is no page-splicing or moving-window gaps.
4. `pickup_order_items` binds `(tenant_id, order_id, order_box_id)` to the box line, not only `(tenant_id, order_box_id)`, so provenance cannot cross orders inside one tenant. Cost if wrong: one additional column in the supporting unique/FK definition; benefit is a database-enforced same-order invariant.
5. Existing boxes receive one migration-time `updated_at` via PostgreSQL's fast non-volatile default rather than a historical `COALESCE` full-table rewrite. Cost if wrong: the initial cursor cannot reconstruct pre-migration chronology; benefit is a bounded metadata-only deployment and a full initial registry remains correct because every historical box is visible at the migration version.
6. Mutation stamps use `GREATEST(clock_timestamp(), updated_at + interval '1 millisecond')`, not transaction `now()`, so several eligibility changes in one transaction or millisecond remain strictly observable through a JavaScript millisecond cursor. Cost if wrong: timestamps may lead wall clock by a few milliseconds under a burst; benefit is monotonic, testable delta ordering.
7. `unchanged after close` is proven from server-time evidence: active owners' `code_registry.updated_at` must be no later than `closure_received_at`, and no membership may have `removed_at` or `displaced_at` after closure. Cost if wrong: a delayed pre-close device scan delivered after closure is removed from the registry, intentionally favoring physical-box integrity over device event time.
8. Registry cursors are versioned base64url objects binding mode/lower tenant revision/upper tenant revision plus last `(boxRegistryVersion,id)`; follow-up query parameters must match the bound snapshot. Cost if wrong: a new tenant revision row and stricter client contract; benefit is an actual commit-atomic cut with no MVCC time-watermark gaps or page splicing.
9. One registry page may resolve at most 1,000 member keys across a deterministic candidate prefix; oversized/ineligible candidates cost zero member payload and at least one candidate always advances. Cost if wrong: more HTTP pages for tenants with many large boxes; benefit is a worst-case raw-key allocation near 1 MB rather than hundreds of MB.
10. In-place box rows are not historical snapshots. A page sequence remains valid only while the committed tenant counter equals cursor `until`; preflight and post-read mismatches return `409 registry_snapshot_changed`, requiring the kiosk to discard staging and restart. Cost if wrong: more restarts during active production; benefit is no silently omitted or mixed-revision box without an append-only event store.
11. A persisted product GTIN change invalidates every tenant-scoped closed SSCC box for shifts using that product in the same transaction and tenant revision. Price, name, linkage, and unchanged-GTIN writes do not. Cost if wrong: a set-based historical-box update on rare GTIN edits; benefit is no indefinitely stale kiosk eligibility.
12. Every registry-relevant transaction follows tenant advisory lock -> product/shift/device-box/code rows -> revision counter -> stamps. Actual GTIN changes always allocate a revision even with zero matching boxes; exact station replays and updates without a GTIN field do not take the registry lock. Cost if wrong: same-tenant production mutations serialize; benefit is deterministic ordering without closure/GTIN gaps or row-lock inversion.
13. Continuous mutation may starve a multi-page refresh through repeated `registry_snapshot_changed`. This is accepted fail-safe behavior: Task 6 keeps the prior active snapshot, discards staging, and retries with bounded backoff and visible refresh state.

## Task log

### Task 1

- Base: `ac7c4590dfd373c560d5cb3a1ffb13fd32d747d5`
- Implementer: `sscc_domain_impl`, commit `1e39b3fa566965f2622dfa0ecd54e856b4e67245`
- RED: 7 expected failures, 38 passes.
- GREEN: focused 45/45; full domain 207/207; typecheck/lint/build/diff-check passed.
- Task review: APPROVED by `sscc_domain_review`; no Critical, Important, or Minor findings; scoped 45/45 and diff-check passed.

### Task 2

- Base: `1e39b3fa566965f2622dfa0ecd54e856b4e67245`
- Implementer: `sscc_db_impl`, initial commit `5e5c4b1abe1f8199bcd569ab7453949a74cb09d5`
- RED: 4 expected failures, 20 passes, 14 DB skips.
- Initial GREEN: focused 24/24 non-DB with 14 DB skips; full DB 68 passes/51 DB skips; typecheck/lint/build/format/diff-check passed; repeat generate found no drift.
- Task review: CHANGES REQUESTED by `sscc_db_review`: Important full-table backfill under migration transaction lock; Important missing `(tenant_id, updated_at, id)` cursor index.
- Fix round 1: commit `bbc3e373f06a13679bc4aec34a35dfbe0ead0398`; RED 2 expected failures; final focused 25 passes/14 DB skips, full DB 69 passes/51 DB skips; typecheck/lint/build/format/diff-check and regeneration drift probe passed.
- Re-review: APPROVED; both prior Important findings ADDRESSED, no new Critical/Important. Residual maintenance-window note for ordinary index build recorded for production-like migration timing.

### Task 3

- Base: `bbc3e373f06a13679bc4aec34a35dfbe0ead0398`
- Implementer: `sscc_mutation_impl`, commit `b444df3a`.
- RED: real service closure path, 1 expected failure / 4 passes.
- GREEN: unit 5/5; DB e2e 72 explicitly skipped without a migrated schema; typecheck/lint/build/Prettier/diff-check passed.
- Full API evidence: 1173 passes, 83 failures, 19 skips; shared dev DB journal stops at 0036 and lacks both 0037 columns, so PostgreSQL e2e is NOT green and the schema-drift failures are recorded as infrastructure coverage gap.
- Task review: APPROVED by `sscc_mutation_review`; no Critical/Important/Minor findings; reviewer unit 5/5 and typecheck passed.

### Task 4

- Base: `b444df3a`
- Implementer: `sscc_registry_impl`, initial commit `3d6da35d`.
- RED: 1 failed suite / 0 tests collected on missing production registry module.
- Initial GREEN: unit/guard 24/24, route inventory 2/2, typecheck/lint/Prettier/build/diff-check passed; DB e2e NOT GREEN because shared DB lacks 0037.
- Task review: CHANGES REQUESTED by `sscc_registry_review`: Important timestamp watermark is not an MVCC snapshot cut; Important ~250 MB aggregate allocation ceiling; Important incomplete owner tuple; Minor missing explicit OpenAPI contract.
- Fix round 1: committed tenant `bigint` revision protocol, 1,000-key aggregate page budget, full `(shiftId, terminalId, scannedAt)` owner identity, and exact OpenAPI contract implemented. RED: API 10 failed/27 passed; DB 4 failed/19 passed/2 skipped. GREEN: registry/OpenAPI/mutation unit 37/37, route inventory 2/2, DB full 70 passed/51 skipped, typecheck/lint/build/format/diff and regeneration parity passed. Shared DB registry e2e remains explicitly NOT GREEN because 0037 is unapplied (1 failed suite/5 skipped). Commit: `fix(api): stabilize kiosk box registry snapshots`.
- Re-review after fix round 1: CHANGES REQUESTED; the in-place table did not preserve historic rows across requests, and product GTIN edits could change eligibility without a revision.
- Fix round 2: exact pre/post page revision fence with stable 409 restart code, transactional locked GTIN update, and set-based tenant/product box invalidation implemented. RED: 3 failed files, 2 failed/31 passed plus one missing-module suite. GREEN: focused 45/45 including real ProductsService transaction boundary, route inventory 2/2, typecheck/lint/build/format/diff passed. Shared DB e2e remains explicitly NOT GREEN because 0037 is unapplied (1 failed suite/6 skipped). Commit: `fix(api): fence registry pages and invalidate product GTIN changes`.
- Fix round 3: unconditional actual-GTIN revision, tenant advisory lock order, replay/name-only contention avoidance, and valid unqualified set-based UPDATE implemented. RED: 7 failed/6 passed. GREEN: focused 47/47 plus route/typecheck/lint/build/format/diff. Shared DB remains unapplied; commit: `fix(api): serialize box registry mutations`.
