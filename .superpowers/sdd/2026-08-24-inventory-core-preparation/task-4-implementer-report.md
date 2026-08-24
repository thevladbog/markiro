# Task 4 implementer report — tenant-admin inventory preparation API

## Outcome

Implemented the tenant-cabinet preparation surface only:

- `GET /inventories`
- `POST /inventories`
- `GET /inventories/:id`
- `PATCH /inventories/:id`
- `POST /inventories/:id/imports/:status`

No snapshot fixation/start, CHZ external API, station route, scan/execution, document, or admin UI
surface was added.

## RED / GREEN evidence

- Initial RED ran against a newly created temporary PostgreSQL database after the full migration
  journal applied successfully. The two focused files reported 12/12 failures, limited to missing
  inventory routes and OpenAPI paths.
- Multipart-boundary RED proved that an `8 MiB + 1 byte` upload is rejected before storage; the
  observed established Nest contract is the sanitized `413 File too large` response, which the
  final test pins.
- UUID-boundary RED proved that an unvalidated inventory path id reached PostgreSQL and returned
  500. Route-slot Zod validation was then added; malformed ids now return 400 before database or
  object-storage work.
- Final GREEN ran the complete focused suite against another fresh temporary database after the
  full migration journal: 14/14 tests passed (12 e2e and 2 OpenAPI). The database created by the
  test run was force-dropped only after that same run had successfully created it.

## Endpoint, authorization, and lifecycle behavior

- List/detail use `OPERATIONS_READ`; create/update/upload use `OPERATIONS_WRITE` and the established
  subscription write policy. Read-only managed subscriptions may still list/detail but receive the
  established `subscription_read_only` denial for every mutation.
- All product, line, label-template, inventory, import-idempotency, audit, and response joins are
  tenant-scoped in SQL. Cross-tenant detail/update/upload returns 404 without storage publication.
- Create locks the tenant organization row, reads the tenant maximum `ИНВ-NNNNN` suffix, and assigns
  the next tenant-sequential immutable number. The tenant unique constraint remains the last guard.
- Product status and current GTIN are re-read from the selected tenant product. The assigned line is
  checked for tenant-scoped existence. The schema has no line active-state flag, so no unsupported
  active-line semantics were invented.
- Repack resolves the current tenant default box-label template and verifies the template belongs to
  the tenant; check mode always stores `null`. Client GTIN/template snapshots are not accepted.
- Inclusive civil-date bounds are validated and require `from <= to`. Update/upload first lock the
  tenant inventory and accept only `draft`/`preparing`; `ready` and later states are immutable here.

## Upload publication, transaction, and idempotency ordering

1. The route bounds the in-memory multipart file to the Task 2 compressed-byte limit and validates
   both UUID/status path slots.
2. The service derives SHA-256, locks the tenant inventory, checks mutable lifecycle, and searches
   for an existing attempt by tenant + inventory + declared status + digest.
3. Any already recorded outcome is returned with its stored sanitized diagnostic, without another
   object publication or import row. Different tenant/inventory/status scopes do not coalesce.
4. A new key includes tenant, inventory, declared status, random import id, digest, and container;
   `putVerified` publishes privately and verifies byte size plus SHA-256 metadata.
5. Task 2 parsing receives the exact declared status and current tenant product GTIN. Every new
   parse outcome, including a sanitized failure or zero-row success, is inserted append-only with
   its private object reference and audit event in one database transaction.
6. If publication succeeds but the transaction fails, the service first reconciles the exact
   tenant/inventory/import/object tuple. A committed row is returned; otherwise only the newly
   published key is deleted. If reconciliation itself is unavailable, the object is preserved to
   avoid deleting potentially committed evidence.

## Audit evidence

Focused DB-backed assertions pin exact success and parser-failure events: organization/tenant,
actor, action `inventory.import.processed`, outcome, target type/id, result, declared/parsed status,
row/error/duplicate counts, digest, and sanitized error code/row where applicable. Assertions also
prove audit/API output excludes KM data, object key, filename, credentials, and secret/raw-cause
fields. The rollback test injects an audit-insert failure and proves the import transaction rolls
back and the newly published object is removed.

## Verification

- Fresh isolated PostgreSQL migrations + focused e2e/OpenAPI: **14 passed, 0 skipped**.
- Authorization/subscription-route/object-storage regressions: **47 passed, 0 skipped**.
- `@markiro/db` build (package-local TypeScript compiler): **passed** before API consumer tests.
- API typecheck: **passed**.
- API full lint: **passed**.
- API build: **passed**.
- Scoped Prettier check and `git diff --check`: **passed**.
- Existing Vite native-config compatibility warning was emitted by Vitest; it did not affect tests.
- The shared development database was not modified: its documented pre-0048 drift currently fails
  at missing `tenant_subscriptions.source_invoice_line_id`. All Task 4 DB behavior was exercised on
  fresh isolated databases instead, with no DB-backed skips.
- The repository-declared `pnpm` launcher attempted the configured Yandex registry and could not
  find `@pnpm/exe@11.22.0`; installed package-local binaries were used for the same declared scripts.
- No live MinIO/S3 provider was contacted. Object publication/verification integration remains
  covered by the existing object-storage suite; Task 4 failure ordering used its injected storage
  boundary and a real PostgreSQL rollback.

## Files

- `apps/api/src/app.module.ts`
- `apps/api/src/modules/inventories/dto.ts`
- `apps/api/src/modules/inventories/inventories.controller.ts`
- `apps/api/src/modules/inventories/inventories.module.ts`
- `apps/api/src/modules/inventories/inventories.service.ts`
- `apps/api/test/inventories.e2e.test.ts`
- `apps/api/test/inventories-openapi.test.ts`
- `apps/api/test/authorization-metadata.test.ts`
- `apps/api/test/subscription-route-inventory.test.ts`
- `.superpowers/sdd/2026-08-24-inventory-core-preparation/task-4-implementer-report.md`

## Concerns / follow-up boundary

- Line assignment in v1 can only validate tenant-scoped existence because the current `lines`
  schema has no active flag; adding such lifecycle semantics requires a separate schema decision.
- The generic private object `get` helper currently has a 5 MiB response cap while the Task 2
  import parser accepts 8 MiB compressed inputs. Task 4 does not expose evidence downloads or read
  objects back, but Task 5 snapshot fixation must select an appropriately bounded private-read path
  before relying on evidence larger than 5 MiB.
- Snapshot fixation/start and all later inventory surfaces remain deliberately unimplemented.
