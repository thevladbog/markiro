# Task 5 review

## Verdict

**CHANGES REQUESTED** — 0 Critical, 3 Important, 0 Minor.

Reviewed commit `3f3608ec` against Task 5 in
`docs/superpowers/plans/2026-08-13-kiosk-sscc-orders.md` and the accepted
design specification, including tenant scoping, whole-box persistence,
registry provenance, lock order, bounds, replay, OpenAPI, admin conflict
rendering, and legacy item-only compatibility.

## Important findings

### 1. Persisted vNext rejection is not a complete idempotency winner

`findKioskRejectionOutcome` only returns an outcome when the persisted
rejection contains a `{source: "box"}` entry
(`pickup-orders.service.ts:2354-2382`). Therefore an explicitly vNext request
with `boxes: []` and only loose conflicts, or an early terminal error recorded
only for loose lines, does not replay the persisted verdict. It is evaluated
again and may later create an order under the already-spent
`(tenantId, kioskId, deviceSeq)` after product, badge, policy, or limit state
changes.

There is a second race in the same invariant. Two concurrent all-rejected
requests can both miss the optimistic rejection lookup. The transaction
serializes them, but after taking the pickup/kiosk locks the second request
rechecks only `pickup_orders` (`pickup-orders.service.ts:1922-1944`), not
`pickup_scan_rejections`. The first commits a rejection; the second then
re-evaluates mutable registry/policy/order state and can return a different
verdict or create an order. `recordScanRejection(...).onConflictDoNothing()`
does not make the response or later write idempotent.

Required fix:

- For any explicit-vNext request, load any persisted rejection, not only one
  containing a box entry. Reconstruct `order_rejected` from loose and box
  conflicts, and preserve early terminal reasons without depending on a box.
- Recheck the rejection row inside the serialized transaction after the
  applicable locks and kiosk row lock, before policy/fact resolution or
  inserts.
- Add tests for `boxes: []` loose-only rejection replay, early terminal replay,
  and a concurrent rejection winner observed by the waiter.

### 2. Box-to-box overlap rejects the earlier valid box as well as the new box

`classifyResolvedBoxConflicts` first counts every member across every submitted
box, then rejects every box containing a key whose frequency is greater than
one (`box-order-resolver.ts:146-167`). Thus `[box A(a,b), box B(b,c)]` rejects
both A and B. The focused test explicitly pins that result
(`box-order-resolver.test.ts:45-56`).

The accepted specification says the *newly added* box is rejected when it
overlaps an already-added box (`spec` section 9.3, lines 332-339). The same
first-wins behavior is already used for loose lines and is necessary for a
partial result: A should remain accepted and B should receive one whole-box
`duplicate` conflict. A box rejected because it overlaps a loose item must also
not poison an otherwise valid later box merely because the two rejected/input
boxes overlap each other.

Required fix: classify in deterministic processing order against loose/prior
used keys plus member keys of boxes accepted so far. Add both the simple A/B
overlap test and the case where A is rejected by a loose KM but B can still be
accepted.

### 3. Admission proof canonicalization erases order that changes the result

For explicit vNext, `canonicalKioskOrderContent` sorts copied items and boxes
before hashing (`kiosk-admission-proof.ts:28-46`). Order creation, however,
preserves request order (`pickup-orders.service.ts:392-405`, `1889-1893`) and
applies the limit sequentially to loose lines then boxes
(`box-order-resolver.ts:170-190` and following). Two payloads with a different
item/box order therefore have the same admission digest but can accept different
products or boxes near the daily limit. During subscription recovery, a client
can obtain a proof for one order and submit the other order with the same
digest.

The implementation ledger explicitly chose deterministic vNext ordering, so
the proof order and admission order must be the same. Use one
locale-independent canonical comparator/order for both hashing and vNext
processing, while preserving the exact historical item order and digest when
`boxes` is absent. Add a near-limit proof test demonstrating that reordering a
vNext payload cannot change the accepted result under the same proof.

## Areas that passed review

- Box resolution and persistence are tenant-scoped; foreign SSCCs shape as
  `unknown_box` and no raw member list is returned.
- Registry root -> employee/day -> kiosk row lock order is coherent with the
  reviewed station/product writers; no reverse lock edge was found.
- Accepted boxes are persisted as one snapshot row plus expanded item rows
  linked by the same-order composite provenance FK. Missing returned box
  provenance aborts the transaction.
- The employee limit counts expanded bottle rows tenant-wide and an accepted
  box is never split.
- Request bounds are explicit: 500 loose lines, 100 boxes, 1,024 UTF-8 bytes
  per raw scan, 500 members per box, and 1,000 aggregate resolved members.
- Strict box DTOs reject client product/count/member material. The 413 and 422
  bodies and additive success fields are documented in OpenAPI.
- Stored/admin conflict unions distinguish SSCC lines without exposing box
  members, and admin rendering handles both union variants.
- The item-only proof branch preserves the pinned historical digest and does
  not inject `boxes`.

## Reviewer verification

- `git diff --check a3c5a3d2..3f3608ec` — passed.
- Focused API suites — 45/45 passed:
  `kiosk-admission-proof`, `box-order-resolver`, `pickup-order-locks`,
  `kiosk-box-registry`, and `kiosk-box-registry-openapi`.
- `pnpm --filter @markiro/api typecheck` — passed.
- PostgreSQL box-order e2e was not run green: the available shared database
  does not have migration `0037`. This review did not modify shared schema or
  data.

The focused green run does not clear the findings above: one test currently
asserts the incorrect reject-both overlap behavior, and there are no tests for
loose-only vNext rejection replay, the rejection race, or proof/limit order
equivalence.
