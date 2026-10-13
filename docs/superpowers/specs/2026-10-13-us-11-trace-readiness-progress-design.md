# US-11 durable Trace/Readiness progress

Status: next integration slice under the owner's standing demo-completion
authorization, following independently accepted read-only unit proof. No release,
shared-base writes or hosted acceptance are implied.

## Outcome and boundaries

Compose native chain verification with the new read-only Trace/Readiness unit
verifier, persist actual checked per-unit evidence in the existing dataset journal,
and support explicit resume. Preserve the immutable six-month recipe and every
existing native coordinator contract. Plan and Requests remain subsequent work.

## Per-unit stage

Add `UsDatasetTraceReadinessStageStore(db)` with `initialize(context, unit)` and
`verify(context, unit)`. It consumes the strict unit selector and result from
`UsDatasetTraceReadinessStore` and returns that same bounded frozen result.
Neither mode initializes native prerequisites.

Before writing a `trace_readiness` intent, obtain actual native/read-model proof.
Then bind the intent to the checked dataset ID, version, definition digest, unit
selector and its completed immediate predecessor: `shipping` for regular and
corrected units, `void_receiving` for the orphan. Include the predecessor's exact
operation key, input/result digests and completed revision in a versioned bounded
input. An unrelated or changed predecessor is a conflict, never adoption.

Use the existing journal's supported capture/record operations. Allocate one
random operation key only for a new intent. A compatible concurrent capture uses
the winning persisted key; incompatible intent/receipt rejects. Resume a pending
intent using its original key and exact body. Receipt IDs are the exact unique
owned lot/current event IDs from native proof; receipt result and digest preserve
the complete stable semantic evidence result. The orphan's void-history identity
is covered by checked history digests, not mislabelled as a current event ID.

Both existing-completed initialize and verify re-run actual native/read-model
proof and compare it with the complete saved receipt and predecessor binding.
Verify requires an already completed stage and never captures an intent, fills a
receipt, initializes a prerequisite or repairs drift. Missing stage/receipt is
precise incomplete state; semantic mismatch rejects without rewriting history.

Proof is assembled through existing independent service snapshots. Recording a
receipt does not turn those reads into one cross-service snapshot or promise
future business immutability. Journal writes retain the existing authorized,
tenant-scoped transaction boundary. Full verification must recheck canonical
state; a receipt alone never establishes acceptance. There are no business writes
in this new stage and therefore no fabricated cross-service business transaction.

## Bounded all-unit coordinator

Add `UsDatasetTraceReadinessSeedStore(db)` with `initialize(context)` and
`verify(context)`. Call the unchanged native coordinator in the requested mode,
then process regular units 0 through 259, correction and orphan sequentially.
Do not expose a caller-supplied incomplete range as full verification. Stop on
the original error, retaining earlier actual committed progress; explicit
initialize resumes compatible pending work. No retry loop or concurrent chains.

Return a deeply owned bounded summary with native dataset identity,
`state: "native_chains_trace_readiness_verified"`, literal `datasetComplete: false`,
and 262 ordered unit entries containing unit key and checked result digest.
Keep the existing native result separate rather than silently redefining it.
No Plan/Request/package, CLI, auth, HTTP/UI, runtime or hosting registration.

## Acceptance

Native disposable database tests must prove fresh/partial read-only refusal,
pending resume, completed no-write replay, exact receipt bindings/IDs/digests,
compatible competing captures, incompatible intent/receipt rejection, actual
business drift rejection and tenant/owner/target denial. Include the supported
correction and void examples. Drain all owned work before normal disposal.

The all-unit acceptance runs all 260 chains plus both special units and verifies
262 completed `trace_readiness` stages with no Plan/Requests and false completion.
Compare full-table hashes for complete verify and initialize replay. Preserve the
existing full native coordinator's 900000ms budget and tests; a new complete
composition test may use that same initial budget, never a greater one. Report
actual generation/verification/replay timing and cleanup, not a cloud estimate.

No schema/recipe/dependency/release edits or weakening of existing tests. Only
`US_TEST_DATABASE_URL` points to the reserved synthetic fixture; normal primary
database configuration remains unset and no shared base is seeded.
