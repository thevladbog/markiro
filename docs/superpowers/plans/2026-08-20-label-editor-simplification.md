# Label Editor Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the visual (canvas) label editor from the admin app in favour of a settings-form + code-import workflow, add `product.egais` and `expiry` label fields (backed by a new `products.shelf_life_days`), and seed five default box-label templates to every tenant.

**Architecture:** The language-neutral `LabelTemplateSpec` (jsonb) stays the single source of truth; pasted ZPL/TSPL is parsed into it and the station keeps generating print code in its own configured printer language. The admin editor page loses the interactive canvas/palette/properties trio and becomes a metadata form + `ImportCodeDialog` + read-only `PreviewPane`. Defaults are tenant-owned rows created at provisioning and backfilled by a data migration.

**Tech Stack:** TypeScript monorepo (pnpm + turbo). Domain: zod. API: NestJS + Drizzle/Postgres. Admin: React 19 + Vite + TanStack Query + react-hook-form + vitest/RTL. Station: React + Tauri + local SQLite (`STATION_MIGRATIONS`).

**Spec:** `docs/superpowers/specs/2026-08-20-label-editor-simplification-design.md`

## Global Constraints

- Label spec model stays `LabelTemplateSpec` (`packages/domain/src/labels/model.ts`); no per-language code blobs are stored.
- New label fields, exact ids: `product.egais`, `expiry`. `LABEL_FIELDS` order after the change: `product.name, product.gtin, product.egais, km.code, sscc, shift.no, date, expiry, qty, operator, counterparty.name`.
- Expiry = production date (`closedAt.slice(0,10)`) + `products.shelf_life_days`; empty string when shelf life is null/invalid — never a print failure.
- Default template names (exact, used as the idempotency key): `Коробка 58×40 (203 dpi)`, `Коробка 58×40 (300 dpi)`, `Коробка 75×120 (203 dpi)`, `Коробка 100×100 (203 dpi)`, `Коробка 100×150 (203 dpi)`.
- The visual editor is deleted, not feature-flagged. `renderer.ts`/`geometry.ts` move from `apps/admin/src/pages/labels/editor/` to `apps/admin/src/pages/labels/`.
- `/label-templates` API contract, permissions, and the `labelEditor` entitlement are unchanged.
- Postgres migrations are generated with drizzle-kit (`0046` schema, `0047` data); station SQLite changes go into `STATION_MIGRATIONS` as trailing re-runnable `ALTER TABLE`s plus `packages/db/src/sqlite/schema.ts`.
- Admin i18n: every key added/removed in BOTH `apps/admin/src/i18n/en.json` and `ru.json` (an i18n parity test exists).
- DB-backed test suites (packages/db, apps/api) need `DATABASE_URL` exported (shared local Postgres).
- Commit after every task; conventional-commit messages as given per task.

---

### Task 1: Domain — `product.egais` and `expiry` label fields

**Files:**

- Modify: `packages/domain/src/labels/model.ts`
- Modify: `packages/domain/test/labels-import.test.ts` (contract test, ~line 15)
- Modify: `apps/admin/src/pages/labels/editor/ImportCodeDialog.tsx` (`FIELD_COPY_KEYS`, ~line 29)
- Modify: `apps/admin/src/i18n/en.json`, `apps/admin/src/i18n/ru.json` (`pages.labels.editor.fields`)
- Modify: `apps/station/src/lib/box-label.ts` (compile-only stub values; real values in Task 8)

**Interfaces:**

- Produces: `LabelField` union now includes `"product.egais"` and `"expiry"`; `sampleLabelData()` returns values for them. Every `Record<LabelField, string>` in the repo must carry the new keys.

- [ ] **Step 1: Update the field-inventory contract test to the new expectation (failing first)**

In `packages/domain/test/labels-import.test.ts` replace the array inside the `"exports one canonical ordered label-field inventory"` test:

```ts
expect(LABEL_FIELDS).toEqual([
  "product.name",
  "product.gtin",
  "product.egais",
  "km.code",
  "sscc",
  "shift.no",
  "date",
  "expiry",
  "qty",
  "operator",
  "counterparty.name",
]);
```

Also add a placeholder acceptance case to the `"recognizes only an exact known field placeholder"` test:

```ts
expect(parseTemplatePayload("{{product.egais}}", 9)).toEqual({
  kind: "field",
  field: "product.egais",
});
expect(parseTemplatePayload("{{expiry}}", 10)).toEqual({ kind: "field", field: "expiry" });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @markiro/domain test -- labels-import`
Expected: FAIL — array mismatch and `LABEL_CODE_INVALID` for the new placeholders.

- [ ] **Step 3: Extend `LABEL_FIELDS` and `sampleLabelData` in `packages/domain/src/labels/model.ts`**

```ts
export const LABEL_FIELDS = [
  "product.name",
  "product.gtin",
  "product.egais",
  "km.code",
  "sscc",
  "shift.no",
  "date",
  "expiry",
  "qty",
  "operator",
  "counterparty.name",
] as const;
```

In `sampleLabelData()` add (keeping the existing entries; `expiry` formatted exactly like `date`):

```ts
    "product.egais": "0101234567890123456",
    expiry: "2027-01-19",
```

- [ ] **Step 4: Fix the exhaustive `Record<LabelField, …>` consumers so the repo compiles**

`apps/admin/src/pages/labels/editor/ImportCodeDialog.tsx`, `FIELD_COPY_KEYS` — add:

```ts
  "product.egais": "product.egais",
  expiry: "expiry",
```

`apps/station/src/lib/box-label.ts`, inside the object `boxLabelFields` returns (temporary empty values, replaced with real ones in Task 8):

```ts
    "product.egais": "",
    expiry: "",
```

i18n `pages.labels.editor.fields` — `en.json`:

```json
"product.egais": "EGAIS code",
"expiry": "Best before"
```

`ru.json`:

```json
"product.egais": "Код ЕГАИС",
"expiry": "Годен до"
```

Then hunt any remaining exhaustive sites: `grep -rn "Record<LabelField" packages apps` and fix the same way (expected hits: `model.ts`, `box-label.ts`, `ImportCodeDialog.tsx`, emitter signatures which are lookups and need no change).

- [ ] **Step 5: Run domain tests and the affected typechecks**

Run: `pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain typecheck && pnpm --filter admin typecheck && pnpm --filter station typecheck`
(Substitute the actual package names from `apps/admin/package.json` / `apps/station/package.json` if they differ — use `cat apps/admin/package.json | head -3`.)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/domain apps/admin/src apps/station/src
git commit -m "feat(domain): add product.egais and expiry label fields"
```

---

### Task 2: Domain — default box-label template module

**Files:**

- Create: `packages/domain/src/labels/defaults.ts`
- Modify: `packages/domain/src/index.ts` (exports)
- Test: `packages/domain/test/labels-defaults.test.ts` (create)

**Interfaces:**

- Produces: `buildDefaultLabelTemplates(): DefaultLabelTemplate[]` where `DefaultLabelTemplate = { name: string; spec: LabelTemplateSpec }`, and `DEFAULT_BOX_LABEL_TEMPLATE_NAME = "Коробка 58×40 (203 dpi)"`. Consumed by Task 4 (migration SQL generation + drift test) and Task 7 (provisioning).

- [ ] **Step 1: Write the failing test `packages/domain/test/labels-defaults.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  buildDefaultLabelTemplates,
  generateTspl,
  generateZpl,
  parseLabelTemplate,
  sampleLabelData,
  type RasterResult,
  type RasterizeTextFn,
} from "../src/index.js";

const FAKE_RASTER: RasterResult = {
  hex: "00",
  totalBytes: 1,
  bytesPerRow: 1,
  width: 8,
  height: 1,
};

describe("buildDefaultLabelTemplates", () => {
  it("returns the five stock box labels with the exact seed names", () => {
    const templates = buildDefaultLabelTemplates();
    expect(templates.map((t) => t.name)).toEqual([
      "Коробка 58×40 (203 dpi)",
      "Коробка 58×40 (300 dpi)",
      "Коробка 75×120 (203 dpi)",
      "Коробка 100×100 (203 dpi)",
      "Коробка 100×150 (203 dpi)",
    ]);
    expect(DEFAULT_BOX_LABEL_TEMPLATE_NAME).toBe("Коробка 58×40 (203 dpi)");
    expect(templates.map((t) => [t.spec.widthMm, t.spec.heightMm, t.spec.dpi])).toEqual([
      [58, 40, 203],
      [58, 40, 300],
      [75, 120, 203],
      [100, 100, 203],
      [100, 150, 203],
    ]);
  });

  it("every spec validates and mirrors the approved mock-up layout", () => {
    for (const { spec } of buildDefaultLabelTemplates()) {
      expect(() => parseLabelTemplate(spec)).not.toThrow();
      const kindsByField = new Map(
        spec.elements.filter((el) => el.kind === "field").map((el) => [el.field, el] as const),
      );
      for (const field of ["product.name", "date", "expiry", "qty", "product.egais"] as const) {
        expect(kindsByField.has(field), `missing field ${field}`).toBe(true);
      }
      const barcode = spec.elements.find((el) => el.kind === "barcode");
      expect(barcode).toMatchObject({ format: "code128", data: "sscc" });
      // Every element starts inside the physical label.
      for (const el of spec.elements) {
        expect(el.xMm).toBeGreaterThanOrEqual(0);
        expect(el.yMm).toBeGreaterThanOrEqual(0);
        expect(el.xMm).toBeLessThanOrEqual(spec.widthMm);
        expect(el.yMm).toBeLessThanOrEqual(spec.heightMm);
      }
    }
  });

  it("every spec emits both ZPL and TSPL with sample data without throwing", async () => {
    const rasterizeText: RasterizeTextFn = vi.fn(async () => ({ ...FAKE_RASTER }));
    for (const { spec } of buildDefaultLabelTemplates()) {
      const zpl = await generateZpl(spec, sampleLabelData(), { rasterizeText });
      expect(zpl.startsWith("^XA")).toBe(true);
      const tspl = await generateTspl(spec, sampleLabelData(), { rasterizeText });
      expect(tspl.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic (two calls produce deep-equal output)", () => {
    expect(buildDefaultLabelTemplates()).toEqual(buildDefaultLabelTemplates());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @markiro/domain test -- labels-defaults`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/domain/src/labels/defaults.ts`**

```ts
import type { LabelTemplateSpec } from "./model.js";

/** One stock template: seed name (the idempotency key) + its spec. */
export interface DefaultLabelTemplate {
  name: string;
  spec: LabelTemplateSpec;
}

/** The stock template new tenants get as their default box label. */
export const DEFAULT_BOX_LABEL_TEMPLATE_NAME = "Коробка 58×40 (203 dpi)";

const BASE_WIDTH_MM = 58;
const BASE_HEIGHT_MM = 40;

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function pt(base: number, scale: number): number {
  return Math.min(72, Math.max(4, Math.round(base * scale)));
}

/**
 * The approved mock-up layout (58×40 base), scaled uniformly to the target
 * size and anchored top-left. Separator lines and the three-column block use
 * the label's ACTUAL width, so wide labels don't leave a dead right margin.
 * Larger sizes keep the same structure with proportionally larger type.
 */
function buildBoxLabelSpec(widthMm: number, heightMm: number, dpi: 203 | 300): LabelTemplateSpec {
  const s = Math.min(widthMm / BASE_WIDTH_MM, heightMm / BASE_HEIGHT_MM);
  const m = round1(2 * s);
  const right = round1(widthMm - m);
  const contentW = round1(widthMm - 2 * m);
  const colW = round1(contentW / 3);
  const cols = [m, round1(m + colW), round1(m + 2 * colW)];
  const thickness = round1(Math.max(0.2, 0.3 * s));
  const captionPt = pt(5, s);
  const valuePt = pt(8, s);
  const namePt = pt(10, s);
  return {
    widthMm,
    heightMm,
    dpi,
    language: "zpl",
    elements: [
      {
        kind: "field",
        id: "name",
        xMm: m,
        yMm: m,
        field: "product.name",
        fontSizePt: namePt,
        bold: true,
        maxWidthMm: contentW,
      },
      {
        kind: "line",
        id: "sep1",
        xMm: m,
        yMm: round1(13 * s),
        x2Mm: right,
        y2Mm: round1(13 * s),
        thicknessMm: thickness,
      },
      {
        kind: "text",
        id: "cap-date",
        xMm: cols[0]!,
        yMm: round1(14.5 * s),
        text: "Дата производства:",
        fontSizePt: captionPt,
        maxWidthMm: colW,
      },
      {
        kind: "text",
        id: "cap-expiry",
        xMm: cols[1]!,
        yMm: round1(14.5 * s),
        text: "Годен до:",
        fontSizePt: captionPt,
        maxWidthMm: colW,
      },
      {
        kind: "text",
        id: "cap-qty",
        xMm: cols[2]!,
        yMm: round1(14.5 * s),
        text: "Кол-во в упаковке:",
        fontSizePt: captionPt,
        maxWidthMm: colW,
      },
      {
        kind: "field",
        id: "val-date",
        xMm: cols[0]!,
        yMm: round1(18 * s),
        field: "date",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: colW,
      },
      {
        kind: "field",
        id: "val-expiry",
        xMm: cols[1]!,
        yMm: round1(18 * s),
        field: "expiry",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: colW,
      },
      {
        kind: "field",
        id: "val-qty",
        xMm: cols[2]!,
        yMm: round1(18 * s),
        field: "qty",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: colW,
      },
      {
        kind: "line",
        id: "sep2",
        xMm: m,
        yMm: round1(23.5 * s),
        x2Mm: right,
        y2Mm: round1(23.5 * s),
        thicknessMm: thickness,
      },
      {
        kind: "text",
        id: "cap-egais",
        xMm: m,
        yMm: round1(25 * s),
        text: "Код ЕГАИС:",
        fontSizePt: captionPt,
        maxWidthMm: contentW,
      },
      {
        kind: "field",
        id: "val-egais",
        xMm: m,
        yMm: round1(28 * s),
        field: "product.egais",
        fontSizePt: valuePt,
        bold: true,
        maxWidthMm: contentW,
      },
      {
        kind: "line",
        id: "sep3",
        xMm: m,
        yMm: round1(32.5 * s),
        x2Mm: right,
        y2Mm: round1(32.5 * s),
        thicknessMm: thickness,
      },
      {
        kind: "text",
        id: "cap-sscc",
        xMm: m,
        yMm: round1(33.5 * s),
        text: "SSCC:",
        fontSizePt: captionPt,
        maxWidthMm: contentW,
      },
      {
        kind: "barcode",
        id: "bc-sscc",
        xMm: m,
        yMm: round1(36 * s),
        format: "code128",
        data: "sscc",
        sizeMm: round1(Math.max(3, 3.5 * s)),
      },
    ],
  };
}

/** The five stock box labels seeded to tenants. Pure and deterministic. */
export function buildDefaultLabelTemplates(): DefaultLabelTemplate[] {
  return [
    { name: "Коробка 58×40 (203 dpi)", spec: buildBoxLabelSpec(58, 40, 203) },
    { name: "Коробка 58×40 (300 dpi)", spec: buildBoxLabelSpec(58, 40, 300) },
    { name: "Коробка 75×120 (203 dpi)", spec: buildBoxLabelSpec(75, 120, 203) },
    { name: "Коробка 100×100 (203 dpi)", spec: buildBoxLabelSpec(100, 100, 203) },
    { name: "Коробка 100×150 (203 dpi)", spec: buildBoxLabelSpec(100, 150, 203) },
  ];
}
```

Add to `packages/domain/src/index.ts` next to the other label exports:

```ts
export { DEFAULT_BOX_LABEL_TEMPLATE_NAME, buildDefaultLabelTemplates } from "./labels/defaults.js";
export type { DefaultLabelTemplate } from "./labels/defaults.js";
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @markiro/domain test -- labels-defaults && pnpm --filter @markiro/domain typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): stock box-label templates (buildDefaultLabelTemplates)"
```

---

### Task 3: DB (Postgres) — `products.shelf_life_days`

**Files:**

- Modify: `packages/db/src/schema/platform.ts` (products table, after `egaisCode` ~line 75)
- Create (generated): `packages/db/migrations/0046_product_shelf_life_days.sql` + meta updates
- Test: `packages/db/test/schema.test.ts` (extend if it asserts the products column set — inspect first)

**Interfaces:**

- Produces: `schema.products.shelfLifeDays` (`integer`, nullable) for Tasks 5–7.

- [ ] **Step 1: Add the column to `packages/db/src/schema/platform.ts`**

After `egaisCode: text("egais_code"),`:

```ts
    // Product shelf life in days; the station computes the box label's
    // «Годен до» as production date + this. Null = the label field prints empty.
    shelfLifeDays: integer("shelf_life_days"),
```

(`integer` is already imported in that file; verify with `grep -n "integer" packages/db/src/schema/platform.ts | head -1`.)

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @markiro/db exec drizzle-kit generate --name=product_shelf_life_days`
Expected: creates `packages/db/migrations/0046_product_shelf_life_days.sql` containing exactly:

```sql
ALTER TABLE "products" ADD COLUMN "shelf_life_days" integer;
```

plus a new `meta/0046_snapshot.json` and a `_journal.json` entry (idx 46). If the generated file contains anything else, the schema edit was wrong — fix and regenerate.

- [ ] **Step 3: Run db tests**

Run: `pnpm --filter @markiro/db test`
Expected: PASS (extend `schema.test.ts` if it enumerates product columns and now fails — add `shelf_life_days` to its expectation).

- [ ] **Step 4: Commit**

```bash
git add packages/db
git commit -m "feat(db): products.shelf_life_days column"
```

---

### Task 4: DB — backfill migration seeding the five default templates

**Files:**

- Create (generated shell): `packages/db/migrations/0047_default_label_templates.sql`
- Test: `packages/db/test/default-label-templates-migration.test.ts` (create)
- Test: `packages/domain/test/labels-defaults.test.ts` (add the SQL drift test)

**Interfaces:**

- Consumes: `buildDefaultLabelTemplates()` (Task 2) — its JSON is inlined into the SQL.
- Produces: every existing tenant gains any of the five templates it doesn't already have (by name). Does NOT touch `org_profiles`.

- [ ] **Step 1: Generate the custom migration shell**

Run: `pnpm --filter @markiro/db exec drizzle-kit generate --custom --name=default_label_templates`
Expected: empty `packages/db/migrations/0047_default_label_templates.sql` + journal entry idx 47.

- [ ] **Step 2: Emit the VALUES rows from the domain module**

```bash
pnpm --filter @markiro/domain build
node --input-type=module -e "
const { buildDefaultLabelTemplates } = await import('./packages/domain/dist/index.js');
console.log(
  buildDefaultLabelTemplates()
    .map((t) => \`  ('\${t.name}', '\${JSON.stringify(t.spec)}')\`)
    .join(',\n'),
);
"
```

Paste the printed rows into the migration so the full file reads:

```sql
INSERT INTO label_templates (tenant_id, name, spec)
SELECT o.id, t.name, t.spec::jsonb
FROM organization o
CROSS JOIN (VALUES
<PASTED ROWS — five ('name', '{…json…}') tuples>
) AS t(name, spec)
WHERE NOT EXISTS (
  SELECT 1 FROM label_templates lt
  WHERE lt.tenant_id = o.id AND lt.name = t.name
);
```

(One statement; no `--> statement-breakpoint` needed. The JSON contains no single quotes, so no escaping is required — verify with `grep -c "''" packages/db/migrations/0047_default_label_templates.sql` → 0.)

- [ ] **Step 3: Add the drift test to `packages/domain/test/labels-defaults.test.ts`**

```ts
import { readFile } from "node:fs/promises";

it("matches the jsonb inlined into db migration 0047 (drift guard)", async () => {
  const sql = await readFile(
    new URL("../../db/migrations/0047_default_label_templates.sql", import.meta.url),
    "utf8",
  );
  const rows = [...sql.matchAll(/\('([^']+)', '([^']+)'\)/g)].map((m) => ({
    name: m[1]!,
    spec: JSON.parse(m[2]!) as unknown,
  }));
  expect(rows).toEqual(buildDefaultLabelTemplates().map((t) => ({ name: t.name, spec: t.spec })));
});
```

Run: `pnpm --filter @markiro/domain test -- labels-defaults` — PASS (fails if the pasted SQL drifts).

- [ ] **Step 4: Write the migration test `packages/db/test/default-label-templates-migration.test.ts`**

Reuse the scratch-database harness from `packages/db/test/default-box-label-template-migration.test.ts` verbatim (same `quoteIdentifier`, `maintenancePool` + scratch `pool`, `beforeAll` that `CREATE DATABASE`s and runs `migrate(drizzle(pool), { migrationsFolder })`, `afterAll` that drops it — but WITHOUT that file's `legacyMigrationsFolder` copy logic; migrate the real folder once). Test body:

```ts
const SEED_NAMES = [
  "Коробка 58×40 (203 dpi)",
  "Коробка 58×40 (300 dpi)",
  "Коробка 75×120 (203 dpi)",
  "Коробка 100×100 (203 dpi)",
  "Коробка 100×150 (203 dpi)",
];

async function runBackfill(): Promise<void> {
  const sql = await readFile(join(migrationsFolder, "0047_default_label_templates.sql"), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    if (stmt.trim()) await pool.query(stmt);
  }
}

it("seeds five templates per tenant, skips name collisions, and is idempotent", async () => {
  // Orgs created AFTER migrate() ran, so 0047's original pass saw nothing.
  await pool.query(
    "INSERT INTO organization (id, name, slug, created_at) VALUES ('lt-a','A','lt-a',now()), ('lt-b','B','lt-b',now())",
  );
  // Tenant B already owns a template with a colliding seed name.
  await pool.query(
    `INSERT INTO label_templates (id, tenant_id, name, spec)
     VALUES ('00000000-0000-4000-8000-000000000901', 'lt-b', 'Коробка 58×40 (203 dpi)', '{"marker":true}'::jsonb)`,
  );

  await runBackfill();
  await runBackfill(); // idempotency

  const a = await pool.query(
    "SELECT name FROM label_templates WHERE tenant_id = 'lt-a' ORDER BY name",
  );
  expect(a.rows.map((r) => r.name).sort()).toEqual([...SEED_NAMES].sort());

  const b = await pool.query(
    "SELECT name, spec FROM label_templates WHERE tenant_id = 'lt-b' ORDER BY name",
  );
  expect(b.rows).toHaveLength(5); // 1 pre-existing + 4 seeded
  const kept = b.rows.find((r) => r.name === "Коробка 58×40 (203 dpi)");
  expect(kept.spec).toEqual({ marker: true }); // never overwritten
});
```

- [ ] **Step 5: Run**

Run: `pnpm --filter @markiro/db test -- default-label-templates`
Expected: PASS (skips when `DATABASE_URL` unset — export it).

- [ ] **Step 6: Commit**

```bash
git add packages/db packages/domain/test
git commit -m "feat(db): backfill five default label templates per tenant"
```

---

### Task 5: API — `shelfLifeDays` on the products module

**Files:**

- Modify: `apps/api/src/modules/products/dto.ts`
- Modify: `apps/api/src/modules/products/products.service.ts` (`CURRENT_PRODUCT_SELECTION` ~line 45, create ~line 135, update ~line 189, `rowToDto` ~line 751)
- Test: `apps/api/test/products.e2e.test.ts`

**Interfaces:**

- Produces: `ProductDto.shelfLifeDays: number | null`; `createProductSchema`/`updateProductSchema` accept `shelfLifeDays?: number | null` (int, 1–3650). Flows into `StationBundleProductDto` automatically (it extends `ProductDto`).

- [ ] **Step 1: Extend the e2e test (failing first)**

In `apps/api/test/products.e2e.test.ts`, next to the existing `egaisCode` create/patch coverage (grep `egaisCode` in the file and mirror the surrounding request helpers exactly), add a test that:

1. POSTs a product with `shelfLifeDays: 184` → response body has `shelfLifeDays: 184`;
2. PATCHes it with `shelfLifeDays: null` → response has `shelfLifeDays: null`;
3. POSTs `shelfLifeDays: 0` → 400.

Run: `pnpm --filter api test -- products.e2e` — Expected: FAIL (`shelfLifeDays` undefined in response / no 400).

- [ ] **Step 2: DTOs — `apps/api/src/modules/products/dto.ts`**

Add to BOTH `createProductSchema` and `updateProductSchema` (after `egaisCode`):

```ts
  shelfLifeDays: z.number().int().min(1).max(3650).nullable().optional(),
```

Add to `ProductDto` (after `egaisCode`):

```ts
shelfLifeDays: number | null;
```

- [ ] **Step 3: Service — `apps/api/src/modules/products/products.service.ts`**

- `CURRENT_PRODUCT_SELECTION`: add `shelfLifeDays: schema.products.shelfLifeDays,`
- create `.values({...})`: add `shelfLifeDays: data.shelfLifeDays ?? null,`
- update `set` block: add `if (data.shelfLifeDays !== undefined) set.shelfLifeDays = data.shelfLifeDays;`
- `rowToDto`: add `shelfLifeDays: row.shelfLifeDays,`

- [ ] **Step 4: Run**

Run: `pnpm --filter api test -- products.e2e && pnpm --filter api typecheck`
Expected: PASS. (Typecheck will also flag every place that constructs a `ProductDto` literal — e.g. `shifts.service.ts` bundle product. If it does, add `shelfLifeDays: productRow.shelfLifeDays` there now using Task 6's Step 2 edit, and fold Task 6's selection change in with it.)

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): product shelfLifeDays field"
```

---

### Task 6: API — shift bundle carries `shelfLifeDays` (egaisCode already flows)

**Files:**

- Modify: `apps/api/src/modules/shifts/shifts.service.ts` (`CURRENT_PRODUCT_SELECTION` ~line 77, bundle product payload ~line 569)
- Test: `apps/api/test/shifts-bundle.e2e.test.ts`

**Interfaces:**

- Produces: `ShiftBundleDto.product.shelfLifeDays: number | null` (via `ProductDto`), alongside the already-present `egaisCode`.

- [ ] **Step 1: Extend the bundle e2e test (failing first)**

In `apps/api/test/shifts-bundle.e2e.test.ts`, find where the seeded product row is inserted (grep `insert(schema.products)` or the product fixture) and add `shelfLifeDays: 184` to the seed; find the bundle-shape assertion on `bundle.product` and add:

```ts
expect(bundle.product.shelfLifeDays).toBe(184);
expect(bundle.product.egaisCode).not.toBeUndefined();
```

Run: `pnpm --filter api test -- shifts-bundle` — Expected: FAIL (`shelfLifeDays` undefined).

- [ ] **Step 2: Implement in `apps/api/src/modules/shifts/shifts.service.ts`**

- `CURRENT_PRODUCT_SELECTION` (~line 77): add `shelfLifeDays: schema.products.shelfLifeDays,`
- `getReferenceBundle`'s `product` literal (~line 569, after `egaisCode`): add `shelfLifeDays: productRow.shelfLifeDays,`

- [ ] **Step 3: Run**

Run: `pnpm --filter api test -- shifts-bundle && pnpm --filter api typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): shift bundle carries product shelfLifeDays"
```

---

### Task 7: API — tenant provisioning seeds templates + default box label

**Files:**

- Modify: `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts` (tenant-creation block, ~lines 98–109)
- Test: `apps/api/test/provision-tenant-owner.e2e.test.ts`

**Interfaces:**

- Consumes: `buildDefaultLabelTemplates()`, `DEFAULT_BOX_LABEL_TEMPLATE_NAME` from `@markiro/domain` (Task 2).
- Produces: every NEW tenant gets 5 `label_templates` rows and an `org_profiles` row with `default_box_label_template_id` set to the 58×40@203 template.

- [ ] **Step 1: Write the failing e2e test**

Add to `apps/api/test/provision-tenant-owner.e2e.test.ts` (same helpers as the first `it` in the file — `useDemo`, `MailDeliveryService` construction, `provisionTenantOwner`):

```ts
it("seeds five default label templates and the default box label for a new tenant", async () => {
  await useDemo();
  const suffix = crypto.randomUUID();
  const email = `first-owner-${suffix}@example.com`;
  const tenantSlug = `first-tenant-${suffix}`;
  const mail = new MailDeliveryService(new MailCryptoService(Buffer.alloc(32, 0x71)), () =>
    crypto.randomUUID(),
  );

  const result = await provisionTenantOwner({
    db: connection.db,
    mail,
    adminOrigin: "https://cabinet.example.test",
    input: { email, tenantName: "Этикетки", tenantSlug },
  });

  const templates = await connection.db
    .select({ id: schema.labelTemplates.id, name: schema.labelTemplates.name })
    .from(schema.labelTemplates)
    .where(eq(schema.labelTemplates.tenantId, result.tenantId));
  expect(templates.map((t) => t.name).sort()).toEqual(
    [
      "Коробка 58×40 (203 dpi)",
      "Коробка 58×40 (300 dpi)",
      "Коробка 75×120 (203 dpi)",
      "Коробка 100×100 (203 dpi)",
      "Коробка 100×150 (203 dpi)",
    ].sort(),
  );

  const [profile] = await connection.db
    .select({ defaultId: schema.orgProfiles.defaultBoxLabelTemplateId })
    .from(schema.orgProfiles)
    .where(eq(schema.orgProfiles.tenantId, result.tenantId));
  const expected = templates.find((t) => t.name === "Коробка 58×40 (203 dpi)");
  expect(profile?.defaultId).toBe(expected?.id);

  // Idempotency: re-provisioning the same tenant must not duplicate templates.
  await provisionTenantOwner({
    db: connection.db,
    mail,
    adminOrigin: "https://cabinet.example.test",
    input: { email, tenantName: "Этикетки", tenantSlug },
  });
  const after = await connection.db
    .select({ id: schema.labelTemplates.id })
    .from(schema.labelTemplates)
    .where(eq(schema.labelTemplates.tenantId, result.tenantId));
  expect(after).toHaveLength(5);
});
```

Also extend the suite's `afterAll` cleanup: BEFORE the statement that deletes `schema.organization` rows (grep `delete(schema.organization` in the file; note which slug/email patterns it collects), delete the new children for those same tenant ids:

```ts
if (tenantIds.length > 0) {
  await connection.db
    .delete(schema.orgProfiles)
    .where(inArray(schema.orgProfiles.tenantId, tenantIds));
  await connection.db
    .delete(schema.labelTemplates)
    .where(inArray(schema.labelTemplates.tenantId, tenantIds));
}
```

(`tenantIds` = the organization ids the cleanup already resolves; if it deletes by slug pattern directly, first select those ids into a list.)

Run: `pnpm --filter api test -- provision-tenant-owner` — Expected: the new test FAILS (0 templates).

- [ ] **Step 2: Implement in `tenant-provisioning.service.ts`**

Import at top:

```ts
import { DEFAULT_BOX_LABEL_TEMPLATE_NAME, buildDefaultLabelTemplates } from "@markiro/domain";
```

Inside the `if (!tenant) { … }` creation block (after the `pickupTenantPolicies` insert, still inside the transaction):

```ts
// Stock box-label templates (spec: 2026-08-20 label editor simplification).
// Seeded only on tenant CREATION — re-provisioning an existing tenant
// (idempotent retry) must not duplicate them.
let defaultBoxLabelTemplateId: string | null = null;
for (const template of buildDefaultLabelTemplates()) {
  const templateId = createId();
  await tx.insert(schema.labelTemplates).values({
    id: templateId,
    tenantId: tenant.id,
    name: template.name,
    spec: template.spec,
  });
  if (template.name === DEFAULT_BOX_LABEL_TEMPLATE_NAME) {
    defaultBoxLabelTemplateId = templateId;
  }
}
await tx.insert(schema.orgProfiles).values({
  tenantId: tenant.id,
  defaultBoxLabelTemplateId,
});
```

(`createId` is already in scope. A brand-new tenant has no `org_profiles` row, so a plain insert is correct; nothing else in provisioning writes that table.)

- [ ] **Step 3: Run**

Run: `pnpm --filter api test -- provision-tenant-owner && pnpm --filter api typecheck`
Expected: PASS, including the pre-existing tests in that suite (their cleanup now handles the new child rows). If any OTHER api e2e suite provisions tenants through this service and its cleanup now fails on the label_templates/org_profiles FKs, extend that suite's cleanup the same way.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): seed default label templates on tenant provisioning"
```

---

### Task 8: Station — mirror the new product attributes and print egais/expiry

**Files:**

- Modify: `packages/db/src/sqlite/schema.ts` (`productMirror`), `packages/db/src/sqlite/migrations.ts` (trailing ALTERs)
- Modify: `apps/station/src/lib/mirror.ts` (`StationBundle.product`, `upsertBundleBody`, `ShiftContextRow`, `readShiftContext`)
- Modify: `apps/station/src/lib/box-label.ts` (real values; new `expiryIsoDate`)
- Modify: `apps/station/src/pages/WorkScreen.tsx` (props + `fieldsForClosedBox`, ~lines 64, 138, 808)
- Modify: `apps/station/src/App.tsx` (`<WorkScreen …>` props, ~line 1388)
- Test: `apps/station/test/box-label.test.ts` (create), `apps/station/test/mirror.test.ts` (extend), `packages/db/test/sqlite-schema.test.ts` (extend if it enumerates columns)

**Interfaces:**

- Consumes: bundle `product.egaisCode` / `product.shelfLifeDays` (Task 6).
- Produces: `expiryIsoDate(closedAt: string, shelfLifeDays: number | null): string`; `BoxLabelInput` gains `egaisCode: string | null; shelfLifeDays: number | null`; `ShiftContextRow` gains `egaisCode: string | null; shelfLifeDays: number | null`; `WorkScreenProps` gains `productEgaisCode?: string | null; productShelfLifeDays?: number | null`.

- [ ] **Step 1: Write the failing test `apps/station/test/box-label.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { boxLabelFields, expiryIsoDate } from "../src/lib/box-label.js";

describe("expiryIsoDate", () => {
  it("matches the mock-up: 2025-05-20 + 184 days = 2025-11-20", () => {
    expect(expiryIsoDate("2025-05-20T10:15:00.000Z", 184)).toBe("2025-11-20");
  });

  it("rolls over year and leap-day boundaries", () => {
    expect(expiryIsoDate("2026-12-31T00:00:00.000Z", 1)).toBe("2027-01-01");
    expect(expiryIsoDate("2024-02-28T00:00:00.000Z", 1)).toBe("2024-02-29");
  });

  it("returns empty for null, non-positive, or invalid input", () => {
    expect(expiryIsoDate("2025-05-20T00:00:00.000Z", null)).toBe("");
    expect(expiryIsoDate("2025-05-20T00:00:00.000Z", 0)).toBe("");
    expect(expiryIsoDate("2025-05-20T00:00:00.000Z", -5)).toBe("");
    expect(expiryIsoDate("garbage", 10)).toBe("");
  });
});

describe("boxLabelFields — egais/expiry", () => {
  const base = {
    sscc: "346006820000000014",
    itemCount: 24,
    productName: "Сидр",
    gtin14: "04600682000013",
    operatorName: null,
    counterpartyName: null,
    closedAt: "2025-05-20T10:15:00.000Z",
  };

  it("fills product.egais and computed expiry", () => {
    const fields = boxLabelFields({
      ...base,
      egaisCode: "0101234567890123456",
      shelfLifeDays: 184,
    });
    expect(fields["product.egais"]).toBe("0101234567890123456");
    expect(fields.expiry).toBe("2025-11-20");
  });

  it("degrades to empty strings when the product carries neither", () => {
    const fields = boxLabelFields({ ...base, egaisCode: null, shelfLifeDays: null });
    expect(fields["product.egais"]).toBe("");
    expect(fields.expiry).toBe("");
  });
});
```

Run: `pnpm --filter station test -- box-label` — Expected: FAIL (`expiryIsoDate` not exported; input fields missing).

- [ ] **Step 2: Implement `apps/station/src/lib/box-label.ts`**

Full new file:

```ts
import type { LabelField } from "@markiro/domain";

export interface BoxLabelInput {
  sscc: string;
  itemCount: number;
  productName: string;
  gtin14: string;
  egaisCode: string | null;
  shelfLifeDays: number | null;
  operatorName: string | null;
  counterpartyName: string | null;
  closedAt: string;
}

/**
 * «Годен до» = production date (the box's close date) + the product's shelf
 * life in days, formatted exactly like the `date` field (YYYY-MM-DD). UTC
 * date math on the date part only — the label carries no time component, so
 * local timezones must not shift the printed day.
 */
export function expiryIsoDate(closedAt: string, shelfLifeDays: number | null): string {
  if (shelfLifeDays === null || !Number.isInteger(shelfLifeDays) || shelfLifeDays <= 0) return "";
  const base = new Date(`${closedAt.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return "";
  base.setUTCDate(base.getUTCDate() + shelfLifeDays);
  return base.toISOString().slice(0, 10);
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
    "product.egais": input.egaisCode ?? "",
    "km.code": "",
    sscc: input.sscc,
    "shift.no": "",
    date: input.closedAt.slice(0, 10),
    expiry: expiryIsoDate(input.closedAt, input.shelfLifeDays),
    qty: String(input.itemCount),
    operator: input.operatorName ?? "",
    "counterparty.name": input.counterpartyName ?? "",
  };
}
```

Run: `pnpm --filter station test -- box-label` — Expected: PASS. (Other station tests calling `boxLabelFields` — grep `boxLabelFields(` in `apps/station/test` — now fail to compile; add `egaisCode: null, shelfLifeDays: null` to their inputs.)

- [ ] **Step 3: SQLite mirror columns**

`packages/db/src/sqlite/schema.ts`, `productMirror` (after `defaultLabelTemplateId`):

```ts
  egaisCode: text("egais_code"),
  shelfLifeDays: integer("shelf_life_days"),
```

`packages/db/src/sqlite/migrations.ts`, append at the very end of `STATION_MIGRATIONS`:

```ts
  // Box-label «Код ЕГАИС» / «Годен до» inputs mirrored off the shift bundle
  // (spec 2026-08-20). Same re-runnable idempotency as the `login` ALTER above.
  `ALTER TABLE product_mirror ADD COLUMN egais_code TEXT;`,
  `ALTER TABLE product_mirror ADD COLUMN shelf_life_days INTEGER;`,
];
```

Run: `pnpm --filter @markiro/db test -- sqlite-schema` — extend that test's round-trip row if it fails on the new columns.

- [ ] **Step 4: Mirror plumbing — `apps/station/src/lib/mirror.ts`**

`StationBundle.product` — add (optional: older servers omit them during a rolling deploy):

```ts
    egaisCode?: string | null;
    shelfLifeDays?: number | null;
```

`upsertBundleBody` product upsert — add the two columns to the STATIC column list, values, and update set:

```ts
    `INSERT INTO product_mirror (
       id, gtin14, name, product_group, box_capacity, pallet_capacity, status,
       default_counterparty_id, default_label_template_id, egais_code, shelf_life_days${imageColumns}
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?${imageValues})
     ON CONFLICT(id) DO UPDATE SET
       gtin14=excluded.gtin14, name=excluded.name, product_group=excluded.product_group,
       box_capacity=excluded.box_capacity, pallet_capacity=excluded.pallet_capacity,
       status=excluded.status, default_counterparty_id=excluded.default_counterparty_id,
       default_label_template_id=excluded.default_label_template_id,
       egais_code=excluded.egais_code, shelf_life_days=excluded.shelf_life_days${imageUpdate}`,
```

and in the params array, after `p.defaultLabelTemplateId`:

```ts
      p.egaisCode ?? null,
      p.shelfLifeDays ?? null,
```

`ShiftContextRow` — add:

```ts
egaisCode: string | null;
shelfLifeDays: number | null;
```

`readShiftContext` — extend the row type with `egais_code: string | null; shelf_life_days: number | null;`, the SELECT with `p.egais_code, p.shelf_life_days,` (before the image columns), and the returned object with:

```ts
    egaisCode: row.egais_code ?? null,
    shelfLifeDays: row.shelf_life_days ?? null,
```

Extend `apps/station/test/mirror.test.ts`: in an existing `upsertBundle` round-trip test, set `product.egaisCode: "0101234567890123456"` and `product.shelfLifeDays: 184` on the bundle fixture and assert `readShiftContext` returns them; add one case with the fields ABSENT from the bundle (older server) asserting both read back as null.

- [ ] **Step 5: Thread into WorkScreen**

`apps/station/src/pages/WorkScreen.tsx`:

- `WorkScreenProps` (after `counterpartyName`): `productEgaisCode?: string | null;` and `productShelfLifeDays?: number | null;`
- destructure both in the component signature;
- `fieldsForClosedBox` (~line 808):

```ts
return boxLabelFields({
  sscc: result.sscc,
  itemCount: result.itemCount,
  productName,
  gtin14: expectedGtin14,
  egaisCode: productEgaisCode ?? null,
  shelfLifeDays: productShelfLifeDays ?? null,
  operatorName: null,
  counterpartyName: counterpartyName ?? null,
  closedAt: new Date().toISOString(),
});
```

`apps/station/src/App.tsx` `<WorkScreen …>` (~line 1388), after `counterpartyName={…}`:

```tsx
            productEgaisCode={shiftContext.egaisCode}
            productShelfLifeDays={shiftContext.shelfLifeDays}
```

- [ ] **Step 6: Run the station suite**

Run: `pnpm --filter station test && pnpm --filter station typecheck`
Expected: PASS (fix any remaining `boxLabelFields`/`ShiftContextRow` fixture compile errors by adding the two fields with nulls).

- [ ] **Step 7: Commit**

```bash
git add packages/db apps/station
git commit -m "feat(station): print EGAIS code and computed expiry on box labels"
```

---

### Task 9: Admin — remove the visual editor; settings form + import + preview

**Files:**

- Delete: `apps/admin/src/pages/labels/editor/LabelCanvas.tsx`, `Palette.tsx`, `PropertiesPanel.tsx`, `useEditorState.ts`; `apps/admin/test/labels-canvas.test.tsx`
- Move: `apps/admin/src/pages/labels/editor/renderer.ts` → `apps/admin/src/pages/labels/renderer.ts`; `editor/geometry.ts` → `labels/geometry.ts`
- Create: `apps/admin/src/pages/labels/editor/useSpecState.ts`
- Rewrite: `apps/admin/src/pages/labels/editor/index.tsx`, `apps/admin/test/labels-editor.test.tsx`
- Modify: `apps/admin/src/pages/labels/TemplateThumb.tsx`, `editor/PreviewPane.tsx`, `editor/ImportCodeDialog.tsx` (import paths), `editor/editor.css`, `apps/admin/src/i18n/en.json` + `ru.json`

**Interfaces:**

- Consumes: `parseLabelCode` via `ImportCodeDialog` (unchanged), `fitSpecElements` from the moved `../geometry.js`.
- Produces: `useSpecState(initialSpec)` → `{ state: { spec, geometryError }, replaceSpec(spec), resizeLabel(w, h) }`. Routes and the `/labels` library screen keep working unchanged.

- [ ] **Step 1: Move the shared modules and fix imports**

```bash
git mv apps/admin/src/pages/labels/editor/renderer.ts apps/admin/src/pages/labels/renderer.ts
git mv apps/admin/src/pages/labels/editor/geometry.ts apps/admin/src/pages/labels/geometry.ts
```

Update import specifiers:

- `apps/admin/src/pages/labels/TemplateThumb.tsx`: `"./editor/renderer.js"` → `"./renderer.js"`
- `apps/admin/src/pages/labels/renderer.ts`: no change (it imports nothing from editor/)
- `apps/admin/src/pages/labels/geometry.ts`: `"./renderer.js"` stays valid (both moved together)
- `apps/admin/src/pages/labels/editor/PreviewPane.tsx`: `"./renderer.js"` → `"../renderer.js"`
- `apps/admin/src/pages/labels/editor/ImportCodeDialog.tsx`: `"./geometry.js"` → `"../geometry.js"`

- [ ] **Step 2: Delete the interactive editor**

```bash
git rm apps/admin/src/pages/labels/editor/LabelCanvas.tsx \
       apps/admin/src/pages/labels/editor/Palette.tsx \
       apps/admin/src/pages/labels/editor/PropertiesPanel.tsx \
       apps/admin/src/pages/labels/editor/useEditorState.ts \
       apps/admin/test/labels-canvas.test.tsx
```

- [ ] **Step 3: Create `apps/admin/src/pages/labels/editor/useSpecState.ts`**

```ts
/**
 * Minimal spec state for the import-based editor: the spec itself plus the
 * geometry error surfaced when a label resize can no longer fit the imported
 * elements. Replaces the removed canvas editor's undo/redo reducer.
 */
import { useCallback, useReducer } from "react";

import { type LabelTemplateSpec } from "@markiro/domain";

import { fitSpecElements } from "../geometry.js";

export interface SpecState {
  spec: LabelTemplateSpec;
  geometryError: "ELEMENT_TOO_LARGE" | null;
}

type SpecAction =
  | { type: "replaceSpec"; spec: LabelTemplateSpec }
  | { type: "resizeLabel"; widthMm: number; heightMm: number };

export function specReducer(state: SpecState, action: SpecAction): SpecState {
  switch (action.type) {
    case "replaceSpec":
      return { spec: action.spec, geometryError: null };
    case "resizeLabel": {
      const resized: LabelTemplateSpec = {
        ...state.spec,
        widthMm: action.widthMm,
        heightMm: action.heightMm,
      };
      const fitted = fitSpecElements(resized);
      if (!fitted.ok) return { ...state, geometryError: "ELEMENT_TOO_LARGE" };
      return { spec: fitted.spec, geometryError: null };
    }
  }
}

export function useSpecState(initialSpec: LabelTemplateSpec) {
  const [state, dispatch] = useReducer(specReducer, initialSpec, (spec) => ({
    spec,
    geometryError: null,
  }));
  const replaceSpec = useCallback(
    (spec: LabelTemplateSpec) => dispatch({ type: "replaceSpec", spec }),
    [],
  );
  const resizeLabel = useCallback(
    (widthMm: number, heightMm: number) => dispatch({ type: "resizeLabel", widthMm, heightMm }),
    [],
  );
  return { state, replaceSpec, resizeLabel };
}
```

- [ ] **Step 4: Rewrite `apps/admin/src/pages/labels/editor/index.tsx`**

Keep the existing `LabelEditorPage` guarded-root component (route mode, fetch states, injectable `rasterizeText`/`checkFamilyCoverage`) EXACTLY as-is; replace only the imports it no longer needs and the whole `LabelEditorContent`. Final file:

```tsx
/**
 * The `/labels/new` / `/labels/:id` template page after the visual editor's
 * removal (spec 2026-08-20): a settings form (name, size, dpi, language) +
 * the code-import dialog as the ONLY way to set label content + the
 * read-only "предпросмотр = печать" pane. The spec model and save/download
 * paths are unchanged; `spec.language` only drives download and the library
 * badge — the station picks its printer's language at print time.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";

import {
  generateTspl,
  generateZpl,
  sampleLabelData,
  type LabelImportResult,
  type LabelTemplateSpec,
  type RasterizeTextFn,
} from "@markiro/domain";
import { Alert, Button, Input, Modal, Select, Spinner } from "@markiro/ui";

import { ApiRequestError } from "../../../api/client.js";
import {
  type LabelFontFamily,
  checkFamilyCoverage as realCheckFamilyCoverage,
} from "../../../labels/fontCoverage.js";
import { rasterizeText as realRasterizeText } from "../../../labels/rasterizer.js";
import { toast } from "../../../lib/toast.js";
import { useCreateLabelTemplate, useLabelTemplate, useUpdateLabelTemplate } from "../api.js";
import "./editor.css";
import { buildTsplBlob, buildZplBlob, downloadBlob, safeFileName } from "./download.js";
import { ImportCodeDialog } from "./ImportCodeDialog.js";
import { PreviewPane } from "./PreviewPane.js";
import { useSpecState } from "./useSpecState.js";

const DEFAULT_SPEC: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [],
};

const SIZE_PRESETS = [
  { key: "58x40", widthMm: 58, heightMm: 40 },
  { key: "60x40", widthMm: 60, heightMm: 40 },
  { key: "75x120", widthMm: 75, heightMm: 120 },
  { key: "100x100", widthMm: 100, heightMm: 100 },
  { key: "100x150", widthMm: 100, heightMm: 150 },
] as const;

function matchPresetKey(widthMm: number, heightMm: number): string | null {
  const preset = SIZE_PRESETS.find((p) => p.widthMm === widthMm && p.heightMm === heightMm);
  return preset ? preset.key : null;
}

const DPI_OPTIONS = ["203", "300"];
const LANGUAGE_OPTIONS: Array<{ value: LabelTemplateSpec["language"]; label: string }> = [
  { value: "zpl", label: "ZPL" },
  { value: "tspl", label: "TSPL (TSC)" },
];

export interface LabelEditorPageProps {
  rasterizeText?: RasterizeTextFn;
  checkFamilyCoverage?: (family: LabelFontFamily) => Promise<boolean>;
}

/** Guarded root: resolves route mode (create vs. edit) and the fetch/loading/error states, then hands off to `LabelEditorContent` once the initial spec is known. */
export function LabelEditorPage({
  rasterizeText = realRasterizeText,
  checkFamilyCoverage = realCheckFamilyCoverage,
}: LabelEditorPageProps) {
  const { t } = useTranslation();
  const { id: routeId } = useParams<{ id?: string }>();
  const id = routeId ?? null;
  const templateQuery = useLabelTemplate(id);

  if (id !== null) {
    if (templateQuery.isPending) {
      return (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      );
    }
    if (templateQuery.isError || !templateQuery.data) {
      return (
        <div style={{ padding: "28px 32px" }}>
          <Alert tone="error">{t("pages.labels.editor.loadError")}</Alert>
        </div>
      );
    }
    return (
      <LabelEditorContent
        key={id}
        mode="edit"
        id={id}
        initialName={templateQuery.data.name}
        initialSpec={templateQuery.data.spec}
        rasterizeText={rasterizeText}
        checkFamilyCoverage={checkFamilyCoverage}
      />
    );
  }

  return (
    <LabelEditorContent
      key="new"
      mode="create"
      initialName={t("pages.labels.editor.defaultName")}
      initialSpec={DEFAULT_SPEC}
      rasterizeText={rasterizeText}
      checkFamilyCoverage={checkFamilyCoverage}
    />
  );
}

interface LabelEditorContentProps {
  mode: "create" | "edit";
  id?: string;
  initialName: string;
  initialSpec: LabelTemplateSpec;
  rasterizeText: RasterizeTextFn;
  checkFamilyCoverage: (family: LabelFontFamily) => Promise<boolean>;
}

function LabelEditorContent({
  mode,
  id,
  initialName,
  initialSpec,
  rasterizeText,
  checkFamilyCoverage,
}: LabelEditorContentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const editor = useSpecState(initialSpec);
  const [name, setName] = useState(initialName);
  const [dirty, setDirty] = useState(false);
  const [showDirtyConfirm, setShowDirtyConfirm] = useState(false);
  const [customSize, setCustomSize] = useState(
    () => matchPresetKey(initialSpec.widthMm, initialSpec.heightMm) === null,
  );
  const [showImportDialog, setShowImportDialog] = useState(false);

  const createMutation = useCreateLabelTemplate();
  const updateMutation = useUpdateLabelTemplate();

  const spec = editor.state.spec;

  function markDirty(): void {
    setDirty(true);
  }

  function handleNameChange(value: string): void {
    setName(value);
    markDirty();
  }

  function handleReplaceSpec(nextSpec: LabelTemplateSpec): void {
    editor.replaceSpec(nextSpec);
    markDirty();
  }

  function handleLabelResize(widthMm: number, heightMm: number): void {
    editor.resizeLabel(widthMm, heightMm);
    markDirty();
  }

  function handleImportReplace(result: LabelImportResult): void {
    editor.replaceSpec(result.spec);
    setCustomSize(matchPresetKey(result.spec.widthMm, result.spec.heightMm) === null);
    markDirty();
    setShowImportDialog(false);
  }

  function handleSizePresetChange(value: string): void {
    if (value === "custom") {
      setCustomSize(true);
      return;
    }
    const preset = SIZE_PRESETS.find((p) => p.key === value);
    if (!preset) return;
    setCustomSize(false);
    handleLabelResize(preset.widthMm, preset.heightMm);
  }

  async function handleSave(): Promise<void> {
    try {
      if (mode === "edit" && id) {
        await updateMutation.mutateAsync({ id, input: { name, spec } });
        toast("ok", t("pages.labels.editor.toasts.updateSuccess"));
        setDirty(false);
      } else {
        const created = await createMutation.mutateAsync({ name, spec });
        toast("ok", t("pages.labels.editor.toasts.createSuccess"));
        setDirty(false);
        void navigate(`/labels/${created.id}`, { replace: true });
      }
    } catch (error) {
      const fallback =
        mode === "edit"
          ? t("pages.labels.editor.toasts.updateError")
          : t("pages.labels.editor.toasts.createError");
      toast("error", error instanceof ApiRequestError ? error.message : fallback);
    }
  }

  async function handleDownload(): Promise<void> {
    const sample = sampleLabelData();
    try {
      if (spec.language === "zpl") {
        const text = await generateZpl(spec, sample, { rasterizeText });
        downloadBlob(buildZplBlob(text), `${safeFileName(name)}.zpl`);
      } else {
        const text = await generateTspl(spec, sample, { rasterizeText });
        downloadBlob(buildTsplBlob(text), `${safeFileName(name)}.tspl`);
      }
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    }
  }

  function handleBack(): void {
    if (dirty) {
      setShowDirtyConfirm(true);
    } else {
      void navigate("/labels");
    }
  }

  function handleConfirmDiscard(): void {
    setShowDirtyConfirm(false);
    void navigate("/labels");
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="label-editor">
      <div className="label-editor__toolbar">
        <a
          href="/labels"
          onClick={(event) => {
            event.preventDefault();
            handleBack();
          }}
          style={{
            color: "var(--fg-3)",
            cursor: "pointer",
            textDecoration: "none",
            font: "400 13px/18px var(--font-ui)",
          }}
        >
          {t("pages.labels.editor.back")}
        </a>
        <Input
          aria-label={t("pages.labels.editor.nameLabel")}
          value={name}
          onChange={(event) => handleNameChange(event.target.value)}
          style={{ width: 260 }}
        />
        <span style={{ flex: 1 }} />
        <Button type="button" loading={isSaving} onClick={() => void handleSave()}>
          {t("pages.labels.editor.save")}
        </Button>
      </div>

      <div className="label-editor__body">
        <aside
          className="label-editor__settings"
          aria-label={t("pages.labels.editor.settingsTitle")}
        >
          <Select
            label={t("pages.labels.editor.sizePresetLabel")}
            options={[
              ...SIZE_PRESETS.map((preset) => ({
                value: preset.key,
                label: `${preset.widthMm}×${preset.heightMm}`,
              })),
              { value: "custom", label: t("pages.labels.editor.customSizeOption") },
            ]}
            value={
              customSize ? "custom" : (matchPresetKey(spec.widthMm, spec.heightMm) ?? "custom")
            }
            onValueChange={handleSizePresetChange}
          />
          {customSize && (
            <div className="label-editor__size-inputs">
              <Input
                label={t("pages.labels.editor.widthLabel")}
                type="number"
                mono
                value={spec.widthMm.toFixed(1)}
                onChange={(event) =>
                  handleLabelResize(Number(event.target.value) || 0, spec.heightMm)
                }
              />
              <Input
                label={t("pages.labels.editor.heightLabel")}
                type="number"
                mono
                value={spec.heightMm.toFixed(1)}
                onChange={(event) =>
                  handleLabelResize(spec.widthMm, Number(event.target.value) || 0)
                }
              />
            </div>
          )}
          <Select
            label={t("pages.labels.editor.dpiLabel")}
            options={DPI_OPTIONS}
            value={String(spec.dpi)}
            onValueChange={(value) =>
              handleReplaceSpec({ ...spec, dpi: value === "300" ? 300 : 203 })
            }
          />
          <Select
            label={t("pages.labels.editor.languageLabel")}
            options={LANGUAGE_OPTIONS}
            value={spec.language}
            onValueChange={(value) => handleReplaceSpec({ ...spec, language: value })}
          />
          <p className="label-editor__language-hint">{t("pages.labels.editor.languageHint")}</p>
          <Button type="button" onClick={() => setShowImportDialog(true)}>
            {t("pages.labels.editor.import.open")}
          </Button>
          <Button type="button" variant="secondary" onClick={() => void handleDownload()}>
            {t("pages.labels.editor.download", { format: spec.language.toUpperCase() })}
          </Button>
          {editor.state.geometryError !== null && (
            <Alert tone="error">{t("pages.labels.editor.geometryError")}</Alert>
          )}
        </aside>

        <main
          className="label-editor__workspace"
          aria-label={t("pages.labels.editor.preview.title")}
        >
          {spec.elements.length === 0 && (
            <p className="label-editor__empty">{t("pages.labels.editor.empty")}</p>
          )}
          <PreviewPane
            spec={spec}
            rasterizeText={rasterizeText}
            checkFamilyCoverage={checkFamilyCoverage}
          />
        </main>
      </div>

      <Modal
        open={showDirtyConfirm}
        onClose={() => setShowDirtyConfirm(false)}
        closeLabel={t("common.close")}
        title={t("pages.labels.editor.dirtyGuard.title")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setShowDirtyConfirm(false)}>
              {t("pages.labels.editor.dirtyGuard.cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={handleConfirmDiscard}>
              {t("pages.labels.editor.dirtyGuard.discard")}
            </Button>
          </>
        }
      >
        <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
          {t("pages.labels.editor.dirtyGuard.body")}
        </p>
      </Modal>

      <ImportCodeDialog
        open={showImportDialog}
        initialLanguage={spec.language}
        initialDpi={spec.dpi}
        currentDirty={dirty}
        onClose={() => setShowImportDialog(false)}
        onReplace={handleImportReplace}
      />
    </div>
  );
}
```

Notes: if `@markiro/ui`'s `Select`/`Input` have no `label` prop (check `packages/ui` — the OLD toolbar used `aria-label`), keep `aria-label` instead of `label` with the same i18n keys, and render the visible caption as a `<label>`-styled `<span>` above each control. Check `pages.labels.editor.preview.title` exists in i18n (`preview` keys survived) — if the title key is named differently, use the existing one.

- [ ] **Step 5: i18n — `pages.labels.editor` in both `en.json` and `ru.json`**

Remove keys: `palette`, `properties`, `kinds`, `defaultText`, `workspaceLabel`, `zoomCaption`.
Add keys — en:

```json
"settingsTitle": "Label settings",
"languageHint": "Affects download only. When printing, the station uses its own printer's language.",
"empty": "No label content yet — import ZPL or TSPL code.",
"geometryError": "An element no longer fits the label. Enlarge the label or re-import the code."
```

ru:

```json
"settingsTitle": "Параметры этикетки",
"languageHint": "Влияет только на скачивание. При печати станция использует язык своего принтера.",
"empty": "Содержимое этикетки не задано — импортируйте код ZPL или TSPL.",
"geometryError": "Элемент больше этикетки. Увеличьте этикетку или импортируйте код заново."
```

Before deleting `kinds`/`defaultText`, confirm nothing else references them: `grep -rn "editor.kinds\|editor.defaultText\|editor.palette\|editor.properties\|workspaceLabel\|zoomCaption" apps/admin/src` → must only hit the files deleted in Step 2.

- [ ] **Step 6: `editor.css`**

Delete every rule whose selector contains `__palette`, `__properties`, `__reopen-properties`, or canvas-only classes (grep the deleted components for `className` values first); keep ALL `label-editor__import-*` rules and the preview/toolbar rules. Add:

```css
.label-editor__body {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 20px;
  align-items: start;
}

.label-editor__settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.label-editor__size-inputs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.label-editor__language-hint {
  margin: 0;
  font: 400 12px/16px var(--font-ui);
  color: var(--fg-3);
}

.label-editor__empty {
  margin: 0 0 12px;
  font: 400 13px/18px var(--font-ui);
  color: var(--fg-3);
}
```

- [ ] **Step 7: Rewrite `apps/admin/test/labels-editor.test.tsx`**

Keep the file's existing scaffolding (imports, `jsonResponse`, `FAKE_RASTER_RESULT`, `fakeRasterizeText`, `resolveTrueCoverage`, `LibraryMarker`, `EditorRouteMarker`, `renderCreateFlow`, `renderEditFlow`); delete every `describe` block about Palette/PropertiesPanel/canvas and replace the test body with:

```tsx
const IMPORT_ZPL = [
  "^XA",
  "^PW464",
  "^LL320",
  "^FO40,40^A0N,34,34^FDПартия^FS",
  "^FO40,100^A0N,34,34^FD{{qty}}^FS",
  "^XZ",
].join("\n");

describe("settings form", () => {
  it("dpi and language changes round-trip into the spec Save POSTs", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/label-templates" && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { name: string; spec: unknown };
        return jsonResponse(201, {
          id: "new-1",
          name: body.name,
          spec: body.spec,
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:00.000Z",
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCreateFlow();

    await user.selectOptions(screen.getByLabelText("Разрешение"), "300");
    await user.selectOptions(screen.getByLabelText("Язык"), "tspl");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      spec: { dpi: number; language: string };
    };
    expect(body.spec.dpi).toBe(300);
    expect(body.spec.language).toBe("tspl");
    expect(() => parseLabelTemplate(body.spec)).not.toThrow();
    expect(await screen.findByText("Editor route: new-1")).toBeDefined();
  });

  it("shows the empty-state hint until code is imported", () => {
    renderCreateFlow();
    expect(
      screen.getByText("Содержимое этикетки не задано — импортируйте код ZPL или TSPL."),
    ).toBeDefined();
  });
});

describe("import is the only content path", () => {
  it("the canvas editor chrome is gone", () => {
    renderCreateFlow();
    expect(screen.queryByRole("button", { name: "Текст" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Поле" })).toBeNull();
    expect(screen.queryByLabelText("X, мм")).toBeNull();
  });

  it("imported ZPL replaces the spec and Save POSTs it", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/label-templates" && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { name: string; spec: unknown };
        return jsonResponse(201, {
          id: "new-2",
          name: body.name,
          spec: body.spec,
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:00.000Z",
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCreateFlow();

    fireEvent.click(screen.getByRole("button", { name: "Импортировать код" }));
    fireEvent.change(screen.getByLabelText(/Код ZPL/), { target: { value: IMPORT_ZPL } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Заменить" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      spec: {
        widthMm: number;
        heightMm: number;
        elements: Array<{ kind: string; field?: string }>;
      };
    };
    expect(body.spec.widthMm).toBeCloseTo(58, 0);
    expect(body.spec.heightMm).toBeCloseTo(40, 0);
    expect(body.spec.elements).toHaveLength(2);
    expect(body.spec.elements[1]).toMatchObject({ kind: "field", field: "qty" });
    expect(() => parseLabelTemplate(body.spec)).not.toThrow();
  });
});

describe("edit flow, download, dirty guard", () => {
  const TEMPLATE = {
    id: "tpl-1",
    name: "Коробка",
    spec: {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "zpl",
      elements: [{ kind: "text", id: "t1", xMm: 2, yMm: 2, text: "ACME", fontSizePt: 10 }],
    },
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };

  it("download produces a ZPL blob for the loaded template", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/label-templates/tpl-1") return jsonResponse(200, TEMPLATE);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const created: Blob[] = [];
    vi.stubGlobal(
      "URL",
      Object.assign(Object.create(URL), {
        createObjectURL: (blob: Blob) => {
          created.push(blob);
          return "blob:test";
        },
        revokeObjectURL: () => undefined,
      }),
    );

    renderEditFlow("tpl-1");
    fireEvent.click(await screen.findByRole("button", { name: "Скачать ZPL" }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(await created[0]!.text()).toContain("^XA");
  });

  it("the dirty guard blocks back until confirmed", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/label-templates/tpl-1") return jsonResponse(200, TEMPLATE);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderEditFlow("tpl-1");
    fireEvent.change(await screen.findByLabelText("Название"), {
      target: { value: "Другое имя" },
    });
    fireEvent.click(screen.getByText("← К библиотеке"));
    expect(screen.queryByText("Library page")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Не сохранять" }));
    expect(await screen.findByText("Library page")).toBeDefined();
  });
});
```

IMPORTANT: the literal control names/labels above ("Разрешение", "Язык", "Импортировать код", "Скачать ZPL", "Название", "← К библиотеке", "Не сохранять", "Проверить", "Заменить") must match the RU i18n values actually used by the keys (`dpiLabel`, `languageLabel`, `import.open`, `download`, `nameLabel`, `back`, `dirtyGuard.discard`, `import.check`, `import.replace`). Read them from `ru.json` and adjust the strings — do not rename the i18n values to fit the tests. If `@markiro/ui`'s `Select` is not a native `<select>`, replace `user.selectOptions` with the interaction pattern the OLD dpi/language test in this file's git history used (`git show HEAD~1:apps/admin/test/labels-editor.test.tsx`).

- [ ] **Step 8: Run the admin suite**

Run: `pnpm --filter admin test && pnpm --filter admin typecheck && pnpm --filter admin lint`
Expected: PASS — including the untouched `labels-library.test.tsx` (thumbnails via the moved `renderer.ts`) and the i18n parity test.

- [ ] **Step 9: Commit**

```bash
git add -A apps/admin
git commit -m "feat(admin)!: replace the visual label editor with settings + code import"
```

---

### Task 10: Admin — «Срок годности, дней» on the product form

**Files:**

- Modify: `apps/admin/src/pages/catalog/api.ts` (`ProductDto`, `CreateProductInput`, update input)
- Modify: `apps/admin/src/pages/catalog/ProductForm.tsx` (zod schema ~line 71, `EMPTY_VALUES` ~line 116, aggregation section ~line 441, `toCreateInput` ~line 512)
- Modify: `apps/admin/src/pages/catalog/ProductPanelRoute.tsx` (initialValues mappings ~lines 98, 182, memo deps)
- Modify: `apps/admin/src/i18n/en.json` + `ru.json` (`pages.catalog.form`)
- Test: `apps/admin/test/catalog.test.tsx`

**Interfaces:**

- Consumes: API `shelfLifeDays` (Task 5).
- Produces: form field `shelfLifeDays` (string in the form, `number | null` in the payload).

- [ ] **Step 1: Write the failing test**

In `apps/admin/test/catalog.test.tsx`, find the existing create-product submit test (grep `egaisCode` or the create POST assertion) and add alongside it: fill the input labelled with the new key's RU value («Срок годности, дней»), submit, assert the POST body carries `shelfLifeDays: 184`; and one case leaving it blank → `shelfLifeDays: null`.

Run: `pnpm --filter admin test -- catalog` — Expected: FAIL (no such input).

- [ ] **Step 2: Implement**

`api.ts`: add `shelfLifeDays: number | null;` to `ProductDto` and `shelfLifeDays?: number | null;` to `CreateProductInput` (and the update input type if separate).

`ProductForm.tsx`:

- zod schema, after `egaisCode`:

```ts
  shelfLifeDays: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^[1-9]\d*$/.test(v), "pages.catalog.form.errors.capacityInvalid"),
```

- `EMPTY_VALUES`: `shelfLifeDays: "",`
- Aggregation section, after the `egaisCode` Input:

```tsx
<Input
  label={t("pages.catalog.form.shelfLifeDaysLabel")}
  mono
  inputMode="numeric"
  {...errorProp(translateFieldError(t, errors.shelfLifeDays?.message))}
  {...register("shelfLifeDays")}
/>
```

- `toCreateInput`:

```ts
  const shelfLifeDays = values.shelfLifeDays?.trim();
  // …in the returned object:
    shelfLifeDays: shelfLifeDays ? Number(shelfLifeDays) : null,
```

`ProductPanelRoute.tsx` — both initialValues mappings (created + edit):

```ts
            shelfLifeDays: product.shelfLifeDays === null ? "" : String(product.shelfLifeDays),
```

(and `createdProduct.shelfLifeDays` in the first one; add `product?.shelfLifeDays` to the memo dependency array).

i18n `pages.catalog.form` — en: `"shelfLifeDaysLabel": "Shelf life, days"`; ru: `"shelfLifeDaysLabel": "Срок годности, дней"`.

- [ ] **Step 3: Run**

Run: `pnpm --filter admin test -- catalog && pnpm --filter admin typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/admin
git commit -m "feat(admin): product shelf-life field on the catalog form"
```

---

### Task 11: Full verification and spec status

**Files:**

- Modify: `docs/superpowers/specs/2026-08-20-label-editor-simplification-design.md` (Status line)

- [ ] **Step 1: Repo-wide gates**

```bash
pnpm turbo run typecheck lint test
```

(Export `DATABASE_URL` first — the db/api suites skip or fail without it. Fix anything red; the likely stragglers are exhaustive `Record<LabelField, …>` fixtures in tests untouched above.)

- [ ] **Step 2: Migration dry-run against a scratch database**

Run the packages/db migration suite one more time in isolation (it creates and drops its own scratch DBs):

```bash
pnpm --filter @markiro/db test
```

Expected: PASS, including `default-label-templates-migration` and the pre-existing `default-box-label-template-migration`.

- [ ] **Step 3: Update the spec status**

In the design spec, change `**Status:** Approved — pending implementation plan` to `**Status:** Implemented — automated gates complete; hardware print acceptance pending`. If `docs/superpowers/plans/` keeps a ledger file (check for `LEDGER*` / `README*` there), append this plan's entry following its format.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: mark label editor simplification spec implemented"
```
