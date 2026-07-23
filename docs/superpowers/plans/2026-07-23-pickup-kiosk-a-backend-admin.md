# Pickup Kiosk «Для себя» — Plan A (Data + API + Admin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the office/backend half of the self-service pickup kiosk feature — the domain KM guard, the full data model (employees, badges, kiosks, allowlist, configurable reasons, pickup orders + items, per-tenant order counter, product price/EGAIS fields), the NestJS API (admin CRUD + kiosk device-facing endpoints + order lifecycle + bulk code export + printed slip), and the admin panel section «Для себя».

**Architecture:** Follows the existing repo patterns exactly. Domain logic lives in `packages/domain` (pure, TDD). Tables live in `packages/db` as Drizzle schemas with the composite `(tenant_id, id)` FK pattern; migrations are drizzle-generated. API is NestJS 4-file modules (`module`/`controller`/`service`/`dto`) with Zod validation via `ZodValidationPipe`, tenant scoping via `TenantGuard`, and a new `KioskDeviceGuard` for unattended kiosk device auth. Admin is React + react-router + TanStack Query + `@markiro/ui` + i18next. Plan B (the `apps/kiosk` touch app + offline) builds on the kiosk-facing API delivered here.

**Tech Stack:** TypeScript 6, NestJS 11 + Drizzle 0.45 + Postgres + Better Auth 1.6 + Zod 4, React 19 + Vite 8 + react-router 8 + TanStack Query 5 + react-hook-form + i18next, Vitest 4 (+ supertest for API e2e, React Testing Library for admin), bwip-js (barcode/DataMatrix SVG, bundled — no CDN).

## Global Constraints

Copied from `docs/superpowers/specs/2026-07-23-pickup-kiosk-design.md` and the MVP roadmap; every task inherits these:

- **Versions pinned** per `docs/architecture.md` §1 (Node 24, TS 6.0, NestJS 11.1, Drizzle 0.45 / drizzle-kit 0.31, better-auth 1.6, React 19.2, Vite 8.1, Zod 4.4; pnpm 11.10 + turbo 2.10). Root `.npmrc` stays as committed (npmjs registry, `save-exact`, `engine-strict`, `minimum-release-age=10080` — new deps must be ≥7 days old).
- **Multi-tenant:** every domain table carries `tenant_id`; tenant scoping is the Better Auth `session.activeOrganizationId`; cross-table refs use the composite `(tenant_id, id)` FK pattern from `packages/db/src/schema/platform.ts`.
- **All admin UI:** RU primary + EN (both `ru.json`/`en.json` must stay key-parallel — a missing key throws in tests), light + dark themes, Markiro design system (`@markiro/ui` tokens, never hardcode colors/fonts/spacing).
- **No CDN assets anywhere;** fonts bundled. bwip-js runs locally (SVG output).
- **TDD throughout;** Vitest. DB-touching tests gate on `describe.skipIf(!ready)`.
- **Scope decisions (this plan):** v1 = fixation + document + status only, **no direct ГИС МТ / СУЗ call**; CommerceML deferred but design-ready (`products.external_ref`); order number format `ORD-ГГ-НННН` (per-tenant continuous counter, 4-digit zero-pad, ГГ = creation year, no yearly reset); scanned code that isn't in the kiosk allowlist → machine-readable error for a red modal; write-off sub-reasons are tenant-configurable rows.
- **`exactOptionalPropertyTypes: true`** (tsconfig.base.json): in admin, never assign `undefined` to an optional prop — use the `errorProp(...)` / conditional-spread helpers.
- **Relative imports carry `.js` suffix** in `packages/*` and `apps/admin` sources (NodeNext/bundler convention already in the repo).

---

## File Structure

**`packages/domain`**
- Create `src/scan/pickup.ts` — `validatePickupKm()` + `PickupKmResult`. Modify `src/index.ts` (export). Test `test/pickup.test.ts`.
- Create `src/barcodes/svg.ts` — `renderDataMatrixSvg` / `renderQrSvg` / `renderCode128Svg` (bwip-js `toSVG`). Modify `src/index.ts` (export). Test `test/barcodes.test.ts`. Modify `packages/domain/package.json` (add `bwip-js`).

**`packages/db`**
- Create `src/schema/pickup.ts` — enums + tables (employees, employee_badges, kiosks, kiosk_products, pickup_order_reasons, pickup_order_counters, pickup_orders, pickup_order_items). Modify `src/schema/platform.ts` (products: `unit_price`, `egais_code`, `external_ref`). Modify `src/schema.ts` (barrel export). Modify `drizzle.config.ts` (add pickup.ts to schema list). Generate `migrations/00NN_*.sql`. Test `test/pickup-schema.test.ts`.

**`apps/api`**
- Create `src/tenancy/kiosk-device.guard.ts` — `KioskDeviceGuard`, `RequestWithKiosk`. Test `test/kiosk-device.guard.test.ts`.
- Create modules under `src/modules/`: `employees/`, `kiosks/`, `pickup-reasons/`, `pickup-orders/`, `kiosk/` (device-facing). Each = `dto.ts` + `*.service.ts` + `*.controller.ts` + `*.module.ts`.
- Create `src/pickup/order-number.ts` — `nextOrderNo(...)` helper (used by pickup-orders service). Create `src/pickup/slip.ts` — A4 HTML slip renderer.
- Modify `src/modules/products/dto.ts` + `products.service.ts` (new fields).
- Modify `src/app.module.ts` (register new modules).
- Tests `test/employees.e2e.test.ts`, `kiosks.e2e.test.ts`, `pickup-reasons.e2e.test.ts`, `pickup-orders.e2e.test.ts`, `kiosk-orders.e2e.test.ts`, `pickup-export.e2e.test.ts`, `pickup-slip.e2e.test.ts`, `order-number.test.ts` (unit).

**`apps/admin`**
- Create `src/pages/pickup/` — `index.tsx` (orders свод + filters + bulk export), `OrderDetail.tsx` (route), `api.ts`. Create `src/pages/employees/` (`index.tsx`, `EmployeeForm.tsx`, `api.ts`). Create `src/pages/kiosks/` (`index.tsx`, `KioskForm.tsx`, `ReasonsEditor.tsx`, `api.ts`). Modify `src/pages/catalog/ProductForm.tsx` (price/EGAIS fields).
- Modify `src/app.tsx` (routes), `src/layout/AppShell.tsx` (nav item + pending badge), `src/i18n/ru.json` + `en.json`.
- Tests `test/pickup.test.tsx`, `employees.test.tsx`, `kiosks.test.tsx`.

---

## Phase 1 — Domain (`packages/domain`)

### Task 1: Pickup KM guard

**Files:**
- Create: `packages/domain/src/scan/pickup.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/pickup.test.ts`

**Interfaces:**
- Consumes: `classifyScan` (`src/scan/classify.ts`), `kmKey`, `ParsedKm` (`src/gs1/km.ts`).
- Produces:
  ```ts
  export type PickupKmResult =
    | { status: "ok"; km: ParsedKm; key: string }
    | { status: "not_km"; raw: string }
    | { status: "incomplete"; raw: string; reason: string };
  export function validatePickupKm(raw: string, opts?: { requireCryptoTail?: boolean }): PickupKmResult;
  ```

Rationale: the existing `parseKm` does NOT fail on a missing GS — it silently folds the crypto tail into the serial, producing a wrong `kmKey`. Keyboard-wedge scanners are the common source of dropped GS. Chestny ZNAK product codes always carry a crypto tail AI (91/92/93) after the GS; if `parseKm` reports zero trailing AIs, the GS was almost certainly dropped (serial swallowed the tail) → reject as `incomplete`. `requireCryptoTail` defaults `true` (assumption from spec §16; make it a switch so future non-crypto product groups can opt out).

- [ ] **Step 1: Write the failing test** — `packages/domain/test/pickup.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validatePickupKm } from "../src/scan/pickup.js";

const GS = "";
// Valid beer KM: 01 + gtin14 + 21 + serial + GS + 93 + 4-char crypto tail.
const GTIN = "04650075195923";
const CLEAN = `01${GTIN}21KYC9X7MQ${GS}93Abcd`;

describe("validatePickupKm", () => {
  it("accepts a well-formed KM with a crypto tail and returns the canonical key", () => {
    const r = validatePickupKm(CLEAN);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.km.gtin14).toBe(GTIN);
      expect(r.km.serial).toBe("KYC9X7MQ");
      expect(r.key).toBe(`01${GTIN}21KYC9X7MQ`);
    }
  });

  it("rejects a KM whose GS was dropped (no trailing AI) as incomplete", () => {
    // Keyboard scanner dropped the GS: serial swallows '93Abcd'.
    const r = validatePickupKm(`01${GTIN}21KYC9X7MQ93Abcd`);
    expect(r.status).toBe("incomplete");
  });

  it("classifies a plain GTIN / badge scan as not_km", () => {
    expect(validatePickupKm(GTIN).status).toBe("not_km");
    expect(validatePickupKm("MARKIRO-BADGE-4412").status).toBe("not_km");
  });

  it("accepts a tail-less KM when requireCryptoTail is false", () => {
    const r = validatePickupKm(`01${GTIN}21KYC9X7MQ`, { requireCryptoTail: false });
    expect(r.status).toBe("ok");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @markiro/domain test -- pickup`
Expected: FAIL — `validatePickupKm` not found.

- [ ] **Step 3: Implement** — `packages/domain/src/scan/pickup.ts`:

```ts
import { kmKey, type ParsedKm } from "../gs1/km.js";
import { classifyScan } from "./classify.js";

export type PickupKmResult =
  | { status: "ok"; km: ParsedKm; key: string }
  | { status: "not_km"; raw: string }
  | { status: "incomplete"; raw: string; reason: string };

/**
 * Guards a scan intended to be a Chestny ZNAK product KM before it enters a
 * pickup order. Unlike parseKm(), this rejects a KM whose GS separator was
 * dropped by a keyboard-wedge scanner: such a scan folds the crypto tail into
 * the serial (no trailing AI 91/92/93), which would corrupt the dedup key.
 */
export function validatePickupKm(
  raw: string,
  opts: { requireCryptoTail?: boolean } = {},
): PickupKmResult {
  const requireCryptoTail = opts.requireCryptoTail ?? true;
  const scan = classifyScan(raw);
  if (scan.kind !== "km") return { status: "not_km", raw };
  const km = scan.km;
  if (requireCryptoTail && Object.keys(km.ais).length === 0) {
    return {
      status: "incomplete",
      raw,
      reason: "no trailing AI (91/92/93) — GS separator likely dropped by the scanner",
    };
  }
  return { status: "ok", km, key: kmKey(km) };
}
```

- [ ] **Step 4: Export** — add to `packages/domain/src/index.ts`:

```ts
export { validatePickupKm } from "./scan/pickup.js";
export type { PickupKmResult } from "./scan/pickup.js";
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm --filter @markiro/domain test -- pickup`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/scan/pickup.ts packages/domain/src/index.ts packages/domain/test/pickup.test.ts
git commit -m "feat(domain): pickup KM guard rejecting dropped-GS scans"
```

### Task 2: Barcode SVG renderer (bwip-js)

**Files:**
- Modify: `packages/domain/package.json` (add `bwip-js`)
- Create: `packages/domain/src/barcodes/svg.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/barcodes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function renderDataMatrixSvg(text: string): string; // <svg>…</svg>
  export function renderQrSvg(text: string): string;
  export function renderCode128Svg(text: string): string;
  ```

bwip-js `toSVG` is pure JS (works in Node and browser), so this shared helper serves the server slip now and the admin/kiosk on-screen codes later. DataMatrix payloads may contain the GS (0x1D) control byte; bwip-js encodes it via its FNC1/`^NNN` parse escape — we pre-encode GS to `^029` and pass `parse: true`.

- [ ] **Step 1: Add the dependency** (must satisfy `minimum-release-age`; bwip-js is long-published):

```bash
pnpm --filter @markiro/domain add bwip-js
```

- [ ] **Step 2: Write the failing test** — `packages/domain/test/barcodes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderCode128Svg, renderDataMatrixSvg, renderQrSvg } from "../src/barcodes/svg.js";

describe("barcode SVG renderers", () => {
  it("renders a DataMatrix SVG containing a crypto-tail KM with a GS byte", () => {
    const svg = renderDataMatrixSvg(`01046500751959232 1KYC9X7MQ93Abcd`);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
  });
  it("renders a QR SVG", () => {
    expect(renderQrSvg("MARKIRO-BADGE-4412").startsWith("<svg")).toBe(true);
  });
  it("renders a Code128 SVG for an order number", () => {
    expect(renderCode128Svg("ORD-26-0037").startsWith("<svg")).toBe(true);
  });
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `pnpm --filter @markiro/domain test -- barcodes`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** — `packages/domain/src/barcodes/svg.ts`:

```ts
import bwipjs from "bwip-js";

/** GS (0x1D) → bwip-js parse escape so DataMatrix encodes the FNC1 separator. */
function encodeGs(text: string): string {
  return text.replace(//g, "^029");
}

export function renderDataMatrixSvg(text: string): string {
  return bwipjs.toSVG({ bcid: "datamatrix", text: encodeGs(text), parse: true, scale: 3 });
}

export function renderQrSvg(text: string): string {
  return bwipjs.toSVG({ bcid: "qrcode", text, scale: 3 });
}

export function renderCode128Svg(text: string): string {
  return bwipjs.toSVG({ bcid: "code128", text, scale: 2, height: 10, includetext: true, textxalign: "center" });
}
```

- [ ] **Step 5: Export** — add to `packages/domain/src/index.ts`:

```ts
export { renderCode128Svg, renderDataMatrixSvg, renderQrSvg } from "./barcodes/svg.js";
```

- [ ] **Step 6: Run tests, verify pass**

Run: `pnpm --filter @markiro/domain test -- barcodes`
Expected: PASS. If `toSVG` typing complains, `import * as bwipjs from "bwip-js"` and adjust; verify with `pnpm --filter @markiro/domain typecheck`.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/barcodes/svg.ts packages/domain/src/index.ts packages/domain/test/barcodes.test.ts packages/domain/package.json ../../pnpm-lock.yaml
git commit -m "feat(domain): bwip-js SVG renderers for DataMatrix/QR/Code128"
```

---

## Phase 2 — Data model (`packages/db`)

### Task 3: Pickup schema + product fields + migration

**Files:**
- Create: `packages/db/src/schema/pickup.ts`
- Modify: `packages/db/src/schema/platform.ts` (products columns)
- Modify: `packages/db/src/schema.ts` (barrel), `packages/db/drizzle.config.ts` (schema list)
- Generate: `packages/db/migrations/00NN_*.sql`
- Test: `packages/db/test/pickup-schema.test.ts`

**Interfaces:**
- Produces Drizzle tables under `schema.*`: `employees`, `employeeBadges`, `kiosks`, `kioskProducts`, `pickupOrderReasons`, `pickupOrderCounters`, `pickupOrders`, `pickupOrderItems`; enums `employeeStatus`, `kioskStatus`, `pickupReason`, `pickupOrderStatus`; new `products` columns `unitPrice`, `egaisCode`, `externalRef`.

- [ ] **Step 1: Write the schema** — `packages/db/src/schema/pickup.ts`:

```ts
import {
  boolean, foreignKey, integer, numeric, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization } from "./auth.js";
import { products } from "./platform.js";

export const employeeStatus = pgEnum("employee_status", ["active", "archived"]);
export const kioskStatus = pgEnum("kiosk_status", ["active", "archived"]);
export const pickupReason = pgEnum("pickup_reason", ["buy", "writeoff"]);
export const pickupOrderStatus = pgEnum("pickup_order_status", [
  "pending", "punched", "writtenoff", "cancelled",
]);

const tenantId = () =>
  text("tenant_id").notNull().references(() => organization.id);

export const employees = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    fullName: text("full_name").notNull(),
    role: text("role"),
    status: employeeStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("employees_tenant_id_uq").on(t.tenantId, t.id)],
);

export const employeeBadges = pgTable(
  "employee_badges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    employeeId: uuid("employee_id").notNull(),
    badgeCode: text("badge_code").notNull(),
    label: text("label"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "employee_badges_tenant_employee_fk",
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    // One active badge code per tenant (revoked codes may be reissued).
    uniqueIndex("employee_badges_tenant_code_active_uq")
      .on(t.tenantId, t.badgeCode)
      .where(sql`revoked_at is null`),
  ],
);

export const kiosks = pgTable(
  "kiosks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    location: text("location"),
    deviceTokenHash: text("device_token_hash"),
    dayLimitPerEmployee: integer("day_limit_per_employee").notNull().default(5),
    showPrices: boolean("show_prices").notNull().default(true),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    status: kioskStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("kiosks_tenant_id_uq").on(t.tenantId, t.id),
    // device_token_hash is a deterministic sha256, unique when present.
    uniqueIndex("kiosks_device_token_uq").on(t.deviceTokenHash).where(sql`device_token_hash is not null`),
  ],
);

export const kioskProducts = pgTable(
  "kiosk_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kioskId: uuid("kiosk_id").notNull(),
    productId: uuid("product_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("kiosk_products_uq").on(t.tenantId, t.kioskId, t.productId),
    foreignKey({
      name: "kiosk_products_tenant_kiosk_fk",
      columns: [t.tenantId, t.kioskId],
      foreignColumns: [kiosks.tenantId, kiosks.id],
    }),
    foreignKey({
      name: "kiosk_products_tenant_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
  ],
);

export const pickupOrderReasons = pgTable(
  "pickup_order_reasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("pickup_order_reasons_tenant_id_uq").on(t.tenantId, t.id)],
);

// Per-tenant monotonic counter for ORD-ГГ-НННН. One row per tenant, created
// lazily on first order (INSERT ... ON CONFLICT DO UPDATE ... RETURNING seq).
export const pickupOrderCounters = pgTable("pickup_order_counters", {
  tenantId: text("tenant_id").primaryKey().references(() => organization.id),
  seq: integer("seq").notNull().default(0),
});

export const pickupOrders = pgTable(
  "pickup_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    orderNo: text("order_no").notNull(),
    kioskId: uuid("kiosk_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    reason: pickupReason("reason").notNull(),
    writeoffReasonId: uuid("writeoff_reason_id"),
    status: pickupOrderStatus("status").notNull().default("pending"),
    itemCount: integer("item_count").notNull(),
    totalPrice: numeric("total_price", { precision: 12, scale: 2 }),
    receiptNo: text("receipt_no"),
    actNo: text("act_no"),
    deviceSeq: integer("device_seq"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: text("resolved_by_user_id"),
  },
  (t) => [
    unique("pickup_orders_tenant_id_uq").on(t.tenantId, t.id),
    unique("pickup_orders_tenant_order_no_uq").on(t.tenantId, t.orderNo),
    // Idempotent sync: a (kiosk, deviceSeq) pair maps to one order. NULL
    // deviceSeq rows (admin-created, if ever) are exempt (MATCH SIMPLE).
    unique("pickup_orders_kiosk_device_seq_uq").on(t.tenantId, t.kioskId, t.deviceSeq),
    foreignKey({
      name: "pickup_orders_tenant_kiosk_fk",
      columns: [t.tenantId, t.kioskId],
      foreignColumns: [kiosks.tenantId, kiosks.id],
    }),
    foreignKey({
      name: "pickup_orders_tenant_employee_fk",
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "pickup_orders_tenant_reason_fk",
      columns: [t.tenantId, t.writeoffReasonId],
      foreignColumns: [pickupOrderReasons.tenantId, pickupOrderReasons.id],
    }),
  ],
);

export const pickupOrderItems = pgTable(
  "pickup_order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    orderId: uuid("order_id").notNull(),
    productId: uuid("product_id").notNull(),
    gtin14: text("gtin14").notNull(),
    serial: text("serial").notNull(),
    rawKm: text("raw_km").notNull(),
    kmKey: text("km_key").notNull(),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }),
    voided: boolean("voided").notNull().default(false),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("pickup_order_items_order_kmkey_uq").on(t.tenantId, t.orderId, t.kmKey),
    // A physical unit can be in only ONE non-cancelled order at a time.
    uniqueIndex("pickup_order_items_tenant_kmkey_open_uq")
      .on(t.tenantId, t.kmKey)
      .where(sql`voided = false`),
    foreignKey({
      name: "pickup_order_items_tenant_order_fk",
      columns: [t.tenantId, t.orderId],
      foreignColumns: [pickupOrders.tenantId, pickupOrders.id],
    }),
    foreignKey({
      name: "pickup_order_items_tenant_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
  ],
);
```

- [ ] **Step 2: Add product columns** — in `packages/db/src/schema/platform.ts`, add `numeric` to the `drizzle-orm/pg-core` import, and add these three columns to the `products` table object (after `defaultLabelTemplateId`):

```ts
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }),
    egaisCode: text("egais_code"),
    externalRef: text("external_ref"),
```

- [ ] **Step 3: Wire schema aggregation** — add to `packages/db/src/schema.ts`:

```ts
export * from "./schema/pickup.js";
```

and add `"./src/schema/pickup.ts"` to the `schema` array in `packages/db/drizzle.config.ts`.

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @markiro/db db:generate`
Expected: a new `packages/db/migrations/00NN_*.sql` creating the enums + 8 tables + the `products` ALTER, plus a `meta/00NN_snapshot.json` and a `_journal.json` entry.

- [ ] **Step 5: Verify the generated SQL — CRITICAL partial indexes**

Open the generated `.sql`. Confirm the two partial unique indexes carry their `WHERE` clause:
- `... "pickup_order_items_tenant_kmkey_open_uq" ... ("tenant_id","km_key") WHERE voided = false;`
- `... "employee_badges_tenant_code_active_uq" ... WHERE revoked_at is null;`
- `... "kiosks_device_token_uq" ... WHERE device_token_hash is not null;`

If drizzle-kit emitted them without the `WHERE`, hand-edit the migration `.sql` to add it (partial index — the WHERE is what makes cancelled orders / revoked badges reusable). Also confirm the composite FKs reference `("tenant_id","id")` on their parents.

- [ ] **Step 6: Write the schema test** — `packages/db/test/pickup-schema.test.ts` (mirror `test/tenant-isolation.test.ts` harness: `describe.skipIf(!url)`, seed two orgs, clean up in FK order). Assert the three enforcement rules:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { createDb, schema } from "../src/index.js";

const url = process.env.DATABASE_URL;
const { organization } = schema;

describe.skipIf(!url)("pickup schema constraints", () => {
  const { db, pool } = createDb(url!);
  const org = { id: `org-${randomUUID()}`, name: "T", slug: `t-${randomUUID()}`, createdAt: new Date() };
  const empId = randomUUID();
  const kioskId = randomUUID();
  const productId = randomUUID();
  const order1 = randomUUID();
  const order2 = randomUUID();

  beforeAll(async () => {
    await db.insert(organization).values(org);
    await db.insert(schema.employees).values({ id: empId, tenantId: org.id, fullName: "Смирнов А." });
    await db.insert(schema.kiosks).values({ id: kioskId, tenantId: org.id, name: "Киоск-1" });
    await db.insert(schema.products).values({
      id: productId, tenantId: org.id, gtin14: "04650075195923", name: "Пиво",
    });
    await db.insert(schema.pickupOrders).values([
      { id: order1, tenantId: org.id, orderNo: "ORD-26-0001", kioskId, employeeId: empId, reason: "buy", itemCount: 1 },
      { id: order2, tenantId: org.id, orderNo: "ORD-26-0002", kioskId, employeeId: empId, reason: "buy", itemCount: 1 },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.pickupOrderItems).where(inArray(schema.pickupOrderItems.orderId, [order1, order2]));
    await db.delete(schema.pickupOrders).where(inArray(schema.pickupOrders.id, [order1, order2]));
    await db.delete(schema.kiosks).where(inArray(schema.kiosks.id, [kioskId]));
    await db.delete(schema.products).where(inArray(schema.products.id, [productId]));
    await db.delete(schema.employees).where(inArray(schema.employees.id, [empId]));
    await db.delete(organization).where(inArray(organization.id, [org.id]));
    await pool.end();
  });

  const item = (orderId: string) => ({
    tenantId: org.id, orderId, productId, gtin14: "04650075195923",
    serial: "KYC9X7MQ", rawKm: "raw", kmKey: "01046500751959232 1KYC9X7MQ",
    scannedAt: new Date(),
  });

  it("blocks the same km_key in a second non-cancelled order", async () => {
    await db.insert(schema.pickupOrderItems).values(item(order1));
    await expect(db.insert(schema.pickupOrderItems).values(item(order2)))
      .rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("allows the km_key again once the first item is voided", async () => {
    await db.update(schema.pickupOrderItems).set({ voided: true });
    await expect(db.insert(schema.pickupOrderItems).values(item(order2))).resolves.toBeDefined();
  });
});
```

- [ ] **Step 7: Apply + run**

Run: `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro pnpm --filter @markiro/db db:migrate`
Then: `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro pnpm --filter @markiro/db test -- pickup-schema`
Expected: migrate applies cleanly; tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/pickup.ts packages/db/src/schema/platform.ts packages/db/src/schema.ts packages/db/drizzle.config.ts packages/db/migrations packages/db/test/pickup-schema.test.ts
git commit -m "feat(db): pickup kiosk schema (employees, kiosks, orders) + product price/egais fields"
```

---

## Phase 3 — API (`apps/api`)

> Every module below copies the canonical 4-file pattern (`apps/api/src/modules/counterparties/*`): Zod schemas + `z.infer` request DTOs + response `interface`s in `dto.ts`; a service that `@Inject(DB)`, scopes every query with `and(eq(t.tenantId, tenantId), eq(t.id, id))`, and has a private `handleWriteError(error): never` branching on named FK constraints; a controller with `@ApiTags` + `@Controller` + `@UseGuards(TenantGuard)`, `@Body(new ZodValidationPipe(schema))`, reading `req.tenantId!`; a trivial `@Module`. Register each in `apps/api/src/app.module.ts` `forRoot().imports`. Each task's e2e test copies the `describe.skipIf(!ready)` + `signUpAndActivate` harness from `apps/api/test/products.e2e.test.ts`.

### Task 4: Employees module (+ badges)

**Files:**
- Create: `apps/api/src/modules/employees/dto.ts`, `employees.service.ts`, `employees.controller.ts`, `employees.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/employees.e2e.test.ts`

**Interfaces:**
- Produces routes under `/employees`: `GET /` (list, `?status=active|archived`), `POST /`, `PATCH /:id`, `DELETE /:id` (archive), `POST /:id/badges`, `DELETE /:id/badges/:badgeId`.
- Produces response DTOs consumed by admin (Task 12/14) and kiosk bootstrap (Task 8):
  ```ts
  export interface BadgeDto { id: string; badgeCode: string; label: string | null; issuedAt: Date; revokedAt: Date | null; }
  export interface EmployeeDto { id: string; fullName: string; role: string | null; status: "active" | "archived"; badges: BadgeDto[]; createdAt: Date; }
  ```

- [ ] **Step 1: Write the failing e2e test** — `apps/api/test/employees.e2e.test.ts`. Copy the full harness (`loadEnv`, `setupAuth`, `mountAuth`, `signUpAndActivate`, cookie `agent`) from `products.e2e.test.ts`, then:

```ts
it("creates an employee, issues and revokes a badge", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);

  const created = await agent.post("/employees").send({ fullName: "Смирнов Алексей", role: "оператор" }).expect(201);
  const id = created.body.id as string;
  expect(created.body.status).toBe("active");

  const withBadge = await agent.post(`/employees/${id}/badges`)
    .send({ badgeCode: "MARKIRO-BADGE-4412", label: "…4412" }).expect(201);
  const badgeId = withBadge.body.badges[0].id as string;
  expect(withBadge.body.badges).toHaveLength(1);

  // Same active code again on another employee → 409.
  const other = await agent.post("/employees").send({ fullName: "Ким Е." }).expect(201);
  await agent.post(`/employees/${other.body.id}/badges`).send({ badgeCode: "MARKIRO-BADGE-4412" }).expect(409);

  await agent.delete(`/employees/${id}/badges/${badgeId}`).expect(204);
  // After revoke the code can be reissued.
  await agent.post(`/employees/${other.body.id}/badges`).send({ badgeCode: "MARKIRO-BADGE-4412" }).expect(201);
});

it("isolates employees across tenants", async () => {
  const a = request.agent(app!.getHttpServer()); await signUpAndActivate(a);
  const b = request.agent(app!.getHttpServer()); await signUpAndActivate(b);
  const created = await a.post("/employees").send({ fullName: "A" }).expect(201);
  await b.patch(`/employees/${created.body.id}`).send({ fullName: "hax" }).expect(404);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @markiro/api test -- employees` (with `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` set — else it skips).
Expected: FAIL (404s / module missing), not skipped.

- [ ] **Step 3: Implement `dto.ts`**:

```ts
import { z } from "zod";

export const createEmployeeSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(120).nullable().optional(),
});
export type CreateEmployeeDto = z.infer<typeof createEmployeeSchema>;

export const updateEmployeeSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  role: z.string().trim().min(1).max(120).nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});
export type UpdateEmployeeDto = z.infer<typeof updateEmployeeSchema>;

export const listEmployeesQuerySchema = z.object({
  status: z.enum(["active", "archived"]).optional(),
});
export type ListEmployeesQueryDto = z.infer<typeof listEmployeesQuerySchema>;

export const issueBadgeSchema = z.object({
  badgeCode: z.string().trim().min(1).max(256),
  label: z.string().trim().min(1).max(64).nullable().optional(),
});
export type IssueBadgeDto = z.infer<typeof issueBadgeSchema>;

export interface BadgeDto { id: string; badgeCode: string; label: string | null; issuedAt: Date; revokedAt: Date | null; }
export interface EmployeeDto { id: string; fullName: string; role: string | null; status: "active" | "archived"; badges: BadgeDto[]; createdAt: Date; }
export interface ListEmployeesResponseDto { items: EmployeeDto[]; }
```

- [ ] **Step 4: Implement `employees.service.ts`** — inject `DB`; every op scoped by tenant. Aggregate active + revoked badges per employee (badges loaded and grouped in-memory). Key methods:

```ts
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type {
  BadgeDto, CreateEmployeeDto, EmployeeDto, IssueBadgeDto,
  ListEmployeesQueryDto, ListEmployeesResponseDto, UpdateEmployeeDto,
} from "./dto";

@Injectable()
export class EmployeesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listEmployees(tenantId: string, query: ListEmployeesQueryDto): Promise<ListEmployeesResponseDto> {
    const conds = [eq(schema.employees.tenantId, tenantId)];
    if (query.status) conds.push(eq(schema.employees.status, query.status));
    const rows = await this.db.select().from(schema.employees).where(and(...conds)).orderBy(schema.employees.fullName);
    const badges = await this.badgesFor(tenantId, rows.map((r) => r.id));
    return { items: rows.map((r) => this.toDto(r, badges)) };
  }

  async createEmployee(tenantId: string, dto: CreateEmployeeDto): Promise<EmployeeDto> {
    const [row] = await this.db.insert(schema.employees)
      .values({ tenantId, fullName: dto.fullName, role: dto.role ?? null }).returning();
    return this.toDto(row!, new Map());
  }

  async updateEmployee(tenantId: string, id: string, dto: UpdateEmployeeDto): Promise<EmployeeDto> {
    const set: Record<string, unknown> = {};
    if (dto.fullName !== undefined) set.fullName = dto.fullName;
    if (dto.role !== undefined) set.role = dto.role;
    if (dto.status !== undefined) set.status = dto.status;
    const [row] = await this.db.update(schema.employees).set(set)
      .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.id, id))).returning();
    if (!row) throw new NotFoundException();
    return this.toDto(row, await this.badgesFor(tenantId, [id]));
  }

  async archiveEmployee(tenantId: string, id: string): Promise<void> {
    const [row] = await this.db.update(schema.employees).set({ status: "archived" })
      .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.id, id))).returning();
    if (!row) throw new NotFoundException();
  }

  async issueBadge(tenantId: string, employeeId: string, dto: IssueBadgeDto): Promise<EmployeeDto> {
    const [emp] = await this.db.select().from(schema.employees)
      .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.id, employeeId)));
    if (!emp) throw new NotFoundException();
    try {
      await this.db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode: dto.badgeCode, label: dto.label ?? null });
    } catch (error) {
      if ((error as { cause?: { code?: string } })?.cause?.code === "23505"
        || (error as { code?: string })?.code === "23505") {
        throw new ConflictException("Badge code already in use");
      }
      throw error;
    }
    return this.toDto(emp, await this.badgesFor(tenantId, [employeeId]));
  }

  async revokeBadge(tenantId: string, employeeId: string, badgeId: string): Promise<void> {
    const [row] = await this.db.update(schema.employeeBadges).set({ revokedAt: new Date() })
      .where(and(eq(schema.employeeBadges.tenantId, tenantId), eq(schema.employeeBadges.id, badgeId),
        eq(schema.employeeBadges.employeeId, employeeId))).returning();
    if (!row) throw new NotFoundException();
  }

  private async badgesFor(tenantId: string, ids: string[]): Promise<Map<string, BadgeDto[]>> {
    const map = new Map<string, BadgeDto[]>();
    if (ids.length === 0) return map;
    const rows = await this.db.select().from(schema.employeeBadges)
      .where(eq(schema.employeeBadges.tenantId, tenantId));
    for (const b of rows) {
      if (!ids.includes(b.employeeId)) continue;
      const list = map.get(b.employeeId) ?? [];
      list.push({ id: b.id, badgeCode: b.badgeCode, label: b.label, issuedAt: b.issuedAt, revokedAt: b.revokedAt });
      map.set(b.employeeId, list);
    }
    return map;
  }

  private toDto(row: typeof schema.employees.$inferSelect, badges: Map<string, BadgeDto[]>): EmployeeDto {
    return { id: row.id, fullName: row.fullName, role: row.role, status: row.status,
      badges: badges.get(row.id) ?? [], createdAt: row.createdAt };
  }
}
```

- [ ] **Step 5: Implement `employees.controller.ts`** — `@ApiTags("employees")`, `@Controller("employees")`, `@UseGuards(TenantGuard)`; routes: `@Get()` (with `listEmployeesQuerySchema` on `@Query`), `@Post()`, `@Patch(":id")`, `@Delete(":id")` (`@HttpCode(204)` → `archiveEmployee`), `@Post(":id/badges")` (`issueBadge`), `@Delete(":id/badges/:badgeId")` (`@HttpCode(204)` → `revokeBadge`). Each passes `req.tenantId!` first. Mirror `products.controller.ts` mechanics exactly.

- [ ] **Step 6: Implement `employees.module.ts`** (controller + service) and register `EmployeesModule` in `apps/api/src/app.module.ts` `forRoot().imports`.

- [ ] **Step 7: Run the test, verify pass**

Run: `pnpm --filter @markiro/api test -- employees`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/employees apps/api/src/app.module.ts apps/api/test/employees.e2e.test.ts
git commit -m "feat(api): employees + badges module"
```

### Task 5: Kiosks module (+ allowlist + enrollment token)

**Files:**
- Create: `apps/api/src/modules/kiosks/{dto.ts,kiosks.service.ts,kiosks.controller.ts,kiosks.module.ts}`
- Create: `apps/api/src/pickup/device-token.ts` — `generateDeviceToken(): string`, `hashDeviceToken(token: string): string` (sha256)
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/kiosks.e2e.test.ts`

**Interfaces:**
- Produces routes under `/kiosks`: `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` (archive), `PUT /:id/products` (set allowlist `{ productIds: string[] }`), `POST /:id/enroll` (rotate token → returns `{ token }` plaintext ONCE).
- Produces `hashDeviceToken` consumed by `KioskDeviceGuard` (Task 7). `KioskDto`:
  ```ts
  export interface KioskDto { id: string; name: string; location: string | null; dayLimitPerEmployee: number; showPrices: boolean; status: "active" | "archived"; lastSeenAt: Date | null; enrolled: boolean; productIds: string[]; createdAt: Date; }
  ```

- [ ] **Step 1: Write `device-token.ts`** (pure, unit-testable):

```ts
import { createHash, randomBytes } from "node:crypto";
export function generateDeviceToken(): string { return randomBytes(24).toString("base64url"); }
export function hashDeviceToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
```

- [ ] **Step 2: Write the failing e2e test** — `apps/api/test/kiosks.e2e.test.ts` (harness copied). Cover: create kiosk (`enrolled=false`), set allowlist to a seeded product id, enroll returns a token and flips `enrolled=true`, and allowlist rejects a foreign-tenant product id with 400 (`kiosk_products_tenant_product_fk`). Seed products via direct `db.insert(schema.products)` like `products.e2e.test.ts` does for related rows.

```ts
it("creates a kiosk, sets its allowlist, and enrolls a device token", async () => {
  const agent = request.agent(app!.getHttpServer());
  const tenantId = await signUpAndActivate(agent);
  const productId = randomUUID();
  await db.insert(schema.products).values({ id: productId, tenantId, gtin14: "04650075195923", name: "Пиво" });

  const kiosk = await agent.post("/kiosks").send({ name: "Киоск-1", location: "Проходная", dayLimitPerEmployee: 5 }).expect(201);
  expect(kiosk.body.enrolled).toBe(false);
  const id = kiosk.body.id as string;

  const withList = await agent.put(`/kiosks/${id}/products`).send({ productIds: [productId] }).expect(200);
  expect(withList.body.productIds).toEqual([productId]);

  const enroll = await agent.post(`/kiosks/${id}/enroll`).send({}).expect(201);
  expect(typeof enroll.body.token).toBe("string");
  const after = await agent.get("/kiosks").expect(200);
  expect(after.body.items.find((k: { id: string }) => k.id === id).enrolled).toBe(true);
});
```

- [ ] **Step 3: Run it, verify it fails.** Run: `pnpm --filter @markiro/api test -- kiosks` → FAIL.

- [ ] **Step 4: Implement `dto.ts`** — `createKioskSchema` (`name` required; `location?` nullable; `dayLimitPerEmployee` int ≥1 default 5; `showPrices` bool default true), `updateKioskSchema` (all optional incl. `status`), `setKioskProductsSchema` (`{ productIds: z.array(z.string().uuid()) }`), and `KioskDto`/`ListKiosksResponseDto` interfaces per the Interfaces block.

- [ ] **Step 5: Implement `kiosks.service.ts`** — standard tenant-scoped CRUD (mirror counterparties). Specifics:
  - `toDto` sets `enrolled: row.deviceTokenHash !== null` and never returns the hash; `productIds` from a `kiosk_products` select.
  - `setProducts(tenantId, id, productIds)`: verify kiosk exists (404 else); inside a `db.transaction`, `delete` existing `kioskProducts` for `(tenantId, kioskId)`, then `insert` the new set; wrap in `handleWriteError` (a `23503` on `kiosk_products_tenant_product_fk` → `BadRequestException("Unknown product for this organization")`). Return the reloaded DTO.
  - `enroll(tenantId, id)`: verify kiosk exists; `const token = generateDeviceToken()`; `update kiosks set device_token_hash = hashDeviceToken(token)` scoped by tenant+id; return `{ token }`.

- [ ] **Step 6: Implement `kiosks.controller.ts`** (`@UseGuards(TenantGuard)`): `@Get()`, `@Post()`, `@Patch(":id")`, `@Delete(":id")` (`@HttpCode(204)` archive), `@Put(":id/products")` (`@HttpCode(200)`, body `setKioskProductsSchema`), `@Post(":id/enroll")` (returns `{ token }`). Implement `kiosks.module.ts`; register in `app.module.ts`.

- [ ] **Step 7: Run, verify pass.** Run: `pnpm --filter @markiro/api test -- kiosks` → PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/kiosks apps/api/src/pickup/device-token.ts apps/api/src/app.module.ts apps/api/test/kiosks.e2e.test.ts
git commit -m "feat(api): kiosks module with allowlist and device enrollment"
```

### Task 6: Pickup reasons module (configurable write-off sub-reasons)

**Files:**
- Create: `apps/api/src/modules/pickup-reasons/{dto.ts,pickup-reasons.service.ts,pickup-reasons.controller.ts,pickup-reasons.module.ts}`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/pickup-reasons.e2e.test.ts`

**Interfaces:**
- Produces routes under `/pickup-reasons`: `GET /` (non-archived, ordered by `sortOrder`), `POST /`, `PATCH /:id`, `DELETE /:id` (archive). `ReasonDto { id: string; name: string; sortOrder: number; }`.
- Consumed by admin (Task 15), kiosk bootstrap (Task 8), and order resolve/create validation (Task 7/9).

- [ ] **Step 1: Failing e2e test** — create three reasons, list returns them ordered, archive removes one from the list. Standard harness.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3–6: Implement** the 4 files mirroring counterparties (fields: `name` required 1..120, `sortOrder` int default 0). `listReasons` filters `eq(archived, false)` and `orderBy(sortOrder, name)`. `deleteReason` sets `archived = true` (soft — orders keep their FK). Register module.
- [ ] **Step 7: Run → PASS.**
- [ ] **Step 8: Commit** `feat(api): configurable pickup write-off reasons`.

### Task 7: Kiosk device guard + order-number helper

**Files:**
- Create: `apps/api/src/tenancy/kiosk-device.guard.ts` — `KioskDeviceGuard`, `RequestWithKiosk`
- Create: `apps/api/src/pickup/order-number.ts` — `nextOrderNo(...)`
- Test: `apps/api/test/kiosk-device.guard.test.ts` (unit, no DB), `apps/api/test/order-number.test.ts` (unit, no DB — uses a fake tx)

**Interfaces:**
- Produces:
  ```ts
  export interface RequestWithKiosk extends Request { tenantId?: string; kioskId?: string; }
  @Injectable() export class KioskDeviceGuard implements CanActivate {}
  // formats a seq + date into ORD-YY-NNNN; nextOrderNo runs the atomic upsert.
  export function formatOrderNo(seq: number, when: Date): string;
  export async function nextOrderNo(tx: DbLike, tenantId: string, when: Date): Promise<string>;
  ```

The guard reads header `x-kiosk-token`, hashes it (`hashDeviceToken`), looks up a kiosk by `device_token_hash`, sets `req.tenantId` + `req.kioskId`, and updates `last_seen_at`. Mirror `tenant.guard.ts` structure.

- [ ] **Step 1: Write `order-number.ts`** (pure format + atomic counter upsert):

```ts
import { sql } from "drizzle-orm";
import { schema } from "@markiro/db";

export function formatOrderNo(seq: number, when: Date): string {
  const yy = String(when.getUTCFullYear() % 100).padStart(2, "0");
  return `ORD-${yy}-${String(seq).padStart(4, "0")}`;
}

// Atomic per-tenant increment. Works inside a transaction handle.
export async function nextOrderNo(
  tx: { execute: (q: unknown) => Promise<{ rows: Array<{ seq: number }> }> },
  tenantId: string,
  when: Date,
): Promise<string> {
  const result = await tx.execute(sql`
    insert into ${schema.pickupOrderCounters} (tenant_id, seq) values (${tenantId}, 1)
    on conflict (tenant_id) do update set seq = ${schema.pickupOrderCounters.seq} + 1
    returning seq`);
  return formatOrderNo(result.rows[0]!.seq, when);
}
```

- [ ] **Step 2: Unit-test `formatOrderNo`** — `apps/api/test/order-number.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatOrderNo } from "../src/pickup/order-number";
describe("formatOrderNo", () => {
  it("zero-pads to 4 digits and uses the 2-digit creation year", () => {
    expect(formatOrderNo(37, new Date("2026-07-23T00:00:00Z"))).toBe("ORD-26-0037");
    expect(formatOrderNo(12345, new Date("2027-01-01T00:00:00Z"))).toBe("ORD-27-12345");
  });
});
```

Run: `pnpm --filter @markiro/api test -- order-number` → FAIL, then PASS after Step 1.

- [ ] **Step 3: Write `kiosk-device.guard.ts`**:

```ts
import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Request } from "express";
import { schema, type Db } from "@markiro/db";
import { DB } from "../auth/auth.module";
import { hashDeviceToken } from "../pickup/device-token";

export interface RequestWithKiosk extends Request { tenantId?: string; kioskId?: string; }

@Injectable()
export class KioskDeviceGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithKiosk>();
    const header = req.headers["x-kiosk-token"];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token) throw new UnauthorizedException();
    const [kiosk] = await this.db.select().from(schema.kiosks)
      .where(and(eq(schema.kiosks.deviceTokenHash, hashDeviceToken(token)), eq(schema.kiosks.status, "active")));
    if (!kiosk) throw new UnauthorizedException();
    req.tenantId = kiosk.tenantId;
    req.kioskId = kiosk.id;
    await this.db.update(schema.kiosks).set({ lastSeenAt: new Date() }).where(eq(schema.kiosks.id, kiosk.id));
    return true;
  }
}
```

- [ ] **Step 4: Unit-test the guard** — `apps/api/test/kiosk-device.guard.test.ts`, mirroring `tenant.guard.test.ts` (hand-rolled fake `Db` + `ExecutionContext`). Assert: missing header → `UnauthorizedException`; unknown token (empty select) → `UnauthorizedException`; matching kiosk → resolves `true` and sets `req.tenantId`/`req.kioskId`.

- [ ] **Step 5: Run both unit tests → PASS.**

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/tenancy/kiosk-device.guard.ts apps/api/src/pickup/order-number.ts apps/api/test/kiosk-device.guard.test.ts apps/api/test/order-number.test.ts
git commit -m "feat(api): kiosk device guard and ORD-YY-NNNN order-number helper"
```

### Task 8: Pickup orders service — kiosk create path + bootstrap

**Files:**
- Create: `apps/api/src/modules/pickup-orders/dto.ts`, `pickup-orders.service.ts`
- Create: `apps/api/src/modules/kiosk/{kiosk.controller.ts,kiosk.module.ts}` (device-facing)
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/kiosk-orders.e2e.test.ts`

**Interfaces:**
- Produces device routes (guarded by `KioskDeviceGuard`) under `/kiosk`: `GET /bootstrap` (offline cache payload), `POST /orders` (create/sync). Reads `req.tenantId!`/`req.kioskId!`.
- `PickupOrdersService.createFromKiosk(tenantId, kioskId, dto): Promise<CreateOrderResultDto>` and `.bootstrap(tenantId, kioskId): Promise<KioskBootstrapDto>` — both consumed here; `list/detail/resolve/cancel/exportCodes` come in Tasks 9–11 on the same service.
  ```ts
  export interface CreateOrderItemInput { rawKm: string; }
  export interface CreateOrderDto { deviceSeq: number; badgeCode: string; reason: "buy" | "writeoff"; writeoffReasonId?: string | null; items: CreateOrderItemInput[]; createdAt?: string; }
  export interface OrderConflict { rawKm: string; reason: "not_km" | "incomplete" | "unknown_product" | "not_allowed" | "duplicate" | "over_limit"; }
  export interface CreateOrderResultDto { orderNo: string; status: "pending"; itemCount: number; conflicts: OrderConflict[]; }
  export interface KioskBootstrapDto { config: { dayLimitPerEmployee: number; showPrices: boolean }; reasons: { id: string; name: string }[]; products: { id: string; gtin14: string; name: string; unitPrice: string | null; egaisCode: string | null }[]; employees: { id: string; fullName: string; role: string | null; badgeCodes: string[] }[]; }
  ```

Create-path server logic (authoritative; the kiosk also does a best-effort local pass in Plan B):
1. Idempotency: if an order already exists for `(tenantId, kioskId, deviceSeq)`, return it unchanged.
2. Resolve `badgeCode` → active employee (`revoked_at is null`). Unknown → `UnauthorizedException` (kiosk shows "bad badge").
3. If `reason === "writeoff"`, require a non-archived `writeoffReasonId` of this tenant (else `BadRequestException`).
4. For each item: `validatePickupKm(rawKm)`. `not_km`/`incomplete` → push conflict, skip. Resolve GTIN → a product in THIS kiosk's allowlist (`kiosk_products` ∩ `products`). Not found → conflict `unknown_product`/`not_allowed`. Dedup within the request by `kmKey`.
5. Day-limit: count this employee's non-cancelled items created "today" (UTC date of `createdAt ?? now`); if existing + accepted would exceed `dayLimitPerEmployee`, mark the overflow items `over_limit` conflicts (accept up to the limit).
6. In a `db.transaction`: `nextOrderNo`, insert `pickupOrders` (status `pending`, `itemCount`, `totalPrice` = sum of unit prices when all known else null, `deviceSeq`), insert accepted `pickupOrderItems`. A `23505` on `pickup_order_items_tenant_kmkey_open_uq` (code already in another open order, e.g. a race) → convert that item to a `duplicate` conflict and retry without it.
7. Return `{ orderNo, status, itemCount, conflicts }`.

- [ ] **Step 1: Write the failing e2e test** — `apps/api/test/kiosk-orders.e2e.test.ts`. Harness sets up a tenant via `signUpAndActivate(agent)`, then seeds an employee (+badge), a kiosk (+allowlist product), all via direct `db.insert`, and enrolls a device token via `db.update(kiosks).set({ deviceTokenHash: hashDeviceToken(TOKEN) })`. Device calls use `.set("x-kiosk-token", TOKEN)` (no cookie). Assert:

```ts
it("creates a pending order from valid KM scans and echoes the order number", async () => {
  const res = await request(app!.getHttpServer())
    .post("/kiosk/orders").set("x-kiosk-token", TOKEN)
    .send({ deviceSeq: 1, badgeCode: BADGE, reason: "buy",
      items: [{ rawKm: `01${GTIN}21KYC9X7MQ93Abcd` }] })
    .expect(201);
  expect(res.body.orderNo).toMatch(/^ORD-\d{2}-\d{4,}$/);
  expect(res.body.itemCount).toBe(1);
  expect(res.body.conflicts).toHaveLength(0);
});

it("is idempotent on (kiosk, deviceSeq)", async () => {
  const body = { deviceSeq: 7, badgeCode: BADGE, reason: "buy", items: [{ rawKm: `01${GTIN}21ZZZ193Abcd` }] };
  const a = await request(app!.getHttpServer()).post("/kiosk/orders").set("x-kiosk-token", TOKEN).send(body).expect(201);
  const b = await request(app!.getHttpServer()).post("/kiosk/orders").set("x-kiosk-token", TOKEN).send(body).expect(201);
  expect(b.body.orderNo).toBe(a.body.orderNo);
});

it("flags a code that is not in the kiosk allowlist", async () => {
  const res = await request(app!.getHttpServer()).post("/kiosk/orders").set("x-kiosk-token", TOKEN)
    .send({ deviceSeq: 2, badgeCode: BADGE, reason: "buy", items: [{ rawKm: `0199999999999994 21S193Abcd` }] }).expect(201);
  expect(res.body.conflicts[0].reason).toMatch(/unknown_product|not_allowed/);
});

it("rejects an unknown badge", async () => {
  await request(app!.getHttpServer()).post("/kiosk/orders").set("x-kiosk-token", TOKEN)
    .send({ deviceSeq: 3, badgeCode: "NOPE", reason: "buy", items: [] }).expect(401);
});

it("bootstrap returns config, reasons, allowlist products and employees with badge codes", async () => {
  const res = await request(app!.getHttpServer()).get("/kiosk/bootstrap").set("x-kiosk-token", TOKEN).expect(200);
  expect(res.body.config.dayLimitPerEmployee).toBeGreaterThan(0);
  expect(res.body.products[0].gtin14).toBe(GTIN);
  expect(res.body.employees[0].badgeCodes).toContain(BADGE);
});
```

- [ ] **Step 2: Run it → FAIL.**

- [ ] **Step 3: Implement `dto.ts`** with the schemas + interfaces from the Interfaces block: `createOrderSchema` = `z.object({ deviceSeq: z.number().int().nonnegative(), badgeCode: z.string().min(1), reason: z.enum(["buy","writeoff"]), writeoffReasonId: z.string().uuid().nullable().optional(), items: z.array(z.object({ rawKm: z.string().min(1) })), createdAt: z.string().datetime().optional() })`.

- [ ] **Step 4: Implement `pickup-orders.service.ts`** `createFromKiosk` + `bootstrap` per the logic above. Use `validatePickupKm` and `kmKey` from `@markiro/domain`; `nextOrderNo` from `../../pickup/order-number`. Product resolution query joins `kioskProducts` ∩ `products` on `(tenantId, productId)` filtered by `gtin14`. Day-limit uses `sql\`(created_at at time zone 'utc')::date = ${dateStr}\`` counting non-cancelled items for the employee.

- [ ] **Step 5: Implement `kiosk.controller.ts`** (`@ApiTags("kiosk")`, `@Controller("kiosk")`, `@UseGuards(KioskDeviceGuard)`): `@Get("bootstrap")` → `svc.bootstrap(req.tenantId!, req.kioskId!)`; `@Post("orders")` (body `createOrderSchema`) → `svc.createFromKiosk(req.tenantId!, req.kioskId!, body)`. Implement `kiosk.module.ts` (provides `PickupOrdersService`, imports nothing extra since `DB` is global); register `KioskModule` in `app.module.ts`. `PickupOrdersService` is provided by both `KioskModule` and the admin `PickupOrdersModule` (Task 9) — to avoid duplicate instances, create a shared `PickupOrdersModule` that `exports: [PickupOrdersService]` and have `KioskModule` `imports: [PickupOrdersModule]`. Build Task 9's module first if needed, or scaffold the shared module here and add admin routes in Task 9.

- [ ] **Step 6: Run → PASS.**

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/pickup-orders apps/api/src/modules/kiosk apps/api/src/app.module.ts apps/api/test/kiosk-orders.e2e.test.ts
git commit -m "feat(api): kiosk device endpoints — bootstrap and order create/sync"
```

### Task 9: Pickup orders — admin list/detail/resolve/cancel

**Files:**
- Create: `apps/api/src/modules/pickup-orders/{pickup-orders.controller.ts,pickup-orders.module.ts}` (admin, session-guarded)
- Modify: `apps/api/src/modules/pickup-orders/dto.ts` (add list/detail/resolve DTOs), `pickup-orders.service.ts` (add methods), `apps/api/src/app.module.ts`
- Test: `apps/api/test/pickup-orders.e2e.test.ts`

**Interfaces:**
- Produces admin routes under `/pickup-orders` (`@UseGuards(TenantGuard)`): `GET /` (`?status=&reason=&from=&to=`), `GET /:id` (detail with items), `POST /:id/resolve` (`{ action: "punch" | "writeoff", receiptNo?, actNo?, writeoffReasonId? }`), `POST /:id/cancel`.
  ```ts
  export interface PickupOrderRowDto { id: string; orderNo: string; employeeName: string; kioskName: string; reason: "buy" | "writeoff"; writeoffReasonName: string | null; itemCount: number; totalPrice: string | null; status: "pending" | "punched" | "writtenoff" | "cancelled"; createdAt: Date; }
  export interface PickupOrderItemDto { id: string; gtin14: string; serial: string; rawKm: string; productName: string; unitPrice: string | null; }
  export interface PickupOrderDetailDto extends PickupOrderRowDto { employeeBadgeCode: string | null; items: PickupOrderItemDto[]; receiptNo: string | null; actNo: string | null; }
  ```

- [ ] **Step 1: Failing e2e test** — create an order via the kiosk path (reuse the Task 8 seed helpers), then as the admin agent: list filters by `status=pending`/`reason=buy`; `resolve` with `action=punch, receiptNo` flips status to `punched` and sets `resolvedAt`; `cancel` on a fresh pending order flips to `cancelled` AND voids its items (assert the same code can then be re-scanned). Cross-tenant `GET /:id` → 404.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Extend `dto.ts`** — add `listPickupOrdersQuerySchema` (`status?`, `reason?`, `from?`/`to?` as `z.string().date()`), `resolvePickupOrderSchema` (`action: z.enum(["punch","writeoff"])`, `receiptNo?`, `actNo?`, `writeoffReasonId?`), and the response interfaces above.

- [ ] **Step 4: Extend `pickup-orders.service.ts`**:
  - `list(tenantId, query)`: select from `pickupOrders` with `leftJoin` employees / kiosks / pickupOrderReasons (explicit projection like `shifts.service.ts` `joinedSelection()`), conditions on status/reason/date range, `orderBy(desc(createdAt))`.
  - `detail(tenantId, id)`: order row + joined names + active badge code + items (`leftJoin` products for `productName`). 404 if missing.
  - `resolve(tenantId, id, dto, userId)`: load order; must be `pending` else `ConflictException`. `punch` → `status="punched", receiptNo, resolvedAt=now, resolvedByUserId=userId`; `writeoff` → require `writeoffReasonId` (or inherit the order's), set `status="writtenoff", actNo, writeoffReasonId, resolvedAt, resolvedByUserId`. Return updated row DTO.
  - `cancel(tenantId, id)`: in a transaction, set order `status="cancelled"` (must be `pending`) and `update pickupOrderItems set voided = true` for that order (frees the codes). Return DTO.
  - `resolvedByUserId`: thread the Better Auth user id. Add to `TenantGuard` a `req.userId = session.user.id` (small modify: set it alongside `req.tenantId`), and read `req.userId` in the controller. (Update `tenant.guard.test.ts` accordingly.)

- [ ] **Step 5: Implement `pickup-orders.controller.ts`** (admin) + `pickup-orders.module.ts` exporting `PickupOrdersService`; ensure `KioskModule` (Task 8) imports it. Register `PickupOrdersModule` in `app.module.ts`.

- [ ] **Step 6: Run → PASS.**

- [ ] **Step 7: Commit** `feat(api): pickup orders admin list/detail/resolve/cancel`.

### Task 10: Bulk code export (txt UTF-8)

**Files:**
- Modify: `apps/api/src/modules/pickup-orders/{dto.ts,pickup-orders.service.ts,pickup-orders.controller.ts}`
- Test: `apps/api/test/pickup-export.e2e.test.ts`

**Interfaces:**
- Produces `POST /pickup-orders/export` (`{ orderIds: string[] }`) → `text/plain; charset=utf-8`, one `raw_km` per line (GS byte preserved), `Content-Disposition: attachment; filename="codes-YYYYMMDD.txt"`.
- `PickupOrdersService.exportCodes(tenantId, orderIds): Promise<string>`.

- [ ] **Step 1: Failing e2e test** — create two orders, `POST /pickup-orders/export` with both ids, assert the response body has one line per item and the content-type is `text/plain`. Cross-tenant ids are silently excluded (only same-tenant items exported).

```ts
const res = await agent.post("/pickup-orders/export").send({ orderIds: [id1, id2] })
  .expect(200).expect("Content-Type", /text\/plain/);
expect(res.text.split("\n").filter(Boolean).length).toBe(totalItems);
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `exportCodes` — select `rawKm` from `pickupOrderItems` where `tenantId` = tenant AND `orderId in orderIds` (ids not belonging to the tenant contribute nothing), ordered by `orderId, scannedAt`; `return rows.map(r => r.rawKm).join("\n")`. Add `exportPickupCodesSchema = z.object({ orderIds: z.array(z.string().uuid()).min(1) })`.

- [ ] **Step 4: Implement the controller route** — `@Post("export")` `@HttpCode(200)`, inject `@Res({ passthrough: true }) res`, set headers and return the string:

```ts
@Post("export")
@HttpCode(200)
async export(@Req() req: RequestWithTenant, @Res({ passthrough: true }) res: Response,
  @Body(new ZodValidationPipe(exportPickupCodesSchema)) body: ExportPickupCodesDto): Promise<string> {
  const txt = await this.service.exportCodes(req.tenantId!, body.orderIds);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="codes-${stamp}.txt"`);
  return txt;
}
```

- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Commit** `feat(api): bulk pickup code export (txt/utf-8)`.

### Task 11: Printed slip (A4 HTML)

**Files:**
- Create: `apps/api/src/pickup/slip.ts` — `renderPickupSlipHtml(data): string`
- Modify: `apps/api/src/modules/pickup-orders/{pickup-orders.service.ts,pickup-orders.controller.ts}`
- Test: `apps/api/test/pickup-slip.e2e.test.ts`, `apps/api/test/slip.test.ts` (unit, no DB)

**Interfaces:**
- Produces `GET /pickup-orders/:id/slip` → `text/html; charset=utf-8` — a print-ready A4 page (mirrors `prototypes/pickup-slip.dc.html`) with per-item DataMatrix (13mm), a badge QR (22mm), and a Code128 of the order number in the footer. `renderPickupSlipHtml(data: PickupSlipData): string` is pure (unit-tested); `PickupOrdersService.slipData(tenantId, id)` gathers the data.

- [ ] **Step 1: Unit-test the pure renderer** — `apps/api/test/slip.test.ts`: feed a `PickupSlipData` fixture with 2 items, assert the HTML contains the order number, both product names, three `<svg` occurrences minimum (2 DataMatrix + 1 Code128), and `@page` A4 CSS.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `slip.ts`** — a template string building the A4 document. Use `renderDataMatrixSvg(item.rawKm)`, `renderQrSvg(badgeCode)`, `renderCode128Svg(orderNo)` from `@markiro/domain`. Structure/labels from the prototype (organization / employee / order blocks; KM table; "Способ вывода из оборота" block; signatures; footer with the Code128). Inline styles + a `<style>@page { size: A4; margin: 0 }</style>` head; no external assets.

- [ ] **Step 4: Implement `slipData` + controller route** — `@Get(":id/slip")`, gather order + items + employee active badge + org profile (`schema.orgProfiles`), `res.setHeader("Content-Type", "text/html; charset=utf-8")`, return `renderPickupSlipHtml(...)`. e2e test asserts 200 + `text/html` + body contains the order number.

- [ ] **Step 5: Run both tests → PASS.**
- [ ] **Step 6: Commit** `feat(api): printed pickup slip (A4 HTML with DataMatrix/QR/Code128)`.

### Task 12: Product price / EGAIS fields in the products API

**Files:**
- Modify: `apps/api/src/modules/products/dto.ts`, `products.service.ts`
- Test: extend `apps/api/test/products.e2e.test.ts`

**Interfaces:** adds `unitPrice` (string decimal or null), `egaisCode` (string or null), `externalRef` (string or null) to create/update schemas, the `ProductDto`, and the service insert/update/`rowToDto`.

- [ ] **Step 1: Failing test** — extend `products.e2e.test.ts`: create a product with `unitPrice: "52.00"`, `egaisCode: "0123..."`; GET returns them; PATCH `unitPrice: null` clears it.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in `dto.ts` add to both schemas `unitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional()`, `egaisCode: z.string().trim().min(1).max(64).nullable().optional()`, `externalRef: z.string().trim().min(1).max(200).nullable().optional()`; add to `ProductDto`. In `products.service.ts` map them in insert/update (`?? null`) and `rowToDto`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(api): product unit price, EGAIS code, external ref`.

---

## Phase 4 — Admin panel (`apps/admin`)

> Each page mirrors an existing one: list = `pages/counterparties/index.tsx` (or `catalog/index.tsx` for filters + StatusChip); forms = `CounterpartyForm.tsx` (RHF + zodResolver in a `Modal`, `errorProp` spread, i18n error keys); data = `pages/<x>/api.ts` (TanStack Query over `apiFetch`, list responses unwrap `.items`). All new strings go into BOTH `ru.json` and `en.json` under `pages.<page>` + `nav.<page>` (missing keys throw in tests). Tests stub global `fetch` (`vi.stubGlobal`) per `test/catalog.test.tsx`.

### Task 13: Admin API layer + i18n scaffolding for «Для себя»

**Files:**
- Create: `apps/admin/src/pages/pickup/api.ts`, `apps/admin/src/pages/employees/api.ts`, `apps/admin/src/pages/kiosks/api.ts`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/pickup-api.test.tsx`

**Interfaces:** hand-mirrored DTO interfaces (from each API `dto.ts`) + query/mutation hooks: `usePickupOrders(params)`, `usePickupOrder(id)`, `useResolveOrder()`, `useCancelOrder()`, `useExportCodes()`, `usePendingOrderCount()`, `useEmployees()`/`useCreateEmployee()`/…/`useIssueBadge()`/`useRevokeBadge()`, `useKiosks()`/…/`useSetKioskProducts()`/`useEnrollKiosk()`, `usePickupReasons()`/CRUD.

- [ ] **Step 1: Write the failing test** — `pickup-api.test.tsx`: render a tiny probe component using `usePickupOrders({ status: "pending" })` inside a `QueryClientProvider`, stub `fetch` to return `{ items: [ORDER] }`, assert the hook surfaces the row and the request path is `/api/pickup-orders?status=pending`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement the three `api.ts` files** following `counterparties/api.ts` (+ `catalog/api.ts` `buildListPath` for query params). Export the DTO interfaces + hooks. `useExportCodes` posts to `/pickup-orders/export` and triggers a browser download from the returned text (Blob + `URL.createObjectURL`). `usePendingOrderCount` derives from `usePickupOrders({ status: "pending" })` (`.length`).
- [ ] **Step 4: Add i18n blocks** — `pages.pickup`, `pages.employees`, `pages.kiosks`, and `nav.pickup`/`nav.employees`/`nav.kiosks` in both JSONs (mirror the counterparties block shape: `title`, `emptyTitle/Hint`, `addAction`, table/form/toasts/status/filters sub-objects). Keep RU and EN key-parallel.
- [ ] **Step 5: Run → PASS.** Also run `pnpm --filter @markiro/admin test -- i18n` to confirm key parity.
- [ ] **Step 6: Commit** `feat(admin): pickup/employees/kiosks api hooks and i18n`.

### Task 14: «Для себя» orders list (свод) + filters + bulk export + nav badge

**Files:**
- Create: `apps/admin/src/pages/pickup/index.tsx`
- Modify: `apps/admin/src/app.tsx` (route `pickup`), `apps/admin/src/layout/AppShell.tsx` (nav item + pending badge)
- Test: `apps/admin/test/pickup.test.tsx`

- [ ] **Step 1: Failing test** — stub `fetch` for `/api/pickup-orders...` returning two orders; assert both render in the table; changing the status `Select` to "pending" refetches with `?status=pending`; clicking "Выгрузить коды" after selecting rows posts to `/api/pickup-orders/export`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `pages/pickup/index.tsx`** — `PageHeader` + a filter toolbar (`Select` status: Все/Ожидают/Пробиты/Списаны/Отменены; `Select` reason: Все/Покупка/Списание; two `<Input type="date">` from/to) feeding `usePickupOrders(params)` via conditional spread; the standard `isPending/isError/empty/Table` ternary. Columns: orderNo (mono), employeeName, kioskName, createdAt, itemCount, totalPrice, `StatusChip` (map pending→warn, punched→ok, writtenoff→neutral, cancelled→error), and a row link to `/pickup/:id`. A "Массовая выгрузка" toggle reveals a selection checkbox column + a "Выгрузить коды" `Button` calling `useExportCodes()` with the checked ids.
- [ ] **Step 4: Wire route + nav** — add `<Route path="pickup" element={<PickupPage />} />` and `<Route path="pickup/:id" element={<OrderDetailPage />} />` (detail comes in Task 15) in `app.tsx`; add `{ to: "/pickup", key: "nav.pickup" }` to `NAV_ITEMS` in `AppShell.tsx` and set its `badge` from `usePendingOrderCount()` via the conditional-spread pattern.
- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Commit** `feat(admin): pickup orders list with filters, bulk export, nav badge`.

### Task 15: Order detail card + resolve/cancel/print actions

**Files:**
- Create: `apps/admin/src/pages/pickup/OrderDetail.tsx`
- Modify: `apps/admin/src/app.tsx` (already routed in Task 14)
- Test: `apps/admin/test/pickup-detail.test.tsx`

- [ ] **Step 1: Failing test** — stub `fetch` for `/api/pickup-orders/:id` returning a pending order with 2 items; assert names/codes render; clicking "Пробита на кассе" opens a receipt-number modal and posts `/api/pickup-orders/:id/resolve` with `{ action: "punch", receiptNo }`; "Отменить" posts `/cancel`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `OrderDetail.tsx`** — `useParams()` id + `usePickupOrder(id)`; a `Card` header (orderNo, employee, kiosk, reason, createdAt, total); an items `Table` rendering each item's DataMatrix inline via `renderDataMatrixSvg(item.rawKm)` from `@markiro/domain` (`dangerouslySetInnerHTML` of the SVG string, 64px box), full `rawKm` in mono, unit price. Action bar: `Button` "Пробита на кассе" (primary → receipt modal → `useResolveOrder({action:"punch"})`), "Списать актом" (→ act-number + reason `Select` modal → `useResolveOrder({action:"writeoff"})`), "Печать" (`window.open('/api/pickup-orders/'+id+'/slip')`), "Отменить" (`useCancelOrder`). Actions disabled unless status `pending`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(admin): pickup order detail with resolve/cancel/print`.

### Task 16: Employees management page

**Files:**
- Create: `apps/admin/src/pages/employees/index.tsx`, `EmployeeForm.tsx`
- Modify: `apps/admin/src/app.tsx` (route), `apps/admin/src/layout/AppShell.tsx` (nav item)
- Test: `apps/admin/test/employees.test.tsx`

- [ ] **Step 1: Failing test** — list renders mocked employees; create submits `POST /api/employees`; issuing a badge submits `POST /api/employees/:id/badges`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — list page mirroring `counterparties/index.tsx` (Table: fullName, role, status StatusChip, badge count, actions edit/archive). `EmployeeForm.tsx` (RHF+zod: `fullName` required, `role` optional). A badge sub-panel in the edit modal: list active badges with a revoke `Button` (`useRevokeBadge`) and an "issue badge" `Input` + `Button` (`useIssueBadge`) — the `badgeCode` field is where the physical badge would be scanned in production. Wire route + `nav.employees`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(admin): employees management with badge issue/revoke`.

### Task 17: Kiosk settings page + reasons editor

**Files:**
- Create: `apps/admin/src/pages/kiosks/index.tsx`, `KioskForm.tsx`, `ReasonsEditor.tsx`
- Modify: `apps/admin/src/app.tsx` (route), `apps/admin/src/layout/AppShell.tsx` (nav item)
- Test: `apps/admin/test/kiosks.test.tsx`

- [ ] **Step 1: Failing test** — list renders mocked kiosks with online status; create submits `POST /api/kiosks`; "Выдать токен" posts `/enroll` and shows the returned token once; the reasons editor adds a reason via `POST /api/pickup-reasons`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — list page (Table: name, location, online StatusChip from `lastSeenAt` recency, limit, showPrices). `KioskForm.tsx` (name, location, `dayLimitPerEmployee` number, `showPrices` checkbox, and a multi-select allowlist of active products → `useSetKioskProducts`). An "Выдать токен" action calls `useEnrollKiosk` and surfaces the one-time token in a `Modal` with copy. `ReasonsEditor.tsx` — a small inline CRUD list over `usePickupReasons` (add/rename/reorder via `sortOrder`/archive). Wire route + `nav.kiosks` (or nest under a "Settings" area if preferred — follow `pages/settings` if it groups sub-sections).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(admin): kiosk settings, allowlist, enrollment, reasons editor`.

### Task 18: Product form — price & EGAIS fields

**Files:**
- Modify: `apps/admin/src/pages/catalog/ProductForm.tsx`, `apps/admin/src/i18n/{ru,en}.json`
- Test: extend `apps/admin/test/catalog.test.tsx`

- [ ] **Step 1: Failing test** — the product form renders "Цена за шт., ₽" and "Код ЕГАИС" inputs; submitting includes `unitPrice`/`egaisCode` in the POST body.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — add two `Input`s to `ProductForm.tsx` (price: `inputMode="decimal"`, validated by a `z.string().regex(/^\d+([.,]\d{1,2})?$/)` refine, normalized `,`→`.` in `toCreateInput`; EGAIS: free text, optional). Add the i18n keys to both JSONs. Map into the create/update payload.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(admin): product price and EGAIS fields`.

---

## Final Verification

- [ ] Run the full gate: `pnpm turbo lint typecheck test build` (with `DATABASE_URL`/`BETTER_AUTH_*` set so API/DB e2e tests execute, not skip).
- [ ] Confirm `/docs` (Scalar) lists the new tags: `employees`, `kiosks`, `pickup-reasons`, `pickup-orders`, `kiosk`.
- [ ] Manual smoke (dev servers): create an employee + badge, a kiosk + allowlist + token; `POST /kiosk/orders` with the token and a valid KM; see the order in «Для себя»; resolve it; print the slip; bulk-export codes.

## Self-Review (completed while writing)

- **Spec coverage:** domain guard (§7 → Task 1); barcodes/bwip-js (§5/§11 → Task 2); all tables incl. counter + product fields (§6/§13 → Task 3, 12, 18); employees/badges shared foundation (§4/§6 → Task 4, 16); kiosks + allowlist + enrollment + reasons (§6/§9/§10 → Task 5, 6, 17); device auth (§8/§9 → Task 7); kiosk bootstrap + create/sync with dedup/limit/idempotency (§8/§9 → Task 8); admin list+filters/detail/resolve/cancel (§10 → Task 9, 14, 15); bulk export (§12 → Task 10, 14); slip (§11 → Task 11, 15); nav badge (§10 → Task 14). Kiosk offline queue + app (Plan B) intentionally excluded.
- **Type consistency:** `PickupKmResult`, `validatePickupKm`, `formatOrderNo`/`nextOrderNo`, `EmployeeDto`/`BadgeDto`, `KioskDto`, `CreateOrderDto`/`CreateOrderResultDto`/`OrderConflict`, `PickupOrderRowDto`/`PickupOrderDetailDto`, `hashDeviceToken` are defined once (Tasks 1/7/4/5/8/9) and referenced consistently.
- **Assumptions carried from spec §16:** GS preserved literally in txt export (Task 10); no yearly reset of the order counter (Task 3/7); bwip-js placed in `packages/domain` (Task 2); unknown-vs-not-allowed both surface as `OrderConflict` reasons for the red modal (Task 8).
