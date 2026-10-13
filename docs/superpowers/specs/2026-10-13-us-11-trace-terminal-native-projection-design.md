# US-11 terminal native projection for Trace/Readiness

Status: scoped performance correction under standing implementation approval.
No full-dataset or hosted acceptance is implied by source review.

## Evidence and problem

GitHub run38349158875 at cedecca8d completed with six original isolation jobs
successful. The additional Trace/Readiness job passed25 tests and failed the
full260-regular-plus2-special test at its unchanged900000ms limit. The tracked
work then exceeded the existing60000ms drain hooks; no full-seed disposal/absence
was logged. This is distinct from the earlier local unexplained SIGTERM.

The current unit proof calls Shipping.verify, Receiving.verify and
Transformation.verify separately. Shipping already verifies Cases, Transformation,
Receiving and references in its native transaction. The existing real one-unit
measurement is906 SQL dispatches: Shipping393, Receiving114, Transformation178,
per-lot Trace/Readiness/history210, outer11. The latter two standalone dependency
calls repeat292 dispatches. Their measured~662ms is only a candidate saving, not
proof that this correction alone will meet the complete-test budget.

## Selected boundary

Add an internal terminal verification method on UsDatasetShippingSeedStore that
returns an owned immutable projection of the exact Receiving, Transformation and
Shipping results verified during its one existing guarded native transaction.
The normal initialize/verify methods keep their result shapes and behavior.

The terminal verifier may return the existing prepared dependency rows/results
only after every current verification has succeeded. Preserve all native intent,
receipt, operation, root/revision, reference, audit, document, quantity, stock,
case-link and source checks. The implementation must not reload a dependency in
a later transaction and describe it as verified by an earlier one. It must not
accept caller-supplied prepared rows, completion evidence or skip-check flags.
No shared cache, cross-call cache, cross-transaction reuse or receipt-only proof.

Keep actual database, tenant, original owner, current role/profile authorization
before interpreting the selector or evidence. Retain existing arbitration and
business lock order/cardinality, native transaction/isolation/retry ownership,
semantic error namespaces and original driver failures. Projection fields are
schema-owned clones, deeply frozen and bounded; mutable journal objects or
transaction handles must not escape. Native getters/public HTTP are unchanged.

Each projected result must be identical to the exact receipt/intent checked by
the nested verifier: dataset/tenant/original owner/unit/stage/revision, operation
key, input/inputDigest, recordIds and result/resultDigest. Thread those checked
values back, or explicitly prove their identity with the retained locked rows.
Return only owned parsed results, never stage rows or callbacks. An invocation-
local captured projection is released only after awaited runAtomicStage succeeds;
query or COMMIT failures propagate unchanged and cannot yield a projection.

TraceReadiness.verify uses this terminal projection for regular chains instead
of the three separate top-level verifier calls. It still calls the actual Trace,
Readiness and history services independently for every lot, with original
directions, periods, limits and complete exact evidence checks. The accepted
independent native/read-model snapshot boundary is retained. Correction and
orphan verification initially remain unchanged.

The native observation is the facts checked under retained locks in that one
existing read-committed terminal transaction, not a global frozen snapshot. A
writer committed before relevant lock acquisition must be observed. A blocked
writer may commit after terminal commit; every later read-model call keeps its
own current observation and must reject incompatible evidence. Require a real
barrier regression between terminal commit and actual read-model calls. Do not
promise identical behavior for every adversarial interleaving or add a new
whole-proof transaction to manufacture that promise.

The full coordinator's native pass,260+2 ordered durable stages, fault/resume,
completed verification/replay and result shape remain unchanged in this slice.
No adoption, regeneration or repair is allowed. Any additional composition
deduplication requires a separate measured design; it cannot be silently included
to force this slice green.

## Acceptance

Use only fresh owned disposable US PostgreSQL children with DATABASE_URL unset;
normal work drain, non-FORCE disposal and exact absence. Keep all existing limits,
timeouts, assertions and CI ownership checks. The initial missing-method native
test must fail meaningfully before implementation.

Compare the new projection to actual existing standalone verifier results in the
same unchanged fixture, including exact canonical outputs and full-table no-write
hashes. Measure actual SQL dispatches transparently: retain forwarded pg behavior,
restore instrumentation and log counts/phase durations without SQL parameters or
private payloads. Assert that the new regular proof reduces reads versus the
accepted reference path, not merely wall-time luck.

Negative tests must independently mutate live Receiving, Transformation, Cases,
Shipping and reference facts while saved completed receipts remain present;
all must still fail without writes. Exercise tenant/original-owner/current-role/
database and hostile selectors, pending/missing prerequisites, genuine driver
failures and actual concurrent lifecycle writers blocked by retained locks.
Include writer-first and verifier-first lock cases, the terminal-commit/read-model
barrier, and genuine query/commit failures with no escaped projection.
Retain existing Trace/Readiness drift and evidence-tampering tests.

After native regressions/static gates and independent source review, run the
unchanged full262 acceptance in the existing900000ms budget. Add only bounded safe
phase-progress diagnostics to that test so a failure locates generation, resume,
verification or replay rather than hiding all timing until the final print.
Actual green is required; if it still fails, record phase evidence and design the
next correction without relaxing checks or retrying unchanged until green.

The new projection native suite requires explicit ownership in the existing
dedicated Trace job: add it to the exact command and strict ownership contract
after a meaningful missing-suite RED. Preserve all original six matrix segments,
job guards and30-minute budget; retain negative mutation checks for every gate.

No schema/manifest/dependency/public API/UI/auth/provider/release change. Plan and
Requests integration remains blocked on actual full Trace/Readiness acceptance.
