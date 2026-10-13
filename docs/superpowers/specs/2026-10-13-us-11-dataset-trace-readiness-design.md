# US-11 dataset Trace and Readiness verification

Status: implementation under the owner's standing approval to finish the synthetic
demo without repeated approval prompts. The accepted six-month recipe remains
unchanged. Separate implementation and independent review remain required.

## Outcome

Verify that the existing cabinet read models faithfully expose each completed
regular chain, the corrected chain and the retained orphan lots. This is the next
bounded integration slice, not a new trace engine or readiness rule set.

The existing native coordinator proves 260 regular chains and the special
examples, but deliberately excludes Trace/Readiness, Plan and Requests. Never
replace its false completion flag with true based on this increment alone.

## Interface and proof

Add an internal `UsDatasetTraceReadinessStore`, constructed with the existing `Db`.
Its read-only `verify(context, unit)` accepts a strict discriminated selector:
`{ kind: "regular", index: 0..259 }`, `{ kind: "correction" }`, or
`{ kind: "orphan" }`. Reject extra keys, fractional/negative indices and negative
zero. Check the actual target and original trusted owner through the dataset
journal before interpreting business selectors.

Use existing native stage verifiers to establish the unit's current prerequisites;
do not initialize missing references, events, boxes or journal stages. Derive owned
lot and current revision IDs from checked service results, never arbitrary caller
IDs. Obtain graph and readiness evidence through the existing `UsTraceStore`.
Use the pinned business period `2026-04-01` through `2026-09-30`, never today or
a fabricated historical assessment timestamp.

For regular and corrected chains, require complete untruncated current trace,
exact three owned lots, the expected current Receiving/Transformation/Shipping
revision IDs, no unrelated events, and exact event-line quantities and UOMs.
Transformation must remain an event node, not invented proportional lot edges.
Check missing-origin findings and actual readiness findings, not just graph size.
The corrected trace must use the amended current Receiving revision; its previous
revision belongs to excluded history. Check that history contains the actual
superseded revision with the proper exclusion, without asserting unrelated
history pagination is globally empty.

For both orphan lots, require no current event/edge, a complete singleton lot
graph with the exact origin-gap finding, retained void history and the explicit
missing-origin readiness finding. The deliberate orphan is expected incomplete
evidence, not a reason to fake a globally clean readiness result.

Return a bounded deeply owned immutable summary containing dataset identity,
unit key, `state: "trace_readiness_verified"`, `datasetComplete: false`, checked
lot IDs, current event IDs and stable per-lot trace/readiness evidence digests.
Exclude only the live `assessedAt` timestamp from the readiness digest so repeat
reads do not drift merely because time advanced. Preserve findings, scopes,
counts, history facts and all semantic quantities. Report the actual assessment
time separately only if needed; do not persist fabricated times.

Errors reject without repairing business state. Existing infrastructure failures
and upstream domain failures retain their identities. New semantic mismatches
use a precise `us_dataset_trace_readiness_mismatch` error with unit and stage.
The helper does not promise one snapshot across multiple existing service reads.
Persisted stage receipts and whole-dataset composition require a subsequent
integration step, with native revalidation at replay; this increment adds none.

## Verification and isolation

Use fresh randomized disposable children of the reserved synthetic fixture
`127.0.0.1:55432/markiro_us_dev`, role `markiro_us`. Keep `DATABASE_URL` unset and
pass only `US_TEST_DATABASE_URL` to opt-in native tests. Drain owned work before
normal database disposal. Never read the user's `.env` or populate the shared base.

TDD must prove a completed regular chain, partial stock, Scenario A, correction,
void orphan, missing prerequisites, wrong owner/tenant/target and deliberate
business drift. Native full-table hashes before/after verification and replay
must match. No mocked trace/readiness success can establish acceptance.

No schema, recipe, business service rules, HTTP/UI, public contracts, dependencies,
release settings, timeouts or existing assertions change in this slice. Hosting,
Plan/Requests artifacts and full visitor acceptance remain distinct gates.
