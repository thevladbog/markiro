# US-11: atomic dataset Receiving stages

Status: written specification owner-approved on 2026-10-06. This document does
not authorize implementation, commit, push,
runtime registration, shared-base population or deployment. Implementation needs
an approved written plan and the established separate implementer/reviewer gates.

## 1. Outcome and scope

Implement the Receiving portion of the approved
[six-month dataset](2026-10-06-us-11-six-month-demo-design.md): one bounded,
resumable internal stage for each of the 260 regular chain descriptors, including
unchanged Scenario A at index259. A successful stage produces two reference
documents, one current finalized Receiving root/revision and two imported,
source-locked inbound lots through the existing services, together with its
dataset receipt. Repeating a completed stage verifies current business state
without duplicating records or renewing timestamps.

The recipe remains `us-processor-six-month-v1`, `2026-04-01` through
`2026-09-30`, `America/Los_Angeles`. Preserve the catalogue, manifest, digest,
compact recipe and all descriptor bytes. Reference strings resolve to exactly
one document definition by `input.number`, not its symbolic key. Preserve service
quantity representations, including Scenario A's snapshot text `"500"`.

This increment does not initialize all stages, create correction/orphan examples,
Transformation, Cases, Shipping, Plan or Requests, add a CLI/HTTP/UI entry point,
provision customers, or populate the shared base. It operates only through the
existing US worktree and internal test consumers. No Station, scanning, printing,
hosting, dependency/environment edits, migrations, reset or repair is included.

## 2. Approach and alternatives

Use the accepted dataset journal's `runAtomicStage` with native document and
Receiving commands/readers. PostgreSQL owns the business-stage commit and its
receipt; there is no separate write-after-finalization checkpoint.

Verify the entire receipt-owned shared catalogue with the existing reference
verifier before accepting a stage, both on creation and replay. It covers 23
parties, 23 locations, 16 products and their 16 profiles; it does not reject extra
independently created references. This reuses the accepted semantics, at the cost
of repeated bounded reads and shared row locks. Checking only used references
would reduce work but require a new subset verification contract and is deferred.
No runtime/free-tier performance promise follows from this decision.

Keep chain intents thin: reference the installed catalogue receipt's identity,
not a copy of its full evidence. Catalogue installation remains an explicit
prerequisite, not an implicit repair side effect of a chain initializer.

## 3. Components and ownership

- A dataset Receiving contract module validates immutable intents, dependency
  identity and strict bounded results. Codec identity is separate from the
  unchanged recipe version.
- A dataset Receiving stage store captures or recovers a chain intent and calls
  the journal's atomic executor. It builds inputs from the recipe and stored
  bindings; callers cannot supply alternative documents, quantities or IDs.
- A canonical verifier compares receipt-owned documents, current Receiving,
  operation acknowledgements, lots and origin against the recipe. It performs
  no business writes or repair.
- A native cross-unit journal reader obtains the shared `references/references`
  stage in the supplied transaction, with the same database, original-owner,
  tenant, definition and header checks as existing readers. It starts no nested
  transaction or pool query and writes no progress. Public readers retain their
  current isolation and denial semantics.

Existing services continue to own document validation, draft creation,
readiness-v4 checks, command-version2 finalization, snapshots, lots, source locks,
operation receipts and audits. The initializer never fabricates those rows using
seed SQL. Read-only native row locking and canonical evidence inspection are
allowed where service getters alone cannot establish the required invariant.

## 4. Immutable intent and bounded result

Each regular unit has exactly one `receiving` intent. Its input binds:

- recipe version/digest and the exact regular chain descriptor;
- dataset ID and the shared reference stage's unit/stage, revision, operation
  key, input digest and result digest;
- a separate Receiving-stage codec identity.

The journal-owned operation key is generated once and reused on restart. Creation
and finalization may use that same key because existing operations are
command-scoped. Request/audit IDs use the stored identity, not a new attempt ID.
Do not derive credentials or business UUIDs from names/TLCs.

The result contains the dependency identity, document-key/ID bindings, owned
root/event/lot identities, ordered line mapping and sufficient immutable service
evidence to verify the finalized state and exact original command receipts.
Root and event may share an ID; `recordIds` is the deterministic deduplicated list
of owned document, root/event and lot IDs, not catalogue IDs. Parsing rejects
duplicates, missing/extra identities, cross-result substitutions, unknown fields
and schema normalization that would silently change stored evidence.

Input and result remain subject to the existing 256 KiB JSON discipline and
canonical digests, including raw-object safety checks before schema traversal.
There is no whole-dataset array, copied shared catalogue, larger journal limit,
second compact header or new receipt table. Exact TypeScript signatures and
module/file boundaries belong in the implementation plan.

## 5. Capture, execution and recovery

1. Check the actual US database, reserved synthetic tenant, original trusted
   owner and fixed processor/time-zone profile through the existing guards.
   Read the installed dataset header and complete shared reference stage. An
   absent or incomplete prerequisite fails; the chain store does not install it.
2. Build the exact chain input and dependency identity. Capture its durable
   intent before business work. A concurrent capture loser rereads the winner
   and accepts it only when semantic input is identical; it reuses the winner's
   operation key. Any changed descriptor/dependency is a conflict.
3. In the guarded atomic stage transaction, reread the shared stage and validate
   its captured identity and catalogue. Out-of-transaction reads are not enough
   to certify execution. Pending chains must have no previously committed
   command receipts for their operation key or conflicting intended documents
   or lot identities. Such rows are conflicts, not adoption candidates. Do not
   reject normal records belonging to other dataset units.
4. Create only the two Receiving documents, bind real catalogue parents, create
   the original draft and obtain current readiness. Require complete readiness;
   finalize using its actual digest/lifecycle/draft values. Keep real service
   clocks and generated event-number year, independent of historic civil dates.
5. Construct and validate the bounded result. Verify canonical state in that
   same transaction, then persist the dataset receipt. Any command, counter,
   audit, operation, verification or receipt error aborts the entire stage.
6. A completed stage runs verification only. It returns the same receipt bytes
   and IDs without updating counters, clocks, audit or journal revision. A lost
   commit acknowledgement is recovered by rereading the stage, not assuming
   the commit failed or generating a new identity.

The durable pending intent may remain after an aborted business transaction;
documents, drafts, lots and receipts from that aborted attempt must not remain.
The supplied commands never retry a failed transaction. Any later retry starts
the entire guarded stage with the same stored intent. Driver failures propagate;
this increment adds no silent loop, timeout relaxation or partial SQL retry.

## 6. Current origin is distinct from historical acknowledgement

For a regular chain, require the owned Receiving root to have its expected
original current finalized revision, no pending amendment, no void and no
supersession. Its event/date/location, source, references, lines, quantities,
lot bindings, immutable snapshot and actual actor/timestamps match the recorded
service evidence and recipe. A pending amendment is drift even if the old
revision remains current. Exact historical command replay alone is insufficient.

Each owned lot retains the expected ID, product, TLC, imported origin,
source/source-lock and active business state. Each has exactly one current
Receiving support entry: the owned root/event/revision and the expected line.
Missing or additional support, a changed current revision, archive, changed
document/parent/profile or foreign substitution stops the stage. Verify the
recorded document and operation/audit provenance, not only row counts or names.

Do not require current stock to equal originally received quantity: valid
downstream use can consume it. Do not compare mutable dependency/basis tokens,
technical modification clocks or transient readiness digests as immutable
business truth. Preserve captured acknowledgements and snapshots byte-for-byte;
compare current lots using an explicit stable-business-field projection. A test
must exercise real downstream use to distinguish legitimate technical changes
from drift, without making downstream orchestration part of this increment.

Correction and orphan units are not accepted by this regular-chain initializer.
Their amendment/void stages need separately reviewed stage-aware verification;
do not generalize regular replay to accept them implicitly.

## 7. Isolation and lock protocol

The journal's mutation transaction remains read committed, with its existing
tenant seed advisory lock, guarded provenance, dataset header and stage locks.
That seed lock serializes initializers; it does not lock public cabinet writers.
Native current readers therefore need explicit protection, not an assumed
repeatable-read snapshot.

For completed-stage verification, acquire the owned Receiving root, relevant
event/revision rows and sorted owned lot locks before business reference locks,
consistent with public Receiving lifecycle/finalization order. Hold them through
verification and commit. These locks protect lifecycle and origin support while
native readers make multiple queries. Never lock a lot and then wait for its
own Receiving root, upgrade a share lock unnecessarily, or lock arbitrary
foreign roots discovered through unexpected support. Unexpected support fails.

Then verify catalogue-owned rows in the existing fixed party/location/product
order and chain documents in deterministic ID order. On fresh application the
new roots/lots are private transaction writes; existing catalogue locks may be
taken before creation. Reuse these held locks for post-apply verification rather
than treating creation as a replay of externally visible records.

The written plan must map this protocol to the exact public writer paths and
every compared mutable row. Actual blocked-writer tests must prove that a
concurrent amend/void, support change or catalogue/document edit cannot pass
between verification and receipt commit. If the existing protocol cannot prove
that, resolve the specific gap before implementation; do not silently change
the journal's isolation or claim general read-committed consistency.

## 8. Error and authorization boundaries

Denied target/provenance, incomplete prerequisites, intent/dependency conflict,
invalid receipt and current-state drift remain distinct internal failures.
Chain failures carry unit/stage identifiers; reference failures retain their
original cause. Do not label every database exception as drift or expose secrets
in diagnostics. Denial must occur before attacker-controlled business input is
interpreted, and verification cannot use another tenant's evidence.

Malformed or forged journal/receipt data, altered dependency identity and
unexpected business rows fail without repair. Existing public role policy,
authorization order, command replay, bounded retry, errors and routes are
unchanged. An internal owner-only initializer is not a new visitor capability.

## 9. Acceptance evidence

Use owned disposable US PostgreSQL fixtures, never the shared base implicitly.
The future plan must cover:

- Pure strict codec tests: exact recipe/dependency identities, safe raw JSON,
  256 KiB boundaries, missing/extra/duplicate/substituted IDs and digest checks.
- Cross-unit reads with tenant, owner, actual database, provenance and header
  rejection, with no nested transaction or business/journal writes.
- Representative April, varied-quantity middle-period and Scenario A chains:
  two service documents, one original finalized root/event, two source-locked
  lots, correct civil dates/UOM/source and bounded stage receipt.
- Exact tenant/actor/action/target/outcome/request-ID and before/after audit
  assertions, exact command receipts, counters and immutable snapshots.
- Actual failures at document, draft, lot, audit, operation, canonical verifier
  and dataset-receipt boundaries; full persisted-row rollback while the pending
  intent survives; fresh external retry and lost-ack recovery.
- Concurrent initialization with one committed result; byte-identical replay
  with no writes; independent extra references and legitimate downstream use
  accepted; amend/void/archive/tampering/extra origin rejected without repair.
- Real lock-contention tests for public writers, deadlock-sensitive order and
  origin support. Configured skips are not database acceptance.
- Preserved Receiving/reference/journal regressions, API build/typecheck/lint,
  scoped formatting and parsed unconditional serial US CI ownership after
  dependency/API builds. Keep the unresolved full API gate visible.

Full 260-chain generation, measured resources, later business stages, artifacts,
viewer/browser and actual runtime/CLI/cloud deployment remain subsequent gates.
Representative tests establish the stage contract, not an installed complete
demo or a measured hosting cost.

## 10. Sources and retained limitations

Design was checked against current `us-dataset-journal.ts`, dataset/reference
contracts and verifier, `us-six-month-chains.ts`, native `us-receiving-store.ts`,
revision readiness/finalization, Receiving basis and the accepted six-month spec.
No local Graphify graph exists in this worktree; no graph/dependency installation
is needed. Unrelated dirty work must be preserved.

Previous configured gates passed, but full API remains nongreen. The pre-existing
generic organization-profile/covered-product mismatch returning 503 and Vite
module-loader warning remain separate uninvestigated/configuration limitations.
This design does not clear those issues, certify remote CI or assert hosted,
backup, operational, physical or regulatory acceptance. Hosting/storage remain
outside RF when a later deployment is explicitly authorized.
