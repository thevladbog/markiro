# Chestny ZNAK Product Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the product card's free-text «Группа продукции» with a selection from a seeded reference table of Chestny ZNAK product groups, so a product carries the numeric group code the ЧЗ APIs require.

**Architecture:** A global (non-tenant) table `chz_product_groups` is created and seeded by one migration. `products.product_group text` is replaced by `products.chz_product_group_code integer` referencing it; existing free-text values are discarded. The API resolves the code to a name on read, so `ProductDto.productGroup` keeps its `string | null` shape and the Station's shift bundle — which derives its type from `ProductDto` and validates against a strict OpenAPI schema — needs no change at all.

**Tech Stack:** Drizzle ORM (Postgres), NestJS 11, zod 4, React 19 + `@markiro/ui`, vitest.

## Global Constraints

- Monorepo: pnpm + turbo. API tests: `pnpm --filter @markiro/api exec vitest run test/<file>`. DB: `pnpm --filter @markiro/db ...`. Never use `git stash` (shared stash stack).
- Migration flow (AGENTS.md): `set -a; source .env; set +a` → `db:generate` → `build` → `test` → `db:migrate`. Never edit an applied migration. **Next migration number: 0090** (last applied: `0089_chz_api_tokens_agent_fk`). Rename the generated file AND its `meta/_journal.json` tag to match, with `"idx": 90`, `"version": "7"`, `"breakpoints": true`.
- The dictionary is the **union** of the two documented lists, with True API naming where they disagree: «Справочник "Товарные группы"», `API_СУЗ_3.0.pdf` table 276, pages 472–473; «Справочник "Список поддерживаемых товарных групп"», `True_API_GIS_MT-v721.0` appendix 1, pages 1213–1214.
- `products.status` stays server-computed and its rule is unchanged in shape: `active` iff group, `boxCapacity` and `palletCapacity` are all set — only the group's storage changes.
- **The Station is not touched.** `apps/station/**` and `packages/db/src/sqlite/**` must have zero diff. The shift bundle keeps emitting `productGroup` as a `string | null` name.
- Every new API surface carries OpenAPI decorators — `apps/api/test/openapi-coverage.test.ts` is a hard gate.
- i18n keys go in BOTH `apps/admin/src/i18n/ru.json` and `en.json`; the admin test-mode i18n throws on a missing key.
- Repo TS is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; use conditional spreads rather than assigning `undefined`. Local TS imports carry `.js` extensions.
- Commit footer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## File Structure

| File                                                         | Responsibility                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `packages/db/src/schema/platform.ts`                         | `chzProductGroups` table; `products.chzProductGroupCode` replacing `productGroup` |
| `packages/db/migrations/0090_chz_product_groups.sql`         | Create + seed the dictionary, swap the products column                            |
| `apps/api/src/modules/products/dto.ts`                       | zod input schemas, `ProductDto`, OpenAPI schema                                   |
| `apps/api/src/modules/products/products.service.ts`          | Selection with the dictionary join, `computeStatus`, create/update, `rowToDto`    |
| `apps/api/src/modules/products/products.controller.ts`       | Updated OpenAPI description                                                       |
| `apps/api/src/modules/products/product-groups.controller.ts` | `GET /chz-product-groups`                                                         |
| `apps/api/src/modules/products/product-groups.service.ts`    | Reads the dictionary                                                              |
| `apps/api/src/modules/shifts/dto.ts`                         | `StationBundleProductDto` via `Omit`, keeping the station schema byte-identical   |
| `apps/api/src/modules/shifts/shifts.service.ts`              | Product selection joins the dictionary for the name                               |
| `apps/admin/src/pages/catalog/ProductForm.tsx`               | Text input becomes a `Select`                                                     |
| `apps/admin/src/pages/catalog/api.ts`                        | Types and the dictionary hook                                                     |
| `apps/admin/src/i18n/{ru,en}.json`                           | Label and empty-option copy                                                       |

---

### Task 1: Dictionary table, seed, and the products column swap

**Files:**

- Modify: `packages/db/src/schema/platform.ts`
- Create (generated, then renamed): `packages/db/migrations/0090_chz_product_groups.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Test: `packages/db/test/chz-product-groups.test.ts`
- Modify (test seeds that set the dropped column): `apps/api/test/shifts.e2e.test.ts`, `apps/api/test/shifts-bundle.e2e.test.ts`, `apps/api/test/station-scans.e2e.test.ts`, `apps/api/test/box-exceptions.e2e.test.ts`, `apps/api/test/box-sell-codes.e2e.test.ts`, `apps/api/test/boxes.e2e.test.ts`, `apps/api/test/code-search.e2e.test.ts`, `apps/api/test/conflicts.e2e.test.ts`, `apps/api/test/disaggregation-apply.e2e.test.ts`, `apps/api/test/disaggregation-lines.e2e.test.ts`, `apps/api/test/label-templates.e2e.test.ts`, `apps/api/test/sscc.e2e.test.ts`, `apps/api/test/shifts.service.test.ts`, `apps/api/src/modules/products/test/product-registry-invalidation.test.ts`

**Interfaces:**

- Produces: `chzProductGroups` table with columns `code` (integer PK), `alias` (text, unique), `name` (text); `products.chzProductGroupCode` (integer, nullable, FK → `chzProductGroups.code`); row type `ChzProductGroupRow`. Tasks 2–5 all read these.

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/chz-product-groups.test.ts`. Follow the existing `packages/db/test/*.test.ts` idiom for reading the schema (they import from `../src/schema.js`):

```ts
import { describe, expect, it } from "vitest";

import { chzProductGroups, products } from "../src/schema/platform.js";

describe("chz product groups schema", () => {
  it("exposes the columns the ChZ APIs need", () => {
    const columns = Object.keys(chzProductGroups);
    expect(columns).toEqual(expect.arrayContaining(["code", "alias", "name"]));
  });

  it("replaces the product's free-text group with a dictionary code", () => {
    const columns = Object.keys(products);
    expect(columns).toContain("chzProductGroupCode");
    // The free-text column is gone, not merely deprecated: leaving both would
    // let two sources of truth drift.
    expect(columns).not.toContain("productGroup");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/db exec vitest run test/chz-product-groups.test.ts`
Expected: FAIL — `chzProductGroups` is not exported.

- [ ] **Step 3: Add the table and swap the product column**

In `packages/db/src/schema/platform.ts`, add above `products`:

```ts
/**
 * Chestny ZNAK product groups — global reference data, not tenant-scoped.
 *
 * `code` is what the ЧЗ APIs take as `productGroupCode` (dispenser tasks) and
 * `pg` (most True API methods); `alias` is the latin slug used in СУЗ URLs.
 * Seeded by migration 0090 from the two published dictionaries — see the plan
 * and spec for their exact locations, which is where a future group will be
 * found too.
 */
export const chzProductGroups = pgTable("chz_product_groups", {
  code: integer("code").primaryKey(),
  alias: text("alias").notNull(),
  name: text("name").notNull(),
});
```

and add `unique("chz_product_groups_alias_uq").on(t.alias)` by declaring the table with the config callback form:

```ts
export const chzProductGroups = pgTable(
  "chz_product_groups",
  {
    code: integer("code").primaryKey(),
    alias: text("alias").notNull(),
    name: text("name").notNull(),
  },
  (t) => [unique("chz_product_groups_alias_uq").on(t.alias)],
);
```

In the `products` table, replace the line `productGroup: text("product_group"),` with:

```ts
    chzProductGroupCode: integer("chz_product_group_code").references(() => chzProductGroups.code),
```

Keep the surrounding columns and the existing comment block untouched.

- [ ] **Step 4: Generate the migration and add the seed**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/db db:generate
```

Rename the generated file to `packages/db/migrations/0090_chz_product_groups.sql` and its `meta/_journal.json` tag to `0090_chz_product_groups` (both must match). Then append the seed to the generated SQL, after the `CREATE TABLE` statement and **before** the products column change, separated by `--> statement-breakpoint`:

```sql
INSERT INTO "chz_product_groups" ("code", "alias", "name") VALUES
  (1, 'lp', 'Лёгкая промышленность'),
  (2, 'shoes', 'Обувные товары'),
  (3, 'tobacco', 'Табачная продукция'),
  (4, 'perfumery', 'Духи и туалетная вода'),
  (5, 'tires', 'Шины и покрышки пневматические резиновые новые'),
  (6, 'electronics', 'Фотокамеры (кроме кинокамер), фотовспышки и лампы-вспышки'),
  (7, 'pharma', 'Лекарственные препараты для медицинского применения'),
  (8, 'milk', 'Молочная продукция'),
  (9, 'bicycle', 'Велосипеды и велосипедные рамы'),
  (10, 'wheelchairs', 'Медицинские изделия'),
  (11, 'alcohol', 'Алкоголь'),
  (12, 'otp', 'Альтернативная табачная продукция'),
  (13, 'water', 'Упакованная вода'),
  (14, 'furs', 'Товары из натурального меха'),
  (15, 'beer', 'Пиво, напитки, изготавливаемые на основе пива, слабоалкогольные напитки'),
  (16, 'ncp', 'Никотиносодержащая продукция'),
  (17, 'bio', 'Специализированная пищевая продукция и БАД к пище'),
  (19, 'antiseptic', 'Антисептики и дезинфицирующие средства'),
  (20, 'petfood', 'Корма для животных'),
  (21, 'seafood', 'Морепродукты'),
  (22, 'nabeer', 'Безалкогольное пиво'),
  (23, 'softdrinks', 'Соковая продукция и безалкогольные напитки'),
  (25, 'meat', 'Мясные изделия'),
  (26, 'vetpharma', 'Ветеринарные препараты'),
  (27, 'toys', 'Игры и игрушки для детей'),
  (28, 'radio', 'Радиоэлектронная продукция'),
  (31, 'titan', 'Титановая металлопродукция'),
  (32, 'conserve', 'Консервированная продукция'),
  (33, 'vegetableoil', 'Растительные масла'),
  (34, 'opticfiber', 'Оптоволокно и оптоволоконная продукция'),
  (35, 'chemistry', 'Косметика, бытовая химия и товары личной гигиены'),
  (36, 'books', 'Печатная продукция'),
  (37, 'grocery', 'Бакалейная продукция'),
  (38, 'pharmaraw', 'Фармацевтическое сырьё, лекарственные средства'),
  (39, 'construction', 'Строительные материалы'),
  (40, 'fire', 'Пожарная безопасность'),
  (41, 'heater', 'Отопительные приборы'),
  (42, 'cableraw', 'Кабельно-проводниковая продукция'),
  (43, 'autofluids', 'Моторные масла'),
  (44, 'polymer', 'Полимерные трубы'),
  (45, 'sweets', 'Сладости и кондитерские изделия'),
  (48, 'carparts', 'Автозапчасти и комплектующие транспортных средств'),
  (49, 'furslp', 'Натуральный мех'),
  (50, 'nicotindev', 'Радиоэлектронная продукция. Электронные системы доставки никотина'),
  (51, 'gadgets', 'Радиоэлектронная продукция. Ноутбуки и смартфоны'),
  (52, 'frozen', 'Полуфабрикаты и замороженные продукты'),
  (53, 'fertilizers', 'Удобрения в потребительской упаковке'),
  (54, 'homeware', 'Товары для дома и интерьера'),
  (55, 'vetbio', 'Кормовые добавки'),
  (57, 'industrial', 'Промышленное оборудование'),
  (59, 'pyrotechnics', 'Пиротехнические изделия')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
```

Verify the generated DDL drops `product_group` and adds `chz_product_group_code` with its foreign key. Every product that had a free-text group therefore loses it and will be recomputed to `draft` by the next update — this is the intended, irreversible behaviour recorded in the spec.

- [ ] **Step 5: Apply and verify**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/db test
pnpm --filter @markiro/db db:migrate
```

Expected: build and tests pass (including the two new schema assertions), migration applies cleanly.

Then confirm the seed landed:

```bash
psql "$DATABASE_URL" -c "select count(*) from chz_product_groups"
```

Expected: `51`.

- [ ] **Step 6: Fix the direct-DB test seeds**

Every test listed under **Files** seeds a product straight through Drizzle with `productGroup: "..."`. Replace each with a dictionary code. The canonical shape becomes:

```ts
const productId = await seedProduct(orgId, {
  status: "active",
  chzProductGroupCode: 8,
  boxCapacity: 10,
  palletCapacity: 5,
});
```

Use `8` (`milk`) as the default replacement everywhere a value was arbitrary; where a test's string carried meaning (`"beer"` in `apps/admin/test/inventory-preparation.test.tsx` is admin-side and belongs to Task 5) keep the meaning by picking the matching code — `15` for beer, `23` for soft drinks. Update the comment at `apps/api/test/station-scans.e2e.test.ts:90` so it names the new column.

- [ ] **Step 7: Run the db and API suites**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/db test
pnpm --filter @markiro/api test
```

Expected: db green. The API suite still fails in the products/shifts/HTTP-level tests — those belong to Tasks 2 and 4. Record the failing file list in the report so the next task can confirm it shrinks.

- [ ] **Step 8: Commit**

```bash
git add packages/db apps/api/test apps/api/src/modules/products/test
git commit -m "feat(db): seeded Chestny ZNAK product groups dictionary"
```

---

### Task 2: Products API reads and writes the code

**Files:**

- Modify: `apps/api/src/modules/products/dto.ts`
- Modify: `apps/api/src/modules/products/products.service.ts`
- Modify: `apps/api/src/modules/products/products.controller.ts:138`
- Test: `apps/api/test/products.e2e.test.ts`

**Interfaces:**

- Consumes: `chzProductGroups`, `products.chzProductGroupCode` (Task 1).
- Produces: `ProductDto` gains `chzProductGroupCode: number | null` and keeps `productGroup: string | null` — now the **resolved dictionary name**; `createProductSchema`/`updateProductSchema` accept `chzProductGroupCode: number | null` and no longer accept `productGroup`. Tasks 3–5 depend on these names.

- [ ] **Step 1: Write the failing test**

In `apps/api/test/products.e2e.test.ts`, replace the status-rule test (currently around lines 278–305) with one that exercises the code, and add an unknown-code case:

```ts
it("activates a product once the group code and both capacities are set", async () => {
  const createRes = await agent
    .post("/products")
    .send({ gtin: EAN13_CANONICAL, name: "Flip Widget" })
    .expect(201);
  const id = createRes.body.id as string;
  expect(createRes.body.status).toEqual("draft");
  expect(createRes.body.chzProductGroupCode).toBeNull();
  expect(createRes.body.productGroup).toBeNull();

  const activateRes = await agent
    .patch(`/products/${id}`)
    .send({ chzProductGroupCode: 8, boxCapacity: 12, palletCapacity: 48 })
    .expect(200);
  expect(activateRes.body).toMatchObject({
    status: "active",
    chzProductGroupCode: 8,
    // The resolved name travels beside the code so the catalogue list needs
    // no second request.
    productGroup: "Молочная продукция",
    boxCapacity: 12,
    palletCapacity: 48,
  });

  const downgradeRes = await agent
    .patch(`/products/${id}`)
    .send({ palletCapacity: null })
    .expect(200);
  expect(downgradeRes.body).toMatchObject({
    status: "draft",
    chzProductGroupCode: 8,
    palletCapacity: null,
  });
});

it("rejects a group code that is not in the dictionary", async () => {
  const created = await agent
    .post("/products")
    .send({ gtin: EAN13_CANONICAL, name: "Unknown group" })
    .expect(201);
  await agent
    .patch(`/products/${created.body.id as string}`)
    .send({ chzProductGroupCode: 9999 })
    .expect(400);
});
```

Also update the other `productGroup:` occurrences in this file (lines around 224, 287, 291, 302, 404, 440) to send `chzProductGroupCode` instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/products.e2e.test.ts`
Expected: FAIL — the API still rejects `chzProductGroupCode` as an unknown key and does not return it.

- [ ] **Step 3: Update the DTOs**

In `apps/api/src/modules/products/dto.ts`:

- In `createProductSchema` and `updateProductSchema`, replace the line
  `productGroup: z.string().min(1).max(200).nullable().optional(),` with
  `chzProductGroupCode: z.number().int().positive().nullable().optional(),`.
- In `ProductDto`, keep `productGroup: string | null` but document it, and add the code:

```ts
/** Resolved name of `chzProductGroupCode`; null when no group is selected. */
productGroup: string | null;
/** Chestny ZNAK product group code — what the ЧЗ APIs take as `productGroupCode`/`pg`. */
chzProductGroupCode: number | null;
```

- In `productOpenApiSchema`, add `"chzProductGroupCode"` to `required` right after `"productGroup"`, and add the property:

```ts
    chzProductGroupCode: { type: "integer", nullable: true },
```

- Update the create-schema docstring at the top of the file so it names `chzProductGroupCode` instead of `productGroup`.

- [ ] **Step 4: Update the service**

In `apps/api/src/modules/products/products.service.ts`:

- In `CURRENT_PRODUCT_SELECTION`, replace `productGroup: schema.products.productGroup,` with
  `chzProductGroupCode: schema.products.chzProductGroupCode,`.
- In `PRODUCT_WITH_IMAGE_SELECTION`, add the resolved name:

```ts
const PRODUCT_WITH_IMAGE_SELECTION = {
  ...CURRENT_PRODUCT_SELECTION,
  productGroupName: schema.chzProductGroups.name,
  imageChecksum: schema.mediaAssets.checksum,
  imageByteSize: schema.mediaAssets.byteSize,
  imageWidth: schema.mediaAssets.width,
  imageHeight: schema.mediaAssets.height,
};
```

and widen `ProductWithImageRow` with `productGroupName: string | null`.

- In `productRows()`, add the dictionary join after the existing ones:

```ts
      .leftJoin(
        schema.chzProductGroups,
        eq(schema.chzProductGroups.code, schema.products.chzProductGroupCode),
      )
```

- Replace `computeStatus` with the code-based rule, keeping the shape of the rule intact:

```ts
  /** active iff boxCapacity AND palletCapacity AND the ChZ group code are all set; else draft. */
  private computeStatus(fields: {
    chzProductGroupCode: number | null;
    boxCapacity: number | null;
    palletCapacity: number | null;
  }): ProductStatus {
    return fields.chzProductGroupCode !== null &&
      fields.boxCapacity !== null &&
      fields.palletCapacity !== null
      ? "active"
      : "draft";
  }
```

- In `createProduct`, replace `const productGroup = data.productGroup ?? null;` with
  `const chzProductGroupCode = data.chzProductGroupCode ?? null;`, pass it to `computeStatus`, and write `chzProductGroupCode` in the insert values instead of `productGroup`.
- In `updateProduct`, replace the merge line with
  `const chzProductGroupCode = data.chzProductGroupCode !== undefined ? data.chzProductGroupCode : current.chzProductGroupCode;`, pass it to `computeStatus`, and put it in the `set` object.
- In `rowToDto`, emit both fields:

```ts
      productGroup: row.productGroupName,
      chzProductGroupCode: row.chzProductGroupCode,
```

- In `handleWriteError`, the 23503 branch currently assumes a counterparty. Make it name the actual constraint, so an unknown group code is not reported as an unknown counterparty:

```ts
if (errorCode === "23503") {
  const constraint = String(
    (err as { constraint?: string }).constraint ??
      (cause as { constraint?: string } | undefined)?.constraint ??
      "",
  );
  if (constraint.includes("chz_product_group")) {
    throw new BadRequestException("Unknown Chestny ZNAK product group code");
  }
  throw new BadRequestException("Unknown counterparty for this organization");
}
```

- [ ] **Step 5: Update the controller description**

In `apps/api/src/modules/products/products.controller.ts`, change the `POST /products` description text to:

```ts
      "`status` is server-computed: active when chzProductGroupCode, boxCapacity, and palletCapacity are all set, draft otherwise.",
```

- [ ] **Step 6: Run the tests**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/products.e2e.test.ts test/openapi-coverage.test.ts
```

Expected: PASS. Then `pnpm --filter @markiro/api exec tsc -p tsconfig.json --noEmit` — clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/products apps/api/test/products.e2e.test.ts
git commit -m "feat(api): products carry a Chestny ZNAK product group code"
```

---

### Task 3: The dictionary endpoint

**Files:**

- Create: `apps/api/src/modules/products/product-groups.service.ts`
- Create: `apps/api/src/modules/products/product-groups.controller.ts`
- Modify: `apps/api/src/modules/products/products.module.ts`
- Test: `apps/api/test/chz-product-groups.e2e.test.ts`

**Interfaces:**

- Consumes: `chzProductGroups` (Task 1).
- Produces: `GET /chz-product-groups` returning `{ items: { code: number; alias: string; name: string }[] }` sorted by name; `ChzProductGroupDto`. Task 5's select consumes it.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/chz-product-groups.e2e.test.ts`, using the bootstrap from `apps/api/test/products.e2e.test.ts` (same `ready` gate, `setupAuth`, `mountAuth`, `listenOnLoopback`, `signUpAndActivate`):

```ts
it("returns the seeded dictionary sorted by name", async () => {
  const res = await agent.get("/chz-product-groups").expect(200);
  const items = res.body.items as { code: number; alias: string; name: string }[];
  expect(items.length).toBeGreaterThanOrEqual(51);

  // Anchors, not all fifty-one rows: enough that a future edit cannot silently
  // renumber or drop a code the exports slice depends on.
  const byCode = new Map(items.map((item) => [item.code, item]));
  expect(byCode.get(8)?.alias).toBe("milk");
  expect(byCode.get(8)?.name).toBe("Молочная продукция");
  expect(byCode.get(13)?.alias).toBe("water");
  expect(byCode.get(15)?.alias).toBe("beer");

  const names = items.map((item) => item.name);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "ru")));
});

it("requires a cabinet session", async () => {
  await request(app!.getHttpServer()).get("/chz-product-groups").expect(401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-product-groups.e2e.test.ts`
Expected: FAIL with 404 — the route does not exist.

- [ ] **Step 3: Implement the service**

`apps/api/src/modules/products/product-groups.service.ts`:

```ts
import { Inject, Injectable } from "@nestjs/common";
import { asc } from "drizzle-orm";

import { schema } from "@markiro/db";

import { DB, type Db } from "../../auth/auth.module";

export interface ChzProductGroupDto {
  code: number;
  alias: string;
  name: string;
}

export interface ListChzProductGroupsResponseDto {
  items: ChzProductGroupDto[];
}

@Injectable()
export class ProductGroupsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Global reference data: the same rows for every tenant, so there is no
   * tenant predicate here by design.
   */
  async list(): Promise<ListChzProductGroupsResponseDto> {
    const items = await this.db
      .select({
        code: schema.chzProductGroups.code,
        alias: schema.chzProductGroups.alias,
        name: schema.chzProductGroups.name,
      })
      .from(schema.chzProductGroups)
      .orderBy(asc(schema.chzProductGroups.name));
    return { items };
  }
}
```

Match the exact `schema` / `DB` / `Db` import style used by `apps/api/src/modules/products/products.service.ts` — copy its import lines rather than the ones above if they differ.

- [ ] **Step 4: Implement the controller**

`apps/api/src/modules/products/product-groups.controller.ts` — decorators copied from `ProductsController`'s class-level set:

```ts
import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { SchemaObject } from "@nestjs/swagger";

import { ApiCabinetAuth, ApiHttpErrors } from "../../lib/openapi";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access.decorators";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard } from "../../tenancy/tenant.guard";
import {
  ProductGroupsService,
  type ListChzProductGroupsResponseDto,
} from "./product-groups.service";

const chzProductGroupsOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "alias", "name"],
        properties: {
          code: { type: "integer" },
          alias: { type: "string" },
          name: { type: "string" },
        },
      },
    },
  },
};

@ApiTags("products")
@Controller("chz-product-groups")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class ProductGroupsController {
  constructor(private readonly groups: ProductGroupsService) {}

  @Get()
  @ApiOperation({ summary: "List Chestny ZNAK product groups" })
  @ApiOkResponse({ schema: chzProductGroupsOpenApiSchema })
  @ApiHttpErrors(401, 403)
  @ApiCabinetAuth()
  list(): Promise<ListChzProductGroupsResponseDto> {
    return this.groups.list();
  }
}
```

Adjust import paths and the `AllowSubscriptionReadOnly`/`ApiHttpErrors` spellings to match what `products.controller.ts` actually imports. The route is deliberately read-only and carries no capability requirement beyond a valid cabinet session, since the dictionary is public reference data within the product.

Register both in `apps/api/src/modules/products/products.module.ts`: add `ProductGroupsController` to `controllers` and `ProductGroupsService` to `providers`.

- [ ] **Step 5: Run the tests**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/chz-product-groups.e2e.test.ts test/openapi-coverage.test.ts
```

Expected: PASS. Fix any coverage-gate complaint by completing the OpenAPI decorators.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/products apps/api/test/chz-product-groups.e2e.test.ts
git commit -m "feat(api): expose the Chestny ZNAK product group dictionary"
```

---

### Task 4: The shift bundle keeps its string, and the Station stays untouched

**Files:**

- Modify: `apps/api/src/modules/shifts/shifts.service.ts`
- Modify: `apps/api/src/modules/shifts/dto.ts`
- Test: `apps/api/test/shifts-bundle.e2e.test.ts`

**Interfaces:**

- Consumes: `chzProductGroups`, `products.chzProductGroupCode` (Task 1), `ProductDto` (Task 2).
- Produces: `StationBundleProductDto` with `productGroup: string | null` and **no** `chzProductGroupCode`, so `apps/station/**` and `packages/db/src/sqlite/**` keep a zero diff.

- [ ] **Step 1: Write the failing test**

In `apps/api/test/shifts-bundle.e2e.test.ts`, add:

```ts
it("sends the product group as its resolved name and never leaks the code", async () => {
  // Seeded with code 15 (beer) — the bundle must carry the human name the
  // Station has always stored in its `product_group TEXT` mirror column.
  const bundle = await agent.get(`/shifts/${shiftId}/bundle`).expect(200);
  expect(bundle.body.product.productGroup).toBe(
    "Пиво, напитки, изготавливаемые на основе пива, слабоалкогольные напитки",
  );
  expect(bundle.body.product).not.toHaveProperty("chzProductGroupCode");
});
```

Seed that shift's product with `chzProductGroupCode: 15` (adapt the file's existing product seed helper).

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/shifts-bundle.e2e.test.ts`
Expected: FAIL — the bundle no longer has a `productGroup` value because the service still selects the dropped column.

- [ ] **Step 3: Join the dictionary in the shifts service**

In `apps/api/src/modules/shifts/shifts.service.ts`, in that file's own `CURRENT_PRODUCT_SELECTION`, replace `productGroup: schema.products.productGroup,` with:

```ts
  chzProductGroupCode: schema.products.chzProductGroupCode,
  productGroupName: schema.chzProductGroups.name,
```

and add the join to `findProductRow` — note this query has no joins today, so the `.from(...)` needs one appended:

```ts
const [row] = await this.db
  .select(CURRENT_PRODUCT_SELECTION)
  .from(schema.products)
  .leftJoin(
    schema.chzProductGroups,
    eq(schema.chzProductGroups.code, schema.products.chzProductGroupCode),
  )
  .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));
```

In `getReferenceBundle`, map the name into the field the Station expects:

```ts
      productGroup: productRow.productGroupName,
```

- [ ] **Step 4: Keep the bundle type free of the code**

In `apps/api/src/modules/shifts/dto.ts`, change the bundle product type so the new field cannot leak into a schema declared with `additionalProperties: false`:

```ts
/**
 * Legacy fields retained only on station bundles during a rolling deployment.
 *
 * `chzProductGroupCode` is deliberately omitted: the Station stores the group
 * as text in its SQLite mirror and has no use for the code, and
 * `stationBundleProductOpenApiSchema` is `additionalProperties: false`, so
 * adding it here would break bundle validation for no gain.
 */
export type StationBundleProductDto = Omit<ProductDto, "chzProductGroupCode"> & {
  defaultLabelTemplateId: null;
};
```

Leave `stationBundleProductOpenApiSchema` exactly as it is — `productGroup` stays `{ type: "string", nullable: true }`.

- [ ] **Step 5: Run the tests and prove the Station is untouched**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/shifts-bundle.e2e.test.ts test/shifts.e2e.test.ts
pnpm --filter @markiro/station test
git status --short apps/station packages/db/src/sqlite
```

Expected: API suites pass; the station suite passes untouched; `git status` prints nothing for those two paths.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shifts apps/api/test/shifts-bundle.e2e.test.ts apps/api/test/shifts.e2e.test.ts
git commit -m "feat(api): resolve the product group name for the station bundle"
```

---

### Task 5: The product form becomes a select

**Files:**

- Modify: `apps/admin/src/pages/catalog/api.ts`
- Modify: `apps/admin/src/pages/catalog/ProductForm.tsx`
- Modify: `apps/admin/src/pages/catalog/ProductPanelRoute.tsx`
- Modify: `apps/admin/src/pages/catalog/index.tsx:312-316`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/catalog.test.tsx`, and the fixtures in `apps/admin/test/shifts.test.tsx`, `catalog-routing.test.tsx`, `integrations-candidates.test.tsx`, `inventory-preparation.test.tsx`, `kiosk-products.test.tsx`, `kiosks-routing.test.tsx`, `shifts-routing.test.tsx`

**Interfaces:**

- Consumes: `GET /chz-product-groups` (Task 3); `ProductDto.chzProductGroupCode` and the resolved `productGroup` name (Task 2).
- Produces: `useChzProductGroups()` hook and `CHZ_PRODUCT_GROUPS_QUERY_KEY`.

- [ ] **Step 1: Write the failing test**

In `apps/admin/test/catalog.test.tsx`, add to the form suite. `Select` is a Radix
listbox, not a native `<select>` — open the combobox and click the option, exactly as
the pagination test at `apps/admin/test/catalog.test.tsx:349-352` already does and
documents:

```ts
it("submits the selected group code rather than free text", async () => {
  const user = userEvent.setup();
  renderPage();

  await user.click((await screen.findAllByRole("button", { name: "Добавить товар" }))[0]!);
  await user.click(screen.getByRole("combobox", { name: "Группа продукции" }));
  await user.click(await screen.findByRole("option", { name: "Молочная продукция" }));
  await user.click(screen.getByRole("button", { name: "Сохранить" }));

  await waitFor(() => {
    expect(lastCreateBody?.chzProductGroupCode).toBe(8);
  });
  expect("productGroup" in (lastCreateBody ?? {})).toBe(false);
});
```

Wire `lastCreateBody` by capturing the `POST /products` request body in the file's
existing `vi.stubGlobal("fetch", ...)` mock, and add a `/chz-product-groups` branch to it
returning `{ items: [{ code: 8, alias: "milk", name: "Молочная продукция" }] }`. Match the
button and field names to whatever the file's other tests already use; adjust for English
where the test switches locale. Update `ACTIVE_PRODUCT`/`DRAFT_PRODUCT` and the other
listed fixtures to carry `chzProductGroupCode` alongside the now-resolved `productGroup`
name.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/admin exec vitest run test/catalog.test.tsx`
Expected: FAIL — the field is still a text input and the payload still carries `productGroup`.

- [ ] **Step 3: Add the types and hook**

In `apps/admin/src/pages/catalog/api.ts`:

```ts
/** Mirrors `apps/api/src/modules/products/product-groups.service.ts`. */
export interface ChzProductGroupDto {
  code: number;
  alias: string;
  name: string;
}

export const CHZ_PRODUCT_GROUPS_QUERY_KEY = ["chz-product-groups"] as const;

async function fetchChzProductGroups(): Promise<ChzProductGroupDto[]> {
  const value = await apiFetch<{ items: ChzProductGroupDto[] }>("/chz-product-groups");
  return value.items;
}

/** `GET /chz-product-groups` — global reference data, safe to cache for the session. */
export function useChzProductGroups(): UseQueryResult<ChzProductGroupDto[]> {
  return useQuery({
    queryKey: CHZ_PRODUCT_GROUPS_QUERY_KEY,
    queryFn: fetchChzProductGroups,
    staleTime: Infinity,
  });
}
```

In `ProductDto`, replace `productGroup: string | null;` with:

```ts
/** Resolved name of `chzProductGroupCode`; null when no group is selected. */
productGroup: string | null;
chzProductGroupCode: number | null;
```

In `CreateProductInput`, replace `productGroup?: string | null;` with `chzProductGroupCode?: number | null;`, and update the docstring above it so it names the new field.

- [ ] **Step 4: Turn the field into a select**

In `apps/admin/src/pages/catalog/ProductForm.tsx`:

- In `productFormSchema`, replace the `productGroup` entry with
  `chzProductGroupCode: z.string().trim().optional(),` — the form holds the code as a string, exactly as it already does for `boxCapacity`, and converts on submit.
- In `EMPTY_VALUES`, replace `productGroup: ""` with `chzProductGroupCode: ""`.
- Add the data source and options next to the existing `counterpartyOptions`:

```ts
const { data: productGroups = [] } = useChzProductGroups();
const chzProductGroupCode = watch("chzProductGroupCode");
const productGroupOptions: SelectOption[] = [
  { value: "", label: t("pages.catalog.form.noProductGroup") },
  ...productGroups.map((group) => ({ value: String(group.code), label: group.name })),
];
```

- Replace the `Input` for the group with a `Select`, following the `defaultCounterpartyId` control already in this file. `searchable` is on because the dictionary has fifty-one entries:

```tsx
<Select
  label={t("pages.catalog.form.productGroupLabel")}
  options={productGroupOptions}
  value={chzProductGroupCode ?? ""}
  searchable
  searchLabel={t("pages.catalog.form.productGroupSearchLabel")}
  onValueChange={(value) =>
    setValue("chzProductGroupCode", value, { shouldDirty: true, shouldValidate: true })
  }
/>
```

- In `toCreateInput`, replace the `productGroup` lines with:

```ts
  const chzProductGroupCode = values.chzProductGroupCode?.trim();
  // ...
    chzProductGroupCode: chzProductGroupCode ? Number(chzProductGroupCode) : null,
```

In `apps/admin/src/pages/catalog/ProductPanelRoute.tsx`, change both `initialValues` mappings and the `useMemo` dependency to
`chzProductGroupCode: String(product.chzProductGroupCode ?? "")` (and the same for `createdProduct`).

In `apps/admin/src/pages/catalog/index.tsx`, the column keeps rendering `row.productGroup ?? "—"` — it is now the resolved name, so no change is needed there beyond confirming it still compiles.

- [ ] **Step 5: Update i18n**

In `apps/admin/src/i18n/ru.json`: delete `pages.catalog.form.errors.productGroupTooLong` and add to `pages.catalog.form`:

```json
        "noProductGroup": "Не выбрана",
        "productGroupSearchLabel": "Поиск группы",
```

In `apps/admin/src/i18n/en.json`: delete the same error key and add:

```json
        "noProductGroup": "Not selected",
        "productGroupSearchLabel": "Search groups",
```

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/admin
git commit -m "feat(admin): pick the product group from the Chestny ZNAK dictionary"
```

---

### Task 6: Full verification pass

- [ ] **Step 1: Run everything**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/db test
pnpm --filter @markiro/api test
pnpm --filter @markiro/admin test
pnpm --filter @markiro/station test
pnpm format:check
pnpm turbo lint typecheck build --concurrency=1 --force
```

Expected: all green. Paste the counts into the report.

- [ ] **Step 2: Prove the Station diff is empty**

```bash
git diff --stat origin/main -- apps/station packages/db/src/sqlite
```

Expected: no output. If anything appears, it is a defect against this plan's constraint — report it rather than accepting it.

- [ ] **Step 3: Commit any stragglers**

```bash
git add -A && git commit -m "chore(product-groups): verification fixes" || echo "nothing to commit"
```

---

## Out of scope

- Migrating old free-text values by fuzzy matching — the decision is to wipe them.
- Editing the dictionary from the UI.
- Per-tenant subsets of groups.
- Consuming the code for exports — that is the `2026-08-29-chz-inventory-exports-design.md` slice.
