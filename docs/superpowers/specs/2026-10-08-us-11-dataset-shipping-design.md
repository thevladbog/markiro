# US-11 regular dataset Shipping execution

## Outcome and boundary

Complete one regular chain's `shipping` journal stage using actual US Shipping
commands, with one or two finalized events as prescribed by the unchanged
`us-processor-six-month-v1` recipe. A fresh application writes all documents,
events, operation receipts, lot effects and the stage receipt atomically.
Repeated initialization verifies the saved business evidence and returns the
same result without writes. This is an internal per-chain executor, not a CLI,
runtime route, deployment or full 260-chain population command.

Owner preapproved implementation and waived further approval questions. Preserve
separate implementer and independent review for each stage. No commit, push,
PR, merge, release, cleanup, dependency/environment edits or shared-base seeding.
Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, `codex/us-mvp`.
Reuse installed Node 24/Corepack dependencies. No schema/migration changes.

## Chosen approach

Use the existing journal's captured intent plus `runAtomicStage`, real stores
and the four supplied-transaction Shipping entries. HTTP orchestration would
split commits and is not used. Direct business-table insertion would bypass
authorization, snapshots and audit and is not used. The outer journal mutation
is read committed: explicit operation/root/lot/reference locks and rechecks must
provide the consistency; native RR foundation alone is not proof for this caller.
Keep journal isolation and public Shipping transactions unchanged.

Add a read-only `UsDatasetJournalStore.readHeaderInTransaction(tx, context)` seam
that runs the existing checked transaction-context guard and then the existing
stored-header check. It reads no caller evidence, opens no nested transaction and
uses no pool read. Status proof and preparation use this first, before inspecting
raw evidence or its dataset ID; use the guarded header's ID thereafter.

## Frozen commands and receipt

The existing Shipping input codec and recipe remain unchanged. One journal
operation UUID owns the chain stage. Derive each native Shipping operation UUID
deterministically from that UUID and shipment number, using SHA256 of canonical
JSON `{namespace:"us-dataset-shipping-operation-v1",operationKey,shipmentNo}`,
first32 hex digits, UUID version5/variant bits. Shipment numbers are 1 or2.
Both `shipping.create` and `shipping.finalize` use the same derived UUID within
their independent command namespaces. Request ID is
`dataset-shipping:<journal-operation-uuid>:<shipmentNo>`.

`UsDatasetShippingResult` contains validated `input`, `originLot` (the original
Transformation receipt lot, not a historical stock estimate), `outputLotAfter`
(actual lot response after this application), and ordered `shipments`. Each
shipment retains shipmentNo, operationKey, requestId, two `{key,record}` document
responses, createInput, finalizeInput, created draft and finalized record.
Metadata: carrierReference null; notes `Synthetic six-month demo shipment.`.
Each event has one line for the output lot, exact recipe quantity/UOM/date,
resolved ship-from/recipient, and two recipe documents in their declared order.

The strict bounded result parser validates full native schemas before coherence
checks. It rejects unknown fields, getter/prototype/array/size hazards and
normalization drift, then requires exact input/command/draft/snapshot agreement,
actor/time/root/revision/lifecycle coherence, unique document/event IDs and
operation keys, source/product/TLC consistency and recipe ordering. It derives
only new document/root/event IDs; the existing output lot is not newly owned.
Return owned deep-frozen copies. Readiness digest is retained command evidence,
not reconstructed from later stock. All receipts fit the existing256KiB guard.

## Dependencies, authority and pending ownership

Current actual database/role/synthetic owner/profile authorization precedes
parsing caller indices/evidence. Require completed References, Receiving,
Transformation and Cases stages for the same header/unit; parse their native
receipts and rederive the input identities and output IDs. Verify canonical
upstream business facts and exact synthetic case support/links. No recursive
installation of dependencies or new tenants.

Capture intent durably before application, reconcile a competing capture by
reading its saved intent, and reject any different input. Application rejects
preexisting owned Shipping create/finalize operations or recipe documents;
pending stages cannot adopt manually created writes. Verify-only on pending or
absent stages fails without application. Completed stages always verify actual
rows, not merely journal digests. All driver failures retain original identity
and cause; there is no hidden inner retry, fake store or monkeypatched DB.

## Stock and upstream status compatibility

Fresh application requires known `case` stock, recipe supply and zero preexisting
consumption. Compute each readiness after the preceding shipment's writes in
the same transaction; native finalization remains the authority for overship/UOM.
After all shipments, actual supply/used/remaining must match the recipe forecast.
Reject other current Shipping/Transformation consumption of this output.

Full Shipping changes the output lot's status/revision. Existing upstream
Transformation/Cases replay must allow this precise native effect, not ignore
all status changes. Add one narrowly scoped current-lot proof helper used by the
Transformation verifier's output-lot comparison. Unchanged original identity
keeps its existing strict path. The alternate path requires original active
revision1 → shipped revision2, unchanged remaining origin identity, a captured
canonical Shipping intent for the same dataset/chain/output, its derived native
create/finalize operations and current finalized events, exact recipe lines,
known zero remaining stock, one uncompensated active→shipped status effect owned
by the last recipe shipment and exact successful native status audit identity.
Check tenant/actor/target/request/action/before/after/origin and clocks against
the actual native rows. A journal receipt is not required for this status proof
because fresh verification runs before receipt publication; the proof certifies
only the native status effect, never stage completion or permission to adopt
pending writes. Never rewrite stored origin receipts or return a fake lot.
Before receipt publication, native operations persist the finalize command's
digest and result, not its historical readiness input. Status proof validates
the derived key, command, event, result and digest shape, and recomputes the
create-command digest; it must not reconstruct historical readiness. If the
Shipping receipt exists, bind the finalize digest to its frozen finalize input.
The Shipping executor/verifier always compares the exact finalize-command digest
against its fresh or frozen result before publishing/accepting a stage receipt.
Thus prepublication status proof alone cannot detect a well-formed substitution
of the otherwise immutable finalize digest and never certifies stage completion.
Manual status changes, source/product drift, foreign/missing/compensated effects,
wrong owners, altered events/operations/audits, or extra consumption fail.

## Locking and replay verification

Acquire the dataset mutex/header/stage first. Case operation arbitration and all
known Shipping operation locks precede origin roots and lots. Lock Receiving
root/revisions, Transformation root/revisions and, on replay, receipt-owned
Shipping roots/revisions before the sorted union of lot locks. Fresh Shipping
roots are private inserts in this transaction. Reuse existing verification only
after its required roots/operations are already held, never acquire a previously
unknown root after lots. Retain required catalogue/location/party/document shares
and case support locks to the receipt commit. Document the actual public writer
ordering against current source and exercise relevant races on real PostgreSQL.

The Shipping verifier checks journal identities, upstream/current origin and
case links, exact saved commands/drafts/native results, current root/version/
revision/header/child rows, immutable operations and command digests, document
metadata/issuers, exact audit payloads, stock and owned status effect. Read current
finalized output consumers to reject extras. Void/amended/pending revisions and
manual changes fail rather than being adopted or reconstructed. Historical
readiness is never recalculated from current mutable facts.

## Test and acceptance boundary

TDD and real disposable-US-PostgreSQL fixtures: two-shipment partial chain0
(55→22→33→23→10), full split chain1 (65→26→39→39→0), boundary258 (60→60→0),
special259 (100→100→0); initialize/replay/verify no-write hashes; status-proof
compatibility with upstream replay; rollback after first/second/native/audit/
receipt failure; pending adoption, drift and current owner/tenant denial;
concurrent initializer convergence and actual public writer blocking; caller
retry after original SQL error; runner cancellation cannot outlive disposal.
Create/dispose only invocation-owned children from US_TEST_DATABASE_URL; unset
DATABASE_URL, serial fixture workers, no base migration/reset/population.

New pure input/result suites and new configured seed/verify/lock suites receive
one mandatory isolated check-only CI owner after builds. Preserve old workflow
settings/owners/permissions/services/30-minute budget and all historical pins;
only exclude the new owner when reproducing predecessor hashes. Fresh YAML
mutations prove the intended invariant failures.

Local checks/reviews are not remote CI timing, full-volume DB population,
browser/hardware/printing, provider/backup/deployment or regulatory acceptance.
Known broad API failures and older ordinary Cases timeout causes remain separate
and must not be hidden by focused passes.
