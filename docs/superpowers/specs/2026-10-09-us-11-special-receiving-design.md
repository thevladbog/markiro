# US-11 special Receiving examples

Status: implementation under the owner's explicit continue/approval-question
waiver; separate implementers and independent reviews retained.

## Outcome

Execute the Receiving portion of the approved six-month special examples through
real services. `correction_0001` receives 250 and 400 lb on 2026-06-10, then amends
only its first quantity to 300 lb and finalizes revision 2 before downstream use.
`orphan_0001` receives 200 and 200 lb on 2026-08-10, then voids its original before
downstream use. Its two lots remain active, source-locked and without current
Receiving basis. Preserve the exact existing recipe, reasons, references and TLCs
from `makeUsSixMonthSpecialExamples`, version `us-processor-six-month-v1`, digest,
April–September 2026 and `America/Los_Angeles`.

This is not the corrected chain's Transformation/Cases/Shipping executor, complete
dataset population, Readiness/Plan/Requests artifacts, runtime/CLI/HTTP/browser
or hosting. It creates no downstream rows or new case links. It does not mark
the special unit or dataset complete: later required stages remain pending.

## Transaction and identity

Reuse the existing dataset journal, original-owner/target guards, 256 KiB JSON
limits and native Receiving/document/lot readers and writers. No schema change,
public command change, new runtime setting or regular-chain codec relaxation.
Add dedicated special codecs, executor and canonical verifier alongside regular
executors. The executor exposes original-stage initialize/verify and complete
Receiving-example initialize/verify for `correction` or `orphan` only.

Capture the original `receiving` intent before applying it; real document creation,
draft creation, readiness, finalization and bounded result receipt commit together.
Capture `amend_receiving` or `void_receiving` intent separately; amendment start,
save and finalization, or void, commit with that stage's receipt. A failed later
stage preserves the original stage and the durable pending lifecycle intent.
The caller explicitly reruns after failure; no new automatic retry or wrapping
of infrastructure errors. Journal capture arbitration may recover its existing
precise intent-conflict race exactly as regular executors do.

Each stage uses its own captured operation UUID as request ID and service key;
different commands within that stage reuse the key. It never adopts a matching
document/TLC/root/operation belonging to another stage or preexisting business.
References and predecessor dependencies pin dataset/unit/stage/revision2,
operation/input/result digests. Results retain actual receipts, documents, lot
identities and the post-transition predecessor record for correction. They are
strict, descriptor-safe, bounded owned frozen JSON; caller inputs are not frozen.
Record IDs are canonical, unique and bound to actual owned facts.

## Stage-aware canonical verification

Historical receipts are immutable evidence, not current origin. Verification
checks actual root/revisions, saved inputs, frozen snapshots, operation rows,
exact actor/tenant/action/target/result/request/before/after audit facts, document
ownership, source/product bindings and lot identities through the supplied tx.
Initial receipt bytes never change when lifecycle completion supersedes/voids it.

Before lifecycle completion, original verification requires precisely one current
finalized original and no unexpected pending revision. After a valid owned
lifecycle receipt exists, original verification checks that receipt and the joint
current/history state instead of demanding that the original still be current.
There is no recursive verification between stages. While verifying a candidate
lifecycle receipt before journal persistence, pass that candidate explicitly;
do not mistake its still-pending journal row for lack of completion.

Correction has precisely two revisions: original amended with unchanged frozen
250/400 content, revision2 current finalized 300/400, retained IDs/product/TLC/
source/bindings, exact reason and predecessor linkage. Orphan has one void
revision, current/pending null, unchanged frozen 200/200 content and absent basis
for both retained lots. Reject any additional revision, pending amendment,
unsupported current pointer, missing/mutated audit/operation, forged receipt or
owned-business drift. No adoption, repair, deletion or rewriting of history.

Hold root → revision → sorted affected-lot locks before multi-statement canonical
reads; hold reference/document locks using the established reference verifier.
The journal's read-committed atomic callback must remain protected through commit
against real public mutation. Do not promise arbitrary RC consistency or modify
the journal's isolation/retry policy. Preserve source identity/status/locks but
ignore legitimate technical dependency-token changes. Correction verification
continues to work after genuine downstream consumption. Orphan verification
requires no downstream event/case support; actual downstream consumption from its
lots is rejected. Test the invalid action without persisting a demonstration draft.

For this fixed orphan recipe, support absence includes tenant-scoped
Transformation input/output rows, Shipping items, case-link history and genealogy
edges in either direction, including draft and historical support. Checking only
current finalized consumers is insufficient. These bounded absence probes run
under the existing lot locks for both lifecycle candidates and completed replay.
This is a strict synthetic-example invariant, not a change to public void rules.

## Execution APIs and codecs

`UsDatasetSpecialSeedStore(db)` exposes:

```ts
initializeReceiving(context: UsDatasetContext, kind: UsDatasetSpecialKind):
  Promise<UsDatasetSpecialReceivingResult>;
verifyReceiving(context: UsDatasetContext, kind: UsDatasetSpecialKind):
  Promise<UsDatasetSpecialReceivingResult>;
initialize(context: UsDatasetContext, kind: UsDatasetSpecialKind):
  Promise<UsDatasetSpecialLifecycleResult>;
verify(context: UsDatasetContext, kind: UsDatasetSpecialKind):
  Promise<UsDatasetSpecialLifecycleResult>;
```

Authorize target/owner before inspecting kind. Verify never captures an intent or
writes missing business facts. Initialize requires existing compatible dataset
and completed references, then sequentially initializes original/lifecycle stages.
Completed replay returns exact stored results after canonical verification, with
no new event/lot/audit/document/operation/journal mutation. Missing prerequisites,
conflict and mismatch errors include safe unit/stage context, not credentials.

## Verification and scope

TDD covers strict inputs and result evidence, real two-example history, exact
counts/audits/basis, no-write replay after transitions, hostile kind/tenant/owner
denial, pending intent recovery, actual business/audit/operation/journal SQL
failures, ambiguous acknowledgement, forged and mutated receipt/history,
concurrent initialization and blocked real public mutation. Tests use only owned
random children of the explicit synthetic loopback US fixture, serial worker;
setup acquisition and all work settle before reset/disposal, fail closed on live
prior work, remove only owned failpoints. No fake clocks or SQL success history.

One new exact dedicated fixture-only serial CI owner runs three new suites after
successful domain/API builds. Remove only that owner to restore complete current
predecessor raw bytes/AST. Preserve every prior hash literal, command and setting;
change old preservation filters only to exclude the new owner. Aggregate API
collection remains allowed, with explicit DB skips when not configured.

Only `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, `codex/us-mvp`.
Preserve dirty baseline and index. No stage/commit/push/PR/merge/release/cleanup,
dependency/environment/schema/shared-base writes or archive/design edits.
Retain local evidence; isolated runtime evidence does not certify external
hosting, DNS/TLS, non-RF residency, backups, hardware or regulatory acceptance.

## Alternatives

Public lifecycle calls would escape the atomic journal transaction. Changing the
regular codec to accept special units would alter previously accepted assumptions
and verifiers. Separate narrowly scoped special executors reuse the existing
native boundaries without either change.
