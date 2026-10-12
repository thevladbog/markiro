# US-11 Case native transaction foundation

Status: written specification approved by the owner on 2026-10-07.
The implementation plan requires its own review before execution. This approval
does not authorize commit, push, release or shared-base population.

## 1. Intent and sequence

Complete the single-tenant six-month synthetic demo so visitors can explore
coherent event, lot and SSCC history. The next stage after the accepted dataset
Transformation increment is Cases. Preserve the approved recipe and existing
server bridge; Station, scanning, printing and physical production are absent.

The owner approved two separately reviewed subincrements:

1. Compose the existing native case link command inside a caller-owned
   transaction without changing public behavior.
2. Generate one chain's synthetic boxes, provenance and service-owned links,
   verify them and commit their bounded dataset receipt atomically.

This specification covers the first prerequisite only. It provides an internal
transaction seam, not a dataset executor, demo-source mode, populated demo or
completed Cases stage. The second subincrement requires its own design and plan.

## 2. Current evidence and selected approach

`UsCaseStore.link` delegates to `linkCases`, whose body runs inside
`caseTransaction`. The public wrapper uses repeatable read, up to three attempts
and the existing named retry classification. The dataset journal instead owns
a guarded read-committed transaction for atomic business writes and receipts.
Calling the public wrapper from that callback would start an independent
transaction and would not establish stage atomicity.

Extract the existing link body into one supplied-transaction command. Public
`linkCases` delegates to that same body through the unchanged wrapper. Expose
the narrowly typed internal seam through `UsCaseStore`, following the existing
Receiving and Transformation native-entry pattern. Exact names and source/test
file boundaries belong in the separately reviewed implementation plan.

Separate public calls with later recovery introduce partial stage commits;
direct SQL link insertion duplicates service validation and audit behavior.
Neither alternative is selected. Native persistence remains permitted only for
future minimal seed-owned box/shift support, not service-owned case links.

## 3. Native command contract

The native link entry receives the actual supplied transaction, explicit tenant
and actor, lot identifier, existing strict command payload and request ID.
Tenant/actor arguments are trusted context, not permission grants.

Before interpreting the lot/input or returning an operation replay, reload
membership, role/capability and profile through `authorizeUsMasterData` with
`TRANSFORMATION_WRITE`. Preserve current denial order and tenant-scoped queries.

Use the existing SSCC normalization/check digit, distinct batch bounds of 1–100,
same-tenant output-lot and box checks, disassembled denial, active-link
uniqueness, current-origin requirement for newly created links and same-lot
unchanged results. Preserve exact original errors and schemas.

The native entry opens no transaction, performs no independent pool read,
commits nothing and retries nothing. The caller owns commit/rollback and any
fresh whole-transaction retry. Propagate driver errors, including 40001/40P01
and constraint failures, without replacing them with successful replay or
sanitized public exhaustion. Never recover an aborted transaction internally.

The first subincrement retains `linkSource: manual`, including when eligible
boxes already carry synthetic provenance. Provenance describes the box;
linkSource describes how that particular link was created. Do not reinterpret
the current manual command as a demo command or relabel stored links.

## 4. Public compatibility and provenance boundary

Retain public store signatures, HTTP routes, strict request/response contracts,
capabilities, origin/host policy, error shapes, repeatable-read isolation,
three-attempt retry policy and sanitized exhaustion. Preserve commandVersion 1
canonical digest, sorting, operation namespace/key, target, original receipt
bytes and exact audit before/after fields. No new client-selectable source or
synthetic flag is accepted.

Unlink, list and lookup remain unchanged public operations. Do not extract
additional native entry points or change their behavior without an actual
implementation dependency and explicit scope review.

A historical operation replay retains today's existing semantics: it returns
the original receipt after current authorization. It does not certify that the
link is still active or its Transformation origin remains current. The future
dataset verifier must independently compare current canonical state.

The subsequent Cases design must define an internal-only guarded `demo_seed`
path and explicit seed identity in audit metadata, reusing the same service
business rules. It must preserve public manual digest/replay bytes, prevent
cross-mode adoption and establish trusted dataset/owner/marker binding. This
foundation intentionally implements none of that new mode; using its manual
receipt alone does not satisfy demo-seed provenance acceptance.

## 5. Isolation and locking

Preserve the existing command order: authorize and validate; arbitrate the
exact `case.link` operation; lock output lot; lock boxes sorted by SSCC/ID;
verify active links; bump the lot dependency version when creating links;
read current Transformation origin; write links, audit and receipt together.
Do not add a Transformation root lock after holding its output lot.

Preserve coordination with Transformation lifecycle writers through the lot
row and actual dependency-version writes. Public repeatable-read waiters retain
the existing fresh-attempt retry behavior. The supplied-transaction caller must
use repeatable read or an independently verified sufficient explicit lock
protocol; extraction alone does not make arbitrary read-committed composition
safe.

The later dataset design must separately coordinate prerequisite event roots,
lots, case operation arbitration, boxes, provenance and receipts. It must map
both orders of every supported writer, including void/amend and link/unlink.
In particular, a public operation holder must not wait on a lot held by a caller
that subsequently waits on that operation key. A future dataset advisory lock
does not protect against public cabinet writers. Report a demonstrated lock gap
for scoped approval rather than silently changing public isolation or ordering.

## 6. Required acceptance evidence

Use real native services and invocation-owned disposable US PostgreSQL children.
Never migrate, seed, reset or clean the shared base or primary database.

- Write focused failing tests before each new boundary; environmental loopback
  denial is not a valid behavior RED.
- Create minimal synthetic shift/boxes/markers inside a supplied transaction,
  call native manual link and verify visibility of those uncommitted support
  rows, genuine links, dependency changes, operation and exact audit.
- Commit and read through existing public list/lookup contracts; check synthetic
  box provenance separately from manual link source and CTE quantity.
- Throw after native link and verify full rollback of support rows, links,
  operation, audit and lot dependency changes. Preserve existing event snapshots,
  genealogy and lot identities, with no fabricated closure/print/scan facts.
- Inject failures at link, dependency update, audit and operation boundaries;
  prove one native attempt and original error propagation. Distinguish injected
  SQLSTATE evidence from naturally induced concurrency.
- Verify authorization before malformed input, current access reload on replay,
  cross-tenant denial, duplicate/malformed/oversized SSCC batches, missing or
  disassembled boxes, cross-lot conflict, same-lot no-op and changed-key payload.
- Preserve historical replay bytes and exact tenant/actor/action/target/outcome,
  request ID and before/after audit metadata, not only row counts.
- Exercise PID-observed public/native link contention, link/unlink and origin
  void races in both orders. Preserve existing void-origin-gap behavior: old
  links remain visible; new links fail; authorized unlink remains available.
- Preserve existing case commands, concurrency, reads, HTTP and affected
  Transformation lifecycle/current-consumer regressions. Require zero skips
  for selected configured database acceptance.
- Register unconditional serial check-only CI ownership after shared/API builds;
  preserve existing workflow selections, release locks and fixture-only target.
- Run fresh API typecheck/lint/build, US tooling, formatting/diff and scoped
  configured regressions. Run/report the separate full API gate without loading
  primary credentials; baseline failures are not automatically harmless.

Register owned cleanup synchronously, release barriers and drain actual workers
before disposing resources or building shared packages. Failure/cancellation
must not leak owned clients, pools or databases or replace the primary error.
Do not weaken assertions or extend deadlines merely to obtain a green run.

## 7. Scope and evidence limits

Work only in `codex/us-mvp` at the existing US worktree, preserving accepted
dirty work and the empty index. No stage/commit/push/PR/merge/release, dependency
or environment edit, schema migration, shared-base population, runtime/CLI/HTTP
registration, archive or design-file edit is authorized. Generic skill commit
instructions do not override these explicit boundaries.

Keep `us-processor-six-month-v1`, April–September 2026, America/Los_Angeles,
Scenario A and the 256 KiB intent/result bounds unchanged. Later regular Cases
must use the exact per-chain recipe, including its varying counts and the
100-case Scenario A; full recipe totals are not multiplied by 100 per chain.
Real technical timestamps are not backdated to historical business dates.

Dataset Cases/provenance orchestration, Shipping, special examples, Plan/Requests
artifacts, full-volume generation, viewer/browser, provider selection, private
storage, backup and hosting remain subsequent acceptance. Hosted infrastructure
and storage remain outside RF. No physical or regulatory acceptance follows.

The preceding full API gate is nongreen with eight preparation-failed files;
only billing's missing configuration has an established cause. Retain the Vite
warning, unresolved historical timeout evidence and unknown database provenance
without assigning cause or cleaning unrelated resources. No remote CI success
or measured 30-minute budget is asserted. The local Graphify graph is absent;
source inspection is used without installing tooling or rebuilding a graph.
