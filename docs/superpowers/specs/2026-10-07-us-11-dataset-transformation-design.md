# US-11 regular dataset Transformation stage

Status: owner-approved written specification (2026-10-07). Its implementation
plan requires separate owner review before execution.

## 1. Intent and scope

Build the next bounded business stage of the six-month synthetic demo for one
reserved US tenant. For each regular chain, consume its actual finalized
Receiving lots and create the recipe's Transformation documents, original
finalized event, output lot and genealogy through native product commands.
The stage and its journal receipt commit together; restart reuses identities,
verifies current owned facts and never repairs or adopts unrelated records.

Preserve `us-processor-six-month-v1`, April through September 2026,
`America/Los_Angeles`, all recipe quantities/UOM/TLCs and Scenario A. This
increment handles regular `chain_0000` through `chain_0259` individually. It
does not run all 260 chains, implement correction/orphan units or populate the
shared base. Cases, Shipping, Plan/Requests artifacts, viewer and deployment
remain subsequent work.

## 2. Existing foundation and approach

The accepted dataset Receiving executor creates two metadata documents, one
original finalized Receiving and two inbound lots per regular chain. Its
canonical verifier checks current origin under root/revision/lot locks, then
catalogue/document locks. The dataset journal owns guarded read-committed stage
transactions and the existing 256 KiB intent/result discipline.

The accepted Transformation foundation now provides native creation, readiness,
finalization and record reads in a supplied transaction. Native commands retain
authorization and product rules but start/commit/retry no transaction of their
own; public methods keep their existing repeatable-read/retry behavior.

Use these native boundaries inside `runAtomicStage`, not public wrappers or seed
SQL. Reuse the existing Receiving/reference canonical verifiers after acquiring
a compatible outer lock set. Public service semantics and journal isolation are
unchanged. Separate business/journal commits permit partial state; changing the
whole journal's isolation expands the compatibility surface. Neither alternative
is selected.

## 3. Components and immutable contracts

- A strict Transformation intent/result codec validates recipe identity,
  prerequisites, ordered mappings and bounded immutable service evidence.
- A regular-chain stage executor captures intent, applies native commands and
  recovers the winning stage on concurrent capture or ambiguous commit.
- A canonical Transformation verifier checks owned current state, original
  command receipts, exact audits and genealogy. It performs no business repair.
- A small internal lock/preflight component coordinates the two owned roots,
  their revision rows and all receipt-bound lots before reused verification.
  Exact module boundaries and signatures belong in the plan.

The intent binds dataset/definition identity, separate stage codec identity,
the exact regular chain descriptor, and identities of both installed reference
and completed same-chain Receiving receipts. Each prerequisite identity includes
dataset, unit/stage, journal revision, operation key, input digest and result
digest. It does not copy their entire result arrays or snapshots into the intent.
The Receiving unit must be this exact regular chain, not another chain with
similar products/TLCs. Cross-unit reference reading remains guarded through the
existing supplied-transaction journal reader.

The bounded result contains those prerequisite identities, two document-key/ID
bindings with actual service responses, original created/finalized Transformation
responses, one output lot response and an ordered input-line mapping to the two
actual Receiving lot IDs. Retain sufficient saved command input/response evidence
to independently verify original operation digests, audit correlation and
immutable snapshots. `recordIds` is the deterministic deduplicated set of newly
owned documents, root/event and output lot; do not claim ownership of prerequisite
lots or catalogue IDs. Root/event may share one ID.

Reject unknown fields, normalization that changes stored evidence, duplicated or
substituted IDs, missing/extra mappings, wrong tenant/unit/dependency, invalid
digests and unsafe raw JSON before schema traversal. Both intent and result stay
within 256 KiB; no whole-dataset array, larger limit, migration or new receipt table.
Receipt schema validity is not proof of current business state.

## 4. Capture and prerequisites

Every call retains the journal's actual-database/current-user, original trusted
owner/provenance, current role, synthetic tenant and fixed processor/timezone
guards before interpreting the requested recipe index. No new visitor capability
or caller-supplied target trust is introduced.

The reference stage and same-chain Receiving stage must exist and be complete.
The executor neither initializes them implicitly nor adopts matching business
rows. Build intent from the installed header/receipt identities and pure recipe;
callers cannot provide replacement quantities, source IDs, document IDs or lots.

Capture intent durably before business work. A simultaneous loser rereads and
accepts only the semantically identical winning intent; its stored operation key
is reused. Reread both prerequisites inside the guarded atomic stage transaction,
match captured identities and verify their actual canonical state. An outside-
transaction prerequisite read cannot certify the business commit.

## 5. Fresh application

1. Acquire and validate the owned Receiving root/revisions and input-lot locks
   before catalogue/document verification, as specified below. Verify its current
   original finalized support and installed catalogue using existing verifiers.
2. Reject already committed Transformation operations for the stored stage key,
   conflicting intended document identities and conflicting processor/output TLC.
   Other regular units and independently created unrelated data remain allowed.
   An operation-only historical result is not a candidate for adoption.
3. Create precisely the recipe's work-order/batch-log metadata documents through
   the native document service, resolving their issuer through installed bindings.
   Use the exact existing document types, labels and civil dates from the recipe.
4. Build the native draft from those actual document IDs and Receiving's ordered
   lot mapping: two `ftl_lot` inputs with exact quantities/UOM, recipe processor,
   reason/notes and one output product/TLC/quantity/UOM. Do not infer mass
   conversion, pairwise allocation or a relation between lb and case beyond the
   actual event lines. Existing services own validation and readiness.
5. Create the original draft; read real readiness and require complete state;
   finalize using the actual saved version/digest. Creation/finalization use the
   captured operation identity with their existing command scopes and digests.
   Service actor/audit/create/finalize clocks remain real; historic event dates
   do not backdate technical timestamps or event-number year.
6. Read the finalized record and actual output lot through native boundaries,
   construct the strict result and verify canonical state in the same transaction.
   Business writes, audits, command results and dataset receipt commit atomically.

New Transformation root/header/output rows in this flow are private uncommitted
writes. Taking their locks after already-held input/catalogue locks is not a
general replay lock-order exception; it is valid only for these private rows.
No hook may make a pre-existing public root masquerade as a fresh application.

## 6. Canonical verification and replay

On completed stages, perform verification only and return the existing receipt
bytes/IDs. No apply, counter allocation, clock/audit update, progress revision
change, repair or regenerated receipt occurs.

Verify reference and Receiving dependency identities and canonical state under
the joint lock protocol. Receiving remains its original current finalized
revision with no pending amendment/void; its two input lots remain the expected
active IDs/products/TLCs/source assignments and exact current support. Existing
Receiving verification already excludes mutable technical tokens and stock.

Require the owned Transformation root to have its expected original current
finalized revision, no pending amendment, supersession or void. Verify saved
header, ordered input/output/document relations, actual frozen snapshot, trusted
actor/times and exact original create/finalize operation records. Verify exact
tenant/actor/action/target/outcome/request-ID and before/after audit evidence,
including documents, output lot and finalization. Recompute command digests from
the independently validated saved command inputs, not just a matching hash count.

Its output lot retains its actual ID, recipe product/TLC, processor source,
Transformation assignment, permanent source lock and active state. Require exact
current origin support from this root/revision/line and no additional current
origin. Genealogy has exactly the two owned directed input→output edges for
this event, each matching its actual lot IDs. Snapshot quantities belong to
event lines, not numeric edge allocations.

Valid later consumption of input/output lots does not constitute drift. Do not
require current stock to equal original received/transformed quantity or compare
mutable dependency/basis versions and technical modification times as immutable
facts. Preserve historical receipts and snapshot bytes. Legitimate future Cases
or Shipping must not invalidate an unchanged originating Transformation merely
by consuming the lot. Archive, changed business identity, origin loss, amendment,
void, altered documents/catalogue or forged/extra support still fail closed.

Correction and orphan recipe units require separate stage-aware verification.
This regular stage does not loosen replay to accept them implicitly.

## 7. Joint lock protocol

The tenant seed advisory lock serializes initializers, not public cabinet writers.
Preserve read-committed journal mutation isolation and protect compared mutable
facts with explicit locks held until receipt commit.

For replay, validate receipt shapes/digests/dependency bindings first. Acquire
only the roots identified by these two owned receipts, scoped by tenant/type:
Receiving root, then Transformation root, with their relevant event/revision
rows. Do not discover and lock arbitrary foreign roots through support/genealogy.
Acquire the deduplicated union of the two inbound IDs and output ID in sorted UUID
order next. Only then call reused Receiving verification and acquire catalogue
and document locks. Existing verifier re-acquisition of already-held root/lot
locks must not introduce a new blocking wait. Native Transformation readers
likewise see their already-held own root/header locks.

For fresh application, the Transformation root/output do not exist. Lock the
owned Receiving root/revisions and input lots first, verify prerequisites, then
create the private new event/output. Post-apply verification reuses held locks
and private rows; do not execute the public replay prelock path as if it owned an
already committed Transformation.

Why prelocking matters: calling the existing Receiving verifier and then locking
an existing Transformation root would hold input lots while waiting for a root
whose public writer may already be waiting for those lots. The proposed replay
order prevents that inversion; it is not an assertion that all combinations of
existing verifiers are safe by default.

The implementation plan must map each compared mutable row and actual public
writer to this protocol, including Receiving/Transformation lifecycle, lot
status/source, product/profile and party/location/document changes. Tests must
observe real blocker PIDs for amendment/void and reference/lot edits in both
relevant schedules, including the root-before-lot deadlock-sensitive case.
Unexpected extra origin is rejected, not followed to lock foreign roots. A gap,
stale acceptance or inversion requires a scoped correction before implementation
acceptance; do not silently change journal isolation or claim broad RC safety.

## 8. Failure, recovery and boundaries

Any document/create/readiness/finalization/lot/audit/operation/verifier/receipt
failure aborts every business-stage write. The separately captured pending
intent may survive and permits a fresh external retry with the same identity.
Native commands retry nothing inside an aborted transaction. Driver failures
propagate, distinct from prerequisite conflict, invalid receipt or current-state
mismatch. Include unit/stage context without raw sensitive input/SQL diagnostics.

After ambiguous commit acknowledgement, reread the existing guarded stage; do
not assume no commit or create a new identity. Concurrent initialize/verify must
converge to one canonical result. Current authorization still applies on replay.

No lifecycle command, user role, public route, shared contract, schema, runtime
registration, auto-seed or cleanup capability is added. Public Receiving and
Transformation isolation, retry, parsing, historical response and errors remain.
No environment/dependency change, stage/commit/push/PR/merge/release, primary
checkout change, archive/design-file edit or shared-base mutation is authorized.
Keep existing dirty work and US release locks; eventual hosted persistence and
infrastructure must remain outside RF, but no hosting is created here.

## 9. Required acceptance

- Strict pure codecs and independent descriptor/dependency/line/ID/digest checks,
  safe raw JSON and 256 KiB boundary tests; no copied prerequisite results.
- Owned disposable US PostgreSQL: April, varied middle-period and unchanged
  Scenario A chains, actual Receiving inputs, two documents, one original
  Transformation/output, two exact genealogy edges and bounded receipt.
- Exact snapshots/operations/audits, tenant/actor/authorization rejection before
  input parsing and foreign dependency/lot/root substitutions.
- Actual failure boundaries for documents, draft, output lot, genealogy, audit,
  operation, verifier and dataset receipt; full rollback while intent survives;
  fresh retry and ambiguous acknowledgement recovery with identical identities.
- One concurrent result, byte-identical write-free replay; real downstream use
  accepted without pinning stock/technical tokens; amendment/pending draft/void/
  archive/tamper/additional support rejected without repair.
- Real lock-contention/inversion-sensitive schedules for public writers,
  combined Receiving/Transformation verification and origin/reference stability.
  Separate naturally produced driver errors from injected SQLSTATE evidence.
- Failure/cancellation before readiness and while actually blocked; synchronous
  cleanup ownership, release gates, drain actual workers, independent cleanup
  attempts, preserve primary errors and prove owned child disposal. Reuse the
  accepted cleanup discipline, not a success-only finally chain.
- Native/reference/Receiving/journal and public Transformation regressions,
  unconditional serial check-only US CI ownership after builds, API static/build
  gates and scoped formatting. Configured skips are not database acceptance.

Run the full API and report its actual failures/skips separately. The preceding
gate was nongreen with eight setup-failed files; only billing's missing auth/
origin variables were established. Retained Vite warning is not silently fixed
or suppressed. No local result proves remote CI or the 30-minute remote budget.
Full-volume generation, measured resources/Request limits, artifacts, viewer/
browser, providers, hosting, backup, deployment and regulatory/physical acceptance
remain unrun subsequent gates.

## 10. Sources

Checked against current dataset journal/contracts, Receiving stage contract,
executor and verifier, pure regular-chain recipe, native Transformation
store/finalization/record/origin/genealogy boundaries and the approved native
foundation spec. The local Graphify graph is absent; no graph/tooling installation
is necessary. Exact files/types/signatures and staged review tasks belong in
the implementation plan after this written specification is approved.
