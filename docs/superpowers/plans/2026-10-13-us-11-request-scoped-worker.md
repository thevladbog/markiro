# US-11 Exact-Run Request Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Execute only one explicitly selected tenant/run through the real durable Request worker, preserving the unchanged global runtime.

**Architecture:** Strict scoped entries select before lock/recovery; both global/scoped claims and worker entries share private bodies. Durable authority, clocks, fences, rendering and publication remain authoritative.

**Tech Stack:** Strict TypeScript, NestJS, Drizzle/PostgreSQL, Vitest, existing private synthetic storage fixtures, Node CI ownership contracts.

**Spec:** `docs/superpowers/specs/2026-10-13-us-11-request-scoped-worker-design.md`

## Local pre-push checkpoint — 2026-10-20

Task 1 source and local verification are implemented; independent task and final
selected-plan source reviews are Approved with no blocking finding. Native scoped
tests pass 20/20 and unchanged worker regressions
pass 249/249 across 10 files; tooling passes 192/192, with zero skips in these groups.
API typecheck/lint/build, focused formatting/diff and isolation pass. The owned
database catalog is unchanged after the focused runs. The single full ordinary
API invocation passes 4,807 tests across 332 files; 3,981 opt-in tests across 189
files are explicitly skipped in that invocation. The scoped native suite and
worker regressions above ran separately with their actual US database flag. The
ordinary API child was normally dropped, catalog absence verified, no new database
remained and its refusal listener closed after 29 refused connections.

Exact new-source GitHub CI acceptance remains a separate gate, not inferred from
these local checks or the approved source reviews. This is not proof of three
prepared dataset packages or complete demo acceptance. The inherited Vite
native-config warning remains visible; it is not suppressed by this increment.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`.
- Preserve existing worker deadlines, retry delays, lease/renewal policy, native test timeouts and assertions.
- No schema, migration, public route, fake Ready state, dataset adapter, production clock rewrite, RU/main/Station, PR, release or deployment.
- Root owns scoped commit/push after independent review; no implementer commits/pushes or nested agents.
- Native testing uses only `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev`; unset `DATABASE_URL`; create/drain/drop only owned disposable children, preserve unknown databases/processes.
- Build affected shared dependencies before API consumers; no reinstall, lockfile, environment-file or dependency policy changes.
- Begin only after prepared-services CI source review completes; remote full Trace acceptance remains a separate integration gate.

## Review Focus

- Wrong tenant paired with an existing run must never claim or recover that row.
- A locked or ineligible target must not cause fallback to eligible foreign work.
- Executable/extra-key scope must reject before property evaluation or sanitation changes its error.
- Scoped expired recovery returns no lease and must not silently re-claim or touch a foreign expired run.
- Shared-body extraction must preserve global claim sanitation, renewal shutdown and ambiguous publication reconciliation.

---

### Task 1: Exact-run claim and shared real worker execution

**Files:**

- Modify `apps/api/src/modules/traceability/requests/us-request-worker-lifecycle.ts` (contract + private shared claim).
- Modify `apps/api/src/modules/traceability/requests/us-request-worker.ts` (scoped entry + private shared execution).
- Create `apps/api/test/us-request-worker-scoped.e2e.test.ts`.
- Modify `.github/workflows/us-development.yml` and `tools/us-development/test/support/prepared-services-owner.mjs` plus `dataset-prepared-services-ownership.test.mjs` only for exact additive native selector and independent pin/denial proof.
- Adapt a strict contract fixture only if the interface addition actually breaks its type; retain all original assertions.

**Interfaces:**

```ts
// Added to existing lifecycle contract and implementation.
claimScoped(scope: unknown): Promise<UsWorkerLease | null>;
// Added to existing worker.
runScoped(scope: unknown): Promise<UsRequestWorkerResult>;
```

Consume existing `parseUsWorkerScope`, immutable execution identity and existing lifecycle/checkpoint/publication/storage services. No new selection proof or callback is accepted from callers. Existing no-argument `claimNext()` and `runOne()` stay compatible.

- [x] Read spec and preflight `design-review.md`, both production modules, existing lifecycle/worker/recovery tests and real worker fixtures. Record current global ordering and exact unchanged scheduling predicate.
- [x] Build API dependencies through `corepack pnpm turbo build --filter '@markiro/api^...'`. Record success before native tests.
- [x] Add a real owned-fixture failing test first, asserting the target lease belongs to its exact scope:

```ts
const actual = await lifecycle.claimScoped(scope);
expect(actual).toMatchObject(scope);
```

Use existing native fixture acquisition, tracked work and normal cleanup; missing-method failure is RED, connection/setup errors are not. Run only this failing native case with the explicit isolated variable and preserve its raw evidence and exact owned child absence.

- [x] Implement one shared private claim body with scope optional **only inside the private method**. Public scoped entry parses outside catches, then combines exact tenant/run predicate with eligibility before selection and `FOR UPDATE SKIP LOCKED`. Global entry passes no scope. Keep every existing validation/disposal/recovery/claim/audit action unchanged. No post-claim filtering or fallback.
- [x] Implement scoped worker entry parsing independently before storage/identity checks. Both entries use shared private preconditions/claim sanitation and identical post-claim execution; strict scoped entry invokes only `claimScoped`. The parse error must remain `us_request_worker_evidence_invalid`, not sanitized unknown failure. Preserve live renewal/failure cleanup/reconciliation.
- [x] Add real native coverage for every spec case. Arrange expensive preparations in existing bounded setup hooks, not enlarged bodies. Assert complete foreign run/request/attempt/audit/artifact/object state equality and exact target audit. Observe live concurrent lock contenders rather than assume sleeps prove contention. Include parser/accessor/extra-key/mutable-input denial and wrong-tenant identity.
- [x] Prove real scoped target Ready through renderer/checkpoint/private store/readback/publication and verify archive/digests; inject a real provider fault and exercise existing durable retry/recreation without new policy. Use existing test-only clock transport only where necessary for existing elapsed lifecycle behavior, never mutate production clocks/evidence or fake Ready.
- [x] Add one literal native filename to the reviewed prepared-services command/helper/independent pins. Assert omission/duplicate/filter denial while preserving exact job/body/time budgets and every older ownership mutation. Do not add a second owner or touch the historical matrix/Trace command.
- [x] Run the new suite, unchanged native consumers and pure tooling checks with unchanged budgets:

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-request-worker-scoped.e2e.test.ts --maxWorkers=1
corepack pnpm --filter @markiro/api exec vitest run test/us-request-worker-lifecycle.e2e.test.ts test/us-request-worker.e2e.test.ts test/us-request-worker-recovery.e2e.test.ts test/us-request-worker-checkpoint.e2e.test.ts test/us-request-worker-publication.e2e.test.ts test/us-request-worker-runtime.test.ts test/us-request-worker-execution.test.ts --maxWorkers=1
node --test tools/us-development/test/*.test.mjs
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
git diff --check
```

Record native failures before any fix; successful retry alone does not establish cause. If a failure requires broader design, stop implementation and report measured evidence for root ruling. Log actual owned child drain/disposal/catalog absence; never kill/drop unknown targets.

- [x] Run focused repository Prettier check on changed paths and self-review against spec, unchanged global routes and zero policy changes. Write complete report, exact counts/skips/commands/children/pending CI and concerns; hand off source unstaged for root review.

## Root review and acceptance

- [x] Root generates exact Task 1 package and independent spec/quality review, addressing findings through implementer and scoped re-review.
- [x] Obtain most-capable complete selected-plan source review; keep source verdict separate from actual runtime evidence.
- [ ] Authorized scoped US commit/push only after predecessor run settles and relevant reviews/gates pass. Verify exact new-SHA native ownership/execution in CI before integration acceptance.
- [ ] Only then design the owned dataset Request preparation adapter and three-package integration; no fake Ready or full-demo completion claim from this generic service seam.
