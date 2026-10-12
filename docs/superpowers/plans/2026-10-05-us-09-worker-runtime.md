# US-09 Separate Local Worker Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task after owner approval. Steps use checkbox (`- [ ]`) syntax for tracking. Preserve the already selected separate implementer and independent-review method.

**Status:** Owner-approved implementation plan, 2026-10-05. The owner confirmed
this written plan; execution uses the already selected separate implementer and
independent-review method. Task acceptance is recorded in this plan's isolated
execution ledger. Tasks 1–4 are independently accepted; Task 5 local checks are
complete. Task and final review acceptance are tracked in the execution ledger
and owner handoff. US-09 remains In progress.

Local Task 5 checkpoint: six new suites pass 93/93 (229.39 seconds); the disjoint
38-file existing worker/Requests/package/Plan/export selection passes 834/834,
zero skips. API typecheck/lint/build and repository formatting/diff pass. The
complete API with both DB variables unset remains non-green: 416 files, eight
primary-environment setup failures, 1,986 passed / 3,259 skipped tests and zero
failed assertions. Dirty real-source publication remains refused; no product
commit, push, HTTP/UI or hosted acceptance is implied.

**Goal:** Run the accepted internal package worker in a separate local US
process, with checked build evidence, serial polling and genuine subprocess
shutdown/recovery verification.

**Architecture:** An explicit compiled entry owns a small worker composition
and its PostgreSQL/private-storage resources. A checked build descriptor feeds
the existing execution identity; a serial loop invokes `runOne()` without
altering its database fencing or retry policy. API startup remains unchanged.

**Tech Stack:** Node 24+, Corepack/repository pnpm 11.22.0, strict TypeScript,
existing Nest build, Zod, Drizzle/PostgreSQL and AWS S3 adapters; Vitest/Node
subprocess tests. No new package or broker.

**Spec:** [Owner-approved worker runtime](../specs/2026-10-05-us-09-worker-runtime-design.md),
with [accepted worker semantics](../specs/2026-10-04-us-09-durable-package-worker-design.md).

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch
  `codex/us-mvp`. Recheck status/HEAD; preserve both inherited specification and
  plan edits. Starting observed HEAD is `f06aaef2b923a7ae902c0fabacfd0c4712c127c3`.
- No stage/commit/push/PR, merge, provisioning, deployment, release, cleanup of
  unrelated work, primary environment access or base/shared database migration.
  Replace skill commit steps with explicit-path diff/evidence checkpoints.
- Read root/scoped instructions and development isolation; Node 24+ and Corepack
  pnpm 11.22.0. Build affected shared dependencies before consumer checks. Do not
  rewrite the lockfile or link another worktree's mutable output/installation.
- The publication entry requires `dirty: false`; compiling dirty development
  output remains possible, but its publication command refuses. Do not commit
  the product merely to make this gate pass. Tests use owned clean build fixtures.
- Reuse `loadUsDevelopmentEnv`; local development/test and exact existing
  loopback configuration only. Keep production/RU/integration rejection intact.
- Explicit `US_REQUEST_PACKAGE_S3_*` and existing `US_PLAN_ARTIFACT_S3_*` only;
  no fallback to general S3, no automatic bucket/credential creation. Missing
  package storage exits nonzero before a claim; existing API remains available.
- No broker, HTTP listener, Nest HTTP/Auth composition, pg-boss, RU provider,
  startup migration/seed or automatic worker start from `main.us.ts`/`main.ts`.
- Preserve lease 120 seconds, renewal every 30 seconds, attempt deadline five
  minutes, three attempts per cycle and persisted retry delays 10/60 seconds.
  Polling delay is one second; invocation infrastructure-error delay five seconds.
- At most one invocation per process. Cooperative drain 30 seconds; no detached
  publication after closing resources and no claim that Node preempts CPU work.
- Cleanup remains the accepted bounded invocation cleanup. No global orphan
  sweep, bucket listing, run/attempt reset or fabricated rollback on process exit.
- Exact actor/profile authorization, durable frozen input/checkpoints, private
  byte verification and unknown-COMMIT reconciliation remain authoritative.
- Requester contacts, payloads, SQL, credentials, tokens, provider errors and
  object contents never enter process diagnostics. Logs contain allowlisted
  lifecycle/result categories and aggregate counters only.
- The owner selected a fresh executor plus independent specification and quality
  review for each stage. Reviewers are read-only. Reopen affected gates if a fix
  changes an earlier interface; final review covers the whole owned increment.

## Review Focus

1. A checked-looking descriptor belongs to different compiled/shared output or
   installed renderers: refuse before DB claims (Task 1/3).
2. Partial startup fails after creating a pool or one storage client: dispose only
   owned resources exactly once, preserving API resources (Task 3).
3. SIGTERM arrives during an idle wait, an active invocation or drain completion:
   stop new claims synchronously; no detached work or double-close (Task 2/4).
4. A killed child leaves persisted processing intent and private bytes: wait for
   actual lease eligibility, preserve checkpoints and publish one winner (Task 4).
5. Recovery's former initiator lost authority, or transaction outcome is unknown:
   no permission bypass, guessed deletion or automatic scope refreeze (Task 4).

## Proposed files and responsibilities

| File                                                                        | Responsibility                                                                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/deployment/us-request-build-descriptor.ts`                    | Strict bounded document, fixed-root file hashing, checked loader and private loaded-object brand; no runtime Git. |
| `apps/api/scripts/build-us-request-worker.mjs`                              | Capture Git/version/lock at build time; emit descriptor after compiled output exists.                             |
| `apps/api/src/modules/traceability/requests/us-request-worker-execution.ts` | Add checked-descriptor identity factory without changing existing synthetic digest/replay.                        |
| `apps/api/src/deployment/us-request-worker-loop.ts`                         | One asynchronous polling loop, interruptible wait and drain result.                                               |
| `apps/api/src/deployment/us-request-worker-runtime.ts`                      | Validate configuration, compose only worker dependencies, preflight schema, own clients/pool.                     |
| `apps/api/src/main.us-request-worker.ts`                                    | Explicit executable, fixed diagnostics/exit codes and signal handling.                                            |
| `apps/api/test/support/us-request-build-fixture.ts`                         | Owned output trees and disposable clean source/build fixtures.                                                    |
| `apps/api/test/support/us-request-worker-process-fixture.ts`                | Owned DB/process/provider-double fixture and race barriers.                                                       |
| `apps/api/test/support/us-request-worker-process-child.mjs`                 | Test-only child importing compiled production composition; trusted fixture injection over IPC.                    |
| `tools/us-development/test/request-worker-entry.smoke.mjs`                  | Actual compiled executable refusal/no-listener checks.                                                            |

New test files and CI/doc ownership are listed in their owning tasks below. Do
not add a parallel source tree or split/refactor accepted lifecycle modules.

## Interface contract between tasks

These are proposed exports to implement, not claims that they already exist.

```ts
type UsRequestBuildTree = "api" | "db" | "domain" | "contracts";
type UsRequestBuildRoots = Readonly<{
  trees: Readonly<Record<UsRequestBuildTree, string>>;
  lockfile: string;
}>;
type UsRequestBuildDocument = Readonly<{
  schemaVersion: 1;
  build: UsExportBuildIdentity;
  lockfileSha256: string;
  libraries: Readonly<{
    "@react-pdf/renderer": "4.6.1";
    "write-excel-file": "4.1.1";
    fflate: "0.8.3";
  }>;
  files: readonly Readonly<{
    tree: UsRequestBuildTree;
    path: string;
    byteSize: number;
    sha256: string;
  }>[];
}>;
type LoadedUsRequestBuildDescriptor = Readonly<{
  document: UsRequestBuildDocument;
  digest: string;
}>;

function captureUsRequestBuildDescriptor(
  build: UsExportBuildIdentity,
  roots: UsRequestBuildRoots,
): Promise<UsRequestBuildDocument>;
function loadUsRequestBuildDescriptor(
  source: NodeJS.ProcessEnv,
  roots?: UsRequestBuildRoots,
): Promise<LoadedUsRequestBuildDescriptor>;
function assertLoadedUsRequestBuildDescriptor(value: LoadedUsRequestBuildDescriptor): void;
function createUsRequestRuntimeExecutionIdentity(
  descriptor: LoadedUsRequestBuildDescriptor,
  source: NodeJS.ProcessEnv,
): UsRequestWorkerExecutionIdentity;

type UsWorkerProcessEvent = Readonly<{
  event: "started" | "result" | "iteration_failed" | "stopping" | "stopped";
  kind?: UsRequestWorkerResult["kind"];
  completedIterations: number;
}>;
type UsWorkerDrainResult = Readonly<{ kind: "graceful" | "force_exit" }>;
type UsRequestWorkerLoopOptions = Readonly<{
  runOne: () => Promise<UsRequestWorkerResult>;
  emit: (event: UsWorkerProcessEvent) => void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;
class UsRequestWorkerLoop {
  constructor(options: UsRequestWorkerLoopOptions);
  run(): Promise<void>;
  stop(): Promise<UsWorkerDrainResult>;
}

type UsRequestWorkerRuntimeDependencies = Readonly<{
  connect?: typeof createDb;
  loadBuild?: typeof loadUsRequestBuildDescriptor;
  packageTransport?: UsRequestPackageArtifactS3Transport;
  planTransport?: UsPlanArtifactS3Transport;
  emit?: (event: UsWorkerProcessEvent) => void;
}>;
type UsRequestWorkerRuntime = Readonly<{
  run(): Promise<void>;
  stop(): Promise<UsWorkerDrainResult>;
}>;
function createUsRequestWorkerRuntime(
  raw: NodeJS.ProcessEnv,
  dependencies?: UsRequestWorkerRuntimeDependencies,
): Promise<UsRequestWorkerRuntime>;
```

Imports for referenced existing types: `UsExportBuildIdentity` from platform
contracts, `UsRequestWorkerExecutionIdentity` from worker-execution,
`UsRequestWorkerResult` from worker, `createDb` from DB, package transport from
package-artifacts and Plan transport from Plan artifacts. Type blocks show
signatures; implementations cannot be empty declaration-only substitutes.

The optional dependencies are trusted in-process test seams; the actual entry
passes none. No environment flag, IPC handler in the production entry, URL
argument or arbitrary descriptor path enables an operator to replace them.

### Task 1: Checked local build descriptor and execution identity

**Files:** Create build-descriptor, build script and build-fixture above; modify
worker-execution and `apps/api/package.json`; create
`apps/api/test/us-request-build-descriptor.test.ts` and
`apps/api/test/us-request-build-command.test.ts`; extend
`apps/api/test/us-request-worker-execution.test.ts`.

**Consumes:** Existing strict build contract, package/report versions and pinned
renderer libraries. **Produces:** All descriptor/identity exports above. Descriptor
path is fixed `apps/api/dist/us-request-build.json`, never runtime-selected.

- [ ] Write RED tests using owned tiny output trees and literal bytes/hashes:
      capture/load a clean descriptor, mutate one compiled file, add/remove a file,
      alter a font, change installed renderer version, supply a bad lock hash,
      truncate JSON, use an unknown tree, absolute/traversing path or symlink.
      Assert startup rejects dirty source and cloned/unbranded loaded objects.

```ts
const loaded = await loadUsRequestBuildDescriptor(localEnv, fixture.roots);
expect(loaded.document.build).toEqual(fixture.cleanBuild);
await fixture.replaceApiBytes("main.us-request-worker.js", Buffer.from("changed"));
await expect(loadUsRequestBuildDescriptor(localEnv, fixture.roots)).rejects.toThrow();
expect(() => createUsRequestRuntimeExecutionIdentity({ ...loaded }, localEnv)).toThrow();
```

`fixture` is produced by the new build-fixture helper: owned roots, strict clean
build tuple, explicit renderer package metadata and file-replacement operation.
Capture expected literal hash independently with Node crypto; do not compare
the loader against its own capture output as the only tamper assertion.

- [ ] Run RED:

```sh
corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/us-request-build-descriptor.test.ts test/us-request-build-command.test.ts test/us-request-worker-execution.test.ts --maxWorkers=1
```

- [ ] Implement strict validation and canonical sorted capture. Bounds: document
      1 MiB, 10,000 files, 32 MiB per file and 256 MiB cumulative hashed bytes.
      Include complete sorted output inventories and fonts; exclude only the
      descriptor itself. Reject symlinks, duplicate/noncanonical paths and unexpected
      inventory differences. Production defaults resolve the four fixed workspace
      dist roots and root lockfile relative to the compiled loader; test roots are
      supplied only through its trusted parameter.
- [ ] Implement a private WeakSet brand for loaded objects; only successful
      validation creates one. The runtime identity factory checks the brand and
      delegates to the existing synthetic identity construction under the same
      explicit US/local environment. Keep its existing digest and old replay tests
      unchanged. No Git/library/lock re-reading in the identity factory itself.
- [ ] Implement the build script: read API version, exact 40-character Git HEAD
      and tracked plus nonignored untracked status at build time; capture compiled
      output and write the fixed generated descriptor. Exclude no dirty product file.
      Do not edit generated dist manually or commit it. Add only these scripts:

```json
{
  "build:us-request-worker": "nest build && node scripts/build-us-request-worker.mjs",
  "start:us-request-worker": "node dist/main.us-request-worker.js"
}
```

Existing `build`, `start`, `start:us` and RU commands stay unchanged. Dedicated
build captures dirty output truthfully; loader refuses its publication use.

- [ ] Test the actual build script in a fixture-owned clean Git/output tree and
      again after an untracked input appears. No user repository commit or Git config
      mutation. Verify no version/SHA environment substitution and no source secrets.
- [ ] Run GREEN, API typecheck/lint/build and focused formatting. Independent
      specification review first, quality review second; record exact diff/hashes.

### Task 2: Serial polling and cooperative shutdown controller

**Files:** Create loop module above and
`apps/api/test/us-request-worker-loop.test.ts`.

**Consumes:** Accepted `UsRequestWorkerResult`; no database or storage changes.
**Produces:** Loop/options/event/drain exports above. `run()` is its lifetime
promise; `stop()` synchronously inhibits new claims before its first await.

- [ ] Write RED using a deferred invocation, injected wait and fake timers.
      Prove active invocations never exceed one, result emission leaks no scope,
      idle/ready/failed outcomes schedule 1,000 ms, a thrown infrastructure operation
      schedules 5,000 ms, and neither delay changes any persisted retry field.

```ts
const active = Promise.withResolvers<UsRequestWorkerResult>();
let calls = 0;
const loop = new UsRequestWorkerLoop({
  runOne: () => {
    calls++;
    return active.promise;
  },
  emit: () => {},
});
const running = loop.run();
expect(calls).toBe(1);
const stopping = loop.stop();
active.resolve({ kind: "idle" });
await expect(stopping).resolves.toEqual({ kind: "graceful" });
await running;
expect(calls).toBe(1);
```

- [ ] Run RED with the focused loop file. Implement one awaited iteration,
      interruptible `AbortSignal` wait and idempotent shared stop promise. Repeated
      `run()` cannot start a second loop. Catch per-iteration failures and emit only
      fixed categories; an emitter failure cannot print the caught exception.
- [ ] Test stop-before-run, stop while waiting, repeated stop, stop while resolving
      a run and 30,000-ms drain expiry. Expiry returns `force_exit`, not a fabricated
      settled invocation. Do not abort/reset a core lease or call cleanup in this loop.
- [ ] Implement drain with a separate timer and cancel it on settled completion.
      A late completed invocation cannot restart polling. Process termination belongs
      to the entry (Task 3), not `process.exit` in this testable helper.
- [ ] Run GREEN, typecheck/lint/build, focused formatting and independent reviews.
      Review fake-timer assertions as scheduler proof, not PostgreSQL time proof.

### Task 3: Resource-owning worker composition and executable

**Files:** Create worker-runtime and entry above; create
`apps/api/test/us-request-worker-runtime.test.ts`,
`apps/api/test/us-request-worker-runtime.e2e.test.ts` and compiled entry smoke
above; modify only the optional package-storage inventory comments in
`deploy/us-development/local.env.example` (never a user's env file).

**Consumes:** Task 1 descriptor identity and Task 2 loop. **Produces:** Factory,
runtime/dependency types above and compiled `dist/main.us-request-worker.js`.
Pool options: max 2, connection timeout 2,000 ms, statement timeout 15,000 ms;
core transaction-local statement/lock limits remain unchanged.

- [ ] Write RED: wrong edition/production, invalid package/Plan settings, absent
      package storage, descriptor failure and partial startup failure. Assert exact
      owned disposal, no connection/claim before configuration/build checks, and no
      initialized HTTP/Auth/RU service. Tests import the real accepted core factories.

```ts
let connected = false;
await expect(
  createUsRequestWorkerRuntime(missingPackageStorage, {
    connect: () => {
      connected = true;
      throw new Error("unexpected DB open");
    },
  }),
).rejects.toThrow();
expect(connected).toBe(false);
```

`missingPackageStorage` is a complete synthetic example with all six package
fields absent. Use `parseEnv` on the tracked example and explicit synthetic
values, not primary process environment or `.env` loading.

- [ ] Implement startup order: local environment → strict package/Plan config →
      checked descriptor/identity → owned pool/clients → read-only schema preflight →
      accepted service composition → loop. Construct only `UsPlanArtifactStore`,
      `UsRequestPackageArtifactStore`, `UsRequestPlanReader`, worker lifecycle,
      checkpoints, publication, cleanup and `UsRequestWorker`. No `UsRuntime`/Auth.
- [ ] Preflight selects required columns with LIMIT 0 from the current request,
      run, attempt, checkpoint, object-intent, artifact, retry-receipt and cleanup
      relations. Derive exact table/column names from current DB schema/migration0140,
      not a guessed old model. A missing relation/column fails safely, with no writes.
- [ ] On a settled loop stop, destroy owned clients and await pool end once.
      On `force_exit`, return that outcome without pool closure beneath detached
      work. On startup failure, unwind partial ownership. Report no provider/SQL error.
- [ ] Implement entry with a strict zero-argument command, fixed diagnostic
      categories, SIGINT/SIGTERM and explicit exit codes: 0 graceful, 2 unavailable
      package storage, 1 other refusal/fatal/forced termination. Repeated signals join
      the same stop operation. `force_exit` calls process termination, not exitCode
      alone. Rejected lifetime/startup promises must be handled without stack dumps.
- [ ] Run actual compiled entry refusal smoke for production/RU/missing fields,
      dirty/malformed manifest and unwanted arguments. Assert no HTTP listener, no
      raw configured strings in stdout/stderr and unchanged existing API smoke tests.
- [ ] Run E2E composition/preflight against a fixture-owned US DB via trusted
      connect injection. Production entry still accepts only the exact local base
      configuration; no public test URL escape hatch. Regressions cover absent Plan
      storage with a genuinely absent frozen Plan and per-run failure for a pinned one.
- [ ] Run focused GREEN and existing deployment/US/Plan regressions, API package
      typecheck/lint/build and independent reviews. Do not edit API registration or
      business-readiness responses to obtain a green worker result.

### Task 4: Genuine subprocess recovery and signal matrix

**Files:** Create both process support files above and
`apps/api/test/us-request-worker-process.e2e.test.ts`. Read existing profile,
worker, package and storage fixtures; do not weaken their assertions.

**Consumes:** Compiled Task 3 composition and strict Task 1 loader. **Produces:**
real-process evidence and these test-helper exports (test-only):

```ts
type WorkerProcessFixture = {
  spawn(): Promise<{
    pid: number;
    signal(value: "SIGTERM" | "SIGINT" | "SIGKILL"): void;
    exited: Promise<{ code: number | null; signal: string | null }>;
    output(): string;
  }>;
  holdNextUpload(): Promise<{ entered: Promise<void>; release(): void }>;
  seedRun(
    mode: "export_ready" | "available_records_incomplete",
  ): Promise<{ tenantId: string; actorId: string; runId: string }>;
  waitForReady(runId: string): Promise<void>;
  readEvidence(runId: string): Promise<{
    frozenInput: unknown;
    checkpoint: unknown;
    attemptCount: number;
    successfulPublications: number;
    artifactHashes: readonly string[];
  }>;
  close(): Promise<void>;
};
```

- [ ] Build the fixture before recovery assertions: `createUsProfileTestDatabase`
      creates/migrates only its random owned DB. Prepare runs with real receiving
      seed/finalization, `UsRequestStore`, validation and preparation using the
      loaded fixture build tuple. Reuse Plan seed/approval where a Plan is present.
      Never update frozen rows, checkpoint data, lease expiry or machine clocks.
- [ ] Build a parent-owned byte provider double that survives child exits. Child
      uses typed storage transports communicating with that provider through bounded
      IPC; preserve exact bucket/key/conditional-PUT/hash/stream behavior from the
      existing fixture. Explicitly label this a provider double, not real MinIO/S3.
      IPC cancels orphaned pending requests after child death and never logs payloads.
- [ ] The test-only child imports compiled production composition. Parent supplies
      a fixture URL/checked build roots/transports through trusted test dependencies;
      child validates that URL matches its allocated random database. Its raw runtime
      env is the synthetic local example, not a loosened production URL policy.
      Keep all IPC dependency injection out of `main.us-request-worker.ts`.
- [ ] Run RED with real child startup, settled idle SIGTERM, in-flight completion
      during drain, repeated signals and forced SIGKILL. Assert actual PID change,
      exit reason, stopped claims and absence of private requester/lease data in logs.
- [ ] Real lease test: hold a provider upload only after observing a durable
      checkpoint/attempt, SIGKILL child A, await its actual exit, start child B while
      lease remains live and prove it has not claimed. Wait for PostgreSQL time to
      pass the recorded expiry, then release the barrier and observe recovery. Allow
      180 seconds for this one test because the unchanged lease is 120 seconds;
      record the measured duration and cause rather than increasing a default timeout.

```ts
const scope = await fixture.seedRun("available_records_incomplete");
const hold = await fixture.holdNextUpload();
const first = await fixture.spawn();
await hold.entered;
const before = await fixture.readEvidence(scope.runId);
first.signal("SIGKILL");
expect((await first.exited).signal).toBe("SIGKILL");
const second = await fixture.spawn();
await fixture.waitForReady(scope.runId);
const after = await fixture.readEvidence(scope.runId);
expect(after.frozenInput).toEqual(before.frozenInput);
expect(after.checkpoint).toEqual(before.checkpoint);
expect(after.attemptCount).toBe(2);
expect(after.successfulPublications).toBe(1);
second.signal("SIGTERM");
expect(await second.exited).toEqual({ code: 0, signal: null });
hold.release();
```

The upload hold is one-shot and scoped to child A; a dead child's blocked call
cannot block child B. `waitForReady` polls a bounded real DB deadline, not a
projected clock. Read actual winning objects and recompute every recorded hash.
Successful publication audit is `traceability.request.worker.published`; assert
exact tenant/original actor/run/revision/mode/digests, not only row count.

- [ ] Add authority-revocation and ambiguous-publication cases with real DB
      barriers and actual forwarded COMMIT/reply-loss seams from the accepted fixture.
      Label projected-clock cases separately. Verify no guessed deletion, no changed
      frozen input and no referenced winning object removed; do not claim global
      historical-orphan cleanup.
- [ ] Run the process matrix twice with clean owned state. Always stop/reap children
      before dropping their allocated DB, close IPC/provider handles and remove only
      invocation-owned temporary fixture files. Report direct CLI refusal separately
      from injected-composition child recovery; no successful base-DB startup claim.
- [ ] Independent reviews inspect real PID/exit evidence, real lease observation,
      private byte persistence, exact audit and proof categories. Fixtures never grant
      production runtime permission, reset the base DB or rewrite durable clocks.

### Task 5: Check-only CI ownership, regressions and final integration review

**Files:** Modify `.github/workflows/us-development.yml`,
`tools/us-development/test/isolation.test.mjs`,
`docs/us/development-isolation.md`, `docs/us/implementation-plan.md`, this plan
and its specification only for accurate scope/verification checkpoints. Inspect
`tools/ci/affected.mjs`; modify only if current selection demonstrably misses
an owned path. No operational workflow or new secret/service.

**Consumes:** Accepted Tasks 1–4 and exact per-task evidence. **Produces:** Honest
accepted local checkpoint, with runtime/HTTP/UI/hosting distinctions retained.

- [ ] Add RED isolation ownership for new descriptor/build/loop/composition/process
      tests and direct compiled-entry smoke. Require shared builds before consumers,
      explicit US URL and `--maxWorkers=1` for DB/process suites. No ignored failure,
      public artifact upload, conditional ownership skip or general `DATABASE_URL`.

```js
for (const file of [
  "us-request-build-descriptor.test.ts",
  "us-request-build-command.test.ts",
  "us-request-worker-loop.test.ts",
  "us-request-worker-runtime.test.ts",
  "us-request-worker-runtime.e2e.test.ts",
  "us-request-worker-process.e2e.test.ts",
])
  assert.ok(workflowText.includes(file));
assert.ok(workflowText.includes("request-worker-entry.smoke.mjs"));
```

- [ ] Extend the existing US check job only after RED. Do not raise its 30-minute
      default as a precaution: last verified green run 37258619533 took 22 min 46 s.
      Measure new owned steps including the real 120-second lease test. If the job
      demonstrably exceeds budget, scope a separate CI scheduling change; no weakened
      coverage, accelerated production lease or blanket timeout increase.
- [ ] Build dependencies directly with repository-pinned pnpm:

```sh
corepack pnpm@11.22.0 --filter @markiro/db build
corepack pnpm@11.22.0 --filter @markiro/domain build
corepack pnpm@11.22.0 --filter @markiro/platform-contracts build
corepack pnpm@11.22.0 --filter @markiro/api build
```

- [ ] Run the six new focused API files with the explicit synthetic US URL and
      serial selection, existing eleven worker suites, request/package/Plan regression
      selection, API typecheck/lint/build and the package command. Never copy primary
      env to hide broad suite setup failures; state exact failed files and skips.

```sh
env -u DATABASE_URL US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/us-request-build-descriptor.test.ts test/us-request-build-command.test.ts test/us-request-worker-loop.test.ts test/us-request-worker-runtime.test.ts test/us-request-worker-runtime.e2e.test.ts test/us-request-worker-process.e2e.test.ts --maxWorkers=1
env -u DATABASE_URL -u US_TEST_DATABASE_URL corepack pnpm@11.22.0 --filter @markiro/api test
corepack pnpm@11.22.0 --filter @markiro/api typecheck
corepack pnpm@11.22.0 --filter @markiro/api lint
corepack pnpm@11.22.0 --filter @markiro/api build
node --test tools/us-development/test/request-worker-entry.smoke.mjs tools/us-development/test/runtime-entry.smoke.mjs tools/us-development/test/isolation.test.mjs
node tools/us-development/check-isolation.mjs
corepack pnpm@11.22.0 format:check
git diff --check
```

The smoke fixture supplies intentionally valid/invalid owned descriptors; the
dirty real checkout is not silently treated as a committed publication build.
Actual new remote CI is unavailable without separately authorized push.

- [ ] Record automated, subprocess, direct executable, provider-double and any
      manual checks separately. Do not sum overlapping invocations. No browser,
      real MinIO/cloud storage, base schema migration, OS reboot, Excel, backup/restore,
      production build attestation, hosted residency or release acceptance is implied.
- [ ] Review the complete owned diff and source hashes, then obtain final
      independent whole-increment review after task gates. Preserve runtime/API
      isolation and existing execution digest compatibility. Update status only with
      real evidence; Requests HTTP/UI and hosted publication remain future work.
- [ ] Hand off without stage/commit/push/PR. The manual clean-source publication
      command remains blocked in a dirty checkout until the owner explicitly
      authorizes a source commit and rebuild. Testing through owned clean fixtures
      does not waive that operator gate.

## Controller self-review before owner handoff

Specification sections 1–2 map to Task 3; section 3 to Task 1; sections 4–5 to
Tasks 2/4; sections 6–7 to Tasks 3–5. All five Review Focus conditions have
explicit negative tests in their owning tasks. Cross-task names/types agree with
the Interface contract; test-only producer helpers remain outside production.
There is no required schema/dependency/RU/API-controller change. The next action
is owner review of this written plan, not implementation or a Git operation.
