# US-09 Durable Internal Package Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task after owner approval. Steps use checkbox (`- [ ]`) syntax for tracking. Preserve the owner's separate implementer and independent-review method. Do not execute this plan while its status is awaiting review.

**Status:** Owner-approved implementation plan, 2026-10-04. Tasks 1–8 have independent specification/quality acceptance, including the separately reopened Task 6 v1 fixture correction. The three Important final-review findings were addressed and independently re-reviewed on 2026-10-05; the local increment is accepted with the recorded verification limits. The earlier broad API setup limitations remain. US-09 remains In progress.

**Goal:** Recover and privately publish a verified package from an immutable US request run, without stale-worker publication, unsafe cleanup or runtime exposure.

**Architecture:** The existing isolated US PostgreSQL run is durable intent. A bounded internal worker uses attempt fences, write-once rendering evidence and private attempt-scoped objects, then atomically publishes artifact rows, status and audit. It introduces no broker, polling daemon, application registration or HTTP/UI path.

**Tech Stack:** Node 24+, repository-pinned pnpm through Corepack, strict TypeScript, NestJS exceptions, Drizzle/PostgreSQL, Zod, existing AWS S3 SDK, pinned React PDF and the accepted US package composer. No new dependency or lockfile change.

**Spec:** [Owner-approved durable worker design](../specs/2026-10-04-us-09-durable-package-worker-design.md), with [current US-09](../specs/2026-10-04-us-09-trace-request-current-design.md) and [package core](../specs/2026-10-04-us-09-package-core-design.md).

## Global Constraints

- Existing checkout `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve all inherited dirty work. Starting HEAD observed at planning: `7aca1b70703728cc24d09455d42095aa24eafcf8`; recheck before execution.
- No commit, stage, push, PR, merge, deployment, provisioning, release, shared/base migration, primary environment access or worktree cleanup. Replace skill commit steps with an explicit-path diff/evidence checkpoint.
- Read root AGENTS and `docs/us/development-isolation.md`; consult the available API scoped instructions without importing RU providers. No copying primary `.env`, credentials, volumes or database state.
- Internal invocation handles at most one run. No runtime/controller registration, CLI, startup hook or perpetual polling timer. A bounded renewal helper must stop on every invocation exit.
- “Three automatic attempts means one initial execution plus at most two retries per cycle.” Backoff is 10 seconds then 60 seconds; lifetime `attemptCount` never resets. Lease 120 seconds, renewal no later than every 30 seconds, attempt deadline five minutes.
- PostgreSQL time governs ownership and eligibility. Capture report-data preparation once before PDF rendering; never overwrite frozen snapshots or accepted report context. No false CPU-cancellation guarantee.
- Full package requires v2. Preserve v1 validation/XLSX replay and fail full-package execution with the existing refreeze-required code before private input I/O.
- Original initiator requires current processor profile, `QA_MANAGE` and `EXPORT_READ` before work and publication. Manual retry also requires the caller's current authority; caller does not replace the original initiator.
- US package configuration is optional/all-or-none, US edition and development/test only, existing allowed loopback hosts on port 19000. Reject production, remote storage and configured primary S3 bucket/credential reuse.
- No production build provider is implemented. Synthetic execution stamps are an internal test/development seam, not operational identity or an environment-variable release bypass.
- Limits: workbook/validation 16 MiB each, Plan 8,000,000 bytes, report 4 MiB, model/manifest 1 MiB each, sums 16 KiB, entries total 48 MiB, ZIP 64 MiB, maximum six ZIP entries. Sums stay inside ZIP only; six existing DB artifact kinds suffice.
- Objects are private conditional creates under `us/requests/` with server UUID scope and fixed basenames. Verify actual bounded read-back bytes, not ETag/HEAD alone. Individual storage I/O is bounded to 15 seconds.
- Upload only after complete package verification. Publish artifact set/status/audit atomically. Never close/fulfil a request, upgrade incomplete mode, delete a winner or delete an original Plan.
- Only disposable fixture-owned US child databases are migrated. Use `US_TEST_DATABASE_URL`, never `DATABASE_URL` as a test-resource fallback. Do not start/provision infrastructure as an implicit test step.
- Every task follows RED → minimal GREEN → refactor → focused gates → independent spec/quality review. Never weaken assertions or infer full API/remote/external success from a focused pass.

## Review Focus

These five risks require explicit new tests, not assumptions from package-core coverage:

1. A revocation commits while publication waits for locks: the later publication transaction must deny access (Tasks 5/7).
2. A manual retry receipt is replayed after its cycle has started or failed: return that receipt without creating another cycle or audit (Task 2).
3. An incomplete workbook writer recovers after checkpoint acceptance: do not silently turn the frozen omission into a different package (Tasks 3/7).
4. A provider returns lying length metadata, a truncated/overlong stream or a late response after abort: reject without unbounded allocation or late publication (Tasks 4/6).
5. Database outcome remains unknown after successful object upload: retain objects until a reference/fence check resolves ownership; never infer rollback from a thrown error (Tasks 5/7).

## Execution and baseline

The controller owns integration and the final diff. Each task gets a fresh implementer, then an independent specification review and code-quality review before the next task starts. Reviewers are read-only unless explicitly assigned a fix. Fixes stay with the owning implementer and receive re-review. No proactive parallel edits to schema/lifecycle/contracts.

Before Task 1, record `git status --short`, HEAD, explicit owned paths and hashes of overlapping inherited files in an ignored task evidence directory. Do not stage them. Existing request modules, migration0139 and CI changes are inherited, not this task's clean baseline. Resume from recorded checks rather than repeating accepted package-core work. No local Graphify graph existed during planning; recheck before source work and update only if a local graph exists.

Commands below run from the isolated worktree with Node 24+ and Corepack. Tests requiring PostgreSQL use the already-declared synthetic URL only if the isolated service is available. Missing infrastructure is an explicit limitation, not passing acceptance.

```sh
git status --short
git rev-parse HEAD
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/domain build
corepack pnpm --filter @markiro/platform-contracts build
```

Every new DB-backed API suite uses the existing database fixture below, with a fresh child database per test. A fresh tenant alone is insufficient because `claimNext()` scans the whole isolated queue: a prior test's unfinished queued run must not become the next test's candidate. Declare the indicated imports in each suite; do not rely on another suite's resources. Existing upstream suites keep their own established isolation.

```ts
import { beforeEach, afterEach, describe } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US worker in an owned disposable database", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeEach(async () => {
    if (!url) throw new Error("US_TEST_DATABASE_URL is required");
    f = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterEach(async () => {
    await f?.close();
  });
  // Insert the task's tests inside this suite. Destroy each Plan fixture in finally.
});
```

## File and interface map

All new API source files below live in `apps/api/src/modules/traceability/requests/`. Proposed schema names and public internal interfaces are locked here so task implementers can consume earlier results without renaming their contracts.

| File                                    | Responsibility                                                          | Owning task |
| --------------------------------------- | ----------------------------------------------------------------------- | ----------- |
| `us-request-worker-types.ts`            | Strict scope/lease/checkpoint/object/outcome types and bounded policies | 1           |
| `us-request-worker-failures.ts`         | Finite sanitized classification, no generic transient default           | 2           |
| `us-request-worker-lifecycle.ts`        | Durable claim/renew/recover/retry/read and active-fence assertion       | 2           |
| `us-request-worker-checkpoint.ts`       | Write-once report/package expectations and reproduction checks          | 3           |
| `us-request-package-artifact-config.ts` | Validated synthetic-only configuration authority                        | 4           |
| `us-request-package-artifacts.ts`       | Bounded conditional private byte I/O, no DB lifecycle                   | 4           |
| `us-request-worker-publication.ts`      | Object intent, verified receipts, atomic publication and recovery       | 5           |
| `us-request-worker-cleanup.ts`          | Reference check, permanent fence and retryable bounded cleanup          | 5           |
| `us-request-worker.ts`                  | One-run orchestration and bounded renewal lifetime                      | 6           |
| `us-request-worker-execution.ts`        | Synthetic execution identity validation and pinned versions             | 6           |

Schema additions go in `packages/db/src/schema/traceability-request-worker.ts`, with lifecycle columns added to `traceability-requests.ts`, schema exports/config and new migration0140. No 0140 file existed during planning; if another reviewed migration takes that number before execution, stop and reconcile the next number rather than overwriting it.

Test files and fixtures are assigned in the tasks. Reuse `createUsRequestPackageFixture(db, options)` and `createUsRequestPlanFixture` for real upstream data/Plan bytes. Those fixtures are not a worker or package storage implementation. Keep mutable test transports in the new test support module, not product exports.

### Task 1: Additive persistence and strict internal evidence

**Files:** Create `packages/db/src/schema/traceability-request-worker.ts`, `packages/db/migrations/0140_us_request_worker.sql`, generated0140 snapshot, `packages/db/test/us-request-worker-schema.test.ts`, `packages/db/test/us-request-worker-migration.e2e.test.ts`, `apps/api/src/modules/traceability/requests/us-request-worker-types.ts`, `apps/api/test/us-request-worker-types.test.ts`. Modify `packages/db/src/schema/traceability-requests.ts`, `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`, migration journal and `packages/db/test/us-request-migration.e2e.test.ts` to pin its historical final migration. Adapt only persisted-corruption fixture setup in `apps/api/test/us-request-prepare.e2e.test.ts` as described below. Do not regenerate0139.

**Deliverable:** Persistable tenant/fence/checkpoint protocol with upgrade preservation; no worker operation or runtime registration.

**Interfaces:** Export Drizzle tables `traceExportAttempts`, `traceExportRenderCheckpoints`, `traceExportObjectIntents`, `traceExportRetryReceipts`. Export the following types from `us-request-worker-types.ts`; extend strict parsers for their JSON forms, using the actual existing model/manifest schemas or validators instead of duplicating loose shapes.

```ts
import type { schema } from "@markiro/db";
import type {
  UsRequestReportModel,
  UsRequestFileDescriptor,
  UsRequestPackageName,
} from "./us-request-package-types";
import type { UsRequestManifestV1 } from "./us-request-package-manifest";
export type UsWorkerScope = Readonly<{ tenantId: string; runId: string }>;
export type UsWorkerLease = Readonly<
  UsWorkerScope & {
    attemptId: string;
    attemptNumber: number;
    cycle: number;
    token: string;
    startedAt: string;
    expiresAt: string;
    deadlineAt: string;
  }
>;
export type UsWorkerArtifactName = Exclude<UsRequestPackageName, "SHA256SUMS">;
export type UsWorkerArtifactKind =
  "xlsx" | "plan_pdf" | "validation_report" | "request_report" | "manifest" | "package_zip";
export type UsWorkerObjectEvidence = Readonly<
  UsWorkerScope & {
    id: string;
    attemptId: string;
    name: UsWorkerArtifactName;
    kind: UsWorkerArtifactKind;
    objectKey: string;
    mediaType: string;
    byteSize: number;
    sha256: string;
  }
>;
export type UsWorkerCheckpoint = Readonly<{
  model: UsRequestReportModel;
  modelDigest: string;
  executionDigest: string;
  packageVersion: string;
  reportVersion: string;
}>;
export type UsWorkerPackageExpectation = Readonly<{
  manifest: UsRequestManifestV1;
  entries: readonly UsRequestFileDescriptor[];
  zip: UsRequestFileDescriptor<"package.zip">;
}>;
export type UsWorkerRunState = Readonly<{
  run: typeof schema.traceExportRuns.$inferSelect;
  attempts: readonly (typeof schema.traceExportAttempts.$inferSelect)[];
  checkpoint: UsWorkerCheckpoint | null;
  expectation: UsWorkerPackageExpectation | null;
  artifacts: readonly (typeof schema.traceExportArtifacts.$inferSelect)[];
}>;
export const US_REQUEST_WORKER_POLICY = Object.freeze({
  leaseMs: 120_000,
  renewMs: 30_000,
  deadlineMs: 300_000,
  attemptsPerCycle: 3,
  retryDelaysMs: [10_000, 60_000] as const,
});
```

- [ ] Write schema tests asserting exact exported tables, composite tenant/run/attempt foreign keys, unique attempt numbers/keys, immutable body/package expectations, finite states, nonnegative lifetime counters and unique retry receipts. Run them RED before adding schema.
- [ ] Add lifecycle columns `lifecycleVersion`, `retryCycle`, `cycleAttemptCount`, `nextAttemptAt`, `leaseAttemptId`, `leaseToken`, `leaseExpiresAt`, `attemptDeadlineAt`. Default old queued runs to version0/cycle1/count0 with null lease. Do not invent history for old rows. Attempt records carry start/finish/failure, render completion and lease/fence identity; object ledger carries allocated/verified/unresolved/fenced/deleted/referenced states.
- [ ] Generate0140 through Drizzle with the scoped schema inventory, inspect all SQL and add reviewed SQL immutability guards. Run/body immutable fields include identity, preparation actor/key/digests/inputSnapshot/Plan/registry/preparation instant; lifecycle/timing may advance only under valid service transitions. Published artifacts cannot update/delete. Checkpoint body and nonnull package expectations are write-once. Keep SQL/schema metadata parity and composite FK creation order valid.
- [ ] Write migration RED/GREEN for a child pinned through0139 with existing queued v1/v2 data, then apply0140. Compare exact snapshots before/after; test fresh full migration, foreign-tenant inserts and rejected rewrites. Pin the pre-existing0139 historical test to0139 so new guards do not redefine that test's original scope.
- [ ] Preserve the existing prepare corruption matrix: it currently uses UPDATE to inject corrupted snapshots/digests, which new immutability guards must reject. Use a real prepared row as a template, then INSERT a separate deliberately corrupt test run with a new server-shaped ID, next revision and command key in that same owned request. Replaying that key must still return the exact stored-invalid error without recapture or success audit. Compare against the full before/after row and audit baseline; do not remove any corruption case, disable triggers or weaken checks to merely expect an UPDATE failure. Keep separate assertions that production-style UPDATE is now rejected. Equivalent JSONB key reordering remains allowed because it is not a content change. Do not pin API tests to an old DB schema while the compiled Drizzle schema expects new columns.

```ts
expect(after.run.inputSnapshot).toEqual(before.run.inputSnapshot);
expect(after.run.attemptCount).toBe(before.run.attemptCount);
expect(after.run.lifecycleVersion).toBe(0);
expect(after.run.leaseToken).toBeNull();
await expect(
  f.pool.query("UPDATE trace_export_runs SET input_snapshot = '{}'::jsonb WHERE id=$1", [
    before.run.id,
  ]),
).rejects.toMatchObject({ code: "23514" });
```

- [ ] Add strict scope/lease/checkpoint/object/expectation parsers with exact canonical milliseconds, UUIDs, finite names/kinds/media mappings, digest/size bounds and defensive copies. Test fractional precision, getters/extra fields, mismatched descriptors, buffers modified after binding and bigint-safe DB conversion. Invalid evidence is a sanitized finite failure, never a broad cast.
- [ ] Run focused DB/API type suites, then DB test/typecheck/lint/build and formatting/diff checks. Rebuild DB before consumer tests. Record results/skips; independent review must accept constraints, SQL upgrade preservation and type exports before Task2.

**Commands:** `corepack pnpm --filter @markiro/db exec vitest run test/us-request-worker-schema.test.ts test/us-request-worker-migration.e2e.test.ts test/us-request-migration.e2e.test.ts --maxWorkers=1`; `corepack pnpm --filter @markiro/api exec vitest run test/us-request-worker-types.test.ts`.

### Task 2: Fenced lifecycle, backoff and manual retry

**Files:** Create `us-request-worker-lifecycle.ts`, `us-request-worker-failures.ts` and `apps/api/test/us-request-worker-lifecycle.e2e.test.ts`, `apps/api/test/us-request-worker-failures.test.ts`. Extend only the owned exports in `us-request-worker-types.ts` with retry/failure types below.

**Consumes:** Task1 types/tables; existing `Db`, `UsMasterDataTransaction`, `authorizeUsMasterData`, `US_CAPABILITY`, request frozen-evidence verification and tenant audit table. Use both capability calls: an array to `authorizeUsMasterData` means OR, not AND.

**Produces:** `UsRequestWorkerLifecycle(db)` with these methods. `read` is internal evidence only, not a user read endpoint. Claim/renew are system operations; authorization is checked before execution and in publication. All timestamps returned are canonical UTC milliseconds derived from DB time.

```ts
type UsWorkerFailure = Readonly<{ code: UsWorkerFailureCode; retryable: boolean }>;
type UsWorkerRetryBody = Readonly<{
  expectedLifecycleVersion: number;
  reason: string;
  idempotencyKey: string;
}>;
type UsWorkerRetryReceipt = Readonly<
  UsWorkerScope & {
    cycle: number;
    lifecycleVersion: number;
    requestedBy: string;
    idempotencyKey: string;
  }
>;
export interface UsRequestWorkerLifecycleContract {
  claimNext(): Promise<UsWorkerLease | null>;
  renew(lease: UsWorkerLease): Promise<UsWorkerLease>;
  authorize(lease: UsWorkerLease): Promise<void>;
  read(scope: UsWorkerScope): Promise<UsWorkerRunState>;
  finishFailure(lease: UsWorkerLease, failure: UsWorkerFailure): Promise<void>;
  recoverExpired(scope: UsWorkerScope): Promise<void>;
  retry(
    scope: UsWorkerScope,
    callerId: string,
    body: UsWorkerRetryBody,
  ): Promise<UsWorkerRetryReceipt>;
  assertActive(tx: UsMasterDataTransaction, lease: UsWorkerLease): Promise<void>;
}
```

- [ ] Write and run concurrent-claim RED using two service instances and one real prepared run. Exactly one nonnull lease; persisted lifetime count1 and one attempt/audit. Add renew, stale token, expired renewal and five-minute deadline cases before implementing conditional transitions.

```ts
const c = await createUsRequestPackageFixture(f.db, { mode: "export_ready" });
try {
  const a = new UsRequestWorkerLifecycle(f.db);
  const b = new UsRequestWorkerLifecycle(f.db);
  const claims = await Promise.all([a.claimNext(), b.claimNext()]);
  expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
  const state = await a.read({ tenantId: c.tenantId, runId: c.run.id });
  expect(state.run.attemptCount).toBe(1);
  expect(state.attempts).toHaveLength(1);
} finally {
  c.destroy();
}
```

- [ ] Implement short transactional claim selection with deterministic preparation-time/ID order, row locking and `SKIP LOCKED`. Eligibility must be rechecked after locking using `date_trunc('milliseconds', clock_timestamp())`, not transaction-start `now()` or caller time. Recover one expired run per bounded operation. Never hold run locks across byte work; retain membership→profile→org-profile→run lock order when combining authorization and publication checks.
- [ ] Implement lifecycle transitions: queued→processing; recoverable failure→queued with due time and cleared lease; permanent/exhausted→failed with completion and cleared lease; expired→abandoned attempt plus delayed next eligibility/exhaustion. Renew cannot extend the fixed attempt deadline. Re-read publication references before recovering ambiguous finished work.
- [ ] Implement finite failure parsing/classification: allowlist current upstream request/profile/capability failures without exposing their causes. Only known DB retryable codes (`40001`, `40P01`, classified connection unavailability) and bounded package-storage transport/timeout codes are transient. Corrupt evidence/hash, unsupported v1/version, access denial, limits, unknown errors and generic render failures are permanent. A SQL error after an unknown publication commit is reconciled, not immediately sent to failure transition.

```ts
// Preserve these upstream codes as permanent; never store a raw error message.
const upstream = [
  "insufficient_permission",
  "traceability_profile_required",
  "traceability_profile_invalid",
  "us_request_profile_unsupported",
  "us_request_run_stored_invalid",
  "us_request_package_refreeze_required",
  "us_request_payload_evidence_mismatch",
  "us_request_payload_size_limit",
  "us_request_payload_workbook_unavailable",
  "us_request_payload_render_failed",
  "us_request_plan_read_failed",
  "us_request_package_inputs_invalid",
  "us_request_package_context_invalid",
  "us_request_package_model_invalid",
  "us_request_package_size_limit",
  "us_request_package_manifest_invalid",
  "us_request_package_archive_invalid",
  "us_request_report_render_failed",
] as const;
export const US_REQUEST_WORKER_FAILURE_CODES = [
  ...upstream,
  "us_request_worker_lease_lost",
  "us_request_worker_deadline_exceeded",
  "us_request_worker_retry_limit",
  "us_request_worker_checkpoint_mismatch",
  "us_request_worker_execution_invalid",
  "us_request_worker_stored_invalid",
  "us_request_worker_retry_conflict",
  "us_request_worker_unknown_failure",
  "us_request_worker_database_unavailable",
  "us_request_worker_database_retryable",
  "us_request_package_storage_configuration_invalid",
  "us_request_package_storage_operational_verification_required",
  "us_request_package_storage_transport_failed",
  "us_request_package_storage_timeout",
  "us_request_package_storage_evidence_invalid",
  "us_request_package_storage_scope_invalid",
  "us_request_package_storage_collision",
  "us_request_package_storage_checksum_mismatch",
  "us_request_package_storage_read_failed",
  "us_request_package_storage_delete_failed",
] as const;
export type UsWorkerFailureCode = (typeof US_REQUEST_WORKER_FAILURE_CODES)[number];
```

Opaque Plan-reader failures remain permanent because that boundary does not distinguish corrupt/missing evidence from transport failure. Do not inspect/log its hidden cause to guess a retry classification. Validate worker codes with a strict enum and export the resulting inferred type; unknown input maps only to `us_request_worker_unknown_failure`.

- [ ] Test 10/60-second backoff against DB-recorded next eligibility, exact third-claim exhaustion and expired third attempt. Advance only test-owned scheduling/lease fields in the disposable DB; do not change production clock policy or sleep through backoff. Assert exact tenant/system actor/action/target/result/attempt/count/reason metadata.
- [ ] Implement strict manual retry body/digest/receipt. Authorize caller and original initiator first; replay an identical receipt before expected-version/new-state validation. Require failed state for a new cycle, reason length3–2000, positive expected version and UUID key. Update only lifecycle fields, leaving checkpoint/frozen input untouched. Ready cannot requeue; duplicate key/different body conflicts.

```ts
const first = await lifecycle.retry(scope, c.actorId, body);
await lifecycle.claimNext();
expect(await lifecycle.retry(scope, c.actorId, body)).toEqual(first);
expect((await lifecycle.read(scope)).run.retryCycle).toBe(first.cycle);
// Count exact retry action rows and compare full metadata; expect one, not two.
```

- [ ] Run focused lifecycle/failure suites plus existing prepare/run-evidence/v1 regressions. Check API typecheck/lint and record explicit-path diff. Independent review must accept race, authorization, finite-code and retry receipt evidence.

**Commands:** `corepack pnpm --filter @markiro/api exec vitest run test/us-request-worker-lifecycle.e2e.test.ts test/us-request-worker-failures.test.ts test/us-request-prepare.e2e.test.ts test/us-request-run-evidence.e2e.test.ts test/us-request-versions.e2e.test.ts --maxWorkers=1`.

### Task 3: Write-once report and package checkpoint

**Files:** Create `us-request-worker-checkpoint.ts`, `apps/api/test/us-request-worker-checkpoint.e2e.test.ts`. Do not alter the accepted composer/renderer to read clocks or persistence.

**Consumes:** Tasks1/2; existing `bindUsRequestPackageInputs`, `assertUsRequestReportModel`, `stableStringify`, package composer/result and real pinned Plan reader.

**Produces:** `UsRequestWorkerCheckpoints(db, lifecycle)` with `acceptReport(lease, checkpoint): Promise<UsWorkerCheckpoint>`, `acceptPackage(lease, expectation, renderedAt: string): Promise<UsWorkerPackageExpectation>`, `assertReproduction(checkpoint, inputs: UsRequestPackageInputs, executionDigest: string): void`, `assertPackageReproduction(expected, result: UsRequestPackageResult): void`. Methods validate tenant/run bindings and the active fence; first-write-wins returns identical evidence or conflicts, never replaces it.

- [ ] Write stale-attempt/report-first-write RED in real PostgreSQL. Two candidate contexts for the same run cannot both be accepted; a service recreated after commit reads the first model/digest. Corrupt stored evidence fails without repair. Run RED before creating methods.
- [ ] Implement canonical deep-copy/model digest and bounded persistence under lifecycle `assertActive`. Require model tenant/run/revision/actor/mode/digests/Plan/origin to match verified frozen evidence. First-write renderer/version/execution identities are saved with the report body. Reconcile unknown checkpoint commit through a fresh read before returning/retrying.

```ts
const inputs = bindUsRequestPackageInputs(c.run, c.tenantId, c.payloads, c.plan, c.context);
const body = {
  model: inputs.model,
  modelDigest: createHash("sha256").update(stableStringify(inputs.model)).digest("hex"),
  executionDigest: "b".repeat(64),
  packageVersion: US_REQUEST_PACKAGE_VERSION,
  reportVersion: US_REQUEST_REPORT_PDF_VERSION,
};
expect(await checkpoints.acceptReport(lease, body)).toEqual(body);
await expect(
  checkpoints.acceptReport(lease, {
    ...body,
    executionDigest: "c".repeat(64),
  }),
).rejects.toMatchObject({ response: { code: "us_request_worker_checkpoint_mismatch" } });
```

- [ ] Implement reproduction comparisons over actual upstream descriptor bytes/hashes, model findings/omissions and execution versions. Reject clock reversal, an altered timezone, renamed actor, changed trusted-origin model, a different Plan pin and incomplete omission recovery. Compare saved context, not new report-data time. Preserve exact existing typed omissions; do not reinterpret a render exception.
- [ ] Assemble through the real composer, save write-once ordered manifest/entry/ZIP expectations before I/O and record actual render completion on the attempt. Compare all descriptors and manifest identity on recovery, including SHA256SUMS as a ZIP entry but not a separate stored artifact. Later byte-identical re-render may record its own actual completion without changing expected byte facts.
- [ ] Run checkpoint/payload/Plan/package inputs/ZIP regressions; prove source/request amendments and Plan supersession do not change checkpoint or reconstructed bytes. Independently review first-write, unknown commit and before-PDF boundaries.

**Commands:** `corepack pnpm --filter @markiro/api exec vitest run test/us-request-worker-checkpoint.e2e.test.ts test/us-request-package-inputs.e2e.test.ts test/us-request-plan-reader.e2e.test.ts test/us-request-package.e2e.test.ts --maxWorkers=1`.

### Task 4: Bounded private synthetic package storage

**Files:** Create `us-request-package-artifact-config.ts`, `us-request-package-artifacts.ts`, `apps/api/test/support/us-request-worker-storage-fixture.ts`, `apps/api/test/us-request-package-artifact-config.test.ts`, `apps/api/test/us-request-package-artifacts.test.ts`.

**Consumes:** Task1 object evidence/limits and existing SDK dependencies. Plan adapter is a reference, not a base class or namespace to extend.

**Produces:** `loadUsRequestPackageArtifactStorageConfig(source: NodeJS.ProcessEnv): UsRequestPackageArtifactStorageConfig | null`; authority-validating config assertion; `UsRequestPackageArtifactStore(config, transport?)` with `putVerified(scope, evidence, bytes: Uint8Array): Promise<void>`, `readVerified(scope, evidence): Promise<Buffer>`, `removeFenced(scope, evidence): Promise<void>`, `destroy(): void`. DELETE can only be invoked by Task5's committed fence flow; possession of this adapter is not user authorization. Transport exposes `send(command, { abortSignal }): Promise<unknown>` and optional `destroy` using the existing four SDK command types.

The test-only `createUsRequestWorkerStorageFixture()` returns `{ config, store, objects, calls, destroy }`, with its config obtained through the real loader, an isolated in-memory conditional transport and actual command/stream assertions. Tests may inject a wrapped transport to delay/fail a boundary; no product test bypass flag.

- [ ] Write loader RED for unconfigured/all-or-none, production/remote/URL-credential/query/hash endpoints, duplicate primary bucket/credentials and forged configuration objects. Implement validated WeakSet authority and `US_REQUEST_PACKAGE_S3_*` inventory in the loader only; do not connect environment parsing to runtime yet.

```ts
const fields = {
  endpoint: "US_REQUEST_PACKAGE_S3_ENDPOINT",
  region: "US_REQUEST_PACKAGE_S3_REGION",
  bucket: "US_REQUEST_PACKAGE_S3_BUCKET",
  accessKeyId: "US_REQUEST_PACKAGE_S3_ACCESS_KEY_ID",
  secretAccessKey: "US_REQUEST_PACKAGE_S3_SECRET_ACCESS_KEY",
  forcePathStyle: "US_REQUEST_PACKAGE_S3_FORCE_PATH_STYLE",
} as const;
```

- [ ] Write conditional-put/read-back RED using correctly scoped fixed file evidence. Implement copied buffer/hash/size/name/kind/media validation and key shape `us/requests/<tenant>/<run>/<attempt>/<fixed-name>`. No requester-derived text. Conditional `IfNoneMatch: "*"` prevents overwrite; a collision is not ownership proof.

```ts
const s = createUsRequestWorkerStorageFixture();
try {
  await s.store.putVerified(scope, evidence, bytes);
  expect(await s.store.readVerified(scope, evidence)).toEqual(Buffer.from(bytes));
  await expect(s.store.putVerified(scope, evidence, bytes)).rejects.toThrow();
  expect(s.objects.size).toBe(1);
  expect(s.calls.filter((call) => call.kind === "get")).not.toHaveLength(0);
} finally {
  s.destroy();
}
```

- [ ] Implement15-second abort/transport/body deadline with bounded streaming and actual size/hash verification. Test exact/beyond file limits, lying HEAD/content-length, truncated stream, oversized first chunk, stream failure, non-Uint8Array chunks and post-abort late completion. Verify signal/timer/stream resources are closed and no late promise becomes successful evidence.
- [ ] Delete only the exact validated key handed to the fenced cleanup path; repeated not-found deletion is idempotent, unknown errors finite. Test foreign scope, Plan prefix, malformed UUID/path, forged evidence and primary/private key leakage rejection before transport.
- [ ] Run storage/config suites, API typecheck/lint and format/diff checks. Record these as synthetic-transport results, not live S3 acceptance. Independent review validates bounds, privacy, ownership and no SDK retry hiding the worker budget.

**Commands:** `corepack pnpm --filter @markiro/api exec vitest run test/us-request-package-artifact-config.test.ts test/us-request-package-artifacts.test.ts`.

### Task 5: Atomic publication, reconciliation and fenced cleanup

**Files:** Create `us-request-worker-publication.ts`, `us-request-worker-cleanup.ts`, `apps/api/test/us-request-worker-publication.e2e.test.ts`, `apps/api/test/us-request-worker-cleanup.e2e.test.ts`.

**Consumes:** Tasks1–4, actual frozen/checkpoint/package expectations and tenant audit. New classes do not own a scheduler or HTTP route.

**Produces:** `UsRequestWorkerPublication(db, lifecycle)` with `allocate(lease, expectation): Promise<readonly UsWorkerObjectEvidence[]>`, `markVerified(lease, evidence): Promise<void>`, `publish(lease): Promise<UsWorkerRunState>`, `reconcile(scope): Promise<UsWorkerRunState>`. `UsRequestWorkerCleanup(db, store)` exposes `cleanupOne(scope): Promise<"idle" | "referenced" | "deleted" | "unresolved" | "retry_required">`. Publication only consumes trusted verified receipts persisted by the internal worker after Task4 read-back, not client-supplied metadata.

- [ ] Write atomicity RED using a real run/checkpoint/package, durable allocated intents and Task4 actual upload/read-back. Successful result has all six available artifact kinds, exact hashes/private keys, one publication audit and ready mode semantics. Cause audit/row insertion failure and assert no partial artifact set/status mutation.
- [ ] Implement durable intent allocation before PUT. Conditional allocation returns the same exact key set for a repeated attempt; never reuse another attempt's namespace. Enforce write-once expected bytes and per-attempt filename/key uniqueness; allocated intent alone does not prove an uncertain PUT was owned.
- [ ] Implement final publication authorization via both capability calls and processor profile under membership/profile locks before the run lock. Validate live token/deadline and exact verified intent/checkpoint/package bindings. Check permanent fences. Commit artifacts, reference markers, successful attempt timing, `ready`, mode-derived `exportReady`, completion instant and exact audit in one transaction with no object I/O inside it.

```ts
const result = await publication.publish(lease);
expect(result.run.status).toBe("ready");
expect(result.run.exportReady).toBe(result.run.mode === "export_ready");
expect(result.artifacts.map((row) => row.filename).sort()).toEqual(
  expectedObjects.map((row) => row.name).sort(),
);
expect((await publication.publish(lease)).artifacts).toEqual(result.artifacts);
// Assert one exact publication action, with tenant/actor/target/mode/revision/hashes.
```

- [ ] Test creator revocation after read-back and while a publication waits for locks. Use two actual PostgreSQL clients and bounded barriers, not sleeps. A committed revocation denies publication. Serialization/deadlock retries must reopen transactions and reread access; never replay a stale authorized closure.
- [ ] Implement read-only reconciliation after unknown COMMIT outcome. Fault injection forwards an actual COMMIT then loses the reply; separately exercise actual rollback/lost reply. Read durable references through a fresh connection. While DB remains unavailable, retain all objects and expose no invented terminal success/failure.
- [ ] Implement cleanup transaction: lock run, check all artifact/checkpoint/staging references and candidate eligibility, assert provable ownership, commit a permanent never-publish fence, then DELETE outside TX. Only verified-owned abandoned objects qualify; unresolved PUT collisions remain unresolved. Record fenced/deleted/retry_required outcomes durably with exact audits. Startup memory is not cleanup authority.
- [ ] Run concurrent cleanup/publication races, stale old worker completion, failed DELETE then recreated cleanup service, winner/Plan preservation and ambiguous cleanup-fence commit. A reference or unconfirmed fence prevents deletion. Ensure a candidate's own stale completion cannot publish after fencing.
- [ ] Run focused publication/cleanup plus Plan approval/artifact regressions, format/diff and API typecheck/lint. Independent review gates the transactional/reference/ownership protocol before orchestration.

**Commands:** `corepack pnpm --filter @markiro/api exec vitest run test/us-request-worker-publication.e2e.test.ts test/us-request-worker-cleanup.e2e.test.ts test/us-plan-artifact-config.test.ts test/us-plan-artifacts.test.ts test/us-plan-approval.e2e.test.ts --maxWorkers=1`.

### Task 6: One-run orchestration and synthetic execution identity

**Files:** Create `us-request-worker.ts`, `us-request-worker-execution.ts`, `apps/api/test/us-request-worker-execution.test.ts`, `apps/api/test/us-request-worker.e2e.test.ts`. Do not modify `UsRuntime` or `UsDevelopmentModule`.

**Consumes:** Tasks1–5 and actual payload→pinned Plan→model→composer pipeline.

**Produces:** `createSyntheticUsRequestExecutionIdentity(build: UsExportBuildIdentity, source: NodeJS.ProcessEnv): UsRequestWorkerExecutionIdentity`, using canonical digests, explicit pinned package/report/library identities and an authority-bearing development/test-only result; `assertUsRequestWorkerExecutionIdentity(identity): void` verifies its loader authority. The type exposes read-only `build` and `digest`; the worker rejects forged/operational identities. `UsRequestWorker(db, deps)` exposes `runOne(): Promise<UsRequestWorkerResult>`; deps are `{ lifecycle, checkpoints, publication, cleanup, storage: UsRequestPackageArtifactStore | null, planReader: UsRequestPlanReader, execution: UsRequestWorkerExecutionIdentity }`.

```ts
type UsRequestWorkerResult =
  | { kind: "storage_unavailable" }
  | { kind: "idle" }
  | { kind: "ready"; scope: UsWorkerScope }
  | { kind: "retry_scheduled"; scope: UsWorkerScope }
  | { kind: "failed"; scope: UsWorkerScope; code: UsWorkerFailureCode }
  | { kind: "lease_lost"; scope: UsWorkerScope }
  | { kind: "outcome_unresolved"; scope: UsWorkerScope };
// code is constrained by Task2's finite parser; no raw error/cause in any result.
```

- [ ] Write no-storage RED asserting exact unchanged run/attempt/checkpoint/artifact/audit rows and no Plan/renderer calls. Reject operational mode or execution stamp drift before payload I/O. Preserve explicit `not_attested` provenance for normal synthetic fixtures; execution mode is not tenant-origin attestation.
- [ ] Implement the pipeline in this order, with explicit active-fence checks at durable boundaries:

```ts
if (!deps.storage) return { kind: "storage_unavailable" };
assertUsRequestWorkerExecutionIdentity(deps.execution);
const lease = await deps.lifecycle.claimNext();
if (!lease) return { kind: "idle" };
const scope = { tenantId: lease.tenantId, runId: lease.runId };
await deps.lifecycle.authorize(lease);
const state = await deps.lifecycle.read(scope);
const frozen = requireUsRequestPackageEvidence(state.run, lease.tenantId);
if (stableStringify(frozen.validationSnapshot.build) !== stableStringify(deps.execution.build))
  throw new ServiceUnavailableException({ code: "us_request_worker_execution_invalid" });
const payloads = await renderUsRequestPayloads(state.run, lease.tenantId);
const plan = await deps.planReader.read(state.run, lease.tenantId);
const context = {
  schemaVersion: 1 as const,
  workerStartedAt: state.checkpoint
    ? state.checkpoint.model.timing.workerStartedAt
    : lease.startedAt,
  reportDataPreparedAt:
    state.checkpoint?.model.timing.reportDataPreparedAt ?? new Date().toISOString(),
};
const inputs = bindUsRequestPackageInputs(state.run, scope.tenantId, payloads, plan, context);
if (state.checkpoint)
  deps.checkpoints.assertReproduction(state.checkpoint, inputs, deps.execution.digest);
await deps.checkpoints.acceptReport(lease, {
  model: inputs.model,
  modelDigest: createHash("sha256").update(stableStringify(inputs.model)).digest("hex"),
  executionDigest: deps.execution.digest,
  packageVersion: US_REQUEST_PACKAGE_VERSION,
  reportVersion: US_REQUEST_REPORT_PDF_VERSION,
});
const result = await assembleUsRequestPackage(inputs);
const renderedAt = new Date().toISOString();
if (state.expectation) deps.checkpoints.assertPackageReproduction(state.expectation, result);
const { bytes: zipBytes, ...zip } = result.zip;
void zipBytes;
const expectation = await deps.checkpoints.acceptPackage(
  lease,
  {
    manifest: result.manifest,
    entries: result.files.map(({ bytes, ...descriptor }) => {
      void bytes;
      return descriptor;
    }),
    zip,
  },
  renderedAt,
);
const objects = await deps.publication.allocate(lease, expectation);
for (const evidence of objects) {
  const file =
    evidence.name === "package.zip"
      ? result.zip
      : result.files.find((entry) => entry.name === evidence.name);
  if (!file) throw new ServiceUnavailableException({ code: "us_request_worker_stored_invalid" });
  await deps.storage.putVerified(scope, evidence, file.bytes);
  await deps.publication.markVerified(lease, evidence);
}
await deps.publication.publish(lease);
return { kind: "ready", scope };
```

This is the success path inside the bounded renewal/failure wrapper described in the next steps, not permission to omit that wrapper. Capture actual system times only through the trusted internal worker; reject backward chronology rather than clamping it. Preserve explicitly null worker timing from a stored checkpoint. Pair objects to real composer files by the fixed mapping: records→xlsx, Plan→plan_pdf, validation→validation_report, report→request_report, manifest→manifest, package ZIP→package_zip. Do not upload SHA256SUMS separately.

- [ ] Add a renewable 120-second lease with a renewal helper scoped to this invocation; join/stop it on ready, failed, transient, unknown commit and thrown initialization paths. Deadline expiration rejects publication even if non-cancellable PDF work finishes afterwards. A late renderer/storage result cannot update state after lease loss.
- [ ] Implement strict transient handling through Task2, checkpoint reuse through Task3 and unknown publication reconciliation through Task5 before failure/cleanup. Never call `finishFailure` on a possibly committed ready result without resolving references. Sanitized unresolved results retain durable recovery intent.
- [ ] Test both ready/incomplete, null Plan only when originally absent, v1-before-I/O rejection, broken pinned Plan, exact publication timestamps separated from saved PDF context, lease loss during render/read/upload and changed execution identity. Assert no runtime registration and no original Plan upload/delete.
- [ ] Run worker/execution tests plus checkpoint/publication/storage gates. Independent review inspects real renderer provenance, no-storage side effects, renewal termination and failure routing.

**Commands:** `corepack pnpm --filter @markiro/api exec vitest run test/us-request-worker-execution.test.ts test/us-request-worker.e2e.test.ts --maxWorkers=1`.

### Task 7: Restart and integrated recovery matrix

**Files:** Create `apps/api/test/us-request-worker-recovery.e2e.test.ts`, `apps/api/test/support/us-request-worker-fixture.ts`. Extend `us-request-worker-storage-fixture.ts` only for test fault injection/transport recording. Do not change production behavior to make integration tests pass.

**Consumes:** All prior classes and real package fixtures. `createUsRequestWorkerFixture(db, options: Parameters<typeof createUsRequestPackageFixture>[1])` returns `{ source, storage, lifecycle, checkpoints, publication, cleanup, worker, recreate(): UsRequestWorker, destroy(): void }`. Each recreated worker uses new service instances with the same explicit DB, durable state and isolated transport objects; no inherited in-memory lease/checkpoint authority. All resources remain owned by the test.

- [ ] Write RED for restart after claim, report checkpoint, complete package expectation, partial upload, read-back, committed publication/lost reply and cleanup fence. Use test-owned DB lease expiry and explicit synchronization barriers; do not wait 120 seconds or rely on flakiness. Recreated services prove durable state recovery; separately label any real subprocess restart test, not a live daemon.
- [ ] Implement only test harness fault seams at the actual dependencies/DB connection boundaries. Lost-COMMIT tests must forward or roll back a real PostgreSQL transaction before simulating reply loss; a fake throw before COMMIT is not the accepted scenario.
- [ ] Prove same run/revision/checkpoint context and byte hashes survive each recovery, with increasing lifetime attempts, no duplicate winning rows/audits and exactly protected Plan bytes. Compare downloaded internal store bytes to the actual composer expectation and invoke the existing canonical archive verifier.

```ts
const firstState = await fixture.lifecycle.read(scope);
const restarted = fixture.recreate();
await restarted.runOne();
const finalState = await fixture.lifecycle.read(scope);
expect(finalState.run.inputSnapshot).toEqual(firstState.run.inputSnapshot);
expect(finalState.checkpoint).toEqual(firstState.checkpoint);
expect(finalState.run.status).toBe("ready");
const zipRow = finalState.artifacts.find((row) => row.kind === "package_zip");
expect(zipRow?.sha256).toBe(finalState.expectation?.zip.sha256);
// Verify actual read-back ZIP and every archived entry, not only metadata equality.
```

- [ ] Add both modes with present/absent workbook/Plan combinations, source/request edits and Plan supersession after preparation, request closure, original initiator revoke/restore, manual retry receipt replay after another failure and permanent omission/version mismatch. A terminal permanent problem never becomes ready through retries; a corrected source uses a new run.
- [ ] Include the reserved synthetic-owner provisioning path already exercised in `us-request-package.e2e.test.ts`: use the actual `UsDevelopmentOwnerStore` operation and subsequent profile/membership setup, not an inserted audit row or client provenance flag. Assert the worker preserves its server-derived synthetic mark and exact owner-provisioning audit fields. Normal fixture provenance stays `not_attested`.
- [ ] Add positive Transformation/Shipping frozen-content worker cases using the actual existing event stores/fixtures. Compare the exact generated workbook to `renderUsRequestPayloads` for that same saved run. Do not create event JSON by casting fixtures. Keep full-chain quantity/lifecycle semantics with upstream tests; do not claim these worker tests replace genealogy validation.
- [ ] Exercise bounded total/package/stream paths. If reaching a default maximum requires structurally invalid fixture input, test a restored lower-limit seam and default invariant separately and label that evidence; never claim valid maximum-size performance from a seam.
- [ ] Run integrated matrix twice with clean test-owned state and no skips. Independently review race barriers, actual byte witnesses, ambiguous transaction evidence and exact audits. No new browser/PDF visual acceptance is claimed merely because previously rendered package-core pages were accepted.

**Commands:** `corepack pnpm --filter @markiro/api exec vitest run test/us-request-worker-recovery.e2e.test.ts test/us-request-worker.e2e.test.ts test/us-request-package.e2e.test.ts --maxWorkers=1`.

### Task 8: Check-only CI ownership and final acceptance

**Files:** Modify `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, `docs/us/implementation-plan.md`, this plan and its approved specification only to record implemented scope/results. Add no operational workflow or runtime environment parsing. Inspect `tools/ci/affected.mjs` read-only and change it only if evidence shows the existing US check selection misses these owned paths.

**Consumes:** Accepted Tasks1–7 evidence, exact owned diff and unchanged release boundaries.

- [ ] Add failing isolation contract assertions for all new schema/type/failure/checkpoint/storage/lifecycle/publication/cleanup/worker/recovery suites. Assert dependency builds precede tests, DB suites have explicit US URL and serial selection, and commands contain no ignored failure/conditional skip. Run RED before extending the existing check-only US job.

```js
for (const name of [
  "us-request-worker-lifecycle.e2e.test.ts",
  "us-request-worker-checkpoint.e2e.test.ts",
  "us-request-worker-publication.e2e.test.ts",
  "us-request-worker-cleanup.e2e.test.ts",
  "us-request-worker-recovery.e2e.test.ts",
])
  assert.ok(workflowText.includes(name));
```

- [ ] Select every new suite by its exact task filename, including pure config/storage/types/failures/execution and DB schema/migration tests. Keep unconditional operational locks, secrets/publication/token permissions and concurrency groups unchanged. No CI artifact upload of packages/contact data.
- [ ] Build affected shared dependencies, run new selected gates plus existing request/export/Plan regressions serially with the explicit isolated URL. Record per-suite totals and skips once; do not sum overlapping gates or claim CI execution from a local pass.
- [ ] Run DB/API package test/typecheck/lint/build with the authorized isolated environment. A full API run may retain primary-environment setup failures; report exact suites/hooks/assertion totals and cause without loading primary secrets. Missing/blocked infrastructure cannot be accepted as exercised recovery.

```sh
corepack pnpm --filter @markiro/db test
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/db lint
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/api test
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
node tools/us-development/check-isolation.mjs
node --test tools/us-development/test/isolation.test.mjs
corepack pnpm format:check
git diff --check
```

- [ ] Review the full owned diff against the approved specification, validate hashes of unchanged inherited overlaps and all added files, and obtain final independent whole-increment review. This is an increment review, not a PR against main or release decision. If fixes change another task's contract, reopen its review gate and rerun dependent tests.
- [ ] Record an accepted local checkpoint only after real results exist. US-09 remains In progress; runtime/scheduler/shutdown, production build identity, hosted storage/recovery, HTTP/UI/downloads, remote CI and release remain separate unverified outcomes. Distinguish mocked transport, any actual local S3 test and any real subprocess test. Do not claim reused package-core screenshots verify this worker.
- [ ] Hand off behavior/files/checks/manual evidence/remaining gates. Do not stage, commit, push, create a PR, release or clean up without new direct owner authorization.

## Local implementer checkpoint — 2026-10-05

This is implementation evidence pending independent Task 8 and final whole-increment review, not an accepted whole-increment checkpoint. Tasks 1–7 are independently accepted, including the corrected Task 6 v1 queue fixture and Task 7's two clean 75-case recovery/worker/package runs. The internal one-run worker now uses immutable checkpoints, fenced private synthetic storage, atomic publication, unknown-transaction reconciliation and durable permanent cleanup fences; no runtime entry or scheduler is registered.

Task 8's isolation RED first identified missing build/suite ownership, then GREEN passed 19/19 with zero skips. Check-only CI selects all eleven API worker/config/storage/type/failure/execution/lifecycle/checkpoint/publication/cleanup/recovery suites plus both DB worker schema/migration suites. Explicit DB/domain/contracts builds precede them; actual request/export/Plan DB/API regressions are serial with explicit isolated US URL. Operational workflow locks, services, token permissions, secrets and concurrency are unchanged; no package/contact artifact upload is added. Read-only inspection of `tools/ci/affected.mjs` found no missing selection, so it is unchanged.

Fresh selected gates passed API 38 files / 809 tests, DB six files / 112 tests, domain five files / 104 tests and contracts four files / 124 tests, all zero skips. These are separate invocations and are not summed with the overlapping broad runs. All affected API shared dependencies were built directly under Node 24.18.0 and Corepack pnpm 11.22.0 before consumer tests. DB/API typecheck, lint and build, full formatting, diff and isolation checks pass.

The full DB package invocation passed: 105 files (78 passed / 27 skipped), 780 passed / 141 skipped, no failures. The sole full API invocation remains non-green: exit 1, 410 files (8 failed / 299 passed / 103 skipped), 3,716 passed / 1,411 skipped / zero failed assertions, 975.02 seconds. All same 38 selected API files and their 809 assertions passed within that invocation. Failed files are `billing-accounts.e2e.test.ts`, `exchange-credentials.e2e.test.ts`, `exchange-import.e2e.test.ts`, `exchange-orders.e2e.test.ts`, `exchange-protocol.e2e.test.ts`, `integrations-delete.e2e.test.ts`, `integrations.e2e.test.ts`, and `subscription-route-inventory.test.ts`. Nine failed-suite groups comprise eight primary-environment `beforeAll` loader failures and one billing collection failure; twelve diagnostics include three secondary undefined `db.delete` teardown errors in import/orders/protocol. Primary database/auth/origin/pepper variables are intentionally absent. No primary environment was loaded or unrelated RU setup repaired. Initial sandbox loopback EPERM was resolved only by tool-reviewed isolated fixture access; existing Vite CommonJS/native-config advisory remains disclosed.

Fixtures create, migrate and drop only their own random US child databases; the base/primary databases are unchanged. Synthetic storage transport, real PostgreSQL transactions and new service instance recovery are separate evidence categories. Test-only deterministic PostgreSQL clock projection does not prove 120 seconds of real expiry or OS process restart. No live local/hosted S3, worker HTTP/UI/downloads, runtime/scheduler/shutdown, production build identity, hosted recovery, browser/PDF visual, Excel/hardware, remote CI or release acceptance is established. Existing Plan HTTP regressions are exercised separately from any absent worker endpoint. Previous package-core PDF screenshots are not worker proof. US-09 stays In progress. HEAD remains `7aca1b70703728cc24d09455d42095aa24eafcf8`; no staging, commit, push, PR, provisioning, runtime startup, release or cleanup occurred.

## Final-review fix checkpoint — 2026-10-05

The preceding local checkpoint records the source before the final review and fixes. Task 8 was subsequently independently accepted. The final review found three Important issues: an oldest corrupt queued row could block later healthy work; checkpoint/intent/failure writes could commit after a write-only lock wait crossed lease expiry or deadline; renewal could revive the old lease after its UPDATE waited. One combined fix adds a bounded permanent disposition with exact system/original-initiator audit and no invented attempt, final fresh DB-time guards after all lease-owned writes/audit, and renewal checks against the exact old persisted expiry/deadline. Frozen facts/counters, valid-v1 refreeze, current original-actor authorization and actual unknown-COMMIT reconciliation remain intact. Schema, migrations, guards, runtime, storage adapter and public interfaces are unchanged.

Twenty-four new recovery regressions include twenty real PostgreSQL SHARE write-barrier cases across expiry/deadline, two corrupt-row progress/healthy-actor authorization cases and two unsafe identity/reference cases. The twenty-two primary regressions failed on the pre-fix source, then passed; full affected verification passed six suites / 146 tests, and the post-fix request/export/Plan selection passed 38 suites / 833 tests, both with zero skips. These overlapping runs are not summed. API typecheck/lint/build, full formatting, diff, isolation checker and 19 isolation contracts pass. Clock projection remains the approved test-only seam; SQL transactions/locks are real, with exact rollback and safe recovery assertions. No immutable clocks or SQL guards were rewritten.

The earlier 809-test selected result, full DB 780 passed / 141 skipped and non-green full API 3,716 passed / 1,411 skipped with eight failed primary-environment setup files all precede these three source-module and one test-file changes. They remain historical evidence, not post-fix full-package gates. Full API/DB commands were not repeated to regenerate those known primary-environment failures; no primary environment was loaded. The existing Vite advisory remains disclosed. Independent scoped re-review of this combined fix is pending; this is not whole-increment acceptance, remote CI, runtime, hosted-storage/recovery or release acceptance. US-09 remains In progress; no staging, commit, push or release occurred.

## Owner review gate

Controller completion record, 2026-10-05: independent scoped re-review confirmed all three findings addressed, with no new Critical/Important breakage, and accepted the local increment. This supersedes the pending-review status in the historical checkpoints above. It does not establish a green full API gate, remote CI, runtime, hosted-storage/recovery, merge or release readiness. No source or test changed during this completion recording.

The owner approved this plan on 2026-10-04 and selected a separate implementer and independent review for each stage. Execution is authorized within the Global Constraints; no Git, runtime or external operation is implied. Record acceptance only after the corresponding implementation and review evidence exists.
