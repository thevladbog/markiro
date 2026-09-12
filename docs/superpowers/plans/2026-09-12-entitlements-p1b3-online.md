# P1B.3a Online Entitlement Observations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Observe P1 entitlement decisions at actual operation owners for inventories, CommerceML, label templates and pallets, preserving existing admission and recoverability.

**Architecture:** Extend the existing capture/observe/withAdmission facade with verified identities; directly connect owners after their current authorization, validation and replay checks. Each owner retains its transaction, locks, cursor/fence and effects. An explicit coverage inventory distinguishes new work from continuation, historical reads and evidence intake.

**Implementation base:** `2b657110267bbec9eb4d30c10428cac8d60b4465` (merged #547); design reference remains `b313f90f6`.

**Tech Stack:** Node24, pnpm11.22.0, NestJS, TypeScript, Zod, Drizzle/PostgreSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-entitlements-p1b3-online-design.md` (approved).

## Global Constraints

- Все текущие фактические проверки безопасности, подписки, квот и release/config сохраняются.
- Ошибка наблюдения имеет результат unknown, а не allow, и не отравляет бизнес-транзакцию.
- Подготовка facts выполняется непосредственно перед транзакцией; наблюдение — после действующих проверок и определения реального действия, до соответствующей записи/нового внешнего эффекта.
- Существующие порядок блокировок, isolation, leases, курсоры и идемпотентность сохраняются. В открытой транзакции не захватывается второе подключение к пулу.
- Cabinet сохраняет user ID. CommerceML получает domain `exchange_session` и ID подтверждённой сессии; publicApi к нему не добавляется.
- Источники с ограниченным списком операций не получают новые ID автоматически. Старые ID и receipts не переписываются.
- Прежние snapshots, templates, barcode/file bytes, manifests, cursor/fence, operational and financial history remain immutable.
- P1B.3b public-API execution and P1C handheld/offline grants remain explicitly deferred; this delivery never changes customer rollout or catalog publication gates.
- No dependency upgrades, unrelated refactors, global interceptors, duplicate resolver or generic hooks framework.
- Worktree local changes only. No staging/commit/push/PR/deploy/cleanup without a new user request for this delivery. Keep evidence and previous worktrees.
- Node24 path: `/opt/homebrew/opt/node@24/bin`. Rebuild changed shared packages before API tests. Database suites must use a separate temporary localhost database; never migrate/reset shared data. Reports must redact credentials.

## File and verification ownership

Task1 owns the initial registry/actor additions, inventory owners and callable coverage test. Tasks2/3 extend the same inventory sequentially and change their own registry coverage only after wiring is tested. No concurrent implementers or shared output builds. Root owns final full API/affected consumer gates and final review. Each implementer runs focused regressions and API static gates; run full shared package gates when that package changes.

A fresh reviewer gates each task. Reports record exact commands, RED failure, GREEN result, warnings, omitted checks, changed signatures and branch status. Root snapshots each task's initial file contents, so uncommitted changes can be reviewed independently without requiring commits.

### Task 1: Registry, verified observation identity and inventory owners

**Files:**

- Modify: `packages/platform-contracts/src/entitlements.ts`, `packages/platform-contracts/test/entitlements.test.ts`.
- Modify: `apps/api/src/subscriptions/entitlement-admission.service.ts`, `apps/api/test/entitlement-admission.test.ts`.
- Modify: `apps/api/src/modules/inventories/inventories.service.ts`, `inventory-lifecycle.service.ts`, `inventories.module.ts` and controllers only when identity plumbing requires it.
- Modify: `apps/api/test/entitlement-operation-inventory.test.ts`.
- Create: `apps/api/test/inventory-entitlement-admission.test.ts` using isolated real PostgreSQL and existing inventory lifecycle/snapshot fixture patterns.
- Create: `docs/operations/entitlements-p1b3.md` with four-family owner inventory; fill verified inventory portion now, list unimplemented families as pending tasks, never claimed covered.
- Inspect: `apps/api/test/inventory-lifecycle.e2e.test.ts`, `inventory-snapshot.e2e.test.ts`, `inventory-chz-import.test.ts`, `subscription-route-inventory.test.ts`, existing NK/CHZ admission owners and scoped API/Handheld guides.

**Interfaces:**

- Consumes existing `capture(tenantId): Promise<AdmissionFacts>`, `observe(input: EntitlementAdmissionInput): Promise<EntitlementAdmissionObservation>`, `withAdmission<T>(input, action): Promise<T>`.
- Produces truthful actor union adding `{domain:"exchange_session";id:string}`; retains existing cabinet/api_key/system semantics and IDs. Never infer api_key from header presence. Missing real actor must not be disguised as system.
- Produces new operation IDs `inventory.task.create.v1` and `inventory.task.start.v1`, inventory feature and existing cabinet capability. Retains `inventory.file.create.v1` for real new file input, not all inventory actions.
- Produces additive coverage `p1b_adapter`; existing p1a/classified/deferred remain. Advance new observation registry version to `p1b.v1` for the additive registry. Preserve every existing operation definition and historical observation/receipt bytes; check consumers rather than rewriting saved records to the new version.
- Inventory table and callable checks are extensible by subsequent tasks with explicit operation/owner/class/replay boundaries.

- [x] Map every inventory entry: task create, new file import/finalization, first ready→running start, repeated running start, CHZ fresh export, cancellation, station sync/corrections, frozen documents and retained reads. Specify which use new-work IDs and which remain classified recovery/read; no caller-supplied recovery flag.
- [x] RED contract/admission tests: new IDs/coverage, scoped grants do not automatically authorize new IDs, exchange session does not compose publicApi; cabinet/api_key behavior unchanged. Exact assertion pattern:

```ts
expect(ENTITLEMENT_OPERATIONS["inventory.task.start.v1"].features).toEqual(["inventory"]);
expect(ENTITLEMENT_OPERATIONS["inventory.task.start.v1"].class).toBe("new_work");
expect(ENTITLEMENT_OPERATIONS["handheld.work.start.v1"].coverage).toBe("deferred");
```

- [x] RED real DB tests call actual inventory owners with dependency wiring: task create, new file input, first start save exact shadow row; repeated import/start returns prior stored result without a second new-work observation. Existing cross-tenant/security/subscription rejection and malformed input remain rejection before new effect. Disabled P1 inventory and injected shadow failure preserve current success; stale captured proof reports unknown. Assert business/audit/manifest equality and canonical scope, not only counts.

```ts
expect(observation).toMatchObject({
  tenantId,
  actorType: "cabinet",
  actorId: actorUserId,
  operationId: "inventory.task.create.v1",
  outcome: "deny",
});
expect(observation.resourceScope.digest).toBe(expectedCanonicalDigest);
expect(createdInventory.createdByUserId).toBe(actorUserId);
expect(replayedManifest).toEqual(originalManifest);
```

- [x] Implement direct capture/observe in each new-effect branch, keeping current lock and replay order. Capture before tx; observe uses the same tx after verified facts. Example control flow (reuse owner variables):

```ts
const facts = await this.admission.capture(tenantId);
return this.db.transaction(async (tx) => {
  const current = await existingLockedRead(tx);
  if (isExistingReplay(current)) return existingStoredResult(current);
  await existingValidation(tx, current);
  await this.admission.observe({
    tenantId,
    facts,
    actor: { domain: "cabinet", id: actorUserId },
    operationId: "inventory.task.start.v1",
    scopeDigest: admissionScopeDigest({ inventoryId, snapshotId: current.activeSnapshotId }),
    runtime: { enabled: true, observedAt: new Date() },
    transaction: tx,
  });
  return existingPersistAndAudit(tx, current);
});
```

`runtime.enabled:true` is valid only where the owner has just verified every existing readiness condition; otherwise pass actual false/null. This block describes ordering, not replacement helpers or permission to rewrite business logic.

- [x] Run focused tests RED then GREEN, contracts full test/typecheck/lint/build, API focused admission+inventory suites/typecheck/lint/build. Include actual Nest DI execution and savepoint failure isolation. Update owner inventory and callable AST checks, retaining original P1A assertions. Report no effect on public API/handheld/offline protocols. Do not commit.

### Task 2: CommerceML observations at protocol effect boundaries

**Files:**

- Modify: `apps/api/src/modules/exchange/exchange.controller.ts`, `exchange.module.ts`; `exchange-session.service.ts` only where a validated session/fence field must be propagated.
- Modify: `packages/platform-contracts/src/entitlements.ts`, `packages/platform-contracts/test/entitlements.test.ts` for this family's coverage and only necessary additive operation classification.
- Modify: `apps/api/test/entitlement-operation-inventory.test.ts`, `docs/operations/entitlements-p1b3.md`.
- Create: `apps/api/test/exchange-entitlement-admission.test.ts`.
- Inspect/run relevant: `exchange-protocol.e2e.test.ts`, `exchange-import.e2e.test.ts`, `exchange-orders.e2e.test.ts`, `exchange-sale-import.test.ts`, `exchange-import-batch.test.ts`, existing exchange credentials/session cursor/export fencing tests.

**Interfaces:**

- Consumes Task1 existing facade plus verified exchange actor `{domain:"exchange_session";id:session.id}` and p1b_adapter coverage.
- Produces direct owner observations for actual fresh import/apply and creation of new export batches using `commerceMl.exchange.v1`, with session/cursor/file or batch digest as canonical identity. Replay/continuation/success acknowledgement remain distinct, never new work merely because another HTTP request arrived.

- [x] Map all GET/POST modes and deeper effect owners. Identify session verification, file chunk/cursor, import/offer/status writes, fresh query batch vs retained pending batch, success ACK and expired/invalid session. Use semantic action stages; do not wrap the entire controller or classify all GET as reads.
- [x] RED real-owner tests: verified exchange session gets exact actor and commerceMl decision while publicApi=false; invalid credentials/session gets no tenant observation; fresh import/export observed once at correct owner boundary; retries/cursor continuation/known batch ACK do not become fresh export/import. Preserve protocol response bytes, cursor/fingerprint/fenced attempt, lease and known provider batch identity.

```ts
expect(observation).toMatchObject({
  tenantId,
  actorType: "exchange_session",
  actorId: sessionId,
  operationId: "commerceMl.exchange.v1",
});
expect(observation.reasonCodes).not.toContain("feature_publicApi_disabled");
expect(retryResponse.text).toBe(originalResponse.text);
expect(await loadPendingBatch()).toEqual(originalPendingBatch);
```

Use actual reason codes from projection in final test; also assert the full relevant reasons to avoid a meaningless negative string assertion.

- [x] Inject admission through Nest/factory dependencies. Capture just before owner transaction or external effect admission, not at unauthenticated checkauth entry. Preserve current subscription checks and owner locking. Never open a second connection under owner tx or hold PostgreSQL tx across HTTP/image downloads.

```ts
await this.admission.observe({
  tenantId: session.tenantId,
  actor: { domain: "exchange_session", id: session.id },
  operationId: "commerceMl.exchange.v1",
  facts,
  transaction: tx,
  scopeDigest: admissionScopeDigest({ sessionId: session.id, action, fingerprint, cursor }),
  runtime: verifiedRuntime,
});
```

Only include transaction/facts when owned by actual operation; preserve no-tx facade path where appropriate. No credentials/raw CommerceML payloads in scope/logs. No new generic hooks.

- [x] Prove shadow deny and persistence failure cannot change previously allowed action/response or poison committed cursor/audit. Prove existing subscription denial still denies. Existing external failures still propagate exactly as before.
- [x] Update coverage/inventory only for actual tested branches. Run focused exchange/admission/API contract tests and static/build gates. If contracts changed, rebuild and run their full gates before API. Record live1C testing as not performed; no source publication or commit.

### Task 3: Template and pallet owners; complete coverage and acceptance

**Files:**

- Modify: `apps/api/src/modules/label-templates/label-templates.service.ts`, `label-templates.controller.ts`, `label-templates.module.ts`.
- Modify: `apps/api/src/modules/shifts/shifts.service.ts`, `shifts.controller.ts`, `shifts.module.ts` only as needed for verified identity and DI.
- Inspect: tenant default-template owners introduced by #548, station/handheld shift callers and applicable scoped guides. Modify direct callers/tests only for necessary internal signature plumbing; no wire DTO changes.
- Modify: `packages/platform-contracts/src/entitlements.ts`, `packages/platform-contracts/test/entitlements.test.ts`, `apps/api/test/entitlement-operation-inventory.test.ts`, `docs/operations/entitlements-p1b3.md`.
- Create: `apps/api/test/template-pallet-entitlement-admission.test.ts`.
- Inspect/run: `label-templates.service.test.ts`, `label-templates.e2e.test.ts`, `label-templates-openapi.test.ts`, `shifts-pallets.test.ts`, `shifts.service.test.ts`, `shifts.controller.test.ts`, `shifts.e2e.test.ts`, tenant-default tests, station/handheld shift read/bundle/recovery and subscription-route inventory.

**Interfaces:**

- Consumes existing admission facade and p1b_adapter registry coverage; direct owner identity is server verified.
- Produces connected `labelEditor.template.write.v1`, `pallets.shift.configure.v1` and any required additive distinct start classification. Do not reuse configuration ID for accumulated production evidence or recovery. All four covered families have complete documented owner inventory; publicApi.request.v1/handheld.work.start.v1 remain deferred with reason.

- [x] RED actual-owner tests for label create/update/delete and all pallet-sensitive create/update/open/enter branches, including replay/no-op and ordinary box-only paths. Assert exact actor/tenant/action/digest and existing operational audit, foreign-tenant denial, shadow deny/unknown without changed admission. Registry/test coverage starts failing before real calls exist.

```ts
expect(templateAfter.spec).toEqual(expectedValidatedSpec);
expect(shadowRow).toMatchObject({ tenantId, actorId: userId, operationId });
expect(storedPrintSnapshot).toEqual(originalPrintSnapshot);
expect(boxOnlyObservationRows).toEqual([]);
```

Use real DB/service/HTTP fixtures to establish these variables. A mocked helper returning success or AST name alone is not wiring proof.

- [x] Pass verified actor through current controller/service boundaries without inventing cabinet users for system/device callers. Preserve create/update transaction and FOR UPDATE semantics. For station/device paths requiring observations, carry verified device identity with a truthful internal actor variant; do not translate it into public api_key or cabinet. Do not add the deferred handheld admission operation.
- [x] Place calls only at concrete template write or pallet configuration/start effects. Preserve delete/read/update policies as currently implemented; no new premium condition for printing retained templates, setting tenant defaults, ordinary box aggregation or collecting already authorized events. Classify #548 default-pointer change separately from editing template bytes.
- [x] Complete inventory across all four families with reasoned exclusions and regression references. Maintain separate public API and P1C deferral assertions, existing NK/CHZ owner checks and actual DI tests. No broad file split or new framework.
- [x] Run focused template/pallet/default/device regression suites and API static/build; shared contracts gates if changed. Report source frozen for root final full API and affected consumers. Root runs full API on fresh local DB, format/diff, relevant production contracts if wiring affects bundle, and independent whole-diff review. Any browser/native/external check not exercised is stated explicitly; server-only change does not claim hardware acceptance. No commits/push/cleanup.

## Local verification result — 2026-09-13

All three implementation tasks and their independent reviews are complete. Final CommerceML
identity review is closed. Changes remain local and uncommitted.

The final full API run passed 3969 tests and failed one existing retention fixture because it
mixed database creation time with Node revocation time. A deterministic clock-skew regression
reproduced the constraint failure; the fixture now matches production creation, and all 48
retention tests pass. Runtime code and database constraints were unchanged by this repair.

The 22 inventory tests requiring `INVENTORY_TEST_DATABASE_URL` were then run on an isolated,
freshly migrated database: 21 passed, one failed. The existing competing-device repack test
violates `inventory_repack_items_tenant_result_active_date_fk` when the winning scan changes
the observed date before the prior repack reference is released. Its service, test and schema
are unchanged by this delivery. This remains an unresolved issue outside the approved online
shadow stage; the repository is not claimed to have an entirely green test suite.

Contracts: 269 passed. Admin: 1376 passed. SaaS admin: 463 passed. Relevant typecheck, lint,
build, formatting and production bundle contracts (558 passed) completed. Three explicit
Mailpit/MinIO infrastructure cases and one live National Catalog case remain unexecuted.
No live 1C, browser, native device, hardware or deployment acceptance is claimed.
