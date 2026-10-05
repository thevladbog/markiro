# US-09 Selection, Validation and Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use a separate implementer and an independent reviewer for each task, then a final whole-stage review.

**Goal:** Make a US-only trace request select a complete bounded chain, validate it from one database view and prepare an immutable, idempotent run revision without publishing artifacts.

**Architecture:** A transaction-aware US-07 reader remains the source-content authority. A new tenant-scoped selector finds seed lots/events and closes the Receiving → Transformation → Shipping genealogy, including linked historical revisions. Internal request services persist a mode-neutral validation digest, then reselect and freeze exact content in one repeatable-read Prepare transaction.

**Tech Stack:** TypeScript 6, NestJS exceptions, Drizzle/PostgreSQL, Zod 4, Vitest, Corepack pnpm; owned disposable US PostgreSQL for transaction tests.

**Spec:** [Owner-approved stage-2 design](../specs/2026-10-04-us-09-selection-freeze-design.md) and [parent US-09 design](../specs/2026-10-04-us-09-trace-request-current-design.md). Read the source files and tests named below before editing; plans do not override current code.

## Global Constraints

- Work only in the isolated `codex/us-mvp` checkout and preserve its existing dirty work. Do not touch RU routes, shared RU storage/jobs, Station, HTTP, worker, UI, deploy, real data or production configuration.
- Stage 1 request contracts/schema/migration must be independently reviewed and exercised against an owned disposable US PostgreSQL before accepting this stage. `US_TEST_DATABASE_URL` must identify that disposable database; a skipped DB suite is not a pass.
- Processor profile only. Require fresh tenant membership at each boundary. Request mutation requires `US_CAPABILITY.QA_MANAGE`; validation and Prepare additionally require `US_CAPABILITY.EXPORT_READ` because they read exact export sources. Call `authorizeUsMasterData` for both capabilities, because its array argument means **any**, not all.
- Distinct scope filters use AND; TLC/location values within a list use OR. Date/location/document predicates must match one event. Expand all linked upstream/downstream dependencies, including those outside the seed date range.
- Count all included event revisions after closure: maximum 500. Detect the 501st with a sentinel. Bound the canonical UTF-8 frozen snapshot at 16 MiB. No truncation, pagination-as-completeness, missing-source-as-empty or timeout-as-Incomplete.
- `Validate` and `Prepare` share a mode-neutral scoped-content digest. The generated-at instant, actor, mode, key and run identifiers are excluded; full US-07 `inputDigest` is separately named.
- `export_ready` uses current finalized records, no blocking findings and a verified effective Plan. `available_records_incomplete` keeps available excluded revisions and may explicitly have zero matches; neither mode converts corrupt records or infrastructure failure to success.
- The build identity is a required immutable injected `UsExportBuildIdentity`; no runtime Git/package fallback. This stage does not claim a production build-identity provider or artifact readiness.
- Focused failing test first, then implementation and package gates. No commit, push, PR, merge, release or deployment is authorized by this plan; review diffs without staging unrelated changes.

## Review Focus

1. A lot with two Transformation outputs and later Shipping must return the full connected event chain, with dependencies outside the seed date range labelled as such (Task 2).
2. Date, location and document values found on three _different_ events must not falsely satisfy one filter set (Task 2).
3. The 501st linked revision and a 16 MiB-plus snapshot must fail visibly, without an incomplete or truncated run (Tasks 2 and 5).
4. A source amendment or effective Plan change between Validate and Prepare must return stale-validation conflict, while same-key replay returns the original run after drift (Tasks 4 and 5).
5. Concurrent Prepare calls, a cross-tenant relation and a malformed stored snapshot must fail closed without duplicate revisions or a false zero-match response (Tasks 1, 2 and 5).

---

## File map and task sequence

| Unit              | Files                                                                                                                                                          | Responsibility                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Reader seam       | `apps/api/src/modules/traceability/export/source-reader.ts`, `apps/api/test/us-export-source-reader.e2e.test.ts`                                               | Read exact pins using an existing transaction while keeping the public reader's authorization and own transaction. |
| Selector          | New `apps/api/src/modules/traceability/requests/us-request-selector-query.ts`, `us-request-selection.ts`; new `apps/api/test/us-request-selection.e2e.test.ts` | Resolve filters, exhaust bidirectional closure, retain match/dependency reasons and detect cap/corruption.         |
| Request lifecycle | New `apps/api/src/modules/traceability/requests/us-request-store.ts`; new `apps/api/test/us-request-store.e2e.test.ts`                                         | Internal create/edit/close with deadline policy, expected revision, tenant auth and validation invalidation.       |
| Validation        | New `apps/api/src/modules/traceability/requests/us-request-snapshot.ts`, `us-request-validation.ts`; new `apps/api/test/us-request-validation.e2e.test.ts`     | Canonical envelope/digest, source/Plan/registry/build stamps, findings and warning acknowledgement.                |
| Freeze            | New `apps/api/src/modules/traceability/requests/us-request-prepare.ts`; new `apps/api/test/us-request-prepare.e2e.test.ts`                                     | Same-transaction reselect, stale check, mode gates, snapshot cap, idempotency and immutable run insertion.         |

The new request modules are internal exports only. Do not register controllers, providers, workers or routes in `UsDevelopmentModule` for this plan. Reuse `createUsProfileTestDatabase`, `seedCompleteReceiving`, Transformation/Shipping fixtures and existing Plan test support; extend fixtures only in the task that needs them.

### Task 1: Transaction-aware exact source reader

**Files:** Modify `apps/api/src/modules/traceability/export/source-reader.ts`; modify `apps/api/test/us-export-source-reader.e2e.test.ts`.

**Interfaces:** Produce `readUsExportSourcesInTransaction(tx: UsMasterDataTransaction, tenantId: string, actorUserId: string, pins: readonly EventPin[], mode: ExportMode): Promise<readonly ExportSourceRecord[]>`. Keep the existing `readUsExportSources(db, ...)` signature and error behavior. The internal function authorizes `EXPORT_READ` and processor profile inside the caller's transaction; Prepare separately checks `QA_MANAGE`.

- [ ] **Step 1: RED test.** Add an e2e case to the existing source-reader suite using `createUsProfileTestDatabase`: within `transformationTransaction(f.db, async tx => ...)`, call `readUsExportSourcesInTransaction(tx, tenant, actor, [{eventId, revision: 1}], "export_ready_candidate")`, amend the source concurrently after the first read, and assert both reads inside `tx` resolve the same original current identity/content. Also assert wrong tenant is `404`, malformed/duplicate pins are `400`, historical pin in candidate mode is `409`, and a corrupt stored snapshot is `503`. Start with this assertion inside the existing `receiving()` fixture test:

```ts
const pins = [{ eventId: c.original.id, revision: 1 }];
const observed = await transformationTransaction(f.db, async (tx) => {
  const first = await readUsExportSourcesInTransaction(tx, c.tenant, c.actor, pins, candidate);
  const amendmentId = await createStoredAmendment(f, c.tenant, c.original.id);
  await finalizeStoredAmendment(f, c.tenant, amendmentId);
  const second = await readUsExportSourcesInTransaction(tx, c.tenant, c.actor, pins, candidate);
  return { first, second };
});
expect(observed.second).toEqual(observed.first);
```

- [ ] **Step 2: Verify RED.** Run `corepack pnpm --filter @markiro/api exec vitest run test/us-export-source-reader.e2e.test.ts` with the isolated `US_TEST_DATABASE_URL`; the new imported function must be absent before implementation. Abort acceptance if the DB cases are skipped.
- [ ] **Step 3: Minimal implementation.** Move the existing pin/mode parsing and `authorizeUsMasterData(..., US_CAPABILITY.EXPORT_READ)` into the exported in-transaction function, then make the public wrapper call it inside its existing `transformationTransaction`. Keep `resolvePinnedEvents` private and unchanged except for a regression-required correction. The wrapper shape is:

```ts
export async function readUsExportSourcesInTransaction(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  pins: readonly EventPin[],
  mode: ExportMode,
): Promise<readonly ExportSourceRecord[]> {
  const selected = pinsSchema.safeParse(pins);
  const parsedMode = usExportInputV1Schema.shape.mode.safeParse(mode);
  if (!selected.success || !parsedMode.success)
    throw new BadRequestException({ code: "invalid_us_export_sources" });
  const profile = await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.EXPORT_READ);
  if (profile !== "US_FSMA204_PROCESSOR")
    throw new ForbiddenException({ code: "traceability_profile_required" });
  const ordered = selected.data.sort(
    (a, b) => a.eventId.localeCompare(b.eventId) || a.revision - b.revision,
  );
  return resolvePinnedEvents(tx, tenantId, ordered, parsedMode.data);
}
```

- [ ] **Step 4: GREEN and independent review.** Run the focused DB suite and API typecheck/lint/build. Reviewer checks that no second transaction is opened by the new function, public reader tests still pass, and unauthorized callers cannot use the internal path as an HTTP boundary.

### Task 2: Complete tenant-scoped selector and genealogy closure

**Files:** Create `apps/api/src/modules/traceability/requests/us-request-selector-query.ts`, `us-request-selection.ts`, `apps/api/test/us-request-selection.e2e.test.ts`.

**Interfaces:** Produce `selectUsRequestScope(tx: UsMasterDataTransaction, tenantId: string, scope: UsTraceRequestScopeV1): Promise<UsRequestSelection>`. Define and export `UsRequestSelection` in `us-request-selection.ts` as `{ scope; seeds: readonly {kind: "lot" | "event"; id: string}[]; records: readonly {eventId: string; revision: number; reason: "match" | "dependency"; rootEventId: string}[]; lotIds: readonly string[]; relations: readonly {eventId: string; lotId: string; lineNo: number; role: "receiving" | "input" | "output" | "shipping"}[] }`. All arrays have deterministic ordering.

- [ ] **Step 1: RED tests.** Add database fixtures with two TLCs feeding one Transformation with two outputs and later Shipping. Assert a TLC seed returns both upstream Receiving, the Transformation, both output lots and Shipping, while an out-of-range event is marked `dependency`. Add a filter case in which date, location and document appear only on different events and assert zero seeds. Assert location list OR, TLC list OR, distinct filters AND, exact zero-match, a mixed-tenant relation error, a corrupt root-chain error and 501 linked revisions raising `us_request_selection_limit` without returning 500. The central assertion uses the Task 2 interface:

```ts
const selected = await transformationTransaction(f.db, (tx) =>
  selectUsRequestScope(tx, tenant, { tlc: inputTlc }),
);
expect(selected.records.map((row) => row.eventId)).toContain(shippingEventId);
expect(selected.records).toContainEqual(
  expect.objectContaining({
    eventId: outOfRangeEventId,
    reason: "dependency",
  }),
);
expect(selected.lotIds).toEqual(expect.arrayContaining([outputLotA, outputLotB]));
```

- [ ] **Step 2: Verify RED.** Run `corepack pnpm --filter @markiro/api exec vitest run test/us-request-selection.e2e.test.ts` against owned disposable PostgreSQL; expect the missing selector module.
- [ ] **Step 3: Implement seed queries.** In `us-request-selector-query.ts`, construct Drizzle `sql` predicates using `scope` only after strict schema parse. Reuse the safe document/location extraction and `escapeLikePattern` approach in `trace/us-trace-search.ts`, but do not call its paged projection. Use a **single** tenant-scoped `EXISTS` over one event for all supplied event-level filters, and C-collation for TLC range. Apply every predicate before `LIMIT 501`. Return seed IDs plus their exact direct-match reason; if a `lotId` does not belong to the tenant, it yields no seed, not another tenant's data.

```ts
const eventEvidence = sql`EXISTS (
  SELECT 1 FROM traceability_events e
  JOIN receiving_event_items i ON i.tenant_id=e.tenant_id AND i.event_id=e.id
  WHERE e.tenant_id=${tenantId} AND i.lot_id=l.id
    AND (${datePredicate}) AND (${locationPredicate}) AND (${documentPredicate})
)`;
// The implemented relation union also covers Transformation inputs/outputs and Shipping;
// datePredicate, locationPredicate and documentPredicate are built from the
// validated scope using the frozen-event logic in trace/us-trace-search.ts.
// All three remain attached to the same e alias.
```

- [ ] **Step 4: Implement closure.** In `us-request-selection.ts`, maintain visited lot IDs and event IDs, traverse the four tenant-scoped line tables (`receiving_event_items`, `transformation_event_inputs`, `transformation_event_outputs`, `shipping_event_items`) until no new lot/event appears, and expand every touched root to its linked event revisions. Reuse `assertTraceRelations` and root-chain readers; do not treat the current-only `traceCandidateQuery` as history. Apply a fixed transaction-local `30s` statement deadline before selector reads; SQL timeout is a technical `503`. Query `remaining + 1` (maximum 501) at each bounded step, count **distinct revisions**, and throw `ConflictException({code: "us_request_selection_limit"})` before returning on overflow. Sort pins by event ID/revision, line relations by event ID/role/line number, lot IDs by UUID bytes; keep `match` ahead of `dependency` for a record that is both. Reject broken foreign-tenant or missing edges as `ServiceUnavailableException`, not empty selection.

```ts
const recordKey = (eventId: string, revision: number) => `${eventId}:${revision}`;
if (recordsByKey.size > 500) throw new ConflictException({ code: "us_request_selection_limit" });
```

- [ ] **Step 5: GREEN and independent review.** Run focused selector, trace and source-reader e2e tests plus API typecheck/lint/build. Reviewer traces a 2→2 fixture by hand, verifies same-event SQL and all tenant predicates, and confirms the 501st revision is detected rather than clipped. Do not accept skipped PostgreSQL cases.

### Task 3: Internal request lifecycle and optimistic revision

**Files:** Create `apps/api/src/modules/traceability/requests/us-request-store.ts`, `apps/api/test/us-request-store.e2e.test.ts`.

**Interfaces:** Produce `UsRequestStore` with `create(tenantId, actorUserId, body: UsTraceRequestCreateBody)`, `update(tenantId, actorUserId, requestId, body: UsTraceRequestUpdateBody)` and `close(tenantId, actorUserId, requestId, body: UsTraceRequestCloseBody)`. All return a validated server-owned request row; none accepts tenant/actor from the body. The constructor takes `Db`.

- [ ] **Step 1: RED tests.** Test a shell with null scope; default `receivedAt + 86_400_000` across DST; alternative deadline requiring reason; duplicate tenant request number; cross-tenant ID as `404` when the actor is authorized in the queried tenant; stale expected revision as `409`; update of scope/requester/deadline clearing validation/ack quartet; close retaining prior seeded runs and marking the request closed. Task 5 tests that Prepare rejects a new key after closure. Assert exact tenant, actor, action, target and result in `tenantAuditEvents`, with requester contact absent from audit metadata. Start the store suite with:

```ts
const created = await store.create(tenant, actor, {
  requestNumber: "REQ-001",
  requesterName: "Synthetic requester",
  requesterOrganization: null,
  requesterContact: null,
  receivedAt: "2026-03-08T01:30:00-06:00",
  scope: null,
});
expect(created.dueAt.getTime() - created.receivedAt.getTime()).toBe(86_400_000);
await expect(
  store.close(otherTenant, otherActor, created.id, { expectedRevision: 1 }),
).rejects.toMatchObject({ status: 404 });
```

- [ ] **Step 2: Verify RED.** Run `corepack pnpm --filter @markiro/api exec vitest run test/us-request-store.e2e.test.ts` on the isolated database; expect the store export missing.
- [ ] **Step 3: Implement store.** Parse the existing strict contracts, call `resolveUsRequestDeadline`, use `transformationTransaction` and `authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.QA_MANAGE)`, and require processor profile. PATCH retains deadline policy: an omitted `dueAt` recomputes the default after a receipt change if the prior deadline was default; it retains and revalidates the prior due instant/reason if alternative. An explicit `dueAt` resolves against the merged receipt. For update/close select the tenant-scoped request `FOR UPDATE`, compare `expectedRevision`, increment the semantic revision only on actual edits/closure, clear `lastValidation`, digest/time and warning-ack fields in the same update for every digest-bearing edit. A no-op edit retains revision/validation. Map only the known tenant request-number unique violation to `409`; propagate infrastructure errors. Write the exact same-transaction success audit row, following `plans/us-plan-store.ts` for rejection audit after rollback.

```ts
if (!row) throw new NotFoundException({ code: "us_request_not_found" });
if (row.revision !== body.expectedRevision)
  throw new ConflictException({ code: "us_request_revision_conflict" });
```

- [ ] **Step 4: GREEN and independent review.** Run focused store test, request-domain/contract tests, API typecheck/lint/build. Reviewer checks stale-write rollback, no log/audit contact leakage and no endpoint registration.

### Task 4: Mode-neutral validation, digest and acknowledgement

**Files:** Create `apps/api/src/modules/traceability/requests/us-request-snapshot.ts`, `us-request-validation.ts`, `apps/api/test/us-request-validation.e2e.test.ts`.

**Interfaces:** Define `type UsRequestRow = typeof schema.traceRequests.$inferSelect`. Produce `captureUsRequestScope(tx: UsMasterDataTransaction, tenantId: string, actorUserId: string, requestRow: UsRequestRow, build: UsExportBuildIdentity): Promise<{ snapshot: UsRequestSnapshot; digest: string; byteSize: number }>` in `us-request-snapshot.ts`. `UsRequestSnapshot` has `selection: UsRequestSelection`, `sources: readonly ExportSourceRecord[]`, `findings: readonly ExportFinding[]`, request metadata, lot/product/source/coverage values, `plan: {id: string; pdfSha256: string} | null`, profile timezone/baseline, registry ID/version/hash and build. Also define `stableStringify(value: unknown): string` there. Produce `UsRequestValidationStore.validate(tenantId, actorUserId, requestId, build)` and `.acknowledgeWarnings(tenantId, actorUserId, requestId, digest, reason)`; both use the same transaction helper and return server-owned summaries.

- [ ] **Step 1: RED tests.** Validate a no-match scope and missing effective Plan as explicit findings; repeat with reordered seed rows and assert identical digest; change source snapshot, lot TLC/product/source/coverage, genealogy edge, requester contact, Plan ID/hash, registry/build stamp and assert changed digest for each. Test a corrupt Plan through `parseUsPlanPublishedRow` as `503`, a serialization rollback preserving previous validation, warning acknowledgement bound to exact digest, acknowledgement not incrementing semantic revision, and a later source change invalidating acknowledgement at Prepare. Use an immutable test build identity:

```ts
const build = { apiVersion: "test-us09", gitSha: "a".repeat(40), dirty: false } as const;
const first = await validation.validate(tenant, actor, requestId, build);
expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
const second = await validation.validate(tenant, actor, requestId, build);
expect(second.digest).toBe(first.digest);
```

- [ ] **Step 2: Verify RED.** Run `corepack pnpm --filter @markiro/api exec vitest run test/us-request-validation.e2e.test.ts` on disposable PostgreSQL; expect the new module missing.
- [ ] **Step 3: Implement canonical capture.** Use `selectUsRequestScope` and `readUsExportSourcesInTransaction(..., "available_records_incomplete")` inside the caller's `tx`; for zero pins do not call the reader. Resolve current effective Plan row tenant-scoped and parse with `parseUsPlanPublishedRow`, pin its exact ID/PDF hash, or add `plan_absent` finding. Inject and validate `build` with `usExportBuildIdentitySchema`; use `traceExportRegistryHash()` and the processor's stored baseline/timezone, not runtime Git. Sort unordered selection arrays, then recursively sort plain-object keys while preserving saved snapshot array order. If the first serialized full snapshot exceeds 16 MiB, deterministically add a blocking `snapshot_limit` finding, then recalculate the final bytes and digest; both Validate and Prepare must call this same capture. Digest with `canonicalExportDigest(normalizedSnapshot)` and measure `Buffer.byteLength(stableJson, "utf8")`. Keep actor, mode, idempotency key, run fields, generated-at and ack out of `normalizedSnapshot`.

```ts
function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError("non_json_snapshot");
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}
const digest = canonicalExportDigest(normalizedSnapshot);
const byteSize = Buffer.byteLength(stableStringify(normalizedSnapshot), "utf8");
return { snapshot: normalizedSnapshot, digest, byteSize };
```

- [ ] **Step 4: Implement validation/ack persistence.** Reload `QA_MANAGE` and `EXPORT_READ` separately, plus processor profile, inside `transformationTransaction`; lock the open request row and require non-null strict scope. Capture in that same transaction; persist summary/digest/time only against the read revision. Acknowledge a warning with reason and current digest under row lock, write `warningAck*` fields without incrementing semantic revision, and reject a nonmatching digest or an error-only validation. Audit exact accepted/rejected context, with no requester contact. Preserve previous validation on technical failure.

```ts
if (request.status !== "open" || request.scope === null)
  throw new ConflictException({ code: "us_request_scope_required" });
const captured = await captureUsRequestScope(tx, tenantId, actorUserId, request, build);
await tx
  .update(schema.traceRequests)
  .set({
    lastValidation: {
      matchedRevisionCount: captured.snapshot.selection.records.length,
      findings: captured.snapshot.findings,
    },
    lastValidationDigest: captured.digest,
    lastValidatedAt: new Date(),
    warningAckDigest: null,
    warningAckReason: null,
    warningAckAt: null,
    warningAckBy: null,
  })
  .where(and(eq(schema.traceRequests.tenantId, tenantId), eq(schema.traceRequests.id, request.id)));
```

- [ ] **Step 5: GREEN and independent review.** Run focused validation, source-reader and Plan e2e tests plus API typecheck/lint/build. Reviewer compares every digest-bearing field in the spec to the captured envelope and checks canonical bytes, Plan corruption and warning invalidation.

### Task 5: Atomic immutable Prepare and idempotent replay

**Files:** Create `apps/api/src/modules/traceability/requests/us-request-prepare.ts`, `apps/api/test/us-request-prepare.e2e.test.ts`; modify `us-request-snapshot.ts` only for independently reviewed defects exposed by this task.

**Interfaces:** Produce `UsRequestPrepareStore.prepare(tenantId: string, actorUserId: string, requestId: string, body: UsTraceRequestPrepareBody, build: UsExportBuildIdentity): Promise<typeof schema.traceExportRuns.$inferSelect>` plus its private `prepareWithinTransaction(tx: UsMasterDataTransaction, tenantId: string, actorUserId: string, requestId: string, body: UsTraceRequestPrepareBody, build: UsExportBuildIdentity)`. It uses `captureUsRequestScope` from Task 4 and the existing strict `usExportInputV1Schema`; it does not render XLSX or write artifacts.

- [ ] **Step 1: RED tests.** Assert Validate → Prepare freezes exact source content, findings and Plan pin; a later amendment/void/Plan supersession leaves run revision 1 unchanged; fresh key after drift yields `us_request_validation_stale` with no run; same key after drift or closure returns original run; same key with another mode/request conflicts; two different concurrent keys allocate revisions 1 and 2; same-key race creates one run. Test incomplete zero-match with `selectionKind: "empty"`/null input digest, ready mode with a healthy amended root using only its current revision, ready rejection without Plan or with a required noncurrent dependency, 16 MiB + 1 byte failure and rollback, reader/Plan/timeout errors not creating an Incomplete run, current membership revocation, cross-tenant `404` and exact audit fields. The replay assertion is:

```ts
const body = { mode: "available_records_incomplete", idempotencyKey: randomUUID() } as const;
const run1 = await prepare.prepare(tenant, actor, requestId, body, build);
const amendmentId = await createStoredAmendment(f, tenant, sourceEventId);
await finalizeStoredAmendment(f, tenant, amendmentId);
const replay = await prepare.prepare(tenant, actor, requestId, body, build);
expect(replay.id).toBe(run1.id);
expect(replay.inputSnapshot).toEqual(run1.inputSnapshot);
```

- [ ] **Step 2: Verify RED.** Run `corepack pnpm --filter @markiro/api exec vitest run test/us-request-prepare.e2e.test.ts` with owned PostgreSQL; expect missing Prepare module, not skipped tests.
- [ ] **Step 3: Implement transaction sequence.** Parse body, use `transformationTransaction`, check `QA_MANAGE` and `EXPORT_READ` separately, require processor profile, lock `(tenant, requestId)` row, then query `(tenant, actor, idempotencyKey)` **before** checking open/validated state. Compute `commandDigest = canonicalExportDigest({schemaVersion: 1, requestId, mode})`; same digest returns the stored run, mismatch yields `us_request_idempotency_conflict`. For a new key require open/validated, call `captureUsRequestScope` in the same `tx`, compare digest, enforce 500 and `byteSize <= 16 * 1024 * 1024`, then mode gates. Map ready mode to US-07 `export_ready_candidate` and incomplete to `available_records_incomplete`. For ready mode derive the connected current-finalized path from semantic seeds, retaining historical revisions only in the validation envelope; excluded revisions cannot bridge this path, and their model-only representability finding is recomputed on the current input. A healthy amended root or extra linked draft is not rejected merely for having history. Reject a corrupt current provenance cycle technically in either mode. Build/parse `ExportInputV1` only when selected events are nonempty. Typed workbook-model failure blocks ready; incomplete retains exact input and the explicit unavailable-workbook finding for later artifact handling. Pin `generatedAt` once and compute `inputDigest = canonicalExportDigest(parsedInput)`. Insert run `status: "queued"`, `exportReady: false`, revision `MAX(revision)+1` for the locked request; write same-transaction success audit. The DB unique constraints remain the concurrency arbiter; transaction retry restarts authorization and selection.

```ts
if (stored) {
  if (stored.commandDigest !== commandDigest)
    throw new ConflictException({ code: "us_request_idempotency_conflict" });
  // Verify the saved envelope, identity bindings and both frozen digests;
  // emit a distinct replay audit before returning the original row.
  return validateAndAuditStoredReplay(tx, stored);
}
if (captured.digest !== request.lastValidationDigest)
  throw new ConflictException({ code: "us_request_validation_stale" });
if (captured.byteSize > 16 * 1024 * 1024)
  throw new ConflictException({ code: "us_request_snapshot_limit" });
```

Replay must validate only frozen evidence, never recapture live sources. Test corrupted persisted envelope, input/scoped digests and identity bindings as technical failures. Preserve one creation audit and add an exact replay audit carrying original run ID/revision/mode/digests after drift, closure and a same-key race; requester contact and warning free text stay absent. Legitimate worker lifecycle changes do not alter the frozen evidence identity.

- [ ] **Step 4: Handle rejection audit and race outcomes.** Follow `plans/us-plan-store.ts`: after rollback, record a bounded rejection audit with exact tenant/actor/request/mode/code/digest if the request belongs to that tenant; never copy requester contact. Recognize only `trace_export_runs_idempotency_uq` and `trace_export_runs_revision_uq` as retryable uniqueness conflicts, and restart the whole repeatable-read transaction. Do not catch source corruption, network or storage failures as Incomplete. Do not create or publish any artifact row.

```ts
if (
  isUniqueConstraintViolation(error, "trace_export_runs_idempotency_uq") ||
  isUniqueConstraintViolation(error, "trace_export_runs_revision_uq")
) {
  return transformationTransaction(this.db, (tx) =>
    this.prepareWithinTransaction(tx, tenantId, actorUserId, requestId, body, build),
  );
}
throw error;
```

- [ ] **Step 5: GREEN, whole-stage gate and independent review.** Run focused Prepare/concurrency suite, all US request/domain/contract/DB/API affected tests, API/DB package test/typecheck/lint/build, `corepack pnpm format:check` and `git diff --check`. Record `US_TEST_DATABASE_URL` target as disposable without printing credentials; reject any DB skip. Reviewer inspects the full three-dot diff against intended branch base and specifically checks transaction boundaries, replay after drift, no false ready status, immutable stored bytes and exact audit metadata. Browser, hosted US storage, backup/restore, production build provenance, human throughput and regulatory acceptance remain unverified and outside this stage.

## Local implementation checkpoint — 2026-10-04

Tasks 1–5 are implemented and independently task-reviewed. Whole-stage source integration review approved the additive foundation, shared transaction composition, complete selection, lifecycle/validation invalidation, immutable Prepare and frozen-only replay verification with no remaining Critical, Important or Minor findings. The legacy US-08 migration fixture is pinned to its historical end (0138); separate US-09 fresh and upgrade tests cover additive migration 0139. These are uncommitted working-tree changes on `codex/us-mvp`, not a scoped PR or a published result.

Recorded automated evidence:

- Final focused database suites: source reader **18/18**, selection **14/14**, lifecycle **18/18**, validation **15/15** and Prepare **24/24**, all without skips; controller independently repeated each final task suite. Transactions use owned disposable child databases of the loopback synthetic US PostgreSQL, not shared or RU data.
- The affected API regression passed **197/197** before the last saved-envelope normalization guard. That API-only follow-up passed the final **24/24** Prepare suite and API typecheck, lint and build; the earlier aggregate is not represented as a rerun of final source.
- Full domain **1359/1359** and contracts **992/992** passed without skips. Full DB passed **775**, with **141 unrelated conditional skips**; the explicit affected schema/migration run passed **105/105**, without skips. Shared-package typecheck, lint and builds passed.
- Final controller execution of the new serial CI request command passed **71/71** on final source; focused deadline **30/30**, strict contracts **38/38** and request schema/migration **5/5** also passed without skips.
- Check-only US CI now explicitly owns all eight new US-09 suites after dependency builds, with synthetic US database boundaries and serial DB/API execution. Its isolation regression was observed failing before the workflow amendment, then passed **18/18**; full isolation tests passed **37/37**. Independent final integration re-review approved this closure without findings. Repository formatting and `git diff --check` passed; hosted execution is not claimed.

The broad API package gate is **not green**: the recorded full run has eight unrelated RU/auth setup-failed files and 1411 conditional skips because that environment was deliberately not supplied. It is not evidence against the focused US transaction results, nor a claim of full repository health. No browser/HTTP journey, worker/package artifacts, hosted storage/PDF object read, backup/restore, production build provenance, human throughput or regulatory acceptance was exercised in this stage. HTTP, worker, package publication and cabinet integration remain separate increments. No commit, push, PR, merge, release or deployment occurred.
