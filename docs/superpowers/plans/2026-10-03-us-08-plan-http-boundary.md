# US-08 Plan HTTP Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A separate implementer and independent reviewer handle each task; the primary agent accepts the review before the next task.

**Status:** owner-approved on 2026-10-03; implemented on `codex/us-mvp` with independent reviews of each task and a final audit correction (`5ca95e863`). This is a development checkpoint, not a release or deployment approval.

**Goal:** Expose the existing US-only Traceability Plan draft, validation, approval and immutable PDF services through a strict, documented HTTP boundary without enabling a release.

**Architecture:** Keep all routes in the explicit US module and compose the existing tenant-scoped plan stores in `UsRuntime`. Add a read/inspection service that captures one coherent tenant configuration, derives synthetic provenance on the server, and serves saved-draft validation and ephemeral preview; published detail uses frozen evidence. Treat private artifact storage as optional for draft operations but mandatory for approval and PDF download, with a distinct 503 code and no RU/default storage fallback.

**Tech Stack:** NestJS/Express US entry point, Zod contracts in `@markiro/platform-contracts`, Drizzle/PostgreSQL, existing `@markiro/domain` plan rules and React-PDF renderer, Vitest with disposable `US_TEST_DATABASE_URL`.

**Spec:** `docs/superpowers/specs/2026-10-02-us-08-traceability-plan-current-design.md`, including the owner clarification dated 2026-10-03. The approved plan `docs/superpowers/plans/2026-10-02-us-08-plan-approval-pdf.md` describes the already implemented internal stores.

## Global Constraints

- Work only on `codex/us-mvp`; do not register a Plan controller in RU, import RU tenant services or use RU/default object storage. No PR, merge, release, deployment or production data in this plan.
- Preserve current US session, origin, host, request-ID and no-store boundaries. Never trust tenant, actor, demo status, configuration snapshot, approver, artifact key or timestamp from a request.
- Fresh membership/capability/profile checks occur in tenant transactions: `traceability.read` for list/detail; `traceability.qa.manage` for create/save/validate/approve/discard; `traceability.export.read` for preview/download.
- Wrong-tenant and absent version IDs return the same 404. `US_GENERIC_LOT_TRACEABILITY` and `RU_CHZ` do not receive a Plan service. Method, case and trailing-slash aliases are rejected before authentication and do not invoke a store.
- Published rows and PDF bytes are immutable. HTTP responses expose hash/byte size/renderer version but never object key, raw idempotency hash, secret, or trusted-seed proof. Synthetic provenance is server-derived and retained from frozen evidence after publication.
- Without private US artifact configuration, drafts, validation and watermarked preview work; approve and download return `503 {"code":"us_plan_artifact_storage_unconfigured"}` after the appropriate authorization and auditable denial. No production readiness assertion follows from local tests.
- The Plan PDF is English regardless of EN/ES UI. Preview is ephemeral, watermarked `DRAFT — not effective`; synthetic published PDF carries `Synthetic demo — not an operational record` on every page.
- Use red-green-refactor per task. Only disposable, loopback `US_TEST_DATABASE_URL` databases may be migrated by e2e tests. Preserve dirty/unrelated files. Each accepted task may be checkpoint-committed and pushed only under the user's already authorized US-branch scope; do not push this proposed plan by itself.

## File and interface map

| Area                                                                   | Responsibility                                                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/platform-contracts/src/traceability/plans-http.ts`           | Strict request/query and sanitized response schemas; no server-owned identity fields in bodies.                              |
| `packages/domain/src/traceability/plan/impact.ts`                      | Deterministic comparison of frozen effective configured facts with current facts, including individual location/product IDs. |
| `apps/api/src/modules/traceability/plans/us-plan-read.ts`              | One-transaction list/detail projection, current impact, frozen publication fields, server-derived synthetic label.           |
| `apps/api/src/modules/traceability/plans/us-plan-inspection.ts`        | Freshly authorized, saved-revision validation and ephemeral preview from one coherent draft/configuration capture.           |
| `apps/api/src/modules/traceability/plans/us-plan-validation.ts`        | Shared approval/inspection business validation, including TLC-location description completeness.                             |
| `apps/api/src/deployment/us-plans.controller.ts`                       | Explicit canonical route table, OpenAPI, request context, strict bodies/queries, safe PDF streaming.                         |
| `apps/api/src/deployment/us-runtime.ts` and `us-development.module.ts` | US-only service wiring, optional private artifact adapter, shutdown, migration preflight, controller allowlist.              |
| `apps/api/src/deployment/us-http.ts`                                   | Bounded JSON body for Plan draft create/save only; keep 16 KiB command bodies and strict origin policy.                      |
| Focused tests and `.github/workflows/us-development.yml`               | Contract, impact, service, HTTP/OpenAPI/negative-route and isolated CI coverage.                                             |

The canonical route table is:

| Method | Path                               | Capability  | Result                                                                                 |
| ------ | ---------------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| GET    | `/traceability/plans`              | read        | Version summaries, effective impact and publication availability.                      |
| POST   | `/traceability/plans`              | QA manage   | Create one saved draft.                                                                |
| GET    | `/traceability/plans/:id`          | read        | Draft or sanitized frozen published detail.                                            |
| PUT    | `/traceability/plans/:id`          | QA manage   | Replace saved draft at `expectedRevision`.                                             |
| POST   | `/traceability/plans/:id/validate` | QA manage   | Read-only approval issues for saved revision and proposed confirmations.               |
| POST   | `/traceability/plans/:id/preview`  | export read | Ephemeral watermarked PDF for saved revision; invalid draft returns structured issues. |
| POST   | `/traceability/plans/:id/approve`  | QA manage   | Existing atomic approval with body idempotency key.                                    |
| POST   | `/traceability/plans/:id/discard`  | QA manage   | Discard draft at `expectedRevision`.                                                   |
| GET    | `/traceability/plans/:id/pdf`      | export read | Stored, hash-verified English PDF; no re-render.                                       |

For validate, use `{expectedRevision, confirmations}`; for preview, use `{expectedRevision}`. They are read-only POST operations so that exact, bounded JSON and origin checks apply; neither persists a draft or an artifact. Preview requires a saved, renderable draft and is not a substitute for the authoritative approval check. Unsaved editor state must first be saved, or the client must clearly label the preview as the saved revision.

## Review Focus

1. A reader opening a historical version after current locations/products change must see its frozen facts and a separate current-impact warning, never a silently rewritten plan (Tasks 1–2).
2. A QA user submitting stale `expectedRevision` to validate/preview/approve must get a 409 and no PDF or publication of a different draft (Tasks 3–4).
3. A user with read permission but no export permission must not receive preview or published bytes, even when they know a version ID; the same applies after membership revocation (Tasks 3–4).
4. A local US runtime with no plan artifact variables must still allow drafts but must never read the default `S3_*` bucket or return a PDF download (Tasks 3–4).
5. A wrong-tenant ID, malformed UUID, HEAD alias, mixed-case path, trailing slash or duplicate query key must not disclose whether a plan exists or invoke a store (Task 4).

---

### Task 1: Strict HTTP contracts and deterministic change impact

**Files:**

- Create: `packages/platform-contracts/src/traceability/plans-http.ts`
- Modify: `packages/platform-contracts/src/index.ts` (export only the new public schemas)
- Create: `packages/platform-contracts/test/us-plans-http.test.ts`
- Create: `packages/domain/src/traceability/plan/impact.ts`
- Modify: `packages/domain/src/index.ts` (export comparator)
- Create: `packages/domain/test/us-plan-impact.test.ts`

**Interfaces:**

- Consumes: existing `usPlanDraftCreateBodySchema`, `usPlanDraftSaveBodySchema`, `usPlanDraftDiscardBodySchema`, `usPlanApproveBodySchema`, `UsPlanConfiguredFacts`, `UsPlanSnapshot`.
- Produces: `usPlanValidateBodySchema`, `usPlanPreviewBodySchema`, `usPlanListResponseSchema`, `usPlanDetailResponseSchema`, `usPlanValidationResponseSchema` and `compareUsPlanConfiguredFacts(frozen: UsPlanConfiguredFacts, current: UsPlanConfiguredFacts): UsPlanImpact`. `UsPlanImpact` has `changedSections` (stable section codes) and `changedLocationIds`/`changedProductIds` (sorted UUIDs); it never embeds a revised historical snapshot. Export `UsPlanListResponse`, `UsPlanDetailResponse` and `UsPlanValidationResponse` as `z.infer` types.

- [ ] **Step 1: Write red contract tests.** Assert strict rejection of tenant/actor/demo/approvedAt/objectKey in bodies, numeric positive revisions, exact sorted validation issue shape, and that published DTO parsing rejects a raw `objectKey` or `idempotencyKeyHash`. Use a valid draft fixture from the existing `test/us-plans-contracts.test.ts`; add unknown fields one at a time.
- [ ] **Step 2: Run `pnpm --filter @markiro/platform-contracts exec vitest run test/us-plans-http.test.ts` and record the missing-schema failure.**
- [ ] **Step 3: Add the schemas.** Define the input with the exact Zod shape below; define discriminated draft/published response objects and strict nested objects, exposing the published SHA-256, byte size and renderer version but not provider keys. Use a separate `publicationAvailability` enum `available | artifact_storage_unconfigured`; do not infer it from a draft's status.

The list response is `{items, effectiveImpact, publicationAvailability}`. Each draft item carries `id`, `versionNumber`, `draftRevision`, `status: "draft"`, timestamps and `provenance`; each published item carries `id`, `versionNumber`, `status: "effective" | "superseded"`, approval and retention timestamps, `provenance`, and artifact SHA-256/byte size/renderer version. `effectiveImpact` is `null` when no effective version exists. Detail is a strict discriminated union: draft adds `sections`, `changeSummary`, creator and `statementOwnership`; published adds frozen `snapshot`, sanitized fact-source manifest (synthetic source has only `origin`, never the trusted-seed proof), server-attributed confirmations, approver, artifact metadata and a separately labelled comparison against current configured facts. Build exact nested Zod schemas for the existing `UsPlanSnapshot` fields in `packages/domain/src/traceability/plan/snapshot.ts` and `LocationDescriptionInput`; do not use `z.unknown()` for the frozen snapshot. The DTO projection must satisfy these contracts in tests.

```ts
export const usPlanValidateBodySchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    confirmations: usPlanApproveBodySchema.shape.confirmations,
  })
  .strict();
export const usPlanPreviewBodySchema = z
  .object({
    expectedRevision: z.number().int().min(1),
  })
  .strict();
export const usPlanValidationResponseSchema = z
  .object({
    versionId: platformUuidSchema,
    draftRevision: z.number().int().min(1),
    issues: z.array(
      z
        .object({
          section: z.enum([
            "plan",
            "recordMaintenance",
            "ftlIdentification",
            "tlcAssignment",
            "pointOfContact",
            "farmActivity",
            "reviewAndUpdate",
          ]),
          path: z.string(),
          code: z.string(),
        })
        .strict(),
    ),
    publicationAvailability: z.enum(["available", "artifact_storage_unconfigured"]),
  })
  .strict();
export type UsPlanListResponse = z.infer<typeof usPlanListResponseSchema>;
export type UsPlanDetailResponse = z.infer<typeof usPlanDetailResponseSchema>;
export type UsPlanValidationResponse = z.infer<typeof usPlanValidationResponseSchema>;
```

- [ ] **Step 4: Write red impact tests.** Freeze a v1 config fixture; change only a location description, remove a location, add a product, change an existing product `revision`/`coverageStatus`, and change tenant/profile scalar values. Assert exact section codes and individual IDs in stable order. Assert equal facts produce empty arrays and no mutation of either input.
- [ ] **Step 5: Run `pnpm --filter @markiro/domain exec vitest run test/us-plan-impact.test.ts` and record the missing-export failure.**
- [ ] **Step 6: Implement the comparator.** Compare normalized scalar fields and ID-keyed collections, not aggregate counts or array insertion order. Return only stable codes `tenant | profile | tlcSourceLocations | productProfiles` and sorted changed IDs. Keep application-policy workflow version outside current configured-facts comparison; the published detail still displays its frozen version.

```ts
export interface UsPlanImpact {
  changedSections: Array<"tenant" | "profile" | "tlcSourceLocations" | "productProfiles">;
  changedLocationIds: string[];
  changedProductIds: string[];
}
export function compareUsPlanConfiguredFacts(
  frozen: UsPlanConfiguredFacts,
  current: UsPlanConfiguredFacts,
): UsPlanImpact;
```

- [ ] **Step 7: Run focused tests, then `pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint && pnpm --filter @markiro/domain build`; repeat for `@markiro/platform-contracts`.**
- [ ] **Step 8: Reviewer checks strict DTO whitelisting, per-ID impact, stable ordering and no legal/compliance claim.** Fix and rerun before primary acceptance. Commit only accepted paths.

### Task 2: Authorized read projection with frozen detail

**Files:**

- Create: `apps/api/src/modules/traceability/plans/us-plan-read.ts`
- Create: `apps/api/test/us-plan-read.e2e.test.ts`
- Reuse without broad refactor: `us-plan-store.ts`, `us-plan-approval.ts`, `us-plan-configuration.ts`, `us-plan-published.ts`.

**Interfaces:**

- Consumes: `compareUsPlanConfiguredFacts`, existing row parsers, `authorizeUsMasterData`, `readUsPlanConfiguration` and exact trusted-seed verifier.
- Produces: `UsPlanReadStore.list(tenantId, actorUserId)` and `.get(tenantId, actorUserId, id)` returning the Task 1 response DTOs. Constructor accepts the server-derived `publicationAvailability` value. List/get use one repeatable-read transaction each; published detail returns frozen snapshot, fact sources, confirmations, retained status/hash and a separate current impact. Draft detail carries server-derived synthetic/operational provenance and `operator_pending`; no raw trusted-seed proof leaves the store.

- [ ] **Step 1: Write red isolated DB tests** using `createUsProfileTestDatabase`: same-tenant v1/v2/draft list, frozen v1 detail after current config changes, exact changed product/location IDs, synthetic draft marker only for the verified seed, forged seed near-miss, wrong-tenant and absent IDs both 404, revoked read membership 403, generic profile safe denial, and no object key/seed proof in serialized output.
- [ ] **Step 2: Run `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev pnpm --filter @markiro/api exec vitest run test/us-plan-read.e2e.test.ts` against the disposable local US test service and record the missing-store failure.** Never substitute a shared `.env` database.
- [ ] **Step 3: Implement `UsPlanReadStore`.** In each repeatable-read transaction call `authorizeUsMasterData(..., US_CAPABILITY.READ)` before tenant-scoped row reads, require `US_FSMA204_PROCESSOR`, parse stored rows, and call `readUsPlanConfiguration` in the same transaction. For effective detail, compare `published.evidence.snapshot.configured` with current facts; for superseded detail show frozen evidence and an explicitly labelled current comparison, not a claim about what changed at supersession. Map `published.artifact` to `{sha256, byteSize, rendererVersion}` only. On the list, show impact only for the current effective version.

```ts
export class UsPlanReadStore {
  constructor(
    private readonly db: Db,
    private readonly publicationAvailability: "available" | "artifact_storage_unconfigured",
  ) {}
  list(tenantId: string, actorUserId: string): Promise<UsPlanListResponse>;
  get(tenantId: string, actorUserId: string, rawId: unknown): Promise<UsPlanDetailResponse>;
}
```

- [ ] **Step 4: Run the focused DB test and `pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint`.** Reviewer checks one-snapshot impact, fresh authorization, frozen history and response sanitization. Commit only after independent acceptance.

### Task 3: Saved-draft inspection and optional artifact gate

**Files:**

- Create: `apps/api/src/modules/traceability/plans/us-plan-inspection.ts`
- Create: `apps/api/src/modules/traceability/plans/us-plan-validation.ts`
- Create: `apps/api/test/us-plan-inspection.e2e.test.ts`
- Modify: `apps/api/src/modules/traceability/plans/us-plan-approval.ts` only to share the exact validation/capture helper if needed and to express the configured-store gate after authorization.
- Modify: `apps/api/src/deployment/us-runtime.ts`, `apps/api/src/deployment/us-bootstrap.ts`, `apps/api/src/deployment/us-development.module.ts` only for US service ownership/wiring and plan-table preflight; controller registration is Task 4.
- Test: `apps/api/test/us-plan-artifact-config.test.ts`, `apps/api/test/us-plan-approval.e2e.test.ts`, `apps/api/test/deployment-entry.test.ts`.

**Interfaces:**

- Consumes: saved draft row, `readUsPlanConfiguration`, `validateUsPlanApproval`, `buildUsPlanSnapshot`, `buildUsPlanDraftFactSources`, `renderUsPlanDraftPreview`, `UsPlanArtifactStore` and `UsPlanApprovalStore`.
- Produces: `UsPlanInspectionStore.validate(tenantId, actorUserId, id, body)` -> Task 1 validation DTO; `.preview(tenantId, actorUserId, id, body)` -> `{bytes: Buffer, draftRevision: number}`; runtime properties `planRead`, `planDrafts`, `planInspection`, `planApproval` with `planArtifactStorage` optional. Approval/download still perform authorization and exact failure audit when storage is unavailable.

- [ ] **Step 1: Write red tests.** A saved valid draft validates and previews without artifact variables; preview PDF contains draft watermark and synthetic marker where appropriate, does not create an artifact/audit approval or change a row, and reports the saved revision. Stale revisions return 409; missing/foreign IDs return identical 404; revoked QA/export capabilities deny the corresponding method. Real-tenant false confirmations appear as issues. Invalid farm status/forbidden claim gives structured issues and no PDF. Verify missing storage yields the exact explicit 503 for approve/download _after_ auth and creates a denial audit with actor, tenant, action, target and code; never touches default `S3_*`.
- [ ] **Step 2: Run `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev pnpm --filter @markiro/api exec vitest run test/us-plan-inspection.e2e.test.ts test/us-plan-approval.e2e.test.ts` against the disposable local US test service and record the failing cases.**
- [ ] **Step 3: Implement inspection capture.** Extract approval's complete business validation (including required location descriptions) into `us-plan-validation.ts` and use it from both approval and inspection. Parse strict bodies; in a repeatable-read transaction authorize the requested capability, select tenant-scoped saved draft, compare `expectedRevision`, read configuration and verify synthetic seed at server time. Validation returns issues plus publication availability; preview uses a frozen in-memory snapshot and fact-source manifest, renders after the transaction, never writes to object storage. Return the captured `draftRevision` with the PDF so the UI can label it as the saved revision; a concurrent later edit does not rewrite that preview, and approval independently rechecks its own revision.
- [ ] **Step 4: Wire only US runtime services.** Instantiate `UsPlanArtifactStore` only from validated `env.planArtifactStorage`; never from `S3_*`. Add a third, optional `UsPlanArtifactS3Transport` test seam to `createUsDevelopmentApplication`/`UsRuntime`, passed only to that validated store, so HTTP tests can use a fake private transport without MinIO; ordinary startup passes no override. Keep approval/download authorization and auditing when the adapter is absent, returning `us_plan_artifact_storage_unconfigured`; close the adapter on US runtime shutdown. Add `traceability_plan_versions` and cleanup-fence columns to `assertDatabaseReady` read-only preflight, without changing the deliberately unavailable `/health/ready` response.

```ts
type PlanInspection = {
  validate(
    tenantId: string,
    actorUserId: string,
    rawId: unknown,
    body: unknown,
  ): Promise<UsPlanValidationResponse>;
  preview(
    tenantId: string,
    actorUserId: string,
    rawId: unknown,
    body: unknown,
  ): Promise<{ bytes: Buffer; draftRevision: number }>;
};
const artifacts = env.planArtifactStorage
  ? new UsPlanArtifactStore(env.planArtifactStorage, planArtifactTransport)
  : null;
```

- [ ] **Step 5: Run focused tests, then API `test`, `typecheck`, `lint`, `build`; rerun artifact-config and approval suites.** Reviewer checks authorization-before-storage status, absence of object-store fallback, preview race behavior, unchanged atomic approval and resource shutdown. Fix and rerun before acceptance.

### Task 4: Canonical controller, transport, OpenAPI and CI

**Files:**

- Create: `apps/api/src/deployment/us-plans.controller.ts`
- Modify: `apps/api/src/deployment/us-development.module.ts` (explicit controller allowlist)
- Modify: `apps/api/src/deployment/us-http.ts` (256 KiB parser for Plan create/save only)
- Create: `apps/api/test/us-plan-http.e2e.test.ts`
- Modify: `apps/api/test/deployment-entry.test.ts`, `apps/api/test/openapi-coverage.test.ts` if their inventories require it
- Modify: `.github/workflows/us-development.yml` (focused contracts/impact/inspection/HTTP check-only steps)

**Interfaces:**

- Consumes: Task 1 strict schemas, Task 2 read store, Task 3 inspection/runtime and existing draft/approval stores.
- Produces: only the canonical route table above. `POST /:id/validate` and `/preview` read saved revision; preview includes `X-Plan-Draft-Revision` for the captured revision. Response bytes use `application/pdf`, `Cache-Control: no-store`, a bounded `Content-Length` and safe fixed filename (never user text). No controller reaches RU runtime.

- [ ] **Step 1: Write red HTTP tests** with a disposable DB, verified US session and stubbed private artifact transport. Cover all nine routes, strict body limits and unknown fields, exact status/response schemas, stale revision, same-key approval retry, immutable PDF byte/hash round trip, missing-store 503 and draft availability, cross-tenant 404, revoked capabilities, unconfirmed operator assertions, synthetic provenance, and exact audit metadata. Snapshot before/after tests for read-only validate/preview. Assert PDF is English under an ES `Accept-Language` header.
- [ ] **Step 2: Add alias/OpenAPI red tests.** For each route, anonymous `HEAD`, trailing slash, mixed case, wrong method and extra suffix must return 404 before session/store work; all query keys (including duplicate or percent-encoded keys) and malformed IDs are rejected with 400 or canonical 404 without writes. Swagger paths expose only intended methods and explicit 200/201, 400, 401, 403, 404, 409, 413, 415 and 503 responses as applicable. RU entry document has no Plan paths.
- [ ] **Step 3: Run `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev pnpm --filter @markiro/api exec vitest run test/us-plan-http.e2e.test.ts` against the disposable local US test service and record missing-controller failures.**
- [ ] **Step 4: Implement the controller and canonical guard.** Guard checks `request.method` and `request.path` against an exact route table before `UsSessionGuard`; dynamic IDs use strict lowercase UUID syntax and the store's tenant lookup. Controller obtains tenant/user/request ID only from `UsRequest`, passes unknown bodies into strict schemas, and uses `ApiZodBody`/`ApiZodResponse` or explicit binary OpenAPI metadata on every endpoint. Return raw verified bytes through a bounded PDF response with `nosniff` and no-store; never render a published PDF. Use a 256 KiB JSON parser only for create/save, the existing 16 KiB default for approval and read-only POSTs; preserve origin and host checks.

```ts
@Controller("traceability/plans")
@UseGuards(UsPlansCanonicalRouteGuard, UsSessionGuard)
@ApiCookieAuth("markiro-us.session_token")
export class UsPlansController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}
  // Each method delegates to one runtime service with principal from UsRequest.
}
```

- [ ] **Step 5: Register the controller only in `UsDevelopmentModule`, then run focused HTTP, existing US entry/isolation and OpenAPI tests.** Add the focused tests to check-only `.github/workflows/us-development.yml`, without touching release/deploy workflows.
- [ ] **Step 6: Run final gates:** run the exact commands below after building shared dependencies, with a disposable US test database for database-backed suites. Record database skips explicitly. Reviewer inspects the full diff for RU leakage, route alias bypass, PDF/secret leakage, audit fields, no-store headers and no production-ready claim. Fix and repeat review until accepted.

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
pnpm --filter @markiro/platform-contracts test
pnpm --filter @markiro/platform-contracts typecheck
pnpm --filter @markiro/platform-contracts lint
pnpm --filter @markiro/platform-contracts build
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
node tools/us-development/check-isolation.mjs
git diff --check
pnpm format:check
```

## Handoff after acceptance

After this HTTP plan is independently accepted, write and obtain approval for a separate US cabinet plan covering EN/ES Plan navigation, list/editor, source labels, validation/confirmation dialog, immutable detail/download, responsive and keyboard-accessible states, then an integrated synthetic browser flow. This HTTP plan alone does not verify a rendered browser, real non-RF storage, backup/restore, deployment, regulatory acceptance, or a public release.
