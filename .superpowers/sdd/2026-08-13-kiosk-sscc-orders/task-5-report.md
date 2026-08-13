# Task 5 implementation report

## Outcome

`POST /kiosk/orders` and admission attestations now accept optional strict canonical SSCC box lines beside loose KMs. Box facts, membership, product, quantity, and current price are resolved server-side inside the serialized order transaction; accepted boxes persist one snapshot line and exact expanded pickup items with `orderBoxId`.

## Compatibility and contracts

- Legacy item-only admission content preserves the exact historical JSON shape, item order, and pinned SHA-256 fixture.
- vNext proof content is selected only by explicit `boxes` presence and sorts copied items/boxes without mutation.
- Badge identity remains exactly one of digest/code; `items + boxes` must be non-empty.
- Responses add `acceptedBoxes` and `boxConflicts`; legacy `conflicts` is unchanged.
- Additive box conflicts are persisted as a discriminated JSONB union and rendered safely in admin with SSCC/count, never raw member KMs.
- Idempotent accepted replay reconstructs sorted accepted boxes from `pickup_order_boxes`; box-only terminal rejection replays its persisted result.

## Atomicity and ordering

- Only box requests take `box-registry tenant root -> employee/day -> kiosk row`; loose-only requests preserve the old lock path.
- Shared Task 4 facts/evaluator are reused after tenant-scoped candidate row locking.
- Limit ordering is loose request order, then box request order. Boxes are indivisible.
- Loose/box, box/box, prior-order, and unique-index races classify an entire affected box as `duplicate`; retries are finite.
- No accepted box item can be inserted without returned same-order box provenance.

## Resource bounds

- Loose items: 500; box lines: 100; raw scan: 1,024 UTF-8 bytes.
- One box: 500 members; aggregate submitted box work: 1,000 members.
- Aggregate overflow is exact `413 {code:"box_request_too_large"}` and never partial.

## Verification

- RED: 3 expected admission/schema failures plus missing resolver suite.
- Focused GREEN: API 45/45; kiosk cart 25/25.
- API/admin typecheck: passed.
- Scoped API/admin ESLint: passed.
- DB TypeScript build, API TypeScript build, admin production build: passed.
- Prettier and `git diff --check`: passed.
- Full API runnable evidence: 61 files/586 tests passed; 58 files/744 tests skipped. Environment/listen failures and one unrelated timeout remain separately reported.
- Box-order PostgreSQL e2e: not run/green because no migrated 0037 test database was available; shared DB was not modified. The compiled scenarios include accepted expansion/replay, prior-used all-rejected/no-order, and foreign-tenant-as-unknown. Whole-box over-limit is pinned at the deterministic unit boundary; its DB-backed execution remains part of the isolated-0037 gate.

## Known external gate

Run the compiled box-order e2e against an isolated PostgreSQL database with migration 0037 applied. It exercises 12-bottle expansion, current price, exact provenance/replay, and all-rejected used-member behavior.
