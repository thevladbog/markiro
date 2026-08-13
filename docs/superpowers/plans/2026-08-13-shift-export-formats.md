# Shift Export Formats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four built-in, asynchronously generated shift-report formats with optional physical-line splitting, immutable retained artifacts, and an admin workflow for generation, status, retry, and download.

**Architecture:** A pure `@markiro/domain` registry/renderer owns exact bytes, line accounting, box-preserving splitting, and filenames. Tenant-scoped Postgres rows own request/history state and artifact metadata; a pg-boss worker reads one repeatable-read source snapshot, uploads every private object, and publishes all parts atomically. The NestJS API exposes cabinet-only orchestration/history/download routes, while the admin shift page opens a modal backed by TanStack Query polling.

**Tech Stack:** TypeScript, Zod, NestJS, Drizzle/Postgres, pg-boss, S3-compatible private storage, React/Vite, TanStack Query, `@markiro/ui`, Vitest/Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-13-shift-export-formats-design.md`

## Global Constraints

- MVP registry contains exactly `shift_txt_flat@1`, `shift_txt_boxes@1`, `shift_csv_flat@1`, and `shift_csv_boxes@1`; there is no editor, upload, tenant/counterparty assignment, or JSON transformation DSL.
- TXT is UTF-8 without BOM and uses LF; CSV is UTF-8 with BOM, semicolon delimiters, CRLF, repeated headers, and standard CSV quoting.
- Literal GS (`0x1D`) in canonical KMs must survive byte-for-byte.
- Only closed shifts may be exported; the authoritative KM is selected through `code_registry`, never an arbitrary duplicate `codes` row.
- Boxed formats fail closed unless every authoritative shift code belongs exactly once to an active membership in an active closed SSCC box.
- Optional `maxLines` is an integer from 2 through 1,000,000 and counts every physical line, including headers and empty TXT separators but excluding the BOM.
- Boxes are indivisible; a box that cannot fit in an empty part fails the export.
- All artifact counts and filename counts are per part and are derived from rendered records.
- The filename date is the shift planned date; unsafe characters become `_`, repeated underscores collapse, Cyrillic remains, and `_часть_N` appears only when there is more than one part.
- Generation is always asynchronous; every part is privately stored and no artifact metadata becomes downloadable until all parts succeed.
- Ready exports and artifacts are immutable; idempotency only collapses a retry of one create action, while a deliberate rerun creates a new export.
- Read-only subscription mode allows list, create, retry, and download; station/kiosk credentials must be denied.
- Audit metadata must never contain raw KMs, signed URLs, or object-storage credentials.

---

## File map

- `packages/domain/src/shift-exports.ts`: versioned descriptor registry, renderer/splitter, CSV encoding, filename sanitization, safe domain errors.
- `packages/domain/test/shift-exports.test.ts`: exact-byte and boundary tests for all deterministic behavior.
- `packages/db/src/schema/shift-exports.ts`: export request and artifact tables with tenant-composite keys and immutable metadata.
- `packages/db/migrations/0035_*.sql` and `packages/db/migrations/meta/0035_snapshot.json`: generated migration, reviewed and augmented only where Drizzle cannot express constraints.
- `apps/api/src/modules/storage/object-storage.service.ts`: verified private upload primitive using SHA-256 metadata plus `HeadObject` verification.
- `apps/api/src/modules/shift-exports/dto.ts`: Zod request/query response contracts and safe status/error types.
- `apps/api/src/modules/shift-exports/shift-export-source.service.ts`: one repeatable-read authoritative source snapshot and boxed coverage validation.
- `apps/api/src/modules/shift-exports/shift-export-runner.service.ts`: state transitions, rendering, uploads, cleanup, atomic artifact publication, and outcome audit.
- `apps/api/src/modules/shift-exports/shift-exports.service.ts`: create/idempotency, list, retry, download authorization, and request audit.
- `apps/api/src/modules/shift-exports/shift-exports.controller.ts`: five cabinet HTTP operations.
- `apps/api/src/modules/shift-exports/shift-exports.module.ts`: feature providers/controller.
- `apps/api/src/jobs/jobs.module.ts`: global queue gateway, shift-export queue/worker, enqueue method, and readiness worker count.
- `apps/admin/src/pages/shifts/shift-exports-api.ts`: API DTOs and TanStack Query hooks.
- `apps/admin/src/pages/shifts/ShiftExportsDialog.tsx`: format selection, split input, history polling, stale/retry/download states.
- `apps/admin/src/pages/shifts/index.tsx` and `shifts.css`: closed-row action and modal integration.
- `apps/admin/src/i18n/{ru,en}.json`: user-visible labels, statuses, errors, and counts.

---

### Task 1: Deterministic format registry, renderer, splitting, and filenames

**Files:**

- Create: `packages/domain/src/shift-exports.ts`
- Create: `packages/domain/test/shift-exports.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**

- Consumes: canonical KM strings and already deterministically ordered flat/boxed source records.
- Produces:

```ts
export type ShiftExportFormatId =
  "shift_txt_flat" | "shift_txt_boxes" | "shift_csv_flat" | "shift_csv_boxes";
export type ShiftExportBoxMode = "flat" | "boxes";
export interface ShiftExportFormatDescriptor {
  id: ShiftExportFormatId;
  version: 1;
  label: string;
  extension: "txt" | "csv";
  mimeType: "text/plain; charset=utf-8" | "text/csv; charset=utf-8";
  boxMode: ShiftExportBoxMode;
}
export type ShiftExportSource =
  | { mode: "flat"; codes: readonly string[] }
  | { mode: "boxes"; boxes: readonly { sscc: string; codes: readonly string[] }[] };
export interface RenderShiftExportInput {
  formatId: ShiftExportFormatId;
  formatVersion: 1;
  productName: string;
  shiftDate: string;
  maxLines: number | null;
  source: ShiftExportSource;
}
export interface ShiftExportPart {
  partNumber: number;
  physicalLineCount: number;
  codeCount: number;
  boxCount: number;
  filename: string;
  mimeType: ShiftExportFormatDescriptor["mimeType"];
  bytes: Uint8Array;
}
export type ShiftExportDomainErrorCode =
  | "FORMAT_NOT_FOUND"
  | "FORMAT_SOURCE_MISMATCH"
  | "EMPTY_SOURCE"
  | "INVALID_LINE_LIMIT"
  | "BOX_EXCEEDS_LINE_LIMIT";
export class ShiftExportDomainError extends Error {
  constructor(readonly code: ShiftExportDomainErrorCode) {
    super(code);
  }
}
export const SHIFT_EXPORT_FORMATS: readonly ShiftExportFormatDescriptor[];
export function getShiftExportFormat(id: string, version: number): ShiftExportFormatDescriptor;
export function renderShiftExport(input: RenderShiftExportInput): ShiftExportPart[];
export function sanitizeShiftExportFilenameSegment(value: string): string;
```

- [ ] **Step 1: Write exact-byte registry and four-format tests**

Create table-driven tests that assert the exact registry order/labels and these exact decoded bodies (plus BOM byte assertions for CSV):

```ts
expect(decode(render("shift_txt_flat", flat).bytes)).toBe("KM-1\nKM-2\n");
expect(decode(render("shift_txt_boxes", boxes).bytes)).toBe(
  "001234567890123456\nKM-1\nKM-2\n\n009876543210123456\nKM-3\n\n",
);
expect(stripBom(render("shift_csv_flat", flat).bytes)).toBe("code\r\nKM-1\r\nKM-2\r\n");
expect(stripBom(render("shift_csv_boxes", boxes).bytes)).toBe(
  "box_sscc;code\r\n001234567890123456;KM-1\r\n001234567890123456;KM-2\r\n009876543210123456;KM-3\r\n",
);
```

Also assert that `A\u001dB` retains byte `0x1d`, CSV quotes `a;b`, `a"b`, CR, and LF correctly, and TXT never receives a BOM.

- [ ] **Step 2: Run the domain test and verify RED**

Run: `pnpm --filter @markiro/domain exec vitest run test/shift-exports.test.ts`

Expected: FAIL because `../src/shift-exports.js` does not exist.

- [ ] **Step 3: Implement the registry and exact encoders**

Use a frozen literal registry and a `(id, version)` lookup. Implement `csvField` exactly as:

```ts
function csvField(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
```

Require `source.mode === descriptor.boxMode`, emit terminal line separators exactly as specified, and throw `EMPTY_SOURCE` before creating parts.

- [ ] **Step 4: Add RED tests for physical-line splitting and indivisible boxes**

Cover flat TXT at limits 2 and 3; CSV header capacity; TXT box block size `1 + codes + 1`; CSV box block size `codes` plus one header per part; next-box-to-next-part behavior; single-box overflow; and an unsplit result. Assert every `physicalLineCount`, `codeCount`, `boxCount`, and part body.

- [ ] **Step 5: Implement the splitter before encoding**

Build logical blocks first. A flat block is one code/one line. A boxed TXT block is SSCC + codes + empty separator; a boxed CSV block is the box's item records. Account for `headerLines = extension === "csv" ? 1 : 0`, reject `maxLines` outside `[2, 1_000_000]`, and start a new part only before adding a block that would exceed the limit.

- [ ] **Step 6: Add RED filename tests**

Assert:

```ts
expect(sanitizeShiftExportFilenameSegment('  Вода / "газ"  ')).toBe("Вода_газ");
expect(sanitizeShiftExportFilenameSegment("\u0000///:::***")).toBe("продукция");
expect(parts.map((part) => part.filename)).toEqual([
  "Вода_2_1_2026-08-13_часть_1.csv",
  "Вода_1_1_2026-08-13_часть_2.csv",
]);
```

Also assert no `_часть_1` for a single part and no box-count segment for flat formats.

- [ ] **Step 7: Implement filename sanitization and per-part naming**

Normalize the product to NFC, replace every run outside Unicode letters, Unicode numbers, and `-` with `_` using `/[^\p{L}\p{N}-]+/gu`, collapse `/_+/g`, trim underscores, and fall back to `продукция`. Validate `shiftDate` with `^\d{4}-\d{2}-\d{2}$`, then build the name only after the final part count is known. This allowlist replaces whitespace, controls, separators, reserved punctuation, shell punctuation, and escapable characters while preserving Cyrillic.

- [ ] **Step 8: Export the module and run package gates**

Run:

```bash
pnpm --filter @markiro/domain exec vitest run test/shift-exports.test.ts
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/domain/src/shift-exports.ts packages/domain/src/index.ts packages/domain/test/shift-exports.test.ts
git commit -m "feat(domain): add shift export renderers"
```

---

### Task 2: Tenant-scoped export and artifact persistence

**Files:**

- Create: `packages/db/src/schema/shift-exports.ts`
- Create: `packages/db/test/shift-exports-schema.test.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/drizzle.config.ts`
- Create: `packages/db/migrations/0035_*.sql`
- Create: `packages/db/migrations/meta/0035_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`

**Interfaces:**

- Consumes: `organization`, `user`, and tenant-composite `shifts` keys.
- Produces: `shiftExports`, `shiftExportArtifacts`, `shiftExportStatusEnum`, and inferred select/insert types.

Use these columns:

```ts
shiftExports: {
  id: uuid primary key defaultRandom,
  tenantId: text not null,
  shiftId: uuid not null,
  formatId: text not null,
  formatVersion: integer not null,
  maxLines: integer nullable,
  status: enum("queued", "processing", "ready", "failed"),
  errorCode: text nullable,
  productNameSnapshot: text nullable,
  shiftDateSnapshot: date nullable,
  totalCodeCount: integer nullable,
  totalBoxCount: integer nullable,
  createdByUserId: text not null,
  idempotencyKey: uuid not null,
  sourceSnapshotStartedAt: timestamptz nullable,
  completedAt: timestamptz nullable,
  attemptCount: integer not null default 0,
  createdAt: timestamptz not null defaultNow,
  updatedAt: timestamptz not null defaultNow,
}
shiftExportArtifacts: {
  id: uuid primary key defaultRandom,
  tenantId: text not null,
  exportId: uuid not null,
  partNumber: integer not null,
  physicalLineCount: integer not null,
  codeCount: integer not null,
  boxCount: integer not null,
  filename: text not null,
  mimeType: text not null,
  byteSize: bigint mode number not null,
  sha256: text not null,
  objectKey: text not null,
  createdAt: timestamptz not null defaultNow,
}
```

- [ ] **Step 1: Write the failing schema contract test**

Assert table names, all columns, `(tenant_id, id)` unique keys, composite FKs `(tenant_id, shift_id) -> shifts(tenant_id, id)` and `(tenant_id, export_id) -> shift_exports(tenant_id, id)`, unique `(tenant_id, created_by_user_id, idempotency_key)`, unique `(tenant_id, export_id, part_number)`, and indexes for tenant/shift history and queued status.

- [ ] **Step 2: Run the schema test and verify RED**

Run: `pnpm --filter @markiro/db exec vitest run test/shift-exports-schema.test.ts`

Expected: FAIL because the tables are not exported.

- [ ] **Step 3: Implement and export the Drizzle schema**

Add positive check constraints for versions/counts/part numbers/byte sizes, `max_lines between 2 and 1000000`, a 64-lowercase-hex checksum check, and state consistency:

```sql
(status = 'ready' AND completed_at IS NOT NULL AND error_code IS NULL)
OR (status = 'failed' AND completed_at IS NOT NULL AND error_code IS NOT NULL)
OR (status IN ('queued','processing') AND completed_at IS NULL AND error_code IS NULL)
```

Keep snapshot fields nullable until the worker begins, because create must be a short request that does not read/export source data.

- [ ] **Step 4: Generate and inspect migration 0035**

Run:

```bash
set -a
source .env
set +a
pnpm --filter @markiro/db db:generate
```

Expected: one new `0035_*.sql`, one snapshot, and one journal entry. Inspect the SQL for both composite FKs, all checks/indexes, and no changes outside the two new tables/enum.

- [ ] **Step 5: Run DB gates**

Run:

```bash
pnpm --filter @markiro/db exec vitest run test/shift-exports-schema.test.ts
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
```

Expected: all available tests PASS; report any database-backed skips explicitly.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/shift-exports.ts packages/db/src/schema.ts packages/db/drizzle.config.ts packages/db/test/shift-exports-schema.test.ts packages/db/migrations/0035_*.sql packages/db/migrations/meta/0035_snapshot.json packages/db/migrations/meta/_journal.json
git commit -m "feat(db): persist shift export artifacts"
```

---

### Task 3: Verified private object upload

**Files:**

- Modify: `apps/api/src/modules/storage/object-storage.service.ts`
- Modify: `apps/api/test/object-storage.test.ts`

**Interfaces:**

- Consumes: a safe `tenants/...` key, exact body bytes, MIME type, and lowercase SHA-256.
- Produces:

```ts
async putVerified(
  key: string,
  body: Buffer,
  contentType: string,
  sha256: string,
): Promise<{ byteSize: number; sha256: string }>;
async presignRead(
  key: string,
  expiresInSeconds?: number,
  options?: { downloadFilename: string },
): Promise<string>;
```

- [ ] **Step 1: Write failing verified-upload tests**

Mock `PutObjectCommand` and `HeadObjectCommand`. Assert `putVerified` stores metadata `{ sha256 }`, then rejects if `ContentLength` differs, metadata is absent, or the returned metadata checksum differs. Assert the optional `presignRead` filename becomes a safe RFC 5987 `ResponseContentDisposition: attachment; filename*=UTF-8''...` value, while existing two-argument callers retain current behavior. Retain the existing safe-prefix assertions.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @markiro/api exec vitest run test/object-storage.test.ts`

Expected: FAIL because `putVerified` is undefined.

- [ ] **Step 3: Implement upload-plus-head verification**

Validate checksum with `/^[0-9a-f]{64}$/`, upload with private bucket defaults and `Metadata: { sha256 }`, issue `HeadObjectCommand`, and compare both exact byte length and metadata checksum. Extend `presignRead` without breaking existing callers and reject CR/LF in a requested download filename before placing the RFC 5987 value on `GetObjectCommand`. Return only verified immutable facts; never log body/key credentials.

- [ ] **Step 4: Run focused and package checks**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/object-storage.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/storage/object-storage.service.ts apps/api/test/object-storage.test.ts
git commit -m "feat(api): verify private object uploads"
```

---

### Task 4: Authoritative repeatable-read shift snapshot

**Files:**

- Create: `apps/api/src/modules/shift-exports/shift-export-source.service.ts`
- Create: `apps/api/test/shift-export-source.test.ts`

**Interfaces:**

- Consumes: tenant ID, shift ID, and descriptor `boxMode`.
- Produces:

```ts
export type ShiftExportSourceErrorCode =
  "SHIFT_NOT_CLOSED" | "SHIFT_HAS_NO_CODES" | "SHIFT_DATE_MISSING" | "BOX_COVERAGE_INCOMPLETE";
export class ShiftExportSourceError extends Error {
  constructor(readonly code: ShiftExportSourceErrorCode) {
    super(code);
  }
}
export interface ShiftExportSnapshot {
  sourceSnapshotStartedAt: Date;
  productName: string;
  shiftDate: string;
  source: ShiftExportSource;
}
export class ShiftExportSourceService {
  load(
    tenantId: string,
    shiftId: string,
    boxMode: ShiftExportBoxMode,
  ): Promise<ShiftExportSnapshot>;
}
```

- [ ] **Step 1: Write failing source tests with production-shaped rows**

Cover tenant scoping; non-closed, missing-planned-date, and empty shifts; duplicate `codes` history where the `(tenant_id, code_hash, shift_id, scanned_at)` row matching `code_registry` wins; deterministic flat order `(scanned_at, code_hash)`; deterministic box/item order; and exclusion of removed/displaced/disassembled/open/no-SSCC boxes.

For every excluded/incomplete boxed case, assert `BOX_COVERAGE_INCOMPLETE`, not a shortened success.

- [ ] **Step 2: Run the source test and verify RED**

Run: `pnpm --filter @markiro/api exec vitest run test/shift-export-source.test.ts`

Expected: FAIL because `ShiftExportSourceService` does not exist.

- [ ] **Step 3: Implement one repeatable-read transaction**

Use:

```ts
return this.db.transaction(async (tx) => this.loadFromTransaction(tx, tenantId, shiftId, boxMode), {
  isolationLevel: "repeatable read",
  accessMode: "read only",
});
```

Implement the private `loadFromTransaction(tx, tenantId, shiftId, boxMode)` method in the same service. Read `transaction_timestamp()` as `sourceSnapshotStartedAt`. Join `codeRegistry` to `codes` on tenant, hash, shift, and scanned time. For boxed mode, build eligible memberships from active `boxes`/`boxItems`, require every authoritative hash exactly once, reject extra/missing/duplicate membership, then map canonical raw values from the authoritative flat map. Snapshot `product.name` with fallback `Продукция`; require a planned date and serialize `YYYY-MM-DD` without timezone conversion.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/shift-export-source.test.ts
pnpm --filter @markiro/api typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shift-exports/shift-export-source.service.ts apps/api/test/shift-export-source.test.ts
git commit -m "feat(api): load authoritative shift export snapshots"
```

---

### Task 5: Atomic generation runner and cleanup

**Files:**

- Create: `apps/api/src/modules/shift-exports/shift-export-runner.service.ts`
- Create: `apps/api/test/shift-export-runner.test.ts`

**Interfaces:**

- Consumes: persisted export ID, Task 4 source loader, Task 1 renderer, Task 3 storage.
- Produces:

```ts
export const SHIFT_EXPORT_SAFE_ERROR_CODES = [
  "SHIFT_NOT_CLOSED",
  "SHIFT_HAS_NO_CODES",
  "SHIFT_DATE_MISSING",
  "BOX_COVERAGE_INCOMPLETE",
  "FORMAT_NOT_FOUND",
  "INVALID_LINE_LIMIT",
  "BOX_EXCEEDS_LINE_LIMIT",
  "GENERATION_FAILED",
  "STORAGE_FAILED",
  "QUEUE_FAILED",
] as const;
export class ShiftExportRunnerService {
  run(exportId: string, attempt: { retryCount: number; retryLimit: number }): Promise<void>;
}
```

- [ ] **Step 1: Write failing runner tests**

Assert: tenant-scoped row claim changes `queued -> processing` and increments attempts; a ready/processing row is ignored; renderer inputs use persisted format/version/limit; each object key is `tenants/<tenant>/shift-exports/<export>/attempt-<n>/part-<n>.<ext>`; SHA-256 is computed over exact bytes; all artifact inserts and `ready` transition occur in one transaction; aggregate counts are sums of parts; and the completion audit contains no KM or signed URL.

- [ ] **Step 2: Add partial-failure and retryability tests**

Make the second `putVerified` reject after the first succeeds. Assert no artifact row is published and the first key is deleted best-effort. On a non-final attempt (`retryCount < retryLimit`), assert status returns to `queued`, no error/completion is published, and the infrastructure error is rethrown for pg-boss. On the final attempt, assert status becomes `failed` with `STORAGE_FAILED`. Make a database publication failure follow the same rule with `GENERATION_FAILED`. Assert domain/source errors become final bounded failures immediately without leaking messages or consuming pointless queue retries.

- [ ] **Step 3: Run the runner test and verify RED**

Run: `pnpm --filter @markiro/api exec vitest run test/shift-export-runner.test.ts`

Expected: FAIL because the runner does not exist.

- [ ] **Step 4: Implement claim, generate, verify, and atomic publish**

Claim with a conditional update on `status = 'queued'`. Store Task 4's snapshot instant/product/date on the export before rendering. Hash each `Buffer.from(part.bytes)` with `createHash("sha256")`. Keep uploaded keys in memory; after every verified upload, publish all child rows and `ready`/counts/completion audit inside one tenant-scoped transaction. On failure, run `Promise.allSettled(uploadedKeys.map(delete))`. A safe source/domain error writes `failed`, completion time, bounded code, and failure audit and returns. An infrastructure error on a non-final pg-boss attempt writes `queued` with no public error/completion and rethrows; on the final attempt it writes `failed`, a bounded infrastructure code, completion time, and failure audit before rethrowing. The explicit retry endpoint is the only transition from a user-visible `failed` row back to `queued`.

- [ ] **Step 5: Run runner and API checks**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/shift-export-runner.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shift-exports/shift-export-runner.service.ts apps/api/test/shift-export-runner.test.ts
git commit -m "feat(api): generate shift exports atomically"
```

---

### Task 6: pg-boss shift-export queue and readiness

**Files:**

- Modify: `apps/api/src/jobs/jobs.module.ts`
- Modify: `apps/api/test/jobs-readiness.test.ts`
- Create: `apps/api/test/jobs-shift-exports.test.ts`

**Interfaces:**

- Consumes: `ShiftExportRunnerService.run(exportId, { retryCount, retryLimit })`.
- Produces:

```ts
export const BUILD_SHIFT_EXPORT_QUEUE = "build-shift-export";
export class PgBossService {
  enqueueShiftExport(exportId: string): Promise<string>;
}
```

- [ ] **Step 1: Write failing queue registration/enqueue tests**

Assert queue options `retryLimit: 5`, `retryDelay: 30`, `retryBackoff: true`, `retryDelayMax: 900`, `expireInSeconds: 900`; worker uses `{ includeMetadata: true }` and passes each job's `exportId`, `retryCount`, and `retryLimit` to the runner; `enqueueShiftExport` uses the queue and returns the job ID; a missing send ID throws `shift export enqueue failed`.

- [ ] **Step 2: Update readiness RED expectations**

Change fixtures/assertions from exactly 10 to exactly 11 active unique worker IDs and assert the export worker is included.

- [ ] **Step 3: Run job tests and verify RED**

Run: `pnpm --filter @markiro/api exec vitest run test/jobs-readiness.test.ts test/jobs-shift-exports.test.ts`

Expected: FAIL because the queue and constructor dependency are absent.

- [ ] **Step 4: Register the worker and expose the queue gateway**

Mark `JobsModule` `@Global()` so the single root `forRoot` instance can provide `PgBossService` to the sibling feature module. Register `ShiftExportSourceService` and `ShiftExportRunnerService` as JobsModule providers, inject the runner into `PgBossService`, create/work the queue during bootstrap, push its worker ID, and update readiness to 11. Do not schedule it; jobs are request-driven.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/jobs-readiness.test.ts test/jobs-shift-exports.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/jobs.module.ts apps/api/test/jobs-readiness.test.ts apps/api/test/jobs-shift-exports.test.ts
git commit -m "feat(api): queue shift export generation"
```

---

### Task 7: Cabinet export API, idempotency, history, retry, and download

**Files:**

- Create: `apps/api/src/modules/shift-exports/dto.ts`
- Create: `apps/api/src/modules/shift-exports/shift-exports.service.ts`
- Create: `apps/api/src/modules/shift-exports/shift-exports.controller.ts`
- Create: `apps/api/src/modules/shift-exports/shift-exports.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/shift-exports.e2e.test.ts`
- Create: `apps/api/test/shift-exports-openapi.test.ts`

**Interfaces:**

- Consumes: Task 1 descriptor registry, Task 2 tables, `PgBossService.enqueueShiftExport`, `ObjectStorageService.presignRead`.
- Produces five routes from spec section 9 and these JSON shapes:

```ts
createShiftExportSchema = z.object({
  formatId: z.enum(["shift_txt_flat", "shift_txt_boxes", "shift_csv_flat", "shift_csv_boxes"]),
  formatVersion: z.literal(1),
  maxLines: z.number().int().min(2).max(1_000_000).nullable(),
  idempotencyKey: z.string().uuid(),
});
type ShiftExportDto = {
  id: string;
  shiftId: string;
  formatId: ShiftExportFormatId;
  formatVersion: 1;
  maxLines: number | null;
  status: "queued" | "processing" | "ready" | "failed";
  errorCode: string | null;
  productNameSnapshot: string | null;
  shiftDateSnapshot: string | null;
  totalCodeCount: number | null;
  totalBoxCount: number | null;
  createdByUserId: string;
  createdByName: string | null;
  sourceSnapshotStartedAt: string | null;
  completedAt: string | null;
  attemptCount: number;
  createdAt: string;
  stale: boolean;
  artifacts: ShiftExportArtifactDto[];
};
type ShiftExportArtifactDto = {
  id: string;
  partNumber: number;
  physicalLineCount: number;
  codeCount: number;
  boxCount: number;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
};
type ShiftExportDownloadDto = { url: string; filename: string; expiresInSeconds: 300 };
```

- [ ] **Step 1: Write failing format/create authorization tests**

Assert formats return the exact server registry; create requires cabinet `OPERATIONS_READ`; station API keys receive 403; subscription read-only is allowed; an open shift or cross-tenant shift is denied; invalid version/limit is 400; and two requests by the same tenant/user/idempotency key return the same row while two distinct keys create two rows/jobs.

- [ ] **Step 2: Write failing history/retry/download tests**

Assert list is tenant/shift scoped and newest first; `stale` is `shift.lateDataAt > sourceSnapshotStartedAt`; failed retry atomically sets `queued`, clears error/completion, and enqueues; ready/non-failed/cross-tenant retry is denied; only ready, tenant-owned artifacts can be signed; presign duration is exactly 300 seconds and passes the persisted filename as response content disposition; response filename comes from DB; audit rows include actor/format/parameters/outcome but no object key or URL.

- [ ] **Step 3: Write and run the OpenAPI RED contract**

Generate a Swagger document from the test Nest app and assert all five paths, request required fields/ranges/enums, response statuses, descriptor/status/artifact fields, and that object keys are absent from public schemas.

Run: `pnpm --filter @markiro/api exec vitest run test/shift-exports-openapi.test.ts`

Expected: FAIL because the controller and explicit Swagger schemas do not exist.

- [ ] **Step 4: Run e2e and verify RED**

Run: `pnpm --filter @markiro/api exec vitest run test/shift-exports.e2e.test.ts`

Expected: FAIL with missing routes/module.

- [ ] **Step 5: Implement DTOs, service, controller, module, and OpenAPI schemas**

Decorate the controller with `TenantGuard`, `AuthorizationGuard`, `SubscriptionAccessGuard`, `@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)`, and `@AllowSubscriptionReadOnly("read")`; never use `AllowStationOrPermissions`. Add explicit `@ApiBody`, `@ApiOkResponse`, and `@ApiCreatedResponse` JSON schemas so Swagger matches the Zod/runtime contract. Create the queued row and `shift_export.created` audit transactionally, catch only the unique idempotency constraint to return the existing row, then enqueue. If enqueue fails, mark that row failed with `QUEUE_FAILED`, completion timestamp, and failure audit before returning 503. When a repeated idempotent create finds that exact failed `QUEUE_FAILED` row, conditionally restore it to `queued` and try enqueueing again instead of creating a second row. Register `ShiftExportsModule` in `AppModule`.

- [ ] **Step 6: Implement list/retry/download details**

Join creator name from `user`/`userProfiles`; do not return object keys. Retry uses a conditional `failed -> queued` update, increments only in the worker, writes `shift_export.retried`, then enqueues. Download re-reads tenant/export/artifact ready state before `presignRead(objectKey, 300, { downloadFilename: artifact.filename })` and writes `shift_export.downloaded` without persisting URL.

- [ ] **Step 7: Run API gates**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/shift-exports.e2e.test.ts test/shift-exports-openapi.test.ts test/shift-export-source.test.ts test/shift-export-runner.test.ts test/jobs-shift-exports.test.ts test/jobs-readiness.test.ts test/object-storage.test.ts
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

Expected: all available tests PASS; report DB/object-storage skips separately.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/shift-exports apps/api/src/app.module.ts apps/api/test/shift-exports.e2e.test.ts apps/api/test/shift-exports-openapi.test.ts
git commit -m "feat(api): expose retained shift exports"
```

---

### Task 8: Admin API hooks and polling model

**Files:**

- Create: `apps/admin/src/pages/shifts/shift-exports-api.ts`
- Create: `apps/admin/test/shift-exports-api.test.tsx`

**Interfaces:**

- Consumes: Task 7 HTTP DTOs.
- Produces:

```ts
export const SHIFT_EXPORT_FORMATS_QUERY_KEY = ["shift-export-formats"] as const;
export const shiftExportsQueryKey = (shiftId: string) => ["shift-exports", shiftId] as const;
export function useShiftExportFormats(): UseQueryResult<ShiftExportFormatDescriptor[]>;
export function useShiftExports(
  shiftId: string,
  enabled: boolean,
): UseQueryResult<ShiftExportDto[]>;
export function useCreateShiftExport(): UseMutationResult<
  ShiftExportDto,
  Error,
  { shiftId: string; input: CreateShiftExportInput }
>;
export function useRetryShiftExport(): UseMutationResult<
  ShiftExportDto,
  Error,
  { shiftId: string; exportId: string }
>;
export function downloadShiftExportArtifact(
  exportId: string,
  artifactId: string,
): Promise<ShiftExportDownloadDto>;
```

- [ ] **Step 1: Write failing hook tests**

Assert exact paths/bodies, UUID idempotency supplied by the caller, cache invalidation after create/retry, list disabled while the dialog is closed, and `refetchInterval` of 2 seconds only while any item is `queued` or `processing`.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/shift-exports-api.test.tsx`

Expected: FAIL because the API module is missing.

- [ ] **Step 3: Implement typed fetchers and hooks**

Use the existing `apiFetch` wrapper and TanStack Query patterns from `pages/shifts/api.ts`. Keep object keys absent from client types. Create/retry invalidates only the active shift's history key.

- [ ] **Step 4: Run focused test and typecheck**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/shift-exports-api.test.tsx
pnpm --filter @markiro/admin typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/shifts/shift-exports-api.ts apps/admin/test/shift-exports-api.test.tsx
git commit -m "feat(admin): add shift export data hooks"
```

---

### Task 9: Closed-shift report dialog and retained history

**Files:**

- Create: `apps/admin/src/pages/shifts/ShiftExportsDialog.tsx`
- Modify: `apps/admin/src/pages/shifts/index.tsx`
- Modify: `apps/admin/src/pages/shifts/shifts.css`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/admin/test/shift-exports-dialog.test.tsx`
- Modify: `apps/admin/test/shifts.test.tsx`

**Interfaces:**

- Consumes: Task 8 hooks and `ShiftDto` for a closed shift.
- Produces:

```ts
export interface ShiftExportsDialogProps {
  shift: ShiftDto;
  open: boolean;
  onClose: () => void;
}
```

- [ ] **Step 1: Write failing selection and validation tests**

Assert a closed row shows `Сформировать отчет` even for an operations-read user without operations-write; planned/active rows do not. Opening shows the four exact server labels. Split is off initially; enabling it shows required numeric input defaulted to `2000`; values below 2, above 1,000,000, or non-integers disable submit with a localized error.

- [ ] **Step 2: Write failing history-state tests**

Assert queued/processing/ready/failed chips; actor/time/format/parameters/counts; ready parts with line/code/box/byte counts; no box count for flat formats; failed safe reason plus `Повторить`; stale warning text `Данные смены изменились — сформируйте новую`; and each part has its own download button using the server filename.

- [ ] **Step 3: Run component tests and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/shift-exports-dialog.test.tsx test/shifts.test.tsx`

Expected: FAIL because the dialog/action do not exist.

- [ ] **Step 4: Implement the modal creation form**

Use `Modal`, semantic radio inputs for descriptors, `Checkbox`, `Input`, `Button`, `Alert`, and visible focus styles from `@markiro/ui`. Generate one `crypto.randomUUID()` when the user begins a submission and retain it across the same mutation's network retry; clear it only after success or an explicit new click. Disable close/submit while pending and announce API errors in an alert.

- [ ] **Step 5: Implement retained history and downloads**

Fetch history only while open. Render exports newest first and artifact parts by `partNumber`. For download, request the signed URL, create an `<a href={url} download={filename}>`, click it, then remove it; do not reconstruct filenames. Map each bounded error code to localized safe copy and use a generic infrastructure message for unknown codes.

- [ ] **Step 6: Integrate the closed-row action and styles/i18n**

Keep edit/delete/close actions behind `OPERATIONS_WRITE`, but render the report action for closed rows on this already operations-read-protected page. Add compact responsive history rows without introducing horizontal page overflow. Add complete Russian and English strings for form, statuses, counts, stale warning, retry, download, validation, and all safe codes.

- [ ] **Step 7: Run admin gates**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/shift-exports-dialog.test.tsx test/shifts.test.tsx test/shift-exports-api.test.tsx
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/admin/src/pages/shifts/ShiftExportsDialog.tsx apps/admin/src/pages/shifts/index.tsx apps/admin/src/pages/shifts/shifts.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/shift-exports-dialog.test.tsx apps/admin/test/shifts.test.tsx
git commit -m "feat(admin): add retained shift report workflow"
```

---

### Task 10: Cross-package verification and browser acceptance

**Files:**

- Modify only if a verified contract gap is found: `docs/architecture.md`

**Interfaces:**

- Consumes: completed Tasks 1–9.
- Produces: evidence that the approved specification works across domain, DB, API, storage, queue, and admin boundaries.

- [ ] **Step 1: Rebuild workspace dependencies before consumer tests**

Run:

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/db build
pnpm --filter @markiro/ui build
```

Expected: PASS.

- [ ] **Step 2: Run focused cross-package regression suite**

Run:

```bash
pnpm --filter @markiro/domain exec vitest run test/shift-exports.test.ts
pnpm --filter @markiro/db exec vitest run test/shift-exports-schema.test.ts
pnpm --filter @markiro/api exec vitest run test/shift-export-source.test.ts test/shift-export-runner.test.ts test/shift-exports.e2e.test.ts test/shift-exports-openapi.test.ts test/jobs-shift-exports.test.ts test/jobs-readiness.test.ts test/object-storage.test.ts
pnpm --filter @markiro/admin exec vitest run test/shift-exports-api.test.tsx test/shift-exports-dialog.test.tsx test/shifts.test.tsx
```

Expected: PASS with no unexpected skips.

- [ ] **Step 3: Run repository-level quality gates**

Run:

```bash
pnpm turbo lint typecheck test build --concurrency=1 --force
pnpm format:check
git diff --check
git status --short
```

Expected: PASS; only intentional task files changed. Report environment-driven skips and do not call them verified.

- [ ] **Step 4: Perform local browser acceptance**

With development Postgres, pg-boss, MinIO, API, and admin running, close a representative aggregation shift with at least two boxes and more than one split part. Generate all four formats, verify queued-to-ready history polling, download every part, confirm exact server filenames and visible per-part counts, then add legitimate late offline data and confirm the old row becomes stale but remains downloadable. Repeat one failed boxed export after fixing coverage.

- [ ] **Step 5: Verify downloaded bytes independently**

Use `xxd -g 1` (or an equivalent binary viewer) to confirm CSV begins `ef bb bf`, TXT does not, literal GS appears as `1d`, CSV uses `0d 0a`, TXT uses `0a`, and every part's physical line count matches the UI/API metadata. This byte check is authoritative over editor rendering.

- [ ] **Step 6: Update architecture documentation if the implemented invariant is absent**

Add a concise `docs/architecture.md` section stating that shift exports are versioned code-owned adapters, generated asynchronously from an authoritative repeatable-read snapshot, privately retained as immutable artifacts, and published atomically. Do not document uploaded/custom templates as implemented.

- [ ] **Step 7: Commit verification documentation if changed**

```bash
git add docs/architecture.md
git commit -m "docs: record shift export architecture"
```

Skip this commit when Step 6 finds the invariant already documented adequately.
