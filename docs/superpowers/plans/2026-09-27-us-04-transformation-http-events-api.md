# US-04 Transformation HTTP and Events API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the already-built Transformation lifecycle through the isolated U.S. API and serve one tenant-safe, globally paginated Receiving/Transformation Events registry.

**Architecture:** Keep Receiving's HTTP routes and typed root unchanged. Add strict Transformation HTTP/revision contracts and a typed controller over `UsTransformationStore`; add a read-only Events registry over `traceability_events` with type-specific root validation. This API is independently testable before the companion [Events UI plan](2026-09-27-us-04-events-transformation-ui.md).

**Tech Stack:** Node 24, Corepack/pnpm, TypeScript, Zod, NestJS, Drizzle/PostgreSQL, Vitest.

**Spec:** [2026-09-26-us-04-transformation-http-events-ui-design.md](../specs/2026-09-26-us-04-transformation-http-events-ui-design.md). Read this approved spec, the root `AGENTS.md`, scoped guides if present, and affected code/tests before execution.

## Global Constraints

- Isolated `codex/us-mvp` U.S. instance only; no RU router, Station/scanner/print, Shipping placeholder, synthetic seed, public deployment or release.
- Keep existing Receiving API/editor responses and frozen v1/v2/v3 snapshots compatible. Civil `event_date` and saved IANA timezone are not UTC timestamps.
- `en-US` and `es-US` are the only U.S. locales; this API returns identifiers and neutral structured codes, not translated server prose.
- `traceability.read` guards reads; `traceability.transformation.write` guards original draft create/save; an amendment save additionally requires `traceability.qa.manage` even on replay. QA guards finalize/amend/void.
- Original draft void needs reason, operation key, exact lifecycle and draft versions, immutable history and audit; it changes no lot, case, genealogy or frozen snapshot.
- Event list: `type=all|receiving|transformation`, `history=current|all`, optional status, event-number search ≤200 characters, limit 1–100, offset 0–100000, global `(created_at DESC,id DESC)` order in one tenant-scoped repeatable-read snapshot.
- Command receipts are historical; exact authorized replay returns the same receipt. Unknown/foreign IDs disclose nothing. Host, Origin, no-store, strict input and US OpenAPI remain enforced.
- Use only disposable child databases under `US_TEST_DATABASE_URL`; never use shared development or production data. Build changed shared packages before API tests.
- Preserve all existing dirty work. Do not commit, push, create a PR, merge or deploy without separate authorization; the skill's default commit step is intentionally omitted.

## Review Focus

1. A QA actor's role changes to production before replaying an amendment save: return 403 before the stored receipt (Task 2 test).
2. A stale original-draft void races a save/finalization: return 409, preserve the current state and write no success audit (Task 2 test).
3. A mixed page crosses the Receiving/Transformation boundary: sort and page once globally, never merge two separately paged arrays (Task 4 test).
4. A finalized location card changes after the event: summary keeps the frozen location display, while a draft uses current tenant reference data (Task 4 test).
5. A malformed/wrong-type/foreign ID or a missing typed root: 400/404 or fail-closed 503 as appropriate, never cross-tenant disclosure or a misleading empty page (Tasks 3–4 tests).

---

## File and interface map

- `packages/platform-contracts/src/traceability/transformation-http.ts`: strict typed record union, revision list/query and safe lifecycle error shape. Export through `packages/platform-contracts/src/index.ts`.
- `packages/platform-contracts/src/traceability/events.ts`: strict mixed summary/query/response schemas; no command abstraction.
- `apps/api/src/modules/traceability/transformation/us-transformation-revisions.ts`: bounded same-root history, current lifecycle version and complete chain validation.
- Existing `us-transformation-draft.ts` and `us-transformation-lifecycle.ts`: amendment-save QA check and original-draft void only. `us-transformation-store.ts` exposes the new revision read.
- `apps/api/src/deployment/us-transformation.controller.ts`: typed routes. `us-runtime.ts`, `us-development.module.ts`, `us-http.ts`: explicit store/controller registration and 256 KiB create/save parse limit.
- `apps/api/src/modules/traceability/events/us-events-registry.ts` and `us-events-store.ts`: one authorized, tenant-scoped list read; `apps/api/src/deployment/us-events.controller.ts`: one guarded GET.
- Focused tests live beside existing `us-transformation-*.e2e.test.ts`, `us-receiving-registry.e2e.test.ts`, and `us-case-http.e2e.test.ts` patterns. New test files are named in each task.

Stable handoff interfaces for all tasks:

```ts
type TransformationHttpRecord = TransformationDraftRecord | TransformationHistoricalRecord;
type TransformationRevisionSummary = {
  id: string;
  rootId: string;
  eventNumber: string;
  revision: number;
  status: "draft" | "finalized" | "amended" | "void";
  timeZone: string;
  lifecycleVersion: number;
  currentEventId: string | null;
  pendingDraftId: string | null;
  previousRevisionId: string | null;
  amendmentReason: string | null;
  voidReason: string | null;
};
type TransformationRevisionList = {
  items: TransformationRevisionSummary[];
  limit: number;
  offset: number;
  lifecycleVersion: number;
};
type UsEventSummary =
  | {
      type: "receiving";
      id: string;
      rootId: string;
      eventNumber: string;
      revision: number;
      status: "draft" | "finalized" | "amended" | "void";
      lifecycleVersion: number;
      currentEventId: string | null;
      pendingDraftId: string | null;
      eventDate: string | null;
      timeZone: string;
      locationId: string | null;
      locationDisplay: string | null;
      lineCount: number;
      documentCount: number;
      previousSourceLocationId: string | null;
      updatedAt: string;
    }
  | {
      type: "transformation";
      id: string;
      rootId: string;
      eventNumber: string;
      revision: number;
      status: "draft" | "finalized" | "amended" | "void";
      lifecycleVersion: number;
      currentEventId: string | null;
      pendingDraftId: string | null;
      eventDate: string | null;
      timeZone: string;
      locationId: string | null;
      locationDisplay: string | null;
      inputCount: number;
      outputCount: number;
      documentCount: number;
      updatedAt: string;
    };
type UsEventList = { items: UsEventSummary[]; limit: number; offset: number };
```

Do not use these TypeScript aliases as a substitute for strict Zod schemas. Reuse `platformUuidSchema`, the existing Receiving/Transformation status and civil-date schemas, `listReceivingLiveRecordsQuerySchema.pick({limit:true,offset:true,search:true,status:true,history:true})`, and existing record schemas where compatible. A list response must reject duplicate IDs, inconsistent root identity/lifecycle on two rows from one root, and more items than `limit`.

## Task 1: Strict HTTP, revision and mixed-list contracts

**Files:** Create `packages/platform-contracts/src/traceability/transformation-http.ts`, `packages/platform-contracts/src/traceability/events.ts`, `packages/platform-contracts/test/us-transformation-http.test.ts`, `packages/platform-contracts/test/us-events.test.ts`; modify `packages/platform-contracts/src/index.ts`.

**Interfaces:** Export `transformationHttpRecordSchema`, `transformationRevisionListQuerySchema`, `transformationRevisionListSchema`, `transformationHttpErrorSchema`, `usEventListQuerySchema`, `usEventListSchema` and their inferred types. `transformationHttpRecordSchema` is the union of the existing draft and historical record; query numbers accept only the repository's canonical query-integer form. The strict error union names `transformation_not_found`, `transformation_reference_not_found`, `transformation_not_draft`, `transformation_draft_conflict`, `transformation_lifecycle_conflict`, `transformation_pending_amendment`, `transformation_operation_conflict`, `transformation_readiness_changed`, `transformation_output_identity_locked`, `transformation_lot_conflict`, `transformation_genealogy_cycle`, `traceability_downstream_blocked` and `event_incomplete`. The last two retain only typed metadata: `event_incomplete.issues` uses `transformationIssueSchema`; `traceability_downstream_blocked.blockers` is at most 100 `{lotId,eventId,rootId,revision}` rows plus `hasMore: boolean`. The HTTP controller maps the existing internal exception's full blocker array to this bounded response, without changing the command's all-consumer safety check. `transformation_pending_amendment` retains a UUID `pendingDraftId`.

- [ ] **Step 1: Write RED contract tests.** Assert strict unknown-key rejection, canonical query bounds, discriminated event summaries, no over-limit response, no duplicate event IDs, and consistent root lifecycle on same-root rows. Keep the test data synthetic and valid under the existing record schemas.

```ts
expect(usEventListQuerySchema.parse({})).toMatchObject({
  type: "all",
  history: "current",
  limit: 50,
  offset: 0,
});
expect(usEventListQuerySchema.safeParse({ type: "shipping" }).success).toBe(false);
expect(usEventListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
expect(usEventListQuerySchema.safeParse({ search: "x".repeat(201) }).success).toBe(false);
expect(transformationRevisionListQuerySchema.safeParse({ limit: "01" }).success).toBe(false);
const id = randomUUID();
const row = {
  type: "receiving" as const,
  id,
  rootId: id,
  eventNumber: "REC-26-0001",
  revision: 1,
  status: "draft" as const,
  eventDate: null,
  timeZone: "America/Chicago",
  lifecycleVersion: 1,
  currentEventId: null,
  pendingDraftId: id,
  locationId: null,
  locationDisplay: null,
  lineCount: 0,
  documentCount: 0,
  previousSourceLocationId: null,
  updatedAt: "2026-09-27T00:00:00.000Z",
};
expect(usEventListSchema.safeParse({ items: [row, row], limit: 2, offset: 0 }).success).toBe(false);
```

- [ ] **Step 2: Run RED.** `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/us-transformation-http.test.ts test/us-events.test.ts`; require missing exports/assertion failures, not skipped tests.
- [ ] **Step 3: Implement strict schemas.** Derive page/search/status/history from `listReceivingLiveRecordsQuerySchema.pick({ limit: true, offset: true, search: true, status: true, history: true })`; add `.strict()` and default `type`. This preserves canonical query-integer parsing and the existing search control-character check. Define the `UsEventSummary` branches above with literal `type`, exact count bounds (0–100), nullable civil date/location, and stable ISO instants. Refinements enforce duplicate/root consistency and `items.length <= limit`. Accept actual validated error metadata only, never a raw exception string.

```ts
export const usEventListQuerySchema = listReceivingLiveRecordsQuerySchema
  .pick({ limit: true, offset: true, search: true, status: true, history: true })
  .safeExtend({
    type: z.enum(["all", "receiving", "transformation"]).default("all"),
  })
  .strict();
```

- [ ] **Step 4: Run GREEN and package gates.** Repeat the focused command, then `corepack pnpm --filter @markiro/platform-contracts test`, `typecheck`, `lint`, `build`. Review the exported names against the interface map before Task 2.

## Task 2: Lifecycle correction and bounded Transformation revisions

**Files:** Modify `apps/api/src/modules/traceability/transformation/us-transformation-draft.ts`, `us-transformation-lifecycle.ts`, `us-transformation-store.ts`; create `apps/api/src/modules/traceability/transformation/us-transformation-revisions.ts`, `apps/api/test/us-transformation-original-draft-void.e2e.test.ts`, `apps/api/test/us-transformation-revisions.e2e.test.ts`; extend `apps/api/test/us-transformation-draft.e2e.test.ts` for amendment-save authorization.

**Interfaces:** `UsTransformationStore.listRevisions(tenantId: string, actorUserId: string, eventId: unknown, query: unknown): Promise<TransformationRevisionList>`; `readTransformationRevisions(tx, tenantId, eventId, query)` owns same-tenant/type root validation. Existing `.void()` retains its signature and receipt schema. No schema migration is planned; if existing DB guards reject a revision-1 void, stop this task and add a new reviewed migration and upgrade test rather than editing migration 0132.

- [ ] **Step 1: Write RED original-void and QA-replay tests.** Use `seedReceivingTenant(f.db)` and `new UsTransformationStore(f.db)` to create a real original draft through `.createDraft()`; the older `seedTransformationDraft` inserts only a bare shell and is not a command fixture. Void with exact versions and a reason, read it as historical `void`, assert no output lot/genealogy/case/snapshot effects, exact audit and no reopened root. Retry the exact operation under QA authority, then change membership to a non-QA role and expect 403. Create revision 2 under QA, deny its save under a production role, save it under QA, then revoke QA and deny an exact replay.

```ts
const c = await seedReceivingTenant(f.db);
const store = new UsTransformationStore(f.db);
const draft = await store.createDraft(
  c.tenant,
  c.actor,
  {
    operationKey: randomUUID(),
    draft: {
      eventDate: null,
      processorLocationId: null,
      reason: null,
      reasonNote: null,
      notes: null,
      inputs: [],
      outputs: [],
      documentIds: [],
    },
  },
  "create-original",
);
const beforeEffects = await readEffects(f, c.tenant);
const command = {
  operationKey: randomUUID(),
  expectedLifecycleVersion: 1,
  expectedDraftVersion: draft.draftVersion,
  reason: "Duplicate work order",
};
const receipt = await store.void(c.tenant, c.actor, draft.id, command, "void-original");
expect(receipt.record).toMatchObject({
  status: "void",
  lifecycle: {
    currentEventId: null,
    pendingDraftId: null,
    lifecycleVersion: 2,
  },
});
expect(await store.void(c.tenant, c.actor, draft.id, command, "exact-replay")).toEqual(receipt);
expect(await readEffects(f, c.tenant)).toEqual(beforeEffects);
```

Define `readEffects(f, tenant)` in the test using one parameterized `f.pool.query`: select `jsonb_agg(to_jsonb(x) ORDER BY id)` from tenant-scoped `traceability_lots`, `jsonb_agg(to_jsonb(x) ORDER BY event_id,input_lot_id,output_lot_id)` from tenant-scoped `lot_genealogy_edges`, and `jsonb_agg(to_jsonb(x) ORDER BY id)` from tenant-scoped `trace_lot_boxes`; also select only non-null `finalization_snapshot` from tenant-scoped `traceability_events` ordered by `id`. Return the single row `{ lots, edges, cases, snapshots }`. Compare before/after; exclude audit because a successful void must add one exact `tenant_audit_events` row. Assert that row's tenant, actor, action, target, request ID and before/after content separately, not merely its count.

- [ ] **Step 2: Run RED.** `corepack pnpm --filter @markiro/api exec vitest run test/us-transformation-original-draft-void.e2e.test.ts test/us-transformation-draft.e2e.test.ts`; require `US_TEST_DATABASE_URL` and a real failing assertion rather than an environment skip.
- [ ] **Step 3: Apply the smallest lifecycle/auth changes.** In `saveTransformationDraft`, after parsing the tenant/type-scoped ID but before looking up a saved operation, read the immutable target revision and require QA for revision >1. This must also cover exact replay after the revision is no longer draft. In `executeTransformationLifecycle`, accept revision 1 draft only when `pendingDraftId===eventId` and `currentEventId===null`; still require matching draft/lifecycle versions. Reuse the current atomic void/audit/receipt path and do not create any lot effects.

```ts
const [identity] = await tx
  .select({ revision: events.revision })
  .from(events)
  .where(
    and(eq(events.tenantId, tenantId), eq(events.id, eventId), eq(events.type, "transformation")),
  );
if (!identity) throw new NotFoundException({ code: "transformation_not_found" });
if (identity.revision > 1)
  await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.QA_MANAGE);
// Only then inspect the operation key, including an exact replay.
```

- [ ] **Step 4: Write RED revision-list tests.** Create finalized rev 1, pending rev 2, canceled rev 2, finalized rev 3. Page at limit 2; assert ascending revision order, identical root/number/timezone/lifecycle version, and visible void reason. Wrong-type/foreign event IDs must be 404, and a missing/mismatched typed root must fail closed rather than return a partial history.
- [ ] **Step 5: Implement bounded revision read.** Authorize `READ` in one repeatable-read transaction. Resolve event type/tenant, lock/read the typed root consistently, read its chain in ascending `revision` with limit/offset, validate contiguous identities and predecessor links against the complete chain before paging, then project only the summary fields from the interface map and parse `transformationRevisionListSchema`. Do not page first and then assume a corrupt omitted revision is safe.
- [ ] **Step 6: Run GREEN and review.** Focused suites plus existing `test/us-transformation-void.e2e.test.ts`, `test/us-transformation-lifecycle.e2e.test.ts`, `test/us-transformation-amendment-finalization.e2e.test.ts`; API `typecheck`, `lint`, `build`. Reviewer checks replay authorization order, exact audit, original-draft effect absence, historical record schema and full-chain validation.

## Task 3: Transformation HTTP transport and allowlist

**Files:** Create `apps/api/src/deployment/us-transformation.controller.ts`, `apps/api/test/us-transformation-http.e2e.test.ts`; modify `apps/api/src/deployment/us-runtime.ts`, `us-development.module.ts`, `us-http.ts`. Do not change Receiving controller routes.

**Interfaces:** The controller maps the exact typed routes in the spec to existing `UsTransformationStore` methods plus `.listRevisions`. `UsRuntime.transformation` owns one store instance. Body limit is 256 KiB only for `POST /traceability/transformation` and `PUT /traceability/transformation/:uuid`; other US commands retain 16 KiB. `POST /traceability/transformation/genealogy/query` is a read requiring `READ` despite POST transport and still requires mutation-Origin protection from US middleware.

- [ ] **Step 1: Write RED HTTP tests.** Use the real MFA/Host/Origin/no-store harness from `apps/api/test/us-case-http.e2e.test.ts`. Use HTTP create for the incomplete-draft path and `seedFinalizableTransformation(f)` for the complete reference/FTL-lot fixture before exercising save→readiness→finalize; the bare-shell `seedTransformationDraft` is not a valid saved command fixture. Test OpenAPI paths, create→GET→save→readiness→finalize, amend→revisions→void, genealogy current/pinned, exact replay, typed 409 issues, malformed UUID, wrong type/tenant 404, anonymous 401, role denial 403, wrong Host/Origin 403, 256 KiB draft boundary and 16 KiB lifecycle boundary. Parse every successful response with the Task 1 Zod schema. Test that a downstream-blocked response includes at most 100 safe blocker rows and `hasMore`, while the internal command still checks all consumers.

```ts
const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
expect(document.paths?.["/traceability/transformation"]?.post).toBeDefined();
expect(document.paths?.["/traceability/transformation/{id}/revisions"]?.get).toBeDefined();
expect(document.paths?.["/traceability/transformation/genealogy/query"]?.post).toBeDefined();
expect(document.paths?.["/boxes"]).toBeUndefined();
const denied = await request(`/traceability/transformation/${draft.id}`, "GET", undefined, {
  cookie: "",
});
expect(denied.status).toBe(401);
```

- [ ] **Step 2: Run RED.** `corepack pnpm --filter @markiro/api exec vitest run test/us-transformation-http.e2e.test.ts`; require the disposable DB and confirm missing route/contract failures.
- [ ] **Step 3: Implement only the US controller/runtime wiring.** Register `UsTransformationController` in `UsDevelopmentModule` and `UsTransformationStore` in `UsRuntime`. Use `@UseGuards(UsSessionGuard)`, `@ApiZodBody/Query/Response`, `this.runtime.databaseOperation`, server-generated request ID and the existing `principal()` pattern from `us-case.controller.ts`. Map `traceability_downstream_blocked` to a strict HTTP response with the first 100 typed blockers and `hasMore` from the full internal list; never truncate the command's all-consumer validation. Put the fixed genealogy path before `:id`, and add only the two draft-write regexes to `us-http.ts`'s 256 KiB selector. Do not alter the fallback parser or RU bootstrap.

```ts
@Post(":id/finalize")
@HttpCode(200)
@ApiZodBody(finalizeTransformationSchema)
@ApiZodResponse({ status: 200, schema: transformationFinalizedRecordSchema })
finalize(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
  const principal = this.principal(request);
  return this.runtime.databaseOperation(() => this.runtime.transformation.finalize(
    principal.tenantId, principal.userId, id, body, this.requestId(request),
  ));
}
```

- [ ] **Step 4: Run GREEN and review.** Focused HTTP tests, `test/us-receiving-http.e2e.test.ts`, `test/us-case-http.e2e.test.ts`, API `typecheck`, `lint`, `build`. Reviewer checks every verb/path, operation-key replay, 256 KiB selector, OpenAPI and non-mounted RU routes.

## Task 4: One global Events read model and HTTP route

**Files:** Create `apps/api/src/modules/traceability/events/us-events-registry.ts`, `us-events-store.ts`, `apps/api/src/deployment/us-events.controller.ts`, `apps/api/test/support/us-events-fixture.ts`, `apps/api/test/us-events-registry.e2e.test.ts`, `apps/api/test/us-events-http.e2e.test.ts`; modify `apps/api/src/deployment/us-runtime.ts`, `us-development.module.ts`.

**Interfaces:** `UsEventsStore.list(tenantId: string, actorUserId: string, query: unknown): Promise<UsEventList>`; the controller owns only `GET /traceability/events`. `seedMixedEvents(f)` creates a tenant with Receiving and Transformation originals, finalized/amended/void revisions, a second tenant and mutable locations; it returns `{tenant, actor, receivingIds, transformationIds, foreignEventId, expectedFirstFourIds}`. The registry parses `usEventListQuerySchema` after authorizing `READ` and returns `usEventListSchema`.

- [ ] **Step 1: Write RED mixed-list tests.** Seed alternating creation times across types. Query `limit=2` at offsets 0/2/4 and assert the concatenated IDs equal one `(created_at DESC,id DESC)` order. Assert `type` and `status` filters are applied before paging, `history=current` retains current+pending but excludes amended history, `history=all` returns all revisions, and a fully void root has one explicit terminal row. Search only event number, never TLC/document contents. Change a finalized location's live business name and assert `locationDisplay` remains the frozen name; change a draft location and assert its current display updates.

```ts
const first = await store.list(c.tenant, c.actor, { limit: 2, offset: 0 });
const second = await store.list(c.tenant, c.actor, { limit: 2, offset: 2 });
expect([...first.items, ...second.items].map((row) => row.id)).toEqual(c.expectedFirstFourIds);
expect(first.items.every((row) => row.type === "receiving" || row.type === "transformation")).toBe(
  true,
);
expect(
  (
    await store.list(c.tenant, c.actor, { type: "transformation", limit: 2, offset: 0 })
  ).items.every((row) => row.type === "transformation"),
).toBe(true);
```

- [ ] **Step 2: Run RED.** `corepack pnpm --filter @markiro/api exec vitest run test/us-events-registry.e2e.test.ts test/us-events-http.e2e.test.ts` with `US_TEST_DATABASE_URL`; expect missing store/route failures, not skips.
- [ ] **Step 3: Implement the registry in one snapshot.** Authorize READ and parse query; validate matching typed root chains before status/pagination (reuse Receiving chain assertion and add Transformation chain assertion). Query the common events shell with type-conditioned joins to Receiving/Transformation roots and type-specific count subqueries. Choose current/pending pointers or last void terminal revision per typed root, then apply status/search, global order and one SQL limit/offset. Extract frozen Receiving `locationDescription.businessName` and Transformation `processor.description` for finalized/retained frozen rows; use tenant-scoped live location only for drafts. Project bounded summaries, parse the contract and never return full snapshots. An inconsistent typed root is 503, not an omitted row.

The current-selection predicate must compare `e.id` with the current/pending pointer of the root matching `e.type`, or, when both pointers are null, select only the greatest-revision `void` event of that root. Apply `type`, `status`, and event-number search before `ORDER BY e.created_at DESC, e.id DESC` and one `LIMIT/OFFSET`. Validate all matching root chains before paging; a corrupt root must not disappear just because its row falls outside the requested page.

- [ ] **Step 4: Add the controller and HTTP denial tests.** Use the same US session guard/OpenAPI decorators as Task 3; no body. Assert 400 for invalid query, 401/403 for missing access, no-store header, and only own-tenant rows. A malformed/wrong-type typed root must not become a successful empty result.
- [ ] **Step 5: Run GREEN and review.** Focused registry/HTTP tests plus `test/us-receiving-registry.e2e.test.ts`, `test/us-receiving-shared-event-compatibility.e2e.test.ts`, API `typecheck`, `lint`, `build`. Reviewer checks whole-chain validation, one SQL page, frozen display provenance, no full JSON response, and tenant/type predicates.

## Task 5: US CI/isolation ownership and API handoff

**Files:** Modify `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, `docs/us/implementation-plan.md`, `docs/us/requirements-traceability.md`; keep browser/design-brief changes for the companion UI plan.

**Interfaces:** The isolated workflow owns `test/us-transformation-http.test.ts`, `test/us-events.test.ts`, `test/us-transformation-original-draft-void.e2e.test.ts`, `test/us-transformation-revisions.e2e.test.ts`, `test/us-transformation-http.e2e.test.ts`, `test/us-events-registry.e2e.test.ts`, `test/us-events-http.e2e.test.ts`. DB-backed API tests receive the existing `US_TEST_DATABASE_URL` service URL. Docs mark HTTP/registry implemented only after the checks actually pass; UI and seed remain pending.

- [ ] **Step 1: Write RED isolation assertions.** Extend the current workflow-parsing test with exact job-step file ownership and no `continue-on-error`, no release workflow, and explicit `UsTransformationController`/`UsEventsController` allowlist registration.

```js
for (const file of [
  "us-transformation-http.e2e.test.ts",
  "us-events-registry.e2e.test.ts",
  "us-events-http.e2e.test.ts",
]) {
  const owned = job.steps.some(
    (step) =>
      step.run?.includes(`test/${file}`) &&
      step.env?.US_TEST_DATABASE_URL ===
        "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev" &&
      step["continue-on-error"] === undefined,
  );
  assert.ok(owned, `Missing US API gate: ${file}`);
}
```

- [ ] **Step 2: Run RED.** `node --test tools/us-development/test/isolation.test.mjs`; expect missing new test ownership.
- [ ] **Step 3: Add workflow commands and status-only docs.** Put shared-contract tests in the existing contracts step and DB-backed API tests in the disposable-Postgres step; keep `permissions: contents: read` and release isolation untouched. Update requirements evidence links without claiming UI, seed, browser or deployment acceptance.
- [ ] **Step 4: Run GREEN and final API gates.** `node --test tools/us-development/test/isolation.test.mjs`, `node tools/us-development/check-isolation.mjs`, affected contracts/API package tests/typecheck/lint/build, existing Receiving and case HTTP regressions, `corepack pnpm format:check`, `git diff --check`. Record actual DB skips and external gates separately. Independent reviewer checks the complete API diff and all five Review Focus items before the UI plan begins.

## Execution boundary

Use one fresh implementer and one independent reviewer per task, sequentially, with an additional whole-increment review. Preserve the current isolated worktree and unrelated changes. This plan does not authorize a commit, push, PR, merge or deployment. After the API review, execute the companion UI plan only after the owner reviews that plan too.
