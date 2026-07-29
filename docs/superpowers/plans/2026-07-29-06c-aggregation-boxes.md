# Aggregation: Boxes & SSCC (06c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A station assembles scanned items into boxes, prints and optionally verifies a GS1-128 label, and the server records the hierarchy with one owner per code.

**Architecture:** SSCC serials are allocated server-side in one statement from a counter keyed `(tenant, issuer, extension digit)`, handed to a device as blocks that ride the shift bundle and the sync response, and burned locally one statement at a time. Box membership is a column on the code row, so the device's existing three-write compensation path does not widen. Aggregation follows 06b's ownership rule: a box item whose code is owned by another scan is marked displaced, never deleted.

**Tech Stack:** Node 24, TypeScript 6.0.3, pnpm 11.10, turbo, NestJS 11, Drizzle 0.45.2, Postgres 17, React 19.2.7, Tauri 2.11, `tauri-plugin-sql`, vitest 4.1.10, `node:sqlite` for device-store tests.

## Global Constraints

- An SSCC is **18 digits**: extension digit (1) + issuer prefix (9) + serial (7) + check digit (1).
- The issuer prefix is **the first 9 digits of the issuer's GLN**. It is derived, never chosen.
- The AI `(00)` exists **only in the emitter**. Storage, DTOs and the device mirror carry exactly 18 digits.
- Extension digit **0 for boxes**; 1 is reserved for pallets in 06d. Serial spaces per extension digit never interleave.
- The counter is keyed `(tenant, issuer, extension digit)`. Allocation is **one statement** — `UPDATE … RETURNING` — never a read followed by a write.
- The serial is assigned when the box **closes**, not when it opens.
- Exhaustion **blocks closing, never scanning**.
- On the device, `tauri-plugin-sql` opens SQLite through a pool: a multi-call `BEGIN`/`COMMIT` is **not** a transaction, so **one statement is the only atomic unit**. `?` is the placeholder, never `$1`.
- `TenantGuard` accepts a station api-key. Every cabinet route also carries `SessionOnlyGuard`.
- Every server query is tenant-scoped **in the statement itself**.
- No new npm dependencies. `.npmrc` carries `minimum-release-age=10080`; adding `minimumReleaseAgeExclude` is task failure.
- User-facing station and cabinet copy is Russian.
- Conventional commit messages, English, no co-author line.

## File Structure

**`packages/domain`**
- `src/gs1/sscc.ts` (modify) — add `parseScannedSscc`; `buildSscc`/`isValidSscc`/`ssccSerialCapacity` stay untouched.
- `src/labels/zpl.ts`, `src/labels/tspl.ts` (modify) — a GS1-128 path for a `code128` element bound to `sscc`.

**`packages/db`**
- `src/schema/platform.ts` (modify) — `ssccCounters`, `ssccBlocks`, `boxes`, `boxItems`; issuer columns on `shifts`.
- `src/schema/codes.ts` (modify) — `scanEvents.operatorId` (query-only def; DDL in the migration).
- `src/sqlite/migrations.ts`, `src/sqlite/schema.ts` (modify) — `sscc_pool`, `boxes_mirror`, `box_id` on `codes_mirror` and `outbox`.

**`apps/api`**
- `src/modules/sscc/sscc.service.ts` (create) — issuer resolution and block allocation. One responsibility: hand out serial ranges.
- `src/modules/boxes/` (create) — cabinet-only read model for the box list.
- `src/modules/station-scans/` (modify) — box ids, box rows, operator, displacement marking.
- `src/modules/shifts/` (modify) — the bundle carries the issuer and a pool block.
- `src/modules/org-profile/`, `src/modules/counterparties/` (modify) — counter settings.

**`apps/station`**
- `src/lib/sscc-pool.ts` (create) — pool ranges and burning.
- `src/lib/boxes.ts` (create) — open, current, close.
- `src/lib/box-label.ts` (create) — assemble the field record and render.
- `src/lib/journal.ts`, `src/lib/sync.ts`, `src/lib/hardware-config.ts` (modify).
- `src/pages/WorkScreen.tsx` (modify), `src/ui/PrintVerification.tsx` (create).

**`apps/admin`**
- `src/pages/boxes/` (create), `src/pages/shifts/`, org-profile and counterparty forms (modify).

---

### Task 1: Parse a scanned SSCC

**Files:**
- Modify: `packages/domain/src/gs1/sscc.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/sscc.test.ts`

**Interfaces:**
- Consumes: `isValidSscc(code: string): boolean` (already exported).
- Produces: `parseScannedSscc(raw: string): string | null` — returns the bare 18 digits, or `null` when the payload is not an SSCC.

Print verification compares what the scanner read against what was printed. A scanner returns the barcode's data, which for a GS1-128 is `00` followed by the 18 digits, and many scanners prepend the AIM identifier `]C1`. This is the **narrow** strip-and-compare the spec allows; recognising an arbitrary scan as an SSCC belongs to 06d.

- [ ] **Step 1: Write the failing tests**

Append to `packages/domain/test/sscc.test.ts`:

```ts
describe("parseScannedSscc", () => {
  // buildSscc(0, "460123456", 1) — a real, check-digit-valid SSCC.
  const sscc = buildSscc(0, "460123456", 1);

  it("accepts the bare 18 digits", () => {
    expect(parseScannedSscc(sscc)).toBe(sscc);
  });

  it("strips the (00) application identifier", () => {
    expect(parseScannedSscc(`00${sscc}`)).toBe(sscc);
  });

  it("strips a leading AIM identifier and the application identifier", () => {
    expect(parseScannedSscc(`]C100${sscc}`)).toBe(sscc);
  });

  it("rejects a payload with a bad check digit", () => {
    const broken = sscc.slice(0, 17) + (sscc[17] === "0" ? "1" : "0");
    expect(parseScannedSscc(broken)).toBeNull();
  });

  it("rejects a KM DataMatrix payload", () => {
    expect(parseScannedSscc("0104601234567890215Abc")).toBeNull();
  });

  it("rejects an empty payload", () => {
    expect(parseScannedSscc("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/domain exec vitest run sscc`
Expected: FAIL — `parseScannedSscc is not a function`.

- [ ] **Step 3: Implement**

Append to `packages/domain/src/gs1/sscc.ts`:

```ts
/**
 * Extracts the bare 18-digit SSCC from what a scanner hands back.
 *
 * A GS1-128 encodes `00` + the 18 digits, and many scanners prepend the AIM
 * identifier `]C1`. Storage and transport carry the 18 digits alone, so this
 * is the one place that knows about the wrapper. Returns null rather than
 * throwing: a non-SSCC scan is an ordinary event here, not an error.
 */
export function parseScannedSscc(raw: string): string | null {
  let rest = raw.startsWith("]C1") ? raw.slice(3) : raw;
  if (rest.length === 20 && rest.startsWith("00")) rest = rest.slice(2);
  return isValidSscc(rest) ? rest : null;
}
```

Export it from `packages/domain/src/index.ts` beside `buildSscc`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/domain exec vitest run sscc`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/gs1/sscc.ts packages/domain/src/index.ts packages/domain/test/sscc.test.ts
git commit -m "feat(domain): parse a scanned SSCC payload"
```

---

### Task 2: Emit a GS1-128 barcode

**Files:**
- Modify: `packages/domain/src/labels/zpl.ts`
- Modify: `packages/domain/src/labels/tspl.ts`
- Test: `packages/domain/test/zpl.test.ts`, `packages/domain/test/tspl.test.ts`

**Interfaces:**
- Consumes: the `code128` branch of each emitter's barcode switch.
- Produces: no new export. A `code128` element whose `field` is `"sscc"` emits a GS1-128 carrying FNC1 + `00` + the 18 digits.

A plain Code 128 carrying 18 digits scans, but nothing GS1-aware recognises it as an SSCC. The DataMatrix path in `zpl.ts` already documents Zebra's `_1` FNC1 escape and the literal-`_1D` trap; this is the Code 128 equivalent. In ZPL, `^BC` takes the FNC1 through `^FD>;>8` — `>;` selects subset C and `>8` is FNC1. In TSPL, the `BARCODE` command's `"128"` type takes FNC1 as the two characters `!1` inside the data when the code page permits; both are printer-verified in Task 13's checklist entry.

- [ ] **Step 1: Write the failing tests**

Append to `packages/domain/test/zpl.test.ts`:

```ts
it("emits a GS1-128 for a code128 element bound to sscc", async () => {
  const spec: LabelTemplateSpec = {
    widthMm: 100,
    heightMm: 50,
    dpi: 203,
    language: "zpl",
    elements: [
      { id: "b", kind: "barcode", field: "sscc", format: "code128", xMm: 5, yMm: 5, sizeMm: 15 },
    ],
  };
  const out = await generateZpl(spec, { ...EMPTY_FIELDS, sscc: "004601234560000017" }, ctx);
  // Subset C, then FNC1, then the AI and the 18 digits.
  expect(out).toContain("^FD>;>800004601234560000017");
});

it("leaves a code128 element bound to another field as a plain Code 128", async () => {
  const spec: LabelTemplateSpec = {
    widthMm: 100,
    heightMm: 50,
    dpi: 203,
    language: "zpl",
    elements: [
      { id: "b", kind: "barcode", field: "qty", format: "code128", xMm: 5, yMm: 5, sizeMm: 15 },
    ],
  };
  const out = await generateZpl(spec, { ...EMPTY_FIELDS, qty: "12" }, ctx);
  expect(out).toContain("^FD12");
  expect(out).not.toContain(">8");
});
```

Append the mirror-image pair to `packages/domain/test/tspl.test.ts`, asserting the TSPL data contains `!100004601234560000017` for the `sscc` case and a bare `12` for the `qty` case.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/domain exec vitest run zpl tspl`
Expected: FAIL — the emitted data is the bare value with no FNC1.

- [ ] **Step 3: Implement**

In `packages/domain/src/labels/zpl.ts`, replace the `case "code128":` body:

```ts
    case "code128": {
      const heightDots = mmToDots(element.sizeMm, dpi);
      // A code128 bound to `sscc` is a GS1-128, not a plain Code 128: `>;`
      // selects subset C and `>8` is Zebra's FNC1, which is what makes a
      // scanner report `(00)…` and any GS1-aware system recognise an SSCC.
      // The AI is added HERE and nowhere else — storage and transport carry
      // the bare 18 digits.
      const payload = element.field === "sscc" ? `>;>800${value}` : value;
      const { fh, data: escaped } = escapeFdData(payload);
      return `^FO${x},${y}^BCN,${heightDots},N,N,N${fh}^FD${escaped}^FS`;
    }
```

Apply the equivalent change in `packages/domain/src/labels/tspl.ts`, using `!1` as the FNC1 marker and the same `element.field === "sscc"` condition, with a comment pointing at the ZPL one.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/domain exec vitest run zpl tspl`
Expected: PASS.

- [ ] **Step 5: Record the hardware check**

Append to `docs/hardware-acceptance-checklist.md`, in the printing section:

```markdown
- **GS1-128 SSCC on a real printer.** Print a box label and scan it. The
  scanner must report `(00)` followed by 18 digits — not 20 bare digits and
  not a literal `>8` / `!1` in the barcode. Verify on both a Zebra (ZPL) and
  a TSC (TSPL) printer: the FNC1 escape differs per language and neither is
  provable from emitted text alone.
```

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/labels packages/domain/test docs/hardware-acceptance-checklist.md
git commit -m "feat(domain): emit GS1-128 for an sscc-bound code128 element"
```

---

### Task 3: Server schema for counters, blocks and boxes

**Files:**
- Modify: `packages/db/src/schema/platform.ts`
- Modify: `packages/db/src/schema/codes.ts`
- Create: `packages/db/migrations/00NN_*.sql` (generated)
- Test: `packages/db/test/schema.test.ts`

**Interfaces:**
- Produces: `ssccCounters`, `ssccBlocks`, `boxes`, `boxItems` tables; `shifts.ssccIssuerCounterpartyId`; `scanEvents.operatorId`.

`scan_events` and `codes` are partitioned and their DDL lives in hand-written migrations — `packages/db/src/schema/codes.ts` says so at the top and is excluded from `drizzle.config.ts`'s `schema` list. So `scanEvents.operatorId` is added to the **query-only** def there and its DDL is written by hand into the generated migration file.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/test/schema.test.ts`:

```ts
it("keys the sscc counter by tenant, issuer and extension digit", () => {
  const cols = Object.keys(ssccCounters);
  expect(cols).toEqual(
    expect.arrayContaining(["tenantId", "issuerGln", "extensionDigit", "nextSerial"]),
  );
});

it("gives boxes a tenant-unique sscc", () => {
  const cols = Object.keys(boxes);
  expect(cols).toEqual(
    expect.arrayContaining(["tenantId", "id", "sscc", "shiftId", "terminalId", "closedAt"]),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/db exec vitest run schema`
Expected: FAIL — `ssccCounters` is not exported.

- [ ] **Step 3: Add the tables**

Append to `packages/db/src/schema/platform.ts`:

```ts
/**
 * One serial counter per (tenant, issuer, extension digit).
 *
 * The issuer is identified by its GLN — the tenant's own or a counterparty's
 * — because the SSCC prefix is the GLN's first 9 digits, so the GLN IS the
 * number space's identity. `nextSerial` is what an administrator seeds when
 * migrating off another system that issued SSCCs under the same prefix.
 * Allocation is one statement; see SsccService.
 */
export const ssccCounters = pgTable(
  "sscc_counters",
  {
    tenantId: tenantId(),
    issuerGln: char("issuer_gln", { length: 13 }).notNull(),
    extensionDigit: integer("extension_digit").notNull(),
    nextSerial: bigint("next_serial", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.issuerGln, t.extensionDigit] })],
);

/**
 * Which device received which serial range. Not bookkeeping for its own sake:
 * a ten-million space per extension digit runs low only slowly, and when it
 * does the only way to find out where it went is to have written it down.
 */
export const ssccBlocks = pgTable("sscc_blocks", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: tenantId(),
  issuerGln: char("issuer_gln", { length: 13 }).notNull(),
  extensionDigit: integer("extension_digit").notNull(),
  deviceId: uuid("device_id").notNull(),
  fromSerial: bigint("from_serial", { mode: "number" }).notNull(),
  toSerial: bigint("to_serial", { mode: "number" }).notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A transport box. The row is created when its FIRST ITEM arrives, not when
 * the closure event does: items are queued before the closure and the drain
 * is sequential, so this needs no buffering and no out-of-order handling.
 * A box with a null `sscc` is one whose closure has not arrived yet — which
 * is also exactly what an open box on the device looks like.
 */
export const boxes = pgTable(
  "boxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    shiftId: uuid("shift_id").notNull(),
    terminalId: text("terminal_id"),
    deviceBoxId: text("device_box_id").notNull(),
    sscc: char("sscc", { length: 18 }),
    operatorId: uuid("operator_id"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    printVerifiedAt: timestamp("print_verified_at", { withTimezone: true }),
    printSkippedAt: timestamp("print_skipped_at", { withTimezone: true }),
  },
  (t) => [
    unique("boxes_tenant_id_uq").on(t.tenantId, t.id),
    // Two devices holding overlapping pools is precisely the situation
    // nothing else would reveal. An index, not a check in code.
    unique("boxes_tenant_sscc_uq").on(t.tenantId, t.sscc),
    // A device's own id for the box, unique within its shift and terminal:
    // this is what an arriving scan carries instead of a server id.
    unique("boxes_device_box_uq").on(t.tenantId, t.shiftId, t.terminalId, t.deviceBoxId),
    foreignKey({
      name: "boxes_tenant_shift_fk",
      columns: [t.tenantId, t.shiftId],
      foreignColumns: [shifts.tenantId, shifts.id],
    }),
  ],
);

/**
 * A code's membership of a box. `displacedAt` marks an item whose code is
 * owned by another scan (06b's rule: the earlier scannedAt wins). It is
 * marked, never deleted — the row is the only evidence of what happened,
 * and it does not count towards the box's contents.
 */
export const boxItems = pgTable(
  "box_items",
  {
    tenantId: tenantId(),
    boxId: uuid("box_id").notNull(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
    displacedAt: timestamp("displaced_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.boxId, t.codeHash] }),
    index("box_items_tenant_code_idx").on(t.tenantId, t.codeHash),
    foreignKey({
      name: "box_items_tenant_box_fk",
      columns: [t.tenantId, t.boxId],
      foreignColumns: [boxes.tenantId, boxes.id],
    }),
  ],
);
```

Add to the `shifts` column list, after `labelTemplateId`:

```ts
    /**
     * Whose numbers this shift's boxes carry. Null means the tenant's own
     * organisation. Deliberately NOT inferred from `counterpartyId`: that
     * field answers "who is this for", this one answers "whose numbers".
     * Packing for a client under one's own SSCCs is legal and common, and
     * inferring one from the other would silently produce a wrong number,
     * discovered at the recipient's goods-in.
     */
    ssccIssuerCounterpartyId: uuid("sscc_issuer_counterparty_id"),
    boxLabelTemplateId: uuid("box_label_template_id"),
```

and the matching composite FKs beside the existing ones:

```ts
    foreignKey({
      name: "shifts_tenant_sscc_issuer_fk",
      columns: [t.tenantId, t.ssccIssuerCounterpartyId],
      foreignColumns: [counterparties.tenantId, counterparties.id],
    }),
    foreignKey({
      name: "shifts_tenant_box_label_template_fk",
      columns: [t.tenantId, t.boxLabelTemplateId],
      foreignColumns: [labelTemplates.tenantId, labelTemplates.id],
    }),
```

In `packages/db/src/schema/codes.ts`, add to `scanEvents`:

```ts
  operatorId: uuid("operator_id"),
```

- [ ] **Step 4: Generate and inspect the migration**

```bash
pnpm --filter @markiro/db db:generate
```

Read the generated `.sql`. It must create exactly `sscc_counters`, `sscc_blocks`, `boxes`, `box_items` and alter `shifts`. `scan_events` is excluded from drizzle's schema list, so append its column by hand at the end of the generated file:

```sql
ALTER TABLE "scan_events" ADD COLUMN "operator_id" uuid;
```

Confirm the new journal entry's `when` exceeds every prior entry — drizzle decides applied-ness by timestamp, not by content hash, so a colliding timestamp is silently skipped.

- [ ] **Step 5: Apply to a scratch database**

```bash
createdb markiro_scratch_06c
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro_scratch_06c pnpm --filter @markiro/db db:migrate
dropdb markiro_scratch_06c
```

Expected: applies cleanly from an empty schema.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/db exec vitest run schema`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): sscc counters, blocks and the box hierarchy"
```

---

### Task 4: Issuer resolution and block allocation

**Files:**
- Create: `apps/api/src/modules/sscc/sscc.service.ts`
- Create: `apps/api/src/modules/sscc/sscc.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/sscc.e2e.test.ts`

**Interfaces:**
- Consumes: `ssccCounters`, `ssccBlocks` (Task 3); `buildSscc` from `@markiro/domain`.
- Produces:
  ```ts
  export const BOX_EXTENSION_DIGIT = 0;
  export interface SsccBlock { issuerGln: string; extensionDigit: number; fromSerial: number; toSerial: number; }
  class SsccService {
    resolveIssuerGln(tenantId: string, shiftId: string): Promise<string>;
    allocate(tenantId: string, issuerGln: string, extensionDigit: number, deviceId: string, size: number): Promise<SsccBlock>;
  }
  ```

`resolveIssuerGln` reads the shift's `ssccIssuerCounterpartyId`; null means the tenant's own organisation profile GLN. Both reads are tenant-scoped in the statement. A missing GLN is a `BadRequestException` naming which record needs one — a plant cannot issue SSCCs without a GLN and guessing a prefix would produce numbers belonging to someone else.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/sscc.e2e.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { signUpAndActivate } from "./support/auth.js";
import { listenOnLoopback } from "./support/listen-loopback.js";
// … standard app bootstrap as in conflicts.e2e.test.ts …

it("allocates non-overlapping blocks under concurrency", async () => {
  const svc = app.get(SsccService);
  const blocks = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      svc.allocate(tenantId, gln, 0, `11111111-1111-4111-8111-00000000000${i}`, 100),
    ),
  );
  const sorted = [...blocks].sort((a, b) => a.fromSerial - b.fromSerial);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i].fromSerial).toBeGreaterThan(sorted[i - 1].toSerial);
  }
  expect(new Set(blocks.map((b) => b.fromSerial)).size).toBe(8);
});

it("continues from the seeded starting serial", async () => {
  await db
    .insert(schema.ssccCounters)
    .values({ tenantId, issuerGln: gln, extensionDigit: 0, nextSerial: 45_000 });
  const block = await app.get(SsccService).allocate(tenantId, gln, 0, deviceId, 10);
  expect(block.fromSerial).toBe(45_000);
});

it("records which device received the block", async () => {
  const block = await app.get(SsccService).allocate(tenantId, gln, 0, deviceId, 10);
  const rows = await db
    .select()
    .from(schema.ssccBlocks)
    .where(and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)));
  expect(rows).toHaveLength(1);
  expect(rows[0].fromSerial).toBe(block.fromSerial);
});

it("resolves a shift's issuer to the counterparty when one is set", async () => {
  const gln2 = await app.get(SsccService).resolveIssuerGln(tenantId, shiftWithIssuerId);
  expect(gln2).toBe(counterpartyGln);
});

it("resolves to the organisation's own GLN when the shift sets no issuer", async () => {
  expect(await app.get(SsccService).resolveIssuerGln(tenantId, plainShiftId)).toBe(orgGln);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 PAIRING_CODE_PEPPER=insecure-dummy-ci-pepper-not-a-secret pnpm --filter @markiro/api exec vitest run sscc`
Expected: FAIL — `SsccService` does not exist.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/modules/sscc/sscc.service.ts`:

```ts
import { BadRequestException, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@markiro/db";
import { Db } from "../../db/db.provider.js";

/** Boxes take extension digit 0; 1 is reserved for pallets (06d). */
export const BOX_EXTENSION_DIGIT = 0;

export interface SsccBlock {
  issuerGln: string;
  extensionDigit: number;
  fromSerial: number;
  toSerial: number;
}

@Injectable()
export class SsccService {
  constructor(private readonly db: Db) {}

  /**
   * Whose numbers this shift's boxes carry.
   *
   * `ssccIssuerCounterpartyId` is an explicit choice, not `counterpartyId`:
   * that field says who the goods are for, this one says whose numbers they
   * carry, and packing for a client under one's own SSCCs is ordinary.
   */
  async resolveIssuerGln(tenantId: string, shiftId: string): Promise<string> {
    const [shift] = await this.db
      .select({ issuer: schema.shifts.ssccIssuerCounterpartyId })
      .from(schema.shifts)
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)));
    if (!shift) throw new BadRequestException("shift not found");

    if (shift.issuer) {
      const [cp] = await this.db
        .select({ gln: schema.counterparties.gln })
        .from(schema.counterparties)
        .where(
          and(
            eq(schema.counterparties.tenantId, tenantId),
            eq(schema.counterparties.id, shift.issuer),
          ),
        );
      if (!cp?.gln) throw new BadRequestException("sscc issuer counterparty has no GLN");
      return cp.gln;
    }

    const [profile] = await this.db
      .select({ gln: schema.organizationProfile.gln })
      .from(schema.organizationProfile)
      .where(eq(schema.organizationProfile.tenantId, tenantId));
    if (!profile?.gln) throw new BadRequestException("organisation profile has no GLN");
    return profile.gln;
  }

  /**
   * Reserves `size` serials in ONE statement.
   *
   * A read followed by a write would eventually hand two devices overlapping
   * ranges, and an overlapping range is indistinguishable from a duplicate
   * box. The upsert both creates the counter on first use and advances an
   * existing one, returning the value it advanced FROM.
   */
  async allocate(
    tenantId: string,
    issuerGln: string,
    extensionDigit: number,
    deviceId: string,
    size: number,
  ): Promise<SsccBlock> {
    const [row] = await this.db
      .insert(schema.ssccCounters)
      .values({ tenantId, issuerGln, extensionDigit, nextSerial: size })
      .onConflictDoUpdate({
        target: [
          schema.ssccCounters.tenantId,
          schema.ssccCounters.issuerGln,
          schema.ssccCounters.extensionDigit,
        ],
        set: {
          nextSerial: sql`${schema.ssccCounters.nextSerial} + ${size}`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ next: schema.ssccCounters.nextSerial });

    const toExclusive = Number(row.next);
    const block: SsccBlock = {
      issuerGln,
      extensionDigit,
      fromSerial: toExclusive - size,
      toSerial: toExclusive - 1,
    };

    await this.db.insert(schema.ssccBlocks).values({
      tenantId,
      issuerGln,
      extensionDigit,
      deviceId,
      fromSerial: block.fromSerial,
      toSerial: block.toSerial,
    });

    return block;
  }
}
```

Create `sscc.module.ts` exporting `SsccService`, and register it in `app.module.ts` beside the other modules.

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command.
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the concurrency test discriminates**

Replace the one-statement upsert with a read-then-write:

```ts
const [cur] = await this.db.select().from(schema.ssccCounters).where(/* … */);
await this.db.update(schema.ssccCounters).set({ nextSerial: (cur?.nextSerial ?? 0) + size });
```

Run the Step 2 command. Expected: the overlap test FAILS. Restore, confirm green, and confirm `git diff` is clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/sscc apps/api/src/app.module.ts apps/api/test/sscc.e2e.test.ts
git commit -m "feat(api): sscc issuer resolution and one-statement block allocation"
```

---

### Task 5: Counter settings in the cabinet

**Files:**
- Modify: `apps/api/src/modules/org-profile/dto.ts`, `org-profile.service.ts`
- Modify: `apps/api/src/modules/counterparties/dto.ts`, `counterparties.service.ts`
- Modify: `apps/admin/src/pages/settings/OrgProfilePage.tsx`, `apps/admin/src/pages/counterparties/`
- Modify: `apps/admin/src/i18n/en.json`, `ru.json`
- Test: `apps/api/test/sscc-settings.e2e.test.ts`, `apps/admin/test/org-profile.test.tsx`

**Interfaces:**
- Consumes: `ssccCounters` (Task 3).
- Produces: `GET/PUT` of `{ extensionDigit: number; nextSerial: number }` for the tenant's own counter and for a counterparty's, both `SessionOnlyGuard`.

The counter belongs to the number space, not to a shift: for the tenant's own numbers it is edited on the organisation profile, for a client's on that counterparty's card. Putting it on the shift would force re-entering it for every shift of the same client.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/sscc-settings.e2e.test.ts`:

```ts
it("seeds the tenant's own box counter and reads it back", async () => {
  await agent.put("/api/org-profile/sscc").send({ extensionDigit: 0, nextSerial: 45_000 }).expect(200);
  const res = await agent.get("/api/org-profile/sscc").expect(200);
  expect(res.body).toEqual({ extensionDigit: 0, nextSerial: 45_000 });
});

it("rejects an extension digit outside 0..9", async () => {
  await agent.put("/api/org-profile/sscc").send({ extensionDigit: 10, nextSerial: 0 }).expect(400);
});

it("rejects a starting serial beyond the space a 9-digit prefix allows", async () => {
  await agent
    .put("/api/org-profile/sscc")
    .send({ extensionDigit: 0, nextSerial: 10_000_000 })
    .expect(400);
});

it("rejects a station api-key", async () => {
  await request(app.getHttpServer())
    .get("/api/org-profile/sscc")
    .set("x-api-key", stationKey)
    .expect(403);
});

it("keeps a counterparty's counter separate from the tenant's own", async () => {
  await agent.put("/api/org-profile/sscc").send({ extensionDigit: 0, nextSerial: 100 }).expect(200);
  await agent
    .put(`/api/counterparties/${counterpartyId}/sscc`)
    .send({ extensionDigit: 0, nextSerial: 900 })
    .expect(200);
  const own = await agent.get("/api/org-profile/sscc").expect(200);
  expect(own.body.nextSerial).toBe(100);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run the Task 4 Step 2 command with `vitest run sscc-settings`.
Expected: FAIL — 404 on the new routes.

- [ ] **Step 3: Implement**

Add to `apps/api/src/modules/org-profile/dto.ts`:

```ts
/**
 * A 9-digit issuer prefix leaves a 7-digit serial, so the space is
 * 0..9_999_999 per extension digit. Seeding beyond it cannot produce a valid
 * SSCC, so it is refused at the boundary rather than at the first close.
 */
export const ssccCounterSchema = z.object({
  extensionDigit: z.number().int().min(0).max(9),
  nextSerial: z.number().int().min(0).max(9_999_999),
});
export type SsccCounterDto = z.infer<typeof ssccCounterSchema>;
```

Add `GET`/`PUT /org-profile/sscc` to the org-profile controller and `GET`/`PUT /counterparties/:id/sscc` to the counterparties controller, both under `@UseGuards(TenantGuard, SessionOnlyGuard)`, both upserting `ssccCounters` keyed by the resolved issuer GLN. Reuse `ssccCounterSchema` in both.

In the admin, add the pair of fields to the organisation-profile form and the counterparty drawer, with the derived prefix shown read-only beside them and the copy explaining that the starting serial counts within that prefix. New i18n keys go into both dictionaries in matching order.

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command, then `pnpm --filter @markiro/admin exec vitest run org-profile`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/org-profile apps/api/src/modules/counterparties apps/admin/src apps/api/test/sscc-settings.e2e.test.ts
git commit -m "feat(api,admin): sscc counter settings for the tenant and counterparties"
```

---

### Task 6: The shift picks its issuer and box template

**Files:**
- Modify: `apps/api/src/modules/shifts/dto.ts`, `shifts.service.ts`
- Modify: `apps/admin/src/pages/shifts/` (form + api)
- Modify: `apps/admin/src/i18n/en.json`, `ru.json`
- Test: `apps/api/test/shifts.e2e.test.ts`, `apps/admin/test/shifts.test.tsx`

**Interfaces:**
- Consumes: `shifts.ssccIssuerCounterpartyId`, `shifts.boxLabelTemplateId` (Task 3).
- Produces: both fields on the shift create/update DTO and on `ShiftDto`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/shifts.e2e.test.ts`:

```ts
it("stores an explicit sscc issuer distinct from the counterparty", async () => {
  const res = await agent
    .post("/api/shifts")
    .send({ ...baseShift, counterpartyId: buyerId, ssccIssuerCounterpartyId: brandOwnerId })
    .expect(201);
  expect(res.body.counterpartyId).toBe(buyerId);
  expect(res.body.ssccIssuerCounterpartyId).toBe(brandOwnerId);
});

it("defaults the sscc issuer to the tenant's own organisation", async () => {
  const res = await agent.post("/api/shifts").send(baseShift).expect(201);
  expect(res.body.ssccIssuerCounterpartyId).toBeNull();
});

it("rejects an sscc issuer from another tenant", async () => {
  await agent
    .post("/api/shifts")
    .send({ ...baseShift, ssccIssuerCounterpartyId: otherTenantCounterpartyId })
    .expect(400);
});
```

Append to `apps/admin/test/shifts.test.tsx`:

```tsx
it("submits the sscc issuer separately from the counterparty", async () => {
  const fetchMock = stubFetch({ counterparties: [BUYER, BRAND_OWNER] });
  renderPage();
  await screen.findByLabelText("Контрагент");
  fireEvent.change(screen.getByLabelText("Контрагент"), { target: { value: BUYER.id } });
  fireEvent.change(screen.getByLabelText("Эмитент группового кода"), {
    target: { value: BRAND_OWNER.id },
  });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string);
  expect(body.counterpartyId).toBe(BUYER.id);
  expect(body.ssccIssuerCounterpartyId).toBe(BRAND_OWNER.id);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run the Task 4 Step 2 command with `vitest run shifts`, then `pnpm --filter @markiro/admin exec vitest run shifts`.
Expected: FAIL — the field is not persisted and the control does not exist.

- [ ] **Step 3: Implement**

Add to the shift create/update schema:

```ts
  ssccIssuerCounterpartyId: z.string().uuid().nullable().optional(),
  boxLabelTemplateId: z.string().uuid().nullable().optional(),
```

Persist both, and return them on `ShiftDto`. The composite FKs from Task 3 already reject a cross-tenant id at the database; map that violation to a 400 the same way the existing counterparty field does.

In the admin shift form, add a select labelled «Эмитент группового кода» whose default option is «Наша организация» and whose remaining options are the tenant's counterparties, plus a box-template select beside the existing item-template one. Add a hint saying the issuer decides whose numbers the boxes carry, which is not the same question as who the goods are for.

- [ ] **Step 4: Run the tests to verify they pass**

Run both Step 2 commands.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shifts apps/admin/src apps/api/test/shifts.e2e.test.ts apps/admin/test/shifts.test.tsx
git commit -m "feat(api,admin): a shift picks its sscc issuer and box label template"
```

---

### Task 7: The bundle carries the issuer and a pool block

**Files:**
- Modify: `apps/api/src/modules/shifts/shifts.service.ts` (bundle assembly)
- Modify: `apps/station/src/lib/mirror.ts` (`StationBundle`)
- Test: `apps/api/test/shifts-bundle.e2e.test.ts`

**Interfaces:**
- Consumes: `SsccService.resolveIssuerGln`, `SsccService.allocate`, `BOX_EXTENSION_DIGIT` (Task 4).
- Produces: `StationBundle.sscc: { issuerGln: string; extensionDigit: number; fromSerial: number; toSerial: number }`.

This is what lets a device close boxes for a client whose numbers it has never held. Opening a shift already requires the network — the bundle is fetched over `GET /shifts/:id/bundle` — so it is the one guaranteed moment to put the right issuer's numbers on the device.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/shifts-bundle.e2e.test.ts`:

```ts
it("carries a box serial block for the shift's issuer", async () => {
  const res = await request(app.getHttpServer())
    .get(`/api/shifts/${shiftId}/bundle`)
    .set("x-api-key", stationKey)
    .expect(200);
  expect(res.body.sscc.issuerGln).toBe(orgGln);
  expect(res.body.sscc.extensionDigit).toBe(0);
  expect(res.body.sscc.toSerial).toBeGreaterThan(res.body.sscc.fromSerial);
});

it("carries the counterparty's numbers when the shift names an issuer", async () => {
  const res = await request(app.getHttpServer())
    .get(`/api/shifts/${issuerShiftId}/bundle`)
    .set("x-api-key", stationKey)
    .expect(200);
  expect(res.body.sscc.issuerGln).toBe(counterpartyGln);
});

it("does not allocate for a validation-mode shift", async () => {
  const res = await request(app.getHttpServer())
    .get(`/api/shifts/${validationShiftId}/bundle`)
    .set("x-api-key", stationKey)
    .expect(200);
  expect(res.body.sscc).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run the Task 4 Step 2 command with `vitest run shifts-bundle`.
Expected: FAIL — `res.body.sscc` is undefined.

- [ ] **Step 3: Implement**

In the bundle assembly, after the existing fields:

```ts
    // Aggregation shifts only. A validation shift closes no boxes, so
    // allocating for it would burn serials nothing will ever print.
    sscc:
      shift.mode === "aggregation"
        ? await (async () => {
            const issuerGln = await this.sscc.resolveIssuerGln(tenantId, shift.id);
            return this.sscc.allocate(
              tenantId,
              issuerGln,
              BOX_EXTENSION_DIGIT,
              deviceId,
              BOX_BLOCK_SIZE,
            );
          })()
        : null,
```

with, beside it:

```ts
/**
 * One block must outlast a shift even if the network drops at the worst
 * moment. Ten million serials per extension digit make generosity free, and
 * a burnt serial costs nothing — SSCCs need not be contiguous.
 */
const BOX_BLOCK_SIZE = 2000;
```

Add the matching field to `StationBundle` in `apps/station/src/lib/mirror.ts`:

```ts
  sscc: {
    issuerGln: string;
    extensionDigit: number;
    fromSerial: number;
    toSerial: number;
  } | null;
```

- [ ] **Step 4: Run the test to verify it passes**

Run the Step 2 command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shifts apps/station/src/lib/mirror.ts apps/api/test/shifts-bundle.e2e.test.ts
git commit -m "feat(api): the shift bundle carries a box serial block"
```

---

### Task 8: The device's serial pool

**Files:**
- Modify: `packages/db/src/sqlite/migrations.ts`, `packages/db/src/sqlite/schema.ts`
- Create: `apps/station/src/lib/sscc-pool.ts`
- Test: `apps/station/test/sscc-pool.test.ts`, `packages/db/test/sqlite-schema.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PoolRange { issuerGln: string; extensionDigit: number; fromSerial: number; toSerial: number; nextSerial: number }
  export async function addRange(exec: SqlExecutor, r: Omit<PoolRange, "nextSerial">): Promise<void>;
  export async function burnSerial(exec: SqlExecutor, issuerGln: string, extensionDigit: number): Promise<number | null>;
  export async function remaining(exec: SqlExecutor, issuerGln: string, extensionDigit: number): Promise<number>;
  ```

`burnSerial` returns the serial it consumed, or `null` when the pool is dry. **It must consume in one statement** — `tauri-plugin-sql` opens SQLite through a pool, so a select followed by an update can hand the same serial to two callers.

- [ ] **Step 1: Write the failing tests**

Create `apps/station/test/sscc-pool.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/lib/mirror.js";
import { addRange, burnSerial, remaining } from "../src/lib/sscc-pool.js";
import { makeExec } from "./support/sqlite-exec.js";

const GLN = "4601234567890";

describe("sscc pool", () => {
  let exec: ReturnType<typeof makeExec>;
  beforeEach(async () => {
    exec = makeExec(new DatabaseSync(":memory:"));
    await applyMigrations(exec);
  });

  it("returns null when the pool is empty", async () => {
    expect(await burnSerial(exec, GLN, 0)).toBeNull();
  });

  it("burns serials in ascending order", async () => {
    await addRange(exec, { issuerGln: GLN, extensionDigit: 0, fromSerial: 10, toSerial: 12 });
    expect(await burnSerial(exec, GLN, 0)).toBe(10);
    expect(await burnSerial(exec, GLN, 0)).toBe(11);
    expect(await burnSerial(exec, GLN, 0)).toBe(12);
    expect(await burnSerial(exec, GLN, 0)).toBeNull();
  });

  it("moves on to a later non-adjacent range once the first is spent", async () => {
    await addRange(exec, { issuerGln: GLN, extensionDigit: 0, fromSerial: 10, toSerial: 10 });
    await addRange(exec, { issuerGln: GLN, extensionDigit: 0, fromSerial: 90, toSerial: 91 });
    expect(await burnSerial(exec, GLN, 0)).toBe(10);
    expect(await burnSerial(exec, GLN, 0)).toBe(90);
  });

  it("keeps issuers apart", async () => {
    await addRange(exec, { issuerGln: GLN, extensionDigit: 0, fromSerial: 10, toSerial: 11 });
    expect(await burnSerial(exec, "4609999999999", 0)).toBeNull();
    expect(await remaining(exec, GLN, 0)).toBe(2);
  });

  it("keeps extension digits apart", async () => {
    await addRange(exec, { issuerGln: GLN, extensionDigit: 0, fromSerial: 10, toSerial: 11 });
    expect(await burnSerial(exec, GLN, 1)).toBeNull();
  });

  it("never reissues a serial when two burns race", async () => {
    await addRange(exec, { issuerGln: GLN, extensionDigit: 0, fromSerial: 10, toSerial: 19 });
    const got = await Promise.all(Array.from({ length: 10 }, () => burnSerial(exec, GLN, 0)));
    expect(new Set(got).size).toBe(10);
  });

  it("counts what is left across ranges", async () => {
    await addRange(exec, { issuerGln: GLN, extensionDigit: 0, fromSerial: 1, toSerial: 3 });
    await addRange(exec, { issuerGln: GLN, extensionDigit: 0, fromSerial: 7, toSerial: 8 });
    await burnSerial(exec, GLN, 0);
    expect(await remaining(exec, GLN, 0)).toBe(4);
  });

  it("ignores a duplicate range so a replayed bundle cannot double the pool", async () => {
    const r = { issuerGln: GLN, extensionDigit: 0, fromSerial: 1, toSerial: 3 };
    await addRange(exec, r);
    await addRange(exec, r);
    expect(await remaining(exec, GLN, 0)).toBe(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/station exec vitest run sscc-pool`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Add the table**

Append to `STATION_MIGRATIONS` in `packages/db/src/sqlite/migrations.ts`, before the trailing `ALTER TABLE`:

```ts
  `CREATE TABLE IF NOT EXISTS sscc_pool (
     issuer_gln TEXT NOT NULL,
     extension_digit INTEGER NOT NULL,
     from_serial INTEGER NOT NULL,
     to_serial INTEGER NOT NULL,
     next_serial INTEGER NOT NULL,
     PRIMARY KEY (issuer_gln, extension_digit, from_serial)
   );`,
```

The primary key is what makes a replayed bundle harmless: the same block cannot be added twice. Mirror the table in `packages/db/src/sqlite/schema.ts` and bump the expected table count in `packages/db/test/sqlite-schema.test.ts`.

- [ ] **Step 4: Implement the store**

Create `apps/station/src/lib/sscc-pool.ts`:

```ts
import type { SqlExecutor } from "./mirror.js";

export interface PoolRange {
  issuerGln: string;
  extensionDigit: number;
  fromSerial: number;
  toSerial: number;
  nextSerial: number;
}

/** Idempotent: the primary key drops a block the device already holds. */
export async function addRange(
  exec: SqlExecutor,
  r: Omit<PoolRange, "nextSerial">,
): Promise<void> {
  await exec.run(
    `INSERT INTO sscc_pool (issuer_gln, extension_digit, from_serial, to_serial, next_serial)
     VALUES (?,?,?,?,?)
     ON CONFLICT(issuer_gln, extension_digit, from_serial) DO NOTHING`,
    [r.issuerGln, r.extensionDigit, r.fromSerial, r.toSerial, r.fromSerial],
  );
}

/**
 * Consumes the lowest unspent serial, or null when the pool is dry.
 *
 * ONE statement, deliberately. `tauri-plugin-sql` hands each call out on
 * whatever pooled connection is free, so a SELECT followed by an UPDATE can
 * give the same serial to two callers — and two boxes with one SSCC is the
 * one failure the server cannot repair.
 */
export async function burnSerial(
  exec: SqlExecutor,
  issuerGln: string,
  extensionDigit: number,
): Promise<number | null> {
  const rows = await exec.all<{ next_serial: number }>(
    `UPDATE sscc_pool SET next_serial = next_serial + 1
     WHERE rowid = (
       SELECT rowid FROM sscc_pool
       WHERE issuer_gln = ? AND extension_digit = ? AND next_serial <= to_serial
       ORDER BY from_serial LIMIT 1
     )
     RETURNING next_serial - 1 AS next_serial`,
    [issuerGln, extensionDigit],
  );
  return rows.length > 0 ? rows[0].next_serial : null;
}

export async function remaining(
  exec: SqlExecutor,
  issuerGln: string,
  extensionDigit: number,
): Promise<number> {
  const rows = await exec.all<{ n: number }>(
    `SELECT COALESCE(SUM(to_serial - next_serial + 1), 0) AS n FROM sscc_pool
     WHERE issuer_gln = ? AND extension_digit = ? AND next_serial <= to_serial`,
    [issuerGln, extensionDigit],
  );
  return Number(rows[0]?.n ?? 0);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/station exec vitest run sscc-pool` and `pnpm --filter @markiro/db exec vitest run sqlite-schema`.
Expected: PASS.

- [ ] **Step 6: Prove the race test discriminates**

Replace `burnSerial`'s body with a select-then-update pair. Run Step 5 — the race test must FAIL with fewer than 10 distinct serials. Restore, confirm green, confirm `git diff` is clean.

- [ ] **Step 7: Commit**

```bash
git add packages/db apps/station/src/lib/sscc-pool.ts apps/station/test/sscc-pool.test.ts
git commit -m "feat(station): device-side sscc serial pool"
```

---

### Task 9: Boxes on the device

**Files:**
- Modify: `packages/db/src/sqlite/migrations.ts`, `packages/db/src/sqlite/schema.ts`
- Create: `apps/station/src/lib/boxes.ts`
- Modify: `apps/station/src/lib/journal.ts`
- Test: `apps/station/test/boxes.test.ts`, `apps/station/test/journal.test.ts`

**Interfaces:**
- Consumes: `burnSerial` (Task 8); `AcceptedCode` and `recordScan` in `journal.ts`.
- Produces:
  ```ts
  export interface DeviceBox { boxId: string; shiftId: string; sscc: string | null; itemCount: number; openedAt: string; closedAt: string | null }
  export async function currentBox(exec: SqlExecutor, shiftId: string): Promise<DeviceBox | null>;
  export async function openBox(exec: SqlExecutor, shiftId: string, boxId: string, openedAt: string): Promise<void>;
  export async function closeBox(exec: SqlExecutor, boxId: string, sscc: string, closedAt: string, operatorId: string | null): Promise<void>;
  ```
- `AcceptedCode` gains `boxId: string | null`.

Box membership is a column on the code row. `recordScan` already writes to three places and compensates if any fails; a fourth write would widen that compensation surface, while a column rides the insert already there.

- [ ] **Step 1: Write the failing tests**

Create `apps/station/test/boxes.test.ts`:

```ts
it("has no current box before one opens", async () => {
  expect(await currentBox(exec, "s1")).toBeNull();
});

it("counts the codes that name the open box", async () => {
  await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z");
  await recordScan(exec, event("a"), code("aa", "b1"));
  await recordScan(exec, event("b"), code("bb", "b1"));
  expect((await currentBox(exec, "s1"))?.itemCount).toBe(2);
});

it("stops being current once closed", async () => {
  await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z");
  await closeBox(exec, "b1", "004601234560000017", "2026-07-29T10:05:00.000Z", null);
  expect(await currentBox(exec, "s1")).toBeNull();
});

it("keeps a closed box's item count", async () => {
  await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z");
  await recordScan(exec, event("a"), code("aa", "b1"));
  await closeBox(exec, "b1", "004601234560000017", "2026-07-29T10:05:00.000Z", null);
  const rows = await exec.all<{ sscc: string }>(`SELECT sscc FROM boxes_mirror WHERE box_id = ?`, ["b1"]);
  expect(rows[0].sscc).toBe("004601234560000017");
});

it("keeps boxes of different shifts apart", async () => {
  await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z");
  expect(await currentBox(exec, "s2")).toBeNull();
});
```

Append to `apps/station/test/journal.test.ts`:

```ts
it("stores the box id on the code row and on the outbox row", async () => {
  await recordScan(exec, event("a"), { ...acceptedCode, boxId: "b1" });
  const code = await exec.all<{ box_id: string }>(`SELECT box_id FROM codes_mirror`);
  const out = await exec.all<{ box_id: string }>(`SELECT box_id FROM outbox`);
  expect(code[0].box_id).toBe("b1");
  expect(out[0].box_id).toBe("b1");
});

it("compensates the code row away when the outbox write fails, box id and all", async () => {
  const failing = failingExecOn(exec, /INSERT INTO outbox/);
  await expect(recordScan(failing, event("a"), { ...acceptedCode, boxId: "b1" })).rejects.toThrow();
  expect(await exec.all(`SELECT 1 FROM codes_mirror`)).toHaveLength(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/station exec vitest run boxes journal`
Expected: FAIL — no `boxes_mirror`, no `box_id`.

- [ ] **Step 3: Add the tables and columns**

Append to `STATION_MIGRATIONS`, before the trailing `ALTER TABLE`:

```ts
  `CREATE TABLE IF NOT EXISTS boxes_mirror (
     box_id TEXT PRIMARY KEY,
     shift_id TEXT NOT NULL,
     sscc TEXT,
     opened_at TEXT NOT NULL,
     closed_at TEXT,
     closed_by TEXT,
     acked_at TEXT,
     print_verified_at TEXT,
     print_skipped_at TEXT
   );`,
```

`acked_at` is what stops a closed box being resent for the rest of the shift; Task 11 sets it beside the outbox ack.

And, at the very end beside the existing `login` upgrade — `applyMigrations` swallows exactly the duplicate-column error, which is what makes these re-runnable:

```ts
  `ALTER TABLE codes_mirror ADD COLUMN box_id TEXT;`,
  `ALTER TABLE outbox ADD COLUMN box_id TEXT;`,
  `ALTER TABLE outbox ADD COLUMN operator_id TEXT;`,
  `ALTER TABLE scan_events_mirror ADD COLUMN operator_id TEXT;`,
```

Mirror both in `packages/db/src/sqlite/schema.ts` and bump the table count in `packages/db/test/sqlite-schema.test.ts`.

- [ ] **Step 4: Implement the store and thread the box id**

Create `apps/station/src/lib/boxes.ts` with `currentBox` (the one row for this shift with `closed_at IS NULL`, its `itemCount` a `COUNT(*)` over `codes_mirror` by `box_id`), `openBox` (one INSERT) and `closeBox` (one UPDATE setting `sscc`, `closed_at`, `closed_by`).

In `apps/station/src/lib/journal.ts`, add `boxId: string | null` to `AcceptedCode` and carry it into both inserts:

```ts
      await exec.run(
        `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at, box_id)
         VALUES (?,?,?,?,?,?)`,
        [code.codeHash, code.shiftId, code.gtin14, code.serial, code.scannedAt, code.boxId],
      );
```

and, in the outbox insert, `storedCode && code ? code.boxId : null` alongside the other three code fields. The compensation path is untouched — it deletes the code row by hash, which now takes the box id with it.

`ScanEventRow` gains `operatorId: string | null`, written to both `scan_events_mirror` and `outbox`. Without it the server can never attribute a scan to a person, and unlike a report that can be added later, an attribution that was never captured cannot be recovered. Pin it:

```ts
it("stores the operator on the journal row and on the outbox row", async () => {
  await recordScan(exec, { ...event("a"), operatorId: "op-1" }, { ...acceptedCode, boxId: "b1" });
  const ev = await exec.all<{ operator_id: string }>(`SELECT operator_id FROM scan_events_mirror`);
  const out = await exec.all<{ operator_id: string }>(`SELECT operator_id FROM outbox`);
  expect(ev[0].operator_id).toBe("op-1");
  expect(out[0].operator_id).toBe("op-1");
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/station exec vitest run boxes journal` and `pnpm --filter @markiro/db exec vitest run sqlite-schema`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db apps/station/src/lib/boxes.ts apps/station/src/lib/journal.ts apps/station/test
git commit -m "feat(station): device box store and box membership on the code row"
```

---

### Task 10: Ingest records boxes and marks displaced items

**Files:**
- Modify: `apps/api/src/modules/station-scans/dto.ts`
- Modify: `apps/api/src/modules/station-scans/station-scans.service.ts`
- Create: `apps/api/src/modules/station-scans/box-membership.ts`
- Test: `apps/api/test/station-scans.e2e.test.ts`, `apps/api/test/box-membership.test.ts`

**Interfaces:**
- Consumes: `boxes`, `boxItems` (Task 3); the existing ownership claim block and `code_registry`.
- Produces:
  ```ts
  export interface MembershipRow { boxId: string; codeHash: string; addedAt: Date; ownerIsThisScan: boolean }
  export function displacedHashes(rows: MembershipRow[]): string[];
  ```
  DTO: `scanItemSchema` gains `boxId: z.string().min(1).max(64).nullable()` and `operatorId: z.string().uuid().toLowerCase().nullable()`; a new `boxes` array on `syncBatchSchema` carries closures.

A box row is created when its **first item** arrives, not when the closure does: items are queued before the closure and the drain is sequential, so nothing has to buffer or handle out-of-order arrival. The closure then fills in the serial and the closing time.

Displacement follows 06b exactly. After ownership is claimed, an item whose code the registry says belongs to another scan gets `displaced_at` — marked, never deleted, because the row is the only evidence of what happened. The retroactive direction matters as much: when this batch **displaces** an owner already recorded, that owner's box item must be marked too. That is the same shape as `displacedIncumbents`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/box-membership.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { displacedHashes } from "../src/modules/station-scans/box-membership.js";

const at = new Date("2026-07-29T10:00:00.000Z");

describe("displacedHashes", () => {
  it("is empty when every item's code is owned by its own scan", () => {
    expect(
      displacedHashes([{ boxId: "b1", codeHash: "aa", addedAt: at, ownerIsThisScan: true }]),
    ).toEqual([]);
  });

  it("names an item whose code is owned elsewhere", () => {
    expect(
      displacedHashes([
        { boxId: "b1", codeHash: "aa", addedAt: at, ownerIsThisScan: false },
        { boxId: "b1", codeHash: "bb", addedAt: at, ownerIsThisScan: true },
      ]),
    ).toEqual(["aa"]);
  });

  it("names the same hash once when it appears in two boxes", () => {
    expect(
      displacedHashes([
        { boxId: "b1", codeHash: "aa", addedAt: at, ownerIsThisScan: false },
        { boxId: "b2", codeHash: "aa", addedAt: at, ownerIsThisScan: false },
      ]),
    ).toEqual(["aa"]);
  });
});
```

Append to `apps/api/test/station-scans.e2e.test.ts`:

```ts
it("creates the box row from its first item, before any closure arrives", async () => {
  await postBatch([scan("aa", { boxId: "b1" })]);
  const rows = await db.select().from(schema.boxes).where(eq(schema.boxes.tenantId, tenantId));
  expect(rows).toHaveLength(1);
  expect(rows[0].sscc).toBeNull();
  expect(rows[0].closedAt).toBeNull();
});

it("fills in the serial when the closure arrives", async () => {
  await postBatch([scan("aa", { boxId: "b1" })]);
  await postBatchWithBoxes([], [{ boxId: "b1", sscc: SSCC, closedAt: ISO, operatorId: null }]);
  const [box] = await db.select().from(schema.boxes).where(eq(schema.boxes.tenantId, tenantId));
  expect(box.sscc).toBe(SSCC);
  expect(box.closedAt).not.toBeNull();
});

it("records the operator on the scan event", async () => {
  await postBatch([scan("aa", { boxId: "b1", operatorId: OPERATOR_ID })]);
  const [ev] = await db
    .select()
    .from(schema.scanEvents)
    .where(eq(schema.scanEvents.tenantId, tenantId));
  expect(ev.operatorId).toBe(OPERATOR_ID);
});

it("marks the later terminal's box item displaced when an earlier scan wins", async () => {
  await postBatchAs("t2", [scan("aa", { boxId: "b2", scannedAt: "10:00:05" })]);
  await postBatchAs("t1", [scan("aa", { boxId: "b1", scannedAt: "10:00:00" })]);
  const items = await boxItemRows(tenantId, "aa");
  const displaced = items.filter((i) => i.displacedAt !== null);
  expect(displaced).toHaveLength(1);
  expect(displaced[0].boxId).toBe(await boxIdFor("b2"));
});

it("marks nothing when a batch is clean", async () => {
  await postBatch([scan("aa", { boxId: "b1" })]);
  const items = await boxItemRows(tenantId, "aa");
  expect(items.every((i) => i.displacedAt === null)).toBe(true);
});

it("counts a box's contents excluding displaced items", async () => {
  await postBatchAs("t2", [scan("aa", { boxId: "b2", scannedAt: "10:00:05" })]);
  await postBatchAs("t1", [scan("aa", { boxId: "b1", scannedAt: "10:00:00" })]);
  expect(await liveItemCount("b2")).toBe(0);
  expect(await liveItemCount("b1")).toBe(1);
});

it("is idempotent: replaying a batch changes neither boxes nor items", async () => {
  const body = batchBody([scan("aa", { boxId: "b1" })]);
  await postRaw(body);
  await postRaw(body);
  expect(await boxCount(tenantId)).toBe(1);
  expect((await boxItemRows(tenantId, "aa")).length).toBe(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run the Task 4 Step 2 command with `vitest run station-scans box-membership`.
Expected: FAIL — `boxId` is rejected by the DTO and no box rows are written.

- [ ] **Step 3: Implement the pure rule**

Create `apps/api/src/modules/station-scans/box-membership.ts`:

```ts
export interface MembershipRow {
  boxId: string;
  codeHash: string;
  addedAt: Date;
  ownerIsThisScan: boolean;
}

/**
 * Hashes whose box item must be marked displaced.
 *
 * Aggregation follows ownership: 06b's rule is that the earlier scannedAt
 * owns the code, and a box may only count what its own scan owns. The item
 * is MARKED, never deleted — it is the only evidence that two terminals
 * boxed what is physically one item.
 */
export function displacedHashes(rows: MembershipRow[]): string[] {
  const out = new Set<string>();
  for (const r of rows) if (!r.ownerIsThisScan) out.add(r.codeHash);
  return [...out];
}
```

- [ ] **Step 4: Extend the DTO**

In `apps/api/src/modules/station-scans/dto.ts`, add to `scanItemSchema`:

```ts
  boxId: z.string().min(1).max(64).nullable(),
  // Per scan, not per batch: a drained batch can span a handover, and a
  // per-batch attribution would credit one operator with another's work.
  operatorId: z.string().uuid().toLowerCase().nullable(),
```

and to `syncBatchSchema`:

```ts
  boxes: z
    .array(
      z.object({
        boxId: z.string().min(1).max(64),
        sscc: z.string().length(18),
        closedAt: z.string().datetime(),
        operatorId: z.string().uuid().toLowerCase().nullable(),
      }),
    )
    .max(50)
    .default([]),
```

- [ ] **Step 5: Extend the ingest transaction**

Inside the existing transaction, after the ownership claim block and before the late-data stamp:

1. Upsert a `boxes` row per distinct `boxId` in the batch, `ON CONFLICT (tenant_id, shift_id, terminal_id, device_box_id) DO NOTHING`, one statement over all of them sorted by `deviceBoxId` — the same sorted-order discipline the registry claim uses, for the same 40P01 reason.
2. Insert `box_items` for every item carrying a `boxId`, `ON CONFLICT DO NOTHING` so a replay is a no-op.
3. Build `MembershipRow[]` from the batch and the registry owners already read in the claim block, call `displacedHashes`, and one `UPDATE box_items SET displaced_at = now()` over those hashes for **this batch's** boxes.
4. For the retroactive direction, reuse the displaced-incumbent set the claim block already produces: one `UPDATE box_items SET displaced_at = now()` scoped to those code hashes and to boxes other than the winner's.
5. Apply the `boxes` closures from the request: one `UPDATE … SET sscc, closed_at, operator_id` per closure, matched on the device box id.

Every statement is tenant-scoped in its own `where`.

- [ ] **Step 6: Run the tests to verify they pass**

Run the Step 2 command.
Expected: PASS.

- [ ] **Step 7: Prove three mutations are caught**

Apply each, run, name the failing test, restore, confirm green:
1. Skip the displacement `UPDATE` entirely — the displacement test must fail.
2. Drop `ON CONFLICT DO NOTHING` from the `box_items` insert — the idempotency test must fail.
3. Write `operatorId` from the batch's first item instead of per item — the operator test must fail (add a second item with a different operator if it does not).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/station-scans apps/api/test
git commit -m "feat(api): record box membership and mark displaced items on ingest"
```

---

### Task 11: The sync engine carries pools and closures

**Files:**
- Modify: `apps/station/src/lib/sync.ts`
- Modify: `apps/station/src/lib/shift-bundle.ts`
- Test: `apps/station/test/sync.test.ts`

**Interfaces:**
- Consumes: `addRange`, `remaining` (Task 8); `currentBox`, `closeBox` (Task 9); the DTO from Task 10.
- Produces: `SyncState` gains `serialsLeft: number`; the batch body gains `boxes` and per-item `boxId`/`operatorId`; the response's `ssccBlock` is applied.

Two rules carry over from 06a and 06b and must not be weakened. `isBatchResponse` still runs **before** the ack — a captive portal answering `200 {"status":"ok"}` must never be treated as delivery. And a failure applying a pool top-up must not block the ack, for the same reason conflict recording does not: the pool is a convenience, delivery is the guarantee.

- [ ] **Step 1: Write the failing tests**

Append to `apps/station/test/sync.test.ts`:

```ts
it("applies a serial block carried by the sync response", async () => {
  mockPost({ applied: 1, alreadyApplied: false, conflicts: [],
    ssccBlock: { issuerGln: GLN, extensionDigit: 0, fromSerial: 5, toSerial: 9 } });
  await drainOnce();
  expect(await remaining(exec, GLN, 0)).toBe(5);
});

it("reports how many serials are left in the batch it sends", async () => {
  await addRange(exec, { issuerGln: GLN, extensionDigit: 0, fromSerial: 1, toSerial: 3 });
  await drainOnce();
  expect(JSON.parse(lastBody()).serialsLeft).toBe(3);
});

it("sends a closed box with its serial", async () => {
  await openBox(exec, SHIFT, "b1", ISO);
  await closeBox(exec, "b1", SSCC, ISO, null);
  await drainOnce();
  expect(JSON.parse(lastBody()).boxes).toEqual([
    { boxId: "b1", sscc: SSCC, closedAt: ISO, operatorId: null },
  ]);
});

it("does not resend a box already acknowledged", async () => {
  await openBox(exec, SHIFT, "b1", ISO);
  await closeBox(exec, "b1", SSCC, ISO, null);
  await drainOnce();
  await drainOnce();
  expect(JSON.parse(lastBody()).boxes).toEqual([]);
});

it("still acknowledges when applying a serial block fails", async () => {
  const failing = failingExecOn(exec, /INSERT INTO sscc_pool/);
  mockPost({ applied: 1, alreadyApplied: false, conflicts: [],
    ssccBlock: { issuerGln: GLN, extensionDigit: 0, fromSerial: 5, toSerial: 9 } });
  await drainOnce(failing);
  expect(await outboxCount(exec)).toBe(0);
});

it("still rejects a response that is not this endpoint's shape", async () => {
  mockPost({ status: "ok", ssccBlock: { issuerGln: GLN, extensionDigit: 0, fromSerial: 5, toSerial: 9 } });
  await drainOnce();
  expect(await outboxCount(exec)).toBe(1);
  expect(await remaining(exec, GLN, 0)).toBe(0);
});

it("drops a lost code from the box that is still open", async () => {
  await openBox(exec, SHIFT, "b1", ISO);
  await recordScan(exec, event("a"), code("aa", "b1"));
  await recordScan(exec, event("b"), code("bb", "b1"));
  mockPost({ applied: 2, alreadyApplied: false,
    conflicts: [{ codeHash: "aa", winningTerminalId: "t1", winningScannedAt: ISO }] });
  await drainOnce();
  expect((await currentBox(exec, SHIFT))?.itemCount).toBe(1);
});

it("leaves a closed box alone when one of its codes is lost", async () => {
  await openBox(exec, SHIFT, "b1", ISO);
  await recordScan(exec, event("a"), code("aa", "b1"));
  await closeBox(exec, "b1", SSCC, ISO, null);
  mockPost({ applied: 1, alreadyApplied: false,
    conflicts: [{ codeHash: "aa", winningTerminalId: "t1", winningScannedAt: ISO }] });
  await drainOnce();
  const rows = await exec.all<{ box_id: string }>(
    `SELECT box_id FROM codes_mirror WHERE code_hash = ?`, ["aa"]);
  expect(rows[0].box_id).toBe("b1");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/station exec vitest run sync`
Expected: FAIL — the block is ignored and `boxes` is absent from the body.

- [ ] **Step 3: Implement**

In `sync.ts`:

- Add `serialsLeft` to the request body from `remaining(exec, issuerGln, 0)`, and `boxes` from `boxes_mirror` rows that are closed and not yet acknowledged (`closed_at IS NOT NULL AND acked_at IS NULL`; add `acked_at TEXT` to `boxes_mirror` in Task 9's migration block).
- Add `boxId` and `operatorId` to each item read out of `outbox`.
- Extend `isBatchResponse` with an optional, element-checked `ssccBlock` guard in the same style as `isBatchConflict` — a malformed block is dropped, never the batch.
- After the validated response and **before** `ackThrough`, apply the block in its own `try`/`catch`:

```ts
  if (res.ssccBlock) {
    try {
      await addRange(deps.exec, res.ssccBlock);
    } catch (err) {
      // A pool top-up that fails must not wedge delivery. The device simply
      // runs on what it has; the next response carries another block. Losing
      // one block costs at most some burnt numbers, and SSCCs need not be
      // contiguous.
      console.error("station: applying serial block failed", err);
    }
  }
```

- Mark the sent boxes acknowledged in the same place the outbox rows are acked.
- Add `serialsLeft` to `SyncState` and publish it.
- Beside the existing `recordConflicts` call, clear the box id of every lost code whose box is **still open**, in one statement:

```ts
      // A still-open box corrects itself: the operator simply scans one more
      // item. A CLOSED box is taped and labelled, so it stays as printed and
      // ends one position short — the cabinet is where that surfaces. This is
      // the same trade the server makes when it marks a box item displaced
      // rather than deleting it.
      await deps.exec.run(
        `UPDATE codes_mirror SET box_id = NULL
         WHERE code_hash = ?
           AND box_id IN (SELECT box_id FROM boxes_mirror WHERE closed_at IS NULL)`,
        [c.codeHash],
      );
```

  inside the same `try`/`catch` that already isolates conflict recording from the ack, and for the same reason.

In `shift-bundle.ts`, apply `bundle.sscc` through `addRange` when it is present.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/station exec vitest run sync`
Expected: PASS.

- [ ] **Step 5: Prove the guard still discriminates**

Delete the `ssccBlock` element check from `isBatchResponse` — nothing should change. Then delete the `applied`/`alreadyApplied` requirement — the shape test must FAIL. Restore both, confirm green.

- [ ] **Step 6: Commit**

```bash
git add apps/station/src/lib/sync.ts apps/station/src/lib/shift-bundle.ts apps/station/test/sync.test.ts
git commit -m "feat(station): sync carries serial top-ups and closed boxes"
```

---

### Task 12: Closing a box and rendering its label

**Files:**
- Create: `apps/station/src/lib/box-label.ts`
- Create: `apps/station/src/lib/close-box.ts`
- Test: `apps/station/test/close-box.test.ts`

**Interfaces:**
- Consumes: `burnSerial` (Task 8); `currentBox`, `closeBox` (Task 9); `buildSscc` from `@markiro/domain`; `renderLabelBytes` from `print-label.ts`.
- Produces:
  ```ts
  export type CloseBoxResult =
    | { status: "closed"; sscc: string; itemCount: number }
    | { status: "no-serials" }
    | { status: "empty" };
  export async function closeCurrentBox(deps: CloseBoxDeps, shiftId: string, operatorId: string | null): Promise<CloseBoxResult>;
  export function boxLabelFields(input: BoxLabelInput): Record<LabelField, string>;
  ```

The serial is burned **at close**, so a box abandoned mid-shift costs nothing. `no-serials` is a first-class result, not an exception: exhaustion blocks labelling, and the caller shows an honest message while scanning carries on.

- [ ] **Step 1: Write the failing tests**

Create `apps/station/test/close-box.test.ts`:

```ts
it("burns a serial and builds a valid SSCC", async () => {
  await addRange(exec, { issuerGln: GLN, extensionDigit: 0, fromSerial: 7, toSerial: 9 });
  await openBox(exec, SHIFT, "b1", ISO);
  await recordScan(exec, event("a"), code("aa", "b1"));
  const res = await closeCurrentBox(deps, SHIFT, null);
  expect(res.status).toBe("closed");
  if (res.status !== "closed") throw new Error("unreachable");
  expect(isValidSscc(res.sscc)).toBe(true);
  expect(res.sscc).toBe(buildSscc(0, GLN.slice(0, 9), 7));
  expect(res.itemCount).toBe(1);
});

it("refuses to close when the pool is dry, and burns nothing", async () => {
  await openBox(exec, SHIFT, "b1", ISO);
  await recordScan(exec, event("a"), code("aa", "b1"));
  expect((await closeCurrentBox(deps, SHIFT, null)).status).toBe("no-serials");
  const box = await currentBox(exec, SHIFT);
  expect(box?.sscc).toBeNull();
});

it("refuses to close an empty box, and burns nothing", async () => {
  await addRange(exec, { issuerGln: GLN, extensionDigit: 0, fromSerial: 7, toSerial: 9 });
  await openBox(exec, SHIFT, "b1", ISO);
  expect((await closeCurrentBox(deps, SHIFT, null)).status).toBe("empty");
  expect(await remaining(exec, GLN, 0)).toBe(3);
});

it("derives the prefix from the first nine digits of the issuer GLN", () => {
  const fields = boxLabelFields({ sscc: SSCC, itemCount: 12, productName: "Кола", gtin14: GTIN,
    operatorName: "Иванов", counterpartyName: "Клиент", closedAt: ISO });
  expect(fields.sscc).toBe(SSCC);
  expect(fields.qty).toBe("12");
});

it("puts no application identifier in the field record", () => {
  const fields = boxLabelFields({ sscc: SSCC, itemCount: 1, productName: "", gtin14: GTIN,
    operatorName: null, counterpartyName: null, closedAt: ISO });
  expect(fields.sscc).toHaveLength(18);
  expect(fields.sscc.startsWith("00")).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/station exec vitest run close-box`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Implement**

Create `apps/station/src/lib/box-label.ts`:

```ts
import type { LabelField } from "@markiro/domain";

export interface BoxLabelInput {
  sscc: string;
  itemCount: number;
  productName: string;
  gtin14: string;
  operatorName: string | null;
  counterpartyName: string | null;
  closedAt: string;
}

/**
 * The field record a box label is rendered from.
 *
 * `sscc` is the BARE 18 digits. The application identifier `(00)` is added
 * by the emitter and nowhere else: storing or transporting it would get an
 * export to «Честный знак» rejected.
 */
export function boxLabelFields(input: BoxLabelInput): Record<LabelField, string> {
  return {
    "product.name": input.productName,
    "product.gtin": input.gtin14,
    "km.code": "",
    sscc: input.sscc,
    "shift.no": "",
    date: input.closedAt.slice(0, 10),
    qty: String(input.itemCount),
    operator: input.operatorName ?? "",
    "counterparty.name": input.counterpartyName ?? "",
  };
}
```

Create `apps/station/src/lib/close-box.ts` with `closeCurrentBox`, which reads the current box, returns `empty` when its `itemCount` is zero, calls `burnSerial` and returns `no-serials` on `null`, builds the SSCC with `buildSscc(extensionDigit, issuerGln.slice(0, 9), serial)`, calls `closeBox`, and returns the serial and count. Nothing is burned on either refusal path — that is what the two tests pin.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/station exec vitest run close-box`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/box-label.ts apps/station/src/lib/close-box.ts apps/station/test/close-box.test.ts
git commit -m "feat(station): close a box and render its label fields"
```

---

### Task 13: The box on screen, and verifying the print

**Files:**
- Modify: `apps/station/src/lib/hardware-config.ts`
- Create: `apps/station/src/ui/PrintVerification.tsx`
- Modify: `apps/station/src/pages/WorkScreen.tsx`, `apps/station/src/pages/WorkstationSetup.tsx`
- Modify: `apps/station/src/i18n/en.json`, `ru.json`
- Test: `apps/station/test/print-verification.test.tsx`, `apps/station/test/work-screen.test.tsx`

**Interfaces:**
- Consumes: `closeCurrentBox`, `boxLabelFields` (Task 12); `parseScannedSscc` (Task 1); `renderLabelBytes`.
- Produces: `HardwareConfig.verifyPrintedLabel: boolean` (default `false`); `<PrintVerification expected={...} onVerified={} onReprint={} onSkip={} />`.

A box closes automatically at `boxCapacity` and manually at any time. The verification prompt is the one place the floor rule that nothing competes with a scan verdict is broken deliberately — the box has just closed, the operator is at the printer, and the flow is already interrupted for taping. It must therefore always have an exit: **reprint** when the scan does not match, and **skip** — recorded — when the scanner is disconnected or the label is ruined. A prompt with no exit stops the line.

- [ ] **Step 1: Write the failing tests**

Create `apps/station/test/print-verification.test.tsx`:

```tsx
it("accepts a scan of the expected label", async () => {
  const onVerified = vi.fn();
  render(<PrintVerification expected={SSCC} onVerified={onVerified} onReprint={vi.fn()} onSkip={vi.fn()} scanSource={source} />);
  act(() => source.emit(`]C100${SSCC}`));
  await waitFor(() => expect(onVerified).toHaveBeenCalledOnce());
});

it("does not accept a scan of a different label", async () => {
  const onVerified = vi.fn();
  render(<PrintVerification expected={SSCC} onVerified={onVerified} onReprint={vi.fn()} onSkip={vi.fn()} scanSource={source} />);
  act(() => source.emit(`00${OTHER_SSCC}`));
  await waitFor(() => expect(screen.getByText("Это другая этикетка")).toBeDefined());
  expect(onVerified).not.toHaveBeenCalled();
});

it("ignores a scan that is not an SSCC at all", async () => {
  const onVerified = vi.fn();
  render(<PrintVerification expected={SSCC} onVerified={onVerified} onReprint={vi.fn()} onSkip={vi.fn()} scanSource={source} />);
  act(() => source.emit("0104601234567890215Abc"));
  await waitFor(() => expect(screen.getByText("Это не групповой код")).toBeDefined());
  expect(onVerified).not.toHaveBeenCalled();
});

it("always offers a way out", () => {
  render(<PrintVerification expected={SSCC} onVerified={vi.fn()} onReprint={vi.fn()} onSkip={vi.fn()} scanSource={source} />);
  expect(screen.getByRole("button", { name: "Печатать заново" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Пропустить" })).toBeDefined();
});

it("gives both exits a 64px touch target", () => {
  render(<PrintVerification expected={SSCC} onVerified={vi.fn()} onReprint={vi.fn()} onSkip={vi.fn()} scanSource={source} />);
  for (const name of ["Печатать заново", "Пропустить"]) {
    expect(screen.getByRole("button", { name }).style.minHeight).toBe("64px");
  }
});
```

Append to `apps/station/test/work-screen.test.tsx`:

```tsx
it("shows how full the open box is", async () => {
  renderWork({ boxCapacity: 10, boxItemCount: 3 });
  expect(await screen.findByTestId("box-progress")).toHaveTextContent("3 / 10");
});

it("closes the box automatically when it reaches capacity", async () => {
  const close = vi.fn().mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 10 });
  renderWork({ boxCapacity: 10, boxItemCount: 9, closeCurrentBox: close });
  act(() => scan(VALID_KM));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it("lets the operator close a partial box", async () => {
  const close = vi.fn().mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 3 });
  renderWork({ boxCapacity: 10, boxItemCount: 3, closeCurrentBox: close });
  fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it("says plainly that numbers have run out, and keeps accepting scans", async () => {
  const close = vi.fn().mockResolvedValue({ status: "no-serials" });
  const onScan = vi.fn();
  renderWork({ boxCapacity: 10, boxItemCount: 9, closeCurrentBox: close, onScan });
  act(() => scan(VALID_KM));
  await waitFor(() => expect(screen.getByText(/номера для коробов закончились/i)).toBeDefined());
  act(() => scan(OTHER_VALID_KM));
  await waitFor(() => expect(onScan).toHaveBeenCalledTimes(2));
});

it("does not prompt for verification when the setting is off", async () => {
  const close = vi.fn().mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 10 });
  renderWork({ boxCapacity: 10, boxItemCount: 9, closeCurrentBox: close, verifyPrintedLabel: false });
  act(() => scan(VALID_KM));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(screen.queryByText("Отсканируйте распечатанную этикетку")).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/station exec vitest run print-verification work-screen`
Expected: FAIL — the component does not exist and the screen has no box section.

- [ ] **Step 3: Implement**

Add `verifyPrintedLabel: boolean` to `HardwareConfig` and `DEFAULT_HARDWARE_CONFIG` (default `false`), persisted by the existing `saveHardwareConfig`, with a checkbox on `WorkstationSetup.tsx` beside the printer fields.

Create `PrintVerification.tsx`: a full-screen panel showing the expected serial, subscribing to the scan source, running each payload through `parseScannedSscc`, calling `onVerified` on a match and showing a distinct message for a mismatch versus a non-SSCC payload. Both buttons carry `style={{ minHeight: 64 }}`.

In `WorkScreen.tsx`: show `box-progress` as `count / capacity`, add a «Закрыть короб» button, call `closeCurrentBox` when a scan brings the count to capacity, and on `closed` render the label through `boxLabelFields` + `renderLabelBytes` and print. When `verifyPrintedLabel` is on, show `PrintVerification`; `onReprint` reprints the same bytes, `onSkip` records the skip. On `no-serials`, show the message and leave the scan loop untouched.

New copy goes into both i18n dictionaries in matching order.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/station exec vitest run print-verification work-screen`
Expected: PASS.

- [ ] **Step 5: Prove the exhaustion path discriminates**

Change the `no-serials` branch to also stop the scan loop. The "keeps accepting scans" test must FAIL. Restore, confirm green.

- [ ] **Step 6: Commit**

```bash
git add apps/station/src apps/station/test
git commit -m "feat(station): box progress, closing, printing and print verification"
```

---

### Task 14: The box list in the cabinet

**Files:**
- Create: `apps/api/src/modules/boxes/` (controller, service, dto, module)
- Create: `apps/admin/src/pages/boxes/` (index, api)
- Modify: `apps/api/src/app.module.ts`, `apps/admin` routing, `apps/admin/src/i18n/*`, `docs/device-key-surface.md`
- Test: `apps/api/test/boxes.e2e.test.ts`, `apps/admin/test/boxes.test.tsx`

**Interfaces:**
- Consumes: `boxes`, `boxItems` (Task 3).
- Produces: `GET /boxes?shiftId=…` returning `BoxDto { id, sscc, terminalId, operatorId, itemCount, closedAt, contentsChangedAfterClose }`.

`contentsChangedAfterClose` is true when the box has an item whose `displaced_at` is later than `closed_at`. A closed box cannot be corrected — it is taped and labelled — so this is the only way a manager finds out it is one position short.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/boxes.e2e.test.ts`:

```ts
it("lists a shift's boxes with a live item count", async () => {
  const res = await agent.get(`/api/boxes?shiftId=${shiftId}`).expect(200);
  expect(res.body.items[0].itemCount).toBe(2);
});

it("excludes displaced items from the count", async () => {
  const res = await agent.get(`/api/boxes?shiftId=${displacedShiftId}`).expect(200);
  expect(res.body.items[0].itemCount).toBe(0);
});

it("flags a box whose contents changed after it closed", async () => {
  const res = await agent.get(`/api/boxes?shiftId=${displacedShiftId}`).expect(200);
  expect(res.body.items[0].contentsChangedAfterClose).toBe(true);
});

it("does not flag a box displaced before it closed", async () => {
  const res = await agent.get(`/api/boxes?shiftId=${openShiftId}`).expect(200);
  expect(res.body.items[0].contentsChangedAfterClose).toBe(false);
});

it("rejects a station api-key", async () => {
  await request(app.getHttpServer())
    .get(`/api/boxes?shiftId=${shiftId}`)
    .set("x-api-key", stationKey)
    .expect(403);
});

it("does not list another tenant's boxes", async () => {
  const res = await agent.get(`/api/boxes?shiftId=${otherTenantShiftId}`).expect(200);
  expect(res.body.items).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run the Task 4 Step 2 command with `vitest run boxes`.
Expected: FAIL — 404.

- [ ] **Step 3: Implement**

Create the module with `@UseGuards(TenantGuard, SessionOnlyGuard)` at class level. One tenant-scoped query joins `boxes` to a `box_items` aggregate computing the live count (`COUNT(*) FILTER (WHERE displaced_at IS NULL)`) and the flag (`bool_or(displaced_at > closed_at)`), ordered by `closed_at DESC NULLS FIRST` so an open box sits at the top where a manager looks first.

In the admin, add a boxes page listing serial, terminal, operator, count, closing time and a badge when contents changed after closing, with a shift filter following the conflicts page's pattern. Add the two routes to `docs/device-key-surface.md`'s cabinet-only table.

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command, then `pnpm --filter @markiro/admin exec vitest run boxes`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/boxes apps/admin/src apps/api/test/boxes.e2e.test.ts apps/admin/test/boxes.test.tsx docs/device-key-surface.md apps/api/src/app.module.ts
git commit -m "feat(api,admin): per-shift box list in the cabinet"
```

---

### Task 15: Documentation and full verification

**Files:**
- Modify: `apps/station/README.md`
- Modify: `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`
- Modify: `docs/hardware-acceptance-checklist.md`

- [ ] **Step 1: Document the slice**

Add an "Aggregation: boxes" section to `apps/station/README.md` stating, accurately against the code:

- The earlier `scanned_at` owns a code, and aggregation follows ownership — a box counts only what its own scan owns, and a displaced item is marked, never deleted.
- The issuer prefix is the first 9 digits of the issuer's GLN; the shift picks the issuer explicitly, and that is a different question from `counterpartyId`.
- Extension digit 0 for boxes, 1 reserved for pallets; counters are keyed `(tenant, issuer, extension digit)` and the starting serial is what makes migration off another system safe.
- Blocks are allocated in one statement; the device burns serials in one statement; top-ups ride the shift bundle and the sync response.
- The serial is assigned at close; exhaustion blocks closing, never scanning.
- `(00)` exists only in the emitter — storage and transport are 18 digits, and both mistakes are silent.
- A box row is created by its first item, not by its closure.
- Print verification is opt-in per workstation and always has an exit; a skip is recorded.

- [ ] **Step 2: Update the roadmap**

Add a `06c` row marked done with today's date, noting that pallets (06d) are next and are unblocked by this slice.

- [ ] **Step 3: Run the full gate**

```bash
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 PAIRING_CODE_PEPPER=insecure-dummy-ci-pepper-not-a-secret pnpm turbo lint typecheck test build --concurrency=1
```

Expected: all tasks successful. Then `pnpm format:check` separately — CI runs it as its own step and turbo does not cover it.

**Check the skipped count, not just the exit code.** The API e2e are wrapped in `describe.skipIf` on `DATABASE_URL`/`BETTER_AUTH_*`, and turbo does not load `.env`, so a run without the environment passes while silently skipping ~25 files. Confirm 0 skipped.

- [ ] **Step 4: Verify the migration once more**

Apply the whole chain to a scratch database from an empty schema and confirm the new journal entry's `when` still exceeds every prior entry — `main` may have moved while this branch was in flight.

- [ ] **Step 5: Commit**

```bash
git add apps/station/README.md docs
git commit -m "docs: document box aggregation and the sscc number space"
```

---

## Notes for the executor

- A fresh worktree needs `.env` copied from the main checkout, `pnpm install`, and `pnpm --filter @markiro/db build` before lint and typecheck report anything real.
- `pnpm --filter <pkg> test -- <name>` does **not** filter by file; use `pnpm --filter <pkg> exec vitest run <name>`.
- Never run `prettier --write .` — it reaches into sibling worktrees. Format only the paths you touched.
- Any new API e2e file must call `listenOnLoopback(app)` in `beforeAll`, or it will flake with `Parse Error: Expected HTTP/`.

