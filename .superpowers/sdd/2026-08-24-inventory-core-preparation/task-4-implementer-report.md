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

## Review fix round 1

### Outcome and RED / GREEN evidence

- Added focused regressions before production changes. Parser RED was **1 failed / 39** because a
  status mismatch discarded already decoded filter facts. Fresh isolated-DB RED was **10 failed /
  33** across inventory e2e, OpenAPI, and label-template e2e for the missing template projection,
  partial audit facts, filename-before-idempotency ordering, multipart limits, and deterministic
  evidence-key behavior.
- Parser GREEN is **39/39**. A first DB-backed GREEN attempt exposed a real Busboy boundary detail:
  `parts: 1` emits `partsLimit` for the closing boundary of a valid one-file request. The final
  bounded configuration uses `files: 1`, `fields: 0`, `fieldSize: 0`, and `parts: 2`; focused
  one-file, extra-field, extra-file, and oversized-file cases then passed.
- A newly created temporary PostgreSQL database applied the complete migration journal and the
  final inventory e2e, inventory OpenAPI, and label-template e2e suite passed **33/33**. Cleanup was
  registered only after successful creation and the explicitly named temporary database was
  dropped after the run. The shared drifted development database was not changed.

### Parser, API, and template behavior

- `ChzImportError` now carries typed optional `parsedStatus` and `includedGtin14` facts only after
  the complete filter was decoded. Later status/GTIN/header/row failures retain those sanitized
  facts in the durable import and exact audit metadata; failures before filter decoding retain
  `null`. The public error remains code plus optional row and contains no raw value or cause.
- List/detail/create/update now return `boxLabelTemplate: { id, name } | null` from a composite
  tenant join. Check mode returns `null`; repack returns the referenced tenant template. OpenAPI
  pins the exact child shape.
- Deleting a template referenced by `inventories_tenant_box_label_template_fk` now translates to
  the established 409 conflict and the DB-backed test pins the updated exact message. Product and
  line services were not touched, so their conflict copy was left outside this review fix.

### Publication, idempotency, cleanup, and audit ordering

1. SHA-256 is computed first; the tenant-scoped inventory is locked and the existing attempt is
   looked up by tenant + inventory + declared status + digest before filename classification.
2. Therefore a retry of any recorded success or failure returns the same sanitized attempt even if
   its retry filename is unsupported, without a second object publication, import, or audit.
3. An unsupported filename with no prior scoped digest is an intentional 415 pre-publication
   boundary. It is not persisted or audited because `inventory_import_container` deliberately
   represents only CSV, ZIP, and XLSX; no `unknown` schema value or migration was added.
4. New supported evidence uses the deterministic private key
   `tenants/{tenant}/inventories/{inventory}/imports/{status}/{sha256}.{container}`. This supersedes
   the random-import-id key described earlier in this report. Every segment is server-derived or a
   validated enum/digest/container value.
5. A proven rollback removes that new key. A committed transaction is reconciled to its exact
   tenant/inventory/import/object tuple and returned without deletion; reconciliation-read failure
   preserves possibly committed evidence. The injected commit-then-acknowledgement-error test pins
   the deterministic key, no deletion, and retry without a second publication or orphan.
- Exact repeated parser-failure assertions pin identical 422 response, one import, one audit, and
  one publication. Success/failure audits include exact actor, tenant, action, target, outcome,
  declared/parsed status, included GTIN, counts, and digest, while excluding filename, object key,
  KM values, credentials, and raw causes.

### Final verification and files

- `@markiro/db` package-local build: **passed** before consumer tests.
- Parser, authorization metadata/guard/service, subscription-route inventory, and object-storage
  regressions: **95 passed, 0 skipped**.
- Fresh isolated-DB inventory e2e/OpenAPI/label-template regressions: **33 passed, 0 skipped**.
- API typecheck, full lint, and build: **passed**.
- Scoped Prettier and `git diff --check`: **passed**.
- Vite emitted the existing native-config compatibility warning. A setup-only test invocation
  without two required local URL variables failed before assertions; the corrected final command
  supplied the development values and passed. A sandboxed localhost attempt was denied before DB
  creation; the approved isolated run above then passed and cleaned up safely. These are not
  product-test skips.
- Review-fix files: inventory parser/error boundary, DTO/OpenAPI/controller/service, label-template
  conflict translation, and their four focused test files. No DB schema/migration, snapshot/start,
  UI, station, CHZ external API, scan/execution, or document surface was added.

### Remaining concerns

- The pre-existing line schema still has no active flag, and the private object `get` helper still
  has the previously reported 5 MiB cap versus the parser's 8 MiB compressed limit. Neither
  concern is broadened or changed by this review fix.
