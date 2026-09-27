# US-04 server case/SSCC bridge implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the isolated U.S. instance an auditable, tenant-safe server link between finalized Transformation output lots and existing SSCC boxes, with exact lookup and unlink.

**Architecture:** Add three US-owned relations beside, not inside, shared `boxes`; expose a strict contract and transactional internal store, then mount only a US controller. Link history and synthetic provenance are separate. A controlled US-11 seed and the Transformation/unified Events UI follow in separate increments.

**Tech Stack:** TypeScript, Zod, NestJS, Drizzle/PostgreSQL, Vitest, pnpm/Corepack.

**Spec:** [2026-09-26-us-04-server-case-bridge-design.md](../specs/2026-09-26-us-04-server-case-bridge-design.md). Read it and `AGENTS.md` plus `apps/api/AGENTS.md` before execution. The parent [current Transformation design](../specs/2026-09-26-us-04-transformation-current-design.md) governs lifecycle semantics.

## Global Constraints

- US-only, opt-in module and database; no RU router, shared `boxes` column, Station, scanner, print or release change.
- One link batch has 1–100 **distinct normalized** SSCCs; the active case count is independent of the frozen Transformation quantity.
- New links require a current finalized Transformation output origin; after void, retain old links with an origin gap, reject new links, and allow reasoned unlink.
- Eligible means a valid non-null SSCC and `disassembled_at IS NULL`; `closed_at` and a physical shift state are not eligibility requirements.
- A case has at most one active lot link per tenant; all case/lot FKs and reads are tenant-composite. Never disclose a foreign target.
- Only trusted seed/fixture code sets synthetic provenance. No public route creates a box, source `demo_seed`, closure, shift, scan or print evidence.
- `traceability.read` is required for reads; `traceability.transformation.write` for writes. Reload membership even for an idempotent replay.
- Use `US_TEST_DATABASE_URL` disposable child databases for DB tests; never mutate shared development or production data. Build `@markiro/db` after schema edits and before consumer tests.
- Do not commit, push, open a PR, merge or deploy under this plan without separate authorization. Preserve the dirty US worktree and stage no unrelated files.

## Review Focus

1. Two differently wrapped strings for the same SSCC in one batch must be rejected as a duplicate after normalization (Task 1 contract test).
2. A link racing a Transformation void must not create an apparently current link against a vanished origin (Task 2 concurrency test).
3. An exact retry after the user's role was revoked must be denied before returning the stored receipt (Task 2 authorization test).
4. An old unlink request arriving after unlink/relink must not remove the new link (Task 2 stale-link test).
5. A box SSCC edited after linking must appear as inconsistent, not silently map its frozen historical SSCC to the new value (Task 3 read test).

---

## File and interface map

- `packages/platform-contracts/src/traceability/case-bridge.ts`: strict link, unlink, list and lookup schemas; normalize SSCC only through `@markiro/domain` `parseScannedSscc`.
- `packages/db/src/schema/traceability-case-bridge.ts` plus additive migration: link history, synthetic marker, operation receipts and DB invariants; export through `packages/db/src/schema.ts`, include in `packages/db/drizzle.config.ts`.
- `apps/api/src/modules/traceability/cases/us-case-operations.ts`: digest, operation-key arbitration, repeatable-read retry. `us-case-commands.ts`: atomic link/unlink and audit. `us-case-reads.ts`: bounded list/lookup and provenance consistency. `us-case-store.ts`: narrow facade for the US runtime.
- `apps/api/src/deployment/us-case.controller.ts`: four session-protected routes. `us-runtime.ts` owns the store; `us-development.module.ts` explicitly allowlists the controller.
- `apps/api/test/support/us-case-bridge-fixture.ts`: disposable DB and 100-box synthetic test fixture, not a production/demo seed script.

The following TypeScript interface is the handoff between Tasks 1–3; keep names and field meanings stable unless the reviewer finds a concrete contradiction:

```ts
type CaseOriginState = "current" | "gap";
type CaseProvenance = "synthetic_demo" | "existing_record";
type CaseLinkSource = "manual" | "demo_seed";
type CaseRow = {
  linkId: string;
  boxId: string;
  lotId: string;
  ssccAtLink: string;
  linkSource: CaseLinkSource;
  provenance: CaseProvenance;
  linkedAt: string;
  linkedBy: string;
  unlinkedAt: string | null;
  unlinkedBy: string | null;
  unlinkReason: string | null;
  originState: CaseOriginState;
  ssccState: "consistent" | "inconsistent";
};
type LinkCasesResult = { lotId: string; created: CaseRow[]; unchanged: CaseRow[] };
type UnlinkCaseResult = {
  linkId: string;
  lotId: string;
  unlinkedAt: string;
  unlinkedBy: string;
  reason: string;
};
type CaseListResult = {
  lotId: string;
  originState: CaseOriginState;
  activeCount: number;
  rows: CaseRow[];
  nextCursor: string | null;
};
type CaseLookupResult = {
  boxId: string;
  sscc: string;
  provenance: CaseProvenance;
  activeLink: CaseRow | null;
};
```

Cursor contract: `limit` is 1–100, default 50; `history` defaults false. Sort by `(linked_at,id)` ascending; `cursor` is an opaque base64url JSON pair `[linkedAtISO, linkId]`, max 200 characters, rejected if malformed. Count only active rows irrespective of `history`; pagination must not load all tenant history. The cursor is not a consistency snapshot across separate HTTP calls, so document concurrent inserts as live pagination.

## Task 1: Strict contract and additive storage

**Files:** Create `packages/platform-contracts/src/traceability/case-bridge.ts`, `packages/platform-contracts/test/us-case-bridge.test.ts`, `packages/db/src/schema/traceability-case-bridge.ts`, `packages/db/test/us-case-bridge-schema.test.ts`, `packages/db/test/us-case-bridge-migration.e2e.test.ts`, `packages/db/migrations/0133_us_case_bridge.sql` and `packages/db/migrations/meta/0133_snapshot.json`; modify `packages/platform-contracts/src/index.ts`, `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`, `packages/db/migrations/meta/_journal.json`. If the migration journal advances before execution, use the then-next free number instead of colliding. Extend disposable fixture setup only, never the shared DB.

**Interfaces:** Export `caseLinkCommandSchema`, `caseUnlinkCommandSchema`, `caseListQuerySchema`, `caseLookupQuerySchema`, `caseLinkResultSchema`, `caseUnlinkResultSchema`, `caseListResultSchema` and `caseLookupResultSchema`, with response shapes matching the map above. Export DB tables `traceLotBoxes`, `traceabilitySyntheticCaseOrigins`, `traceLotBoxOperations`. Canonical link input is `{ operationKey: UUID, ssccs: string[] }` with bare normalized SSCCs; unlink input is `{ operationKey: UUID, reason: trimmed 3–2000 chars }`. `operationKey` remains a UUID in the HTTP contract. Operation digest uses canonical command, lot/link target and normalized SSCC set or reason, not wrapper spelling or request ID.

- [ ] **Step 1: Write failing contract tests.** The core assertion must distinguish normalized duplicate and bad checksum; use `buildSscc` for valid fixture data.

```ts
const code = buildSscc(0, "1234567", 7);
expect(
  caseLinkCommandSchema.safeParse({ operationKey: randomUUID(), ssccs: [code, `(00)${code}`] })
    .success,
).toBe(false);
expect(
  caseLinkCommandSchema.parse({ operationKey: randomUUID(), ssccs: [`]C1(00)${code}`] }).ssccs,
).toEqual([code]);
const wrongDigit = code.at(-1) === "0" ? "1" : "0";
expect(
  caseLinkCommandSchema.safeParse({
    operationKey: randomUUID(),
    ssccs: [`${code.slice(0, -1)}${wrongDigit}`],
  }).success,
).toBe(false);
expect(
  caseLinkCommandSchema.safeParse({ operationKey: randomUUID(), ssccs: Array(101).fill(code) })
    .success,
).toBe(false);
```

- [ ] **Step 2: Run RED.** `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/us-case-bridge.test.ts`; expect missing exports, not a fixture infrastructure failure.
- [ ] **Step 3: Implement strict Zod schemas.** Use `parseScannedSscc`; reject unknown keys and duplicate canonical values. Normalize before computing any command digest. Export response schemas and type aliases; test query cursor/limit and reason bounds.

```ts
const ssccSchema = z.string().transform((raw, ctx) => {
  const value = parseScannedSscc(raw);
  if (value === null) {
    ctx.addIssue({ code: "custom", message: "invalid_sscc" });
    return z.NEVER;
  }
  return value;
});
export const caseLinkCommandSchema = z
  .object({
    operationKey: z.string().uuid(),
    ssccs: z.array(ssccSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.ssccs).size !== value.ssccs.length)
      ctx.addIssue({ code: "custom", path: ["ssccs"], message: "duplicate_sscc" });
  });
```

- [ ] **Step 4: Write failing DB tests.** Fresh and upgrade fixture migrations must reject a cross-tenant `(tenant,box)` or `(tenant,lot)` FK, a second active link to the same box, invalid `sscc_at_link`, a rewritten link identity, and a second unlink rewrite. They must accept a new history row after unlink and a marker that survives unlink. Verify a no-box pre-existing database migrates without backfilling fabricated cases.
- [ ] **Step 5: Run RED.** `corepack pnpm --filter @markiro/db exec vitest run test/us-case-bridge-schema.test.ts test/us-case-bridge-migration.e2e.test.ts` with disposable `US_TEST_DATABASE_URL`; expect missing relation/schema, not a silent DB skip.
- [ ] **Step 6: Add the schema and migration.** Use next free number after inspecting `_journal.json`; Drizzle generation may create the skeleton, but review/edit the SQL for partial unique index, tenant-composite FKs, checks, and guards. The three relations must have these essentials:

```sql
CREATE UNIQUE INDEX trace_lot_boxes_one_active_box_uq
  ON trace_lot_boxes (tenant_id, box_id) WHERE unlinked_at IS NULL;
CREATE INDEX trace_lot_boxes_lot_active_idx
  ON trace_lot_boxes (tenant_id, lot_id, linked_at, id) WHERE unlinked_at IS NULL;
ALTER TABLE trace_lot_boxes ADD CONSTRAINT trace_lot_boxes_unlink_all_or_none
  CHECK ((unlinked_at IS NULL AND unlinked_by IS NULL AND unlink_reason IS NULL)
      OR (unlinked_at IS NOT NULL AND unlinked_by IS NOT NULL AND length(btrim(unlink_reason)) BETWEEN 3 AND 2000));
```

Add composite FKs to `boxes(tenant_id,id)` and `traceability_lots(tenant_id,id)`, check bare 18 digits plus GS1 check digit in the service, and a migration-level trigger (or equivalent DB guard) forbidding DELETE and all UPDATE changes except a one-time setting of the three unlink fields. Also guard synthetic markers and operation receipts against update/delete. `trace_lot_box_operations` has PK `(tenant_id,command,operation_key)`, command check `case.link | case.unlink`, 64-char hex digest, target ID and JSONB result. Never edit applied migration 0132 or shared `boxes`.

- [ ] **Step 7: Run GREEN and package gates.** Run test, typecheck, lint and build separately for `@markiro/platform-contracts` and `@markiro/db` with `corepack pnpm --filter <package> <script>`; build `@markiro/db` before consumer tests. DB e2e must actually run, not skip. Reviewer checks generated snapshot/journal, tenant constraints, update guard, provenance immutability and upgrade path before Task 2.

## Task 2: Transactional link/unlink commands

**Files:** Create `apps/api/src/modules/traceability/cases/us-case-operations.ts`, `us-case-commands.ts`, `us-case-store.ts`, `apps/api/test/support/us-case-bridge-fixture.ts`, `apps/api/test/us-case-commands.e2e.test.ts`, `apps/api/test/us-case-concurrency.e2e.test.ts`; use existing `us-transformation-origin.ts`, `us-current-consumers.ts`, `us-master-data-support.ts` without weakening their invariants.

**Interfaces:** `UsCaseStore.link(tenantId, actorUserId, lotId: unknown, input: unknown, requestId: string): Promise<LinkCasesResult>` and `.unlink(tenantId, actorUserId, lotId: unknown, linkId: unknown, input: unknown, requestId: string): Promise<UnlinkCaseResult>`. Both authorize in the transaction through `authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.TRANSFORMATION_WRITE)`. `lockOutputLot(tx, tenantId, lotId)` returns the tenant lot under `FOR UPDATE` or 404; `lockEligibleBoxes(tx, tenantId, lotId, ssccs: readonly string[])` returns sorted, locked box rows with `activeLinkToSameLot: boolean`, throwing 404 or a stable cross-lot/disassembled conflict before writes; `lockCaseOperation(tx, tenantId, command, operationKey)` arbitrates one canonical receipt. The fixture exports `activeLinks(tenantId, sscc)` and `auditForOperation(tenantId, operationKey)` read helpers for exact assertions. Expose no seed write method on the public store. Task 3 adds read methods to this facade.

- [ ] **Step 1: Build the disposable fixture and write RED tests.** Reuse `seedFinalizableTransformation` and create 100 valid SSCC `boxes` using the existing `shifts` FK with an inert fixture shift; mark only fixture-controlled rows in `traceability_synthetic_case_origins`. Also fixture one unmarked eligible box, disassembled box, foreign-tenant box and an output lot whose Transformation is later voided. Assert that none of the fixture boxes gains `closed_at`, scans or print evidence. Test batch of 100, same-lot unchanged, cross-lot conflict, disassembled refusal, foreign/missing nondisclosure, atomic invalid member, exact receipt/audit, and unchanged event snapshot bytes.

```ts
const first = await store.link(
  tenant,
  actor,
  outputLotId,
  { operationKey: key, ssccs: [code] },
  "req-1",
);
const retry = await store.link(
  tenant,
  actor,
  outputLotId,
  { operationKey: key, ssccs: [`(00)${code}`] },
  "req-2",
);
expect(retry).toEqual(first);
expect(await activeLinks(tenant, code)).toHaveLength(1);
expect(await auditForOperation(tenant, key)).toMatchObject({
  actorUserId: actor,
  action: "case.link",
  requestId: "req-1",
});
```

- [ ] **Step 2: Run RED.** `corepack pnpm --filter @markiro/api exec vitest run test/us-case-commands.e2e.test.ts test/us-case-concurrency.e2e.test.ts`; require `US_TEST_DATABASE_URL` and record any explicit skip as no DB proof.
- [ ] **Step 3: Implement operation-key arbitration and command transactions.** Mirror `transformationTransaction` bounded repeatable-read retries and advisory-key lock, while using case-specific digest and receipt schema. Lock output lot `FOR UPDATE`, then lock eligible boxes in SSCC-sorted order. If any row is new, update its lot's `currentDependencyVersion` before checking origin; an all-unchanged batch must not change that version. Validate all before inserting; use partial unique index as final concurrent arbiter. Re-check authorization before examining a stored receipt. On exact replay return frozen receipt and do not audit again; on changed canonical payload return `case_operation_conflict`. A batch consisting only of already-active same-lot links is unchanged even after void; any new link requires a current origin.

```ts
await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.TRANSFORMATION_WRITE);
const stored = await lockCaseOperation(tx, tenantId, "case.link", input.operationKey);
if (stored) return replayCaseLink(stored, digest, lotId);
await lockOutputLot(tx, tenantId, lotId);
const boxes = await lockEligibleBoxes(tx, tenantId, lotId, [...input.ssccs].sort());
if (boxes.length !== input.ssccs.length) throw new NotFoundException({ code: "case_not_found" });
const toCreate = boxes.filter((box) => !box.activeLinkToSameLot);
if (toCreate.length) {
  await bumpLotDependencyVersions(tx, tenantId, [lotId]);
  const origin = await readCurrentTransformationOrigin(tx, tenantId, lotId);
  if (!origin.currentOrigin) throw new ConflictException({ code: "case_origin_not_current" });
}
```

- [ ] **Step 4: Add unlink with exact active link ID.** It must reload capability, lock lot then box, validate tenant+lot+link and `unlinked_at IS NULL`, increment the lot dependency version, set unlink fields once, write the operation receipt and exact tenant audit in the same transaction. It must not require a current origin; a stale link ID after relink returns `case_link_stale` and leaves the new row active. The guarded mutation is equivalent to:

```sql
UPDATE trace_lot_boxes
SET unlinked_at = now(), unlinked_by = $actor, unlink_reason = $reason
WHERE tenant_id = $tenant AND lot_id = $lot AND id = $link
  AND unlinked_at IS NULL
RETURNING id, box_id, sscc_at_link, unlinked_at;
```

- [ ] **Step 5: Pin concurrency and revocation behavior.** Tests must run two independent connections for same-box link/link, link/void and unlink/relink/stale-unlink races; assert exactly one active link and no success with vanished current origin. Change membership role between original success and replay; expect 403, not old receipt. Concurrent same-key callers must converge on one receipt/audit. Any committed failure must leave no partial links, receipt or success audit.
- [ ] **Step 6: Run GREEN and reviewer gate.** Focused tests above plus existing `test/us-transformation-void.e2e.test.ts`, `test/us-transformation-amendment-finalization.e2e.test.ts`, and `test/us-transformation-genealogy.e2e.test.ts`; `corepack pnpm --filter @markiro/api typecheck`, `lint`, `build`. Reviewer checks lock ordering against Transformation void/finalize, retry semantics, role reload, exact audit metadata (`tenantId`, actor, action, lot/box/link, source, reason, request ID) and no CTE snapshot mutation.

## Task 3: Tenant-scoped reads and US-only HTTP

**Files:** Create `apps/api/src/modules/traceability/cases/us-case-reads.ts`, `apps/api/src/deployment/us-case.controller.ts`, `apps/api/test/us-case-reads.e2e.test.ts`, `apps/api/test/us-case-http.e2e.test.ts`; modify `apps/api/src/modules/traceability/cases/us-case-store.ts`, `apps/api/src/deployment/us-runtime.ts`, `apps/api/src/deployment/us-development.module.ts` and the US runtime preflight relation check. Do not mount any RU box controller or Transformation HTTP route here.

**Interfaces:** Add `UsCaseStore.list(tenantId, actorUserId, lotId: unknown, query: unknown): Promise<CaseListResult>` and `.lookup(tenantId, actorUserId, query: unknown): Promise<CaseLookupResult>`. Route map is `GET /traceability/lots/:lotId/cases`, `GET /traceability/cases/lookup?sscc=`, `POST /traceability/lots/:lotId/cases`, `POST /traceability/lots/:lotId/cases/:linkId/unlink`. Match contracts from Task 1. Reads authorize `US_CAPABILITY.READ` in a consistent read transaction; no read audit is required by this spec.

- [ ] **Step 1: Write failing read tests.** List 100 synthetic links with a page limit of 25 and exhaust cursors without duplicate/missing IDs; active count remains 100 when `history=true`. After one unlink/relink, history has two rows but active count stays 100. Lookup accepts bare/`00`/`(00)`/`]C1` forms; unknown/foreign cases return the same 404 shape. After void, list/lookup report `originState: "gap"`; after a direct SSCC drift in a fixture, the row reports `ssccState: "inconsistent"` and lookup never attributes the new SSCC to the old frozen link.

```ts
expect((await store.list(tenant, auditor, lotId, { limit: 25, history: false })).activeCount).toBe(
  100,
);
expect((await store.lookup(tenant, auditor, { sscc: `(00)${code}` })).activeLink?.ssccAtLink).toBe(
  code,
);
expect((await store.lookup(tenant, auditor, { sscc: changedCode })).activeLink?.ssccState).toBe(
  "inconsistent",
);
```

- [ ] **Step 2: Write failing HTTP tests.** A real US test app must assert route/OpenAPI registration, valid session, current read/write roles, QA access, auditor write denial, disabled/missing membership, foreign tenant nondisclosure, strict payload errors, 16 KiB/body/origin/host rejection, `Cache-Control: no-store`, and no RU `/boxes` route. Verify exact 409 codes and operation replay response. Read endpoints never use a client-supplied tenant ID.
- [ ] **Step 3: Run RED.** `corepack pnpm --filter @markiro/api exec vitest run test/us-case-reads.e2e.test.ts test/us-case-http.e2e.test.ts`; DB suites need `US_TEST_DATABASE_URL`.
- [ ] **Step 4: Implement bounded reads.** Use tenant-qualified joins to marker, lot, active/history links and boxes; return saved SSCC and separate synthetic provenance. Check active SSCC against current box SSCC, mark inconsistent; never substitute it. Reuse `readCurrentTransformationOrigin` in the same snapshot for lot origin. For lookup, find tenant box by normalized current SSCC, then its active link; a missing box is 404 and an unlinked box is `{ activeLink: null }`. Keep paginated queries bounded at 100 and count active links independently. The query must preserve the tenant predicates and cursor tuple:

```sql
SELECT l.id, l.sscc_at_link, b.sscc AS current_sscc, s.box_id AS synthetic_box_id
FROM trace_lot_boxes l
JOIN boxes b ON b.tenant_id = l.tenant_id AND b.id = l.box_id
LEFT JOIN traceability_synthetic_case_origins s
  ON s.tenant_id = l.tenant_id AND s.box_id = l.box_id
WHERE l.tenant_id = $tenant AND l.lot_id = $lot
  AND ($history OR l.unlinked_at IS NULL)
  AND ($cursor_time IS NULL OR (l.linked_at, l.id) > ($cursor_time, $cursor_id))
ORDER BY l.linked_at, l.id LIMIT $limit_plus_one;
```

- [ ] **Step 5: Mount the controller only in `UsDevelopmentModule`.** Use `@Controller("traceability")` with `@UseGuards(UsSessionGuard)`, then follow `UsLotController` `ApiZodBody/Query/Response`, `UsRuntime.databaseOperation`, `UsRequest` principal/request ID and explicit allowlist patterns. Include the three new tables in read-only US preflight; startup still must not migrate/seed/repair. Exact route method order must not shadow `/cases/lookup` with a parameterized route. The controller delegates with the session-derived principal, never a body tenant:

```ts
@Post("lots/:lotId/cases")
@ApiZodBody(caseLinkCommandSchema)
@ApiZodResponse({ status: 200, schema: caseLinkResultSchema })
link(@Req() request: UsRequest, @Param("lotId") lotId: unknown, @Body() body: unknown) {
  const principal = this.principal(request);
  return this.runtime.databaseOperation(() =>
    this.runtime.cases.link(principal.tenantId, principal.userId, lotId, body, this.requestId(request)),
  );
}
```

- [ ] **Step 6: Run GREEN and reviewer gate.** Focused tests plus `corepack pnpm --filter @markiro/api test`, `typecheck`, `lint`, `build`. Reviewer checks query bounds, 404 nondisclosure, response validation, no RU module import and HTTP middleware coverage. A passing DOM-free HTTP test is not a browser check.

## Task 4: CI ownership, regressions and documentation

**Files:** Modify `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, `docs/us/requirements-traceability.md`, `docs/us/implementation-plan.md`, and `docs/us/mvp-contract.md` only where the implemented behavior changes their status/contract; add a focused isolation test if existing coverage does not pin the new suites/routes. Do not alter `.pen` or design-brief UI promises in this server-only task.

**Interfaces:** No new runtime API. CI must explicitly run case contract, DB migration and API e2e suites in the US opt-in job with `US_TEST_DATABASE_URL`, and fail if the US module begins mounting RU box/Station controllers. Documentation marks server case linkage implemented only after Tasks 1–3 pass; US-11 seed, Transformation HTTP and unified Events UI stay pending.

- [ ] **Step 1: Write RED isolation assertions.** Require case suite names in `.github/workflows/us-development.yml` and case controller in the US allowlist; reject `BoxesController`, Station and production release workflow references in the US entrypoint. Keep the test scoped to CI ownership, not a brittle full-workflow snapshot.
- [ ] **Step 2: Run RED.** `node --test tools/us-development/test/isolation.test.mjs`; expect missing case ownership assertions/entries.
- [ ] **Step 3: Wire CI and update only truthful docs.** Reuse existing US disposable Postgres setup and prebuilt dependency order. Do not add a deploy job or environment. Document exact endpoint shapes, 100 batch limit, origin gap, synthetic provenance and live-page cursor behavior; do not mark 100-case seed or UI complete. Add these commands to the existing `US_TEST_DATABASE_URL` job, keeping its current dependency builds:

```yaml
run: |
  pnpm --filter @markiro/platform-contracts exec vitest run test/us-case-bridge.test.ts
  pnpm --filter @markiro/db exec vitest run test/us-case-bridge-schema.test.ts test/us-case-bridge-migration.e2e.test.ts
  pnpm --filter @markiro/api exec vitest run test/us-case-commands.e2e.test.ts test/us-case-concurrency.e2e.test.ts test/us-case-reads.e2e.test.ts test/us-case-http.e2e.test.ts
```

- [ ] **Step 4: Run GREEN and broad relevant gates.** `node --test tools/us-development/test/isolation.test.mjs`; for each of `@markiro/domain`, `@markiro/platform-contracts`, `@markiro/db`, `@markiro/api` in dependency order, run its `test`, `typecheck`, `lint` and `build` scripts as separate `corepack pnpm --filter <package> <script>` commands; run focused US PostgreSQL e2e, `corepack pnpm format:check` and `git diff --check`. Check affected CI ownership with `tools/ci/affected.mjs`. Record any intentional DB skips and RU/full-workspace tests not run separately.
- [ ] **Step 5: Independent final review.** Compare full diff to the approved spec, not only the last edit. Recheck tenant and mutation guards, idempotency, link/void lock interaction, migration upgrade, audit, route allowlist and negative tests. Do not call browser, scanner, printer, US deployment, legal/regulatory review or physical 100-case operation verified on the strength of these automated gates.

## Execution handoff

The user chose a separate implementer and independent reviewer for each stage. Execute Tasks 1–4 sequentially with that gate and a final full-diff review, after owner review of this plan. Existing US work remains local and dirty by design; do not commit, push, PR, merge or release without explicit authorization.
