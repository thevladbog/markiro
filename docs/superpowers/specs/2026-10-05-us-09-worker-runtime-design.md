# US-09 — Separate Local Worker Runtime

**Status:** Owner-approved written specification, 2026-10-05. The owner confirmed
the separate-process approach and subsequently approved this written document.
The implementation plan was separately approved; implementation Tasks 1–4 have
independent acceptance. Task 5 local checks are complete; task and final review
acceptance are tracked in the execution ledger and owner handoff. US-09 remains
In progress.

**Purpose:** Run the accepted internal package worker as an explicit, recoverable
local US process. Keep package rendering outside the HTTP process and prepare the
runtime seam needed by the subsequent Requests API and EN/ES cabinet.

Read with the [current US-09 design](2026-10-04-us-09-trace-request-current-design.md),
[durable worker design](2026-10-04-us-09-durable-package-worker-design.md),
[MVP contract](../../us/mvp-contract.md) and
[development isolation](../../us/development-isolation.md).

## Intent and constraints

The owner chose a separate worker from the same backend, without a broker or a
requirement to place API and worker on different machines. The next deliverable
is local runtime integration, not hosted deployment. It must process durable
queued work, recover after a real process restart, and stop without corrupting
accepted checkpoints or publishing through an expired attempt.

Keep changes in `codex/us-mvp` and its existing isolated worktree. Do not enable
production, alter RU composition, start a worker automatically from either API,
provision a bucket, migrate/seed a database on startup, dispatch operational
workflows, or create a release. No commit/push/PR is included in this increment.

## Implementation baseline before this increment

- `UsRequestWorker.runOne()` already claims one eligible run, renews its lease,
  renders from frozen input and atomically publishes verified private objects.
- Lifecycle, checkpoint, publication and cleanup modules already own fencing,
  current initiator authorization, retries and unknown-COMMIT reconciliation.
- There is no perpetual scheduler, executable worker entry, process shutdown
  controller or worker registration in `UsDevelopmentModule`.
- Execution identity is currently constructed through the explicit synthetic
  factory; it is not a production build-identity provider.
- Package storage accepts local development/test configuration only. Plan and
  package adapters never fall back to RU/general `S3_*` configuration.
- Existing API shutdown owns its pool and Plan client. It must not inherit worker
  polling, render work or worker-owned resources as part of this change.

These are implementation observations, not proof of subprocess recovery or
operational hosting readiness.

### Local implementation checkpoint — 2026-10-05

Tasks 1–4 now supply the checked descriptor/factory, serial loop, separate runtime
and compiled entry described below. Independent review accepted their final
source, including the corrected 11-case process matrix passing twice with real
120-second lease recovery, exact stored bytes after SIGKILL before recovery, and
actual forwarded-COMMIT/lost-reply reconciliation. The actual executable has no
test seams; positive process tests run the copied compiled composition in owned
clean build fixtures with disposable PostgreSQL and a parent transport double.
The product checkout remains dirty and its publication entry refuses startup.
Task 5 adds check-only ownership: six new suites pass 93/93 (229.39 seconds), and
38 existing worker/Requests/package/Plan/export suites pass 834/834, zero skips
in both disjoint selections. API typecheck/lint/build and formatting/diff pass.
The complete API with both DB variables unset still has eight primary-environment
setup-failed files, 1,986 passed / 3,259 skipped tests and zero failed assertions;
primary env was not loaded. Task and final review acceptance are tracked in the
execution ledger and owner handoff; these counts describe local checks. None of
this opens Requests HTTP/UI, business readiness or release.

## 1. Process and resource ownership

Add a dedicated compiled worker entry under the API package and explicit local
build/start commands. The entry composes a small `UsRequestWorkerRuntime`; it
does not construct Nest HTTP, Better Auth, AppModule, pg-boss, a RU module, a mail
client or a general business runtime. Starting the API does not start the worker.

The worker owns exactly one US PostgreSQL pool, one optional private Plan reader
client and one private package-storage client. Compose the accepted lifecycle,
checkpoints, publication, cleanup and Plan reader with these resources. One
process has at most one active `runOne()` invocation. Multiple accidentally
started processes remain subject to existing database fences; no singleton flag
or tenant supplied through a CLI becomes authorization.

A future API composition uses the same checked build descriptor but owns its own
pool and read/write services. API routes and that composition are a later slice;
this specification does not expose Requests or add a browser item.

## 2. Local configuration and startup

Validate edition and local configuration before opening clients. Reuse the
existing `loadUsDevelopmentEnv` boundary for this first development-only entry,
including its production refusal, exact synthetic database, loopback services
and forbidden RU integration variables. Requiring the current full example
environment does not mean the worker initializes its auth/mail clients.

Load package and Plan storage only through their existing strict US loaders.
Package fields are explicit `US_REQUEST_PACKAGE_S3_*`; Plan fields remain
`US_PLAN_ARTIFACT_S3_*`. Never derive them from general S3 settings, invent
credentials, create buckets, or weaken the current separation checks. Partial
or invalid optional storage configuration is a sanitized startup failure.

If package storage is absent, explicit worker startup reports the stable
storage-unavailable category once and exits nonzero before claiming a run.
Existing API startup and drafts remain available. Absent Plan storage alone
does not prohibit processing an incomplete run whose frozen Plan is absent;
an unreadable non-null pinned Plan retains its existing per-run failure.

Run a read-only schema preflight for the current request/run/attempt/checkpoint/
object-intent/receipt/cleanup relations. An outdated database fails safely;
startup never migrates, repairs or imports records. Close every owned resource
if composition or preflight fails.

## 3. Build descriptor

The dedicated local worker build produces a fixed, bounded descriptor beside
the compiled entry. It captures the current contract's `apiVersion`, `gitSha`
and `dirty`, plus a descriptor version, dependency-lock digest, relevant renderer
versions and hashes of compiled API/shared-package output and bundled PDF fonts.
The descriptor excludes itself from its output hash set. Build-time generation
may read Git and manifests; worker startup does not read Git, accept an arbitrary
descriptor path, or override identity through ambient version/SHA variables.

The loader validates the strict descriptor, safe fixed relative file paths,
byte limits, exact installed library versions and recorded output hashes before
creating an execution identity. Missing, malformed, stale or mixed output fails
before database claims. Future API preparation must consume the same descriptor;
matching an environment variable is not proof that two processes share a build.

The first runnable publication entry requires `dirty: false`. An uncommitted
product tree cannot be uniquely identified by the existing Git-SHA-plus-dirty
contract. A developer may compile dirty output, but cannot start this publication
entry until an explicitly authorized source commit and rebuild exist. This does
not authorize the implementation agent to commit or push automatically.
Supporting runtime publication from arbitrary dirty source would require a
separate frozen build-identity contract decision.

Create the execution identity through an internal checked-descriptor factory,
retaining the existing explicit synthetic factory for owned tests. Preserve
saved execution digests and their replay behavior; do not rewrite checkpoints.
A checkpoint from another execution identity fails with the existing execution
mismatch semantics. This descriptor is local build-consistency evidence, not a
signed supply-chain attestation, production identity provider or residency claim.

## 4. Polling and recovery

Use one serial asynchronous loop. Await each invocation before scheduling the
next; do not wrap `runOne()` in an overlapping `setInterval` or enqueue messages
in memory. Poll with a one-second delay after an idle or completed iteration;
after an invocation-level infrastructure exception, wait five seconds. These
are polling delays, not changes to persisted per-run retry eligibility.

Keep the accepted policy unchanged: lease 120 seconds, renewal every 30 seconds,
attempt deadline five minutes, three attempts per cycle and persisted retry
delays of 10 then 60 seconds. PostgreSQL time and current authorization remain
authoritative. Startup reconciliation is the existing eligible claim/recovery
path, not a mass reset of processing rows, attempts or counters.

An unresolved transaction does not grant deletion or retry authority. The next
iteration re-enters the existing durable checks. A corrupt queued record retains
the accepted fail-closed/quarantine behavior; the loop cannot repair snapshots,
invent attempts or bypass actor/profile checks to make progress.

Use only existing bounded cleanup associated with the worker invocation.
Global orphan discovery, bucket listing and a new cleanup scheduler are outside
this increment. Durable unresolved cleanup remains visible in stored evidence;
the process must not claim that every historical orphan has been removed.

## 5. Signals and shutdown

Handle SIGINT/SIGTERM once and idempotently: stop scheduling new claims, cancel
the idle wait, then allow the active invocation a 30-second cooperative drain.
An invocation that finishes retains its ordinary committed result. Join renewal
and close owned storage clients and the pool on a settled drain.

If the drain expires while work remains active, terminate the worker process
nonzero; do not close the pool and then leave a detached render/publication
promise running. Do not release a lease, reset a run, mark the attempt successful
or delete objects merely because shutdown was requested. Restart recovery waits
for the persisted lease/deadline rules and reconciles an uncertain publication.

The 30-second drain is not a CPU preemption guarantee: synchronous PDF work can
delay Node signal/timer handlers. A future supervisor must enforce any hard
wall-clock stop externally. Real subprocess tests distinguish cooperative exit
from forced SIGKILL; neither case is described as successful rollback merely
because the process disappeared.

## 6. Diagnostics and isolation

Emit bounded structured lifecycle/result categories and aggregate counts only.
Do not log requester contacts, frozen payloads, SQL, credentials, session values,
lease tokens, object contents or provider errors. Exit codes distinguish ordinary
graceful stop from configuration/preflight/fatal termination failures. Business
failure of one run does not crash the poller or erase its durable outcome.

No HTTP listener, public artifact URL, FDA client, RU bucket, cloud setting,
automatic seed, new dependency or operational workflow is introduced. Extend
only the existing check-only US CI ownership when new tests are implemented.

## 7. Verification and review gates

Each implementation stage has its own executor and independent specification/
quality review, as previously selected by the owner. The implementation plan
must be reviewed separately after this written specification is approved.

Required evidence includes:

- Build/loader refusal for missing or altered descriptors, mixed output, wrong
  edition, production, dirty publication source and library/hash mismatch; no
  runtime Git or version-env substitution.
- Resource ownership and rollback of partial startup; storage-unavailable startup
  cannot claim a run, while existing API/Plan/draft regressions remain unchanged.
- Deterministic loop tests proving no overlap, bounded error delay, no retry-policy
  change, stopped idle waits and no new claims after shutdown.
- Real child-process startup, idle SIGTERM, in-flight drain and forced stop.
- Actual disposable PostgreSQL recovery after killing a worker with a persisted
  attempt: preserve immutable input/checkpoints, avoid duplicate publications,
  reload initiator authorization and retain ambiguous-outcome protection.
- One wall-clock subprocess recovery case exercises the unmodified 120-second
  lease. Other fault-matrix tests may reuse the explicitly labelled test-only
  clock projection; they do not prove wall-clock lease duration.
- Process tests use a test-owned local private object service or explicitly named
  transport double. Report real S3-compatible behavior separately from doubles.
- Focused and package gates, compiled entry/isolation checks, formatting and diff
  review. Missing infrastructure and broad RU environment limitations stay visible.

Real process recovery is not an OS reboot, cloud deploy, backup/restore, hosted
throughput, browser drill or production-data geography check. None is authorized
by approval of this local runtime design.

## Next slices

After accepted runtime implementation: strict Requests HTTP/OpenAPI, bounded
authorized downloads/manual retry, then EN/ES cabinet and the integrated synthetic
browser drill. Their details remain separate spec/plan gates. Hosted storage,
production build identity, infrastructure and release enablement are separately
reviewed work; they are not unlocked by this runtime.
