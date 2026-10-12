# US-11 full native chain coordinator

Status: implementation under the owner's standing approval, separate implementer
and independent reviews. No publication or shared database writes authorized.

## Outcome

Compose the existing regular and special native stores into one explicit internal
initializer/verifier for the six-month recipe. This produces native chain evidence,
not a complete or hosted demo. Trace/readiness, Plan, Requests, CLI, visitor and
artifact acceptance remain subsequent work.

## Architecture and contract

Create `UsDatasetNativeSeedStore` in `us-dataset-native-seed.ts`, constructed with
the existing `Db`. Export `UsDatasetNativeResult`: the same identity and owned
regular/special summaries as `UsDatasetNativeAssemblyInput`, but with state
`native_chains_shipping_verified` and literal `datasetComplete: false`.

Expose `initialize(context: UsDatasetContext): Promise<UsDatasetNativeResult>` and
`verify(context: UsDatasetContext): Promise<UsDatasetNativeResult>`. Each call:

1. Reads the pinned dataset journal to validate the actual target and trusted owner.
2. Calls the regular store in the requested mode with exactly
   `{ startIndex: 0, count: 260 }`.
3. Calls the special-chain store in that same mode only after regular success.
4. Passes both actual returned summaries to `makeUsDatasetNativeAssemblyInput`.
5. Returns an owned frozen result with the native state and false completion flag.

There is no caller-supplied range, stage shortcut, mockable production interface,
new receipt, new SQL path, concurrency or retry loop. Errors propagate unchanged:
do not wrap, replace, mutate or duplicate upstream annotations. Existing services
own bounded transactions, authorization, current proofs and idempotency. A failed
run retains earlier committed stages and stops before later stages; an explicit
subsequent initialize resumes compatible state. Verify never installs prerequisites.
The coordinator does not promise an all-run transaction or point-in-time snapshot;
each constituent native proof has its own existing transactional boundary.

Sequential composition is preferred to a monolithic transaction (unbounded locks
and false atomicity) or parallel chains (unnecessary recovery/resource complexity).
Neither underlying store, its contracts nor the pure input codec changes.

## Native acceptance in this increment

Use only the verified synthetic fixture base `127.0.0.1:55432/markiro_us_dev`,
role `markiro_us`, to create randomized owned child databases with existing fixture
helpers. Never migrate/truncate/populate the base or read the user's `.env`.
Primary `DATABASE_URL` stays unset; only native test processes receive the exact
`US_TEST_DATABASE_URL`. Pure/static commands unset both actual variable names.
Register/drain complete asynchronous phases before cleanup; remove only owned
failpoints and child databases after work and clients have settled.

Test genuine native behavior, not mocked store forwarding. Include fresh/partial
verify no-write failure, actual target/tenant/owner/role/provenance rejection, and
full-volume generation with a late special-chain SQL failpoint. Confirm all 260
regular chains remain committed, no orphan work starts after the failure, then
remove only the failpoint and explicitly resume through correction and orphan.
Inspect independent persisted totals: 964 roots, 963 current finalized events,
785 lots and 15,700 distinct synthetic boxes, including 100 for Scenario A.
Check correction amendment history and voided orphan with retained lots using
existing native reads. Confirm ordered indices, actual summary digests, bounded
owned immutability and false completion. Replay initialize and verify must preserve
all table snapshot hashes. Deliberate owned business drift must reject both modes
without repair; use existing fixture techniques, not shared records.

Measure generation/resume, verification and replay elapsed times, process peak RSS
and actual child database size. These measurements cover native chains and the
test process only, not artifacts, cloud performance or hosting cost. The new full
native phase has an initial explicit 900,000 ms acceptance-test budget; do not
increase existing timeouts or suppress failure. Exceeding this budget requires a
documented diagnosis, not an automatic timeout bump. Report skipped native gates.

## Isolation and subsequent boundaries

No HTTP/UI/CLI/runtime registration, default startup population, dependencies,
environment files, schema/migrations, release workflows or external writes.
This increment does not edit CI ownership: measure full native execution first;
a dedicated US push-CI owner/budget is the next independently reviewed slice.
Generic API test collection must retain the native fixture gate and report skips.
No commit, push, PR, deployment or cleanup of user work. Append truthful progress
checkpoints without rewriting previous acceptance evidence.
