# US-11 Receiving lifecycle transaction foundation

Status: implementation scope under the owner's instruction to continue without
approval questions; separate implementer and independent reviewer retained.

## Outcome

Enable the approved correction/orphan demo examples to compose genuine Receiving
amendment, amendment save and void with a dataset receipt in a later caller-owned
transaction. Current original create/readiness/finalize/read seams already exist.
This increment supplies the missing lifecycle seams, not a special-example seed.
It preserves the accepted six-month recipe, all IDs/content semantics and RU.

## Design

Extract each existing SQL body once. Public `executeReceivingLifecycle` and
`saveReceivingAmendment` retain `receivingTransaction` (repeatable read, at most
three attempts including invisible receipt races) and delegate to native bodies.
Export `executeReceivingLifecycleInTransaction` and
`saveReceivingAmendmentInTransaction`. Add `UsReceivingStore.amendInTransaction`,
`voidInTransaction` and `saveAmendmentInTransaction`, all returning the existing
`ReceivingOperationReceiptV2` and accepting `UsMasterDataTransaction` followed by
the unchanged tenant/actor/id/input/requestId arguments.

Native bodies use only that transaction: no pool read, nested transaction, commit
or inner retry. Current QA authorization precedes input parsing and replay.
Preserve operation arbitration, root/revision and sorted-lot locks, downstream
checks, exact digest and receipt bytes, parsed errors, reason handling, frozen
predecessor copying, lot/source identity and audit. Caller owns isolation/locks,
rollback and fresh whole-transaction retry; no read-committed snapshot promise.
Historical replay remains historical acknowledgement, not current origin proof.

Do not introduce a second writer, test hook, dependency injector, error wrapper,
public route, runtime/CLI registration, schema or environment setting. Public
authorization, downstream block and concurrency semantics must not change.

## Real verification

Use actual existing services and an owned disposable US PostgreSQL fixture.
Compose finalized original → native amendment → native save changing only the
first quantity → current readiness → existing native re-finalization. Prove
two retained lot IDs/TLC/product/source/status locks, former revision history,
current quantities and exact native audit/operation facts. Separately compose
native void after real original finalization: lots remain; current basis is absent.
No fabricated lifecycle/history/balance/operation rows or fake clocks.

Outer abort and real SQL failures at amendment/save/void audit and operation
insertion must roll back every persisted row (all public-table hashes). Native
40001 propagates its original cause with one attempt; caller retry after owned
failpoint removal succeeds. Public wrapper retains bounded retries. Test same-key
replay without writes, divergent key content, unchanged save, current QA/tenant
denial before hostile input/replay, stale lifecycle/draft versions, retained-line
identity rejection, downstream void denial and drained equal concurrent commands.
Compare historical replay after current lifecycle changes with live/basis reads.
Run existing public lifecycle/save/finalization/consumer regression suites unchanged.

## CI and scope

One unconditional dedicated fixture-only serial CI owner selects the new suite
explicitly once after successful domain/API builds. Aggregate API collection is
allowed; native cases skip without `US_TEST_DATABASE_URL`. Executable YAML
mutations must reject nonexecution, aliases, duplicates, conditions, ignored or
suppressed failure, unsafe environments and missing/reordered builds. Capture
actual predecessor before editing; remove only this owner to reconstruct complete
bytes/AST. Old pins unchanged; preservation filters exclude only the new owner.
The preceding regular-range contract must also retain its original hash pins.

Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, `codex/us-mvp`.
Preserve inherited dirty work. No commit/push/PR/merge/release/cleanup, dependency,
environment, schema, shared-base population, archive or design-file changes.
DB tests use only invocation-owned children of the exact synthetic loopback US
fixture, DATABASE_URL unset, serial workers; register/drain setup and actual work
before disposal, remove only owned failpoints, never build while DB workers run.

No special-example journal/receipt/verifier, corrected downstream seed, Plan,
Requests/packages, full260 generation, viewer/browser, hosting or external
acceptance is claimed. Full API nongreen/skips and inherited warnings remain
reported separately from focused local checks.

## Alternatives

Calling public lifecycle methods inside an atomic callback would start separate
transactions and break business/receipt rollback. Splitting business and receipt
commits would require a new recovery protocol. Reuse one native body instead;
later special executors retain the existing dataset atomic-stage protocol.
