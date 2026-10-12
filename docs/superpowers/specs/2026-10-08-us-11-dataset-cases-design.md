# US-11 regular dataset Cases stage

Status: written specification approved by the owner, 2026-10-08. The owner
approved the conversational architecture: an internal guarded `demo_seed` path
over existing case rules, bounded atomic support/link/receipt composition and
current-state verification on repetition and subsequently approved this written
specification. Implementation-plan approval remains a separate gate. No product
implementation is claimed here.

## 1. Outcome and scope

Advance the single synthetic processor demo toward six months of coherent history
that visitors can inspect through the existing EN/ES cabinet. Apply and verify
the Cases stage of one regular chain from `us-processor-six-month-v1` at a time.
Preserve the pinned April–September 2026 recipe, Los Angeles business timezone,
260 regular chains, 15,640 regular boxes and unchanged Scenario A at index259.
The later corrected chain contributes the additional 60 boxes toward 15,700;
this increment does not implement that special chain.

Each chain already has installed shared references, current Receiving and current
Transformation. Use its actual finalized output lot and exact recipe SSCC set.
Create no additional event, lot, genealogy, quantity conversion or stock write.
Case links do not allocate Transformation quantities to individual physical units.

Work only in the existing `codex/us-mvp` worktree. Preserve accepted dirty work
and operational-workflow locks. No staging, commit, push, merge, release,
environment/dependency changes, shared-base population, unrelated cleanup,
archive/design-file changes or external resources. Hosted storage/infrastructure
remain outside RF; this increment creates none.

## 2. Current boundaries and selected approach

The accepted manual native seam composes case rules in a supplied transaction.
Its public wrapper retains repeatable read, bounded retries, commandVersion1
digests, strict request schema and historical receipt semantics. Synthetic box
provenance is independent of the manual link source. The existing database and
response contracts already admit `demo_seed`, but no guarded runtime writer
currently implements that mode.

The dataset journal composes apply, mandatory verification and bounded receipt
persistence in a guarded read-committed transaction. The journal advisory lock
serializes dataset initialization, not public case or lifecycle writers.
The existing Transformation verifier coordinates both prerequisite roots before
the affected lot union; calling it after an unarbitrated case operation would
create an operation/lot inversion risk.

Selected: one internal guarded demo command sharing existing service business
rules, plus focused Cases contract, support, locking, verifier and executor
modules. A manual-source seed would misdescribe the generating action. A separate
SQL link writer would duplicate validation/audit rules. Neither is selected.
Native persistence is allowed only for minimal seed-owned support rows/markers;
links, dependency writes, case audit and command receipt remain service-owned.

## 3. Guarded service mode and public compatibility

Do not add an optional client-selectable source flag to the public command.
Keep the existing public and native manual signatures and schemas unchanged.
Introduce a separate internal supplied-transaction entry which requires trusted
dataset context and exact captured stage identity. It opens no transaction,
does no independent pool read, no commit and no inner retry.

Before interpreting business input or replaying a demo operation, reload current
case capability and verify actual database/user, original reserved owner and
provisioning provenance, current owner/QA authority, processor profile/timezone,
installed recipe header and canonical pending/completed Cases intent in the SAME
transaction. Derive tenant, actor, dataset ID, unit, operation key, output lot and
SSCC set from those checked bindings, not a source selector or caller assertion.
Every requested box must have the exact marker for this dataset and be owned by
this captured unit's support binding. Existence of any synthetic marker is not
sufficient. Guard and current-state checks also apply to demo-operation replay.

Use a distinct demo command digest envelope: commandVersion2, command `case.link`,
source `demo_seed`, lot ID, canonical sorted SSCCs, dataset ID, recipe version/
digest, unit key and Cases intent digest. Keep the existing operation table/key
namespace; a key collision with manual or another seed identity conflicts.
Never fall back to commandVersion1, relabel a manual link or adopt an existing
same-lot manual/demo link. The first pending stage must create the entire set;
an unexpected preexisting link or operation is a conflict, not successful adoption.

Links carry `linkSource: demo_seed`. Preserve the existing result shape, SSCC
validation, 1–100 distinct-box bound, tenant eligibility, disassembled denial,
active-link uniqueness and current Transformation origin rules. Preserve exact
public manual digest, replay bytes, audit payload, retry classification and
denial precedence. Demo audit adds explicit dataset/recipe/unit/intent identity
and records source `demo_seed`, actual actor/time/request correlation, full result
and exact before/after facts. No source or synthetic option is accepted over HTTP.
Public unlink/list/lookup remain unchanged and can inspect or unlink these rows.

## 4. Durable intent and minimal support

Capture a strict bounded `cases` intent before business mutation. Bind the exact
unchanged recipe/regular index, shared-reference, Receiving and Transformation
stage identities and digests, actual output lot, ordered SSCC set, operation key
and support identities. Use the same canonical codec discipline as other stages:
strict keys, data-only JSON, unique UUID/SSCC bindings and 256 KiB input/result
bounds. Do not store a whole-dataset array or duplicate all upstream receipts.
Generated support UUIDs/device IDs are captured once and reused after failure.
Concurrent capture losers read and use the winning canonical intent, never their
discarded candidate identities. Pure recipe/receipt parsing cannot authorize a
write or certify current state.

Per regular chain, create one minimal aggregation-support shift referencing the
actual output product and one box per recipe SSCC. Support is not a completed
factory workflow. Capture the required month-number key from the actual UTC
capture month, and positive sequence `regular index + 1`; preserve those values
on retries. A collision with an unrelated shift/box/device identity/SSCC is a
precise conflict, not lookup-by-number adoption or counter repair. This technical
support numbering does not backdate a production event.

Keep shift status planned, nullable physical relations unset, pallets disabled,
and closure/production/printing/scanning/operator/device-authority facts absent.
Use actual default creation/open instants where the existing schema requires
them; do not overwrite them with recipe business dates. No box items, scan
events, pallet contents, print jobs or physical counters are generated.

Use the existing synthetic-marker table with `seedId` equal to the installed
dataset UUID and `seedVersion: 1` for this Cases marker contract. Recipe version/
digest and unit ownership remain bound in the dataset intent/receipt and audit;
marker version is not a replacement for the recipe identity. Preserve historical
fixture/compact markers and accept none of them as this dataset's owned support.
No shared-table schema change or migration is expected; a demonstrated constraint
gap requires scope review rather than silently changing shared box semantics.

## 5. Lock protocol and atomic application

All first application and completed verification use the journal's guarded
transaction, retaining its actual isolation. Establish the following explicit
protocol; arbitrary read-committed composition is not certified:

1. Acquire existing journal/target authorization and header/stage locks; validate
   prerequisite identities without acquiring origin lots or box locks.
2. Arbitrate the exact Cases `case.link` operation BEFORE any output/input lot
   lock or prerequisite verifier which locks lots. A stored operation must be
   bound to a completed canonical Cases receipt; unexpected pending-operation
   presence stops without adoption.
3. Lock the receipt-owned Receiving and Transformation roots and their revision
   rows before the sorted union of inbound/output lots, using the existing
   Transformation coordination order. Validate current prerequisite business
   state under those locks; keep required catalogue/document locks before boxes.
4. For first application, insert private support/markers after freshness and
   prerequisite checks. For replay, lock exact existing owned support rows and
   boxes in an order compatible with public lot→sorted-box operations. Box locks
   remain sorted by SSCC/ID. No root lock may be acquired after an output lot.
5. Invoke the guarded demo command with the SAME transaction and operation key;
   any reentry into held locks is reentrant, not a second transaction. Compose
   service dependency update, links, audit and case operation receipt.
6. Perform mandatory canonical Cases verification, then persist the dataset
   receipt before committing. Post-write verification must not introduce new
   out-of-order public origin locks; prerequisites were already locked.

The case operation lock must also precede prerequisite lots on completed replay.
Public case holders must not wait on a seed-held lot while the seed waits on their
operation key. Public Transformation lifecycle writers retain root→lot order.
The implementation must verify both directions against real writers; if current
helpers violate this protocol, report the concrete dependency and scope it rather
than changing public isolation/order or adding a lock after the fact.

Support, markers, links, dependency update, native audit/operation, verification
and dataset receipt commit atomically. A failed apply, verifier, audit or receipt
rolls all of them back while the separately captured intent survives. Preserve
the original error/cause; annotate only bounded unit/stage identity. No retry in
an aborted transaction. An explicit retry starts the entire stage afresh with
the same captured intent; bounded retry policy belongs to the reviewed caller
plan, not a new global journal behavior.

## 6. Canonical verification and repetition

`initialize` may capture a missing intent; `verify` never creates missing state.
Absent or incomplete prerequisites fail before support writes. Completed
repetition calls verification only, returns the identical receipt and creates
no audit, operation, dependency increment, support row or replacement link.
An ambiguous commit acknowledgement is reconciled through the completed stage
and exact current facts, not guessed from SSCCs or a historical case response.

Verify all prerequisite stage identities/digests and current Receiving/
Transformation facts through existing native service/verifier boundaries.
Verify the exact owned support shift, product, immutable bindings, full expected
box set and markers, SSCC consistency, lack of disassembly/physical facts, exact
active link IDs/lot/source/actor/time, command digest/result and native audit.
The output lot must have the exact expected active link set; additional or
replaced links are drift. Owned boxes must have no unexpected link history or
physical contents. Compare frozen business facts and canonical evidence, not only
counts or a self-reported result digest.

Allow legitimate later Shipping/consumption: current stock and mutable technical
dependency versions are not immutable Cases facts. Preserve original event
snapshots, genealogy, lot IDs/TLC/product/source and receipt bytes. Unrelated
references and boxes outside the owned bindings/output link set do not invalidate
unchanged owned facts. Changed/archived/missing origin, amendment or pending draft,
void, unlink/relink, retargeted support, altered markers, wrong-mode operation or
forged receipt stops with bounded unit/stage failure. No repair or replacement.
Old links may remain publicly visible with origin gap after void, while dataset
verification correctly refuses to certify that chain as current.

## 7. Component and acceptance boundaries

Keep focused responsibilities: strict Cases codecs/identity; guarded shared-rule
command; minimal support persistence; operation-first origin/support locking;
canonical verifier; per-chain journal executor. Exact file names, typed interfaces
and reviewable task boundaries belong in the separately approved written plan.
Do not introduce a runtime import from tests or a second general seed framework.

Acceptance uses only invocation-owned disposable US databases. Cover:

- Strict codec limits, unchanged recipe, representative April/middle/Scenario A
  chains, exact quantities/SSCC counts, and 100-box upper boundary.
- Original-owner/actual-target/current-capability rejection before parsing/replay;
  foreign dataset/unit/box/lot/marker denial; manual↔demo and seed↔seed key clashes;
  strict HTTP rejection of a source selector, with manual regressions unchanged.
- Exact support, synthetic provenance and demo source through public reads,
  full actor/tenant/action/target/result audit, operation/dataset receipts and
  unchanged event/genealogy/physical tables.
- Caller abort and injected support/marker/link/dependency/audit/operation/
  verifier/dataset-receipt failures with exact persisted-table rollback;
  retained intent, restart and lost-acknowledgement recovery without duplicates.
- Completed no-write replay after legitimate downstream use, canonical tamper
  rejection, unlink/relink and void/amendment drift without repair.
- Actual PID-observed concurrent capture/application and public link/unlink,
  lifecycle/lot/reference writes in both directions, including operation-first
  and root-before-lot inversion-sensitive schedules. Distinguish injected
  deadlock/serialization codes from naturally observed contention.
- Real runner cancellation before readiness and while a native waiter is blocked;
  release barriers before actual worker drain, independently close resources,
  preserve the primary error and assert exact owned database disposal. Never
  delete unidentified historical databases or infer cluster cleanliness.
- Unconditional serial check-only CI ownership after shared/API builds, exact
  fixture URL with no primary fallback, executable ownership mutations and
  preservation of every existing owner/command/hash and release lock.
- Fresh scoped/configured API regressions, typecheck/lint/build, US tooling and
  formatting/diff, with skips and warnings explicit. Keep the separate full API
  gate's actual result; its prior eight failing files are not a harmless-baseline
  assertion. No timeout increase or assertion weakening merely to obtain green.

Regular Cases acceptance does not populate all 260 chains or certify the complete
demo. Shipping, correction/orphan orchestration, Plan/Request artifacts, measured
resource/Request limits, CLI/runtime/HTTP initializer registration, viewer/browser,
remote CI, hosting/storage, backup, deployment, physical and regulatory acceptance
remain later gates. Preserve separate implementer and independent stage review
when the written implementation plan is approved.
