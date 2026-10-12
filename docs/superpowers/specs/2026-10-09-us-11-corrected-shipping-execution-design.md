# Corrected Shipping native execution

## Intent and boundary

Complete the fixed correction_0001 synthetic recipe through one native Shipping
event. Existing Receiving amendment, corrected Transformation and 60 Cases must
already be installed. Ship 50 case on 2026-06-12 from processor to recipient_02;
the actual current balance must become supply 60, used 50, remaining 10. The output
lot stays active and unchanged. No allocation to particular SSCCs is introduced.
Routine design/plan approvals are waived; independent execution/review remains.
No commit, push, PR, deployment, install, user environment or schema changes.

## Architecture and alternatives

Use a dedicated corrected executor and result codec with the accepted nested
corrected input. Extract existing Shipping result/content assertions into shared
internal helpers consumed by regular and corrected adapters. Preserve regular
codec, recipe, request IDs, semantics and all existing assertions. This avoids
copying the native evidence verifier or pretending corrected data is a regular
chain. A wholly duplicated executor/verifier is rejected for drift; widening the
regular codec to accept corrected origins is rejected for compatibility risk.

## Frozen evidence

`UsDatasetCorrectedShippingResult` has exactly input, originLot, outputLotAfter,
shipments, using existing native shipment result fields. Parsing guards the
entire raw value with assertUsDatasetCorrectedTransformationJson before reads,
then parses the accepted corrected input and native document/draft/final schemas.
Reuse extracted regular lifecycle/result validation through a small explicit
chain/output-ID/plan projection, never a fabricated regular input codec. Require
one shipment, exact recipe/document order, native operation-key derivation and
`dataset-shipping:<journal operation key>:1`, actor/clock/lifecycle coherence,
distinct owned IDs, source/TLC/product consistency and unchanged active output
lot. Owned deep freeze; no caller freeze or normalization. Record IDs are exactly
two document IDs then native event/root ID, in order. Separate corrected error
codes result_invalid, conflict, mismatch and prerequisite_incomplete preserve
cause and fixed correction_0001/shipping context.

## Transaction and authorization

`UsDatasetCorrectedShippingSeedStore(db).initialize(context)` captures only its
own Shipping intent if absent, then uses the existing journal atomic-stage runner.
`verify(context)` does not capture or write. Neither installs prerequisites.
Authorize actual installed header/database/owner/profile and current SHIPPING_WRITE
before parsing supplied evidence or capture, and again inside the transaction.
Current upstream verification retains its existing required capabilities.

Reconstruct the input from current reference/amendment/Transformation/Cases journal
rows. Recheck original Receiving linkage through corrected Cases current verifier.
Compare stored Shipping intent exactly; never silently repair a conflicting intent.
Capture races read the winning compatible intent. Pending stage revision1 advances
to completed revision2 only with native business rows and verified receipt in the
same transaction. initialize replay and verify compare the exact persisted receipt.
Fresh verification requires private native rows from this transaction, not merely
matching data owned by another transaction.

## Lock order and current proof

Retain existing dataset arbitration/header/stage locks. All operation arbitration
(Cases link, corrected Transformation create/finalize, Shipping create/finalize)
precedes business roots. Lock owned Receiving root/all revisions (including actual
amended revision2), Transformation root/all revisions and known Shipping root/all
revisions before sorted union of input/output lots. Then retain public reference,
profile and all upstream/known/new-conflicting document shares before final Cases
support locks. Reacquisition by upstream verifiers must be of already held locks.
Never discover/lock another unowned Shipping root after lot locks.

Application invokes corrected Cases verifier in replay mode and checks current
balance known/case/60 supply/0 used/60 remaining, active output lot and absence of
conflicting shipment documents/native operations. Existing unrelated consumers or
unknown/UOM-divergent balance reject, not merely warn. Replay revalidates corrected
Cases/current origins, native operations, event root/revisions/header, lines and
snapshots, document links/details/records/issuers, exact audit actor/tenant/action/
target/before/after/request/time and actual balance60/50/10 with exactly the owned
current Shipping consumer. No Shipping status effect or status-change audit exists.
Reference/profile/support drift, amendments, pending revisions, void or extra
consumers reject without business changes. Driver/domain failure identity is
preserved where it is not an expected evidence-mismatch wrapper.

## Native writes

Create the two recipe documents, native draft, readiness and finalize using
existing in-transaction stores, one derived operation key and request ID. Retain
native readiness input digest rather than inventing/recomputing historical stock.
Receipt parsing and fresh current proof happen before commit. Any document,
draft/finalize, operation/audit, verification or receipt-write failure rolls back
all business writes and leaves the captured intent pending for safe retry.

## Verification and delivery

Pure corrected result mutations plus unchanged regular result regressions; real
native scenarios, snapshots, SQL faults and lifecycle/concurrency probes in the
existing CI-owned corrected Cases suite using its unchanged single US fixture gate.
New helpers remain test-local. Actual transactions use only audited randomized
owned child databases from loopback55432; never migrate/seed/reset shared base.
DB tasks do not overlap static/build/package checks. Preserve old test bodies,
gate, hooks, timers and assertions; report skips and failures by name. Full API
test, typecheck/lint/build/format/isolation and affected ownership checks remain
separate gates; remote CI/browser/hosting/backup/residency are not implied.
CLI/full-dataset wiring and trace_readiness are subsequent increments.
