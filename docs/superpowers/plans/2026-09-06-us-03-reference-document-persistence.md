# US-03 Reference Document Persistence Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this tightly coupled contracts → storage → HTTP increment, sequentially, with checkbox tracking and independent final review.

**Goal:** Create and read tenant-scoped reference-document metadata through the isolated US API, as the prerequisite for receiving draft links.

**Architecture:** Existing input validation feeds one additive `reference_documents` table and a transactional `UsReferenceDocumentStore`. Current membership/profile checks and the US session/MFA wrapper protect the API; document creation and exact audit commit together.

**Tech Stack:** TypeScript, Zod, Drizzle/PostgreSQL, NestJS, Vitest; Node 24 and pnpm 11.22.0. No new dependencies.

**Spec:** `docs/us/mvp-contract.md`, `docs/us/data-dictionary.md` section 5 and the reference-document subset of `docs/superpowers/specs/2026-09-03-us-03-receiving-and-documents-design.md`. The preceding receiving input foundation is implemented; the historical RU composition is not applicable.

## Global constraints

- Work only in `.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve all existing dirty changes. No commit, push, merge, deployment, workflow dispatch or release enablement.
- Reuse the agreed nine document types and strict metadata fields. Preserve opaque number spelling, case, Unicode and leading zeros. Trim only input boundaries, never persisted reads.
- Reference number uniqueness is `(tenant, type, party, number)`, with a separate null-party identity, case-sensitive and independent of archival. A duplicate POST returns 409 `document_duplicate`, never silently merges or updates metadata. Event/import/export idempotency is separate.
- Read requires `traceability.read`. Create requires any of receiving/production/shipping write capabilities. Reload and lock membership/profile in the transaction. Reject absent/unknown roles and foreign/missing/archived issuer parties.
- No receiving event tables/commands, editing, archival command, binary attachments, browser proxy/UI, finalization, snapshot publication, CSV or hosted resources in this increment.
- Synthetic disposable US PostgreSQL only: `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev`. Always unset `DATABASE_URL`; never load primary env. Fixtures create and remove only their own scratch databases; do not migrate the base database.

## Task 1: Document persistence contracts and database

Files: extend `packages/platform-contracts/src/traceability/documents.ts` and public exports; add `test/us-reference-documents.test.ts`; add `packages/db/src/schema/traceability-documents.ts`, schema export and generator entry; generate migration0120 and metadata; add DB schema/migration tests.

Interfaces: export `referenceDocumentSchema`, `referenceDocumentListSchema`, `listReferenceDocumentsQuerySchema`, `ReferenceDocument`, `ReferenceDocumentList`. Record fields: existing metadata plus `id`, nullable `archivedAt`, opaque `createdBy`, `createdAt`, `updatedAt`. Query: optional `search`, `type`, `partyId`; `archived` false/true/all, `limit` 1–100 default50, `offset` 0–100000 default0. List cannot exceed its declared limit. Input notes reject NUL/lone surrogates before PostgreSQL while retaining valid multiline text; snapshot notes use the same character restriction without trimming.

- [x] Write failing contract tests through public exports: strict records/query/list, lossless strings, dates, unknown fields, bounds and duplicate shapes. Include input/snapshot NUL and surrogate regression.

```ts
expect(listReferenceDocumentsQuerySchema.parse({})).toEqual({
  archived: "false",
  limit: 50,
  offset: 0,
});
expect(referenceDocumentInputSchema.safeParse({ ...input, notes: "x\u0000y" }).success).toBe(false);
expect(referenceDocumentSchema.parse(row).number).toBe("=0001");
```

- [x] Run focused contract tests RED, implement the contracts, then GREEN/typecheck/build before API consumers.
- [x] Write a schema test for the composite issuer FK and `(tenant,id)` anchor; observe missing-table failure before implementing the schema.
- [x] Add `reference_documents`: UUID PK, tenant FK; enum type, nullable label/party/date/notes/archived timestamp; nonnull number and historical actor; created/updated timestamps. Add composite party FK, two identity unique indexes and tenant/party lookup index. Enforce nonblank length/control/other-label shape, valid year range and actor bounds; no attachment columns or event FK yet.
- [x] Generate migration with `pnpm --filter @markiro/db exec drizzle-kit generate --name us_reference_documents`; review it only creates the document enum/table/constraints/indexes. Rebuild DB exports.
- [x] Exercise upgrade from migration0119 on an owned disposable DB: preserve old parties/products/lots, start with zero documents, same number allowed across tenant/type/party but not repeated null/non-null identity, archival does not release identity, reject cross-tenant FK and invalid metadata at storage.

## Task 2: Transactional store

Files: create `apps/api/src/modules/traceability/documents/us-reference-document-store.ts` and `us-reference-document-support.ts`; extend `authorizeUsMasterData` to accept an explicit any-of capability array while preserving single-capability callers; add `apps/api/test/us-reference-document.e2e.test.ts`.

Interfaces: `new UsReferenceDocumentStore(db)` exposes `listDocuments(tenantId, actorUserId, query)`, `getDocument(tenantId, actorUserId, id)`, `createDocument(tenantId, actorUserId, input, requestId)`. Inputs at store boundary are unknown and parsed after authorization; outputs use strict shared contracts.

- [x] Write failing store tests on owned PostgreSQL: precise create/read/list, all operational roles, auditor read-only/member denial, role downgrade/removal, invalid/missing profile, foreign/archived issuer, malformed input, escaped search/pagination/filtering, concurrent duplicates, exact actor/tenant/action/target/before/after/request audit, audit rollback and sanitized invalid stored output.

```ts
const result = await store.createDocument(tenant, actor, input, "server-request");
expect(await store.getDocument(tenant, actor, result.id)).toEqual(result);
await expect(store.createDocument(tenant, actor, input, "retry")).rejects.toMatchObject({
  status: 409,
  response: { code: "document_duplicate" },
});
```

- [x] Implement the store using tenant predicates on every business query, shared membership/profile locks, a SHARE lock on a supplied active issuer and one transaction for insert/audit. Map only the two known unique-index errors to the duplicate code. Leave infrastructure errors for the existing sanitized runtime wrapper.
- [x] Return strict lossless records, stable `number,id` ordering and bounded search with escaped LIKE metacharacters. No update/delete helper or endpoint. Audit action `traceability.reference_document.created`, target `traceability_reference_document`, `before: null`, exact response in `after`.
- [x] Run focused store tests GREEN and API typecheck/lint/build.

## Task 3: Isolated HTTP integration and verification

Files: add `apps/api/src/deployment/us-reference-document.controller.ts`; register only in `us-development.module.ts` and `us-runtime.ts`; extend existing real-MFA `apps/api/test/us-catalog-http.e2e.test.ts`; add new tests to check-only `us-development.yml`; update implementation progress, isolation inventory and DOC matrix evidence.

Routes: GET/POST `/traceability/reference-documents`, GET `/traceability/reference-documents/:id`. No other method or nested path. Keep trusted Host/Origin, 16KiB uncompressed JSON, fresh session/MFA, no-store and server-generated request IDs. OpenAPI describes strict input/query/response and 400/401/403/404/409/413/415/503; custom errors use existing safe schema conventions.

- [x] Add authenticated HTTP tests before registering routes: real MFA create/read/list and exact audit, foreign party/doc denial, live role changes, strict unknown fields/malformed IDs/query, duplicate409, Host/Origin/body policy, unmounted edit/archive/attachment and unchanged readiness/RU paths, strict OpenAPI schema.
- [x] Observe 404 failures; implement controller/runtime wiring; run HTTP tests GREEN with actual disposable PostgreSQL, no business mocks.
- [x] Run full contracts and DB tests/typecheck/lint/build, full API tests/typecheck/lint/build with `DATABASE_URL` unset and explicit US scratch DB enabled. Report primary-infrastructure skips/failures separately; never load primary env to make them pass. Run existing US regression and admin consumer typecheck.
- [x] Run 17 isolation contracts and checker, compiled local runtime smoke, full formatting and diff checks. Inspect final migration snapshot delta and scoped diff; no local graph exists to update.
- [x] Independent read-only review, reproduce/fix findings and rerun affected tests. Record actual results and remaining work in this plan and US docs. Browser/hosted/attachment/finalization acceptance remains unclaimed.

## Verification — 2026-09-06

- RED/GREEN: new contracts and schema failed before implementation; the store module was absent; seven HTTP tests returned 404 before wiring. The review regression then reproduced accepted NUL/lone-surrogate search and HTTP 503 instead of 400. The document-local search schema now rejects unsafe text before SQL. Re-review found no remaining actionable issue and independently reran all 19 document contract tests.
- Full contracts: 400 tests / 20 files passed, no skips; typecheck, lint and build passed. The new record/query tests account for 19 cases; existing receiving input tests remain green.
- Full DB: 278 tests passed, 141 primary-environment tests skipped; typecheck, lint and build passed. New schema/migration tests: 11 passed, exercising actual PostgreSQL upgrade from0119, old-row preservation, foreign issuer denial, both identity indexes and archived identity retention. Generated snapshot comparison adds only the document table/enum and preserves the previous snapshot chain.
- Isolated US API plus deployment/environment/health regression: 335 tests / 17 files passed, no skips, including 18 store and seven new document HTTP cases. API typecheck, lint and build and admin consumer typecheck passed. HTTP uses real MFA and an owned disposable US database, not business-response mocks.
- Broad API: 1,769 passed / 1,411 skipped, with eight failed primary-product files. A focused diagnostic rerun confirms nine setup suites lacking primary DB/auth configuration plus three cascading teardown errors. This broad gate is not green; primary environment variables were deliberately not loaded.
- Isolation: 17 contracts, the release-lock checker and four compiled runtime/owner smoke tests passed. No remote workflow settings, CI run or hosted readiness is claimed.
- Final hygiene: repository-wide `format:check` and `git diff --check` passed. The post-format document store/catalog HTTP rerun passed all 46 tests without skips. The primary checkout's existing untracked design/export files and branch were preserved.
- Scope: contracts, DB/schema/migration, isolated document store/controller, shared authorization helper, tests, check-only CI test selection and US docs. No new dependencies, document UI/proxy, attachments, edit/archive/delete command, receiving event persistence, finalization, snapshot publication, CSV or release changes.
- Only randomly owned synthetic US databases were migrated and removed by fixtures. The base US and primary databases were not migrated. No browser, external service or hardware acceptance was performed because this increment adds only server metadata functionality. No local Graphify graph exists to update.
- All work stays uncommitted in the existing isolated worktree on `codex/us-mvp`; inherited dirty work is preserved. No push, PR, merge, deployment or workflow dispatch.
