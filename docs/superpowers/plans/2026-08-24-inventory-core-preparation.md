# Inventory Core and Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the isolated inventory aggregate, parse the supplied Chestny ZNAK file shapes, fix an immutable single-product snapshot, and expose tenant-safe preparation and start APIs.

**Architecture:** Inventory uses its own status policy, append-only upload evidence, immutable snapshot rows, and lifecycle. It reuses GS1 parsing and tenant authorization but never writes normal production scan or box tables.

**Tech Stack:** Node 24+, TypeScript, NestJS, Zod, Drizzle ORM, PostgreSQL, Vitest, `fast-xml-parser`, `fflate`, `@markiro/domain`, private object storage.

**Spec:** `docs/superpowers/specs/2026-08-24-inventory-v1-architecture.md`

## Global Constraints

- Preserve raw KM bytes and GS separators through canonicalization; never log raw codes.
- Every query and write is tenant-scoped, including idempotency lookups and child rows.
- `MOVING_BY_UD` is protected at the domain layer and again when materializing results.
- All six statuses require a successful import result; zero-row results are valid.
- File slot, filter status, row status, and selected product GTIN must agree.
- Started inventories and snapshots are immutable.
- Uploaded originals are private, checksummed evidence; failed publication is cleaned up.
- Do not add the feature to admin navigation or station task discovery in this plan.

---

### Task 1: Inventory status and snapshot policy in the domain package

**Files:**

- Create: `packages/domain/src/inventory/status.ts`
- Create: `packages/domain/src/inventory/snapshot.ts`
- Create: `packages/domain/src/inventory/index.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/inventory-status.test.ts`
- Test: `packages/domain/test/inventory-snapshot.test.ts`

**Interfaces:**

- Produces `INVENTORY_CHZ_STATUSES`, `InventoryChzStatus`, `InventoryCodeState`,
  `classifyInventorySnapshotRow`, `canDisposeChzCode`, and
  `InventorySnapshotClassification`.
- Consumes normalized GTIN14, source status/state, source production date, and an inclusive
  date range; it performs no I/O.

- [ ] **Step 1: Write failing status-policy tests**

Cover all six statuses, inclusive boundaries, missing dates, and protection precedence:

```ts
expect(classifyInventorySnapshotRow(introducedOn("2025-09-01"), period)).toMatchObject({
  expected: true,
  protected: false,
});
expect(
  classifyInventorySnapshotRow(introducedOn("2025-09-01", { state: "MOVING_BY_UD" }), period),
).toMatchObject({ expected: false, protected: true });
expect(canDisposeChzCode({ status: "APPLIED", state: null })).toBe(false);
expect(canDisposeChzCode({ status: "INTRODUCED", state: "MOVING_BY_UD" })).toBe(false);
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @markiro/domain exec vitest run test/inventory-status.test.ts test/inventory-snapshot.test.ts
```

- [ ] **Step 3: Implement the pure policy**

Use discriminated results for `expected`, `protected`, `known_ineligible`, and
`invalid_missing_production_date`. Do not make `MOVING_BY_UD` another status; it is the source
state column and overrides status eligibility.

- [ ] **Step 4: Export the public contract and verify**

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
```

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/inventory packages/domain/src/index.ts packages/domain/test/inventory-*.test.ts
git commit -m "feat(domain): define inventory snapshot policy"
```

---

### Task 2: Safe Chestny ZNAK CSV, ZIP, and XLSX reader

**Files:**

- Create: `apps/api/src/modules/inventories/chz-filter.ts`
- Create: `apps/api/src/modules/inventories/chz-tabular-reader.ts`
- Create: `apps/api/src/modules/inventories/chz-import-parser.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/api/test/fixtures/inventory/chz-introduced.csv`
- Create: `apps/api/test/fixtures/inventory/chz-empty-applied.csv`
- Create: `apps/api/test/inventory-chz-import.test.ts`

**Interfaces:**

- Consumes `{ filename, mimeType, bytes, expectedStatus, expectedGtin14 }`.
- Produces `{ filter, rows, emptyResult, diagnostics, sha256 }`; data rows carry canonical KM,
  hash, GTIN14, serial, parent SSCC, status/state, and source production date.
- ZIP accepts exactly one non-directory CSV member. XLSX reads the first visible worksheet and
  rejects unsupported formula-only cells.

- [ ] **Step 1: Add synthetic fixtures and failing container tests**

Use valid synthetic KMs from existing domain test builders. Cover:

- the physical filter row before the header;
- comma quoting and crypto-tail punctuation;
- UTF-8 BOM and CRLF/LF;
- ZIP path traversal, multiple members, compression expansion limit, and encrypted archives;
- XLSX shared-string and inline-string cells;
- the approved zero-row `errors` marker;
- wrong slot/filter/status/GTIN and inconsistent row widths.

- [ ] **Step 2: Add the exact ZIP dependency and verify RED**

Add `fflate` at the repository-approved exact version already used by
`@markiro/legal-documents`; keep the existing exact `fast-xml-parser` dependency for OOXML.

```bash
pnpm install --lockfile-only
pnpm --filter @markiro/api exec vitest run test/inventory-chz-import.test.ts
```

- [ ] **Step 3: Implement bounded decoding**

Set explicit compressed, uncompressed, worksheet, row, cell, and KM-byte limits. Parse the
filter independently from CSV rows. A no-results marker is success only for the expected status.
Return stable error codes and row numbers without echoing raw codes.

- [ ] **Step 4: Reconcile against the supplied shape without committing customer data**

Run a local read-only diagnostic against the user-provided examples, then keep only synthetic
fixtures in Git. Assert the known counts 4,323/207/4,116 in a local report, not in a production
test fixture tied to a customer export.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @markiro/api exec vitest run test/inventory-chz-import.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
git add apps/api/package.json pnpm-lock.yaml apps/api/src/modules/inventories/chz-*.ts apps/api/test/fixtures/inventory apps/api/test/inventory-chz-import.test.ts
git commit -m "feat(api): parse inventory status exports"
```

---

### Task 3: PostgreSQL inventory preparation schema

**Files:**

- Create: `packages/db/src/schema/inventory.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/drizzle.config.ts`
- Create via Drizzle: next migration and matching `packages/db/migrations/meta` snapshot/journal entries
- Create: `packages/db/test/inventory-schema.test.ts`
- Modify: `packages/db/test/schema.test.ts`

**Interfaces:**

- Produces `inventories`, `inventoryImports`, `inventorySnapshots`,
  `inventorySnapshotInputs`, and `inventorySnapshotCodes`.
- Every child FK includes `tenant_id`; snapshot codes are unique by tenant, snapshot, and hash.

- [ ] **Step 1: Write failing schema-contract tests**

Assert enum/check values, composite tenant FKs, six-status uniqueness per snapshot, date-order
checks, SHA-256 checks, immutable snapshot uniqueness, and package/date indexes.

- [ ] **Step 2: Run schema tests and verify RED**

```bash
pnpm --filter @markiro/db exec vitest run test/inventory-schema.test.ts test/schema.test.ts
```

- [ ] **Step 3: Define the schema and generate a new migration**

```bash
pnpm --filter @markiro/db db:generate
```

Inspect generated SQL for tenant keys, defaults, nullability, indexes, and cascade behavior.
Do not rewrite an applied migration or hand-edit the lockfile.

- [ ] **Step 4: Apply against the configured development database and verify**

```bash
pnpm --filter @markiro/db db:migrate
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
```

If `DATABASE_URL` is unavailable, record the explicit skip; do not use production resources.

- [ ] **Step 5: Commit**

Stage the schema, generated migration, snapshot, journal, and tests explicitly.

---

### Task 4: Tenant-admin inventory CRUD and upload evidence

**Files:**

- Create: `apps/api/src/modules/inventories/dto.ts`
- Create: `apps/api/src/modules/inventories/inventories.controller.ts`
- Create: `apps/api/src/modules/inventories/inventories.service.ts`
- Create: `apps/api/src/modules/inventories/inventories.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/inventories.e2e.test.ts`
- Test: `apps/api/test/inventories-openapi.test.ts`

**Interfaces:**

- Adds list/create/detail/update and `POST /inventories/:id/imports/:status`.
- Uses `OPERATIONS_READ` for reads and `OPERATIONS_WRITE` plus subscription write policy for
  mutations.
- Upload returns only sanitized diagnostics and counts; original evidence is stored privately.

- [ ] **Step 1: Write failing authorization and lifecycle tests**

Cover same-tenant success, cross-tenant 404/denial, read-only subscription behavior, one-product
validation, date order, explicit repack template selection, editable states, upload idempotency, and
storage cleanup on transaction failure.

- [ ] **Step 2: Run focused API tests and verify RED**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/inventories.e2e.test.ts test/inventories-openapi.test.ts
```

- [ ] **Step 3: Implement DTO, controller, service, and module**

Lock an inventory before mutable-state checks. Derive GTIN from the tenant-scoped product and
validate the explicitly selected repack template against tenant templates. The admin UI preselects
the organization default, but the API persists the user's selection and does not silently replace it
when that default changes. Publish upload bytes with SHA-256 metadata and store append-only
attempts.

- [ ] **Step 4: Add exact audit assertions**

Assert actor, tenant, action, target, result, declared/parsed status, counts, and file digest.
Audit metadata must not include KM values or object credentials.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @markiro/api exec vitest run test/inventories.e2e.test.ts test/inventories-openapi.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

---

### Task 5: Immutable snapshot fixation

**Files:**

- Create: `apps/api/src/modules/inventories/inventory-snapshot.service.ts`
- Modify: `apps/api/src/modules/inventories/inventories.controller.ts`
- Modify: `apps/api/src/modules/inventories/inventories.service.ts`
- Modify: `apps/api/src/modules/inventories/dto.ts`
- Test: `apps/api/test/inventory-snapshot.e2e.test.ts`

**Interfaces:**

- Adds `POST /inventories/:id/snapshots`.
- Consumes exactly one selected successful import for every supported status.
- Produces an immutable snapshot, six input links, code rows, combined digest, and summary.

- [ ] **Step 1: Write failing materialization tests**

Cover six successful slots including empty results, missing slot, invalid latest upload with an
older valid selection, within-file and cross-status duplicates, wrong/missing production date,
inclusive range, protected precedence, 48-parent membership, and concurrent fixation.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @markiro/api exec vitest run test/inventory-snapshot.e2e.test.ts
```

- [ ] **Step 3: Implement fixation in one transaction**

Tenant-lock the inventory, validate selected append-only imports, insert snapshot rows in bounded
chunks, derive counts with the domain policy, and publish `activeSnapshotId` only after all rows
and the combined digest are complete. Concurrent identical requests return the same snapshot;
different input sets conflict.

- [ ] **Step 4: Prove immutability and retry safety**

Tests must show that a later upload cannot mutate the active snapshot and a failed chunk leaves
no active pointer. Do not delete source evidence on a failed fixation.

- [ ] **Step 5: Verify and commit**

Run the focused test, package typecheck/lint/build, and stage only scoped files.

---

### Task 6: Ready/start lifecycle and frozen station manifest contract

**Files:**

- Create: `apps/api/src/modules/inventories/inventory-lifecycle.service.ts`
- Create: `apps/api/src/modules/inventories/station-inventory.dto.ts`
- Modify: `apps/api/src/modules/inventories/inventories.controller.ts`
- Modify: `apps/api/src/modules/inventories/dto.ts`
- Test: `apps/api/test/inventory-lifecycle.e2e.test.ts`
- Modify: `apps/api/test/inventories-openapi.test.ts`

**Interfaces:**

- Adds `POST /inventories/:id/start` and freezes the DTOs that Plan 2 consumes.
- Start requires a ready snapshot, assigned active line, active product, and repack print
  configuration when applicable.

- [ ] **Step 1: Write failing transition and concurrency tests**

Assert legal transitions, duplicate start idempotency, simultaneous start/update exclusion,
started immutability, completed rejection, tenant denial, and exact audit output.

- [ ] **Step 2: Verify RED, implement under row lock, and verify GREEN**

```bash
pnpm --filter @markiro/api exec vitest run test/inventory-lifecycle.e2e.test.ts test/inventories-openapi.test.ts
```

- [ ] **Step 3: Document the frozen station manifest DTO**

The type includes inventory/snapshot ids, revision/digest/count, product, mode, assigned line,
date range, label-template descriptor, and page limits. It contains no cabinet-only actor or
object-storage details.

- [ ] **Step 4: Run final plan gates**

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
pnpm format:check
git diff --check
```

Report database-backed skips separately from passing tests.

---

## Handoff to Plan 2

Before Station work starts, record the exact OpenAPI response for the manifest, code page,
join, event batch, progress delta, and leave endpoints. Plan 2 may extend these contracts through
backward-compatible optional fields, but cannot reinterpret status, protection, date, or digest
semantics.
