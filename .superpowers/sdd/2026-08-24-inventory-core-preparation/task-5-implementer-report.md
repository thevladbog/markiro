# Task 5 implementer report — immutable inventory snapshot fixation

## Outcome

Implemented only `POST /inventories/:id/snapshots`. The strict request selects one distinct UUID
for each of the six exact `INVENTORY_CHZ_STATUSES`; the response contains the immutable snapshot
summary and exact selected inputs, without filenames, object metadata, or code values. Fixation
re-reads and re-parses the selected private originals, materializes the snapshot transactionally,
and publishes `activeSnapshotId` plus lifecycle `ready` only after all links and code rows exist.
No start/execution, document, station, external CHZ, or UI surface was added.

## RED / GREEN evidence

- Object-read RED: the established default 5 MiB boundary rejected an exact 8 MiB private object
  (**1 failed / 18 passed**). GREEN uses an explicit per-call bounded maximum while retaining the
  5 MiB default; the object-storage file then passed **19/19**.
- Initial snapshot RED used a freshly named PostgreSQL database with the complete migration journal:
  all **14/14** snapshot scenarios failed at the missing route (404). The digest test also failed on
  the missing implementation module, and authorization metadata failed on the missing controller
  method.
- The first implementation run found two real issues rather than weakening assertions: the schema
  constraint did not permit protected `INTRODUCED + MOVING_BY_UD` without a production date, and a
  wrong-inventory fixture accidentally collided on a tenant GTIN unique key. The source-of-truth
  rule was corrected in new migration 0068; the fixture now creates the second inventory from the
  same tenant product/line.
- Failure-sanitization RED was **13 passed / 1 failed**: an injected second-chunk database failure
  returned Nest's generic body and logged Drizzle SQL parameters containing a fixture KM. GREEN
  maps only unexpected failures to `INVENTORY_SNAPSHOT_FIXATION_FAILED`; captured Logger and HTTP
  assertions prove the fixture KM, `params:`, and exact object key are absent. Expected 4xx/409/503
  error contracts remain unchanged. The complete snapshot file passed **14/14**.
- Full DB GREEN initially exposed six older migration fixtures that excluded 0066/0067 but not the
  new dependent 0068. After adding the same explicit exclusion for 0068, the full package passed
  **190/190**.

## Selection, evidence, and classification

- The DTO is strict at both levels: missing/extra statuses, malformed UUIDs, and one UUID reused in
  two slots are rejected before service work. The service tenant-locks the inventory first and then
  resolves all six imports in one tenant + inventory query.
- Every selected row must match its requested status and have successful, complete stored parse
  facts. An older successful attempt may be selected even when a newer attempt failed. Cross-tenant,
  wrong-inventory, wrong-status, failed, or incomplete evidence is rejected.
- The deterministic private key is independently reconstructed. The original is read with an
  explicit 8 MiB bound, then byte size and SHA-256 are checked before Task 2 parsing is rerun using
  the selected status and the inventory's current GTIN snapshot. Parsed status, included GTIN, row
  count, duplicate count, and digest must equal durable evidence.
- All six zero-row successes are valid. Within-file and cross-import canonical hash duplicates,
  invalid KM/GTIN/parent/date data, changed facts, missing/corrupt objects, and unprotected
  `INTRODUCED` rows without a production date fail fixation without deleting source evidence.
- Task 1 classification runs after parsing. `MOVING_BY_UD` protection takes precedence, including
  protected `INTRODUCED` rows with no date; they are protected and never expected. Unprotected
  introduced dates use inclusive inventory endpoints.

## Transaction, rows, counts, digest, and idempotency

1. One transaction locks the tenant inventory, validates six selected imports, re-reads/re-parses
   all originals, and derives canonical rows plus counts.
2. A revision-1 snapshot and six status/input links are inserted, followed by canonical code rows
   in bounded chunks of 250. Each row preserves canonical raw KM/GS bytes, SHA-256 code hash, GTIN,
   serial, source facts, optional parent, and Task 1 expected/protected classification.
3. Per-status counts are exact parsed row totals. `protected` and `expected` count classified rows;
   `packages` counts distinct non-null parent SSCC memberships and `loose` counts rows without a
   parent. The 48-parent/288-member case is pinned.
4. The combined digest is SHA-256 of UTF-8 canonical JSON
   `{version:1,inputs:[{status,importId,sha256,byteSize,containerKind},...]}` with fixed key order
   and `INVENTORY_CHZ_STATUSES` array order. A literal digest vector pins determinism.
5. Only after all rows and links exist is the inventory updated to `ready` with its active pointer.
   Any chunk failure rolls back snapshot, links, codes, and pointer while preserving all six source
   objects. Later uploads cannot change an active snapshot.
6. The inventory row lock serializes fixation. A concurrent or repeated identical selection returns
   the stored snapshot; a different set conflicts. Database unique constraints remain the final
   guard and their race is normalized to the same stable conflict.

## Audit and security boundary

- Success and failure use action `inventory.snapshot.fixed`, target type/id `inventory`/inventory
  ID, exact tenant and actor, outcome, ordered selected inputs, and either snapshot digest/counts or
  a stable sanitized error code. Success is in the materialization transaction; failure is written
  durably after rollback.
- Audit assertions pin exact payloads and exclude raw KM, filenames, object keys, credentials, and
  causes. Unexpected persistence errors are never attached to an `HttpException`, Logger, or audit.
  If failure-audit persistence itself fails, its log contains only tenant and inventory IDs.

## Schema correction and migration proof

- Migration `0068_inventory_protected_date_precedence.sql` drops and recreates only the snapshot
  classification check. Migrations 0066/0067 were not edited. The Drizzle schema, static contract,
  DB behavior test, generated snapshot/journal, legacy migration fixtures, and architecture spec
  now agree that only unprotected `INTRODUCED` rows require a production date.
- A repeat `db:generate` reported **No schema changes**. A separate fresh database established the
  0067 check, applied the exact 0068 SQL inside a transaction, verified protected precedence, rolled
  back, and verified restoration of the 0067 definition. The temporary database was then dropped.

## Verification

- Fresh isolated PostgreSQL full migrations + snapshot/inventory/parser/OpenAPI/object-storage/
  authorization/subscription focused files: **122 passed, 0 skipped**.
- Full `@markiro/db` suite on the same isolated base: **190 passed, 0 skipped**.
- `@markiro/db` build, typecheck, and lint: **passed**.
- `@markiro/api` typecheck, lint, and build: **passed**.
- Migration generation parity and explicit transactional rollback validation: **passed**.
- Scoped Prettier check and `git diff --check`: **passed**.
- Vitest emitted the pre-existing Vite native-config compatibility warning. Expected injected
  failure logs from the pre-existing inventory upload rollback tests were visible; the new snapshot
  failure path was captured and proven sanitized. No final test skipped.
- No live S3/MinIO or cloud service was contacted. The real bounded object-storage boundary is unit
  tested; snapshot E2E injects that established provider boundary and uses real PostgreSQL. Shared
  development database state was not changed; all explicitly named Task 5 databases were dropped.

## Files

- Snapshot/API: `inventory-snapshot.service.ts`, inventory DTO/controller/module/service, and
  snapshot digest/E2E, OpenAPI, authorization, subscription-route tests.
- Object read: `object-storage.service.ts` and `object-storage.test.ts`.
- Database: inventory schema/test; migration 0068 SQL, journal, generated snapshot; six legacy
  migration fixtures updated to exclude dependent Task 5 migrations from their historical slices.
- Source of truth: `docs/superpowers/specs/2026-08-24-inventory-v1-architecture.md` (committed in
  full as required for this feature branch).
- This report: `.superpowers/sdd/2026-08-24-inventory-core-preparation/task-5-implementer-report.md`.

## Concerns / external boundary

- No live object-store provider was exercised, so cloud credentials, network behavior, and provider
  error shapes remain external validation. The service intentionally relies on the existing private
  storage abstraction and its bounded body tests.
- The response and durable snapshot are immutable by this route; downstream start/execution and
  document behavior remain outside Task 5.
