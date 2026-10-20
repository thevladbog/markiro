# US-11: owned dataset Request packages

Date: 2026-10-20
Status: implementation basis under the user's standing approval to continue the
agreed MVP without further check-in questions.

## Outcome and boundary

Connect the existing native synthetic Plan adapter and three real Request
packages to `us-processor-six-month-v1`. This is an internal synthetic dataset
adapter, not a new HTTP route, background scheduler, hosting setup or release.
The approved six-month design remains authoritative. Dataset completion remains
false: CLI orchestration, final viewer/browser acceptance and deployment are
separate gates.

The first actual Scenario A run exposed a native prerequisite: Transformation
v1 retains only opaque product/location text and cannot supply 30 required export
KDEs. Complete the separately reviewed
`2026-10-20-us-11-transformation-structured-snapshot-design.md` before continuing
the adapter. It permits a new V2 contract and additive migration for future
finalizations only; it does not permit hydration or rewriting legacy V1 facts.

Keep the recipe and digest unchanged. Requests are exactly:

| Unit                 | Reference               | Owned regular chains              |
| -------------------- | ----------------------- | --------------------------------- |
| `request_scenario_a` | `REQ-2026-APPLE-001`    | `chain_0259`                      |
| `request_april`      | `MUS-REQ-APRIL-001`     | `chain_0000` through `chain_0011` |
| `request_september`  | `MUS-REQ-SEPTEMBER-001` | `chain_0208` through `chain_0219` |

Each package uses native `export_ready` selection with the complete connected
current chain and bounded excluded history. No manually inserted Ready state,
fabricated frozen evidence, truncated selection or copied package bytes.

## Ownership and selection

Accept the existing `UsDatasetContext` and a strict fixed Request unit key only.
Never accept a caller-supplied scope, source projection, Request/run ID, success
callback, artifact evidence or publication receipt.

Require the guarded dataset, trusted original synthetic owner, definition,
reference receipt, native terminal chains and the one owned effective Plan.
Use existing native terminal projection verification for each prescribed chain;
derive TLC filters and expected lot/event/revision identities from those verified
results. Request scope must select exactly that owned complete closure. A same-
tenant unowned lot sharing a TLC, an extra selected event, a missing revision,
foreign source, current drift or a different Plan is a conflict, not a reason to
filter, adopt or repair data.

Native source checks may occur before journal transactions to avoid nested DB
transactions. The journal transaction must capture the actual native Request
snapshot and compare its canonical selection with the verified owned closure.
Persist its semantic digest and compact source bindings. Native Validate and
Prepare must reproduce that digest before they can advance the unit. Immutable
source revisions plus native fresh snapshot comparison close the gap between
preflight and queued-run creation; pending identity is not itself source proof.

Journal JSON stays within the existing 256 KiB limit. Store compact IDs,
digests, command inputs and descriptors, never the full 16 MiB frozen snapshot
or artifact bytes. Strict parsers reject unknown properties and non-canonical
values; replay rechecks native rows, not merely saved receipt equality.

## Request stage

`prepareStageIntent` creates the Request through
`UsRequestStore.createCommandInTransaction` and records its actual generated ID
with pending ownership in the same guarded transaction. The number is the fixed
recipe reference, not an adoption key. An existing unowned row with that number
must fail without acquiring it.

Capture the actual receipt instant once, at creation, and persist the exact
native `receivedAt`/`dueAt` (24 elapsed hours), revision and complete command.
Resume never renews the clock. Do not backdate technical timestamps to the six-
month business window. Use plainly synthetic contact/note content.

Record the Request-stage receipt only after the actual row, owner, dates,
scope and bound native selection are verified. Run the existing Validate API
with the recorded revision for a new pending package; its digest must equal the
owned captured selection. Error/warning findings stop export preparation. Native
informational findings, including exact numeric-lexeme preservation, remain in
the frozen snapshot, report and manifest and are not themselves blockers. This
adapter does not silently acknowledge warnings or bypass blocking findings.

## Atomic queued run

Expose a narrow caller-owned transaction method on `UsRequestPrepareStore`:

```ts
prepareCommandInTransaction(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  requestId: string,
  input: unknown,
  build: UsExportBuildIdentity,
  httpRequestId: string | null = null,
): Promise<typeof schema.traceExportRuns.$inferSelect>
```

Parse the existing strict HTTP Prepare body (expected revision, validation digest,
idempotency key, mode), then delegate to the existing transaction body. Preserve
fresh authorization, US profile, source/Plan capture, replay evidence checks,
limits, locking and success audit. Existing public wrappers keep their retry
and rejection-audit behavior. This method neither opens its own transaction nor
performs artifact I/O. A caller rollback removes its run and audit together.

The package `prepareStageIntent` callback calls that native seam, using the
recorded validation digest, revision, `export_ready` and stable idempotency key.
The actual generated run ID, queued run, native success audit and pending package
identity commit together. No post-crash scan by request number or idempotency key
can substitute for this ownership receipt.

## Worker and artifact verification

Construct the real worker from the existing lifecycle, checkpoint, publication,
cleanup, Plan reader, private artifact store and trusted execution identity.
Inject concrete storage services and execution identity, not a fake worker or
Ready provider. Call only `runScoped({tenantId, runId})` for the owned run.
Never consume unrelated queue work or run a global cleanup sweep.

Provider I/O occurs outside journal locks. Preserve native lease, retry,
checkpoint, execution fingerprint, conditional object intent and publication
protocols. No new retry/sleep loop, timeout increase or budget change. A pending
or retry-scheduled run remains incomplete and can resume through existing policy;
it is not a successful dataset unit.

Ready requires native frozen-run evidence, the expected effective Plan, actual
checkpoint/expectation/publication rows and verified private bytes for every
winning artifact. Reproduce native payloads/package from the frozen run and
saved timing, compare the exact file set, sizes, hashes and manifest, and verify
ZIP contents with the existing archive verifier. Read the private Plan PDF too.
Do not expose private keys or bytes in a journal receipt.

Before committing a package receipt, reread the guarded Request/run/publication
bindings and require equality with the verified evidence. The compact result
contains Request/run identity and immutable artifact descriptors/digests.

Completed `initialize` and `verify` are read-only: no Validate, Prepare replay
audit, worker claim, provider PUT/DELETE, replacement bytes or business repair.
Missing/corrupt objects or native drift fail verification. Concurrent invocations
must converge on the same journal-owned Request and run; only native worker
leases/publication can win artifact creation.

## Composition

Add an artifact-only coordinator that initializes/verifies the owned Plan, then
the three Request units in recipe order. It requires existing native-chain
prerequisites and does not reseed all 260 chains or impersonate a complete CLI.
Return an explicit `datasetComplete: false` artifact-verified result.

Keep the existing Trace/Readiness coordinator and its accepted evidence intact.
A focused integration fixture may seed the 25 distinct required chains and run
all three real packages. This proves actual bounded Request composition; the
unchanged full 260 plus correction/orphan CI gate remains separately required.

## Acceptance

1. Native transaction seam: actual caller rollback/commit and exact audit,
   malformed/stale/cross-tenant/revoked authority denial, stable idempotent replay,
   original Prepare regressions and bounds unchanged.
2. Dataset adapter: strict unit/scope ownership, real native Ready and private
   byte/ZIP verification; creation and queued-run rollback; pending and committed
   reply-loss resume; concurrency; actual source/Plan/Request/run/artifact drift;
   fixed receipt time/deadline; no unrelated queue claim.
3. Composition: one owned marked Plan, exactly the three packages with exact
   recipe selections, unchanged repeat results and zero DB/provider writes on
   completed initialize/verify. Limits and snapshot bounds remain native.
4. New native suites are assigned an explicit prepared-services CI owner and
   actually execute without skips. Static/build/format/isolation and one ordinary
   API run remain separate from native DB proof. Preserve the full Trace and Cases
   gates and all release locks.

All work stays in `codex/us-mvp`; preserve unrelated edits. The controller owns
scoped commits/push, setting and verifying both author and committer to the user's
approved identity. No main/PR/release/deployment or infrastructure policy change.
