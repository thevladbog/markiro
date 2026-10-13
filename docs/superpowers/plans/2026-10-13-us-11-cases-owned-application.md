# US-11 Cases Owned Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Remove the measured duplicate Cases application preparation through one service-owned native support/link command, preserving full post-write proof.

**Architecture:** A strict native seed entry prepares, creates support and links in the caller's transaction. The dataset seed consumes only its parsed result; the unchanged final verifier and receipt publication stay authoritative.

**Tech Stack:** TypeScript/NestJS, Drizzle/PostgreSQL, Vitest, existing Cases fixtures and native CI ownership contracts.

**Spec:** `docs/superpowers/specs/2026-10-13-us-11-cases-owned-application-design.md`

## Global Constraints

- Use only `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`.
- Preserve full post-write origin/support/link/operation/audit verification and all existing lock, authorization, rollback and original-key semantics.
- No caches, preverified inputs, caller proof, skip flags, caller callbacks, nested transaction or native retries.
- Preserve 900000/60000 full-test/fixture limits and all original suite timeouts/assertions; no unchanged full Trace rerun.
- No schemas/migrations, public routes, dependencies/env files, RU/main/Station, PR, releases or hosting.
- Root owns scoped commits/push and independent reviews; implementer must not spawn agents, commit or push.
- Native checks use only explicit isolated `US_TEST_DATABASE_URL` at localhost55432 synthetic base with `DATABASE_URL` unset; owned children drain/drop/catalog absence, unknown resources preserved.

## Review Focus

- A native seed method must not adopt already-present pending support or links.
- Same-transaction trigger drift after support insertion must still fail final proof and roll back everything.
- Wrong context/DB/tenant/actor must be denied before hostile input can grant synthetic ownership.
- Existing link-only native entry must not start creating support or change its audit/result.
- An exact query reduction must not be mistaken for full 260+2 budget acceptance.

---

### Task 1: Owned support/link native entry and unchanged dataset final proof

**Files:**

- Modify `apps/api/src/modules/traceability/cases/us-case-demo-command.ts` and `us-case-store.ts`.
- Modify `apps/api/src/modules/traceability/demo/us-dataset-cases-seed.ts` only to consume the new native result.
- Reuse `us-dataset-cases-support.ts`, existing strict result/identity codecs and native content linker unchanged unless a concrete narrow type export is needed.
- Create `apps/api/test/us-case-demo-owned-application.e2e.test.ts`.
- Modify `apps/api/test/us-dataset-cases-seed.e2e.test.ts` only to retarget necessary existing post-preparation interception points; preserve behavioral assertions and actual cancellation/rollback schedules.
- Modify `.github/workflows/us-development.yml`, prepared-services owner helper and independent ownership test only to append the new exact native selector with omission/duplicate/filter denial.

**Interfaces:**

```ts
// UsCaseStore: same tx/context identity types as existing linkDemoInTransaction.
seedDemoInTransaction(tx, context, datasetId, unitKey, requestId): Promise<{
  input: UsDatasetCasesInput;
  support: UsDatasetCasesResult["support"];
  linked: CaseLinkResult;
}>;
```

Use the existing actual exported Cases input/support types, or derive them from `UsDatasetCasesResult` to avoid duplicate structural models. No caller can supply the output or its preparation. Existing `linkDemoInTransaction` signature/semantics remain unchanged.

- [ ] Read selected spec, actual Cases prepare/support/content/store/seed/verifier and existing native fixtures; read root/API instructions. Map exact before/after call sequence and strict result parser.
- [ ] Build affected API dependencies with `corepack pnpm turbo build --filter '@markiro/api^...'` before consumers.
- [ ] Arrange real saved Cases intent and native upstream prerequisites in owned fixture setup; write a failing absent-method native test and capture its meaningful RED:

```ts
const actual = await store.seedDemoInTransaction(tx, context, datasetId, unitKey, requestId);
expect(actual.linked.created).toHaveLength(expectedCaseCount);
```

Do not count sandbox/setup failure as RED; retain tracked work/normal owned cleanup and existing setup/body deadlines.

- [ ] Implement single preparation -> existing support insertion -> existing native content linker, strict parsed return. Share only private post-preparation code where useful; independently authorize/prepare in both native entry paths. Update seed apply to consume return; leave full final verifier unchanged.
- [ ] Add exact persisted support/link/operation/audit/receipt checks, caller rollback, native failures and all Review Focus denials. Cover current guards plus same-key competitors. Install a real support-insertion trigger changing the upstream output-product name, plus a separate ancestor mutation after the application returns. Both must fail the real unchanged final verifier with its existing mismatch wrapper/upstream cause, preserve pending intent/key and roll back support/link/operation/audit/receipt and trigger writes in all198-table snapshots. Direct entry result is application evidence only, not final proof. Existing link-only consumers keep original assertions and support preconditions.
- [ ] Retarget seed test spies to an equivalent existing post-preparation native content/SQL boundary, forwarding actual work. Preserve zero content-link attempts for support/box/marker failures versus one attempt for link/dependency/audit/operation/receipt failures; competitor single application; five primary error-object forms and full rollback. For cancellation observe the actual blocked executor PID, release its holder only after abort, execute the guard after preparation before content commit, then drain and prove snapshot rollback/backend absence. No production hook, deleted assertion, timeout change or name-only rename moving the guard before the waiter. Record the exact changed hooks and unchanged assertions in the report.
- [ ] Measure the new Cases application path against the original HEAD behavior using actual parameter-free forwarding counts on equivalent owned fixtures. Confirm one application preparation + unchanged final preparation; original shape/native facts and all198-table no-write replay parity. Archive temporary diagnostic code outside API test collection, not as an accepted fake-count fixture.
- [ ] Append the new literal suite selector to reviewed prepared-services CI owner and independent pins; retain complete old command selectors, action/build/service/release/historical gates and 30-minute timeout. Run all Node ownership tests.
- [ ] Execute relevant unchanged native consumers serially plus new suite:

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-case-demo-owned-application.e2e.test.ts test/us-case-demo-command.e2e.test.ts test/us-dataset-cases-prepare.e2e.test.ts test/us-dataset-cases-verify.e2e.test.ts test/us-dataset-cases-locks.e2e.test.ts test/us-dataset-cases-seed.e2e.test.ts test/us-dataset-regular-seed.e2e.test.ts test/us-dataset-shipping-seed.e2e.test.ts --maxWorkers=1
node --test tools/us-development/test/*.test.mjs
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
git diff --check
```

Report every actual failure before repair; no successful-retry-only explanation. Record exact counts/skips and owned child drain/drop/absence; no unknown cleanup. If the original suite exposes another boundary needing design, stop and report, not increase its timeout.

- [ ] Run focused Prettier, self-review and complete report with measured reductions, exact commands/raw evidence and remaining whole-test budget obligations. Return unstaged source to root; no full Trace acceptance or native CI success inference.

## Root review and next slice

- [ ] Root produces exact Task 1 review package; independent spec/quality review, scoped fix review if needed, then most-capable final selected-plan source review.
- [ ] Keep source verdict distinct from actual same-SHA native CI. Do not push just to replay the unchanged failed full gate: combine with subsequently reviewed, measured composition remedy.
- [ ] Next separate design must address entire `G + 2*V + 3*R + H` budget while retaining full original fault/resume/verify/replay/snapshot test. This plan alone carries no sub-900-second forecast.
