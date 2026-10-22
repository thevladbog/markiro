# US-11 Guarded Dataset Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide an explicit local initialize/verify command composing all six-month native/Trace stages and the owned Plan/three Request packages.

**Architecture:** A pure fail-closed command policy precedes all I/O. A complete owner constructs the existing actual Trace and artifact owners; a separate executable supplies checked resources and prints only a bounded private-safe summary. Existing journals and native worker remain authoritative.

**Tech Stack:** Node 24+, repository Corepack/pnpm, strict TypeScript, existing Zod/Drizzle/Nest services, Vitest and Node tooling checks; no dependencies added.

**Spec:** `docs/superpowers/specs/2026-10-20-us-11-dataset-command-design.md`

**Provider amendment (2026-10-21):** The owner authorized alternatives to MinIO.
Task5 implements `docs/superpowers/specs/2026-10-21-us-development-s3-provider-design.md`.
It supersedes only the MinIO/mc-specific provider choices in Task4; all existing
data, authorization, verification, resource, timeout and release boundaries stand.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve unrelated `docs/us/demo-hosting-options.md`.
- Keep recipe `us-processor-six-month-v1` and its current compiled digest.
- Preserve all 260+2 units, 964 roots, 963 current finalized events, 785 lots and 15,700 boxes; no recipe/version rewrite, source exclusion or reduced sampling.
- Request selection remains bounded by 500 revisions and 16 MiB per snapshot. Per-stage JSON remains bounded at 256 KiB. No timer or phase-budget increase.
- Runtime code must not import test fixtures, accept success/proof callbacks, start HTTP/Auth/general workers, migrate, provision users, reset or repair records.
- Return state `six_month_seed_stages_verified`, `datasetComplete: false`; sequential proof is not globally atomic current state or viewer/browser acceptance.
- Preserve ignored evidence/ledger. Root owns explicit-path staging and commits; every author AND committer is Vlad Bogatyrev <47273232+thevladbog@users.noreply.github.com> via per-commit environment and readback. No primary/main/PR/release/deploy or unknown DB/process cleanup.
- Preceding gate reconciled on 2026-10-21: successor `d712098f247cdde5a91b5dbcbe3915ed67e18847` preserves the prior implementation and completes exact-source US/Cases CI after isolated prepared-services partition. Task 1's reviewed pure policy remains accepted; resume Task 2 from this source, without repeating unchanged broad baseline runs or status-only CI restarts.
- Iterate focused checks. One ordinary API suite at final integration, not per task; retain earlier evidence and exact-SHA full Trace/Cases gates separately.

## Review Focus

- A duplicate flag following an otherwise valid confirmation must be refused, not interpreted as last-value-wins (Task 1).
- A valid recipe digest combined with a remote or differently owned DB URL must fail before connection/business work (Tasks 1/3).
- Missing or invalid Plan/Request storage must not allow the native half of initialize to populate data first (Tasks 1/3).
- Completed verification with a missing/corrupt private artifact must fail without repair, success output or provider/DB writes (Tasks 2/3).
- Runtime failure after one real Request package must preserve exact pending identity/clocks and drain resources without a false complete result (Tasks 2/3).

## File map

| File                                                                 | Responsibility                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/api/src/deployment/us-dataset-command.ts`                      | Pure strict argv/environment/storage policy                                                          |
| `apps/api/test/us-dataset-command.test.ts`                           | Literal behavioral policy/refusal/private-safe regressions                                           |
| `apps/api/src/modules/traceability/demo/us-dataset-complete-seed.ts` | Real full Trace + artifact composition, exact identity/order, bounded immutable output               |
| `apps/api/test/us-dataset-complete-seed.e2e.test.ts`                 | Actual full-volume integration and linked no-write/recovery assertions                               |
| `apps/api/src/deployment/us-dataset-command-runtime.ts`              | Trusted descriptor/resources/actual target preflight, one awaited command, disposal and safe summary |
| `apps/api/src/main.us-dataset.ts`                                    | Separate executable argv/exit/output only                                                            |
| `apps/api/test/us-dataset-command-runtime.test.ts`                   | Boundary/lifecycle failure tests, not substituted native acceptance                                  |
| `tools/us-development/test/dataset-command-entry.smoke.mjs`          | Compiled refusal/secret/listener checks                                                              |
| Existing prepared-services ownership/workflow files                  | Additive new native-suite ownership only after finite budget preflight                               |
| `docs/us/dataset-command.md`, current roadmap                        | Operator instructions and exact evidence/remaining gates                                             |

### Task 1: Strict pre-I/O command policy

Local source checkpoint: independently reviewed and accepted on 2026-10-20;
82 new pure tests pass, focused regressions126pass/4explicit native skips.
Source remains uncommitted from that reviewed checkpoint. The preceding CI gate
is now reconciled; resume at Task2. This is not executable/native/full-command acceptance.

**Files:** Create `apps/api/src/deployment/us-dataset-command.ts` and `apps/api/test/us-dataset-command.test.ts`.

**Interfaces:**

```ts
export type UsDatasetCommand = Readonly<{
  mode: "initialize" | "verify";
  context: UsDatasetContext;
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  env: UsDevelopmentEnv;
  planStorage: UsPlanArtifactStorageConfig;
  packageStorage: UsRequestPackageArtifactStorageConfig;
}>;
export function datasetCommandEnvironment(
  args: readonly string[],
  raw: NodeJS.ProcessEnv,
): UsDatasetCommand;
```

Consumes existing `loadUsDevelopmentEnv`, both private storage config loaders,
`UsDatasetContext` and `usSixMonthDefinition`. No filesystem/build loader,
connection, transport, dispatch, logging, CLI entry or consumer integration in
this task. Configuration values remain internal, never an output DTO.

- [ ] Write a real failing behavioral test before implementation. A minimal refusal-only module may make imports collect, but a missing-module/collection error is not behavioral RED. Expected valid input must initially throw/refuse rather than return a valid command; save actual RED output before implementing successful behavior.
- [ ] Pin a literal full valid argv with real isolated example environment plus explicit synthetic separate private storage configs. Assert literal mode/context, fixed recipe/version/digest, unchanged raw input and both real validated storage configs. Test reordered pairs and verify without confirmation; initialize without confirmation and verify with confirmation refuse.
- [ ] Add table-driven literal negatives: each missing required pair/value, duplicates including confirmation, unknown/reset/range/URL options, extra positional tokens, unsupported modes, malformed/uppercase/whitespace UUIDs, wrong DB name/user/version/digest, empty values and trailing tokens. The valid digest fixture is an independently pinned literal of the current recipe, not the parser's output.
- [ ] Add unsafe environment cases: both edition fields, production mode, remote or unexpected DB/username, incompatible isolated endpoints; missing/partial/invalid Plan storage and missing/partial/invalid package storage, including equality with general S3 credentials/bucket. Use actual existing validators, no mocked allow decision. Errors contain only one of `us_dataset_command_arguments_invalid`, `us_dataset_command_environment_invalid`, `us_dataset_command_storage_unavailable`; never attach raw config or the original exception as a public error cause.
- [ ] Implement exact parsing and pure preflight. No implicit defaults or normalization. Copy owned parsed context/config structures rather than mutating caller arrays/environment; freeze owned outward policy/context. Do not freeze or otherwise mutate caller-owned inputs.
- [ ] Run focused new test plus existing `test/us-owner-command.test.ts` and `test/deployment-entry.test.ts`. Use Node 24 and existing compiled dependency outputs. Run API typecheck, focused ESLint/Prettier and `git diff --check`. Report exact warnings/exit counts and scope, leave code unstaged for root independent review. No broad SQL/API rerun for this leaf task.

### Task 2: Actual complete seed owner

**Files:** Create `apps/api/src/modules/traceability/demo/us-dataset-complete-seed.ts`, `apps/api/test/us-dataset-complete-seed.e2e.test.ts`; modify only necessary test support and additive exact CI ownership files.

**Interfaces:**

```ts
export type UsDatasetCompleteSeedResult = Readonly<{
  datasetId: string;
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  state: "six_month_seed_stages_verified";
  datasetComplete: false;
  trace: UsDatasetTraceReadinessSeedResult;
  artifacts: UsDatasetArtifactResult;
}>;
export class UsDatasetCompleteSeedStore {
  constructor(db: Db, services: UsDatasetRequestServices);
  initialize(context: UsDatasetContext): Promise<UsDatasetCompleteSeedResult>;
  verify(context: UsDatasetContext): Promise<UsDatasetCompleteSeedResult>;
}
```

Consumes unchanged actual `UsDatasetTraceReadinessSeedStore` and
`UsDatasetArtifactSeedStore`. No caller results, selectors, flags, alternative
recipes or injected owners. Output is bounded/deeply frozen and stable on replay;
timings are diagnostics, not digest-bearing state.

- [ ] Before starting this task reconcile preceding exact-SHA CI. Read the existing complete Trace native workload/phase helper and actual artifact fixture. Write down a finite test/CI ownership matrix with unchanged original timers/budgets and expected new whole-file counts before running anything. Keep old full-volume tests unchanged. If the new full composition cannot fit existing independent phase envelopes, subdivide new correctness setup using the already approved separation rule; do not enlarge any accepted timer/cap or invent a new SLA.
- [ ] Establish actual behavioral RED, then implement minimal direct composition in the same mode, exact shared identities, all 262 Trace units and three prescribed ordered Request keys. Validate relationships without presenting a caller-usable synthetic proof as authority.
- [ ] Exercise all native 260+2 chains and actual Plan/three packages in one owned installation; no fake Trace success or reduced loop accepted. Link exact before/after full DB snapshots, provider PUT/DELETE calls, IDs, clocks, byte hashes and result equality across completed initialize and verify. Record per-phase elapsed time, process peak RSS, actual DB bytes and private bytes separately. A shorter fixture may test refusal but is not full completion evidence.
- [ ] Prove verify on fresh/middle-pending installation makes no writes; actual interrupted package resume preserves saved Request/run/operation identity and receivedAt/dueAt. Prove wrong tenant/current owner/profile refusal, native drift, missing/corrupt final private byte refusal and an unrelated queued run unchanged. Preserve original failure cause/unit/stage. Finish normal exact owned DB disposal and named catalog absence; never delete unknown prior fixtures.
- [ ] Add new native suite to actual check-only CI ownership with independent literal selector/mutant tests, retaining every existing suite and release lock. Run only focused iteration, then fresh API static/build, tooling/isolation/format/diff; report original failed invocations distinctly. Root independent review before task commit.

### Task 3: Executable, checked resources and operator acceptance

**Files:** Create runtime, executable, runtime test, compiled smoke and operator documentation from file map; update current roadmap and additive check-only compiled-smoke ownership as necessary. No package dependency changes.

**Interfaces:**

```ts
export async function runUsDatasetCommand(
  args: readonly string[],
  raw: NodeJS.ProcessEnv,
): Promise<UsDatasetCompleteSeedResult>;
```

The executable has no injected dependencies; trusted runtime tests may replace
connection/transport and the existing checked-loader filesystem I/O boundary only.
The loader seam must invoke the actual checked loader over an owned fixture and
the actual runtime identity constructor, never fabricate successful authority.
It consumes Task 1
policy, existing checked build loader/runtime execution identity and Task 2 owner.
No injected successful seed/proof/Ready callback is permitted.

Execution refinement (2026-10-21): split this task into separately reviewed 3A
(runtime, resources, refusal tests, compiled refusal smoke, operator docs and an
additive exact no-service check owner) and 3B (actual compiled-positive acceptance
on an independently owned exact-named PostgreSQL/private-provider CI service).
The positive gate is not removed or waived. CLI acceptance and subsequent viewer
implementation require current native and compiled-positive CI success. A detailed
finite provider/ownership/disposal matrix precedes 3B implementation; no shared
local base is populated to substitute for that gate.

- [ ] Write behavioral RED for preflight failure before connection/seed work and safe failure output. Test malformed args/config/build, wrong actual DB/user/current schema, missing owner/profile, partial runtime acquisition and pool/provider failure; resources acquired before refusal are disposed exactly once after awaited work.
- [ ] Build runtime with real loader/config/stores, bounded pool settings from existing worker conventions and actual read-only target/schema/provenance/profile preflight. Dispatch exactly one complete owner operation; never general worker loop/startup seed. Preserve internal original error but redact executable diagnostics to fixed categories plus validated finite recipe unit/stage only. Emit no success on any refusal or incomplete run.
- [ ] Add compiled smoke for unsafe arguments/targets/missing/dirty descriptor, no HTTP listener and no raw secret/SQL/URL/stack output. Preserve/restore only the smoke's owned descriptor fixture; no personal env writes or skip-based green. Build affected dependencies before the executable smoke.
- [ ] Keep standalone executable restricted to actual `markiro_us_dev`/`markiro_us`; do not map a child DB identity to that name in a mock or relax the check. Compiled positive acceptance requires an independently owned disposable PostgreSQL service whose database really has that exact name, not the shared local base or an ordinary child fixture. Before adding that separate check-only service job, record its finite resource/ownership/phase matrix and preserve existing jobs/budgets. Exercise real initialize/verify against the same owned installation/private transport and normal exact disposal. If that environment is not available, keep compiled positive acceptance explicitly pending; native Task 2 and compiled refusal evidence cannot be called a successful CLI run.
- [ ] Document clean explicit environment/build prerequisites, exact initialize/verify arguments, finite errors, interrupted resume and false completion flag semantics. Record measured resources without cost/hosting/US-11 completion claims.
- [ ] Root final integration: one ordinary API invocation, full format/tooling/isolation/static/build, actual new native/compiled evidence, most-capable whole-increment review, explicit-path user-identity commit/push only when prior exact-SHA evidence is reconciled. New exact-source CI remains a separate gate. Preserve ignored ledger; no release/PR/deploy.

### Task 4: Real compiled positive acceptance (Task 3B)

**Files:** Create `tools/us-development/test/dataset-command-positive.smoke.mjs`,
`tools/us-development/test/support/dataset-command-provider.mjs`,
`tools/us-development/test/support/dataset-command-positive-fixture.mjs`,
`tools/us-development/test/dataset-command-provider.test.mjs`,
`tools/us-development/test/dataset-command-positive-ownership.test.mjs` and
`tools/us-development/test/support/dataset-command-positive-owner.mjs`.
Modify only additive check ownership in `.github/workflows/us-development.yml`
and the exact normalizer chain; update operator evidence/status documentation.
Runtime, recipe, native suites, existing jobs/limits and operational locks stand.

**Interfaces:** Consume the actual compiled `apps/api/dist/main.us-dataset.js`
and its existing clean checked descriptor, Task1 argv contract and Task2/3A
canonical summary. No runtime dependency overrides/preloads that supply success.
The fixture may call actual migration, `UsDevelopmentOwnerStore.provision` and
`UsProfileStore.provision` services solely in its initially empty CI installation.
It never calls a dataset owner to populate data before invoking the executable.

Provider helper interface:

```js
startDatasetProviderObservation({ port, upstreamPort });
// Promise<{ counts(): { reads, mutations, failures, active }, close(): Promise<void> }>
```

This is a streaming loopback HTTP observer, not an S3 response fake: forward
unchanged method/path/query/headers/body and real upstream status/headers/bytes.
Preserve Host for signature validation, backpressure and error/close semantics.
Count every non-GET/HEAD method conservatively as a mutation. Retain no body,
Authorization header, secret or private key in logs/counter DTOs. Ports are
trusted fixture arguments; the positive harness pins19000→19002 and runtime
environment policy remains unchanged. Small helper tests use owned random ports.

- [ ] Establish genuine behavioral RED for forwarding/counter/lifecycle rules,
      then implement the helper and focused tests: exact signed-Host/path/query/body
      and response fidelity; GET/HEAD vs PUT/POST/DELETE counts; upstream refusal,
      aborted request and awaited normal socket cleanup. No fabricated provider
      response is allowed in positive acceptance; an echo server is unit evidence only.
- [ ] Before adding/running services, write the finite matrix to the existing
      ignored ledger: new exact `dataset_command_positive` check-only job,
      `needs:isolation`,45minutes, original pinned action/build sequence. Use its own
      existing `postgres:17-alpine` service at loopback55432 with actual
      `markiro_us_dev`/`markiro_us`. The positive harness refuses before I/O outside
      the exact CI job, and attests initial empty database/actual identity before
      acquiring ownership. Never substitute a child DB or touch the local base.
- [ ] On that runner ONLY, start one precisely owned MinIO container using
      existing `minio/minio:RELEASE.2025-09-07T16-13-09Z`, loopback19002, ephemeral
      container-owned data and no external/named production volume. Record exact
      returned container ID and verified image/ownership before use/cleanup. GitHub
      service syntax does not offer a command field, so the fixture owns this
      explicit `server /data` process; do not silently introduce an invalid service.
      Use existing `minio/mc:RELEASE.2025-08-13T08-35-41Z` only as finite owned clients.
      No local Docker invocation, image substitution or dependency-policy change.
- [ ] Create two fresh unique private buckets and distinct restricted service
      credentials. Use generated service-account output captured in memory, never
      secrets in arguments/logs/artifacts. Store any required MC configuration only
      in an owned0600 temporary fixture, never a personal env/config. Restrict each
      account to its own bucket/object operations, no admin or other-bucket access;
      assert actual cross-bucket and anonymous access denial. Setup clients use the
      upstream provider; both actual CLI SDK clients use observed endpoint19000.
      The pinned MC service-account command/policy support was checked against its
      [release source](https://github.com/minio/mc/blob/RELEASE.2025-08-13T08-35-41Z/cmd/admin-user-svcacct-add.go).
- [ ] Apply existing migrations and provision the reserved owner/processor
      profile through actual services on this installation only. Generate password
      in memory; never log it or create sessions/MFA/browser data. Build descriptor
      must come from the clean actual checkout and include dataset entry. No forged
      `dirty:false`, alternate descriptor roots, seed fixtures or shortened dataset.
- [ ] Execute exactly ONE compiled initialize, then exactly ONE compiled verify
      against that same installation, each awaited within900000ms; no retries,
      per-case reset allowances, third full traversal or new cold-command SLA.
      Assertion cases retain5000ms; setup/disposal retain60000ms where applicable.
      Existing pool, provider and native phase limits remain unchanged. Record
      actual elapsed/peak child RSS, DB bytes and separate private-byte totals.
- [ ] Require both child exits0, no signal, one strict bounded canonical JSON
      summary each and no success on refusal. Independently assert shared IDs/hashes
      and equal stable summaries, all260+2 units/964roots/963currentfinalized/785lots/
      15700boxes, actual Plan PDF and three1/12/12 Request selections, complete
      manifest/hash/size/PDF/ZIP bytes and unchanged native bounds. Read persisted
      publication through actual compiled readers and actual SDK, not a success mock.
- [ ] Reuse the existing full-public-table MVCC snapshot helper via fixture-only
      compilation if needed; do not duplicate or narrow its hashing algorithm.
      Compare every table before/after compiled verify; no exclusions. Provider
      observer must show actual reads, zero mutations/failures/active requests over
      verify. Report this compiled persistence/network evidence separately from
      Task2's required literal SQL mutation observation on current15 native cases;
      table hashes alone are not a claim that no SQL statement was issued.
- [ ] Always await owned children/pools/provider requests before disposal. Drop
      ONLY the attested initially empty runner-owned exact database, without FORCE,
      and verify named catalog absence. Normally stop/remove ONLY the recorded
      fixture MinIO ID and confirm absence; await observer/client/temporary-file
      closure. Never clean unknown resources. Failure/cancellation is nonacceptance;
      failed disposal fails the job, not a hidden successful result.
- [ ] Establish real ownership RED then independent literal/mutant tests for
      this additive job/whole smoke selector/resources/build order/caps. Preserve
      every predecessor job, timer, guard, pin and release lock through exact
      normalization only. Full positive smoke refuses locally; do not run services
      here. Focused helper/tooling/static/format/isolation checks, independent review,
      root final ordinary API/whole-increment review and authorized exact-source CI
      follow. Current15 native and compiled positive must actually pass before CLI
      acceptance or viewer implementation. Keep all failed/partial evidence distinct.

### Task 5: Replace unavailable US MinIO with pinned SeaweedFS

**Requirements:** Read the provider amendment above and the frozen finite
`.superpowers/sdd/2026-10-20-us-11-dataset-command/task-5-provider-comparison.md`.
The comparison's concrete command, image digest, resource matrix and sixteen
top-level cases are requirements, not permission for a local service run.
Standing owner approval removes repeated approval prompts; it does not remove
independent review or actual CI acceptance.

**Files:**

- Modify `tools/us-development/test/support/dataset-command-positive-fixture.mjs`:
  consume one real provider and retain all existing DB/CLI/byte/observer lifecycle.
- Create `tools/us-development/test/support/dataset-command-object-store.mjs`:
  test-only identity/config/container contract, capability probes, safe diagnostics.
- Create `tools/us-development/test/dataset-command-object-store.test.mjs`:
  four focused behavior cases from the frozen matrix.
- Modify `tools/us-development/test/dataset-command-positive-ownership.test.mjs`:
  migrate provider-specific expectations, preserve four original behavioral gates.
- Modify `deploy/us-development/compose.yml`; create
  `deploy/us-development/s3-identities.example.json` for synthetic local bootstrap.
- Modify the local dependency-stack contract in
  `tools/us-development/test/isolation.test.mjs` and the current operator sections
  of `docs/us/development-isolation.md`, `docs/us/dataset-command.md`,
  `docs/us/implementation-plan.md`. Leave archived evidence/history unchanged.
- `deploy/us-development/local.env.example` only if necessary for matching the
  actual synthetic bootstrap; do not rewrite any existing personal environment.
- No workflow/normalizer change, product API change, SDK/dependency change or
  hosting document mutation is expected. Report a concrete conflict before widening.

**Interfaces:** Keep the existing fixture exports and positive smoke command.
The helper exposes `datasetObjectStoreConfig`, `datasetObjectStoreContainer`,
`assertDatasetObjectStoreContainer`, `verifyDatasetObjectStoreCapabilities` and
`datasetObjectStoreFailureCategory`. Configuration/container functions consume
trusted generated identities, exact owned config path and actual nonroot uid/gid;
they return bounded owned JSON/argv structures without I/O. Attestation consumes
the actual inspect object and exact expected ownership contract. Capability proof
consumes actual SDK clients for the admin/plan/request identities and their two
owned buckets. It returns only private-safe capability evidence or throws; no
success/proof injection in the executable or fixture. Error categorization emits
fixed identifiers only. Keep all provider-specific code test-only.

- [ ] Write four focused tests first: scoped config/uid contract; exact container
      attestation; capability failure stopping initialization (including incorrect
      conditional winner/checksum/403 outcomes); bounded redaction/partial-acquisition
      cleanup. Preserve seven observer and four ownership cases. Save genuine
      behavioral RED before successful implementations, not missing-import failures
      or a retrospective replay. Doubles verify helper failure orchestration only.
- [ ] Implement the literal image+digest from the frozen comparison. CI uses one
      container with `/usr/bin/weed` entrypoint, nonroot actual runner uid/gid,
      workdir `/data`, same-uid/gid0700tmpfs for declared `/data`, read-only bind of
      the owned0600config from an owned0700directory. Attest every mount, label,
      entrypoint, command, user, workdir, image and S3-only19002:8333loopback mapping.
      Never invoke the image's root/chown entrypoint or acquire an unknown resource.
- [ ] Use the exact `mini` command from the frozen comparison, with admin UI,
      WebDAV, Iceberg/Lance listeners, telemetry and automatic bucket creation
      disabled. No management/master/filer/RPC host port, root secret argv/env or
      external volume. Generate three distinct identities/accounts; only bootstrap
      admin gets global Admin, applications get exact Read/Write/List:ownbucket.
      Use signed real SDK readiness within the same total60000ms setup budget.
- [ ] Before any dataset call, run actual own-bucket Get/Put/List/Delete, both
      directions cross-bucket List/Get/Put403, anonymous Get/Put403 and application
      global CreateBucket403. Check SHA256/streaming bytes with the unchanged SDK
      and refuse an invalid checksum. Sequential conditional A then B must return
      412 for B and retain A; two concurrent fresh-key conditional writes must have
      one winner and a precondition/conflict loser, GET equals exact winner bytes.
      Drain and delete only probe objects, verify both owned buckets empty. Any
      failure prevents initialize; no fallback, header removal or budget increase.
- [ ] Preserve exactly one actual full compiled initialize and verify, all existing
      census/private bytes/ZIP/PDF/hash/read-only measurements, actual GNU-time
      child peak RSS and exact awaited DB/provider/client/observer/temp disposal.
      Publish only public fixed operation/category/image diagnostics on failure,
      never raw Docker/S3 output, credentials or object keys.
- [ ] Replace only the isolated local provider with the same pinned image, its own
      new `s3data` volume and checked-in synthetic identity config. Preserve the
      general local S3 environment/bucket; use explicit bootstrap for that bucket
      and confirm the chosen exact-release flags before writing Compose. Remove
      the obsolete console19001 contract rather than relabelling a filer as a
      private console. Do not start local services, migrate/delete old miniodata,
      alter primary Compose or create private stores from general credentials.
- [ ] Run focused helpers/ownership/isolation, then full US and tools/ci Node tests,
      ESLint, scoped/full format, isolation checker, `git diff --check` and static
      Compose validation without starting services. Preserve predecessor workflow
      AST/byte hashes and every selector/cap. Do not rerun unchanged broad API/native
      suites locally. Freeze a scoped diff/report for independent spec+quality review.
- [ ] Root alone resolves review, stages explicit paths and commits/pushes only US
      with the required four identity variables and author/committer readback.
      Require exact new-SHA all13USjobs and Cases, especially real SeaweedFS positive
      success/probe metrics/disposal. Source/unit success is not provider acceptance.
      Retain exact653 fifteen-case/fullTrace proof as source-specific predecessor
      evidence, not permission to skip the new-SHA jobs. Viewer remains afterward.

### Task 6: Finite Request failure propagation (original Task3A worker)

**Ownership:** The original runtime implementer alone implements this follow-up.
The positive-fixture worker prepares the amendment/brief only and must not edit
the API in parallel. Root selects the independent reviewer and owns integration.
The approved spec amendment above is a diagnostic-contract correction, not a
claim that the historical551 initialization cause has been identified.

**Files (exact four source/test paths):**

- Modify `apps/api/src/modules/traceability/demo/us-dataset-request-contract.ts`.
- Modify `apps/api/src/modules/traceability/demo/us-dataset-request-seed.ts`.
- Modify `apps/api/src/deployment/us-dataset-command-runtime.ts`.
- Modify `apps/api/test/us-dataset-command-runtime.test.ts`.

**Interfaces:** Add the internal `annotateUsDatasetRequestFailure` helper in the
Request contract; it returns the exact input error without wrapping:

```ts
export function annotateUsDatasetRequestFailure(
  error: unknown,
  location:
    Readonly<{ unitKey: UsDatasetRequestUnitKey; stage: "request" | "package" }> | undefined,
): unknown;
```

It consumes only trusted validated service location and existing error metadata;
it grants no execution/proof/authorization authority. It preserves existing valid
canonical location on the error or bounded own-data cause chain and ignores
frozen/opaque/unsafe descriptors without invoking accessors. Existing
`usDatasetCommandDiagnostic(error)` retains its signature/output fields, command
category priority, unknown fallback and bounded recipe-location traversal. Add
only `us_request_worker_checkpoint_mismatch`, `us_dataset_request_conflict` and
`us_dataset_request_incomplete` to the finite diagnostic boundary, using safe own
data `message`/`response.code` reads only, not `getResponse` or raw error output.
Keep that sanitizer self-contained with its existing `categories` and `ownValue`
declarations: the approved tooling compiles those three declarations in isolation.
Do not add an unprovided top-level runtime dependency or widen the four-path scope
to rewrite the tooling extractor; report a concrete conflict before doing so.

- [ ] Read the amended spec and ignored `task-6-runtime-propagation-brief.md`,
      verified551 investigation and raw pure-probe logs. Verify HEAD/worktree and
      closest guides; `apps/api/AGENTS.md` is absent in this US checkout, so do not
      import primary-worktree changes. Preserve hostingdoc/evidence and all gates.
- [ ] Add exactly six focused cases to the existing runtime test: actual pure
      checkpoint model drift, changed bytes, descriptor conflict, incomplete,
      hostile/unknown metadata table, and same-error/frozen/lower-location table.
      Reuse real refusal predicates; do not fabricate a successful owner/proof.
      Save genuine forward behavioral RED before implementing propagation; a
      missing export/import/collection error is not behavioral RED.
- [ ] Implement the helper and an outer Request service catch returning/rethrowing
      that same original error. Trust a Request location only after the existing
      unit validation; switch to `package` immediately before the existing first
      package-stage read. Preserve prior canonical native location and every
      query/action/reconciliation/worker-result/clock/byte-assertion order. No
      new classification of worker outcomes, altered equality or retry behavior.
- [ ] Preserve only the three approved codes through runtime projection. Existing
      command categories win; arbitrary messages/SQL/provider codes and unsafe
      metadata stay generic. Preserve own-data recipe checks, cycle/depth bounds,
      output field set, frozen errors and cause identity. Run the focused file to
      GREEN without changing assertions, caps, selectors or accepted source policy.
- [ ] Run API lint/typecheck/build, full US and tools/ci tooling, format/diff and
      static source-preservation checks. Use Node24/existing dependencies; no
      services, actual positive, native/fullTrace or broad ordinary API run by the
      worker. Root reserves the single final isolated ordinary API integration.
      Expected policy+runtime refusal total becomes117 from111, unfiltered through
      the same existing two-file selector; positive16 top-level cases unchanged.
- [ ] Freeze four-path source/report with RED/GREEN commands, logs, counts/skips/
      warnings and unchanged-boundary proof for independent review. Root owns
      final API, explicit-path user-identity commit/push and new exact-source CI.
      Current15 native, whole compiled initialize/verify, provider/provenance and
      all existing acceptance gates remain mandatory. Unknown historical551 cause
      is not relabelled as checkpoint, renderer, timeout or performance failure.

### Task 7: Reduced same-invocation outer-operation evidence

**Approved scope:** Root adopted the reduced contract in
`.superpowers/sdd/2026-10-20-us-11-dataset-command/task-7-one-pass-design-review.md`.
Read that full review and the spec's reduced Task7 amendment. Broad leaf/native
classification, wrapper instrumentation, DB census/replay and automatic repeat
diagnostic CI are rejected for this increment. A tag is the last entered boundary,
not an exact cause/throwing instruction. Within read_plan/bind_inputs/
assemble_package ambiguity is explicitly accepted. Current338 cause is unknown;
native complete15/15 execution/normal absence does not make its CANCELLED45min
job green. The doc-only amendment and ignored `task-7-outer-operation-brief.md`/
handoff were frozen and read by root before source execution was released.
That execution release does not waive independent review or actual acceptance.

**Exact nine-path implementation manifest:**

1. Create `apps/api/src/modules/traceability/requests/us-request-verification-failure.ts`.
2. Modify `apps/api/src/modules/traceability/demo/us-dataset-request-seed.ts`.
3. Modify `apps/api/src/modules/traceability/demo/us-dataset-request-verify.ts`.
4. Modify `apps/api/src/main.us-dataset.ts`.
5. Modify `tools/us-development/test/support/dataset-command-positive-fixture.mjs`.
6. Modify `tools/us-development/test/dataset-command-positive-ownership.test.mjs`.
7. Create `apps/api/test/us-request-verification-failure.test.ts`.
8. Modify `docs/superpowers/specs/2026-10-20-us-11-dataset-command-design.md`.
9. Modify this plan.

No other source/test path is authorized. Runtime categories/sanitizer, current
Request-contract annotation, both existing refusal test files, all native
payload/Plan/bind/composer/PDF/worker/storage/domain/XLSX implementations,
workflow/ownership selectors, dependencies and personal environment stay
byte-identical. Stop for root on a concrete extra-path need. Root alone owns
independent review, explicit-path staging and required-identity commit/push.

**Interfaces, all synchronous/best effort:** The new module exports closed types
`UsRequestVerificationOperation` (exact19 spec literals),
`UsRequestVerificationArtifact` (exact6 published names), opaque
`UsRequestVerificationFrame`, and `UsRequestVerificationFailure` (exact operation/
artifact combinations). It exposes:

```ts
export declare function createUsRequestVerificationFrame(
  unitKey: unknown,
): UsRequestVerificationFrame | undefined;
export declare function activateUsRequestVerificationFrame(frame: unknown): void;
export declare function enterUsRequestVerificationOperation(
  frame: unknown,
  operation: unknown,
  artifact?: unknown,
): void;
export declare function closeUsRequestVerificationFrame(frame: unknown): void;
export declare function finalizeUsRequestVerificationFailure(frame: unknown, error: unknown): void;
export declare function takeUsRequestVerificationFailure(
  error: unknown,
  diagnostic: unknown,
): UsRequestVerificationFailure | undefined;
export declare function projectUsRequestVerificationFailure(
  value: unknown,
): UsRequestVerificationFailure | undefined;
```

Only the three exact Request-unit strings are accepted at creation. Unknown
arguments support strict refusal tests without casts; they never bypass private
identity. No raw error fields, native classifier or successful authority/proof
are consumed. The existing verifyRequestBytes gains a mandatory fourth argument
`frame: UsRequestVerificationFrame | undefined`; update its sole production call
at RequestSeed312. Undefined frame is a no-op diagnostic path, not a business
refusal or success override.

**Frame algorithm:** Private registry identity lookup precedes every frame read.
Create after unit validation; activate only at the existing package transition.
Each enter first clears operation/artifact, then accepts only a valid spec
combination. Inactive/closed/forged frames do nothing. RequestSeed enters its six
early operations, passes the same handle to verification for its11 operations,
then explicitly enters final_publication_probe or commit_package_receipt.
Verification only inserts synchronous enter calls, never a catch/async wrapper.
Close/remove frame before each original successful return, clearing state.

Only the existing RequestSeed catch finalizes. Validate live identity, close once,
copy an eligible finite immutable package snapshot/location and keep originating-
frame identity privately. Inactive/invalid frames keep only an ineligible pending
identity, not a usable snapshot, so another invocation's tag cannot leak through.
Store by error key identity only; primitive ineligible keys discard it. No error
property/prototype/cause/native-brand access or new
mutation occurs. Repeated closed-frame finalization is ignored; two distinct
unconsumed frames for one error become an ambiguous sentinel, even if either
frame is inactive/invalid, never newest-wins.
Every take first deletes the pending record, including ambiguity, non-generic,
malformed and location mismatch, then checks canonical generic Request/package
agreement and projects a fresh exact tuple. Repeated takes yield none; error reuse
after consumption requires a new frame. No ambient global current-operation,
AsyncLocalStorage, callbacks, I/O, await, timer or retained error/body values.

**Placement:** Enter immediately before each existing call/check. For the
private-object loop, enter read_private_object before its existing expected-byte
lookup/read, compare_private_object before byte equality, and, only for package.zip,
verify_private_archive before archive verification. Clear artifact at every
transition, including final probe/receipt. Normalization may remove only new
diagnostic imports/declarations/calls, the sole fourth argument and braces needed
solely to place an enter inside the existing archive condition; restore every
original statement, condition, await, query, return and ordering exactly.

**Executable and fixture:** Main always obtains the original sanitizer result
first, calls take even for non-generic/mismatched cases, then adds only a returned
verificationFailure to the existing failure JSON. Success JSON stays byte-identical.
No new root code, origin, class, error text, progress, resource or output channel.
The actual owned fixture loads the new pure projector from the same checked
compiled build; its reader requires both old sanitizer and new projector and
reconstructs current root forms or strict generic Request/package extension;
the extension's parsed code must already equal us_dataset_command_failed, not
merely become generic when sanitized.
Missing projector, malformed/extra/unknown tuples or noncanonical JSON are
unavailable. Preserve <=4096 one-line JSON, duplicate rejection, overflow→
unavailable/no parser call, output bounds, child decisions, GNU-time/observer
measurements, original exception/error precedence and awaited normal cleanup.
Keep the original three-declaration extractor unchanged; compile/test the actual
new module/projector separately in the existing ownership cases.

- [x] **Doc-only handoff:** Update only the two approved documents and ignored
      brief/handoff; freeze for root read before touching source/tests or running
      validation workloads. Preserve all evidence and hosting bytes.
- [ ] **Forward RED after source release:** Add12 top-level service-free cases in
      the new pure test: all19 projections; malformed/hostile tuple table; private
      frame identity/no traps; inactive refusal; active last-boundary snapshot;
      phase/artifact reset including invalid transition; successful closure;
      one-shot finalization/error preservation; concurrent/distinct-frame ambiguity;
      every-take consumption/reuse; forged public metadata/old root priority; actual
      placement/full-module preservation. Independently pin literals/combinations.
      A minimal refusing/no-op export scaffold may collect, but missing exports/
      imports or assertions copied from production arrays are not behavioral RED.
- [ ] **Minimal implementation:** Implement the exact private frame state machine,
      pure closed projection, RequestSeed/verification/main wiring and strict
      fixture retention together. Add hostile/canonical/overflow/missing-projector
      and actual-source projector checks inside current ownership cases, without
      changing their selectors or adding fake successful owner/runtime/proof paths.
      All12 classes of tests must GREEN without weakening existing assertions.
- [ ] **Focused gates:** Run the new12 pure tests separately, then unchanged117
      policy/runtime tests through their original unfiltered two-file selector.
      Run focused existing ownership/child tests and all US+CI tooling. API
      typecheck/lint/build after correct existing shared-build ordering, fullformat,
      isolation, diff checks and whole-module original-statement/order proof are
      required. Check excluded native/runtime/worker/storage modules and success
      JSON for exact byte preservation. Static placement is not exercised native
      success. Report exact commands/counts/skips/warnings/source identities.
- [ ] **Freeze/review/actual gates:** Original implementer freezes nine-path diff
      and report for independent review; no automatic local ordinary broad API,
      native/full Trace, real provider/services/CLI or CI retry. Root owns any
      separately justified integration and one explicitly authorized exact-source
      CI after review/identity push. All existing ordinary API/native/full Trace/
      Cases/compiled initialize then verify once/private bytes/no-write/provider/
      ownership/disposal gates and all original caps remain mandatory. Pre-Task7
      evidence stays source-specific; a cancelled job is not green. Stop on the
      actual new result for targeted investigation/ruling, not automatic expansion.

## Task8 — same-invocation fixed private-read evidence (2026-10-22)

Evidence-only amendment: actual567 failure identifies September/package/
read_private_object/manifest.json, not its specific storage cause. Root approved
the amended nine-path design after the initial eight-path design review found
that the existing fixture preservation inverse would reject the addition. The
initial finding remains valid historical evidence; no old digest is re-anchored.

Exact scope:

1. `apps/api/src/modules/traceability/requests/us-request-package-artifacts.ts`
2. `apps/api/src/main.us-dataset.ts`
3. `tools/us-development/test/support/dataset-command-positive-fixture.mjs`
4. `apps/api/test/us-request-package-artifacts.test.ts`
5. `apps/api/test/us-request-verification-failure.test.ts`
6. `tools/us-development/test/dataset-command-positive-ownership.test.mjs`
7. `docs/superpowers/specs/2026-10-20-us-11-dataset-command-design.md`
8. `docs/superpowers/plans/2026-10-20-us-11-dataset-command.md`
9. `tools/us-development/test/viewer-entry.test.mjs`

- [ ] Record genuine forward pure RED for factory identity/take-once and optional
      scalar, then minimal GREEN. Induce actual adapter read failures only through
      controlled external transport without sockets. Cover all seven codes,
      authentic frozen error identity/descriptors, impostors/proxies/accessors/
      wrapped causes and excluded write/delete codes; no successful CLI injection.
- [ ] Gate main on unchanged canonical diagnostic plus the same consumed strict
      private-read tuple/error; preserve original frame/root12/extractor/117 and
      success JSON. Strict parser uses the actual compiled primitive validator;
      legacy envelopes remain compatible. Real bounded child/spec reporter keeps
      exit1 while displaying scalar; reject invalid/mismatched/unknown/overflow
      inputs before any parser/projector runs on incomplete overflow evidence.
- [ ] Add only the exact Task8 preservation inverse: each new parameter, option,
      call argument, compiled load, field allowance/type exclusion, complete
      validation branch and returned scalar is matched once before reversing.
      Preserve historical AST digest, both ordered unique byte segments, both
      module hashes, original substitutions and old mutants. Add semantic bypass
      mutants and prove old guard/resource/cap mutations still fail. New load is
      immediately after invoked-set declaration, outside pinned segments.
- [ ] Run focused pure suites, unchanged117, actual current US+CI tooling,
      API types/lint/build, format/isolation/diff and preservation proofs. Record
      real counts/skips/warnings; no assumed historical count. Existing loopback
      EPERM requires root release before escalation. No DB/provider/browser/native/
      actual initialize/verify, new resource, network or CI retry is authorized.
- [ ] Freeze full nine-path diff/report/hashes for root full read and independent
      review. Task7 launcher paths and hosting remain byte-preserved; root alone
      stages/commits/pushes after prior CI settlement and an explicit publication
      ruling. All actual current-source gates remain mandatory. No cause/fix claim
      and no automatic follow-on evidence expansion.

## Task12 P2 — bounded transport witness (2026-10-22)

Root FULL READ the source-only diagnosis and424-line P2 design; independent
DESIGN Approved. P1 fake-SDK characterization declined. This source increment
adds evidence only, not an actual922 cause reproduction or reliability fix.
The exact same nine Task8 paths are the complete manifest; no new helper,
runtime/frame/worker/provider/SDK/resource or category-policy path is allowed.

- [ ] Freeze immutable922 source hashes and exact new inverse structures before
      editing. Preserve concurrent Task11 three named paths and unrelated hosting.
- [ ] Genuine pure behavioral RED from actual failed adapter read, actual-main
      catch and actual parser; then minimal GREEN with opaque live-read stage,
      first-positive14-literal capture from existing eager reads/OR only,
      closed28-primitive validator, same-error private map/take-once and stale
      passthrough deletion. Preserve error identity/shape/classification and
      original io/await/SDK/finally actions/caps.
- [ ] Main consumes new evidence on every failure catch; emits only with valid
      consumed canonical Request/package/private-read frame and existing genuine
      transport scalar. Old seven-code/frame/root12/117/extractor unchanged.
- [ ] Optional fifth actual parser argument and child option; actual compiled
      validator loaded after unchanged Task8 load, outside pinned segments.
      Present malformed field fails unavailable; absent field is legacy-compatible.
      Independent28 literals/504 valid combinations, all privacy/alias/invalid/
      missing-projector/overflow negatives; real bounded child/spec reporter
      visibly retains scalar and original exit1. No reporter/global-inspect change.
- [ ] New narrow exact inverse BEFORE unchanged Task8 inverse. Validate every
      introduced fragment/placement before erasure. Normal fixture restores
      fixed922 whole-byte hash; historical mutants still reach original errors.
      Keep all old pins/segments/module hashes/substitutions/mutants unchanged.
      Restore original matcher/read/io/main AST by exact additions, no whole
      existing function deletion; all outside approved scopes raw-byte identical.
- [ ] Only root-released focused pure/unchanged117/main/API artifact tests,
      Node positive ownership+viewer-entry, scoped lint/format/isolation/diff;
      sequential final API typecheck ONCE and build ONCE for actual compiled
      primitive validator. NO full tooling glob/ordinary API/native/provider/
      DB/browser/Vite/listeners/network/actual initialize/verify or CI retry.
- [ ] Freeze full nine-path diff/hashes/report, forward failures/counts/warnings
      and explicit unrun gates for root FULL READ and the same independent SOURCE
      reviewer before publication. Root owns any later whole-tooling/exact-CI
      decision; no automatic actual-run ladder. TimeoutError timer ambiguity and
      synchronous capture cost remain, historical/actual922 underlying cause UNKNOWN.
