# Pallet Placard (A4/A5) + Stock «Паллета 58×40» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a cabinet user print an A4 or A5 pallet placard (organisation, product, GTIN, box/unit counts, a per-production-date summary, and a large GS1-128 SSCC) from the pallet card, and seed every tenant with a second stock pallet thermal label, «Паллета 58×40», that repeats the 58×40 box label with the quantity row counting boxes.

**Architecture:** Two independent halves in one branch. (1) Domain: `buildBoxLabelSpec` gains an optional `quantity` parameter so the pallet 58×40 spec is the print-name box 58×40 with one caption/field substituted; `buildPalletLabelTemplates()` returns `[100×150, 58×40]`; migration 0164 seeds the new row for existing tenants; provisioning already loops the builder. (2) API: a pure renderer `pallet-placard.ts` beside `pallet-report.ts`, reusing `contents-report.ts`'s logo/barcode/escape helpers, fed by a new `palletPlacardData` loader and served at `GET /code-search/pallets/:id/placard?format=a4|a5`; the cabinet's pallet card gets a «Ярлык» button opening a small format-choice modal.

**Tech Stack:** TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Vitest, `@markiro/domain`, Drizzle + Postgres migrations (`packages/db`), NestJS (`apps/api`), React 19 + `@markiro/ui` + react-i18next (`apps/admin`).

**Spec:** `docs/superpowers/specs/2026-09-18-pallet-placard-design.md` (§2–§6 placard, §8 stock template).

## Global Constraints

- Branch `worktree-pallet-placard` in worktree `/Users/thevladbog/PRSOME/q/.claude/worktrees/pallet-placard`, cut from `main` at `5db4eb3e5`. Git commands must be run as `/usr/bin/git …` (the `rtk` shell hook otherwise refuses git inside a worktree). Never `git stash`. Commit only paths you changed; every message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Shared packages export compiled `dist`; they are NOT built in this worktree yet. Before any package test/typecheck: `pnpm turbo run build --filter='@markiro/api^...' --filter='@markiro/admin^...'`. After changing `packages/domain` or `packages/db`, rebuild that package (`pnpm --filter @markiro/domain build`, `pnpm --filter @markiro/db build`) before running consumer tests.
- Database-backed tests need `DATABASE_URL=postgres://markiro:markiro@localhost:55481/markiro` (container `markiro-task8-postgres`); API e2e also needs `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=http://localhost:3000`, `PLATFORM_AUTH_SECRET`, `PLATFORM_AUTH_URL`, `SAAS_ADMIN_ORIGIN`, `PAIRING_CODE_PEPPER` (values from `.env.example`) and `CHZ_TOKEN_ENCRYPTION_KEY` (canonical base64, 32 bytes). Report a skipped DB suite explicitly, never as a pass.
- Stock label byte identity: the sixteen stock box templates' JSON is inlined by migration 0123 and pinned by `packages/db` migration tests; the `quantity` parameter must default to today's `qty` / «Кол-во в упаковке:» so their output is byte-identical.
- Seed identity is `(tenant_id, name, purpose)`: the new template's name is exactly `Паллета 58×40` (Cyrillic, U+00D7 «×»), `purpose = 'pallet'`; `buildPalletLabelTemplates()[0]` stays «Паллета 100×150» so the org default and the editor's starting spec are unchanged.
- Placard content (spec §2): header = org logo (`brandLogo`: organisation logo, else Markiro lockup) + org name left, the single word **ПАЛЛЕТА** right, nothing else; key figures GTIN / Коробов / Единиц in cells separated by vertical rules; date summary `Дата производства · Годен до · Коробов · Единиц` (A5: no `Единиц` column, captions `Произв.` / `Кор.`) ascending by date, undated boxes last as `—`, `Итого` row; row cap A4 12 / A5 6 with a folded `и ещё K дат` row whose counts keep `Итого` exact; GS1-128 SSCC full content width (bars A4 30 mm / A5 22 mm) with HRI `(00)…` under it in ONE line with no spaces; footer A4 `ИНН …` left + `Сформировано в Маркиро` right, A5 `Маркиро` right only.
- «Годен до» = `shelfLifeExpiryDate(productionDate, shelfLifeDays)` from `@markiro/domain` (returns `""` when there is no shelf life → print `—`). Disassembled boxes are excluded from every count. Pallet product = `coalesce(pallets.product_id, shifts.product_id)`.
- Placard availability: closed or disassembled pallet WITH an SSCC; otherwise the API answers `409 { code: "PALLET_NOT_CLOSED" }` and the card shows no button. Disassembled → diagonal watermark **РАСФОРМИРОВАНА**.
- Every user-visible cabinet string goes through `t()` and is added to BOTH `apps/admin/src/i18n/ru.json` and `en.json` (`test/i18n.test.tsx` enforces parity). The renderer's Russian is server-side literal text like the existing reports.
- Gates: per package `pnpm --filter @markiro/<pkg> test`, `typecheck`, `lint`, `build`; finally `pnpm format:check` and `git diff --check`. Browser/printer output is NOT exercised by any automated check; say so in the report.

---

## File map

| Path                                                                                    | Responsibility                                                                    |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/domain/src/labels/defaults.ts`                                                | `BoxLabelQuantity`, `quantity` parameter, `buildPallet58x40LabelSpec()`           |
| `packages/domain/src/labels/pallet-defaults.ts`, `src/index.ts`                         | `PALLET_LABEL_58X40_TEMPLATE_NAME`, second entry of `buildPalletLabelTemplates()` |
| `packages/domain/test/pallet-defaults.test.ts`                                          | two templates, the 58×40 equals the box layout with one substitution              |
| `packages/db/migrations/0164_pallet_label_58x40.sql`, `meta/_journal.json`              | idempotent seed for existing tenants                                              |
| `packages/db/test/pallets-migration.test.ts`                                            | counts and drift guard for the new row                                            |
| `apps/api/test/provision-tenant-owner.e2e.test.ts`                                      | new tenants get both pallet templates                                             |
| `apps/api/src/modules/code-search/pallet-placard.ts` (new)                              | pure placard renderer + `summarizeByProductionDate`                               |
| `apps/api/test/pallet-placard.test.ts` (new)                                            | renderer unit tests                                                               |
| `apps/api/src/modules/code-search/code-search.service.ts`                               | `palletPlacardData`; report loader's product join fixed                           |
| `apps/api/src/modules/code-search/dto.ts`, `code-search.controller.ts`                  | `palletPlacardQuerySchema`, the route                                             |
| `apps/api/test/code-search-pallets.e2e.test.ts`, `subscription-route-inventory.test.ts` | route behaviour, inventory line                                                   |
| `apps/admin/src/pages/code-search/PalletCard.tsx`, `i18n/ru.json`, `en.json`            | «Ярлык» button + format modal                                                     |
| `apps/admin/test/warehouse-pallets.test.tsx`                                            | button visibility and opened URL                                                  |

---

### Task 1: Domain — `quantity` parameter and the stock «Паллета 58×40» spec

**Files:**

- Modify: `packages/domain/src/labels/defaults.ts` (`buildBoxLabelSpec` at ~line 311; the caption fit list ~line 355; elements `cap-qty` ~line 461 and `val-qty` ~line 494; new export after `buildDefaultLabelTemplates`)
- Modify: `packages/domain/src/labels/pallet-defaults.ts` (bottom)
- Modify: `packages/domain/src/index.ts:101`
- Test: `packages/domain/test/pallet-defaults.test.ts`

**Interfaces:**

- Produces:

  ```ts
  // defaults.ts
  export interface BoxLabelQuantity {
    field: "qty" | "qty.boxes";
    caption: string;
  }
  export function buildPallet58x40LabelSpec(): LabelTemplateSpec;
  // pallet-defaults.ts
  export const PALLET_LABEL_58X40_TEMPLATE_NAME = "Паллета 58×40";
  export function buildPalletLabelTemplates(): DefaultLabelTemplate[]; // [100×150, 58×40]
  ```

- [ ] **Step 1: Write the failing tests**

In `packages/domain/test/pallet-defaults.test.ts` change the import block to:

```ts
import {
  buildPalletLabelTemplates,
  buildPrintNameBoxLabelTemplates,
  code128ModuleCount,
  elementBoundsMm,
  GS1_128_QUIET_ZONE_MODULES,
  PALLET_LABEL_58X40_TEMPLATE_NAME,
  PALLET_LABEL_TEMPLATE_NAME,
  parseLabelTemplate,
  sampleLabelData,
  type LabelField,
} from "../src/index.js";
```

Replace the first case (`"ships exactly one pallet template"`) with:

```ts
it("ships the 100×150 first and the 58×40 second", () => {
  const names = buildPalletLabelTemplates().map((t) => t.name);
  // Order is load-bearing: provisioning makes [0] the organisation default
  // and the editor starts a new pallet template from [0].
  expect(names).toEqual([PALLET_LABEL_TEMPLATE_NAME, PALLET_LABEL_58X40_TEMPLATE_NAME]);
});
```

Change every `buildPalletLabelTemplates()[0]!.spec` in the cases "binds both counts and the SSCC", "encodes the SSCC…", "leaves GS1's…" and "does not overlap its rows vertically" into a loop over both templates where the assertion holds for both; for "binds both counts" split it:

```ts
it("binds the counts and the SSCC", () => {
  const [large, small] = buildPalletLabelTemplates();
  const bound = (spec: LabelTemplateSpec) =>
    new Set(spec.elements.flatMap((el) => (el.kind === "field" ? [el.field] : [])));
  expect(bound(large!.spec).has("qty")).toBe(true);
  expect(bound(large!.spec).has("qty.boxes")).toBe(true);
  expect(bound(large!.spec).has("sscc")).toBe(true);
  // The small label counts boxes only: «120 кор.» beside the dates.
  const smallBound = bound(small!.spec);
  expect(smallBound.has("qty.boxes")).toBe(true);
  expect(smallBound.has("qty")).toBe(false);
  expect(smallBound.has("product.printName")).toBe(true);
  expect(smallBound.has("date")).toBe(true);
  expect(smallBound.has("expiry")).toBe(true);
  expect(smallBound.has("sscc")).toBe(true);
});
```

(add `type LabelTemplateSpec` to the import). Then append a new `describe`:

```ts
describe("stock «Паллета 58×40»", () => {
  const spec = () => buildPalletLabelTemplates()[1]!.spec;

  it("is the print-name box 58×40 with the quantity row counting boxes", () => {
    const box = buildPrintNameBoxLabelTemplates().find(
      (t) => t.name === "Коробка 58×40 [Назв. для печати]",
    );
    expect(box).toBeDefined();
    const expected = structuredClone(box!.spec);
    for (const el of expected.elements) {
      if (el.kind === "text" && el.id === "cap-qty") el.text = "Коробов:";
      if (el.kind === "field" && el.id === "val-qty") el.field = "qty.boxes";
    }
    // Byte-for-byte the box layout otherwise: same geometry, same fonts,
    // same SSCC symbol — the owner asked for «ту же коробочную, под паллет».
    expect(spec()).toEqual(expected);
  });

  it("is 58×40 and names no resolution", () => {
    expect(spec().widthMm).toBe(58);
    expect(spec().heightMm).toBe(40);
    expect(PALLET_LABEL_58X40_TEMPLATE_NAME).not.toMatch(/dpi/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @markiro/domain exec vitest run test/pallet-defaults.test.ts`
Expected: FAIL — `PALLET_LABEL_58X40_TEMPLATE_NAME` is not exported.

- [ ] **Step 3: Add the `quantity` parameter to the box builder**

In `packages/domain/src/labels/defaults.ts`, just above `function buildBoxLabelSpec(` add:

```ts
/**
 * What the quantity row counts. The box families count units in the box
 * (`qty`, «Кол-во в упаковке:»); the stock «Паллета 58×40» reuses this exact
 * layout counting boxes on the pallet (`qty.boxes`, «Коробов:»). A parameter
 * rather than a second builder so the pallet label cannot drift from the box
 * one: same budget arithmetic, one substitution.
 */
export interface BoxLabelQuantity {
  field: "qty" | "qty.boxes";
  caption: string;
}

const UNIT_QUANTITY: BoxLabelQuantity = { field: "qty", caption: CAPTION_QTY };
```

Change the signature:

```ts
function buildBoxLabelSpec(
  widthMm: number,
  heightMm: number,
  dpi: 203 | 300,
  dates: DateFields,
  nameField: "product.name" | "product.printName" = "product.name",
  quantity: BoxLabelQuantity = UNIT_QUANTITY,
): LabelTemplateSpec {
```

In the caption fit list replace `{ text: CAPTION_QTY, boxMm: colW },` with `{ text: quantity.caption, boxMm: colW },`. In the `cap-qty` element replace `text: CAPTION_QTY,` with `text: quantity.caption,`; in the `val-qty` element replace `field: "qty",` with `field: quantity.field,`. (`QTY_SPECIMEN` «10000 шт.» stays the value-fit specimen: «120 кор.» is shorter, so the fit cannot move.)

After `buildDefaultLabelTemplates()` add:

```ts
/**
 * The stock «Паллета 58×40»: the print-name box 58×40 layout, quantity row
 * counting BOXES. Lives here, not in `pallet-defaults.ts`, because it is
 * built by the box budget above; `pallet-defaults.ts` only names it.
 */
export function buildPallet58x40LabelSpec(): LabelTemplateSpec {
  return buildBoxLabelSpec(58, 40, STOCK_AUTHORING_DPI, "with-dates", "product.printName", {
    field: "qty.boxes",
    caption: "Коробов:",
  });
}
```

- [ ] **Step 4: Register the template**

In `packages/domain/src/labels/pallet-defaults.ts` add the import `import { buildPallet58x40LabelSpec } from "./defaults.js";` (merge with the existing `./defaults.js` import), add below `PALLET_LABEL_TEMPLATE_NAME`:

```ts
/** Seed identity of the small stock pallet label (spec 2026-09-18 §8). Renaming re-seeds. */
export const PALLET_LABEL_58X40_TEMPLATE_NAME = "Паллета 58×40";
```

and replace `buildPalletLabelTemplates`:

```ts
/**
 * The stock pallet labels a tenant is seeded with, in seed order: the large
 * 100×150 FIRST (provisioning makes [0] the organisation default and the
 * editor starts a new pallet template from it), then the 58×40 twin of the
 * box label for plants whose pallet printer is loaded with box stock.
 */
export function buildPalletLabelTemplates(): DefaultLabelTemplate[] {
  return [
    { name: PALLET_LABEL_TEMPLATE_NAME, spec: buildPalletLabelSpec() },
    { name: PALLET_LABEL_58X40_TEMPLATE_NAME, spec: buildPallet58x40LabelSpec() },
  ];
}
```

In `packages/domain/src/index.ts` line 101 export the new constant:

```ts
export {
  buildPalletLabelTemplates,
  PALLET_LABEL_58X40_TEMPLATE_NAME,
  PALLET_LABEL_TEMPLATE_NAME,
} from "./labels/pallet-defaults.js";
```

- [ ] **Step 5: Run the domain suite**

Run: `pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint && pnpm --filter @markiro/domain build`
Expected: all green (the box-label fixture tests prove the sixteen box specs are unchanged).

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add packages/domain/src/labels/defaults.ts packages/domain/src/labels/pallet-defaults.ts packages/domain/src/index.ts packages/domain/test/pallet-defaults.test.ts
/usr/bin/git commit -m "feat(domain): stock «Паллета 58×40» label as the box 58×40 layout counting boxes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Seed «Паллета 58×40» for existing and new tenants

**Files:**

- Create: `packages/db/migrations/0164_pallet_label_58x40.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (append entry)
- Modify: `packages/db/test/pallets-migration.test.ts:202-220`
- Modify: `apps/api/test/provision-tenant-owner.e2e.test.ts:337-345`

**Interfaces:**

- Consumes: `buildPalletLabelTemplates()`, `PALLET_LABEL_58X40_TEMPLATE_NAME` (Task 1).

- [ ] **Step 1: Update the migration test first**

In `packages/db/test/pallets-migration.test.ts` import `PALLET_LABEL_58X40_TEMPLATE_NAME` alongside the existing domain imports, change the purpose-count case to expect `2`, and replace the seed case with:

```ts
it("seeds both stock pallet labels for every existing tenant, without duplicates", async () => {
  for (const id of [tenantId, otherTenantId]) {
    for (const [index, name] of [
      PALLET_LABEL_TEMPLATE_NAME,
      PALLET_LABEL_58X40_TEMPLATE_NAME,
    ].entries()) {
      const { rows } = await pool.query(
        "SELECT spec FROM label_templates WHERE tenant_id=$1 AND name=$2 AND purpose='pallet'",
        [id, name],
      );
      expect(rows, name).toHaveLength(1);
      // The inlined migration JSON and the builder must not drift apart.
      expect(rows[0]!.spec).toEqual(buildPalletLabelTemplates()[index]!.spec);
    }
  }
});
```

- [ ] **Step 2: Run it to verify failure**

Run (with `DATABASE_URL` exported): `pnpm --filter @markiro/db build && pnpm --filter @markiro/db exec vitest run test/pallets-migration.test.ts`
Expected: FAIL — count is 1 and «Паллета 58×40» has no row.

- [ ] **Step 3: Write the migration**

Get the exact JSON by running from `packages/domain` (after its build): `node -e 'import("./dist/index.js").then(m=>console.log(JSON.stringify(m.buildPalletLabelTemplates()[1].spec)))'`. It must equal:

```json
{
  "widthMm": 58,
  "heightMm": 40,
  "dpi": 203,
  "language": "zpl",
  "elements": [
    {
      "kind": "field",
      "id": "name",
      "xMm": 2,
      "yMm": 2,
      "field": "product.printName",
      "fontSizePt": 10,
      "bold": true,
      "maxWidthMm": 54,
      "maxLines": 3
    },
    {
      "kind": "line",
      "id": "sep1",
      "xMm": 2,
      "yMm": 18.2,
      "x2Mm": 56,
      "y2Mm": 18.2,
      "thicknessMm": 0.3
    },
    {
      "kind": "text",
      "id": "cap-date",
      "xMm": 2,
      "yMm": 18.8,
      "text": "Дата производства:",
      "fontSizePt": 5,
      "maxWidthMm": 18
    },
    {
      "kind": "text",
      "id": "cap-expiry",
      "xMm": 20,
      "yMm": 18.8,
      "text": "Годен до:",
      "fontSizePt": 5,
      "maxWidthMm": 18
    },
    {
      "kind": "text",
      "id": "cap-qty",
      "xMm": 38,
      "yMm": 18.8,
      "text": "Коробов:",
      "fontSizePt": 5,
      "maxWidthMm": 18
    },
    {
      "kind": "field",
      "id": "val-date",
      "xMm": 2,
      "yMm": 21.6,
      "field": "date",
      "fontSizePt": 8,
      "bold": true,
      "maxWidthMm": 18
    },
    {
      "kind": "field",
      "id": "val-expiry",
      "xMm": 20,
      "yMm": 21.6,
      "field": "expiry",
      "fontSizePt": 8,
      "bold": true,
      "maxWidthMm": 18
    },
    {
      "kind": "field",
      "id": "val-qty",
      "xMm": 38,
      "yMm": 20.9,
      "field": "qty.boxes",
      "fontSizePt": 8,
      "bold": true,
      "maxWidthMm": 18
    },
    {
      "kind": "line",
      "id": "sep2",
      "xMm": 2,
      "yMm": 26.2,
      "x2Mm": 56,
      "y2Mm": 26.2,
      "thicknessMm": 0.3
    },
    {
      "kind": "text",
      "id": "cap-egais",
      "xMm": 2,
      "yMm": 26.8,
      "text": "Код ЕГАИС:",
      "fontSizePt": 5,
      "maxWidthMm": 18
    },
    {
      "kind": "field",
      "id": "val-egais",
      "xMm": 20,
      "yMm": 26.8,
      "field": "product.egais",
      "fontSizePt": 8,
      "bold": true,
      "maxWidthMm": 36
    },
    {
      "kind": "line",
      "id": "sep3",
      "xMm": 2,
      "yMm": 31.4,
      "x2Mm": 56,
      "y2Mm": 31.4,
      "thicknessMm": 0.3
    },
    {
      "kind": "barcode",
      "id": "bc-sscc",
      "xMm": 9.5,
      "yMm": 32,
      "format": "code128",
      "data": "sscc",
      "sizeMm": 4.8,
      "moduleWidthMm": 0.2502
    },
    {
      "kind": "field",
      "id": "val-sscc",
      "xMm": 2,
      "yMm": 37,
      "field": "sscc",
      "fontSizePt": 5,
      "align": "center",
      "maxWidthMm": 54
    }
  ]
}
```

If the printed JSON differs (key order is irrelevant to `toEqual`, but values matter), use the printed one. Create `packages/db/migrations/0164_pallet_label_58x40.sql`:

```sql
-- Second stock PALLET label (spec 2026-09-18 §8): the 58×40 box layout with
-- the quantity row counting boxes. New tenants get it from
-- tenant-provisioning.service.ts (`buildPalletLabelTemplates()[1]`); this
-- seeds the identical row for tenants that already exist. The name is the
-- (tenant_id, name, purpose) seed identity, so a re-run cannot duplicate it.
-- The organisation default is NOT touched: «Паллета 100×150» stays it.
INSERT INTO label_templates (id, tenant_id, name, purpose, spec)
SELECT gen_random_uuid(), o.id, 'Паллета 58×40', 'pallet', '<PASTE THE JSON HERE>'::jsonb
  FROM organization o
 WHERE NOT EXISTS (
   SELECT 1 FROM label_templates t
    WHERE t.tenant_id = o.id AND t.name = 'Паллета 58×40' AND t.purpose = 'pallet'
 );
```

(replace `<PASTE THE JSON HERE>` with the JSON above, on one line). Append to `packages/db/migrations/meta/_journal.json` after the `0163` entry (mind the comma):

```json
    {
      "idx": 164,
      "version": "7",
      "when": <Date.now() in ms, e.g. 1789700000000>,
      "tag": "0164_pallet_label_58x40",
      "breakpoints": true
    }
```

Use `node -e 'console.log(Date.now())'` for `when`; it must be greater than 1789661574810.

- [ ] **Step 4: Run the db gates**

Run: `pnpm --filter @markiro/db build && pnpm --filter @markiro/db test && pnpm --filter @markiro/db typecheck && pnpm --filter @markiro/db lint`
Expected: green; `pallets-migration.test.ts` passes with both rows. If a `migrations-journal`/`migration-list` consistency test exists in `packages/db/test`, it must pass too — it will if the tag and file name match.

- [ ] **Step 5: Provisioning expectation**

In `apps/api/test/provision-tenant-owner.e2e.test.ts` change the comment/count to `// 16 box + 2 product_duplicate + 2 pallet (06d + spec 2026-09-18 §8).` and `expect(after).toHaveLength(20);`, import `PALLET_LABEL_58X40_TEMPLATE_NAME`, and make the pallets expectation:

```ts
expect(pallets).toEqual([
  expect.objectContaining({
    name: PALLET_LABEL_TEMPLATE_NAME,
    spec: buildPalletLabelTemplates()[0]!.spec,
  }),
  expect.objectContaining({
    name: PALLET_LABEL_58X40_TEMPLATE_NAME,
    spec: buildPalletLabelTemplates()[1]!.spec,
  }),
]);
```

(if `templates` there is not ordered by insertion, sort both sides by `name` first). Run: `pnpm --filter @markiro/api exec vitest run test/provision-tenant-owner.e2e.test.ts` (env loaded). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add packages/db/migrations/0164_pallet_label_58x40.sql packages/db/migrations/meta/_journal.json packages/db/test/pallets-migration.test.ts apps/api/test/provision-tenant-owner.e2e.test.ts
/usr/bin/git commit -m "feat(db): seed the stock «Паллета 58×40» label for every tenant

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Pure placard renderer

**Files:**

- Create: `apps/api/src/modules/code-search/pallet-placard.ts`
- Test: `apps/api/test/pallet-placard.test.ts` (new)

**Interfaces:**

- Consumes: `brandLogo(org)`, `ssccBarcode(sscc20)`, `ssccHri(sscc20)`, `escapeHtml`, `ReportOrg` from `./contents-report`; `shelfLifeExpiryDate(productionDate, shelfLifeDays)` from `@markiro/domain`.
- Produces:

  ```ts
  export type PlacardFormat = "a4" | "a5";
  export interface PalletPlacardBox {
    productionDate: string | null;
    codeCount: number;
    disassembledAt: Date | null;
  }
  export interface PalletPlacardData {
    sscc: string | null;
    status: "open" | "closed" | "disassembled";
    productName: string | null;
    gtin14: string | null;
    shelfLifeDays: number | null;
    org: ReportOrg | null;
    boxes: PalletPlacardBox[];
  }
  export interface PlacardDateRow {
    productionDate: string | null;
    expiryDate: string | null;
    boxCount: number;
    unitCount: number;
    foldedDates?: number;
  }
  export function summarizeByProductionDate(
    boxes: PalletPlacardBox[],
    shelfLifeDays: number | null,
    maxRows: number,
  ): PlacardDateRow[];
  export const PLACARD_ROW_CAP: Record<PlacardFormat, number>; // { a4: 12, a5: 6 }
  export function renderPalletPlacardHtml(data: PalletPlacardData, format: PlacardFormat): string;
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/pallet-placard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  PLACARD_ROW_CAP,
  renderPalletPlacardHtml,
  summarizeByProductionDate,
  type PalletPlacardBox,
  type PalletPlacardData,
} from "../src/modules/code-search/pallet-placard";

function box(productionDate: string | null, codeCount = 20, disassembledAt: Date | null = null) {
  return { productionDate, codeCount, disassembledAt } satisfies PalletPlacardBox;
}

function fixture(overrides: Partial<PalletPlacardData> = {}): PalletPlacardData {
  return {
    sscc: "00104600682000000019",
    status: "closed",
    productName: "Вода питьевая негазированная «Атолл» 0,5 л, ПЭТ",
    gtin14: "04600682000019",
    shelfLifeDays: 180,
    org: { name: "ООО «Атолл»", inn: "7701234567", logo: null },
    boxes: [box("2026-09-10"), box("2026-09-14"), box("2026-09-10")],
    ...overrides,
  };
}

describe("summarizeByProductionDate", () => {
  it("groups live boxes by production date, ascending, with inclusive expiry", () => {
    const rows = summarizeByProductionDate(fixture().boxes, 180, 12);
    expect(rows).toEqual([
      { productionDate: "2026-09-10", expiryDate: "2027-03-08", boxCount: 2, unitCount: 40 },
      { productionDate: "2026-09-14", expiryDate: "2027-03-12", boxCount: 1, unitCount: 20 },
    ]);
  });

  it("prints no expiry without a shelf life and puts undated boxes last", () => {
    const rows = summarizeByProductionDate([box(null), box("2026-09-10")], null, 12);
    expect(rows).toEqual([
      { productionDate: "2026-09-10", expiryDate: null, boxCount: 1, unitCount: 20 },
      { productionDate: null, expiryDate: null, boxCount: 1, unitCount: 20 },
    ]);
  });

  it("excludes a disassembled box from every count", () => {
    const rows = summarizeByProductionDate(
      [box("2026-09-10"), box("2026-09-10", 20, new Date("2026-09-15T00:00:00Z"))],
      180,
      12,
    );
    expect(rows.map((r) => [r.boxCount, r.unitCount])).toEqual([[1, 20]]);
  });

  it("folds the tail past the row cap into one row whose counts keep the total exact", () => {
    const boxes = Array.from({ length: 9 }, (_, i) =>
      box(`2026-09-${String(i + 1).padStart(2, "0")}`),
    );
    const rows = summarizeByProductionDate(boxes, null, 6);
    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 5).map((r) => r.productionDate)).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ]);
    expect(rows[5]).toEqual({
      productionDate: null,
      expiryDate: null,
      boxCount: 4,
      unitCount: 80,
      foldedDates: 4,
    });
    expect(rows.reduce((n, r) => n + r.boxCount, 0)).toBe(9);
  });
});

describe("pallet placard", () => {
  it("prints the header with only the word ПАЛЛЕТА, the organisation and the product", () => {
    const html = renderPalletPlacardHtml(fixture(), "a4");
    expect(html).toContain("ПАЛЛЕТА");
    expect(html).toContain("ООО «Атолл»");
    expect(html).toContain("Вода питьевая негазированная «Атолл» 0,5 л, ПЭТ");
    expect(html).toContain("04600682000019");
    // No status word, no kind, no closing time in the header.
    expect(html).not.toContain("Закрыта");
    expect(html).not.toContain("складская");
    expect(html).not.toContain("ИНН не указан");
  });

  it("prints the counts, the date summary and the total", () => {
    const html = renderPalletPlacardHtml(fixture(), "a4");
    expect(html).toContain("10.09.2026");
    expect(html).toContain("08.03.2027");
    expect(html).toContain("14.09.2026");
    expect(html).toContain("Итого");
    expect(html).toMatch(/pl-figure-value">3</);
    expect(html).toMatch(/pl-figure-value">60</);
  });

  it("prints the SSCC symbol and its HRI once, in one unbroken line", () => {
    const html = renderPalletPlacardHtml(fixture(), "a4");
    expect(html).toContain("<svg");
    expect(html.match(/\(00\)104600682000000019/g)?.length).toBe(1);
  });

  it("sizes the page per format and drops the units column on A5", () => {
    const a4 = renderPalletPlacardHtml(fixture(), "a4");
    const a5 = renderPalletPlacardHtml(fixture(), "a5");
    expect(a4).toContain("@page { size: A4;");
    expect(a5).toContain("@page { size: A5;");
    expect(a4).toContain("<th>Единиц</th>");
    expect(a5).not.toContain("<th>Единиц</th>");
    expect(a5).toContain("Произв.");
    expect(a4).toContain("ИНН 7701234567");
    expect(a5).not.toContain("ИНН 7701234567");
  });

  it("folds a long date list on A5 and says how many dates were folded", () => {
    const boxes = Array.from({ length: 9 }, (_, i) =>
      box(`2026-09-${String(i + 1).padStart(2, "0")}`),
    );
    const html = renderPalletPlacardHtml(fixture({ boxes }), "a5");
    expect(html).toContain("и ещё 4 дат");
    expect(PLACARD_ROW_CAP.a5).toBe(6);
  });

  it("watermarks a disassembled pallet and nothing else", () => {
    expect(renderPalletPlacardHtml(fixture(), "a4")).not.toContain("РАСФОРМИРОВАНА");
    expect(renderPalletPlacardHtml(fixture({ status: "disassembled" }), "a4")).toContain(
      "РАСФОРМИРОВАНА",
    );
  });

  it("prints dashes for a missing GTIN, shelf life and organisation", () => {
    const html = renderPalletPlacardHtml(
      fixture({ gtin14: null, shelfLifeDays: null, org: null }),
      "a4",
    );
    expect(html).toContain('pl-figure-value mono">—<');
    expect(html).not.toContain("ИНН");
    expect(html).toContain('data-brand-logo="markiro"');
  });

  it("escapes tenant-controlled text", () => {
    const html = renderPalletPlacardHtml(
      fixture({
        productName: '<script>alert("x")</script>',
        org: { name: "A & <b>", inn: null, logo: null },
      }),
      "a4",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; &lt;b&gt;");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @markiro/api exec vitest run test/pallet-placard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the renderer**

Create `apps/api/src/modules/code-search/pallet-placard.ts`:

```ts
import { shelfLifeExpiryDate } from "@markiro/domain";
import { brandLogo, escapeHtml, ssccBarcode, ssccHri, type ReportOrg } from "./contents-report";

/**
 * The printed pallet PLACARD (spec 2026-09-18): one page, A4 or A5, meant to
 * be taped to the stack — not the "Состав паллеты" contents list next door.
 * Large GS1-128 SSCC at the bottom, the pallet's identity above it, and a
 * per-production-date summary, because a warehouse pallet carries boxes from
 * several shifts and «дата — количество» is how the stock is counted.
 *
 * Pure: no I/O, no `Date.now()`, no timezone (only civil dates are printed).
 */

export type PlacardFormat = "a4" | "a5";

export interface PalletPlacardBox {
  /** The box's shift's effective production day (`YYYY-MM-DD`) or null. */
  productionDate: string | null;
  /** Live unit codes inside the box. */
  codeCount: number;
  /** Set once the box was taken off; it keeps its `pallet_id` either way. */
  disassembledAt: Date | null;
}

export interface PalletPlacardData {
  /** 20-character machine form `00…`, or null for a pallet closed without one. */
  sscc: string | null;
  status: "open" | "closed" | "disassembled";
  productName: string | null;
  gtin14: string | null;
  shelfLifeDays: number | null;
  org: ReportOrg | null;
  /** Every box that ever joined, disassembled ones included. */
  boxes: PalletPlacardBox[];
}

export interface PlacardDateRow {
  /** Null for the undated group and for the folded tail row. */
  productionDate: string | null;
  /** `YYYY-MM-DD` or null when there is no shelf life or no date. */
  expiryDate: string | null;
  boxCount: number;
  unitCount: number;
  /** Set only on the folded tail row: how many distinct dates it stands for. */
  foldedDates?: number;
}

/** Date rows a page can hold before the tail is folded (spec §2.1). */
export const PLACARD_ROW_CAP: Record<PlacardFormat, number> = { a4: 12, a5: 6 };

/**
 * Live boxes grouped by production date, ascending, undated last; the tail
 * past `maxRows` collapses into one row so `Итого` stays the sum of what is
 * printed. Exported for tests.
 */
export function summarizeByProductionDate(
  boxes: PalletPlacardBox[],
  shelfLifeDays: number | null,
  maxRows: number,
): PlacardDateRow[] {
  const groups = new Map<string | null, { boxCount: number; unitCount: number }>();
  for (const box of boxes) {
    if (box.disassembledAt !== null) continue;
    const group = groups.get(box.productionDate) ?? { boxCount: 0, unitCount: 0 };
    group.boxCount += 1;
    group.unitCount += box.codeCount;
    groups.set(box.productionDate, group);
  }
  const dated = [...groups.entries()]
    .filter(
      (entry): entry is [string, { boxCount: number; unitCount: number }] => entry[0] !== null,
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([productionDate, counts]) => {
      const expiry = shelfLifeExpiryDate(productionDate, shelfLifeDays);
      return { productionDate, expiryDate: expiry === "" ? null : expiry, ...counts };
    });
  const undated = groups.get(null);
  const rows: PlacardDateRow[] = undated
    ? [...dated, { productionDate: null, expiryDate: null, ...undated }]
    : dated;

  if (rows.length <= maxRows || maxRows < 2) return rows;
  const kept = rows.slice(0, maxRows - 1);
  const folded = rows.slice(maxRows - 1);
  return [
    ...kept,
    {
      productionDate: null,
      expiryDate: null,
      boxCount: folded.reduce((n, r) => n + r.boxCount, 0),
      unitCount: folded.reduce((n, r) => n + r.unitCount, 0),
      foldedDates: folded.length,
    },
  ];
}

/** `2026-09-10` → `10.09.2026`; anything else is printed as given. */
function civilDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function dash(value: string | null): string {
  return value === null || value === "" ? "—" : escapeHtml(value);
}

/** Russian plural of «дата» for the folded row: 1 дата, 2–4 даты, 5+ дат. */
function datesWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "дата";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "даты";
  return "дат";
}

interface PageSize {
  page: "A4" | "A5";
  widthMm: number;
  heightMm: number;
  marginMm: number;
  namePt: number;
  figurePt: number;
  tablePt: number;
  barsMm: number;
  hriPt: number;
}

const SIZES: Record<PlacardFormat, PageSize> = {
  a4: {
    page: "A4",
    widthMm: 210,
    heightMm: 297,
    marginMm: 14,
    namePt: 18,
    figurePt: 16,
    tablePt: 11,
    barsMm: 30,
    hriPt: 15,
  },
  a5: {
    page: "A5",
    widthMm: 148,
    heightMm: 210,
    marginMm: 10,
    namePt: 14,
    figurePt: 13,
    tablePt: 10,
    barsMm: 22,
    hriPt: 11,
  },
};

function dateTable(rows: PlacardDateRow[], format: PlacardFormat): string {
  const compact = format === "a5";
  const head = compact
    ? '<tr><th>Произв.</th><th>Годен до</th><th class="n">Кор.</th></tr>'
    : '<tr><th>Дата производства</th><th>Годен до</th><th class="n">Коробов</th><th>Единиц</th></tr>';
  const body = rows
    .map((row) => {
      const label =
        row.foldedDates !== undefined
          ? `и ещё ${row.foldedDates} ${datesWord(row.foldedDates)}`
          : row.productionDate === null
            ? "—"
            : civilDate(row.productionDate);
      const expiry = row.expiryDate === null ? "—" : civilDate(row.expiryDate);
      const units = compact ? "" : `<td class="n">${row.unitCount}</td>`;
      return `<tr><td>${escapeHtml(label)}</td><td>${expiry}</td><td class="n">${row.boxCount}</td>${units}</tr>`;
    })
    .join("");
  const boxes = rows.reduce((n, r) => n + r.boxCount, 0);
  const units = rows.reduce((n, r) => n + r.unitCount, 0);
  const total = compact
    ? `<tr class="total"><td colspan="2">Итого</td><td class="n">${boxes}</td></tr>`
    : `<tr class="total"><td colspan="2">Итого</td><td class="n">${boxes}</td><td class="n">${units}</td></tr>`;
  return `<table class="pl-dates">${head}${body}${total}</table>`;
}

/** Pure: builds the print-ready placard document. */
export function renderPalletPlacardHtml(data: PalletPlacardData, format: PlacardFormat): string {
  const size = SIZES[format];
  const live = data.boxes.filter((box) => box.disassembledAt === null);
  const boxCount = live.length;
  const unitCount = live.reduce((n, box) => n + box.codeCount, 0);
  const rows = summarizeByProductionDate(data.boxes, data.shelfLifeDays, PLACARD_ROW_CAP[format]);
  const hri = data.sscc ? ssccHri(data.sscc) : null;
  const title = hri ?? "Без SSCC";
  const orgName = data.org ? escapeHtml(data.org.name) : "—";
  const inn = data.org?.inn ? `ИНН ${escapeHtml(data.org.inn)}` : "";
  const footer =
    format === "a4"
      ? `<span>${inn}</span><span>Сформировано в Маркиро</span>`
      : `<span></span><span>Маркиро</span>`;
  const barcode = data.sscc
    ? `<div class="pl-bars">${ssccBarcode(data.sscc)}</div><div class="pl-hri mono">${escapeHtml(hri ?? "")}</div>`
    : `<div class="pl-hri">Без SSCC</div>`;
  const watermark =
    data.status === "disassembled"
      ? `<div class="pl-watermark" aria-hidden="true">РАСФОРМИРОВАНА</div>`
      : "";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Ярлык паллеты ${escapeHtml(title)}</title>
<style>
@page { size: ${size.page}; margin: 0 }
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: #E9E7E1; font-family: Arial, sans-serif; color: #17161A; }
.mono { font-family: monospace; font-variant-numeric: tabular-nums; }
.pl-page { position: relative; width: ${size.widthMm}mm; height: ${size.heightMm}mm; margin: 8mm auto; padding: ${size.marginMm}mm; background: #fff; display: flex; flex-direction: column; gap: 4mm; overflow: hidden; font-size: ${size.tablePt}pt; line-height: 1.3; }
.pl-header { display: flex; justify-content: space-between; align-items: center; gap: 6mm; padding-bottom: 3mm; border-bottom: .4mm solid #17161A; }
.pl-brand { display: flex; align-items: center; gap: 3mm; min-width: 0; }
.brand-logo { display: block; max-width: 40mm; max-height: 12mm; width: auto; height: auto; object-fit: contain; }
.brand-logo--markiro { width: 36mm; height: 8mm; }
.pl-org { font-weight: 700; }
.pl-title { font-size: ${size.figurePt}pt; font-weight: 700; letter-spacing: .08em; white-space: nowrap; }
.pl-name { font-size: ${size.namePt}pt; font-weight: 700; line-height: 1.2; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden; }
.pl-figures { display: flex; border-top: .3mm solid #C9C6BD; border-bottom: .3mm solid #C9C6BD; }
.pl-figure { flex: 1; padding: 2mm 3mm; border-left: .3mm solid #C9C6BD; min-width: 0; }
.pl-figure:first-child { border-left: 0; padding-left: 0; }
.pl-figure-label { display: block; color: #6B6862; font-size: ${size.tablePt - 2}pt; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.pl-figure-value { display: block; font-size: ${size.figurePt}pt; font-weight: 700; overflow-wrap: anywhere; }
.pl-dates { width: 100%; border-collapse: collapse; }
.pl-dates th { text-align: left; font-weight: 700; color: #6B6862; padding: 1mm 2mm; border-bottom: .3mm solid #C9C6BD; border-left: .25mm solid #EDEBE5; }
.pl-dates td { padding: 1mm 2mm; border-bottom: .25mm solid #EDEBE5; border-left: .25mm solid #EDEBE5; }
.pl-dates th:first-child, .pl-dates td:first-child { border-left: 0; padding-left: 0; }
.pl-dates .n { text-align: right; }
.pl-dates .total td { font-weight: 700; border-bottom: 0; }
.pl-code { margin-top: auto; display: flex; flex-direction: column; align-items: center; gap: 2mm; }
.pl-bars { height: ${size.barsMm}mm; width: 100%; display: flex; justify-content: center; }
.pl-bars svg { display: block; height: 100%; width: auto; max-width: 100%; }
.pl-hri { font-size: ${size.hriPt}pt; font-weight: 700; white-space: nowrap; letter-spacing: .04em; }
.pl-footer { display: flex; justify-content: space-between; padding-top: 2mm; border-top: .25mm solid #E0DED7; color: #6B6862; font: ${size.tablePt - 2}pt/1.3 monospace; }
.pl-watermark { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) rotate(-30deg); font-size: ${size.figurePt * 2.5}pt; font-weight: 700; letter-spacing: .1em; color: rgba(23, 22, 26, .16); white-space: nowrap; pointer-events: none; }
.rep-code-missing { font-size: 9pt; color: #6B6862; }
@media print { body { background: #fff; } .pl-page { margin: 0; } }
</style>
</head>
<body>
<section class="pl-page">
  ${watermark}
  <header class="pl-header">
    <div class="pl-brand">${brandLogo(data.org)}<span class="pl-org">${orgName}</span></div>
    <span class="pl-title">ПАЛЛЕТА</span>
  </header>
  <div class="pl-name">${dash(data.productName)}</div>
  <div class="pl-figures">
    <div class="pl-figure"><span class="pl-figure-label">GTIN</span><span class="pl-figure-value mono">${dash(data.gtin14)}</span></div>
    <div class="pl-figure"><span class="pl-figure-label">Коробов</span><span class="pl-figure-value">${boxCount}</span></div>
    <div class="pl-figure"><span class="pl-figure-label">Единиц</span><span class="pl-figure-value">${unitCount}</span></div>
  </div>
  ${dateTable(rows, format)}
  <div class="pl-code">${barcode}</div>
  <footer class="pl-footer">${footer}</footer>
</section>
</body>
</html>`;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @markiro/api exec vitest run test/pallet-placard.test.ts`
Expected: PASS (9 tests). If the `pl-figure-value">3<` regex misses because of whitespace, match the emitted markup exactly rather than loosening the assertion.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add apps/api/src/modules/code-search/pallet-placard.ts apps/api/test/pallet-placard.test.ts
/usr/bin/git commit -m "feat(api): pure A4/A5 pallet placard renderer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Loader, route and e2e

**Files:**

- Modify: `apps/api/src/modules/code-search/code-search.service.ts` (imports ~line 5–10; `palletReportData` product join ~lines 1270–1276; new method after it)
- Modify: `apps/api/src/modules/code-search/dto.ts` (after `boxReportQuerySchema`)
- Modify: `apps/api/src/modules/code-search/code-search.controller.ts` (imports; new route after `palletReport`)
- Modify: `apps/api/test/subscription-route-inventory.test.ts:89` (add a line)
- Test: `apps/api/test/code-search-pallets.e2e.test.ts` (new `describe` after "printed contents form")

**Interfaces:**

- Consumes: `PalletPlacardData`, `PlacardFormat`, `renderPalletPlacardHtml` (Task 3).
- Produces: `GET /code-search/pallets/:palletId/placard?format=a4|a5&timeZone=` (200 HTML; 404 unknown/foreign; 409 `{ code: "PALLET_NOT_CLOSED" }` when open or without SSCC).

- [ ] **Step 1: Write the failing e2e**

In `apps/api/test/code-search-pallets.e2e.test.ts` add after the "printed contents form" `describe` (before the mutating tests):

```ts
describe("printed placard", () => {
  it("renders the A4 placard by default and the A5 one on request", async () => {
    const a4 = await agent
      .get(`/code-search/pallets/${palletId}/placard`)
      .expect(200)
      .expect("Content-Type", /text\/html/);
    expect(a4.text).toContain("@page { size: A4;");
    expect(a4.text).toContain("ПАЛЛЕТА");
    expect(a4.text).toContain(`(00)${palletSscc}`);
    expect(a4.text).toContain("Cola");
    expect(a4.text).toContain(VALID_GTIN14);
    // Two live boxes, seven units, one production date.
    expect(a4.text).toMatch(/pl-figure-value">2</);
    expect(a4.text).toMatch(/pl-figure-value">7</);
    const a5 = await agent
      .get(`/code-search/pallets/${palletId}/placard`)
      .query({ format: "a5" })
      .expect(200);
    expect(a5.text).toContain("@page { size: A5;");
  });

  it("refuses an open pallet with PALLET_NOT_CLOSED", async () => {
    // A box that names a pallet the device never closed leaves an OPEN
    // pallet row behind -- the ingest creates it on first mention.
    await postBatch({
      items: [item("c4-0", "b4", new Date(ITEM_BASE + 300_000).toISOString())],
    });
    await postBatch({
      boxes: [
        {
          boxId: "b4",
          shiftId,
          terminalId: "t1",
          sscc: "123460682000000204",
          closedAt: BOX_CLOSED_AT,
          operatorId,
          devicePalletId: "p-open",
        },
      ],
    });
    const pallets = await agent.get(`/pallets?shiftId=${shiftId}`).expect(200);
    const open = (pallets.body.items as { id: string; closedAt: string | null }[]).find(
      (p) => p.closedAt === null,
    );
    expect(open).toBeDefined();
    const res = await agent.get(`/code-search/pallets/${open!.id}/placard`).expect(409);
    expect(res.body).toMatchObject({ code: "PALLET_NOT_CLOSED" });
  });

  it("validates the format, is denied to a station key and across tenants", async () => {
    await agent.get(`/code-search/pallets/${palletId}/placard`).query({ format: "a3" }).expect(400);
    await request(app!.getHttpServer())
      .get(`/code-search/pallets/${palletId}/placard`)
      .set("x-api-key", stationKey)
      .expect(403);
    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);
    await other.get(`/code-search/pallets/${palletId}/placard`).expect(404);
    await agent.get(`/code-search/pallets/${randomUUID()}/placard`).expect(404);
  });
});
```

Note: the open-pallet case ADDS a fourth box `b4` and pallet `p-open` to the shared fixture. Check the later mutating tests ("keeps a disassembled member box…", "reports the pallet's own disassembly…") only address `palletId`/`box2Id`, so an extra open pallet in the shift does not change their assertions; if one of them counts pallets in the shift, place this `describe` AFTER them instead.

Also add to `apps/api/test/subscription-route-inventory.test.ts` right after the `palletReport` line:

```ts
      "GET /code-search/pallets/:palletId/placard (CodeSearchController.palletPlacard)",
```

- [ ] **Step 2: Run to verify failure**

Run (env loaded): `pnpm --filter @markiro/api exec vitest run test/code-search-pallets.e2e.test.ts test/subscription-route-inventory.test.ts`
Expected: FAIL — 404 on `/placard`, inventory mismatch.

- [ ] **Step 3: DTO**

In `apps/api/src/modules/code-search/dto.ts` after `BoxReportQueryDto`:

```ts
/** `GET /code-search/pallets/:id/placard`: the paper size, A4 unless asked for A5. */
export const palletPlacardQuerySchema = boxReportQuerySchema.extend({
  format: z.enum(["a4", "a5"]).default("a4"),
});
export type PalletPlacardQueryDto = z.infer<typeof palletPlacardQuerySchema>;
```

- [ ] **Step 4: Loader (and the report's product join)**

In `code-search.service.ts` add to the imports: `import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";` and `import type { PalletPlacardData } from "./pallet-placard";`. In `palletReportData` replace the products join with the coalesce the card already uses:

```ts
      // A warehouse pallet carries its own `product_id`, a production one the
      // shift's -- the same coalesce `getPalletCard` and `PalletsService` use.
      .leftJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.pallets.tenantId),
          sql`${schema.products.id} = coalesce(${schema.pallets.productId}, ${schema.shifts.productId})`,
        ),
      )
```

Then add after `palletReportData`:

```ts
  /**
   * The printed placard's data (spec 2026-09-18): identity plus each member
   * box's production day and live unit count. Refuses a pallet that is open
   * or has no SSCC -- a placard without a scannable symbol is not a placard,
   * and the card never offers one for such a pallet.
   */
  async palletPlacardData(tenantId: string, palletId: string): Promise<PalletPlacardData> {
    const [pallet] = await this.db
      .select({
        sscc: schema.pallets.sscc,
        closedAt: schema.pallets.closedAt,
        disassembledAt: schema.pallets.disassembledAt,
        productName: schema.products.name,
        gtin14: schema.products.gtin14,
        shelfLifeDays: schema.products.shelfLifeDays,
      })
      .from(schema.pallets)
      .leftJoin(
        schema.shifts,
        and(
          eq(schema.shifts.tenantId, schema.pallets.tenantId),
          eq(schema.shifts.id, schema.pallets.shiftId),
        ),
      )
      .leftJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.pallets.tenantId),
          sql`${schema.products.id} = coalesce(${schema.pallets.productId}, ${schema.shifts.productId})`,
        ),
      )
      .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.id, palletId)));

    if (!pallet) throw new NotFoundException();
    if (pallet.closedAt === null || pallet.sscc === null) {
      throw new ConflictException({ code: "PALLET_NOT_CLOSED", message: "Pallet must be closed" });
    }

    const [org] = await this.db
      .select({
        name: schema.organization.name,
        inn: schema.orgProfiles.inn,
        logo: schema.organization.logo,
      })
      .from(schema.organization)
      .leftJoin(schema.orgProfiles, eq(schema.orgProfiles.tenantId, schema.organization.id))
      .where(eq(schema.organization.id, tenantId));

    // Each box's OWN production day (its shift's), the same expression the
    // card prints; the live count is the report's predicate, so the two forms
    // never disagree about what stands on the stack.
    const boxRows = await this.db
      .select({
        productionDate: sql<
          string | null
        >`coalesce(${schema.shifts.productionDate}, ${schema.shifts.plannedDate})::text`,
        disassembledAt: schema.boxes.disassembledAt,
        codeCount: sql<number>`count(${schema.boxItems.codeHash})::int`,
      })
      .from(schema.boxes)
      .innerJoin(
        schema.shifts,
        and(
          eq(schema.shifts.tenantId, schema.boxes.tenantId),
          eq(schema.shifts.id, schema.boxes.shiftId),
        ),
      )
      .leftJoin(
        schema.boxItems,
        and(
          eq(schema.boxItems.tenantId, schema.boxes.tenantId),
          eq(schema.boxItems.boxId, schema.boxes.id),
          isNull(schema.boxItems.displacedAt),
          or(
            isNull(schema.boxItems.removedAt),
            eq(schema.boxItems.removedAt, schema.boxes.disassemblyReceivedAt),
          ),
        ),
      )
      .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.palletId, palletId)))
      .groupBy(schema.boxes.id, schema.shifts.id)
      .orderBy(schema.boxes.closedAt, schema.boxes.id);

    return {
      sscc: formatSsccWithAi(pallet.sscc),
      status: pallet.disassembledAt ? "disassembled" : "closed",
      productName: pallet.productName,
      gtin14: pallet.gtin14,
      shelfLifeDays: pallet.shelfLifeDays,
      org: org ? { name: org.name, inn: org.inn, logo: org.logo } : null,
      boxes: boxRows.map((row) => ({
        productionDate: row.productionDate,
        codeCount: row.codeCount,
        disassembledAt: row.disassembledAt,
      })),
    };
  }
```

- [ ] **Step 5: Route**

In `code-search.controller.ts` extend the `./dto` import with `palletPlacardQuerySchema, type PalletPlacardQueryDto` and add `import { renderPalletPlacardHtml } from "./pallet-placard";`. After `palletReport` add:

```ts
  /**
   * Print-ready A4/A5 pallet PLACARD: organisation, product, counts, a
   * per-production-date summary and a large GS1-128 SSCC, for taping to the
   * stack. Same open-in-new-tab HTML contract as the reports above.
   */
  @Get("pallets/:palletId/placard")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Render the pallet placard",
    description:
      'Print-ready A4 (default) or A5 HTML placard for opening in a new tab: organisation and logo, product and GTIN, box and unit counts, a summary by production date with "годен до", and a large GS1-128 SSCC. Only a closed pallet with an SSCC has one; an open pallet or one without an SSCC answers 409 PALLET_NOT_CLOSED. A disassembled pallet prints with a watermark.',
  })
  @ApiParam({ name: "palletId", schema: { type: "string", format: "uuid" } })
  @ApiProduces("text/html")
  @ApiZodQuery(palletPlacardQuerySchema)
  @ApiZodValidationError()
  @ApiOkResponse({ schema: { type: "string" }, description: "Print-ready HTML document." })
  @ApiHttpErrors(401, 403, 404, 409)
  async palletPlacard(
    @Req() req: RequestWithTenant,
    @Param("palletId", new ParseUUIDPipe()) palletId: string,
    @Res({ passthrough: true }) res: Response,
    @Query(new ZodValidationPipe(palletPlacardQuerySchema)) query: PalletPlacardQueryDto,
  ): Promise<string> {
    const data = await this.codeSearchService.palletPlacardData(req.tenantId!, palletId);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return renderPalletPlacardHtml(data, query.format);
  }
```

- [ ] **Step 6: Run the API gates**

Run (env loaded): `pnpm --filter @markiro/api exec vitest run test/code-search-pallets.e2e.test.ts test/subscription-route-inventory.test.ts test/pallet-report.test.ts test/openapi-docs.test.ts test/auth-route-policy.test.ts && pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint`
Expected: PASS. If `auth-route-policy.test.ts` or another inventory test enumerates routes, add the new route there in the same shape as `palletReport`'s line.

- [ ] **Step 7: Commit**

```bash
/usr/bin/git add apps/api/src/modules/code-search/code-search.service.ts apps/api/src/modules/code-search/dto.ts apps/api/src/modules/code-search/code-search.controller.ts apps/api/test/code-search-pallets.e2e.test.ts apps/api/test/subscription-route-inventory.test.ts
/usr/bin/git commit -m "feat(api): GET /code-search/pallets/:id/placard (A4/A5) and warehouse product on the contents report

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Cabinet — «Ярлык» button with A4/A5 choice

**Files:**

- Modify: `apps/admin/src/pages/code-search/PalletCard.tsx` (imports line 13–19; state after `createDocument` ~line 66; actions ~lines 212–234; modal before the closing `</div>` of the page)
- Modify: `apps/admin/src/i18n/ru.json:2787` and `en.json:2787` (`pages.codeSearch.palletCard`)
- Test: `apps/admin/test/warehouse-pallets.test.tsx` (append a `describe`)

**Interfaces:**

- Consumes: the route from Task 4; `Modal`, `RadioGroup`, `Button` from `@markiro/ui`; `renderCard`, `WAREHOUSE_CARD`, `READ_ONLY` from the test file.

- [ ] **Step 1: Write the failing tests**

Append to `apps/admin/test/warehouse-pallets.test.tsx`:

```tsx
describe("pallet placard from the card", () => {
  it("opens the A4 placard by default and the A5 one when chosen", async () => {
    const openMock = vi.fn();
    vi.stubGlobal("open", openMock);
    const { user } = renderCard(WAREHOUSE_CARD);

    await user.click(await screen.findByRole("button", { name: "Ярлык" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Ярлык паллеты" }));
    expect(dialog.getByRole("radio", { name: "A4" }).getAttribute("aria-checked")).toBe("true");
    await user.click(dialog.getByRole("button", { name: "Открыть" }));
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(String(openMock.mock.calls[0]?.[0])).toMatch(
      /^\/api\/code-search\/pallets\/pal-w1\/placard\?format=a4&timeZone=/,
    );
    expect(screen.queryByRole("dialog", { name: "Ярлык паллеты" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Ярлык" }));
    const again = within(await screen.findByRole("dialog", { name: "Ярлык паллеты" }));
    await user.click(again.getByRole("radio", { name: "A5" }));
    await user.click(again.getByRole("button", { name: "Открыть" }));
    expect(String(openMock.mock.calls[1]?.[0])).toContain("/placard?format=a5&timeZone=");
  });

  it("offers no placard for an open pallet or one without an SSCC", async () => {
    renderCard({ ...WAREHOUSE_CARD, status: "open", closedAt: null });
    expect(await screen.findByRole("heading", { name: "(00)104600682000000019" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Ярлык" })).toBeNull();
    cleanup();

    renderCard({ ...WAREHOUSE_CARD, sscc: null });
    expect(await screen.findByRole("heading", { name: "Без SSCC" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Ярлык" })).toBeNull();
  });
});
```

`renderCard`'s default `extra` answers the exports section's requests with `{ items: [] }` already; if the pallet-exports requests need arrays, pass `(url) => (url.includes("/exports") || url.includes("/formats") ? [] : { items: [] })` as the third argument, exactly as the "pallet disassembly" cases do.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @markiro/admin exec vitest run test/warehouse-pallets.test.tsx -t "placard"`
Expected: FAIL — no «Ярлык» button.

- [ ] **Step 3: Strings**

`ru.json`, inside `pages.codeSearch.palletCard` (after `disassembleError`):

```json
"placard": {
  "action": "Ярлык",
  "title": "Ярлык паллеты",
  "formatLabel": "Формат листа",
  "format": { "a4": "A4", "a5": "A5" },
  "open": "Открыть",
  "hint": "Откроется в новой вкладке — распечатайте на обычном принтере и прикрепите на паллету."
},
```

`en.json`:

```json
"placard": {
  "action": "Placard",
  "title": "Pallet placard",
  "formatLabel": "Paper size",
  "format": { "a4": "A4", "a5": "A5" },
  "open": "Open",
  "hint": "Opens in a new tab — print it on an office printer and attach it to the pallet."
},
```

- [ ] **Step 4: The button and the modal**

In `PalletCard.tsx`:

1. Imports: `import { useState, type ReactNode } from "react";` and add `Modal, RadioGroup` to the `@markiro/ui` import.
2. After `const createDocument = useCreateDocument();`:

```tsx
const [placardOpen, setPlacardOpen] = useState(false);
const [placardFormat, setPlacardFormat] = useState<"a4" | "a5">("a4");
```

3. After `canDisassemble` (below the early returns):

```tsx
// A placard is a scannable SSCC on paper: only a closed (or disassembled,
// for a historical reprint) pallet that has one gets the action -- the same
// rule the server enforces with 409 PALLET_NOT_CLOSED.
const canPlacard = pallet.sscc !== null && pallet.status !== "open";

const openPlacard = () => {
  const query = new URLSearchParams({
    format: placardFormat,
    timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  window.open(`/api/code-search/pallets/${pallet.id}/placard?${query}`);
  setPlacardOpen(false);
};
```

4. In the header `actions`, after the «Распечатать» button:

```tsx
{
  canPlacard ? (
    <Button type="button" variant="secondary" onClick={() => setPlacardOpen(true)}>
      {t("pages.codeSearch.palletCard.placard.action")}
    </Button>
  ) : null;
}
```

5. Before the page's closing `</div>` (after the exports section):

```tsx
<Modal
  open={placardOpen}
  title={t("pages.codeSearch.palletCard.placard.title")}
  closeLabel={t("common.close")}
  onClose={() => setPlacardOpen(false)}
  width={420}
  footer={
    <>
      <Button type="button" variant="secondary" onClick={() => setPlacardOpen(false)}>
        {t("common.cancel")}
      </Button>
      <Button type="button" onClick={openPlacard}>
        {t("pages.codeSearch.palletCard.placard.open")}
      </Button>
    </>
  }
>
  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <RadioGroup
      label={t("pages.codeSearch.palletCard.placard.formatLabel")}
      name="pallet-placard-format"
      value={placardFormat}
      onValueChange={(value) => setPlacardFormat(value === "a5" ? "a5" : "a4")}
      options={[
        { value: "a4", label: t("pages.codeSearch.palletCard.placard.format.a4") },
        { value: "a5", label: t("pages.codeSearch.palletCard.placard.format.a5") },
      ]}
    />
    <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
      {t("pages.codeSearch.palletCard.placard.hint")}
    </span>
  </div>
</Modal>
```

If `Modal` renders the dialog only when `open` is true and the accessible name comes from `title` (check `packages/ui/src/components/Modal.tsx` — it sets `aria-labelledby` to the title id), the test's `findByRole("dialog", { name: "Ярлык паллеты" })` resolves; otherwise pass the same string as `aria-label` via `className`-adjacent prop the component offers, and say so in the report.

- [ ] **Step 5: Run the admin gates**

Run: `pnpm --filter @markiro/admin exec vitest run test/warehouse-pallets.test.tsx test/pallets.test.tsx test/i18n.test.tsx && pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add apps/admin/src/pages/code-search/PalletCard.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/warehouse-pallets.test.tsx
/usr/bin/git commit -m "feat(admin): «Ярлык» on the pallet card opens the A4/A5 placard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Full gates and spec status

**Files:**

- Modify: `docs/superpowers/specs/2026-09-18-pallet-placard-design.md:3` (status line)

- [ ] **Step 1: Run every affected package's gates**

```bash
pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint && pnpm --filter @markiro/domain build
pnpm --filter @markiro/db test && pnpm --filter @markiro/db typecheck && pnpm --filter @markiro/db lint && pnpm --filter @markiro/db build
pnpm --filter @markiro/api test && pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint && pnpm --filter @markiro/api build
pnpm --filter @markiro/admin test && pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint && pnpm --filter @markiro/admin build
pnpm format:check
/usr/bin/git diff --check
```

All with the DB/API env loaded; record any suite that skipped for lack of `DATABASE_URL` as skipped, not passed. The station and handheld consume the new template through existing feeds and are not rebuilt here — say so.

- [ ] **Step 2: Spec status**

Change line 3 of the spec to `**Status:** Implemented 2026-09-18 (this branch); mock-ups reviewed in chat, header reduced to «ПАЛЛЕТА» only.`

- [ ] **Step 3: Review the whole diff and commit**

`/usr/bin/git fetch origin main && /usr/bin/git diff origin/main...HEAD --stat`, read the source diff once (no `any`, no `!` beyond the established `queryFn`/`req.tenantId!` patterns, both locales updated, migration idempotent, route inventoried). Then:

```bash
/usr/bin/git add docs/superpowers/specs/2026-09-18-pallet-placard-design.md
/usr/bin/git commit -m "docs: pallet placard spec — implemented

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Final report lists: behaviour changed, files changed, automated checks with results (and skips), and that printed output on paper / in a browser was not exercised.

---

## Self-review

**Spec coverage.** §2 blocks (header, product, figures with vertical rules, date summary with cap and fold, barcode + one-line HRI, footer per format) → Task 3; §2.1 semantics (effective production day, inclusive expiry, undated last, fold keeps `Итого`) → Tasks 3 (renderer) and 4 (loader expression); §2.2 product coalesce for both loaders → Task 4; §2.3 availability/409/watermark → Tasks 3–5; §3 API contract, DTO, OpenAPI, route inventory → Task 4; §4 button + modal + i18n → Task 5; §5 edge cases (no GTIN, no org, long name clamp, barcode failure fallback via `ssccBarcode`) → Task 3; §6 tests → Tasks 3–5; §8 stock template (builder parameter, names/order, migration, provisioning, tests) → Tasks 1–2. Not covered by an automated test: the warehouse pallet's product via `pallets.product_id` on the placard/report (needs a handheld-style ingest fixture; the expression is the one `getPalletCard` already tests) — stated in Task 6's report.

**Placeholders.** The only literal placeholder is Task 2's `<PASTE THE JSON HERE>`, with the exact JSON given directly above it and a command to regenerate it.

**Type consistency.** `PalletPlacardBox`/`PalletPlacardData`/`PlacardFormat`/`renderPalletPlacardHtml` (Task 3) are what Task 4 imports; `palletPlacardQuerySchema`/`PalletPlacardQueryDto` (Task 4) match the controller; `buildPallet58x40LabelSpec`/`PALLET_LABEL_58X40_TEMPLATE_NAME` (Task 1) are what Task 2's tests import; the admin URL shape `…/placard?format=<a4|a5>&timeZone=` matches the DTO's parameter names.
