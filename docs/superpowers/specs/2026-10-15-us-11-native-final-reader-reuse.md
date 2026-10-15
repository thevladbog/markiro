# US-11: native final-verifier row reuse

## Evidence and boundary

At `cd8a56474`, CI run `38698328779` passed seven jobs, including the unchanged
full 260+2 composition (764318 ms body, 62/62 tests in its four-file job).
The remaining prepared-services job passed 455 tests and failed M05, M06, M11
and C17 at the original 5000 ms limit. No functional assertion failed.

Shipping already retains protected raw point rows inside its final verifier.
Earlier native final verifiers still discard rows read under their own locks,
then query those rows repeatedly through recursive native readers. This slice
extends the existing mechanism to those final verifier callbacks; it does not
declare an unmeasured performance margin.

## Invariants

- Allocate only after application and immediate triggers; revoke and clear in
  `finally`, before journal persistence and COMMIT. Never retain across callbacks,
  stages, transactions, calls or public read-model requests.
- Keep native/Core checks, order, errors, capability/membership reloads and all
  journal, absence, partial-batch, range, history, origin, balance and audit reads.
- Admit only actual present same-tenant rows protected by successful original
  locks, or private newly inserted rows proven by this invocation. Clone dates
  and JSON at retention and delivery. Failure admits nothing.
- Keep products, locations, product profiles and the amended-current revision
  fresh. Do not preload case markers across INSERTs: triggers can mutate them.
- Preserve the existing lock dependency surface and ordinary fresh SQL exactly.
  A successful existing lock can admit its proven keys; retain the full raw value
  only after its first original point getter. ID-only lock results are never full
  observations. Do not add lock adapters or widen default SELECT projections.
- No exported allocator, adapter, generic cache/callback API, caller-supplied
  proof, skipped verifier, parallel oracle or application-time reuse.
- Every existing test, fixture, counter, timeout and original measurement byte
  remains unchanged. US-only source and branch; no release or deployment.

## Structure

Use private shared implementation behind named final-verifier functions, not a
public dependency factory. Reuse the existing Shipping binding/cloning/revocation
logic; preserve its behavior while avoiding another independent policy copy.
Earlier seed callbacks use those named final verifiers. Ordinary native facades
and fresh control wrappers remain stateless. If a stage cannot establish the
required protection, leave that observation fresh rather than widen retention.

The first candidate widened lock projections and added two adapters. Existing
regressions rejected both changes: they changed the closed adapter inventory,
fresh SQL identity and counted full-row reads. Those changes are not accepted;
the compatible implementation must preserve the original contracts instead of
updating their assertions. The first performance checkpoint also remained red;
this slice alone does not establish completion of the performance task.

## Acceptance

Use the four observed CI failures as the performance RED. Add focused real-DB
coverage for actual locked-row reuse, fresh fallbacks, wrong binding, clone
isolation, trigger drift and revocation; retain current concurrency/rollback
coverage. Measure unchanged whole12 and whole17 once on the changed candidate.
If still red, retain exact evidence and judge the remaining bottleneck before
any further change; no automatic retry or whole260 rerun on unchanged source.
