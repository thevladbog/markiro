# Kiosk SSCC orders SDD ledger

Identity: plan `docs/superpowers/plans/2026-08-13-kiosk-sscc-orders.md`, spec `docs/superpowers/specs/2026-08-13-kiosk-self-service-redesign-design.md`, base `ac7c4590dfd373c560d5cb3a1ffb13fd32d747d5`.

## Preflight

| Task | Status | Dependencies and overlap | Preflight ruling |
| --- | --- | --- | --- |
| 1. Domain SSCC normalization | completed | Feeds kiosk classification in Task 6 | Parse one bounded wrapper stack; classifier trims once and delegates; GS/oversize/check-digit failures remain unknown. |
| 2. DB registry versioning and provenance | completed | Shares `boxes.updatedAt` with Task 3; schema consumed by Tasks 4-5 | Migration follows existing journal as `0037`; assert named composite tenant FKs and cross-tenant denial, not total FK counts. Preserve order snapshots independently of later production-box exceptions. |
| 3. Stamp every box mutation | completed | Must finish before Task 4 delta semantics | Cover every production mutation found in station scans and box exceptions, including insert/displace/remove/close/disassemble. Advance in the same transaction as the eligibility change. |
| 4. Compact device registry | in progress | Reads Task 2 cursor and Task 3 timestamps; shares eligibility rules with Task 5 | One tenant-wide eligibility predicate for closed, active, unchanged, non-empty, one-product boxes. Cursor binds `(since, until, updatedAt, id)` so bounds cannot change between pages. |
| 5. Atomic box order admission | completed | Uses Tasks 2 and 4; DTO/error contract consumed by Task 6 | Resolve boxes, expand member KMs, apply bottle limits, persist provenance and consume admission inside the existing employee/day advisory-locked transaction. Do not accept client product, quantity, price or KM membership. Preserve legacy item-only proof hashing. |
| 6. Offline kiosk registry and queue | completed | Uses Tasks 1, 4, 5 | Activate staged registry only after a complete download; keep old snapshot on failure. Queue canonical SSCC only; validate and minimize durable conflict details; preserve legacy queued `badgeCode`. |
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
14. Box-bearing pickup orders take locks in the global order `tenant box-registry advisory root -> employee/day pickup advisory lock -> kiosk row -> policy/product/box facts -> counters/inserts`; station and product writers never request the pickup lock, so no reverse edge exists. Loose-only legacy orders skip the tenant-wide registry root. Cost if wrong: same-tenant station ingestion waits behind a box order; benefit is stable eligibility/member/product facts through persistence without deadlock inversion.
15. Admission proof keeps the exact legacy JSON shape and item order when `boxes` is absent. When the field is explicitly present, vNext sorts copied items and boxes and includes `boxes`, without mutating caller arrays. Cost if wrong: two canonical branches for the offline compatibility horizon; benefit is replay of every already-issued proof plus stable new proofs.
16. Request processing is bounded at 500 loose scans, 100 box lines, 1,024 UTF-8 bytes per scan, 500 members per box, and 1,000 resolved members across the submitted boxes. Exceeding aggregate work fails the whole request with `413 box_request_too_large`; it never silently truncates or partially processes. Cost if wrong: very large legitimate carts must be split; benefit is bounded allocation/query work on an untrusted kiosk route.
17. Deterministic limit order is all loose lines followed by box lines. Legacy boxes-absent requests preserve loose input order; explicit-vNext requests process locale-independent canonical copies in the exact order hashed by their admission proof. A box consumes its full DB-derived bottle count or receives one `over_limit` conflict. Response `acceptedBoxes` is canonical-SSCC sorted so idempotent replay reconstructed from snapshots is byte-stable without a new line-index column. Cost if wrong: vNext scan order is intentionally erased; benefit is that an attested payload reorder cannot change a near-limit winner while every legacy proof stays byte-compatible.
18. Box rejection/audit provenance uses a discriminated JSONB entry `{source:"box",sscc,bottleCount,reason}` in existing `sync_conflicts`/rejection JSON, never a fake `rawKm` and never box member KMs. Accepted boxes replay from `pickup_order_boxes`; box-only all-rejected requests persist the outcome and replay the same terminal response. Cost if wrong: old admin clients need an additive union update; benefit is exact idempotency and safe audit without a migration or crypto leakage.
19. Every explicit-vNext terminal rejection persists an internal `{source:"request",version:2,terminalReason}` marker in rejection JSON. The API filters it from admin-visible scan codes and accepts only an allowlisted terminal reason when replaying. After the global order locks, idempotency checks order first and rejection second before mutable resolution; early vNext paths serialize only on the kiosk row. Cost if wrong: one internal JSON entry per vNext terminal rejection; benefit is exact replay for `boxes: []`, early failures, and concurrent all-rejected waiters without exposing fake product lines.
20. Kiosk registry activation uses a separate staging store and one active/staging/meta readwrite transaction on the final page. Registry 409 restarts are capped at three with bounded backoff; cursor work is capped and malformed/cyclic pages are discarded. Cost if wrong: the kiosk may keep an older safe cut during sustained mutations; benefit is no partial or mixed registry becoming visible and no infinite foreground refresh.
21. Queue day-count estimates are stored outside the wire body and accepted only as integers from 0 through the protocol maximum 1,500; missing or corrupt estimates fall back to loose item count. Terminal response details are memory-only and quarantine copies only validated box SSCC/count/reason tuples. Cost if wrong: old records undercount boxes until resubmitted; benefit is backward compatibility without corrupt local over-counting or response/member leakage.

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
- Integrated re-review found one Important gap: a freshly inserted already-displaced losing membership was invisible to the subsequent active-only changed-row update. Fix round 1 now returns fresh insert box IDs into revision dedupe; RED 1 failed/9 passed, GREEN focused 50/50 plus typecheck/lint/build/format/diff. Targeted DB e2e remains NOT GREEN on unapplied 0037 (1 failed/72 skipped). Commit: `fix(api): version fresh losing box memberships`.

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

### Task 5

- Base: `a3c5a3d2`.
- RED: focused admission/resolver run produced 3 expected assertion failures plus the missing resolver module; 2 legacy tests still passed. Failures pinned absent boxes/sorting, empty payload acceptance, and missing atomic resolver.
- GREEN: focused API proof/resolver/lock/registry/OpenAPI tests 45/45; kiosk cart 25/25 proves production UI cannot submit an empty cart. API and admin typecheck, scoped ESLint, DB/API TypeScript builds, admin build, Prettier, and diff-check passed.
- Full API direct run: 61 files / 586 tests passed, 58 files / 744 tests skipped. Nine suites failed only because required environment was absent or loopback listen was sandbox-denied; one unrelated provision CLI test timed out. No product assertion failure was observed in the runnable set.
- PostgreSQL box-order e2e is explicitly NOT GREEN: without `DATABASE_URL` it skips; the known shared DB also lacks migration 0037. No shared schema/data was changed. The compiled e2e covers 12-member expansion, mixed/multiple boxes, server price, provenance, exact replay, and used-member 422/no empty order once run on 0037.
- Legacy empty request fixtures in kiosk-orders, pickup-rejections, and subscription-expiry tests now use bounded `not-a-km` content so they reach the intended badge/admission/idempotency behavior under the required non-empty contract. Production kiosk `canSubmit` already rejects an empty cart.
- Initial commit: `3f3608ec` (`feat(api): accept atomic SSCC pickup lines`). Review requested three Important fixes: complete vNext rejection replay/concurrent winner recheck, first-wins overlap, and proof/processing order equivalence.
- Fix round 1: internal vNext request markers and serialized order-then-rejection winner lookup; first-wins accepted-box key claiming; one locale-independent canonical proof/processing helper. RED 4 failed/7 passed plus helper RED 1 failed/7 passed. GREEN focused non-DB 50/50; DB/API TypeScript, scoped ESLint, API build, Prettier, and diff-check passed. Shared-DB e2e remained external/not run; the request to execute its mutating fixture was denied, and no shared data/schema changed.

### Task 6

- Base: `fc91a5ece847dd5abfba3a5125cae3108a791823`.
- RED: 5 failed files, 7 expected assertions plus one missing registry module, 162 existing passes.
- GREEN: focused registry/store/client/sync/day-count/scrub 191/191; full kiosk 478/478; typecheck, full ESLint, production build, Prettier, and diff-check passed.
- IndexedDB v3 preserves legacy snapshot/queue data and adds transactional active/staging/meta registry stores. Bounded 409 restart, cursor/resource guards, 401 revocation propagation, safe bottle estimates, terminal 413, sanitized box quarantine details, and badge scrub compatibility are pinned.
