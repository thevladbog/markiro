# US-11 Shipping native transaction foundation

Status: owner authorized implementation on2026-10-08 and expressly waived further
intermediate approval questions. Preserve separate implementer and independent
review per stage. This is the native foundation, not dataset orchestration.

## Intent

Continue the accepted six-month synthetic dataset for one reserved US tenant.
Its unchanged recipe has260regular chains and440Shipping events, including the
original Scenario A. Enable existing Shipping operations to participate in the
same transaction as a future dataset receipt. No population is authorized here.

## Current source and selected design

UsShippingStore.createDraft/checkReadiness/getRecord and finalizeShipping start
their own shippingTransaction. That wrapper uses repeatable read and three
attempts for established retryable failures. Passing these wrappers into the
read-committed dataset callback would create separate commits.

Extract their existing bodies into supplied-transaction entry points; public
methods delegate through the unchanged wrapper. Native creation retains counters,
reference checks, child persistence, exact audit and operation receipt. Native
finalization retains readiness/input digest, affected-lot locking, immutable
snapshots, dependency increments and automatic lot-status effects/audits. Native
readiness and record reads retain current checks and capabilities.

Do not duplicate business rules, write seed snapshots with SQL, fake Db objects,
add client source flags or use independent pool reads. No nested transaction,
inner retry, commit or sanitized retry-exhaustion conversion in native methods.
Propagate the actual original driver error and cause.

## Internal API and compatibility

Add four UsShippingStore methods taking UsMasterDataTransaction as first argument:
createDraftInTransaction,checkReadinessInTransaction,getRecordInTransaction and
finalizeInTransaction. Export finalizeShippingInTransaction beside the existing
finalizer. Precise typed signatures are in the implementation plan.

Every native boundary reauthorizes before parsing IDs/input or replay:
SHIPPING_WRITE for create,READ for readiness/record,QA_MANAGE for finalize.
Keep public signatures, commandVersion1digests, operation keys/replay bytes,
capabilities/denial order/HTTP/schema, repeatable-read retries and exhaustion
behavior unchanged. Save/amend/void/revisions/balance remain existing paths.

Historical command receipt is not current-origin certification. The subsequent
dataset verifier will check actual current state and refuse drift/adoption; no
dataset codec, support writer, repair or initializer is added in this increment.

## Isolation and locking

Preserve operation-before-own-root/header and affected-lots-in-sorted-order,
reference locks, status-effect ownership and existing lifecycle protocols.
Native multi-query reads require caller-owned repeatable read or a separately
proven explicit lock protocol. Reading own fresh rows is not proof of arbitrary
read-committed consistency. The dataset's upstream Receiving/Transformation/
Cases locks and cross-stage ordering belong to its subsequent plan.

Map existing public finalize/amend/void/status/reference writers and demonstrate
actual PostgreSQL contention. Tests may use repeatable read for general reads
and read committed for visibility/rollback of own fresh writes; label the proof.
If an extraction exposes a lock gap, report it rather than silently altering
isolation, reordering public locks or expanding into dataset orchestration.

## Verification

TDD actual service composition in invocation-owned disposable US PostgreSQL.
Seed real finalized100-case Receiving or Transformation origins. Compose a
real reference document and Shipping create/readiness/finalize/read inside one
caller transaction; independently assert20shipped/80remaining and100/zero with
real shipped-status effect. Throw after finalization and pin complete persisted
rollback:documents,counters,roots/revisions/children,lot dependency/status/effect,
operations and exact audits. Fail at actual write/audit/operation boundaries too.

Assert exact tenant/actor/action/target/outcome/requestId/before/after, replay
bytes/current authorization, cross-tenant denial and malformed-input precedence.
Inject40001/40P01 only as explicitly injected evidence:one attempt and original
error identity, caller rollback, no subsequent recovery statement in aborted tx.
Actual lock tests observe backend PIDs and barriers, release before worker drain,
dispose only owned resources, retain primary failure when cleanup also fails.
No sleep-only proofs, timeout increases or weakened assertions.

Run new seams/locks and all10existing Shipping suites serially with fixture-only
US_TEST_DATABASE_URL,DATABASE_URL unset. Preserve current manual/HTTP/lifecycle/
stock/status regressions. Exact unconditional CI owner after shared/domain/API
builds; negative parsed YAML mutations, global unique suite selection and no
DATABASE_URL fallback; preserve old commands/settings/permissions/30min budget.
Fresh API typecheck/lint/build, tooling, format/diff, final configured regression
and one separate full API with both DB variables unset. Full API errors/skips
remain distinct from bounded foundation results.

## Boundaries

Only existing codex/us-mvp worktree; preserve accepted dirty sources and index.
No staging,commit,push,PR,merge,release,cleanup,dependencies/env changes or shared
base writes. Reuse installed dependencies; no builds during DB fixtures.
No migration,Station,scanners,printing,archive/design-file edits,CLI/runtime/HTTP
initializer,Shipping dataset orchestration,special examples,Plan/Requests or
full-volume generation. Hosted storage remains outsideRF; no resources created.

Prior full API nongreen8files and earlier4ordinary Cases timeouts with unresolved
causes, scan-partition coverage gap and Vite CJS warning remain explicit. No
remote CI30min measurement/browser/hardware/backup/provider/deployment/regulatory
acceptance. Local synthetic results are not real six-month customer activity.
Graphify graph absent; inspect source directly without installing/generating one.
