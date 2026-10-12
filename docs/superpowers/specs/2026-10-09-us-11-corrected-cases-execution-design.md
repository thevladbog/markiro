# US-11 corrected Cases native execution

## Outcome and constraints

Implement internal `UsDatasetCorrectedCasesSeedStore.initialize(context)` and
`verify(context)` for `correction_0001/cases`. Use the accepted corrected Cases
input boundary and actual completed corrected Transformation. The fixed recipe
creates exactly 60 boxes/links, SSCC serials 15641–15700, support sequence 261.
No regular-chain alias, public source selector, new tenant, Shipping, CLI/runtime
registration, dependency/schema/environment change, push or deployment.

## Selected architecture

Use a distinct corrected result codec and executor. Extract shared structural
Cases evidence checks/support/command/current-content verification, keeping regular
parsers, command digests, public APIs and operation semantics unchanged. Shared
structural projections are not authorization or an accepted input codec. No copied
SQL link writer and no duplicated regular verifier/command implementation.

The corrected result has `input`, `support`, `operationKey`, `requestId`, `linked`;
its input is the accepted corrected codec. Strict data-only bounded parsing checks
exact support bindings, markers, ordered links, synthetic/demo provenance, current
origin, consistent SSCC, uniform actor, absent unlink facts, canonical IDs/instants.
Owned records are shift, 60 boxes, 60 links; IDs are unique and do not alias known
carried prerequisite business record IDs. Operation keys have their own namespace;
do not invent cross-namespace uniqueness constraints. Actual receipt-owned
Receiving and Transformation document IDs are additionally checked by the executor,
including generated link IDs, not only captured support IDs. Request ID is
`dataset-cases:<operationKey>` for execution.
Corrected audit identity uses dataset/version/digest/unit/canonical input digest.
Command digest retains commandVersion 2, `case.link`, `demo_seed`, output lot,
sorted SSCCs and that seed identity; it cannot replay a manual/regular operation.

## Atomicity, authorization and locking

Read actual journal target/owner/profile before processing evidence; verify current
TRANSFORMATION_WRITE capability in the supplied transaction. Missing prerequisites
are not installed implicitly. Read original Receiving, amendment and Transformation
stages; reconstruct corrected Cases input with captured support and compare exactly.

Hold journal/header/stage arbitration, then the Cases operation lock BEFORE any
origin root or lot. Verify corrected Transformation in replay mode: it locks both
origins/revisions and the sorted union of two input lots/output lot and verifies
the amended Receiving history/current state. Keep these locks through commit,
then shift/SSCC-sorted boxes/markers. No pool read or new transaction inside this
boundary, and no origin root lock first acquired after box/output-lot locks.

Insert only fresh minimal planned aggregation shift, boxes and synthetic markers
using existing shared support persistence. No physical contents, scanner/operator,
closure, printing or production facts. Collisions fail without adoption or repair.
Invoke existing CaseLink core after guarded support/marker checks in the SAME tx;
service owns links, dependency increments, native audit and operation receipt.
Perform canonical current-content verification before journal receipt publication.
Any failure rolls back all business effects; captured intent remains for explicit
whole-transaction restart with the same IDs/key. Preserve original driver errors.

An existing operation is valid only with the exact completed canonical Cases
receipt; a pending operation is not adopted. Fresh candidate verification is
allowed only after this invocation applied its private business writes. Completed
replay/verify cannot create missing rows or new audit/dependency facts. Concurrent
intent losers use the winner's captured support. Lost commit acknowledgement is
resolved by journal/current-state verification, not guessed by SSCC lookup.

## Current proof and verification

Check actual complete shift/boxes/markers, no physical activity or unexpected link
history, exact active output-lot link set, actor/time/source/IDs, native command
digest/result and exact audit fields. Void/amendment/pending origin, archive,
unlink/relink, drift/forged evidence rejects without repair. Legitimate later
Shipping may change stock and technical dependency tokens; neither invalidates
unchanged historical Cases facts. Public old links may retain origin-gap visibility.

Tests use real installed corrected prerequisites, owned disposable US databases,
and original fixture drain/disposal. Pin 60 actual links and amended 300/400 lb
origin/history, exact audit, no physical/event changes, read-only replay, failures
after real writes/verification, restart/lost acknowledgement, tenant/owner denial,
pending/manual operation clash, support/link/origin drift, downstream consumption,
concurrent initialization and PID-observed operation/origin lock ordering.

New focused corrected Cases contract/native suites get a dedicated unconditional
serial check-only CI owner after successful shared/API builds, exact isolated
fixture URL, no primary fallback. Existing owners/commands/release locks remain
byte-for-byte unchanged. Executable parsed-workflow mutations exercise ownership.
Run scoped configured regular regressions, API package/static gates, formatting,
isolation/source-byte verification and independent reviews; disclose skips/warnings
and package setup failures. No browser/hosting/physical/regulatory claim.
