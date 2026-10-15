# US narrow candidate lookups

Status: accepted for SQL-only implementation after independent design review.
The user's existing scoped implementation and US-branch push authorization applies;
release, deployment and changes to main/RU remain excluded.

## Intent and evidence

Remove demonstrated quadratic candidate selection on a populated US tenant without
changing authority, freshness, integrity, results, limits or acceptance budgets.
The completed index-only diagnostic preserved 543 owner dispatches and table hashes,
but failed the fixed 25% whole-owner improvement gate in both orders: 37.7% forward,
12.45% reverse. Its three complete plans contained no JIT. Index-only is not accepted.

Evidence: `.superpowers/sdd/2026-10-15-us-11-canonical-equality/receiving-index-owner-measurements.json`.
The actual Trace candidate plan iterated 263 root rows 263 times, rejected 68,906
root/event join pairs, and replayed 520 Receiving children 263 times. Its execution
was 27.154 ms; readiness event selection was 9.409 ms with the same repeated child
lookup shape. These are selector-shape fixtures, not 260 complete business chains.
The previous selectedLots/root-CTE hint experiment is closed: insufficient savings,
and root-hint row work worsened. Do not implement those hints.

## Chosen change and boundaries

Change only `traceCandidateQuery` in `apps/api/src/modules/traceability/trace/us-trace-query.ts`
and the lot-scoped branch of `readinessEventSelectionQuery` in
`apps/api/src/modules/traceability/trace/us-readiness-evidence.ts`. SQL-only:
no index, schema or migration changes. Preserve public signatures and callers. No new native procedure,
callback, factory, cache, caller proof, prevalidated context or validation skip.

Each candidate query remains ONE statement in its existing transaction and position.
Do not alter `assertTraceRelations`, `assertReceivingRootsReadable`, current-origin,
history/excluded checks, readiness invalid/selectedLots/integrity/origin/draft queries,
JS decoding, snapshot validation, authentication or transaction isolation/locking.
Do not remove duplicate-looking checks. Keep READ COMMITTED and RR boundaries intact.

## Trace candidate equivalence

1. Retain all four existing tenant-and-lot child branches, including historical and
   excluded revisions. Materialize a scoped candidate CTE of DISTINCT `event_id`
   from eligible children; direction
   is the existing optional `c.direction=direction` condition (none for `both`).
2. For each distinct ID, use a fenced global-PK event lookup:
   `JOIN LATERAL (SELECT ... FROM traceability_events WHERE id=c.event_id LIMIT 1) e ON true`.
   Retain explicit `e.tenant_id=tenantId`, `status='finalized'`, and
   `superseded_by_event_id IS NULL` predicates outside the lookup.
3. Use a fenced type-specific root lookup: three UNION ALL branches, each keyed by
   `id=e.root_event_id` and its exact `e.type`, then `LIMIT 1`. Retain explicit root
   tenant, ID, type and `current_event_id=e.id` checks. UUID PKs and exclusive type
   branches make the limit lossless, even if UUIDs coincide across root tables.
4. Return only `e.id`, ordered by `e.event_date,e.id`, with the unchanged `limit+1`.
   Do not limit/deduplicate after pagination, or introduce an early child limit.

The original candidate EXISTS matches child EVENT ID, not child type. Do not add a
new `child.type=e.type` candidate predicate: the separate preceding integrity guard
already rejects mismatches, and direct selector equivalence must also be retained.
DISTINCT replaces EXISTS multiplicity, not any integrity check. Null/dangling/cross-
tenant child IDs must have the same selector exclusion while public reads still fail
closed at their original guard. No event snapshot is parsed inside these lookups.

## Lot-scoped readiness equivalence

Branch only when `scope.lotId !== null`; leave the no-lot SQL path unchanged, including
product-only scope and the 2001/10001 broad-scope behavior.

Add `scoped_event_ids AS MATERIALIZED (SELECT DISTINCT event_id FROM lines WHERE
tenant_id=tenantId AND lot_id=scope.lotId)` using the EXISTING full `lines` relation.
Drive a fenced event PK lookup from these IDs. Preserve the ENTIRE existing WHERE,
including tenant/status/supersession predicates, the original three type-specific
current-root tuple membership tests, inclusive civil-date range, product predicate,
`ORDER BY e.event_date,e.id`, and 10,001 sentinel. No early candidate truncation.

Keep the existing `eventFilter(scope)` as a final predicate in the new branch:
its repeated lot EXISTS is cheap only after the outer event set is bounded, and
retaining it avoids changing subtle product semantics. In particular, lot+product
scope may match the lot on one line and product on ANOTHER line of the same event,
or through the existing frozen-snapshot fallback. Do not globally narrow its `lines`
relation to the selected lot, remove malformed-snapshot behavior, or replace product
matching with the selected lot's product. Keep the type-specific root membership
truth conditions: nullable current pointers or foreign roots do not select an event.

## Expected scaling

For selected child count K and total tenant rows N, event/root keyed lookup work
should follow K; candidate construction may scan N once using existing indexes,
but must not replay N roots/events times N children. Remaining
integrity checks and broad paths may still have linear tenant work. We do not promise
every reader becomes O(K), nor infer whole-owner speed from a single plan ratio.

## Acceptance

Add old-versus-new selector differential tests for three directions, duplicates,
ordering/cap sentinel, tenant and broken-root states; lot/date/product combinations;
retain public corruption/first-error tests. Add a bounded stale-statistics, unrelated-
lot populated plan regression for BOTH actual builders, preserving the existing broad
2001 test and its work bounds. New work metrics include scans, joins, CTE/materialized
replays and removed rows times loops. Reject quadratic work; do not pin planner names.

Keep every existing deadline, fixture, counter and oracle unchanged: ordinary native
270-query/hash golden is outside these Trace selectors and must remain pinned; completed
owner remains 543 actual calls. Any unexpected golden change requires investigation,
not automatic repinning. No workflow/test-ownership reduction or hidden filtering.

After independent review, require a short actual whole-owner materiality check, then
the unchanged original29 and API gates, followed by controller-authorized push and
exact-SHA CI (including existing full262 and other suites). No new index diagnostic,
population sweep or broad local rerun is part of this plan. Deployment, production load and full-population performance
are not proven by synthetic selector tests. Stop if whole-owner/full262 headroom does
not improve materially; do not compensate with weaker checks or higher timeouts.
