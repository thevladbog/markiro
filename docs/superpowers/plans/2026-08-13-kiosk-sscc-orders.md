# Kiosk SSCC Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a paired kiosk resolve tenant boxes offline, submit SSCCs beside loose KMs, and persist each accepted box as one auditable, indivisible order line.

**Architecture:** Extend the existing GS1 parser at the shared domain boundary, add change-versioned box registry reads over the production box tables, and persist box provenance beside the already-expanded pickup order items. The kiosk stores a complete versioned snapshot/delta in IndexedDB and sends only canonical SSCCs; the server derives product, quantity, price and member KMs in one tenant-scoped transaction.

**Tech Stack:** TypeScript, `@markiro/domain`, PostgreSQL 17 partitioned code tables, Drizzle ORM, NestJS, Zod, IndexedDB, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-13-kiosk-self-service-redesign-design.md`

**Depends on:** `docs/superpowers/plans/2026-08-13-kiosk-policy-and-branding.md`

## Global Constraints

- SSCC storage and API transport use exactly 18 digits, never `(00)` or AIM wrappers.
- Accept scanner forms: bare SSCC, `00` + SSCC, `(00)` + SSCC, and AIM `]C1` before the encoded value.
- A box is tenant-wide; shift/terminal/location are provenance, not kiosk eligibility filters.
- Eligible means closed, not disassembled, unchanged after close, non-empty, and one product.
- Do not expose or accept a client-supplied member KM list, product id, quantity, or box price.
- A box is all-or-none: one member conflict rejects the whole box.
- Preserve legacy item-only order payloads and queued `badgeCode` bodies.
- Preserve idempotency and admission-proof compatibility for old clients.
- Box registry refresh must activate only a fully downloaded version.
- Raw KM remains bounded to existing domain limits; registry content uses canonical KM keys/digests, not plaintext badge credentials.

---

### Task 1: Extend shared scanner SSCC normalization

**Files:**

- Modify: `packages/domain/src/gs1/sscc.ts`
- Modify: `packages/domain/src/scan/classify.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/test/sscc.test.ts`
- Modify: `packages/domain/test/classify.test.ts`

**Interfaces:**

- `parseScannedSscc(raw: string): string | null` accepts all approved wrappers and returns canonical 18 digits.
- `classifyScan` delegates every SSCC-shaped input to `parseScannedSscc` before GTIN/KM classification.
- Malformed, oversized, extra-GS, and invalid-check-digit inputs remain `unknown`/`null`.

- [ ] **Step 1: Add failing table-driven parser/classifier tests**

```ts
it.each([
  [sscc, sscc],
  [`00${sscc}`, sscc],
  [`(00)${sscc}`, sscc],
  [`]C100${sscc}`, sscc],
  [`]C1(00)${sscc}`, sscc],
])("normalizes scanner SSCC %s", (raw, expected) => {
  expect(parseScannedSscc(raw)).toBe(expected);
  expect(classifyScan(raw)).toEqual({ kind: "sscc", sscc: expected });
});

it.each([`${sscc}0`, `(00)${sscc.slice(0, -1)}0`, `]C1\u001d00${sscc}`])(
  "rejects malformed scanner SSCC %s",
  (raw) => expect(parseScannedSscc(raw)).toBeNull(),
);
```

- [ ] **Step 2: Run domain tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/domain exec vitest run test/sscc.test.ts test/classify.test.ts
```

Expected: FAIL for `(00)` and AIM + `(00)` inputs.

- [ ] **Step 3: Implement one bounded wrapper-removal path**

```ts
export function parseScannedSscc(raw: string): string | null {
  if (raw.length > 25) return null;
  let rest = raw;
  if (rest.startsWith("]C1")) rest = rest.slice(3);
  if (rest.startsWith("(00)")) rest = rest.slice(4);
  else if (rest.length === 20 && rest.startsWith("00")) rest = rest.slice(2);
  return isValidSscc(rest) ? rest : null;
}

export function classifyScan(raw: string): ScanInput {
  const sscc = parseScannedSscc(raw.trim());
  if (sscc) return { kind: "sscc", sscc };
  const trimmed = raw.trim();
  if (isValidGtin(trimmed)) {
    return { kind: "gtin", gtin14: normalizeToGtin14(trimmed) };
  }
  try {
    return { kind: "km", km: canonicalizeKm(raw) };
  } catch {
    return { kind: "unknown", raw };
  }
}
```

- [ ] **Step 4: Re-run package gates**

Run:

```bash
pnpm --filter @markiro/domain exec vitest run test/sscc.test.ts test/classify.test.ts
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
```

Expected: PASS.

- [ ] **Step 5: Commit the domain boundary**

```bash
git add packages/domain/src/gs1/sscc.ts packages/domain/src/scan/classify.ts packages/domain/src/index.ts packages/domain/test/sscc.test.ts packages/domain/test/classify.test.ts
git commit -m "feat(domain): normalize scanned SSCC wrappers"
```

---

### Task 2: Add box registry versioning and pickup-order box provenance

**Files:**

- Modify: `packages/db/src/schema/platform.ts`
- Modify: `packages/db/src/schema/pickup.ts`
- Create: `packages/db/migrations/0038_kiosk_sscc_orders.sql`
- Create: `packages/db/migrations/meta/0038_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`
- Modify: `packages/db/test/schema.test.ts`
- Modify: `packages/db/test/pickup-schema.test.ts`
- Modify: `packages/db/test/runtime-migrate.test.ts`

**Interfaces:**

- `boxes.updatedAt: timestamptz` is the registry change cursor.
- `pickupOrderBoxes` snapshots SSCC/product/count/price and links to the production box.
- `pickupOrderItems.orderBoxId` optionally links an expanded KM to its order box.

- [ ] **Step 1: Add failing schema tests for timestamps and composite FKs**

```ts
it("links expanded pickup items to a tenant-scoped order box", () => {
  const fk = getTableConfig(schema.pickupOrderItems).foreignKeys.find(
    (one) => one.getName() === "pickup_order_items_tenant_order_box_fk",
  );
  expect(fk?.reference().columns.map((column) => column.name)).toEqual([
    "tenant_id",
    "order_box_id",
  ]);
  expect(fk?.reference().foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
});
```

- [ ] **Step 2: Run focused DB tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/db exec vitest run test/schema.test.ts test/pickup-schema.test.ts test/runtime-migrate.test.ts
```

Expected: FAIL because the columns/table/migration do not exist.

- [ ] **Step 3: Add the Drizzle definitions**

```ts
export const pickupOrderBoxes = pgTable(
  "pickup_order_boxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    orderId: uuid("order_id").notNull(),
    boxId: uuid("box_id").notNull(),
    sscc: char("sscc", { length: 18 }).notNull(),
    productId: uuid("product_id").notNull(),
    bottleCount: integer("bottle_count").notNull(),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("pickup_order_boxes_tenant_id_uq").on(t.tenantId, t.id),
    unique("pickup_order_boxes_order_box_uq").on(t.tenantId, t.orderId, t.boxId),
    check("pickup_order_boxes_bottle_count_check", sql`${t.bottleCount} > 0`),
    foreignKey({
      name: "pickup_order_boxes_tenant_order_fk",
      columns: [t.tenantId, t.orderId],
      foreignColumns: [pickupOrders.tenantId, pickupOrders.id],
    }),
    foreignKey({
      name: "pickup_order_boxes_tenant_box_fk",
      columns: [t.tenantId, t.boxId],
      foreignColumns: [boxes.tenantId, boxes.id],
    }),
    foreignKey({
      name: "pickup_order_boxes_tenant_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
  ],
);
```

Add `updatedAt` to `boxes` with `defaultNow()` and backfill it with
`COALESCE(closure_received_at, closed_at, opened_at, now())`. Add nullable
`orderBoxId` to `pickupOrderItems` with a composite FK and no cascade from a
production box: the order snapshot survives later exceptions.

- [ ] **Step 4: Build, migrate, and run DB tests**

Run:

```bash
pnpm --filter @markiro/db db:generate --name kiosk_sscc_orders
pnpm --filter @markiro/db build
pnpm --filter @markiro/db exec vitest run test/schema.test.ts test/pickup-schema.test.ts test/runtime-migrate.test.ts
```

Expected: PASS after reviewing all tenant FKs, check constraints, indexes, backfill, and migration journal entry.

- [ ] **Step 5: Commit persistence**

```bash
git add packages/db/src/schema/platform.ts packages/db/src/schema/pickup.ts packages/db/migrations/0038_kiosk_sscc_orders.sql packages/db/migrations/meta/0038_snapshot.json packages/db/migrations/meta/_journal.json packages/db/test/schema.test.ts packages/db/test/pickup-schema.test.ts packages/db/test/runtime-migrate.test.ts
git commit -m "feat(db): persist kiosk box order lines"
```

---

### Task 3: Maintain `boxes.updatedAt` at every mutation boundary

**Files:**

- Modify: `apps/api/src/modules/station-scans/station-scans.service.ts`
- Modify: `apps/api/src/modules/box-exceptions/box-exceptions.service.ts`
- Modify: `apps/api/test/station-scans.e2e.test.ts`
- Modify: `apps/api/test/box-exceptions.e2e.test.ts`

**Interfaces:**

- Every box open/close/member insert/displace/remove/disassemble path advances `boxes.updatedAt` in the same transaction.
- A registry delta can therefore use `(updatedAt, id)` without missing an eligibility change.

- [ ] **Step 1: Write failing timestamp advancement tests**

```ts
it("advances the box registry timestamp when an item is removed", async () => {
  const before = await readBoxUpdatedAt(boxId);
  await submitUndo({ boxId, codeHash, targetScannedAt });
  const after = await readBoxUpdatedAt(boxId);
  expect(after.getTime()).toBeGreaterThan(before.getTime());
});

it("advances the timestamp when a later scan displaces box contents", async () => {
  const before = await readBoxUpdatedAt(boxId);
  await ingestEarlierWinningScan();
  expect((await readBoxUpdatedAt(boxId)).getTime()).toBeGreaterThan(before.getTime());
});
```

- [ ] **Step 2: Run focused API tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/station-scans.e2e.test.ts test/box-exceptions.e2e.test.ts
```

Expected: FAIL because the timestamp remains unchanged.

- [ ] **Step 3: Update affected boxes in the existing transactions**

```ts
await tx
  .update(schema.boxes)
  .set({ updatedAt: new Date() })
  .where(and(eq(schema.boxes.tenantId, tenantId), inArray(schema.boxes.id, changedBoxIds)));
```

Collect only box ids whose active membership or lifecycle changed. Do not stamp
unrelated boxes in the shift, and do not add a second transaction after the
membership write.

- [ ] **Step 4: Re-run focused tests and API typecheck**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/station-scans.e2e.test.ts test/box-exceptions.e2e.test.ts
pnpm --filter @markiro/api typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit registry invalidation**

```bash
git add apps/api/src/modules/station-scans/station-scans.service.ts apps/api/src/modules/box-exceptions/box-exceptions.service.ts apps/api/test/station-scans.e2e.test.ts apps/api/test/box-exceptions.e2e.test.ts
git commit -m "feat(api): version box registry changes"
```

---

### Task 4: Add the device-auth compact box registry endpoint

**Files:**

- Create: `apps/api/src/modules/kiosk/box-registry.dto.ts`
- Create: `apps/api/src/modules/kiosk/box-registry.service.ts`
- Modify: `apps/api/src/modules/kiosk/kiosk.controller.ts`
- Modify: `apps/api/src/modules/kiosk/kiosk.module.ts`
- Create: `apps/api/test/kiosk-box-registry.e2e.test.ts`

**Interfaces:**

- `GET /kiosk/box-registry?since=<ISO>&until=<ISO>&cursor=<token>&limit=250`.
- First page chooses immutable upper bound `until=serverNow`; every next page repeats it.
- Full snapshot omits `since`; delta emits `upsert` and `remove` changes.
- Cursor is opaque base64url JSON `{ updatedAt, id }`, max page size 500.

- [ ] **Step 1: Write failing full-snapshot, delta, paging, and isolation tests**

```ts
it("returns only eligible boxes for the kiosk tenant", async () => {
  const response = await getRegistry({ limit: 2 }).expect(200);
  expect(response.body.items).toEqual([
    expect.objectContaining({
      kind: "upsert",
      sscc: eligibleSscc,
      productId,
      bottleCount: 12,
      contentKeys: expect.arrayContaining([memberKmKey]),
    }),
  ]);
  expect(JSON.stringify(response.body)).not.toContain(foreignSscc);
  expect(JSON.stringify(response.body)).not.toContain(disassembledSscc);
});

it("emits a remove delta after disassembly", async () => {
  const since = await currentRegistryVersion();
  await disassembleBox(eligibleBoxId);
  const response = await getRegistry({ since }).expect(200);
  expect(response.body.items).toContainEqual({ kind: "remove", sscc: eligibleSscc });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/kiosk-box-registry.e2e.test.ts
```

Expected: FAIL with 404 route.

- [ ] **Step 3: Implement bounded query parsing and a stable tenant query**

```ts
export const boxRegistryQuerySchema = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(250),
});

export type KioskBoxRegistryChange =
  | {
      kind: "upsert";
      boxId: string;
      sscc: string;
      productId: string;
      bottleCount: number;
      contentKeys: string[];
      updatedAt: string;
    }
  | { kind: "remove"; sscc: string; updatedAt: string };
```

The service must join `boxes` → `shifts` → `products`, active `boxItems`,
`codeRegistry`, and the exact canonical `codes` row matched by
`(tenantId, codeHash, scannedAt)`. Convert canonical KM to `kmKey` server-side,
sort content keys, reject mixed/missing members as `remove`, and order pages by
`boxes.updatedAt, boxes.id` within `updatedAt <= until`.

- [ ] **Step 4: Re-run tests, including malformed cursor and device revocation**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/kiosk-box-registry.e2e.test.ts test/kiosk-device.guard.test.ts
pnpm --filter @markiro/api typecheck
```

Expected: PASS; station/cabinet credentials cannot use the kiosk route.

- [ ] **Step 5: Commit the registry endpoint**

```bash
git add apps/api/src/modules/kiosk/box-registry.dto.ts apps/api/src/modules/kiosk/box-registry.service.ts apps/api/src/modules/kiosk/kiosk.controller.ts apps/api/src/modules/kiosk/kiosk.module.ts apps/api/test/kiosk-box-registry.e2e.test.ts
git commit -m "feat(api): expose kiosk box registry"
```

---

### Task 5: Extend admission and order creation with atomic boxes

**Files:**

- Modify: `apps/api/src/modules/pickup-orders/dto.ts`
- Modify: `apps/api/src/modules/pickup-orders/kiosk-admission-proof.ts`
- Create: `apps/api/src/modules/pickup-orders/box-order-resolver.ts`
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Modify: `apps/api/test/kiosk-admission-proof.test.ts`
- Modify: `apps/api/test/kiosk-orders.e2e.test.ts`
- Modify: `apps/api/test/pickup-orders.e2e.test.ts`

**Interfaces:**

- Request adds optional `boxes: Array<{ sscc: string }>` with at least one total item/box.
- Response adds `boxConflicts` and `acceptedBoxes`; legacy `conflicts` remains unchanged.
- Produces `resolveOrderBoxes(tx, tenantId, kioskId, boxes): Promise<ResolvedBoxSet>`.

- [ ] **Step 1: Write failing request, proof, atomicity, duplicate, limit, and persistence tests**

```ts
it("accepts one box as one order line and twelve expanded items", async () => {
  const response = await postOrder({ items: [], boxes: [{ sscc }] }).expect(201);
  expect(response.body.acceptedBoxes).toEqual([{ sscc, bottleCount: 12 }]);
  expect(response.body.itemCount).toBe(12);
  expect(await countOrderBoxes(response.body.orderNo)).toBe(1);
  expect(await countExpandedItems(response.body.orderNo)).toBe(12);
});

it("creates no order when a box-only request has one used member", async () => {
  await createPriorOrder(memberRawKm);
  const response = await postOrder({ items: [], boxes: [{ sscc }] }).expect(422);
  expect(response.body.code).toBe("order_rejected");
  expect(response.body.boxConflicts).toEqual([{ sscc, bottleCount: 12, reason: "duplicate" }]);
  expect(await countOrdersCreatedAfterRequest()).toBe(0);
});
```

- [ ] **Step 2: Run focused API tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/kiosk-admission-proof.test.ts test/kiosk-orders.e2e.test.ts test/pickup-orders.e2e.test.ts
```

Expected: FAIL because schemas and resolver do not accept boxes.

- [ ] **Step 3: Implement stable request hashing and server-derived expansion**

```ts
export const createOrderBoxSchema = z.object({
  sscc: z
    .string()
    .regex(/^\d{18}$/)
    .refine(isValidSscc),
});

const createOrderContentShape = {
  deviceSeq: z.number().int().nonnegative().max(MAX_KIOSK_DEVICE_SEQ),
  badgeDigest: z.string().refine(isCanonicalDigestB64).optional(),
  badgeCode: z.string().min(1).optional(),
  reason: z.enum(["buy", "writeoff"]),
  writeoffReasonId: z.string().uuid().nullable().optional(),
  items: z.array(createOrderItemSchema),
  boxes: z.array(createOrderBoxSchema).default([]),
  admissionNonce: z.string().min(32).max(128).optional(),
};

export interface ResolvedOrderBox {
  boxId: string;
  sscc: string;
  productId: string;
  bottleCount: number;
  unitPrice: string | null;
  members: Array<{ rawKm: string; kmKey: string; gtin14: string; serial: string }>;
}
```

Canonical admission hashing must sort copies of `items` by `rawKm` and `boxes`
by `sscc` without mutating caller arrays. The resolver reuses the registry
eligibility query under the order transaction, checks loose↔box and box↔box
overlap, applies the employee bottle limit to the whole box, inserts one
`pickupOrderBoxes` row, then inserts all members with `orderBoxId`. If any
member fails, insert neither the box row nor any member row and return one
`BoxConflict` without exposing members. Preserve the existing exactly-one-of
`badgeDigest`/`badgeCode` refinement and add a refinement requiring at least one
entry across `items` and `boxes`. If every submitted line is rejected, return
422 `order_rejected` and do not create an empty order.

- [ ] **Step 4: Re-run focused and legacy compatibility tests**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/kiosk-admission-proof.test.ts test/kiosk-orders.e2e.test.ts test/pickup-orders.e2e.test.ts test/kiosk-pairing.e2e.test.ts
pnpm --filter @markiro/api typecheck
```

Expected: PASS for mixed, box-only, item-only, replay, cross-tenant, writeoff,
over-limit and old badge payloads.

- [ ] **Step 5: Commit order support**

```bash
git add apps/api/src/modules/pickup-orders apps/api/test/kiosk-admission-proof.test.ts apps/api/test/kiosk-orders.e2e.test.ts apps/api/test/pickup-orders.e2e.test.ts
git commit -m "feat(api): accept atomic SSCC pickup lines"
```

---

### Task 6: Store a versioned registry and box payloads in the kiosk

**Files:**

- Modify: `apps/kiosk/src/api/types.ts`
- Modify: `apps/kiosk/src/api/client.ts`
- Modify: `apps/kiosk/src/store/db.ts`
- Create: `apps/kiosk/src/store/box-registry.ts`
- Modify: `apps/kiosk/src/store/queue.ts`
- Modify: `apps/kiosk/src/store/scrub.ts`
- Modify: `apps/kiosk/src/session/day-count.ts`
- Modify: `apps/kiosk/src/sync/worker.ts`
- Modify: `apps/kiosk/test/store.test.ts`
- Create: `apps/kiosk/test/box-registry.test.ts`
- Modify: `apps/kiosk/test/api-client.test.ts`
- Modify: `apps/kiosk/test/sync.test.ts`
- Modify: `apps/kiosk/test/day-count.test.ts`

**Interfaces:**

- IndexedDB adds staging/active registry stores and metadata `{version, generatedAt}`.
- `KioskClient.boxRegistryPage(query)` mirrors the API response.
- `CreateOrderDto.boxes?: Array<{sscc:string}>` persists verbatim in queue/quarantine.
- `QueuedOrder.estimatedBottleCount` stores the enqueue-time bottle total outside the wire body.
- Legacy queued records without that field fall back to `body.items.length`.
- `KioskApiError.details` preserves structured terminal conflicts for quarantine and outcome UI.

- [ ] **Step 1: Write failing atomic-snapshot, restart, old-record, and count tests**

```ts
it("does not replace the active registry after an incomplete page sequence", async () => {
  await seedActiveRegistry("v1", [oldBox]);
  await stageRegistryPage("v2", [newBox], { nextCursor: "page-2" });
  expect(await lookupBox(oldBox.sscc)).toEqual(oldBox);
  expect(await lookupBox(newBox.sscc)).toBeNull();
});

it("counts a queued twelve-bottle box against the employee day total", () => {
  const taken = countTakenToday({
    employeeId,
    today,
    boundKioskId,
    journal: [],
    queued: [queuedOrderWithTwelveBottleBox],
  });
  expect(taken).toBe(12);
});
```

- [ ] **Step 2: Build dependencies, run kiosk tests, and confirm RED**

Run:

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/kiosk exec vitest run test/box-registry.test.ts test/store.test.ts test/api-client.test.ts test/sync.test.ts test/day-count.test.ts
```

Expected: FAIL with missing store/client/types.

- [ ] **Step 3: Implement staged version activation and backward-compatible queue reads**

```ts
export interface StoredBoxRegistryRow {
  sscc: string;
  boxId: string;
  productId: string;
  bottleCount: number;
  contentKeys: string[];
  updatedAt: string;
  version: string;
}

export interface CreateOrderBoxInput {
  sscc: string;
}

export interface QueuedOrder {
  deviceSeq: number;
  employeeId: string;
  body: CreateOrderDto;
  estimatedBottleCount?: number;
  admissionState?: "pending_attestation";
  admissionNonce?: string;
}

export class KioskApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;

  constructor(
    status: number,
    message: string,
    code: string | null = null,
    details: unknown = null,
  ) {
    super(message);
    this.name = "KioskApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
```

Create a new IndexedDB version with stores `boxRegistryActive`,
`boxRegistryStaging`, and `boxRegistryMeta`. Apply every page to staging; on the
page with `nextCursor=null`, apply all `remove` records, switch the active
version in the same readwrite transaction, and delete the previous version.
Old queued records without `boxes` read as `[]`; never rewrite their
`badgeCode` compatibility beyond the existing scrub rules. At enqueue time,
store `estimatedBottleCount` from validated cart lines; for legacy records where
it is absent, use validated `body.items.length`. Have `readError` retain the
parsed response body as `KioskApiError.details`, and persist only the structured
box SSCC/count/reason fields required by quarantine and outcome UI.

- [ ] **Step 4: Re-run focused tests and kiosk typecheck**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/box-registry.test.ts test/store.test.ts test/api-client.test.ts test/sync.test.ts test/day-count.test.ts
pnpm --filter @markiro/kiosk typecheck
```

Expected: PASS; failed/aborted refresh leaves the previous active version intact.

- [ ] **Step 5: Commit kiosk persistence support**

```bash
git add apps/kiosk/src/api apps/kiosk/src/store apps/kiosk/src/session/day-count.ts apps/kiosk/src/sync/worker.ts apps/kiosk/test
git commit -m "feat(kiosk): cache box registry for offline orders"
```

---

### Task 7: Run the SSCC slice gates

**Files:**

- Verify only; do not add generated output.

**Interfaces:**

- Consumes domain, DB, API and kiosk registry contracts from Tasks 1–6.
- Produces backend/offline readiness for the touch-flow plan.

- [ ] **Step 1: Run dependency builds in consumer order**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/db build
pnpm --filter @markiro/ui build
```

Expected: PASS.

- [ ] **Step 2: Run package gates**

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/kiosk test
pnpm --filter @markiro/kiosk typecheck
pnpm --filter @markiro/kiosk lint
```

Expected: PASS; list database skips explicitly.

- [ ] **Step 3: Run builds, format, and diff checks**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/db build
pnpm --filter @markiro/api build
pnpm --filter @markiro/kiosk build
pnpm format:check
git diff --check
```

Expected: PASS.

- [ ] **Step 4: Review migration and security-sensitive payloads**

```bash
git diff -- packages/db/migrations/0038_kiosk_sscc_orders.sql
git diff -- apps/api/src/modules/pickup-orders/kiosk-admission-proof.ts
git diff -- apps/kiosk/src/store/scrub.ts
git status --short
```

Expected: no badge plaintext regression, no client-supplied member list, no
cross-tenant unscoped query, and `.pnpm-store/` remains unstaged.

- [ ] **Step 5: Commit any verification-only corrections**

```bash
git add packages/domain packages/db apps/api apps/kiosk docs/superpowers/plans/2026-08-13-kiosk-sscc-orders.md
git commit -m "test(kiosk): verify SSCC order flow"
```

Skip when no correction was required; never create an empty commit.
