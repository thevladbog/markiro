# US-09 Requests HTTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (owner-selected) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose authorized, revision-safe request management, immutable run reads,
retry and verified private downloads in the existing isolated US API.

**Architecture:** Reuse the request/validation/Prepare/lifecycle core. Add strict
public contracts, transaction-authorized projections and publication evidence
reads, then operation-local resource gates and downloads. Compose controllers
only after those components pass their own gates; never run the worker from HTTP.

**Tech Stack:** Node 24+, repository-pinned Corepack pnpm 11.22.0, TypeScript,
NestJS/Express, Zod, Drizzle/PostgreSQL, existing private S3 adapter, Vitest.
No new dependency, broker, application or hosted resource.

**Spec:** [Owner-approved Requests HTTP design](../specs/2026-10-05-us-09-requests-http-design.md).

Status: owner-approved implementation plan, 2026-10-05; Tasks 1–6 independently
accepted locally, including scoped compatibility corrections. Task 7 local gates
are complete; independent Task 7 and whole-increment review remain pending.
Preserved execution method: fresh executor per task, independent task review,
then one final whole-increment review. Task acceptance is recorded separately below.
The later final-fix checkpoint records the completed review findings and pending
scoped re-review without replacing historical invocation counts.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve existing changes and primary checkout.
- No commit, push, PR, merge, release, provisioning, deployment, base-database migration or real-data use is authorized by this document.
- The worker remains a separate process. The HTTP process never claims work or instantiates a polling worker.
- Use `/traceability/requests` and `/traceability/export-runs`, matching the actual US API; no `/api/us/traceability/...` compatibility alias.
- All routes require `US_FSMA204_PROCESSOR`, actual US session/MFA and current transaction-reloaded membership; tenant and actor are server-resolved.
- Reads require `traceability.read`; CRUD requires `traceability.qa.manage`; Validate/acknowledgement/Prepare/retry require QA + `traceability.export.read`; download requires export without QA.
- Missing, invalid or dirty checked build identity does not stop the whole API. Validate and Prepare refuse without a checked clean descriptor.
- Without configured private package storage, Validate remains available with a checked build; Prepare, manual retry and artifact download are unavailable.
- Package configuration uses only the six existing `US_REQUEST_PACKAGE_S3_*` fields; no Plan/general S3 fallback or public storage URL.
- Compatible internal callers retain their existing command behavior. Preserve existing command digests, old v1/v2 snapshots and receipts; do not rewrite old rows.
- Validate checks expected revision; first Prepare also checks validation digest inside the same locked transaction. Same-key HTTP replay compares its extra preconditions to frozen evidence, not current live state.
- Capture retains 500 revisions and 16 MiB snapshot limits; no truncation or scope retargeting.
- Default limit 25, maximum 50; canonical offset is 0–10000. Duplicate/noncanonical/unknown query parameters are rejected.
- Create/PATCH alone allow a 256 KiB uncompressed JSON body; commands retain 16 KiB. Host/Origin/MFA/no-store/no inflation stay unchanged.
- Preserve package caps: ZIP 64 MiB, workbook and validation 16 MiB each, Plan 8,000,000 bytes, report 4 MiB, manifest 1 MiB.
- `SHA256SUMS` remains inside the immutable ZIP; it has no standalone artifact row or fabricated download endpoint.
- Do not expose lease tokens, private object keys, credentials, checkpoint models, raw input snapshots or provider errors. Lists/errors exclude requester contact.
- Download reauthorizes and audits after verified I/O before releasing any bytes; no transaction is held over storage I/O.
- Closing does not delete or cancel already accepted runs. Saved validation is not a fresh source-readiness claim; ready incomplete is not export-ready.
- Owned default clients are disposed; explicitly injected test transports remain caller-owned. Production entries receive no test/root/build overrides.
- Use only explicit `US_TEST_DATABASE_URL` and random fixture-owned databases; never load primary `.env`, migrate/reset the base DB or mutate shared installation links.
- No UI/proxy change, manual/browser, real MinIO/S3, hosted, OS-reboot, backup/restore, remote CI or regulatory acceptance; business readiness and operational locks remain closed.

## Review Focus

1. An old screen submits Validate/Prepare after another editor commits: locked revision/digest checks must conflict; matching old-key replay after drift/close must still return the original run. Task 3.
2. A user's export role disappears while a GET is held, or final audit fails: no file bytes or successful release acknowledgement may escape. Task 5.
3. A descriptor/dependency changes after a successful availability check: next Validate/Prepare must recheck and refuse, while CRUD/reads/other US features remain available. Tasks 4 and 6.
4. Encoded/case/trailing-slash routes, implicit HEAD, Range, conditional headers, duplicate queries and large valid escaped-Unicode scope: no alias, audit bypass or accidental body-limit widening. Tasks 1 and 6.
5. Legacy v1 history, many retry cycles, a partial/corrupt ready publication or edited live requester: reads remain bounded, use frozen identity, never leak internals or certify newer data. Task 2.

## Baseline and execution preparation

The current HEAD is `f06aaef2b923a7ae902c0fabacfd0c4712c127c3`; verify it rather
than silently inheriting a changed checkout. The linked worktree already exists;
do not create another checkout or link mutable `node_modules`/`dist` elsewhere.
Read root `AGENTS.md`, `docs/us/development-isolation.md`, the spec and affected
code/tests. This US checkout currently has no scoped API guide; recheck that fact.
No local Graphify graph exists; do not create one as implementation setup.

Earlier worker-runtime code, CI and documents are uncommitted and owned by the
preceding increment. Its accepted 26-path final snapshot is under
`.superpowers/sdd/2026-10-05-us-09-worker-runtime/final-fix1-after/manifest.json`.
Capture a new explicit-path before snapshot for each task; approved overlaps are
not permission to bundle unrelated changes. Use a distinct ignored ledger
`.superpowers/sdd/2026-10-05-us-09-requests-http/`. Preserve prior ledgers.

Commands below run from the US worktree root. DB tests use:

```sh
env -u DATABASE_URL US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/us-request-store.e2e.test.ts --maxWorkers=1
```

`createUsProfileTestDatabase` alone allocates/migrates/drops an owned random DB.
If loopback is sandbox-denied, record the actual EPERM and seek bounded local
network execution; do not rewrite production behavior or count a skip as proof.
No projected clock or durable lease/checkpoint rewrite is needed for HTTP tests.

Task endings replace the skill's commit step: complete tests/self-review, record
owned paths/hashes and actual outputs, snapshot the diff, receive independent
review. No source commit is authorized. Do not mark pending sessions as passing.

## File and interface map

- `packages/platform-contracts/src/traceability/requests-http.ts`: public-only input/output/query schemas and inferred types; keep `requests.ts` legacy command shapes.
- `apps/api/src/modules/traceability/requests/us-request-http-context.ts`: server context and current processor/capability authorization; not a client DTO.
- `us-request-publication-read.ts`: read-only checked committed publication evidence, shared by public reads/downloads; no reconciliation or deletion.
- `us-request-read.ts`: authorized paged request/run/attempt projections, no storage access.
- `us-request-http-commands.ts`: transport command facade, current target preflight, dependency gates and immutable acknowledgements.
- Existing request/validation/Prepare/lifecycle files: optional internal audit correlation and explicit HTTP command paths with transactional preconditions; unchanged legacy calls.
- `apps/api/src/deployment/us-request-http-resources.ts`: checked build/config/client ownership only, no DB or scheduler.
- `us-request-download.ts`: authorized published-byte read, final reauthorization and release audit.
- `apps/api/src/deployment/us-request-http-runtime.ts`: compose those components and merge descriptive availability into detail.
- `us-requests.controller.ts`, `us-export-runs.controller.ts`, `us-request-http-routes.ts`: exact HTTP/OpenAPI methods and canonical guard/query rules.
- Bootstrap/runtime/module/middleware: US-only registration, raw config snapshot, read-only preflight and cleanup.
- Focused tests, check-only workflow/isolation contracts and US docs own the integration evidence.

Module paths without a prefix above are inside
`apps/api/src/modules/traceability/requests/`, except the explicitly named
deployment files. Every new file is assigned below.

### Task 1: Strict public command and projection contracts

**Files**

- Create `packages/platform-contracts/src/traceability/requests-http.ts`.
- Modify `packages/platform-contracts/src/index.ts` explicit exports only.
- Create `packages/platform-contracts/test/us-requests-http.test.ts`.

**Interfaces**

Consumes existing request create/update/close/scope and export-finding schemas.
Produces exported schemas/types named below; later tasks must use these names.

- `usRequestListQuerySchema` / `UsRequestListQuery`: optional exact requestNumber/status; numeric output limit/offset defaults 25/0 with canonical string input.
- `usRequestHistoryQuerySchema` / `UsRequestHistoryQuery`: only that pagination.
- `usRequestValidateHttpBodySchema` / `UsRequestValidateHttpBody`: expectedRevision.
- `usRequestWarningAckHttpBodySchema` / `UsRequestWarningAckHttpBody`: expectedRevision/digest/reason (3–2000, canonical non-control text).
- `usRequestPrepareHttpBodySchema` / `UsRequestPrepareHttpBody`: existing mode/key plus expectedRevision/validationDigest; no change to legacy Prepare schema.
- `usRequestRetryHttpBodySchema` / `UsRequestRetryHttpBody`: expectedLifecycleVersion/reason/idempotencyKey matching existing worker parser.
- `usRequestArtifactKindSchema` / `UsRequestArtifactKind`: exactly the six published kinds in spec section 7.
- `usRequestAvailabilitySchema` / `UsRequestAvailability`: build `available|unavailable|unknown`, packageStorage `configured|unconfigured|invalid`; configured does not claim network health.
- `usRequestSummarySchema` / `UsRequestSummary`: id, requestNumber, revision, status, receivedAt/dueAt, createdBy/createdAt/updatedAt/closedAt, lastValidatedAt; no contact/scope/frozen payload.
- `usRequestDetailResponseSchema` / `UsRequestDetailResponse`: request summary plus saved requester fields/scope; savedValidation (saved digest/time/count/findings, freshness `not_rechecked`) or null; warningAcknowledgement or null; latestRun or null; availability.
- `UsRequestDetailData = Omit<UsRequestDetailResponse, "availability">`, exported type.
- `usRequestListResponseSchema`: items plus limit/offset/hasMore; output type `UsRequestListResponse`.
- `usRequestRunSummarySchema` / `UsRequestRunSummary`: runId/requestId/requestRevision/runRevision, mode/status/exportReady, operator, named digests, lifecycle/cycle/attempt counts, safe recognized failureCode, started/worker-start/render/completion/next-attempt times, provenance `trusted_synthetic|not_verified`.
- `usRequestRunDetailSchema` / `UsRequestRunDetail`: run summary, checked frozen requester/scope/findings, latestAttempt or null, bounded safe artifact descriptors (no keys), missing-file evidence when generated or null.
- `usRequestRunListResponseSchema` / `UsRequestRunListResponse`, `usRequestAttemptListResponseSchema` / `UsRequestAttemptListResponse`: bounded paged summaries; attempt items expose id/number/cycle/status/times/recognized failure/retryability, no token/private state.
- `usRequestCommandResponseSchema` / `UsRequestCommandResponse`: httpRequestId/requestId/revision/status, never a claim of current future state.
- `usRequestValidationHttpResponseSchema` / `UsRequestValidationHttpResponse`: existing validation response fields plus httpRequestId.
- `usRequestPrepareResponseSchema` / `UsRequestPrepareResponse`: httpRequestId/requestId/requestRevision/runId/runRevision/mode/idempotencyKey/scopedContentDigest; no invented replay/status flag.
- `usRequestRetryResponseSchema` / `UsRequestRetryResponse`: httpRequestId/runId/cycle/lifecycleVersion/requestedBy/idempotencyKey; exclude tenant/key authority.

- [ ] **Step 1: Write focused failing schema tests.** Include public-extra-field denial and unchanged legacy body behavior:

```ts
const key = "11111111-1111-4111-8111-111111111111";
const body = {
  mode: "available_records_incomplete" as const,
  idempotencyKey: key,
  expectedRevision: 1,
  validationDigest: "a".repeat(64),
};
expect(usRequestPrepareHttpBodySchema.safeParse(body).success).toBe(true);
expect(usTraceRequestPrepareBodySchema.safeParse(body).success).toBe(false);
expect(
  usTraceRequestPrepareBodySchema.safeParse({
    mode: body.mode,
    idempotencyKey: key,
  }).success,
).toBe(true);
expect(usRequestPrepareHttpBodySchema.safeParse({ ...body, tenantId: "foreign" }).success).toBe(
  false,
);
for (const limit of ["01", "1e1", "1.0", " 1", "51"])
  expect(usRequestListQuerySchema.safeParse({ limit }).success).toBe(false);
```

- [ ] **Step 2: Run RED:** `corepack pnpm@11.22.0 --filter @markiro/platform-contracts exec vitest run test/us-requests-http.test.ts`; missing public exports must fail before implementation.
- [ ] **Step 3: Implement schemas using existing strict primitives.** Numeric-query pattern is anchored decimal, transformed only after bounds; do not use permissive numeric coercion. The public envelope extension is:

```ts
export const usRequestPrepareHttpBodySchema = usTraceRequestPrepareBodySchema
  .extend({
    expectedRevision: z.number().int().positive(),
    validationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type UsRequestPrepareHttpBody = z.infer<typeof usRequestPrepareHttpBodySchema>;
```

Map public states/times/nullable fields explicitly. Check enum/count/timing/mode
invariants and reject private extras; no broad casts or imported API dependencies.
Add valid escaped-Unicode scope and worst valid lists to contract fixtures for
Task 6's body-cap test. Artifact byte maxima derive from the documented caps.

- [ ] **Step 4: GREEN/full contracts:** focused tests, existing `test/us-requests.test.ts`, then contracts test/typecheck/lint/build and owned formatting. Verify compiled exports before consumers.
- [ ] **Step 5: Self-review/report/snapshot and independent review; no commit.** Record exact schemas/types and no legacy-field/digest change.

### Task 2: Transaction-authorized bounded reads and committed publication evidence

**Files**

- Create `apps/api/src/modules/traceability/requests/us-request-http-context.ts`.
- Create `apps/api/src/modules/traceability/requests/us-request-read.ts`.
- Create `apps/api/src/modules/traceability/requests/us-request-publication-read.ts`.
- Modify `apps/api/src/modules/traceability/requests/us-request-worker-publication.ts` only to delegate shared evidence validation; preserve existing queries, locks, transitions and exported interfaces. Execution ruling: the private validators cannot be reused without this small extraction.
- Create `apps/api/test/us-request-read.e2e.test.ts`.
- Create `apps/api/test/us-request-publication-read.e2e.test.ts`.
- Read existing run-evidence, worker-publication/winner validation and Plan read services; do not expose `lifecycle.read` or invoke `reconcile`.

**Interfaces**

```ts
export interface UsRequestHttpContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly httpRequestId: string;
}
// In us-request-http-context.ts: capabilities are UsCapability[] from domain.
export async function authorizeUsRequestHttp(
  tx: UsMasterDataTransaction, ctx: UsRequestHttpContext,
  capabilities: readonly UsCapability[],
): Promise<void>;

// UsRequestReadStore(db: Db)
list(ctx: UsRequestHttpContext, query: unknown): Promise<UsRequestListResponse>;
get(ctx: UsRequestHttpContext, id: unknown): Promise<UsRequestDetailData>;
listRuns(ctx: UsRequestHttpContext, id: unknown, query: unknown): Promise<UsRequestRunListResponse>;
getRun(ctx: UsRequestHttpContext, id: unknown): Promise<UsRequestRunDetail>;
listAttempts(ctx: UsRequestHttpContext, id: unknown, query: unknown): Promise<UsRequestAttemptListResponse>;

export interface UsRequestPublishedState {
  readonly run: UsTraceExportRunRow;
  readonly expectation: UsWorkerPackageExpectation;
  readonly artifacts: readonly UsWorkerObjectEvidence[];
}
export async function readUsRequestPublishedState(
  tx: UsMasterDataTransaction, tenantId: string, runId: string,
): Promise<UsRequestPublishedState>;
```

The last helper is internal checked evidence, not caller authorization. It reads
one committed ready winner under the transaction; no storage call or mutation.

- [ ] **Step 1: Write failing disposable-DB tests.** Setup each suite using `createUsProfileTestDatabase(base)` and `seedCompleteReceiving(f.db)`; contexts use real seeded actor/tenant and `randomUUID()` correlation. Create requests through `UsRequestStore`, runs through existing package/worker fixtures, never insert fabricated ready evidence.

```ts
const foreign = await seedCompleteReceiving(f.db);
const row = await new UsRequestStore(f.db).create(foreign.tenant, foreign.actor, {
  requestNumber: randomUUID(),
  requesterName: "Synthetic foreign requester",
  requesterOrganization: null,
  requesterContact: "private@example.test",
  receivedAt: "2026-10-05T00:00:00Z",
  scope: { lotId: foreign.lot },
});
await expect(reads.get(ctx, row.id)).rejects.toMatchObject({ status: 404 });
const page = await reads.list(ctx, {});
expect(JSON.stringify(page)).not.toContain("private@example.test");
```

Add role/profile denial, saved-validation-not-fresh marker, changed live requester
versus frozen run, v1 compatibility/not-verified provenance, malformed saved row,
limit/offset ordering/hasMore and many cycles' bounded attempt pages. Verify no
write/audit/lease recovery on reads. Partial ready evidence and referenced-object
state/hash/size/winner mismatches must refuse, not produce a download descriptor.

- [ ] **Step 2: RED:** run the two new suites serially with the explicit US URL. Missing read APIs must fail, not skip.
- [ ] **Step 3: Implement current authority before lookup/projection, in a consistent transaction.** Use tenant predicates on every relation; validate stored output without repair. The lookup boundary is:

```ts
await authorizeUsRequestHttp(tx, ctx, [US_CAPABILITY.READ]);
const id = parseMasterDataInput(platformUuidSchema, rawId);
const [row] = await tx
  .select()
  .from(schema.traceRequests)
  .where(and(eq(schema.traceRequests.tenantId, ctx.tenantId), eq(schema.traceRequests.id, id)))
  .limit(1);
if (!row) throw new NotFoundException({ code: "us_request_not_found" });
```

Request lists select only needed summary columns. Run pages first select bounded
IDs, then load/verify/project one frozen run at a time under the same snapshot;
do not retain 50 full 16-MiB payloads. Detail consumes the existing v1/v2 verifier.
Attempt pages read only safe fields and expose unknown legacy prefix honestly.
Use limit+1 for hasMore; never silently claim all history/export scope.

For ready publication, match exactly one succeeded attempt (bounded lookup),
checkpoint/expectation, run completion/render/timing/count/mode and at most six
published rows against winning object intents. Intents must be `referenced`,
verified, not fenced/deleted, with publication timestamps/hash/size/type/key
binding identical to the existing winner validation. Build safe evidence via
`usWorkerIntentEvidence`. Limit queries to detect extra rows (limit 7 for objects).
No candidate/verified-only intent becomes published authority. Reuse the existing
parsers and winner rules, without changing worker transitions or persisted bytes.

Execution clarification: immutable publication SQL guards must not be disabled
for corruption fixtures. A test-file-local read transport may project specific
corrupt fields onto actual SQL results from a real worker-published owned-DB run;
underlying queries, authorization and transactions remain real. Report this fault
injection separately from persisted-row and positive DB evidence.

Confirmed compatibility correction during Task 2: the existing store mixes DB
creation timestamps with JavaScript update/closure timestamps. The public
contract must preserve those recorded instants without requiring cross-clock
update/closure-versus-creation monotonicity. Its schema/test files may be amended
for this correction; no producer protocol, historical row or worker timing rule
is changed. Keep lifecycle/nullability and business deadline predicates.

- [ ] **Step 4: GREEN/regressions:** new suites plus existing run-evidence, versions, worker-publication and worker-cleanup suites on owned DBs; API typecheck/lint/build. Include a current ready full/incomplete package produced by the real worker fixture.
- [ ] **Step 5: Self-review/report/snapshot and independent review; no commit.** Prove bounded reads, no private projection and no reconciliation side effects.

### Task 3: Transactional HTTP preconditions, correlation and command facade

**Files**

- Create `apps/api/src/modules/traceability/requests/us-request-http-commands.ts`.
- Modify existing `us-request-store.ts`, `us-request-validation.ts`, `us-request-prepare.ts`, `us-request-worker-lifecycle.ts` in the same directory.
- Create `apps/api/test/us-request-http-commands.e2e.test.ts`.
- Extend existing store/validation/Prepare/lifecycle regressions only for compatibility witnesses.

**Interfaces**

Add explicit HTTP entry methods while preserving existing internal signatures:

```ts
// UsRequestValidationStore
validateHttp(tenantId: string, actor: string, id: string,
  body: UsRequestValidateHttpBody, build: UsExportBuildIdentity,
  httpRequestId: string): ReturnType<UsRequestValidationStore["validate"]>;
acknowledgeWarningsHttp(tenantId: string, actor: string, id: string,
  body: UsRequestWarningAckHttpBody, httpRequestId: string)
  : ReturnType<UsRequestValidationStore["acknowledgeWarnings"]>;
// UsRequestPrepareStore
prepareHttp(tenantId: string, actor: string, id: string,
  body: UsRequestPrepareHttpBody, build: UsExportBuildIdentity,
  httpRequestId: string): Promise<UsTraceExportRunRow>;
// CRUD optional final httpRequestId; retry optional fourth httpRequestId.
// Existing omitted arguments retain null audit correlation and old behavior.

export interface UsRequestHttpGates {
  loadBuild(): Promise<LoadedUsRequestBuildDescriptor>;
  requirePackageStore(): UsRequestPackageArtifactStore;
}
// UsRequestHttpCommands(db: Db, gates: UsRequestHttpGates)
create(ctx: UsRequestHttpContext, body: unknown): Promise<UsRequestCommandResponse>;
update(ctx: UsRequestHttpContext, id: unknown, body: unknown): Promise<UsRequestCommandResponse>;
close(ctx: UsRequestHttpContext, id: unknown, body: unknown): Promise<UsRequestCommandResponse>;
validate(ctx: UsRequestHttpContext, id: unknown, body: unknown): Promise<UsRequestValidationHttpResponse>;
acknowledgeWarnings(ctx: UsRequestHttpContext, id: unknown, body: unknown): Promise<UsRequestCommandResponse>;
prepare(ctx: UsRequestHttpContext, id: unknown, body: unknown): Promise<UsRequestPrepareResponse>;
retry(ctx: UsRequestHttpContext, id: unknown, body: unknown): Promise<UsRequestRetryResponse>;
```

- [ ] **Step 1: RED tests on real locks, not only mocks.** Validate revision 1 while another connection updates to revision 2 behind a held request row; ensure no new validation/run and exact correlated conflict audit. Prepare wrong digest/revision, concurrent identical keys, matching replay after edit/close, divergent envelope and changed source/Plan/build. Preserve v1 receipts and legacy internal digest/replay assertions.

```ts
const request = await requests.create(ctx.tenantId, ctx.userId, createBody);
await requests.update(ctx.tenantId, ctx.userId, request.id, {
  expectedRevision: request.revision,
  requesterName: "Changed synthetic requester",
});
await expect(
  validation.validateHttp(
    ctx.tenantId,
    ctx.userId,
    request.id,
    { expectedRevision: request.revision },
    build,
    ctx.httpRequestId,
  ),
).rejects.toMatchObject({ status: 409 });
```

Use existing owned DB/source/Plan fixtures for createBody/build; they are declared
in this suite as in the existing request tests. No new fake core or clock seam.
Also test gate rejection ordering, original initiator revocation for retry,
no-op update audit count unchanged and core audit failure rolling back mutation.

Add a real blocking witness to the same suite. Define local
`waitForRequestBlock(pool: Pool, blockerPid: number): Promise<void>` using the
following bounded read-only query. API has no direct pg dependency; derive its
existing Pool type through the owned DB interface:
`import type { createDb } from "@markiro/db"; type Pool = ReturnType<typeof createDb>["pool"];`
A fixed sleep alone is not proof of a row-lock race:

```ts
for (let probe = 0; probe < 100; probe++) {
  const state = await pool.query<{ blocked: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked",
    [blockerPid],
  );
  if (state.rows[0]?.blocked) return;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
throw new Error("Expected request-row lock was not observed");
```

The test takes an owned connection, begins a transaction, locks its request row
and reads that connection's PID. Start ValidateHttp with the old revision, wait
for the blocking witness, then update only this fixture's mutable requester name
and revision and COMMIT before awaiting the rejection. This SQL fault fixture is
not a claimed audited editor; the service under test must retry its existing
repeatable-read boundary and record its own precise 409 audit. Use try/finally
ROLLBACK/release and verify no saved validation/run was created.

```ts
await blocker.query("BEGIN");
const pid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
if (!pid.rows[0]) throw new Error("Missing owned blocker PID");
await blocker.query("SELECT id FROM trace_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
  ctx.tenantId,
  request.id,
]);
const pending = validation.validateHttp(
  ctx.tenantId,
  ctx.userId,
  request.id,
  { expectedRevision: request.revision },
  build,
  ctx.httpRequestId,
);
const settlement = pending.then(
  (value) => ({ value }),
  (error) => ({ error }),
);
await waitForRequestBlock(f.pool, pid.rows[0].pid);
await blocker.query(
  "UPDATE trace_requests SET requester_name=$3,revision=revision+1 WHERE tenant_id=$1 AND id=$2",
  [ctx.tenantId, request.id, "Concurrent synthetic editor"],
);
await blocker.query("COMMIT");
await expect(pending).rejects.toMatchObject({ status: 409 });
await settlement;
```

- [ ] **Step 2: Run RED:** the new suite and affected legacy tests serially with explicit US URL; record exact missing-precondition failure.
- [ ] **Step 3: Implement shared transaction paths, not controller pre-read/write logic.** After core authorization and row lock, new HTTP Validate/ack check expectedRevision. First Prepare additionally checks saved validation digest; after saved receipt lookup its HTTP replay compares the verified frozen revision/digest instead of current request fields:

```ts
if (request.revision !== body.expectedRevision)
  throw new ConflictException({ code: "us_request_revision_conflict" });
if (request.lastValidationDigest !== body.validationDigest)
  throw new ConflictException({ code: "us_request_validation_stale" });
// Replay branch, using verifyUsRequestRunEvidence(stored, tenantId):
if (
  frozen.validationSnapshot.request.revision !== body.expectedRevision ||
  stored.scopedContentDigest !== body.validationDigest
)
  throw new ConflictException({ code: "us_request_idempotency_conflict" });
```

Keep the legacy commandDigest formula and old body parser. Public mode/key are
parsed by their separate schema; old internal methods call the same transaction
path without HTTP guards. Validate frozen bindings before acknowledging a replay;
never check live open/revision first for a saved key. Correlation is written in
the existing atomic audit or its exact rejection audit; no second successful
audit is appended after a mutation already committed. Unchanged update retains
no extra business audit.

The facade preflights current processor/capabilities and tenant target existence
before dependency gates, so a wrong-tenant target remains 404 even without build/
storage. This preflight grants no write authority: core reauthorizes/rechecks in
its command transaction. Retry preflight also checks original initiator before
storage availability. Gate refusal has a sanitized correlated rejected audit;
do not leak private foreign facts. Validate/Prepare assert branded loaded identity,
not merely a caller-created build tuple. CRUD/ack/retry do not load a descriptor.
Return strict acknowledgements and require live GET recovery, not inferred state.

- [ ] **Step 4: GREEN:** new commands plus existing store/validation/Prepare/lifecycle/versions evidence and concurrent-lock cases, then API typecheck/lint/build. Assert exact actor/tenant/action/outcome/target/requestId/metadata, including null legacy correlation.
- [ ] **Step 5: Self-review/report/snapshot and independent review; no commit.** Record every amended internal signature and compatibility result.

### Task 4: Operation-local build/storage resources without changing API startup

**Files**

- Create `apps/api/src/deployment/us-request-http-resources.ts`.
- Create `apps/api/test/us-request-http-resources.test.ts`.
- Create `apps/api/test/us-request-http-resources.e2e.test.ts`.
- Consume existing descriptor/config/artifact classes; no public route registration yet.

**Interfaces**

```ts
export interface UsRequestHttpResourceDependencies {
  readonly loadBuild?: (source: NodeJS.ProcessEnv)
    => Promise<LoadedUsRequestBuildDescriptor>;
  readonly packageTransport?: UsRequestPackageArtifactS3Transport;
}
// UsRequestHttpResources(source: NodeJS.ProcessEnv, deps?: UsRequestHttpResourceDependencies)
loadBuild(): Promise<LoadedUsRequestBuildDescriptor>;
requirePackageStore(): UsRequestPackageArtifactStore;
availability(): Promise<UsRequestAvailability>;
dispose(): void;
```

The class implements Task 3's gate interface. These dependencies are trusted test
composition, never env/CLI/HTTP overrides. No database connection is owned here.

- [ ] **Step 1: RED unit and DB integration tests.** Missing/dirty/tampered/mixed descriptor, invalid partial config, absent storage with successful Validate, config present with provider-double Prepare, no implicit Plan/general fallback, lazy client creation and correct disposal ownership. Validate after a successful availability check then mutate only an owned descriptor/output and require refusal without changing saved validation.

```ts
const buildFixture = await createUsRequestBuildFixture();
const document = await captureUsRequestBuildDescriptor(buildFixture.cleanBuild, buildFixture.roots);
await buildFixture.writeDocument(document);
const source = await localBuildEnv();
const resources = new UsRequestHttpResources(source, {
  loadBuild: (raw) => loadUsRequestBuildDescriptor(raw, buildFixture.roots),
});
expect((await resources.availability()).build).toBe("available");
await buildFixture.writeDocument({ ...document, build: { ...document.build, dirty: true } });
await expect(resources.loadBuild()).rejects.toMatchObject({ status: 503 });
resources.dispose();
await buildFixture.dispose();
```

Put all owned setup under try/finally in the real test, including failed setup.
Use `storageEnvironment()` only with the actual test adapter; do not probe MinIO.

- [ ] **Step 2: RED:** focused resource test files; missing class/gates must fail. DB cases use the explicit isolated URL.
- [ ] **Step 3: Implement a fixed raw-config snapshot and operation-local checks.** Default load calls `loadUsRequestBuildDescriptor(source)` and asserts its brand each time; sanitized `us_request_build_unavailable` on refusal. Config loader result null means unconfigured; invalid means invalid, with no saved provider error. Create a package client lazily only on requirePackageStore; unavailable throws `us_request_package_storage_unavailable`. Availability catches build refusal, never declares mere configured storage healthy. Dispose exactly owned active resources and respect injected transport ownership.

```ts
const loaded = await (deps.loadBuild ?? loadUsRequestBuildDescriptor)(source);
assertLoadedUsRequestBuildDescriptor(loaded);
return loaded;
```

The default path has no roots argument, no ambient SHA/version override and no
forever-success cache. This class has no runOne, connect, scheduler or migration.

- [ ] **Step 4: GREEN:** both resource suites, descriptor/build-command/runtime and command-facade regression; API typecheck/lint/build. Keep compiled output frozen while test processes run.
- [ ] **Step 5: Self-review/report/snapshot and independent review; no commit.** Distinguish fixture clean identity from the dirty real checkout and configured versus operational storage.

### Task 5: Verified private downloads, final reauthorization and exact release audit

**Files**

- Create `apps/api/src/modules/traceability/requests/us-request-download.ts`.
- Create `apps/api/test/us-request-download.e2e.test.ts`.
- Consume Task 2's publication read and Task 4's package resource gate.

**Interfaces**

```ts
export interface UsRequestDownload {
  readonly bytes: Buffer;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
}
// UsRequestDownloadStore(db: Db, packageStore: () => UsRequestPackageArtifactStore)
download(ctx: UsRequestHttpContext, rawRunId: unknown, rawKind: unknown)
  : Promise<UsRequestDownload>;
```

- [ ] **Step 1: RED tests with genuinely published fixtures.** Create via `createUsRequestWorkerFixture(f.db, {mode: "available_records_incomplete", withPlan: false})`, run its worker and check `verifyReady()`; download with an auditor membership, not a fabricated artifact insert. Test all six kinds when present, absent optional files, foreign targets, queued/failed runs, candidate intent substitution, corruption and cap/timeout failures. A held GET must allow another real connection to revoke membership before final authorization.

```ts
const published = await createUsRequestWorkerFixture(f.db, {
  mode: "available_records_incomplete",
  withPlan: false,
});
await published.worker.runOne();
await published.verifyReady();
const ctx = {
  tenantId: published.source.tenantId,
  userId: published.source.actorId,
  httpRequestId: randomUUID(),
};
const downloads = new UsRequestDownloadStore(f.db, () => published.store);
const result = await downloads.download(ctx, published.scope.runId, "package_zip");
expect(createHash("sha256").update(result.bytes).digest("hex")).toBe(result.sha256);
expect(result.bytes.length).toBe(result.byteSize);
```

The full suite uses try/finally and the existing transport `faults.before/after`
for held I/O/type/hash faults. Assert byte release rejected after membership revoke
or audit failure; successful audit action is `traceability.request.artifact_downloaded`,
targetType `trace_export_run`, targetId run ID, correlation column is HTTP ID.
Metadata records business requestId/revisions/mode/kind/size/hash without key/contact.

Pin Review Focus 2 with a real held GET and real membership update. Import the
existing AWS GetObjectCommand plus schema/and/eq, and initialize both callbacks
before starting the operation:

```ts
let unblock: () => void = () => {};
let entered: () => void = () => {};
const release = new Promise<void>((resolve) => {
  unblock = resolve;
});
const observed = new Promise<void>((resolve) => {
  entered = resolve;
});
published.storage.faults.before = async (command) => {
  if (command instanceof GetObjectCommand) {
    entered();
    await release;
  }
};
const pending = downloads.download(ctx, published.scope.runId, "package_zip");
const settlement = pending.then(
  (value) => ({ value }),
  (error) => ({ error }),
);
await observed;
await f.db
  .update(schema.member)
  .set({ role: "member" })
  .where(and(eq(schema.member.organizationId, ctx.tenantId), eq(schema.member.userId, ctx.userId)));
unblock();
await expect(pending).rejects.toMatchObject({ status: 403 });
await settlement;
```

Bound the observed wait and always unblock/settle in finally. Assert no successful
download audit for ctx.httpRequestId and no returned bytes; explicitly permitted
rejected audit is checked for exact actor/tenant/target/code/correlation.

- [ ] **Step 2: RED:** new DB suite with explicit US URL; missing download service must fail.
- [ ] **Step 3: Implement two DB boundaries around verified I/O.** First transaction authorizes export/processor, parses target/kind, obtains checked ready evidence and selects the exact artifact. Storage access uses that evidence only. Final transaction reauthorizes and rereads the same immutable publication/artifact identity, then commits exact audit; only afterwards return bytes:

```ts
const resolved = await db.transaction(async (tx) => {
  await authorizeUsRequestHttp(tx, ctx, [US_CAPABILITY.EXPORT_READ]);
  const runId = parseMasterDataInput(platformUuidSchema, rawRunId);
  const kind = parseMasterDataInput(usRequestArtifactKindSchema, rawKind);
  const state = await readUsRequestPublishedState(tx, ctx.tenantId, runId);
  const evidence = state.artifacts.find((item) => item.kind === kind);
  if (!evidence) throw new NotFoundException({ code: "us_request_artifact_not_found" });
  return { state, evidence };
});
const { state: published, evidence } = resolved;
const frozen = verifyUsRequestRunEvidence(published.run, ctx.tenantId);
const bytes = await packageStore().readVerified(
  { tenantId: ctx.tenantId, runId: published.run.id },
  evidence,
);
await db.transaction(async (tx) => {
  await authorizeUsRequestHttp(tx, ctx, [US_CAPABILITY.EXPORT_READ]);
  const current = await readUsRequestPublishedState(tx, ctx.tenantId, published.run.id);
  const same = current.artifacts.find((item) => item.kind === evidence.kind);
  if (
    !same ||
    same.id !== evidence.id ||
    same.attemptId !== evidence.attemptId ||
    same.objectKey !== evidence.objectKey ||
    same.name !== evidence.name ||
    same.mediaType !== evidence.mediaType ||
    same.byteSize !== evidence.byteSize ||
    same.sha256 !== evidence.sha256 ||
    current.run.scopedContentDigest !== published.run.scopedContentDigest ||
    current.run.completedAt?.getTime() !== published.run.completedAt?.getTime()
  )
    throw new ServiceUnavailableException({ code: "us_request_publication_invalid" });
  await tx.insert(schema.tenantAuditEvents).values({
    organizationId: ctx.tenantId,
    actorUserId: ctx.userId,
    requestId: ctx.httpRequestId,
    action: "traceability.request.artifact_downloaded",
    outcome: "success",
    targetType: "trace_export_run",
    targetId: published.run.id,
    before: null,
    after: {
      requestId: published.run.requestId,
      requestRevision: frozen.validationSnapshot.request.revision,
      runRevision: published.run.revision,
      mode: published.run.mode,
      kind: evidence.kind,
      byteSize: evidence.byteSize,
      sha256: evidence.sha256,
    },
  });
});
return {
  bytes,
  filename: evidence.name,
  mediaType: evidence.mediaType,
  byteSize: evidence.byteSize,
  sha256: evidence.sha256,
};
```

Use the actual Task 2 read helper in both transactions; none remains open over
I/O. No current descriptor or QA requirement for downloads. Failure audits contain
only facts already authorized; failures before identity do not invent a business
actor. Audit/revocation failures cannot release buffered bytes. Closing preserves
old downloads. No public keys, presigned URLs, global orphan sweep or file deletion.

- [ ] **Step 4: GREEN:** downloads/publication-read/worker-publication/artifact adapter and Plan PDF boundary regressions; API typecheck/lint/build. Provider-double results are not S3 verification.
- [ ] **Step 5: Self-review/report/snapshot and independent review; no commit.** Record held-I/O revocation and audit rollback evidence, not just happy-path hashes.

### Task 6: Canonical controllers, HTTP composition, MFA and OpenAPI

**Files**

- Create `apps/api/src/deployment/us-request-http-runtime.ts`.
- Create `apps/api/src/deployment/us-request-http-routes.ts`.
- Create `apps/api/src/deployment/us-requests.controller.ts`.
- Create `apps/api/src/deployment/us-export-runs.controller.ts`.
- Modify `apps/api/src/deployment/us-runtime.ts`, `us-bootstrap.ts`, `us-development.module.ts`, `us-http.ts`.
- Create `apps/api/test/support/us-request-http-fixture.ts` and `apps/api/test/us-request-http.e2e.test.ts`.
- Extend `apps/api/test/deployment-entry.test.ts` for unchanged readiness/RU denial where needed.
- Extend `apps/api/test/us-plan-artifact-config.test.ts` to locate the retained Plan preflight semantically, preserving its exact column assertions rather than assuming it is the first query; new Requests preflight is a separate read-only query.

**Interfaces**

`UsRequestHttpRuntime(db, source, resourceDeps?)` owns `reads`, `commands`,
`downloads`, `resources`; `get(ctx,id)` merges `reads.get` with descriptive
availability and validates `usRequestDetailResponseSchema`; `dispose()` destroys
resources, never a caller's DB. Add `UsRuntime.requestHttp`. Bootstrap's existing
raw/connect/Plan-transport arguments stay compatible; optional fourth trusted
resourceDeps reaches only owned test composition. Real entry supplies none.
UsRuntime receives the bootstrap raw-config snapshot without requiring existing
direct test constructors to read process.env; absent new options means request
resources unavailable, not startup failure.

Canonical guard and two controllers implement exactly the spec's 13 routes.
These are business routes; preserve the existing CORS `OPTIONS` preflight
protocol response without dispatching business services or database readiness.
Public context comes only from `request.usPrincipal` and `request.usRequestId`:

```ts
const ctx: UsRequestHttpContext = {
  tenantId: request.usPrincipal.tenantId,
  userId: request.usPrincipal.userId,
  httpRequestId: request.usRequestId,
};
```

Reject missing context with UnauthorizedException, not a non-null assertion.

- [ ] **Step 1: RED actual HTTP/MFA fixture.** Reuse `UsAuthTestClient`, real password/TOTP enrollment and `listenOnLoopback` patterns from `us-plan-http.e2e.test.ts`, with `createUsProfileTestDatabase` and a connect seam constrained to its allocated random DB. Host remains localhost:3100 and Origin localhost:5174 even on a temporary loopback listener. A test-only clean build fixture loader and provider double are explicit; never stamp real product output clean.

```ts
const response = await fixture.request("/traceability/requests", "POST", {
  requestNumber: randomUUID(),
  requesterName: "Synthetic HTTP requester",
  requesterOrganization: null,
  requesterContact: "private@example.test",
  receivedAt: "2026-10-05T00:00:00Z",
  scope: null,
});
expect(response.status).toBe(201);
const ack = usRequestCommandResponseSchema.parse(await response.json());
expect(response.headers.get("x-request-id")).toBe(ack.httpRequestId);
const alias = await fixture.request("/api/us/traceability/requests");
expect(alias.status).toBe(404);
```

The new fixture provides `request(path, method = "GET", body?, headers?)`,
`close()` and owned connection/context/resource handles. Build all setup with
try/finally cleanup. Never simulate business success with mocked HTTP handlers.
Cover every route, wrong tenant/profile/roles, no MFA, Host/Origin, JSON/inflation,
Unicode valid create/PATCH up to cap, oversize 413, small-command 16-KiB cap,
duplicate/unknown queries, uppercase/encoded/trailing/nested paths and unsupported
methods. HEAD/Range/conditional-header checks must use actual HTTP, not only mocks.

- [ ] **Step 2: RED:** new HTTP test serially with explicit US URL; endpoints currently return 404. Preserve existing cold OpenAPI loading timeout policy, no timeout inflation.
- [ ] **Step 3: Register US-only composition and annotate every route.** Canonical guard runs before controller handling, session guard supplies MFA; services retain transaction authorization. Add exact request body-parser exceptions only for POST collection/PATCH UUID, using existing 256-KiB parser. Extend read-only schema preflight without migration. Dispose request and Plan clients even if one teardown fails, then close the owned pool once; setup failure leaves no client/pool leak.

Binary output is always verified full bytes; avoid Express automatic conditional
send/ETag shortcuts and reject Range before invoking storage:

```ts
response
  .status(200)
  .set({
    "Content-Type": result.mediaType,
    "Content-Length": String(result.byteSize),
    "Content-Disposition": `attachment; filename="${result.filename}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  .end(result.bytes);
```

Filename is the checked fixed artifact name, never a user string. OpenAPI includes
strict inputs/projections, 400/401/403/404/409/413/415/503 and binary MIME schemas;
no raw storage error or unbounded payload. Query decoder checks original URL
duplicates before schema parsing. No main/RU controller registration or browser
proxy opening, no worker imported/created/started/claimed in bootstrap.

- [ ] **Step 4: GREEN:** complete HTTP suite and existing Plan/profile/session/deployment/OpenAPI suites, typecheck/lint/build. Exercise dirty/missing descriptor with real CRUD GETs still successful and Validate/Prepare 503; configured clean-fixture Validate without storage, package-unavailable commands, audited download after close. Compile/run old API and worker entry smoke only after other test processes finish.
- [ ] **Step 5: Self-review/report/snapshot and independent review; no commit.** Verify exact route/OpenAPI inventory and server correlation, no client authority or autostart.

### Task 7: Unconditional check-only CI ownership, complete local gates and documentation

**Files**

- Modify `.github/workflows/us-development.yml`.
- Modify `tools/us-development/test/isolation.test.mjs`.
- Modify `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`.
- Update this plan with factual checkpoints; do not mark the entire US-09 slice Done.
- Modify `tools/ci/affected.mjs` only if a read-only classification probe proves new paths are missed.
- Align absent-infrastructure gating in the new read/publication-read/HTTP-commands/download e2e suites with the existing explicit `describe.skipIf(!url)` convention; configured CI still runs every case with its exact isolated URL and zero relevant skips.

**Interfaces**

Consumes every exact new suite from Tasks 1–6 and compiled exports. Produces
unconditional serial US check ownership, factual local evidence and unchanged
operational locks/30-minute job limit. No new secret, service, upload or release.

- [ ] **Step 1: RED isolation-contract test.** Assert the workflow selects the contract suite and these eight API suites, with explicit synthetic URL, maxWorkers=1 and dependency builds before consumers:

```js
const workflow = readFileSync(".github/workflows/us-development.yml", "utf8");
const requestHttpSuites = [
  "us-request-read.e2e.test.ts",
  "us-request-publication-read.e2e.test.ts",
  "us-request-http-commands.e2e.test.ts",
  "us-request-http-resources.test.ts",
  "us-request-http-resources.e2e.test.ts",
  "us-request-download.e2e.test.ts",
  "us-request-http.e2e.test.ts",
  "openapi-coverage.test.ts",
];
for (const suite of requestHttpSuites) assert.ok(workflow.includes(suite));
```

Use the isolation suite's real workflow text/AST contract pattern; additionally
assert unconditional failure ownership, unchanged timeout and no DB fallback.

- [ ] **Step 2: RED:** `node --test tools/us-development/test/isolation.test.mjs` before changing workflow; missing suites must fail.
- [ ] **Step 3: Add check-only ownership and factual docs.** Keep existing Request/worker/Plan/runtime suites. Builds contract exports before API, then dedicated descriptor before compiled smoke. Split new contract/API tests into exact unconditional commands, not wildcard incidental inclusion. New read/download services are internal until controller registration; docs now supersede that earlier boundary only for the spec's exact paths. Preserve dirty publication refusal, original private storage limits and pending EN/ES UI/hosted acceptance. Probe affected.mjs on all new path classes; no speculative rewrite.
- [ ] **Step 4: Run complete final local gates once on frozen output.** Build shared db/domain/contracts and API/dedicated descriptor; run full contracts gates; run all eight new API suites serially with explicit US URL and zero relevant DB skips; record actual elapsed time. Run current Requests/worker/Plan/export regression union serially with explicit URL, avoiding double-counted totals. Run API typecheck/lint/build, whole formatting/diff, isolation and compiled API/worker smoke. No smoke descriptor mutation or rebuild may overlap API tests.

```sh
corepack pnpm@11.22.0 --filter @markiro/db build
corepack pnpm@11.22.0 --filter @markiro/domain build
corepack pnpm@11.22.0 --filter @markiro/platform-contracts build
corepack pnpm@11.22.0 --filter @markiro/api build:us-request-worker
env -u DATABASE_URL US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev corepack pnpm@11.22.0 --filter @markiro/api exec vitest run test/us-request-read.e2e.test.ts test/us-request-publication-read.e2e.test.ts test/us-request-http-commands.e2e.test.ts test/us-request-http-resources.test.ts test/us-request-http-resources.e2e.test.ts test/us-request-download.e2e.test.ts test/us-request-http.e2e.test.ts test/openapi-coverage.test.ts --maxWorkers=1
```

Controller owns one full default API invocation with both DB variables unset,
captures complete output/result and reports setup failures/skips. Known previous
baseline is eight primary-env setup-failed files; do not load primary configuration
or repair unrelated suites to manufacture green. If HTTP-bind EPERM occurs,
separate it from application defects and use a bounded loopback rerun. The complete
API is not declared green from focused tests. Do not change job timeout based on
speculation; measured local timing is not a remote CI result.
If measured current job timing proves it cannot fit the retained 30-minute limit,
report that budget blocker for a separately approved scheduling decision; do not
silently omit checks, raise the limit or claim remote readiness from local passes.

- [ ] **Step 5: Self-review/report/snapshot and independent review; no commit.** Confirm all completed sessions, exact hashes/scope and preserved lock. Final whole-increment review follows all seven accepted task gates. Any final fix gets one bounded wave and scoped re-review; disclose residual findings/proof limits and retain uncommitted acceptance evidence.

## Self-review and execution handoff

Spec sections 1–2 map to baseline/global boundaries; composition/build/storage to
Task 4/6; contracts/routes to Task 1/6; privacy/authority/bounded history to Task 2;
transaction races/replay/audit to Task 3; private publication/download to Tasks 2/5;
errors and verification/CI to Tasks 1–7. Each Review Focus item has explicit tests
in its owner task. No expected-revision check is implemented as controller-only
pre-read; no public projection is an unfiltered internal row.

Task 1 exports public types before consumers. Task 2 supplies server context and
publication read before Task 3/5. Task 3 defines the gate interface before Task 4
implements it. Task 6 composes only components already built and reviewed; no
future-class import is needed in an earlier independently testable task.

Approval of this plan permits local implementation with the preserved staged
executor/reviewer method, not integration/publication. The next product increment
after accepted HTTP is EN/ES cabinet transport/UI and an owned synthetic browser
journey, not deployment-only completion.

## Task 7 local execution checkpoint — 2026-10-05

The check-only workflow now owns the exact public contracts suite and all eight
new API suites, serially and unconditionally after explicit shared dependency and
dedicated API/descriptor builds. Every old Request/worker/Plan/export command,
including the original Plan/OpenAPI selection, is retained. The AST isolation
contract was RED before adding ownership (20 passed / 1 expected missing-gate
failure / zero skips) and GREEN afterwards (21/21, zero skips). It pins the
30-minute budget, synthetic loopback URL, dependency order and failure ownership;
there is no new service, secret, upload or operational capability.

A read-only `classifyChangedFiles` probe covers contract source/tests, API
modules/deployment/tests/support, workflow, US tooling and docs. Existing package
rules select their consumers; workflow/tooling use conservative full ownership;
docs remain docs-only. No missed path class was found, so `tools/ci/affected.mjs`
is unchanged. The existing CORS `OPTIONS` 204 protocol ruling is recorded in the
design/Task 6 and does not add a business route or new human approval.

Completed local full contracts gates pass 55 files / 1,020 tests, zero skips
(3.79 seconds Vitest, 4.44 seconds elapsed), typecheck/lint/build. The exact eight
API suites pass 8 files / 106 tests, zero skips (146.66 seconds Vitest,
147.48 seconds elapsed); their initial sandbox probe failed on loopback EPERM
and is superseded only by the completed reviewed local run. API typecheck/lint
and the dedicated `nest build`/descriptor build pass. All 40 isolation/tooling
contracts pass, with zero skips. Existing Vite native-config warning is retained.

The separate current 44-file Request/worker/Plan/export regression invocation
recorded 937 passed / 2 failed tests (939 total), zero skips, 614.99 seconds
Vitest / 615.69 seconds elapsed. Both failures were the old Plan configuration
test's first-query assumption after the separate Requests preflight was added.
The original Task 6 executor corrected only that compatibility premise, retained
all three exact Plan assertions on one retained statement and added separate
readonly Requests coverage. Its full focused file passes 20/20 in 2.55 seconds;
independent scoped review accepted it. These runs are separate: no fabricated
single 939-test green run, repeated 44-file run or duplicated 18 passes.

The controller's one complete default API invocation, with both DB variables
unset, remains recorded as exit 1: 423 files (23 failed / 185 passed / 215 skipped),
5,366 tests (76 failed / 1,954 passed / 3,336 skipped), 408.75 seconds Vitest /
409.51 seconds elapsed. Causes were eight prior primary-environment setup files,
eleven loopback EPERM files and four new DB suites missing explicit URL-absence
gating (74 setup-failed tests). The bounded exact eleven-file loopback rerun
passes 63/63, zero skips, 11.87 seconds / 12.55 seconds elapsed. A separate
mechanical four-file correction passes 74 configured tests, zero skips, in
131.87 seconds, explicitly skips 74 when the URL is unconfigured, and refuses a
nonempty invalid URL before I/O. Its spec/quality review is accepted. The earlier
eight-suite 106-test selection predates this test-only correction; configured
CI still supplies the exact synthetic URL and owns every suite unconditionally.

The complete API was not repeated or declared green; targeted resolutions do
not rewrite its original 23-file/76-test failure counts into an unmeasured
eight-only result. Eight known primary-environment setup blockers remain
untreated, and primary configuration was never loaded. Existing worker, Request,
Plan and runtime coverage is retained; the new-eight and regression selections
do not overlap. Compiled API/owner/worker smoke passes 5/5, zero skips, with the
dirty descriptor restored. API/contracts static gates and repository formatting/
diff/isolation pass; final exact results/hashes are retained in the Task 7 report.

All executor/controller verification processes are complete. The descriptor
retains actual HEAD and dirty=true, and matches all 2,376 compiled/shared/font
inventory entries. No build/output regeneration overlapped tests; no source
commit or clean product identity was manufactured. Task and whole-increment
acceptance remain in the execution ledger; whole-increment review is pending.
Selected local elapsed does not measure the full remote check-only job or prove
its 30-minute budget; no measured complete-job violation, omitted gate or timeout
increase is asserted. US-09 stays In progress; dirty product output
still refuses checked publication, and release locks/business readiness remain
closed. Local tests use disposable synthetic PostgreSQL and explicit provider
doubles; they do not establish UI/proxy/browser, real S3, hosted recovery,
OS reboot, backup/restore, regulatory, remote CI, merge or release acceptance.

## Final-fix local checkpoint — 2026-10-05

The completed whole-increment review found Important I1 (missing configured CI
ownership for four owned HTTP lifecycle cases) and Minor M3/M4 helper ownership
defects. Two parsed-YAML ownership cases went RED for missing exact gates, then
GREEN after separate unconditional serial lifecycle/fixture commands with the
exact synthetic US URL after existing dependency builds. The earlier entry gate
and exact eight-suite command remain unchanged; 30 minutes and release locks
remain pinned. Configured lifecycle passes 36/36, fixture unit passes 2/2 and the
complete tooling contract set passes 42/42, all with zero skips.

Real filesystem acquisition failure went RED because its owned root remained;
the helper now removes only that root and rethrows the original error. Successful
fixture behavior and worker-runtime contents remain intact. The filtered second
HTTP suite went RED with four undefined-fixture failures; guarded file-scope
setup/teardown now owns both siblings with one shared real MFA enrollment.
Filtered first/second runs pass 9/4 cases (4/9 intentional filter skips), complete
HTTP passes 13/13, and unconfigured HTTP explicitly skips all 13. Configured
teardown asserts its exact random database/root absence and listener closure.
The separate existing descriptor/resources helper-consumer selection passes
63/63. These covering commands are independent evidence, not a new full matrix.

Independent scoped re-review remains pending. M1 stays deferred: ready winner
publication enforces chronology, while failed/abandoned historical attempts have
no universal monotonic-clock contract. M2 stays separate pre-existing tooling
debt; the native-loader warning is retained without suppression or ESM migration.
The original complete API remains non-green with eight primary setup blockers;
no fresh full API, old 44-file/new-eight matrix repeat or fabricated union is
claimed. Frozen compiled output/descriptor are not rebuilt. No primary env/base
migration, remote CI, provider, browser, integration or release is added. US-09
remains In progress; EN/ES Requests UI and an owned browser journey remain next.
