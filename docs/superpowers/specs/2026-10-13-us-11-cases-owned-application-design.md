# US-11 Cases: service-owned synthetic support and link application

Status: selected next measured optimization, design review required before implementation. Not a complete 900-second/full-demo acceptance claim.

## Evidence and intent

Run `38364992465` at `dc3e3fb66` passed all six isolation segments but failed the unchanged full Trace test at 900000 ms. Bounded actual native measurements at `27d11d834` found Cases.initialize performs the same application preparation twice in one transaction: the seed calls `prepareUsDatasetCases`, inserts synthetic support, and calls native `linkDemoInTransaction`, which prepares again. The separate final verifier prepares a third time and must remain. Each index-0 preparation measured 159 actual SQL calls; this is a source-backed duplicate, not a guessed timing fix.

The goal is to let the native synthetic application own preparation, support insertion and link in one invocation, without accepting a cached proof or weakening post-write verification. This is one initial-generation improvement. Coordinator fusion and further repeated verifier work are separate slices; no unchanged full run is justified merely by this change.

## Selected design

Add an internal `seedDemoInTransaction(tx, context, datasetId, unitKey, requestId)` method to `UsCaseStore`, backed by the existing US-only synthetic demo command module. It independently calls the existing strict `prepareUsDatasetCases` in application mode, which owns actual database/tenant/actor/dataset/intent/operation/prerequisite guards and native origin locks. It then calls existing `insertUsDatasetCasesSupport` followed by existing `linkPreparedDemoCasesInTransaction` with the service-produced input, operation identity and digest/audit seed. Return an independently parsed bounded service result containing `input`, `support` and `linked`, not an authorization token.

The seed's atomic apply callback calls only this native entry and constructs the unchanged Cases receipt using the intent's operation key and unchanged request ID. It must not call preparation separately, supply support IDs outside the saved intent, or accept any preverified evidence. Its `runAtomicStage` verify callback remains unchanged and performs the full fresh post-write origin/support/link/operation/audit proof before receipt publication. Existing receipt replay still follows the unchanged final verifier without new writes.

Existing `linkDemoInTransaction` remains compatible: it independently prepares and links already-existing support, never silently creates support for callers. Public manual link/unlink, lookup, seed recipe, SSCC/box identities, physical Station/printing, audit shape and stage schema are unchanged.

No cache, memo, WeakMap proof reuse, invalidation protocol, callback supplied by a caller, skip flag, caller-owned projection or transaction outside the actual supplied transaction. A private helper may share the post-preparation link content between the two internal native entries, but inputs cannot be supplied by external callers. Both entries independently prepare before any write. The new seed entry is a trusted internal synthetic command, not an HTTP operation.

## Atomicity and compatibility

Support insertion, native case links, operation, exact success audit and journal receipt remain in the caller's atomic transaction. Initial authorization/prerequisite rejection and raw driver error identity remain unchanged. Drift introduced by support insertion may now reach the unchanged final verifier rather than the removed second application preparation: it uses that verifier's existing `us_dataset_cases_mismatch` wrapper, retaining its upstream cause. This intentional difference in failure timing/domain wrapper cannot permit a commit, receipt or partial write. No nested transaction, savepoint, retry, catch-and-success or rejection audit is introduced. Native link order, fixed lock order, current owner/profile checks and original-key resume are retained.

Do not adopt pending pre-existing support or pre-linked boxes. Existing insertion/link rules remain authoritative. A caller who supplies a malformed or hostile context cannot gain access merely because the intent names synthetic support. The new method returns application evidence, not completion; its sole production caller is the seed's atomic apply, which must subsequently execute the unchanged final verifier. A direct native-call test alone cannot claim post-write proof or receipt acceptance. After the entry returns, same-transaction trigger or caller drift must still be rejected by that verifier; no pre-write result certifies a post-write state.

## Required verification

Meaningful missing-method native RED first. Focused new native tests use actual disposable owned PostgreSQL, the real reference/Receiving/Transformation prerequisites and saved Cases intent. Verify exact returned input/support/links, persisted operation and audit; caller rollback; denial before hostile selector interpretation; wrong actor/tenant/DB/profile/header/unit/operation boundaries; no pending-support adoption; same-key competitors; actual link/support/audit/receipt SQLSTATE failures and trigger mutation rejected by final proof. An actual support-insertion trigger must mutate an upstream descriptive field outside support (for example the captured output product name); a second case mutates an ancestor after application returns. Both must reach the real seed/journal final verifier, retain the defined cause/wrapper, preserve the pending intent/key and roll back all198 public tables including trigger writes. Support-only drift is insufficient.

Use actual forwarding query/function instrumentation to compare the new seed path with the previous implementation on the same fixture recipe: precisely one application preparation plus unchanged final preparation, versus previous two application preparations plus final. Measure counts and equal full native result and all-public-table no-write replay snapshots; query counts may drop, assertions may not. No counts fabricated from source or fake Ready rows.

Run native Cases preparation/verify/locks/seed/demo-command suites, regular orchestration and relevant Shipping consumers; preserve their behavioral assertions and deadlines. Allow only necessary interception-point adaptation in `us-dataset-cases-seed.e2e.test.ts`: its old link-method spies must forward real work at an equivalent existing post-preparation native content/SQL boundary. Preserve support-failure versus content-link-attempt counts, competitor single application, exact extensible/frozen/sealed/nonconfigurable/non-Error identity and rollback, actual PID-observed operation-lock waiter, cancellation guard after preparation, abort reason, release/drain order, full snapshots and backend absence. No production test hook, assertion deletion, timeout change or name-only rename moving cancellation before preparation. Existing link-only native service tests stay unchanged. Run API types/lint/build and focused format/diff. Explicitly select the new native regression suite in the already-reviewed dedicated prepared-services job with an independent literal pin and missing/duplicate/filter denial; preserve all previous selectors, historical hashes and the 30-minute budget.

## Acceptance boundary

Independent task and complete selected-plan source review, focused native regression/static gates and actual same-SHA native CI are separate evidence. Report the savings measured, not a promise to fit the unchanged full test. Keep 900000/60000 test/fixture deadlines, complete 260+2 range, current authorization/drift/content/audit assertions and no-write snapshots. Do not launch another unchanged full gate until the subsequent composition optimization is source-reviewed and a whole-test budget forecast is evidence-backed.

No schema/migrations, library/config changes, RU/main/Station, public routes, release, PR or hosting. Full Trace remains RED, generic scoped worker and Request package integration remain deferred behind the measured remedy.

### Regression-harness cleanup discovered during verification

The unchanged eight-file regression run exposed acknowledgement-loss spy
contamination after a native test timeout. Vitest can finish a timed-out test
without cancelling its tracked asynchronous work; a cleanup registered later
may miss the finished-hook snapshot. The precise observed registration schedule
is not yet reproduced and must not be presented as the proven timing cause.
The test-only correction must restore the spy in lexical `finally` inside the
tracked body, retain explicit restoration before completed replay, and preserve
all original assertions, forwarded native work, error identity and deadlines.
A focused regression must use the same cleanup wrapper as the actual
acknowledgement-loss case, introduce a distinct rejection after installation and
real native forwarding, and verify prototype identity before finished hooks run.
No production hook, skipped check, swallowed error or timing-budget change.
