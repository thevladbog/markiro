# US-11 sequential regular-chain range

Status: implementation scope under the owner's explicit instruction to continue
without approval questions. Existing separate implementer/reviewer method remains.

## Outcome

Add an internal range orchestrator over the accepted References, Receiving,
Transformation, Cases and Shipping stores. This prepares bounded batch execution
of the unchanged six-month recipe; it is not a complete-demo installer.

Use an explicit `{ startIndex, count }`, never a default full-volume run. Integers
must satisfy startIndex0–259, count1–260 and startIndex+count<=260. Unknown fields,
coercion, accessors, symbols, custom prototypes and nonfinite values are rejected
before any installation. Existing 256KiB descriptor-safe JSON validation applies.
Each entry point first reauthorizes the actual database and reserved owner with
`journal.read(context)`, before touching range evidence; absent header is allowed
only to proceed to a valid initialize, never to verify.

## Execution

Sequential awaited calls, not Promise.all, a queue or a whole-range transaction:

1. Guard target, validate/copy/freeze range and derive ascending chain indices.
2. Initialize or verify References once through the actual store.
3. For each index call the same mode on Receiving → Transformation → Cases →
   Shipping; their native current-state checks, locks and bounded transactions
   remain authoritative. Verify never installs absent state.
4. Discard full stage results after each chain; retain only compact summaries.

Every store reauthorizes. The coordinator adds no SQL, store dependency injection,
hidden retry, runtime/module/HTTP/CLI registration, repair or progress table. On
the first failure stop immediately, keep prior committed stages, and propagate
the original thrown value/cause. Best-effort non-destructive `unitKey`/`stage`
annotation follows the existing Shipping pattern; it must not wrap frozen errors
or primitive values. Caller rerun verifies/reuses prior stages and resumes pending
work through the existing journals. No status proof substitutes for completion.

Return an owned frozen bounded summary with datasetId, recipe version/digest,
copied range, state `selected_regular_shipping_verified`, `datasetComplete:false`,
and ordered rows `{ index, unitKey, shipmentCount, shippingResultDigest }` from
actual checked Shipping results. Do not assert all rows share one snapshot: each
stage was checked at its transaction boundary and later writes may invalidate it.
Even a range of260 excludes trace_readiness, corrections/orphans, Plan, Requests,
packages and visitor readiness. No timestamps are invented or backdated.

## Verification and isolation

Pure tests independently pin boundary/index/key behavior and safe caller evidence.
Real disposable PostgreSQL tests cover fresh adjacent chains0/1, ScenarioA259,
whole-table no-write replay, missing/pending verify, initial guard precedence,
invalid-range no writes, failed later-chain Shipping with previous chain preserved,
caller resume, canonical drift stopping before a later chain, original SQL cause,
and concurrent equal calls with both actual workers drained. Use existing real
fixture/ownership helpers, not mocked seed stores or fabricated business rows.

Work only in the existing codex/us-mvp checkout. Preserve unrelated dirty files,
source behavior and old CI pins; no commits/push/PR/merge/release/cleanup, schema,
dependency/environment changes, shared-base population or external artifacts.
DB checks only invocation-owned disposable children of the isolated US loopback
fixture with DATABASE_URL unset and maxWorkers1. Never build during DB workers.

The check-only CI adds one exact unconditional two-suite owner after existing
builds. Preserve the complete predecessor workflow by excluding only that owner;
do not repin historical hashes or increase30-minute budget. Executable parsed-YAML
mutations reject aliases, split/duplicate/conditional/suppressed execution,
fallback/wrong fixture and predecessor drift. Docs distinguish selected-range
execution from measured full-volume generation, runtime and hosting acceptance.
Uniqueness means one dedicated owner and one explicit selection of each suite
across workflow commands, not one total execution: unchanged aggregate API CI
also collects the pure suite through `test/**/*.test.ts`. Its US database suite
requires the separate US fixture variable. Keep generic CI/configuration untouched;
test and document this distinction rather than claiming aggregate exclusivity.

## Alternatives and boundary

A monolithic transaction would defeat bounded progress and hold long-lived locks;
a parallel driver would introduce scheduling/cleanup complexity without a measured
need. Choose the sequential driver. Full260 execution is not part of this increment:
it needs a dedicated measured-volume gate after special examples/artifacts and
orchestration are ready. No provider, hosting, browser or regulatory promise follows.
