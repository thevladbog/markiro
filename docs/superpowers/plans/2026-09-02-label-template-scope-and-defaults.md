# Label Template Scope, Enablement and Category Defaults — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Шаблоны этикеток коробки получают область применения по товарным группам ЧЗ и флаг «включён»; появляются дефолты на категорию; все точки выбора шаблона в админке и на станции показывают только пригодные шаблоны.

**Architecture:** Две колонки на `label_templates` (`enabled`, `chz_product_group_codes`) и таблица `org_box_label_template_defaults`. Чистые правила пригодности и разрешения дефолта живут в `@markiro/domain`; один серверный модуль `box-label-template-eligibility.ts` оборачивает их в запросы к БД и переиспользуется модулями label-templates, org-profile, shifts и inventories. Админка фильтрует на клиенте по полям сводки, станция получает уже отфильтрованный список по `productId`.

**Tech Stack:** TypeScript strict, drizzle-orm + Postgres, NestJS + zod, React + TanStack Query + react-hook-form, vitest, `@markiro/ui`.

**Spec:** `docs/superpowers/specs/2026-09-02-label-template-scope-and-defaults-design.md`

## Global Constraints

- Ветка: `claude/label-template-scope-and-defaults` (уже создана, спека закоммичена).
- TypeScript strict с `noUncheckedIndexedAccess` и `exactOptionalPropertyTypes`: без `any`, без `!` кроме уже принятых `req.tenantId!`, без широких кастов.
- `import type` для импортов только типов. Prettier и ESLint корневые, без локальных исключений.
- Каждый серверный запрос tenant-scoped; составные FK `(tenant_id, id)` сохраняются.
- Миграция только новая (`0111_label_template_scope_and_defaults`), уже применённые не переписываются. После изменения `packages/db` обязательно `pnpm --filter @markiro/db build` до тестов API.
- После изменения `packages/domain` обязательно `pnpm --filter @markiro/domain build` до тестов API, admin, station.
- Тесты API с БД требуют окружения: `set -a; source .env; set +a` перед `pnpm --filter @markiro/api exec vitest run …`. Без `DATABASE_URL` они молча пропускаются, это не зелёный результат.
- i18n админки: каждый новый ключ добавляется и в `apps/admin/src/i18n/ru.json`, и в `apps/admin/src/i18n/en.json` (тест `apps/admin/test/i18n.test.tsx` проверяет паритет). Тесты админки сравнивают русские строки.
- Стоковые шаблоны, их спеки, миграции 0049–0066 и дрейф-тест `packages/domain/test/labels-defaults.test.ts` не трогаются.
- Спек шаблона (`LabelTemplateSpec`) не меняется. Бандл смены и SQLite-зеркало станции не меняются.
- Коммиты по одной задаче, `git add` явными путями. Сообщение коммита заканчивается строкой `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Точные строки файлов ниже даны на момент написания плана; перед правкой сверяйтесь с текущим содержимым.

---

## File Structure

**packages/db**

- Modify `packages/db/src/schema/labels.ts`: колонки `enabled`, `chzProductGroupCodes`, CHECK.
- Modify `packages/db/src/schema/org-profile.ts`: таблица `orgBoxLabelTemplateDefaults`.
- Create `packages/db/migrations/0111_label_template_scope_and_defaults.sql` (+ `meta/0111_snapshot.json`, запись в `meta/_journal.json`) через `db:generate` и переименование.
- Create `packages/db/test/label-template-scope.test.ts`: metadata-тест схемы.

**packages/domain**

- Create `packages/domain/src/product-attributes/egais.ts`: `EGAIS_PRODUCT_GROUP_CODE`, `isEgaisApplicable`.
- Create `packages/domain/src/labels/eligibility.ts`: `isBoxLabelTemplateEligible`, `resolveBoxLabelTemplateDefault`, `labelTemplateUsesField`.
- Modify `packages/domain/src/product-attributes/index.ts`, `packages/domain/src/index.ts`: экспорты.
- Create `packages/domain/test/labels-eligibility.test.ts`, `packages/domain/test/product-attributes-egais.test.ts`.

**apps/api**

- Create `apps/api/src/modules/label-templates/box-label-template-eligibility.ts`: DB-обёртки над доменом, общие для четырёх модулей.
- Modify `apps/api/src/modules/label-templates/{dto,label-templates.controller,label-templates.service}.ts`.
- Modify `apps/api/src/modules/org-profile/{dto,org-profile.service}.ts`.
- Modify `apps/api/src/modules/shifts/{dto,shifts.controller,shifts.service}.ts`.
- Modify `apps/api/src/modules/inventories/inventories.service.ts` (+ перечисления кодов ошибок в `dto.ts`, если есть).
- Modify `apps/api/src/modules/product-regulatory/readiness.service.ts`.
- Tests: `apps/api/test/{label-templates,org-profile,shifts,inventories}.e2e.test.ts`, `apps/api/test/readiness.service.test.ts`.

**apps/admin**

- Modify `apps/admin/src/pages/labels/api.ts`: новые поля DTO, параметр `enabled`.
- Create `apps/admin/src/pages/labels/scope.ts`: подписи области и текст конфликта дефолта.
- Modify `apps/admin/src/pages/labels/index.tsx`: фильтр, бейджи, переключатель.
- Modify `apps/admin/src/pages/labels/editor/{index.tsx,editor.css}`: флаг, область, подсказка ЕГАИС.
- Modify `apps/admin/src/pages/catalog/api.ts`: `useChzProductGroups({ enabled })`.
- Modify `apps/admin/src/pages/settings/{api.ts,OrgProfilePage.tsx}`: дефолты категорий.
- Modify `apps/admin/src/pages/shifts/{api.ts,ShiftForm.tsx,ShiftPanelRoute.tsx,index.tsx}`.
- Modify `apps/admin/src/pages/inventory/InventoryParametersForm.tsx`.
- Modify `apps/admin/src/i18n/{ru,en}.json`.
- Tests: `apps/admin/test/{labels-library,labels-editor,org-profile,shifts,inventory-preparation}.test.tsx`.

**apps/station**

- Modify `apps/station/src/pages/NewShift.tsx`, `apps/station/test/new-shift.test.tsx`.

**docs**

- Modify `docs/working-map.md` (раздел «Labels and printing»).

---

### Task 1: Схема БД и миграция

**Files:**

- Modify: `packages/db/src/schema/labels.ts`
- Modify: `packages/db/src/schema/org-profile.ts`
- Create: `packages/db/migrations/0111_label_template_scope_and_defaults.sql` (через генератор)
- Modify: `packages/db/migrations/meta/_journal.json` (tag записи idx 111)
- Test: `packages/db/test/label-template-scope.test.ts`

**Interfaces:**

- Produces: `schema.labelTemplates.enabled: boolean NOT NULL DEFAULT true`, `schema.labelTemplates.chzProductGroupCodes: number[] | null`; таблица `schema.orgBoxLabelTemplateDefaults { tenantId, chzProductGroupCode, templateId, updatedAt }` с PK `(tenant_id, chz_product_group_code)` и FK `org_box_label_template_defaults_template_tenant_fk` на `(label_templates.tenant_id, label_templates.id)`.

- [ ] **Step 1: Убедиться, что `platform.ts` не импортирует `org-profile.ts`** (иначе будет цикл после шага 4)

Run: `grep -n "org-profile" packages/db/src/schema/platform.ts`
Expected: пустой вывод.

- [ ] **Step 2: Написать падающий metadata-тест**

Создать `packages/db/test/label-template-scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { labelTemplates } from "../src/schema/labels.js";
import { orgBoxLabelTemplateDefaults } from "../src/schema/org-profile.js";

describe("label template scope schema", () => {
  it("adds an enabled flag and a nullable product-group scope with a non-empty check", () => {
    expect(labelTemplates.enabled.notNull).toBe(true);
    expect(labelTemplates.enabled.hasDefault).toBe(true);
    expect(labelTemplates.enabled.default).toBe(true);
    expect(labelTemplates.chzProductGroupCodes.notNull).toBe(false);
    const config = getTableConfig(labelTemplates);
    expect(config.checks.map((check) => check.name)).toContain(
      "label_templates_product_group_codes_nonempty",
    );
  });

  it("keys category defaults by tenant and product group with a same-tenant template FK", () => {
    const config = getTableConfig(orgBoxLabelTemplateDefaults);
    expect(config.name).toBe("org_box_label_template_defaults");
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "chz_product_group_code",
    ]);
    expect(config.foreignKeys.map((fk) => fk.getName())).toContain(
      "org_box_label_template_defaults_template_tenant_fk",
    );
    expect(orgBoxLabelTemplateDefaults.templateId.notNull).toBe(true);
  });
});
```

- [ ] **Step 3: Запустить тест, убедиться, что он падает**

Run: `pnpm --filter @markiro/db exec vitest run test/label-template-scope.test.ts`
Expected: FAIL (`orgBoxLabelTemplateDefaults` не экспортируется / `enabled` undefined).

- [ ] **Step 4: Изменить `packages/db/src/schema/labels.ts`**

Заменить содержимое файла на:

```ts
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

/**
 * Tenant-scoped label templates. `spec` is a `LabelTemplateSpec` (see
 * @markiro/domain's `parseLabelTemplate`) stored as-is in jsonb -- the API
 * layer validates it against the domain model before every write, so this
 * table trusts its own contents but never re-derives them.
 *
 * `enabled` and `chz_product_group_codes` are selection metadata, not part of
 * the print model: they decide which pickers offer the template, never how it
 * prints. A shift or inventory keeps its snapshot even if the template is
 * later disabled or scoped away.
 */
export const labelTemplates = pgTable(
  "label_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    spec: jsonb("spec").notNull(),
    /**
     * Admin-controlled visibility. A disabled template is hidden from every
     * template picker in the admin and on the station. It can never be a
     * default: the API refuses to disable a template that the organisation
     * or a category default points at.
     */
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Chestny ZNAK product-group codes this template applies to. NULL means
     * every category; a non-empty array restricts the template to products
     * carrying one of these codes. Codes are validated against
     * `chz_product_groups` by the API on every write (arrays cannot carry an
     * FK); the CHECK below forbids the ambiguous empty array.
     */
    chzProductGroupCodes: integer("chz_product_group_codes").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // (tenant_id, id) UNIQUE lets other tenants' tables (products, shifts --
  // see Task 7) target a same-tenant row via a composite FK.
  (t) => [
    unique("label_templates_tenant_id_uq").on(t.tenantId, t.id),
    check(
      "label_templates_product_group_codes_nonempty",
      sql`${t.chzProductGroupCodes} IS NULL OR cardinality(${t.chzProductGroupCodes}) > 0`,
    ),
  ],
);
```

- [ ] **Step 5: Добавить таблицу дефолтов в `packages/db/src/schema/org-profile.ts`**

Заменить строку импорта drizzle и добавить импорт справочника:

```ts
import {
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { labelTemplates } from "./labels.js";
import { organizationLogoAssets } from "./media.js";
import { chzProductGroups } from "./platform.js";
```

В конец файла добавить:

```ts
/**
 * Per-category box-label defaults: one row per (tenant, ЧЗ product group).
 * Resolution at shift creation is category default → organisation default
 * (`org_profiles.default_box_label_template_id`) → none. The composite FK
 * keeps a default inside its own tenant; its constraint name is part of the
 * label-templates delete-conflict set (label-templates.service.ts).
 */
export const orgBoxLabelTemplateDefaults = pgTable(
  "org_box_label_template_defaults",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    chzProductGroupCode: integer("chz_product_group_code")
      .notNull()
      .references(() => chzProductGroups.code),
    templateId: uuid("template_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.chzProductGroupCode] }),
    foreignKey({
      name: "org_box_label_template_defaults_template_tenant_fk",
      columns: [table.tenantId, table.templateId],
      foreignColumns: [labelTemplates.tenantId, labelTemplates.id],
    }),
  ],
);

export type OrgBoxLabelTemplateDefaultRow = typeof orgBoxLabelTemplateDefaults.$inferSelect;
```

- [ ] **Step 6: Запустить тест, убедиться, что он проходит**

Run: `pnpm --filter @markiro/db exec vitest run test/label-template-scope.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Сгенерировать миграцию и переименовать её**

Run:

```bash
pnpm --filter @markiro/db db:generate
ls packages/db/migrations | grep '^0111_'
```

Expected: один файл `0111_<two_words>.sql` и `meta/0111_snapshot.json`. Затем:

```bash
git mv packages/db/migrations/0111_<two_words>.sql packages/db/migrations/0111_label_template_scope_and_defaults.sql
```

и в `packages/db/migrations/meta/_journal.json` в записи с `"idx": 111` заменить `"tag": "0111_<two_words>"` на `"tag": "0111_label_template_scope_and_defaults"`.

- [ ] **Step 8: Проверить SQL миграции**

Открыть `packages/db/migrations/0111_label_template_scope_and_defaults.sql`. Ожидаемое содержимое (порядок и имена автогенерируемых FK могут отличаться, суть должна совпадать):

```sql
CREATE TABLE "org_box_label_template_defaults" (
	"tenant_id" text NOT NULL,
	"chz_product_group_code" integer NOT NULL,
	"template_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_box_label_template_defaults_tenant_id_chz_product_group_code_pk" PRIMARY KEY("tenant_id","chz_product_group_code")
);
--> statement-breakpoint
ALTER TABLE "label_templates" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "label_templates" ADD COLUMN "chz_product_group_codes" integer[];--> statement-breakpoint
ALTER TABLE "org_box_label_template_defaults" ADD CONSTRAINT "org_box_label_template_defaults_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_box_label_template_defaults" ADD CONSTRAINT "org_box_label_template_defaults_chz_product_group_code_chz_product_groups_code_fk" FOREIGN KEY ("chz_product_group_code") REFERENCES "public"."chz_product_groups"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_box_label_template_defaults" ADD CONSTRAINT "org_box_label_template_defaults_template_tenant_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."label_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_templates" ADD CONSTRAINT "label_templates_product_group_codes_nonempty" CHECK ("label_templates"."chz_product_group_codes" IS NULL OR cardinality("label_templates"."chz_product_group_codes") > 0);
```

Если генератор выдал что-то сверх этого (DROP, изменения других таблиц), значит схема и снапшот разошлись раньше: остановиться и разобраться, а не коммитить лишнее.

- [ ] **Step 9: Собрать пакет, прогнать тесты пакета и применить миграцию к dev-БД**

Run:

```bash
set -a; source .env; set +a
pnpm --filter @markiro/db build
pnpm --filter @markiro/db db:migrate
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
```

Expected: миграция применилась, все тесты пакета зелёные (тесты миграций не пропущены, так как `DATABASE_URL` задан).

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/schema/labels.ts packages/db/src/schema/org-profile.ts packages/db/migrations/0111_label_template_scope_and_defaults.sql packages/db/migrations/meta/0111_snapshot.json packages/db/migrations/meta/_journal.json packages/db/test/label-template-scope.test.ts
git commit -m "feat(db): label template enabled flag, product-group scope and category defaults

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Доменные правила пригодности и ЕГАИС

**Files:**

- Create: `packages/domain/src/product-attributes/egais.ts`
- Create: `packages/domain/src/labels/eligibility.ts`
- Modify: `packages/domain/src/product-attributes/index.ts`
- Modify: `packages/domain/src/index.ts` (блок экспортов labels, строки 23–59)
- Modify: `apps/api/src/modules/product-regulatory/readiness.service.ts:78,141`
- Test: `packages/domain/test/product-attributes-egais.test.ts`, `packages/domain/test/labels-eligibility.test.ts`

**Interfaces:**

- Produces (из `@markiro/domain`):
  - `EGAIS_PRODUCT_GROUP_CODE: 15`, `isEgaisApplicable(code: number | null | undefined): boolean`.
  - `interface BoxLabelTemplateEligibility { enabled: boolean; chzProductGroupCodes: readonly number[] | null }`.
  - `isBoxLabelTemplateEligible(template: BoxLabelTemplateEligibility, chzProductGroupCode: number | null): boolean`.
  - `type BoxLabelTemplateDefaultSource = "category" | "organization"`; `interface BoxLabelTemplateDefault { templateId: string | null; source: BoxLabelTemplateDefaultSource | null }`; `resolveBoxLabelTemplateDefault(input: { categoryDefaultId: string | null; organizationDefaultId: string | null }): BoxLabelTemplateDefault`.
  - `labelTemplateUsesField(spec: LabelTemplateSpec, field: LabelField): boolean`.

- [ ] **Step 1: Написать падающие тесты**

`packages/domain/test/product-attributes-egais.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { EGAIS_PRODUCT_GROUP_CODE, isEgaisApplicable } from "../src/index.js";

describe("EGAIS applicability", () => {
  it("applies only to the beer product group (ЧЗ code 15)", () => {
    expect(EGAIS_PRODUCT_GROUP_CODE).toBe(15);
    expect(isEgaisApplicable(15)).toBe(true);
    expect(isEgaisApplicable(8)).toBe(false);
    expect(isEgaisApplicable(null)).toBe(false);
    expect(isEgaisApplicable(undefined)).toBe(false);
  });
});
```

`packages/domain/test/labels-eligibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  isBoxLabelTemplateEligible,
  labelTemplateUsesField,
  resolveBoxLabelTemplateDefault,
  type LabelTemplateSpec,
} from "../src/index.js";

describe("isBoxLabelTemplateEligible", () => {
  it("accepts an enabled universal template for any category, including an unknown one", () => {
    const template = { enabled: true, chzProductGroupCodes: null };
    expect(isBoxLabelTemplateEligible(template, 15)).toBe(true);
    expect(isBoxLabelTemplateEligible(template, null)).toBe(true);
  });

  it("accepts a scoped template only for a listed category", () => {
    const template = { enabled: true, chzProductGroupCodes: [15, 22] };
    expect(isBoxLabelTemplateEligible(template, 15)).toBe(true);
    expect(isBoxLabelTemplateEligible(template, 22)).toBe(true);
    expect(isBoxLabelTemplateEligible(template, 8)).toBe(false);
    expect(isBoxLabelTemplateEligible(template, null)).toBe(false);
  });

  it("never accepts a disabled template", () => {
    expect(isBoxLabelTemplateEligible({ enabled: false, chzProductGroupCodes: null }, 15)).toBe(
      false,
    );
    expect(isBoxLabelTemplateEligible({ enabled: false, chzProductGroupCodes: [15] }, 15)).toBe(
      false,
    );
  });
});

describe("resolveBoxLabelTemplateDefault", () => {
  it("prefers the category default over the organisation default", () => {
    expect(
      resolveBoxLabelTemplateDefault({ categoryDefaultId: "cat", organizationDefaultId: "org" }),
    ).toEqual({ templateId: "cat", source: "category" });
  });

  it("falls back to the organisation default, then to nothing", () => {
    expect(
      resolveBoxLabelTemplateDefault({ categoryDefaultId: null, organizationDefaultId: "org" }),
    ).toEqual({ templateId: "org", source: "organization" });
    expect(
      resolveBoxLabelTemplateDefault({ categoryDefaultId: null, organizationDefaultId: null }),
    ).toEqual({ templateId: null, source: null });
  });
});

describe("labelTemplateUsesField", () => {
  const base = { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl" } as const;

  it("finds a field element bound to the field", () => {
    const spec: LabelTemplateSpec = {
      ...base,
      elements: [{ kind: "field", id: "e", xMm: 1, yMm: 1, field: "product.egais", fontSizePt: 8 }],
    };
    expect(labelTemplateUsesField(spec, "product.egais")).toBe(true);
    expect(labelTemplateUsesField(spec, "product.gtin")).toBe(false);
  });

  it("finds a barcode whose data is bound to the field, ignoring literals and text", () => {
    const spec: LabelTemplateSpec = {
      ...base,
      elements: [
        { kind: "text", id: "t", xMm: 1, yMm: 1, text: "ЕГАИС", fontSizePt: 8 },
        {
          kind: "barcode",
          id: "b",
          xMm: 1,
          yMm: 10,
          symbology: "code128",
          data: "product.egais",
          heightMm: 10,
        },
      ],
    };
    expect(labelTemplateUsesField(spec, "product.egais")).toBe(true);
    expect(labelTemplateUsesField({ ...base, elements: [] }, "product.egais")).toBe(false);
  });
});
```

Перед запуском сверить форму barcode-элемента с `packages/domain/src/labels/model.ts` (схема `barcodeElementSchema`, строки ~70–95): если обязательные поля называются иначе (`symbology`, `heightMm`), поправить фикстуру в тесте, не меняя модель.

- [ ] **Step 2: Запустить тесты, убедиться, что они падают**

Run: `pnpm --filter @markiro/domain exec vitest run test/product-attributes-egais.test.ts test/labels-eligibility.test.ts`
Expected: FAIL (экспорты не найдены).

- [ ] **Step 3: Создать `packages/domain/src/product-attributes/egais.ts`**

```ts
/**
 * Chestny ZNAK product group «Пиво, напитки, изготавливаемые на основе пива,
 * слабоалкогольные напитки» -- the only group whose products carry an EGAIS
 * code. Every "is EGAIS relevant here" decision (readiness, label editor
 * hints) goes through this constant instead of a bare literal.
 */
export const EGAIS_PRODUCT_GROUP_CODE = 15;

export function isEgaisApplicable(chzProductGroupCode: number | null | undefined): boolean {
  return chzProductGroupCode === EGAIS_PRODUCT_GROUP_CODE;
}
```

В `packages/domain/src/product-attributes/index.ts` добавить строку:

```ts
export * from "./egais.js";
```

- [ ] **Step 4: Создать `packages/domain/src/labels/eligibility.ts`**

```ts
import type { LabelField, LabelTemplateSpec } from "./model.js";

/** The selection metadata a template carries besides its print spec. */
export interface BoxLabelTemplateEligibility {
  enabled: boolean;
  /** `null` means every category; otherwise the ЧЗ product-group codes it applies to. */
  chzProductGroupCodes: readonly number[] | null;
}

/**
 * Whether a template may be offered for a product of the given ЧЗ product
 * group. A product without a group (`null`) can only use universal
 * templates: a scoped template never matches an unknown category.
 */
export function isBoxLabelTemplateEligible(
  template: BoxLabelTemplateEligibility,
  chzProductGroupCode: number | null,
): boolean {
  if (!template.enabled) return false;
  if (template.chzProductGroupCodes === null) return true;
  return (
    chzProductGroupCode !== null && template.chzProductGroupCodes.includes(chzProductGroupCode)
  );
}

export type BoxLabelTemplateDefaultSource = "category" | "organization";

export interface BoxLabelTemplateDefault {
  templateId: string | null;
  source: BoxLabelTemplateDefaultSource | null;
}

/** Category default → organisation default → none. */
export function resolveBoxLabelTemplateDefault(input: {
  categoryDefaultId: string | null;
  organizationDefaultId: string | null;
}): BoxLabelTemplateDefault {
  if (input.categoryDefaultId !== null) {
    return { templateId: input.categoryDefaultId, source: "category" };
  }
  if (input.organizationDefaultId !== null) {
    return { templateId: input.organizationDefaultId, source: "organization" };
  }
  return { templateId: null, source: null };
}

/** True when any field element or field-bound barcode in the spec reads `field`. */
export function labelTemplateUsesField(spec: LabelTemplateSpec, field: LabelField): boolean {
  return spec.elements.some((element) => {
    if (element.kind === "field") return element.field === field;
    if (element.kind === "barcode") return element.data === field;
    return false;
  });
}
```

Если `element.data` в модели типизирован как `LabelField | { literal: string }`, сравнение `element.data === field` корректно сужается; если TypeScript ругается, заменить на `typeof element.data === "string" && element.data === field`.

- [ ] **Step 5: Экспортировать из барреля `packages/domain/src/index.ts`**

После блока экспортов из `./labels/model.js` (строки 23–32) добавить:

```ts
export {
  isBoxLabelTemplateEligible,
  labelTemplateUsesField,
  resolveBoxLabelTemplateDefault,
} from "./labels/eligibility.js";
export type {
  BoxLabelTemplateDefault,
  BoxLabelTemplateDefaultSource,
  BoxLabelTemplateEligibility,
} from "./labels/eligibility.js";
```

`egais.ts` уже экспортируется через `export * from "./product-attributes/index.js"` (строка 3).

- [ ] **Step 6: Запустить тесты домена**

Run: `pnpm --filter @markiro/domain exec vitest run test/product-attributes-egais.test.ts test/labels-eligibility.test.ts`
Expected: PASS.

- [ ] **Step 7: Перевести readiness на константу**

В `apps/api/src/modules/product-regulatory/readiness.service.ts` добавить в импорт из `@markiro/domain` имя `isEgaisApplicable` и заменить оба вхождения (строки 78 и 141):

```ts
          applicable: isEgaisApplicable(product.chzProductGroupCode),
```

- [ ] **Step 8: Собрать домен, прогнать гейты домена и тест readiness**

Run:

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/api exec vitest run test/readiness.service.test.ts
pnpm --filter @markiro/api typecheck
```

Expected: всё зелёное.

- [ ] **Step 9: Commit**

```bash
git add packages/domain/src/product-attributes/egais.ts packages/domain/src/product-attributes/index.ts packages/domain/src/labels/eligibility.ts packages/domain/src/index.ts packages/domain/test/product-attributes-egais.test.ts packages/domain/test/labels-eligibility.test.ts apps/api/src/modules/product-regulatory/readiness.service.ts
git commit -m "feat(domain): box label template eligibility rules and EGAIS product group constant

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: API шаблонов: поля, фильтр `enabled`, инвариант дефолта, общий модуль пригодности

**Files:**

- Create: `apps/api/src/modules/label-templates/box-label-template-eligibility.ts`
- Modify: `apps/api/src/modules/label-templates/dto.ts`
- Modify: `apps/api/src/modules/label-templates/label-templates.controller.ts:59-69,103-121`
- Modify: `apps/api/src/modules/label-templates/label-templates.service.ts`
- Test: `apps/api/test/label-templates.e2e.test.ts`

**Interfaces:**

- Consumes: `schema.labelTemplates.enabled/chzProductGroupCodes`, `schema.orgBoxLabelTemplateDefaults` (Task 1); `isBoxLabelTemplateEligible`, `resolveBoxLabelTemplateDefault` (Task 2).
- Produces (модуль `box-label-template-eligibility.ts`, используется задачами 4–6):
  - `type EligibilityDb = Pick<Db, "select">`.
  - `interface LabelTemplateEligibilityRow { id: string; enabled: boolean; chzProductGroupCodes: number[] | null }`.
  - `findLabelTemplateEligibility(db, tenantId, templateId, lock?: "share" | "update"): Promise<LabelTemplateEligibilityRow | null>`.
  - `resolveDefaultBoxLabelTemplate(db, tenantId, chzProductGroupCode: number | null): Promise<BoxLabelTemplateDefault>`.
  - `interface LabelTemplateDefaultUsage { organizationDefault: boolean; categoryDefaults: number[] }`; `findLabelTemplateDefaultUsage(db, tenantId, templateId): Promise<LabelTemplateDefaultUsage>`.
  - `assertKnownProductGroupCodes(db, codes: readonly number[]): Promise<void>` — бросает `BadRequestException({ code: "CHZ_PRODUCT_GROUP_UNKNOWN", codes })`.
- Produces (HTTP): `GET /label-templates?enabled=true|false|all` (default `true`); DTO шаблона и сводки с `enabled: boolean`, `chzProductGroupCodes: number[] | null`; `POST/PATCH` принимают `enabled?`, `chzProductGroupCodes?`; PATCH отвечает 409 `{ code: "LABEL_TEMPLATE_IS_DEFAULT", message, organizationDefault: boolean, categoryDefaults: number[] }`.

- [ ] **Step 1: Написать падающие e2e-тесты**

В `apps/api/test/label-templates.e2e.test.ts` внутри `describe("label-templates e2e", …)` добавить (после существующих helper-функций `signUpAndActivate`):

```ts
async function createTemplate(
  agent: ReturnType<typeof request.agent>,
  body: Record<string, unknown>,
): Promise<{ id: string; enabled: boolean; chzProductGroupCodes: number[] | null }> {
  const res = await agent
    .post("/label-templates")
    .send({ name: "Scoped", spec: VALID_SPEC, ...body })
    .expect(201);
  return res.body as { id: string; enabled: boolean; chzProductGroupCodes: number[] | null };
}

it("creates templates enabled and universal by default, and round-trips scope and flag", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);

  const plain = await createTemplate(agent, {});
  expect(plain.enabled).toBe(true);
  expect(plain.chzProductGroupCodes).toBeNull();

  const scoped = await createTemplate(agent, { enabled: false, chzProductGroupCodes: [15, 22] });
  expect(scoped.enabled).toBe(false);
  expect(scoped.chzProductGroupCodes).toEqual([15, 22]);

  const fetched = await agent.get(`/label-templates/${scoped.id}`).expect(200);
  expect(fetched.body.enabled).toBe(false);
  expect(fetched.body.chzProductGroupCodes).toEqual([15, 22]);
});

it("rejects an empty, duplicated or unknown product-group scope with 400", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);

  await agent
    .post("/label-templates")
    .send({ name: "Empty", spec: VALID_SPEC, chzProductGroupCodes: [] })
    .expect(400);
  await agent
    .post("/label-templates")
    .send({ name: "Dup", spec: VALID_SPEC, chzProductGroupCodes: [15, 15] })
    .expect(400);
  const unknown = await agent
    .post("/label-templates")
    .send({ name: "Unknown", spec: VALID_SPEC, chzProductGroupCodes: [15, 999999] })
    .expect(400);
  expect(unknown.body.code).toBe("CHZ_PRODUCT_GROUP_UNKNOWN");
  expect(unknown.body.codes).toEqual([999999]);
});

it("lists enabled templates by default and everything with enabled=all", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const on = await createTemplate(agent, { name: "On" });
  const off = await createTemplate(agent, { name: "Off", enabled: false });

  const defaultList = await agent.get("/label-templates").expect(200);
  const defaultIds = defaultList.body.items.map((item: { id: string }) => item.id);
  expect(defaultIds).toContain(on.id);
  expect(defaultIds).not.toContain(off.id);

  const all = await agent.get("/label-templates?enabled=all").expect(200);
  const allIds = all.body.items.map((item: { id: string }) => item.id);
  expect(allIds).toContain(on.id);
  expect(allIds).toContain(off.id);
  const offSummary = all.body.items.find((item: { id: string }) => item.id === off.id);
  expect(offSummary).toMatchObject({ enabled: false, chzProductGroupCodes: null });

  const disabledOnly = await agent.get("/label-templates?enabled=false").expect(200);
  expect(disabledOnly.body.items.map((item: { id: string }) => item.id)).toEqual([off.id]);

  await agent.get("/label-templates?enabled=maybe").expect(400);
});

it("refuses to disable or narrow a template that is the organisation default", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const template = await createTemplate(agent, { name: "Org default" });
  await agent.put("/org/profile").send({ defaultBoxLabelTemplateId: template.id }).expect(200);

  const disable = await agent
    .patch(`/label-templates/${template.id}`)
    .send({ enabled: false })
    .expect(409);
  expect(disable.body).toMatchObject({
    code: "LABEL_TEMPLATE_IS_DEFAULT",
    organizationDefault: true,
    categoryDefaults: [],
  });

  const narrow = await agent
    .patch(`/label-templates/${template.id}`)
    .send({ chzProductGroupCodes: [15] })
    .expect(409);
  expect(narrow.body.organizationDefault).toBe(true);

  // A rename alone still goes through: the invariant is only checked when
  // enabled or scope change.
  await agent.patch(`/label-templates/${template.id}`).send({ name: "Renamed" }).expect(200);
  const still = await agent.get(`/label-templates/${template.id}`).expect(200);
  expect(still.body.enabled).toBe(true);
});

it("refuses to scope a category default away from its category, but allows widening", async () => {
  const agent = request.agent(app!.getHttpServer());
  const orgId = await signUpAndActivate(agent);
  const template = await createTemplate(agent, { name: "Beer", chzProductGroupCodes: [15, 22] });
  await db.insert(schema.orgBoxLabelTemplateDefaults).values({
    tenantId: orgId,
    chzProductGroupCode: 15,
    templateId: template.id,
  });

  const drop = await agent
    .patch(`/label-templates/${template.id}`)
    .send({ chzProductGroupCodes: [22] })
    .expect(409);
  expect(drop.body).toMatchObject({ organizationDefault: false, categoryDefaults: [15] });

  await agent.patch(`/label-templates/${template.id}`).send({ enabled: false }).expect(409);

  const widened = await agent
    .patch(`/label-templates/${template.id}`)
    .send({ chzProductGroupCodes: null })
    .expect(200);
  expect(widened.body.chzProductGroupCodes).toBeNull();
});

it("answers 409 when deleting a template that is a category default", async () => {
  const agent = request.agent(app!.getHttpServer());
  const orgId = await signUpAndActivate(agent);
  const template = await createTemplate(agent, { name: "Beer" });
  await db.insert(schema.orgBoxLabelTemplateDefaults).values({
    tenantId: orgId,
    chzProductGroupCode: 15,
    templateId: template.id,
  });
  await agent.delete(`/label-templates/${template.id}`).expect(409);
});
```

Если в файле `signUpAndActivate` возвращает `orgId` (см. строки 67–93), использовать его как выше; иначе взять `tenantId` из `signUpWithInactiveOrg` + `set-active`.

- [ ] **Step 2: Запустить, убедиться, что падает**

Run:

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/label-templates.e2e.test.ts
```

Expected: новые тесты FAIL (нет полей, 200 вместо 409, 200 вместо 400).

- [ ] **Step 3: Создать `apps/api/src/modules/label-templates/box-label-template-eligibility.ts`**

```ts
import { BadRequestException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { resolveBoxLabelTemplateDefault, type BoxLabelTemplateDefault } from "@markiro/domain";

/**
 * Database-backed helpers over the domain's box-label eligibility rules.
 * Plain functions (no Nest DI) so label-templates, org-profile, shifts and
 * inventories can share them from inside their own transactions.
 */
export type EligibilityDb = Pick<Db, "select">;

export interface LabelTemplateEligibilityRow {
  id: string;
  enabled: boolean;
  chzProductGroupCodes: number[] | null;
}

/** Same-tenant template with its selection metadata, or null. `lock` runs inside a transaction. */
export async function findLabelTemplateEligibility(
  db: EligibilityDb,
  tenantId: string,
  templateId: string,
  lock?: "share" | "update",
): Promise<LabelTemplateEligibilityRow | null> {
  const query = db
    .select({
      id: schema.labelTemplates.id,
      enabled: schema.labelTemplates.enabled,
      chzProductGroupCodes: schema.labelTemplates.chzProductGroupCodes,
    })
    .from(schema.labelTemplates)
    .where(
      and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, templateId)),
    );
  const [row] = lock ? await query.for(lock) : await query;
  return row ?? null;
}

/** Category default (when the product has a group) → organisation default → none. */
export async function resolveDefaultBoxLabelTemplate(
  db: EligibilityDb,
  tenantId: string,
  chzProductGroupCode: number | null,
): Promise<BoxLabelTemplateDefault> {
  const [profile] = await db
    .select({ templateId: schema.orgProfiles.defaultBoxLabelTemplateId })
    .from(schema.orgProfiles)
    .where(eq(schema.orgProfiles.tenantId, tenantId));
  let categoryDefaultId: string | null = null;
  if (chzProductGroupCode !== null) {
    const [category] = await db
      .select({ templateId: schema.orgBoxLabelTemplateDefaults.templateId })
      .from(schema.orgBoxLabelTemplateDefaults)
      .where(
        and(
          eq(schema.orgBoxLabelTemplateDefaults.tenantId, tenantId),
          eq(schema.orgBoxLabelTemplateDefaults.chzProductGroupCode, chzProductGroupCode),
        ),
      );
    categoryDefaultId = category?.templateId ?? null;
  }
  return resolveBoxLabelTemplateDefault({
    categoryDefaultId,
    organizationDefaultId: profile?.templateId ?? null,
  });
}

export interface LabelTemplateDefaultUsage {
  organizationDefault: boolean;
  /** Product-group codes whose category default is this template, ascending. */
  categoryDefaults: number[];
}

export async function findLabelTemplateDefaultUsage(
  db: EligibilityDb,
  tenantId: string,
  templateId: string,
): Promise<LabelTemplateDefaultUsage> {
  const [profile] = await db
    .select({ templateId: schema.orgProfiles.defaultBoxLabelTemplateId })
    .from(schema.orgProfiles)
    .where(eq(schema.orgProfiles.tenantId, tenantId));
  const rows = await db
    .select({ code: schema.orgBoxLabelTemplateDefaults.chzProductGroupCode })
    .from(schema.orgBoxLabelTemplateDefaults)
    .where(
      and(
        eq(schema.orgBoxLabelTemplateDefaults.tenantId, tenantId),
        eq(schema.orgBoxLabelTemplateDefaults.templateId, templateId),
      ),
    );
  return {
    organizationDefault: profile?.templateId === templateId,
    categoryDefaults: rows.map((row) => row.code).sort((a, b) => a - b),
  };
}

/** 400 with the offending codes when any is missing from `chz_product_groups`. */
export async function assertKnownProductGroupCodes(
  db: EligibilityDb,
  codes: readonly number[],
): Promise<void> {
  if (codes.length === 0) return;
  const rows = await db
    .select({ code: schema.chzProductGroups.code })
    .from(schema.chzProductGroups)
    .where(inArray(schema.chzProductGroups.code, [...codes]));
  const known = new Set(rows.map((row) => row.code));
  const unknown = codes.filter((code) => !known.has(code));
  if (unknown.length > 0) {
    throw new BadRequestException({
      code: "CHZ_PRODUCT_GROUP_UNKNOWN",
      message: `Unknown Chestny ZNAK product group codes: ${unknown.join(", ")}`,
      codes: unknown,
    });
  }
}
```

Если TypeScript не принимает `query.for(lock)` из-за типа билдера после `.where`, разбить на две ветки: `lock ? await db.select(...).from(...).where(...).for(lock) : await db.select(...).from(...).where(...)` с вынесенной функцией-строителем.

- [ ] **Step 4: Расширить `apps/api/src/modules/label-templates/dto.ts`**

Перед `createLabelTemplateSchema` добавить:

```ts
/** Non-empty, duplicate-free ЧЗ product-group codes; `null` means every category. */
const productGroupCodesSchema = z
  .array(z.number().int().positive())
  .min(1, "chzProductGroupCodes must list at least one product group")
  .refine((codes) => new Set(codes).size === codes.length, {
    message: "chzProductGroupCodes must not repeat a code",
  })
  .nullable();

export const listLabelTemplatesQuerySchema = z.object({
  /** `true` (default) hides disabled templates so every picker is safe by default; the library asks for `all`. */
  enabled: z.enum(["true", "false", "all"]).default("true"),
});
export type ListLabelTemplatesQueryDto = z.infer<typeof listLabelTemplatesQuerySchema>;
```

Заменить `createLabelTemplateSchema` и `updateLabelTemplateSchema`:

```ts
export const createLabelTemplateSchema = z
  .object({
    name: z.string().min(1).max(200),
    spec: z.unknown(),
    enabled: z.boolean().optional(),
    chzProductGroupCodes: productGroupCodesSchema.optional(),
  })
  .transform((data, ctx) => ({
    name: data.name,
    spec: parseSpecOrAddIssues(data.spec, ctx),
    enabled: data.enabled ?? true,
    chzProductGroupCodes: data.chzProductGroupCodes ?? null,
  }));
export type CreateLabelTemplateDto = z.infer<typeof createLabelTemplateSchema>;

export const updateLabelTemplateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    spec: z.unknown().optional(),
    enabled: z.boolean().optional(),
    chzProductGroupCodes: productGroupCodesSchema.optional(),
  })
  .transform((data, ctx) => {
    const result: {
      name?: string;
      spec?: LabelTemplateSpec;
      enabled?: boolean;
      chzProductGroupCodes?: number[] | null;
    } = {};
    if (data.name !== undefined) result.name = data.name;
    if (data.spec !== undefined) result.spec = parseSpecOrAddIssues(data.spec, ctx);
    if (data.enabled !== undefined) result.enabled = data.enabled;
    if (data.chzProductGroupCodes !== undefined) {
      result.chzProductGroupCodes = data.chzProductGroupCodes;
    }
    return result;
  });
export type UpdateLabelTemplateDto = z.infer<typeof updateLabelTemplateSchema>;
```

В `LabelTemplateDto` и `LabelTemplateSummaryDto` добавить поля:

```ts
  enabled: boolean;
  chzProductGroupCodes: number[] | null;
```

В OpenAPI-схемы: определить рядом с `uuidSchema`

```ts
const productGroupCodesOpenApiSchema = {
  type: "array",
  items: { type: "integer", minimum: 1 },
  minItems: 1,
  nullable: true,
  description: "ЧЗ product-group codes the template applies to; null means every category.",
} as const;
```

и в `labelTemplateOpenApiSchema` и `labelTemplateSummaryOpenApiSchema` добавить в `required` строки `"enabled", "chzProductGroupCodes"`, а в `properties`:

```ts
    enabled: { type: "boolean" },
    chzProductGroupCodes: productGroupCodesOpenApiSchema,
```

Добавить схему ответа 409:

```ts
export const labelTemplateIsDefaultOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "organizationDefault", "categoryDefaults"],
  properties: {
    code: { type: "string", enum: ["LABEL_TEMPLATE_IS_DEFAULT"] },
    message: { type: "string" },
    organizationDefault: { type: "boolean" },
    categoryDefaults: { type: "array", items: { type: "integer" } },
  },
};
```

- [ ] **Step 5: Контроллер: query-параметр и документация 409**

В `label-templates.controller.ts` добавить `Query` в импорт из `@nestjs/common`, `ApiZodQuery` в импорт из `../../lib/openapi`, а также `labelTemplateIsDefaultOpenApiSchema`, `listLabelTemplatesQuerySchema`, `type ListLabelTemplatesQueryDto` в импорт из `./dto`. Заменить GET-список:

```ts
  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "List label templates",
    description:
      "Size/DPI/language summaries without the full spec, most recently updated first. " +
      "Disabled templates are hidden unless `enabled=all` or `enabled=false` is requested.",
  })
  @ApiZodQuery(listLabelTemplatesQuerySchema)
  @ApiOkResponse({ schema: listLabelTemplatesOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  async listLabelTemplates(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listLabelTemplatesQuerySchema)) query: ListLabelTemplatesQueryDto,
  ): Promise<ListLabelTemplatesResponseDto> {
    return this.labelTemplatesService.listLabelTemplates(req.tenantId!, query);
  }
```

В PATCH-роуте заменить `@ApiHttpErrors(401, 403, 404)` на

```ts
  @ApiResponse({
    status: 409,
    description: "The template is an organisation or category default and would stop being eligible.",
    schema: labelTemplateIsDefaultOpenApiSchema,
  })
  @ApiHttpErrors(401, 403, 404)
```

(`ApiResponse` уже импортирован.)

- [ ] **Step 6: Сервис: фильтр, валидация кодов, инвариант дефолта**

В `label-templates.service.ts`:

Импорты: добавить `BadRequestException` не нужно (его бросает helper); добавить `isBoxLabelTemplateEligible` в импорт из `@markiro/domain`; добавить

```ts
import {
  assertKnownProductGroupCodes,
  findLabelTemplateDefaultUsage,
} from "./box-label-template-eligibility";
import type { ListLabelTemplatesQueryDto } from "./dto";
```

В `LABEL_TEMPLATE_REFERENCE_CONSTRAINTS` добавить `"org_box_label_template_defaults_template_tenant_fk"` и в тексте ConflictException удаления заменить на `"Label template is referenced by an organization or category default, product, shift, or inventory"`.

`listLabelTemplates`:

```ts
  async listLabelTemplates(
    tenantId: string,
    query: ListLabelTemplatesQueryDto,
  ): Promise<ListLabelTemplatesResponseDto> {
    const conditions = [eq(schema.labelTemplates.tenantId, tenantId)];
    if (query.enabled === "true") conditions.push(eq(schema.labelTemplates.enabled, true));
    if (query.enabled === "false") conditions.push(eq(schema.labelTemplates.enabled, false));
    const rows = await this.db
      .select()
      .from(schema.labelTemplates)
      .where(and(...conditions))
      .orderBy(desc(schema.labelTemplates.updatedAt));

    return { items: rows.map((row) => this.rowToSummaryDto(row)) };
  }
```

`createLabelTemplate`: перед insert добавить `if (data.chzProductGroupCodes !== null) await assertKnownProductGroupCodes(this.db, data.chzProductGroupCodes);` и в `.values` добавить `enabled: data.enabled, chzProductGroupCodes: data.chzProductGroupCodes`.

`updateLabelTemplate` заменить целиком:

```ts
  /**
   * Partial update inside one transaction. The row is locked FOR UPDATE so a
   * concurrent org-profile write (which locks the template FOR SHARE) cannot
   * make a default point at a template that is being disabled or narrowed.
   */
  async updateLabelTemplate(
    tenantId: string,
    id: string,
    data: UpdateLabelTemplateDto,
  ): Promise<LabelTemplateDto> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.labelTemplates)
        .where(and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, id)))
        .for("update");
      if (!current) {
        throw new NotFoundException("Label template not found or does not belong to this tenant");
      }
      if (data.chzProductGroupCodes) {
        await assertKnownProductGroupCodes(tx, data.chzProductGroupCodes);
      }

      const nextEnabled = data.enabled ?? current.enabled;
      const nextCodes =
        data.chzProductGroupCodes !== undefined
          ? data.chzProductGroupCodes
          : current.chzProductGroupCodes;
      if (data.enabled !== undefined || data.chzProductGroupCodes !== undefined) {
        const usage = await findLabelTemplateDefaultUsage(tx, tenantId, id);
        const next = { enabled: nextEnabled, chzProductGroupCodes: nextCodes };
        const organizationDefault = usage.organizationDefault && (!nextEnabled || nextCodes !== null);
        const categoryDefaults = usage.categoryDefaults.filter(
          (code) => !isBoxLabelTemplateEligible(next, code),
        );
        if (organizationDefault || categoryDefaults.length > 0) {
          throw new ConflictException({
            code: "LABEL_TEMPLATE_IS_DEFAULT",
            message: "Label template is used as a default and would stop being eligible",
            organizationDefault,
            categoryDefaults,
          });
        }
      }

      const setClause: Record<string, unknown> = { updatedAt: sql`now()` };
      if (data.name !== undefined) setClause.name = data.name;
      if (data.spec !== undefined) setClause.spec = data.spec;
      if (data.enabled !== undefined) setClause.enabled = data.enabled;
      if (data.chzProductGroupCodes !== undefined) {
        setClause.chzProductGroupCodes = data.chzProductGroupCodes;
      }

      const [row] = await tx
        .update(schema.labelTemplates)
        .set(setClause)
        .where(and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, id)))
        .returning();
      if (!row) {
        throw new NotFoundException("Label template not found or does not belong to this tenant");
      }
      return this.rowToDto(row);
    });
  }
```

`rowToDto` и `rowToSummaryDto`: добавить `enabled: row.enabled, chzProductGroupCodes: row.chzProductGroupCodes`.

- [ ] **Step 7: Запустить e2e и остальные тесты модуля**

Run:

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/label-templates.e2e.test.ts test/label-templates.service.test.ts test/openapi-coverage.test.ts test/openapi-docs.test.ts
pnpm --filter @markiro/api typecheck
```

Expected: PASS. Если `label-templates.service.test.ts` мокает `db` без `transaction`, расширить мок методом `transaction: (fn) => fn(mockTx)` по образцу его существующих моков, не ослабляя проверки.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/label-templates apps/api/test/label-templates.e2e.test.ts apps/api/test/label-templates.service.test.ts
git commit -m "feat(api): label template enabled filter, product-group scope and default invariant

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: API профиля организации: дефолты категорий и `productGroupsInUse`

**Files:**

- Modify: `apps/api/src/modules/org-profile/dto.ts`
- Modify: `apps/api/src/modules/org-profile/org-profile.service.ts:46-154`
- Test: `apps/api/test/org-profile.e2e.test.ts`

**Interfaces:**

- Consumes: `findLabelTemplateEligibility`, `assertKnownProductGroupCodes` (Task 3); `isBoxLabelTemplateEligible` (Task 2).
- Produces: `OrgProfileDto.categoryBoxLabelTemplateDefaults: Array<{ chzProductGroupCode: number; templateId: string }>`, `OrgProfileDto.productGroupsInUse: number[]`; `PUT /org/profile` принимает `categoryBoxLabelTemplateDefaults` (полная замена); 400 `{ code: "BOX_LABEL_TEMPLATE_NOT_ELIGIBLE", field, chzProductGroupCode? }`; аудит `tenant.box_label_template_defaults.updated`.

- [ ] **Step 1: Написать падающие e2e-тесты**

В `apps/api/test/org-profile.e2e.test.ts` добавить helper (рядом с существующими) и тесты:

```ts
const BOX_SPEC = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [{ kind: "text", id: "t", xMm: 2, yMm: 2, text: "Box", fontSizePt: 12 }],
};

async function createTemplate(
  agent: ReturnType<typeof request.agent>,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await agent
    .post("/label-templates")
    .send({ name: "T", spec: BOX_SPEC, ...body })
    .expect(201);
  return res.body.id as string;
}

async function seedProductInGroup(tenantId: string, code: number, archived = false) {
  await db.insert(schema.products).values({
    id: randomUUID(),
    tenantId,
    gtin14: `${Math.floor(Math.random() * 1e13)}`.padStart(14, "0"),
    name: `Product ${code}`,
    status: "active",
    chzProductGroupCode: code,
    archived,
  });
}

it("reports product groups in use from non-archived products only", async () => {
  const agent = request.agent(app!.getHttpServer());
  const orgId = await signUpWithInactiveOrg(agent);
  await agent.post("/api/auth/organization/set-active").send({ organizationId: orgId }).expect(200);
  await seedProductInGroup(orgId, 15);
  await seedProductInGroup(orgId, 8);
  await seedProductInGroup(orgId, 22, true);

  const profile = await agent.get("/org/profile").expect(200);
  expect(profile.body.productGroupsInUse).toEqual([8, 15]);
  expect(profile.body.categoryBoxLabelTemplateDefaults).toEqual([]);
});

it("only accepts an enabled universal template as the organisation default", async () => {
  const agent = request.agent(app!.getHttpServer());
  const orgId = await signUpWithInactiveOrg(agent);
  await agent.post("/api/auth/organization/set-active").send({ organizationId: orgId }).expect(200);
  const scoped = await createTemplate(agent, { chzProductGroupCodes: [15] });
  const disabled = await createTemplate(agent, { enabled: false });

  const scopedRes = await agent
    .put("/org/profile")
    .send({ defaultBoxLabelTemplateId: scoped })
    .expect(400);
  expect(scopedRes.body).toMatchObject({
    code: "BOX_LABEL_TEMPLATE_NOT_ELIGIBLE",
    field: "defaultBoxLabelTemplateId",
  });
  await agent.put("/org/profile").send({ defaultBoxLabelTemplateId: disabled }).expect(400);
});

it("replaces category defaults as a whole list, validating eligibility, and audits the change", async () => {
  const agent = request.agent(app!.getHttpServer());
  const orgId = await signUpWithInactiveOrg(agent);
  await agent.post("/api/auth/organization/set-active").send({ organizationId: orgId }).expect(200);
  const beer = await createTemplate(agent, { chzProductGroupCodes: [15] });
  const universal = await createTemplate(agent, {});

  const set = await agent
    .put("/org/profile")
    .send({
      categoryBoxLabelTemplateDefaults: [
        { chzProductGroupCode: 15, templateId: beer },
        { chzProductGroupCode: 8, templateId: universal },
      ],
    })
    .expect(200);
  expect(set.body.categoryBoxLabelTemplateDefaults).toEqual([
    { chzProductGroupCode: 8, templateId: universal },
    { chzProductGroupCode: 15, templateId: beer },
  ]);

  // Beer template does not cover milk (8).
  const wrong = await agent
    .put("/org/profile")
    .send({ categoryBoxLabelTemplateDefaults: [{ chzProductGroupCode: 8, templateId: beer }] })
    .expect(400);
  expect(wrong.body).toMatchObject({
    code: "BOX_LABEL_TEMPLATE_NOT_ELIGIBLE",
    field: "categoryBoxLabelTemplateDefaults",
    chzProductGroupCode: 8,
  });

  // Duplicate codes and unknown codes are rejected before any write.
  await agent
    .put("/org/profile")
    .send({
      categoryBoxLabelTemplateDefaults: [
        { chzProductGroupCode: 15, templateId: beer },
        { chzProductGroupCode: 15, templateId: universal },
      ],
    })
    .expect(400);
  await agent
    .put("/org/profile")
    .send({
      categoryBoxLabelTemplateDefaults: [{ chzProductGroupCode: 999999, templateId: universal }],
    })
    .expect(400);

  // Omitting the field keeps the list; sending a shorter list drops rows.
  const kept = await agent.put("/org/profile").send({ inn: "7701234567" }).expect(200);
  expect(kept.body.categoryBoxLabelTemplateDefaults).toHaveLength(2);
  const shrunk = await agent
    .put("/org/profile")
    .send({ categoryBoxLabelTemplateDefaults: [{ chzProductGroupCode: 15, templateId: beer }] })
    .expect(200);
  expect(shrunk.body.categoryBoxLabelTemplateDefaults).toEqual([
    { chzProductGroupCode: 15, templateId: beer },
  ]);

  const audits = await db
    .select({
      action: schema.tenantAuditEvents.action,
      before: schema.tenantAuditEvents.before,
      after: schema.tenantAuditEvents.after,
      targetType: schema.tenantAuditEvents.targetType,
      targetId: schema.tenantAuditEvents.targetId,
      outcome: schema.tenantAuditEvents.outcome,
    })
    .from(schema.tenantAuditEvents)
    .where(
      and(
        eq(schema.tenantAuditEvents.organizationId, orgId),
        eq(schema.tenantAuditEvents.action, "tenant.box_label_template_defaults.updated"),
      ),
    )
    .orderBy(desc(schema.tenantAuditEvents.createdAt));
  expect(audits).toHaveLength(2);
  expect(audits[0]).toMatchObject({
    outcome: "success",
    targetType: "tenant",
    targetId: orgId,
    before: {
      defaults: [
        { chzProductGroupCode: 8, templateId: universal },
        { chzProductGroupCode: 15, templateId: beer },
      ],
    },
    after: { defaults: [{ chzProductGroupCode: 15, templateId: beer }] },
  });
});
```

Сверить имя колонки времени в `tenantAuditEvents` (`createdAt` или `at`) по `packages/db/src/schema` перед запуском.

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/org-profile.e2e.test.ts`
Expected: новые тесты FAIL.

- [ ] **Step 3: DTO**

В `apps/api/src/modules/org-profile/dto.ts`:

```ts
const categoryBoxLabelTemplateDefaultSchema = z.object({
  chzProductGroupCode: z.number().int().positive(),
  templateId: z.string().uuid(),
});

export const putOrgProfileSchema = z.object({
  gln: glnSchema.nullable().optional(),
  gs1Prefixes: z.array(gs1PrefixSchema).optional(),
  inn: z.string().nullable().optional(),
  timeZone: timeZoneSchema.optional(),
  defaultBoxLabelTemplateId: z.string().uuid().nullable().optional(),
  /** Full replacement of the per-category box-label defaults; omitted keeps the current list. */
  categoryBoxLabelTemplateDefaults: z
    .array(categoryBoxLabelTemplateDefaultSchema)
    .refine(
      (items) => new Set(items.map((item) => item.chzProductGroupCode)).size === items.length,
      { message: "categoryBoxLabelTemplateDefaults must not repeat a product group" },
    )
    .optional(),
  pickupLimitsEnabled: z.boolean().optional(),
});
```

`OrgProfileDto` добавить:

```ts
  categoryBoxLabelTemplateDefaults: CategoryBoxLabelTemplateDefaultDto[];
  /** Distinct ЧЗ product-group codes of non-archived products, ascending. A UI hint only. */
  productGroupsInUse: number[];
```

и

```ts
export interface CategoryBoxLabelTemplateDefaultDto {
  chzProductGroupCode: number;
  templateId: string;
}
```

В `orgProfileOpenApiSchema` добавить в `required`: `"categoryBoxLabelTemplateDefaults", "productGroupsInUse"`, в `properties`:

```ts
    categoryBoxLabelTemplateDefaults: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["chzProductGroupCode", "templateId"],
        properties: { chzProductGroupCode: { type: "integer" }, templateId: uuidSchema },
      },
    },
    productGroupsInUse: { type: "array", items: { type: "integer" } },
```

- [ ] **Step 4: Сервис: чтение**

В `org-profile.service.ts` добавить импорты:

```ts
import { isBoxLabelTemplateEligible } from "@markiro/domain";
import {
  assertKnownProductGroupCodes,
  findLabelTemplateEligibility,
} from "../label-templates/box-label-template-eligibility";
import type { CategoryBoxLabelTemplateDefaultDto } from "./dto";
```

и `isNotNull` в импорт из `drizzle-orm`. В `getProfile` расширить `Promise.all` двумя запросами:

```ts
      this.db
        .select({
          chzProductGroupCode: schema.orgBoxLabelTemplateDefaults.chzProductGroupCode,
          templateId: schema.orgBoxLabelTemplateDefaults.templateId,
        })
        .from(schema.orgBoxLabelTemplateDefaults)
        .where(eq(schema.orgBoxLabelTemplateDefaults.tenantId, tenantId))
        .orderBy(schema.orgBoxLabelTemplateDefaults.chzProductGroupCode),
      this.db
        .select({ code: schema.products.chzProductGroupCode })
        .from(schema.products)
        .where(
          and(
            eq(schema.products.tenantId, tenantId),
            eq(schema.products.archived, false),
            isNotNull(schema.products.chzProductGroupCode),
          ),
        )
        .groupBy(schema.products.chzProductGroupCode)
        .orderBy(schema.products.chzProductGroupCode),
```

(деструктурировать как `categoryDefaults` и `groupsInUse`; для `groupsInUse` это массив строк, не `[[row]]`). В возвращаемый объект добавить:

```ts
      categoryBoxLabelTemplateDefaults: categoryDefaults,
      productGroupsInUse: groupsInUse.flatMap((row) => (row.code === null ? [] : [row.code])),
```

- [ ] **Step 5: Сервис: запись и аудит**

В `upsertProfile` внутри `this.db.transaction(async (tx) => { … })` перед upsert профиля добавить валидацию с блокировкой строк шаблонов:

```ts
if (patch.defaultBoxLabelTemplateId) {
  const template = await findLabelTemplateEligibility(
    tx,
    tenantId,
    patch.defaultBoxLabelTemplateId,
    "share",
  );
  if (!template) {
    throw new BadRequestException("Unknown box label template for this organization");
  }
  if (!template.enabled || template.chzProductGroupCodes !== null) {
    throw new BadRequestException({
      code: "BOX_LABEL_TEMPLATE_NOT_ELIGIBLE",
      message: "The organisation default must be an enabled template for all categories",
      field: "defaultBoxLabelTemplateId",
    });
  }
}
if (patch.categoryBoxLabelTemplateDefaults !== undefined) {
  await assertKnownProductGroupCodes(
    tx,
    patch.categoryBoxLabelTemplateDefaults.map((item) => item.chzProductGroupCode),
  );
  for (const item of patch.categoryBoxLabelTemplateDefaults) {
    const template = await findLabelTemplateEligibility(tx, tenantId, item.templateId, "share");
    if (!template || !isBoxLabelTemplateEligible(template, item.chzProductGroupCode)) {
      throw new BadRequestException({
        code: "BOX_LABEL_TEMPLATE_NOT_ELIGIBLE",
        message: "The category default must be an enabled template covering that category",
        field: "categoryBoxLabelTemplateDefaults",
        chzProductGroupCode: item.chzProductGroupCode,
      });
    }
  }
}
```

После upsert профиля (перед блоком `pickupLimitsEnabled`) добавить замену списка и аудит:

```ts
if (patch.categoryBoxLabelTemplateDefaults !== undefined) {
  const before: CategoryBoxLabelTemplateDefaultDto[] = await tx
    .select({
      chzProductGroupCode: schema.orgBoxLabelTemplateDefaults.chzProductGroupCode,
      templateId: schema.orgBoxLabelTemplateDefaults.templateId,
    })
    .from(schema.orgBoxLabelTemplateDefaults)
    .where(eq(schema.orgBoxLabelTemplateDefaults.tenantId, tenantId))
    .orderBy(schema.orgBoxLabelTemplateDefaults.chzProductGroupCode);
  const after: CategoryBoxLabelTemplateDefaultDto[] = [...patch.categoryBoxLabelTemplateDefaults]
    .map((item) => ({ chzProductGroupCode: item.chzProductGroupCode, templateId: item.templateId }))
    .sort((a, b) => a.chzProductGroupCode - b.chzProductGroupCode);
  await tx
    .delete(schema.orgBoxLabelTemplateDefaults)
    .where(eq(schema.orgBoxLabelTemplateDefaults.tenantId, tenantId));
  if (after.length > 0) {
    await tx
      .insert(schema.orgBoxLabelTemplateDefaults)
      .values(after.map((item) => ({ tenantId, ...item })));
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action: "tenant.box_label_template_defaults.updated",
      outcome: "success",
      targetType: "tenant",
      targetId: tenantId,
      before: { defaults: before },
      after: { defaults: after },
    });
  }
}
```

`OrgProfileDatabase` уже включает `delete` и `insert`. `BadRequestException` уже импортирован.

- [ ] **Step 6: Запустить тесты**

Run:

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/org-profile.e2e.test.ts test/org-profile.service.test.ts test/org-profile.controller.test.ts test/openapi-docs.test.ts
pnpm --filter @markiro/api typecheck
```

Expected: PASS. Если `org-profile.service.test.ts` строит `OrgProfileDto` вручную или мокает `db.select` цепочки, дополнить фикстуры/моки новыми полями и запросами, не удаляя существующие проверки.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/org-profile apps/api/test/org-profile.e2e.test.ts apps/api/test/org-profile.service.test.ts
git commit -m "feat(api): per-category box label defaults and product groups in use on the org profile

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: API смен: разрешение дефолта по товару, фильтр для станции, 422 на непригодный шаблон

**Files:**

- Modify: `apps/api/src/modules/shifts/dto.ts:188-214,343-373`
- Modify: `apps/api/src/modules/shifts/shifts.controller.ts:102-127`
- Modify: `apps/api/src/modules/shifts/shifts.service.ts:218-248,475-489,722-761,1222-1228,1286-1304`
- Test: `apps/api/test/shifts.e2e.test.ts`

**Interfaces:**

- Consumes: `findLabelTemplateEligibility`, `resolveDefaultBoxLabelTemplate` (Task 3); `isBoxLabelTemplateEligible`, `BoxLabelTemplateDefaultSource` (Task 2).
- Produces: `GET /shifts/planning-config?productId=` → `{ defaultBoxLabelTemplateId, defaultSource: "category" | "organization" | null }`; `GET /shifts/box-label-templates?productId=` → `{ items (только пригодные), defaultBoxLabelTemplateId, defaultSource }`; `POST /shifts` разрешает дефолт по цепочке, 422 `{ code: "BOX_LABEL_TEMPLATE_NOT_ELIGIBLE" }` на непригодный явный шаблон; `PATCH /shifts/:id` проверяет только сменившийся шаблон.

- [ ] **Step 1: Написать падающие e2e-тесты**

В `apps/api/test/shifts.e2e.test.ts` добавить helper рядом с `seedLabelTemplate`:

```ts
async function seedScopedLabelTemplate(
  tenantId: string,
  name: string,
  scope: { enabled?: boolean; chzProductGroupCodes?: number[] | null },
): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.labelTemplates).values({
    id,
    tenantId,
    name,
    spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
    enabled: scope.enabled ?? true,
    chzProductGroupCodes: scope.chzProductGroupCodes ?? null,
  });
  return id;
}

async function setCategoryDefault(tenantId: string, code: number, templateId: string) {
  await db
    .insert(schema.orgBoxLabelTemplateDefaults)
    .values({ tenantId, chzProductGroupCode: code, templateId });
}
```

и тесты:

```ts
it("resolves the box template default per product: category default before organisation default", async () => {
  const agent = request.agent(app!.getHttpServer());
  const orgId = await signUpAndActivate(agent);
  const orgDefault = await setDefaultBoxLabelTemplate(agent, orgId, "Org default");
  const beerDefault = await seedScopedLabelTemplate(orgId, "Beer", { chzProductGroupCodes: [15] });
  await setCategoryDefault(orgId, 15, beerDefault);
  const beer = await seedProduct(orgId, {
    status: "active",
    chzProductGroupCode: 15,
    boxCapacity: 6,
  });
  const milk = await seedProduct(orgId, {
    status: "active",
    chzProductGroupCode: 8,
    boxCapacity: 6,
  });

  const beerConfig = await agent.get(`/shifts/planning-config?productId=${beer}`).expect(200);
  expect(beerConfig.body).toEqual({
    defaultBoxLabelTemplateId: beerDefault,
    defaultSource: "category",
  });
  const milkConfig = await agent.get(`/shifts/planning-config?productId=${milk}`).expect(200);
  expect(milkConfig.body).toEqual({
    defaultBoxLabelTemplateId: orgDefault,
    defaultSource: "organization",
  });
  const orgConfig = await agent.get("/shifts/planning-config").expect(200);
  expect(orgConfig.body).toEqual({
    defaultBoxLabelTemplateId: orgDefault,
    defaultSource: "organization",
  });
  await agent.get(`/shifts/planning-config?productId=${randomUUID()}`).expect(404);

  const beerShift = await agent
    .post("/shifts")
    .send({ productId: beer, mode: "aggregation" })
    .expect(201);
  expect(beerShift.body.boxLabelTemplateId).toBe(beerDefault);
  const milkShift = await agent
    .post("/shifts")
    .send({ productId: milk, mode: "aggregation" })
    .expect(201);
  expect(milkShift.body.boxLabelTemplateId).toBe(orgDefault);
});

it("rejects an explicit box template that is disabled or scoped to another category", async () => {
  const agent = request.agent(app!.getHttpServer());
  const orgId = await signUpAndActivate(agent);
  await setDefaultBoxLabelTemplate(agent, orgId);
  const disabled = await seedScopedLabelTemplate(orgId, "Off", { enabled: false });
  const beerOnly = await seedScopedLabelTemplate(orgId, "Beer", { chzProductGroupCodes: [15] });
  const milk = await seedProduct(orgId, {
    status: "active",
    chzProductGroupCode: 8,
    boxCapacity: 6,
  });

  const off = await agent
    .post("/shifts")
    .send({ productId: milk, mode: "aggregation", boxLabelTemplateId: disabled })
    .expect(422);
  expect(off.body.code).toBe("BOX_LABEL_TEMPLATE_NOT_ELIGIBLE");
  await agent
    .post("/shifts")
    .send({ productId: milk, mode: "aggregation", boxLabelTemplateId: beerOnly })
    .expect(422);
  await agent
    .post("/shifts")
    .send({ productId: milk, mode: "aggregation", boxLabelTemplateId: randomUUID() })
    .expect(422);
});

it("keeps a planned shift editable when its template was disabled later, but blocks switching to an ineligible one", async () => {
  const agent = request.agent(app!.getHttpServer());
  const orgId = await signUpAndActivate(agent);
  const template = await setDefaultBoxLabelTemplate(agent, orgId);
  const milk = await seedProduct(orgId, {
    status: "active",
    chzProductGroupCode: 8,
    boxCapacity: 6,
  });
  const created = await agent
    .post("/shifts")
    .send({ productId: milk, mode: "aggregation" })
    .expect(201);
  const shiftId = created.body.id as string;

  // Detach the default, then disable the template directly (the API would refuse while it is a default).
  await agent.put("/org/profile").send({ defaultBoxLabelTemplateId: null }).expect(200);
  await db
    .update(schema.labelTemplates)
    .set({ enabled: false })
    .where(eq(schema.labelTemplates.id, template));

  await agent
    .patch(`/shifts/${shiftId}`)
    .send({ plannedQty: 500, boxLabelTemplateId: template })
    .expect(200);
  const other = await seedScopedLabelTemplate(orgId, "Beer", { chzProductGroupCodes: [15] });
  const blocked = await agent
    .patch(`/shifts/${shiftId}`)
    .send({ boxLabelTemplateId: other })
    .expect(422);
  expect(blocked.body.code).toBe("BOX_LABEL_TEMPLATE_NOT_ELIGIBLE");
});

it("filters station box-template options by the product's category and hides disabled templates", async () => {
  const agent = request.agent(app!.getHttpServer());
  const orgId = await signUpAndActivate(agent);
  const orgDefault = await setDefaultBoxLabelTemplate(agent, orgId, "Org default");
  const beerOnly = await seedScopedLabelTemplate(orgId, "Beer only", {
    chzProductGroupCodes: [15],
  });
  const disabled = await seedScopedLabelTemplate(orgId, "Disabled", { enabled: false });
  await setCategoryDefault(orgId, 15, beerOnly);
  const beer = await seedProduct(orgId, {
    status: "active",
    chzProductGroupCode: 15,
    boxCapacity: 6,
  });
  const milk = await seedProduct(orgId, {
    status: "active",
    chzProductGroupCode: 8,
    boxCapacity: 6,
  });
  const device = await createTestStationDevice(app!, agent, "Scoped picker terminal");
  const server = app!.getHttpServer();

  const forBeer = await request(server)
    .get(`/shifts/box-label-templates?productId=${beer}`)
    .set("x-api-key", device.apiKey)
    .expect(200);
  expect(forBeer.body.defaultBoxLabelTemplateId).toBe(beerOnly);
  expect(forBeer.body.defaultSource).toBe("category");
  expect(forBeer.body.items.map((item: { id: string }) => item.id)).toEqual([beerOnly, orgDefault]);

  const forMilk = await request(server)
    .get(`/shifts/box-label-templates?productId=${milk}`)
    .set("x-api-key", device.apiKey)
    .expect(200);
  expect(forMilk.body.defaultBoxLabelTemplateId).toBe(orgDefault);
  expect(forMilk.body.defaultSource).toBe("organization");
  expect(forMilk.body.items.map((item: { id: string }) => item.id)).toEqual([orgDefault]);

  // Legacy stations send no product: every enabled template, org default first.
  const legacy = await request(server)
    .get("/shifts/box-label-templates")
    .set("x-api-key", device.apiKey)
    .expect(200);
  const legacyIds = legacy.body.items.map((item: { id: string }) => item.id);
  expect(legacyIds[0]).toBe(orgDefault);
  expect(legacyIds).toContain(beerOnly);
  expect(legacyIds).not.toContain(disabled);

  await request(server)
    .get(`/shifts/box-label-templates?productId=${randomUUID()}`)
    .set("x-api-key", device.apiKey)
    .expect(404);
});
```

Также в существующем тесте `"serves spec-free box-template summaries to a station key with the default first"` (строки ~1674–1708) `toEqual` первого элемента останется верным: сводка станции не получает новых полей.

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/shifts.e2e.test.ts -t "box template|box-template|editable"`
Expected: новые тесты FAIL.

- [ ] **Step 3: DTO**

В `apps/api/src/modules/shifts/dto.ts` импортировать тип `BoxLabelTemplateDefaultSource` из `@markiro/domain` и заменить блок строк 188–214:

```ts
export const boxLabelTemplateProductQuerySchema = z.object({
  /** Resolves the default (and, for the picker, the eligible list) for this product's ЧЗ category. */
  productId: z.string().uuid().optional(),
});
export type BoxLabelTemplateProductQueryDto = z.infer<typeof boxLabelTemplateProductQuerySchema>;

/** GET /shifts/planning-config response — the operations-readable planning subset only. */
export interface ShiftPlanningConfigDto {
  defaultBoxLabelTemplateId: string | null;
  /** Which default answered: the product's category, the organisation, or none. */
  defaultSource: BoxLabelTemplateDefaultSource | null;
}

/**
 * Box-template summary exposed to station credentials. Deliberately excludes
 * the template `spec` and its selection metadata: the station only ever
 * receives a spec through the shift bundle after the shift snapshot exists,
 * and eligibility is already applied server-side.
 */
export interface ShiftBoxLabelTemplateOptionDto {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  dpi: LabelTemplateSpec["dpi"];
  language: LabelTemplateSpec["language"];
}

/**
 * GET /shifts/box-label-templates response. With `productId` only templates
 * eligible for that product's category are listed. The resolved default
 * (when set) is the first item; the rest follow ordered by name.
 */
export interface ShiftBoxLabelTemplatesDto {
  items: ShiftBoxLabelTemplateOptionDto[];
  defaultBoxLabelTemplateId: string | null;
  defaultSource: BoxLabelTemplateDefaultSource | null;
}
```

В OpenAPI-схемах (строки 343–373) добавить константу и поле:

```ts
const defaultSourceOpenApiSchema = {
  type: "string",
  enum: ["category", "organization"],
  nullable: true,
} as const;
```

в `shiftPlanningConfigOpenApiSchema`: `required: ["defaultBoxLabelTemplateId", "defaultSource"]`, `properties.defaultSource: defaultSourceOpenApiSchema`; в `shiftBoxLabelTemplatesOpenApiSchema`: `required: ["items", "defaultBoxLabelTemplateId", "defaultSource"]`, `properties.defaultSource: defaultSourceOpenApiSchema`.

Найти в `dto.ts` описание кодов 422 для создания смены (grep `BOX_LABEL_TEMPLATE_REQUIRED`): если коды перечислены enum-ом в OpenAPI-схеме ошибки, добавить `"BOX_LABEL_TEMPLATE_NOT_ELIGIBLE"` рядом.

- [ ] **Step 4: Контроллер**

В `shifts.controller.ts` (импорты `Query` и `ZodValidationPipe` уже есть; `ApiZodQuery` уже импортирован из `../../lib/openapi`) добавить `boxLabelTemplateProductQuerySchema`, `type BoxLabelTemplateProductQueryDto` в импорт из `./dto` и заменить два роута:

```ts
  @Get("planning-config")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Read the shift planning configuration",
    description:
      "With `productId`, the box-template default is resolved for that product's category (category default, then organisation default).",
  })
  @ApiCabinetAuth()
  @ApiZodQuery(boxLabelTemplateProductQuerySchema)
  @ApiOkResponse({ schema: shiftPlanningConfigOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  async getPlanningConfig(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(boxLabelTemplateProductQuerySchema))
    query: BoxLabelTemplateProductQueryDto,
  ): Promise<ShiftPlanningConfigDto> {
    return this.shiftsService.getPlanningConfig(req.tenantId!, query.productId);
  }

  // Station-readable template summaries for the NewShift picker. Specs stay
  // cabinet-only; the station receives a spec exclusively through the shift
  // bundle after the snapshot exists (see docs/device-key-surface.md).
  @Get("box-label-templates")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "List box label template options",
    description:
      "Template summaries only; a station receives a template spec exclusively through the shift bundle. " +
      "With `productId` only templates eligible for that product's category are returned; without it, every enabled template.",
  })
  @ApiCabinetOrStationAuth()
  @ApiZodQuery(boxLabelTemplateProductQuerySchema)
  @ApiOkResponse({ schema: shiftBoxLabelTemplatesOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 429)
  async listBoxLabelTemplates(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(boxLabelTemplateProductQuerySchema))
    query: BoxLabelTemplateProductQueryDto,
  ): Promise<ShiftBoxLabelTemplatesDto> {
    return this.shiftsService.listBoxLabelTemplates(req.tenantId!, query.productId);
  }
```

- [ ] **Step 5: Сервис**

В `shifts.service.ts` добавить импорты:

```ts
import { isBoxLabelTemplateEligible } from "@markiro/domain";
import {
  findLabelTemplateEligibility,
  resolveDefaultBoxLabelTemplate,
} from "../label-templates/box-label-template-eligibility";
```

Заменить `getPlanningConfig` и `listBoxLabelTemplates` (строки 218–248):

```ts
  /** The one organisation setting needed by operations shift planning, resolved for a product when given. */
  async getPlanningConfig(tenantId: string, productId?: string): Promise<ShiftPlanningConfigDto> {
    const chzProductGroupCode = await this.productGroupCodeForPicker(tenantId, productId);
    const resolved = await resolveDefaultBoxLabelTemplate(this.db, tenantId, chzProductGroupCode);
    return { defaultBoxLabelTemplateId: resolved.templateId, defaultSource: resolved.source };
  }

  async listBoxLabelTemplates(
    tenantId: string,
    productId?: string,
  ): Promise<ShiftBoxLabelTemplatesDto> {
    const chzProductGroupCode = await this.productGroupCodeForPicker(tenantId, productId);
    const resolved = await resolveDefaultBoxLabelTemplate(this.db, tenantId, chzProductGroupCode);
    const rows = await this.db
      .select({
        id: schema.labelTemplates.id,
        name: schema.labelTemplates.name,
        spec: schema.labelTemplates.spec,
        enabled: schema.labelTemplates.enabled,
        chzProductGroupCodes: schema.labelTemplates.chzProductGroupCodes,
      })
      .from(schema.labelTemplates)
      .where(and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.enabled, true)))
      .orderBy(schema.labelTemplates.name, schema.labelTemplates.id);
    const items = rows
      // Without a product every enabled template is offered (legacy stations);
      // with one, only templates covering its category.
      .filter((row) => productId === undefined || isBoxLabelTemplateEligible(row, chzProductGroupCode))
      .map((row): ShiftBoxLabelTemplateOptionDto => {
        const spec = row.spec as LabelTemplateSpec;
        return {
          id: row.id,
          name: row.name,
          widthMm: spec.widthMm,
          heightMm: spec.heightMm,
          dpi: spec.dpi,
          language: spec.language,
        };
      });
    // Default first so the preselected option is on the station's first page.
    items.sort((a, b) =>
      a.id === resolved.templateId ? -1 : b.id === resolved.templateId ? 1 : 0,
    );
    return {
      items,
      defaultBoxLabelTemplateId: resolved.templateId,
      defaultSource: resolved.source,
    };
  }

  /** `null` without a product (organisation-level answer); 404 for a product outside the tenant. */
  private async productGroupCodeForPicker(
    tenantId: string,
    productId: string | undefined,
  ): Promise<number | null> {
    if (productId === undefined) return null;
    const product = await this.findProductRow(tenantId, productId);
    if (!product) throw new NotFoundException("Unknown product for this organization");
    return product.chzProductGroupCode ?? null;
  }

  private async assertBoxTemplateEligible(
    tenantId: string,
    templateId: string,
    chzProductGroupCode: number | null,
  ): Promise<void> {
    const template = await findLabelTemplateEligibility(this.db, tenantId, templateId);
    if (!template || !isBoxLabelTemplateEligible(template, chzProductGroupCode)) {
      throw new UnprocessableEntityException({
        code: "BOX_LABEL_TEMPLATE_NOT_ELIGIBLE",
        message: "Box label template is unknown, disabled, or does not apply to the product's category",
      });
    }
  }
```

(`NotFoundException` и `UnprocessableEntityException` уже импортированы из `@nestjs/common`; проверить.)

В `createShift` заменить разрешение шаблона (строки 480–483):

```ts
const chzProductGroupCode = product.chzProductGroupCode ?? null;
let boxLabelTemplateId: string | null;
if (data.boxLabelTemplateId === undefined) {
  boxLabelTemplateId = (
    await resolveDefaultBoxLabelTemplate(this.db, tenantId, chzProductGroupCode)
  ).templateId;
} else {
  boxLabelTemplateId = data.boxLabelTemplateId;
  if (boxLabelTemplateId !== null) {
    await this.assertBoxTemplateEligible(tenantId, boxLabelTemplateId, chzProductGroupCode);
  }
}
```

В `updateShift` после вычисления `boxLabelTemplateId` (строки 730–733) и перед `assertBoxTemplateRule` добавить:

```ts
if (
  data.boxLabelTemplateId !== undefined &&
  data.boxLabelTemplateId !== null &&
  data.boxLabelTemplateId !== current.boxLabelTemplateId
) {
  const product = await this.findProductRow(tenantId, current.productId);
  await this.assertBoxTemplateEligible(
    tenantId,
    data.boxLabelTemplateId,
    product?.chzProductGroupCode ?? null,
  );
}
```

Убедиться, что `current` в `updateShift` содержит `productId` (select всей строки `schema.shifts` — да; если select проекционный, добавить колонку). Метод `findDefaultBoxLabelTemplateId` (строки 1222–1228) удалить, если больше не используется (проверить `grep -n findDefaultBoxLabelTemplateId`).

- [ ] **Step 6: Запустить тесты модуля смен и OpenAPI**

Run:

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/shifts.e2e.test.ts test/shifts.service.test.ts test/shifts.controller.test.ts test/shifts-openapi.test.ts test/shifts-bundle.e2e.test.ts test/openapi-docs.test.ts test/subscription-route-inventory.test.ts test/cors-station-surface.test.ts
pnpm --filter @markiro/api typecheck
```

Expected: PASS. `shifts.service.test.ts` (юнит с моками) может ожидать `getPlanningConfig(tenantId)` без второго аргумента и старую форму ответа: дополнить ожидания полем `defaultSource` и моками для `orgBoxLabelTemplateDefaults`, не удаляя проверки.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shifts apps/api/test/shifts.e2e.test.ts apps/api/test/shifts.service.test.ts
git commit -m "feat(api): resolve box label defaults per product category and filter station template options

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: API инвентаризаций: 422 на непригодный явный шаблон

**Files:**

- Modify: `apps/api/src/modules/inventories/inventories.service.ts:734-797,403-457`
- Modify: `apps/api/src/modules/inventories/dto.ts` (перечисление кодов 422, если есть)
- Test: `apps/api/test/inventories.e2e.test.ts`

**Interfaces:**

- Consumes: `findLabelTemplateEligibility` (Task 3), `isBoxLabelTemplateEligible` (Task 2).
- Produces: `POST /inventories`, `PATCH /inventories/:id` → 422 `{ code: "INVENTORY_BOX_LABEL_TEMPLATE_NOT_ELIGIBLE" }` когда явный шаблон выключен или не покрывает категорию товара; на PATCH только при смене шаблона.

- [ ] **Step 1: Написать падающие e2e-тесты**

В `apps/api/test/inventories.e2e.test.ts` рядом с `seedTemplate` добавить:

```ts
async function seedScopedTemplate(
  tenantId: string,
  scope: { enabled?: boolean; chzProductGroupCodes?: number[] | null },
): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.labelTemplates).values({
    id,
    tenantId,
    name: "Scoped",
    spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
    enabled: scope.enabled ?? true,
    chzProductGroupCodes: scope.chzProductGroupCodes ?? null,
  });
  return id;
}
```

Проверить, какой `chzProductGroupCode` ставит локальный `seedProduct` (grep в файле); ниже предполагается, что можно передать override. Тесты:

```ts
it("rejects a repack template that is disabled or scoped to another category", async () => {
  const agent = request.agent(app!.getHttpServer());
  const { tenantId, productId, lineId } = await seedPreparation(agent, { mode: "repack" });
  const disabled = await seedScopedTemplate(tenantId, { enabled: false });
  const disabledRes = await agent
    .post("/inventories")
    .send(createBody(productId, lineId, "repack", disabled))
    .expect(422);
  expect(disabledRes.body.code).toBe("INVENTORY_BOX_LABEL_TEMPLATE_NOT_ELIGIBLE");

  const beerOnly = await seedScopedTemplate(tenantId, { chzProductGroupCodes: [15] });
  await db
    .update(schema.products)
    .set({ chzProductGroupCode: 8 })
    .where(eq(schema.products.id, productId));
  await agent
    .post("/inventories")
    .send(createBody(productId, lineId, "repack", beerOnly))
    .expect(422);
});

it("keeps an inventory editable after its template was disabled, but blocks switching to an ineligible one", async () => {
  const agent = request.agent(app!.getHttpServer());
  const { tenantId, productId, lineId, templateId } = await seedPreparation(agent, {
    mode: "repack",
  });
  const inventory = await createInventory(agent, productId, lineId, "repack", templateId);
  await db
    .update(schema.labelTemplates)
    .set({ enabled: false })
    .where(eq(schema.labelTemplates.id, templateId!));

  await agent
    .patch(`/inventories/${inventory.id}`)
    .send({ productionDateTo: "2026-08-30", boxLabelTemplateId: templateId })
    .expect(200);

  const other = await seedScopedTemplate(tenantId, { enabled: false });
  const blocked = await agent
    .patch(`/inventories/${inventory.id}`)
    .send({ boxLabelTemplateId: other })
    .expect(422);
  expect(blocked.body.code).toBe("INVENTORY_BOX_LABEL_TEMPLATE_NOT_ELIGIBLE");
});
```

Если `setDefaultTemplate` в `seedPreparation` делает шаблон дефолтом организации, прямое `db.update … enabled=false` всё равно работает (это обход API намеренно, чтобы получить «историческую» смену); при желании перед этим сбросить дефолт через `setDefaultTemplate(tenantId, null)`.

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/inventories.e2e.test.ts -t "ineligible|scoped to another"`
Expected: FAIL.

- [ ] **Step 3: Сервис**

В `inventories.service.ts` добавить импорты:

```ts
import { isBoxLabelTemplateEligible } from "@markiro/domain";
import { findLabelTemplateEligibility } from "../label-templates/box-label-template-eligibility";
```

Изменить сигнатуру `resolveParameters`, добавив четвёртый параметр:

```ts
  private async resolveParameters(
    tx: InventoryTx,
    tenantId: string,
    input: {
      productId: string;
      lineId: string;
      mode: InventoryMode;
      productionDateFrom: string;
      productionDateTo: string;
      boxLabelTemplateId: string | null;
    },
    options: { currentBoxLabelTemplateId: string | null } = { currentBoxLabelTemplateId: null },
  ) {
```

В выборке товара добавить `chzProductGroupCode: schema.products.chzProductGroupCode`. Заменить блок проверки шаблона (`if (input.boxLabelTemplateId !== null) { … }`):

```ts
if (input.boxLabelTemplateId !== null) {
  const template = await findLabelTemplateEligibility(
    tx,
    tenantId,
    input.boxLabelTemplateId,
    "share",
  );
  if (!template) {
    throw new UnprocessableEntityException({
      code: "INVENTORY_BOX_LABEL_TEMPLATE_INVALID",
    });
  }
  // An inventory keeps its snapshot even after the template is disabled or
  // scoped away; eligibility is enforced only when the template changes.
  const changed = input.boxLabelTemplateId !== options.currentBoxLabelTemplateId;
  if (changed && !isBoxLabelTemplateEligible(template, product.chzProductGroupCode ?? null)) {
    throw new UnprocessableEntityException({
      code: "INVENTORY_BOX_LABEL_TEMPLATE_NOT_ELIGIBLE",
    });
  }
}
```

В `update` вызов заменить на:

```ts
const resolved = await this.resolveParameters(tx, tenantId, desired, {
  currentBoxLabelTemplateId: current.boxLabelTemplateId,
});
```

Вызов в `create` не меняется (значение по умолчанию `null`).

Запустить `grep -rn "INVENTORY_BOX_LABEL_TEMPLATE_INVALID" apps/api/src/modules/inventories` и в каждом перечислении кодов ошибок (OpenAPI enum, union-тип) добавить `INVENTORY_BOX_LABEL_TEMPLATE_NOT_ELIGIBLE` рядом.

- [ ] **Step 4: Запустить тесты**

Run:

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/inventories.e2e.test.ts test/inventories-openapi.test.ts test/inventory-lifecycle.e2e.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/inventories apps/api/test/inventories.e2e.test.ts
git commit -m "feat(api): enforce box label template eligibility on inventories

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Админка: API-слой шаблонов, подписи области, библиотека с фильтром и переключателем

**Files:**

- Modify: `apps/admin/src/pages/labels/api.ts`
- Modify: `apps/admin/src/pages/catalog/api.ts:189-196`
- Create: `apps/admin/src/pages/labels/scope.ts`
- Modify: `apps/admin/src/pages/labels/index.tsx`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json` (объект `pages.labels`)
- Test: `apps/admin/test/labels-library.test.tsx`, `apps/admin/test/labels-scope.test.ts`

**Interfaces:**

- Consumes: HTTP из Task 3.
- Produces:
  - `LabelTemplateSummaryDto`/`LabelTemplateDto` с `enabled: boolean`, `chzProductGroupCodes: number[] | null`; `CreateLabelTemplateInput` с опциональными `enabled`, `chzProductGroupCodes`.
  - `useLabelTemplates(params?: { enabled?: "true" | "false" | "all" })`.
  - `useChzProductGroups(options?: { enabled?: boolean })`.
  - `describeTemplateScope(codes, groups, t): { label: string; title: string | null }`, `describeDefaultConflict(details, groups, t): string` в `scope.ts`.

- [ ] **Step 1: Написать падающий юнит-тест для `scope.ts`**

`apps/admin/test/labels-scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import i18n from "../src/i18n/index.js";
import { describeDefaultConflict, describeTemplateScope } from "../src/pages/labels/scope.js";

const GROUPS = [
  { code: 8, alias: "milk", name: "Молочная продукция" },
  { code: 15, alias: "beer", name: "Пиво" },
  { code: 22, alias: "nabeer", name: "Безалкогольное пиво" },
];

describe("describeTemplateScope", () => {
  it("names universal scope, lists up to two categories, counts three or more", () => {
    const t = i18n.getFixedT("ru");
    expect(describeTemplateScope(null, GROUPS, t)).toEqual({ label: "Все категории", title: null });
    expect(describeTemplateScope([15, 8], GROUPS, t)).toEqual({
      label: "Пиво, Молочная продукция",
      title: null,
    });
    expect(describeTemplateScope([15, 8, 22], GROUPS, t)).toEqual({
      label: "Категорий: 3",
      title: "Пиво, Молочная продукция, Безалкогольное пиво",
    });
    expect(describeTemplateScope([999], GROUPS, t).label).toBe("999");
  });
});

describe("describeDefaultConflict", () => {
  it("explains which defaults block the change", () => {
    const t = i18n.getFixedT("ru");
    expect(
      describeDefaultConflict({ organizationDefault: true, categoryDefaults: [15] }, GROUPS, t),
    ).toBe(
      "Шаблон назначен дефолтом организации. Шаблон назначен дефолтом категорий: Пиво. Сначала выберите другой шаблон в настройках организации.",
    );
    expect(describeDefaultConflict(null, GROUPS, t)).toBe(
      "Сначала выберите другой шаблон в настройках организации.",
    );
  });
});
```

Проверить, как `apps/admin/test/setup.ts` инициализирует i18n (импорт `../src/i18n/index.js` и язык `ru` по умолчанию); если экспорт по умолчанию называется иначе, поправить импорт в тесте.

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `pnpm --filter @markiro/admin exec vitest run test/labels-scope.test.ts`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: i18n-ключи**

В `apps/admin/src/i18n/ru.json` в объект `pages.labels` (перед `"editor"`) добавить:

```json
    "filterLabel": "Показывать",
    "filterAll": "Все",
    "filterEnabled": "Включённые",
    "filterDisabled": "Выключенные",
    "filterEmpty": "Нет шаблонов с таким состоянием.",
    "disabledBadge": "Выключен",
    "scopeAll": "Все категории",
    "scopeCount": "Категорий: {{count}}",
    "enableAction": "Включить",
    "disableAction": "Выключить",
    "toasts": {
      "enableSuccess": "Шаблон включён",
      "disableSuccess": "Шаблон выключен",
      "toggleError": "Не удалось изменить состояние шаблона"
    },
    "defaultConflict": {
      "organization": "Шаблон назначен дефолтом организации.",
      "categories": "Шаблон назначен дефолтом категорий: {{categories}}.",
      "hint": "Сначала выберите другой шаблон в настройках организации."
    },
```

В `apps/admin/src/i18n/en.json` те же ключи:

```json
    "filterLabel": "Show",
    "filterAll": "All",
    "filterEnabled": "Enabled",
    "filterDisabled": "Disabled",
    "filterEmpty": "No templates in this state.",
    "disabledBadge": "Disabled",
    "scopeAll": "All categories",
    "scopeCount": "Categories: {{count}}",
    "enableAction": "Enable",
    "disableAction": "Disable",
    "toasts": {
      "enableSuccess": "Template enabled",
      "disableSuccess": "Template disabled",
      "toggleError": "Could not change the template state"
    },
    "defaultConflict": {
      "organization": "The template is the organisation default.",
      "categories": "The template is the default for categories: {{categories}}.",
      "hint": "Pick another template in the organisation settings first."
    },
```

- [ ] **Step 4: `scope.ts`**

`apps/admin/src/pages/labels/scope.ts`:

```ts
import type { TFunction } from "i18next";

import type { ChzProductGroupDto } from "../catalog/api.js";

/** Human label for a template's product-group scope; `title` carries the full list when it is abbreviated. */
export function describeTemplateScope(
  codes: readonly number[] | null,
  groups: readonly ChzProductGroupDto[],
  t: TFunction,
): { label: string; title: string | null } {
  if (codes === null) return { label: t("pages.labels.scopeAll"), title: null };
  const names = codes.map(
    (code) => groups.find((group) => group.code === code)?.name ?? String(code),
  );
  const full = names.join(", ");
  if (names.length <= 2) return { label: full, title: null };
  return { label: t("pages.labels.scopeCount", { count: names.length }), title: full };
}

/** Text for the 409 `LABEL_TEMPLATE_IS_DEFAULT` body (`ApiRequestError.details`). */
export function describeDefaultConflict(
  details: unknown,
  groups: readonly ChzProductGroupDto[],
  t: TFunction,
): string {
  const body =
    details && typeof details === "object"
      ? (details as { organizationDefault?: unknown; categoryDefaults?: unknown })
      : {};
  const parts: string[] = [];
  if (body.organizationDefault === true) parts.push(t("pages.labels.defaultConflict.organization"));
  const codes = Array.isArray(body.categoryDefaults)
    ? body.categoryDefaults.filter((code): code is number => typeof code === "number")
    : [];
  if (codes.length > 0) {
    parts.push(
      t("pages.labels.defaultConflict.categories", {
        categories: codes
          .map((code) => groups.find((group) => group.code === code)?.name ?? String(code))
          .join(", "),
      }),
    );
  }
  parts.push(t("pages.labels.defaultConflict.hint"));
  return parts.join(" ");
}
```

Run: `pnpm --filter @markiro/admin exec vitest run test/labels-scope.test.ts` → PASS.

- [ ] **Step 5: `labels/api.ts` и `useChzProductGroups`**

В `apps/admin/src/pages/labels/api.ts`:

```ts
export interface LabelTemplateSummaryDto {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  dpi: 203 | 300;
  language: "zpl" | "tspl";
  enabled: boolean;
  /** `null` means every category; otherwise ЧЗ product-group codes. */
  chzProductGroupCodes: number[] | null;
  updatedAt: string;
}

export interface LabelTemplateDto {
  id: string;
  name: string;
  spec: LabelTemplateSpec;
  enabled: boolean;
  chzProductGroupCodes: number[] | null;
  createdAt: string;
  updatedAt: string;
}

export type LabelTemplateEnabledFilter = "true" | "false" | "all";

export interface ListLabelTemplatesParams {
  /** Omitted = enabled only (the API default), which is what every picker wants. */
  enabled?: LabelTemplateEnabledFilter;
}

async function fetchLabelTemplates(
  params: ListLabelTemplatesParams,
): Promise<LabelTemplateSummaryDto[]> {
  const search = new URLSearchParams();
  if (params.enabled !== undefined) search.set("enabled", params.enabled);
  const query = search.toString();
  const response = await apiFetch<ListLabelTemplatesResponse>(
    `/label-templates${query ? `?${query}` : ""}`,
  );
  return response.items;
}

export interface CreateLabelTemplateInput {
  name: string;
  spec: LabelTemplateSpec;
  enabled?: boolean;
  chzProductGroupCodes?: number[] | null;
}

export function useLabelTemplates(
  params: ListLabelTemplatesParams = {},
): UseQueryResult<LabelTemplateSummaryDto[]> {
  return useQuery({
    queryKey: [...LABEL_TEMPLATES_QUERY_KEY, "list", params],
    queryFn: () => fetchLabelTemplates(params),
  });
}
```

(`UpdateLabelTemplateInput = Partial<CreateLabelTemplateInput>` остаётся; инвалидация по префиксу `LABEL_TEMPLATES_QUERY_KEY` покрывает новый ключ.)

В `apps/admin/src/pages/catalog/api.ts` заменить `useChzProductGroups`:

```ts
/** `GET /chz-product-groups` -- global reference data, safe to cache for the session. */
export function useChzProductGroups(
  options: { enabled?: boolean } = {},
): UseQueryResult<ChzProductGroupDto[]> {
  return useQuery({
    queryKey: CHZ_PRODUCT_GROUPS_QUERY_KEY,
    queryFn: fetchChzProductGroups,
    staleTime: Infinity,
    enabled: options.enabled ?? true,
  });
}
```

- [ ] **Step 6: Написать падающие тесты библиотеки**

В `apps/admin/test/labels-library.test.tsx`:

1. В фикстуры `BOX_SUMMARY` и `UNIT_SUMMARY` добавить `enabled: true, chzProductGroupCodes: null`; добавить третью:

```ts
const BEER_SUMMARY = {
  id: "tpl-3",
  name: "Пиво 58×40",
  widthMm: 58,
  heightMm: 40,
  dpi: 203 as const,
  language: "zpl" as const,
  enabled: false,
  chzProductGroupCodes: [15] as number[] | null,
  updatedAt: "2026-07-03T00:00:00.000Z",
};
```

2. В `stubFetch` заменить первое условие на `if (url === "/api/label-templates?enabled=all")` и добавить перед `throw`:

```ts
if (url === "/api/chz-product-groups") {
  return jsonResponse(200, { items: [{ code: 15, alias: "beer", name: "Пиво" }] });
}
if (/^\/api\/label-templates\/[^/?]+$/.test(url) && init?.method === "PATCH") {
  const body = JSON.parse(init.body as string) as { enabled?: boolean };
  const id = url.slice("/api/label-templates/".length);
  const summary = items.find((item) => item.id === id);
  if (!summary) return jsonResponse(404, { message: "Not found" });
  return jsonResponse(200, {
    ...summary,
    spec: SAMPLE_SPEC,
    enabled: body.enabled ?? summary.enabled,
  });
}
```

(сигнатуру мока расширить до `async (url: string, init?: RequestInit)`, тип `items` — до объединения трёх фикстур).

3. Добавить тесты:

```ts
it("shows scope and disabled badges and filters by state", async () => {
  vi.stubGlobal("fetch", stubFetch([BOX_SUMMARY, BEER_SUMMARY]));
  renderPage();
  await screen.findByText("Короб 100×100 v3");
  expect(screen.getAllByText("Все категории")).toHaveLength(1);
  expect(await screen.findByText("Пиво")).toBeDefined();
  expect(screen.getByText("Выключен")).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Выключенные" }));
  expect(screen.queryByText("Короб 100×100 v3")).toBeNull();
  expect(screen.getByText("Пиво 58×40")).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Включённые" }));
  expect(screen.getByText("Короб 100×100 v3")).toBeDefined();
  expect(screen.queryByText("Пиво 58×40")).toBeNull();
});

it("toggles a template from the card and reports a default conflict", async () => {
  const fetchMock = stubFetch([BOX_SUMMARY, BEER_SUMMARY]);
  vi.stubGlobal("fetch", fetchMock);
  renderPage();
  await screen.findByText("Пиво 58×40");
  fireEvent.click(screen.getByRole("button", { name: "Включить" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/label-templates/tpl-3",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: true }) }),
    ),
  );
  expect(await screen.findByText("Шаблон включён")).toBeDefined();

  // A 409 on disable explains where the template is a default.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/label-templates/tpl-1" && init?.method === "PATCH") {
        return jsonResponse(409, {
          code: "LABEL_TEMPLATE_IS_DEFAULT",
          message: "default",
          organizationDefault: true,
          categoryDefaults: [15],
        });
      }
      return fetchMock(url, init);
    }),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Выключить" })[0]!);
  expect(
    await screen.findByText(
      "Шаблон назначен дефолтом организации. Шаблон назначен дефолтом категорий: Пиво. Сначала выберите другой шаблон в настройках организации.",
    ),
  ).toBeDefined();
});

it("hides the toggle from read-only users", async () => {
  vi.stubGlobal("fetch", stubFetch([BOX_SUMMARY]));
  renderPage(OPERATIONS_READ_ONLY);
  await screen.findByText("Короб 100×100 v3");
  expect(screen.queryByRole("button", { name: "Выключить" })).toBeNull();
});
```

Добавить `fireEvent`, `waitFor` в импорт из `@testing-library/react`. Существующие проверки, что карточка это ссылка на `/labels/tpl-1`, сохранить: ссылка остаётся на миниатюре и имени.

Run: `pnpm --filter @markiro/admin exec vitest run test/labels-library.test.tsx` → новые тесты FAIL, старые могут упасть на URL `?enabled=all` — это ожидаемо до шага 7.

- [ ] **Step 7: Библиотека `apps/admin/src/pages/labels/index.tsx`**

Импорты: добавить `useState` из `react`, `Button` из `@markiro/ui`, `ApiRequestError` из `../../api/client.js`, `toast` из `../../lib/toast.js`, `useChzProductGroups` из `../catalog/api.js`, `useUpdateLabelTemplate` из `./api.js`, `describeDefaultConflict, describeTemplateScope` из `./scope.js`, и тип `ChzProductGroupDto` из `../catalog/api.js`.

Заменить `TemplateCard` и тело страницы:

```tsx
type LibraryFilter = "all" | "enabled" | "disabled";

const FILTERS: LibraryFilter[] = ["all", "enabled", "disabled"];

function TemplateCard({
  item,
  groups,
  canWrite,
}: {
  item: LabelTemplateSummaryDto;
  groups: ChzProductGroupDto[];
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const update = useUpdateLabelTemplate();
  const scope = describeTemplateScope(item.chzProductGroupCodes, groups, t);

  async function toggle(): Promise<void> {
    const enabled = !item.enabled;
    try {
      await update.mutateAsync({ id: item.id, input: { enabled } });
      toast(
        "ok",
        t(enabled ? "pages.labels.toasts.enableSuccess" : "pages.labels.toasts.disableSuccess"),
      );
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "LABEL_TEMPLATE_IS_DEFAULT") {
        toast("error", describeDefaultConflict(error.details, groups, t), 8000);
        return;
      }
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.labels.toasts.toggleError"),
      );
    }
  }

  // The card is a <div>; only the thumbnail + name are the link, so the
  // toggle <button> never nests inside an <a>.
  const body = (
    <>
      <TemplateThumb id={item.id} widthMm={item.widthMm} heightMm={item.heightMm} />
      <span style={{ font: "600 14px/20px var(--font-ui)", color: "var(--fg-1)" }}>
        {item.name}
      </span>
    </>
  );

  return (
    <div style={CARD_STYLE}>
      {canWrite ? (
        <Link
          to={`/labels/${item.id}`}
          style={{ ...CARD_LINK_STYLE, display: "flex", flexDirection: "column", gap: 12 }}
        >
          {body}
        </Link>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{body}</div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Badge>
          {t("pages.labels.sizeBadge", {
            width: item.widthMm.toFixed(1),
            height: item.heightMm.toFixed(1),
          })}
        </Badge>
        <Badge>{t("pages.labels.dpiBadge", { dpi: item.dpi })}</Badge>
        <Badge {...(scope.title ? { title: scope.title } : {})}>{scope.label}</Badge>
        {item.enabled ? null : <Badge tone="neutral">{t("pages.labels.disabledBadge")}</Badge>}
      </div>
      {canWrite ? (
        <Button
          type="button"
          variant="secondary"
          loading={update.isPending}
          onClick={() => void toggle()}
        >
          {t(item.enabled ? "pages.labels.disableAction" : "pages.labels.enableAction")}
        </Button>
      ) : null}
    </div>
  );
}

export function LabelTemplatesPage() {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const { data, isPending, isError } = useLabelTemplates({ enabled: "all" });
  const groupsQuery = useChzProductGroups();
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const items = data ?? [];
  const groups = groupsQuery.data ?? [];
  const visible = items.filter((item) =>
    filter === "all" ? true : filter === "enabled" ? item.enabled : !item.enabled,
  );

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.labels.title")}
        actions={
          canWrite ? (
            <Link to="/labels/new" style={PRIMARY_LINK_STYLE}>
              {t("pages.labels.addAction")}
            </Link>
          ) : null
        }
      />

      {isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState
          title={t("pages.labels.emptyTitle")}
          hint={t("pages.labels.emptyHint")}
          action={
            canWrite ? (
              <Link to="/labels/new" style={PRIMARY_LINK_STYLE}>
                {t("pages.labels.addAction")}
              </Link>
            ) : null
          }
        />
      ) : (
        <>
          <div
            role="group"
            aria-label={t("pages.labels.filterLabel")}
            style={{ display: "flex", gap: 8 }}
          >
            {FILTERS.map((value) => (
              <Button
                key={value}
                type="button"
                variant={filter === value ? "primary" : "secondary"}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {t(
                  value === "all"
                    ? "pages.labels.filterAll"
                    : value === "enabled"
                      ? "pages.labels.filterEnabled"
                      : "pages.labels.filterDisabled",
                )}
              </Button>
            ))}
          </div>
          {visible.length === 0 ? (
            <Alert tone="info">{t("pages.labels.filterEmpty")}</Alert>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                gap: 16,
              }}
            >
              {visible.map((item) => (
                <TemplateCard key={item.id} item={item} groups={groups} canWrite={canWrite} />
              ))}
              {canWrite ? (
                <Link to="/labels/new" style={NEW_TEMPLATE_CARD_STYLE}>
                  {t("pages.labels.newTemplateCard")}
                </Link>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

Сверить имена `variant` у `Button` в `packages/ui/src/components/Button.tsx` (`"primary" | "secondary" | …`) и подставить существующие. Если `Badge` не пропускает `title`, использовать обёртку `<span title={…}>`.

- [ ] **Step 8: Запустить тесты, типы, линт**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/labels-library.test.tsx test/labels-scope.test.ts test/i18n.test.tsx
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
```

Expected: PASS. Typecheck укажет остальные места, где создаются `LabelTemplateSummaryDto` вручную (тесты других страниц): временно они не компилируются как тесты, а не как `src`; исправлять их в задачах 9–11, где они меняются по существу. Если `typecheck` включает `test/`, добавить `enabled: true, chzProductGroupCodes: null` в фикстуры сразу.

- [ ] **Step 9: Commit**

```bash
git add apps/admin/src/pages/labels/api.ts apps/admin/src/pages/labels/scope.ts apps/admin/src/pages/labels/index.tsx apps/admin/src/pages/catalog/api.ts apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/labels-library.test.tsx apps/admin/test/labels-scope.test.ts
git commit -m "feat(admin): label library filter, scope badges and enable toggle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Админка: редактор — флаг, область применения, подсказка ЕГАИС

**Files:**

- Modify: `apps/admin/src/pages/labels/editor/index.tsx:99-203,291-315,387-487`
- Modify: `apps/admin/src/pages/labels/editor/editor.css`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json` (`pages.labels.editor`)
- Test: `apps/admin/test/labels-editor.test.tsx`

**Interfaces:**

- Consumes: `LabelTemplateDto.enabled/chzProductGroupCodes`, `useChzProductGroups({ enabled })`, `describeDefaultConflict` (Task 7); `labelTemplateUsesField`, `EGAIS_PRODUCT_GROUP_CODE` (Task 2).
- Produces: POST/PATCH из редактора всегда несут `enabled` и `chzProductGroupCodes`.

- [ ] **Step 1: i18n-ключи**

В `pages.labels.editor` (ru):

```json
    "enabledLabel": "Включён",
    "enabledHint": "Выключенный шаблон не предлагается при создании смен и инвентаризаций.",
    "scopeTitle": "Область применения",
    "scopeAll": "Все категории",
    "scopeSelected": "Только выбранные категории",
    "scopeSearch": "Поиск категории",
    "scopeEmptyError": "Выберите хотя бы одну категорию или переключитесь на «Все категории».",
    "scopeLoadError": "Не удалось загрузить справочник категорий.",
    "egaisScopeHint": "Поле ЕГАИС заполняется только для товаров категории «Пиво». На выбранных категориях оно будет пустым.",
```

(en):

```json
    "enabledLabel": "Enabled",
    "enabledHint": "A disabled template is not offered when creating shifts and inventories.",
    "scopeTitle": "Applies to",
    "scopeAll": "All categories",
    "scopeSelected": "Selected categories only",
    "scopeSearch": "Search category",
    "scopeEmptyError": "Select at least one category or switch to “All categories”.",
    "scopeLoadError": "Could not load the category dictionary.",
    "egaisScopeHint": "The EGAIS field is filled only for products in the “Beer” category. It will be empty for the selected categories.",
```

- [ ] **Step 2: Написать падающие тесты редактора**

В `apps/admin/test/labels-editor.test.tsx`:

1. `stubCreateFetch` и edit-мок (строки ~212–225, ~679–699): в ответы GET добавить `enabled: true, chzProductGroupCodes: null`; добавить ветку

```ts
if (url === "/api/chz-product-groups") {
  return jsonResponse(200, {
    items: [
      { code: 8, alias: "milk", name: "Молочная продукция" },
      { code: 15, alias: "beer", name: "Пиво" },
    ],
  });
}
```

2. Там, где тесты сравнивают тело POST/PATCH целиком через `toEqual`, дополнить ожидание `enabled: true, chzProductGroupCodes: null` (по умолчанию редактор отправляет оба поля).

3. Новые тесты (рядом с edit-flow тестом, используя его `renderEditFlow` и `jsonResponse`):

```ts
it("saves a selected-category scope and the enabled flag", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/chz-product-groups") {
      return jsonResponse(200, {
        items: [
          { code: 8, alias: "milk", name: "Молочная продукция" },
          { code: 15, alias: "beer", name: "Пиво" },
        ],
      });
    }
    if (url === "/api/label-templates/tpl-9" && (!init || init.method === undefined)) {
      return jsonResponse(200, {
        id: "tpl-9",
        name: "Короб",
        spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
        enabled: true,
        chzProductGroupCodes: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      });
    }
    if (url === "/api/label-templates/tpl-9" && init?.method === "PATCH") {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      return jsonResponse(200, {
        id: "tpl-9",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
        ...body,
      });
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderEditFlow("tpl-9");
  await screen.findByLabelText("Название");

  fireEvent.click(screen.getByLabelText("Включён"));
  fireEvent.click(screen.getByLabelText("Только выбранные категории"));
  fireEvent.click(await screen.findByLabelText("Пиво"));
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

  await waitFor(() => {
    const call = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.enabled).toBe(false);
    expect(body.chzProductGroupCodes).toEqual([15]);
  });
});

it("refuses to save a selected scope with no categories", async () => {
  const fetchMock = stubCreateFetch("tpl-new");
  renderCreateFlow();
  fireEvent.click(screen.getByLabelText("Только выбранные категории"));
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(
    await screen.findByText(
      "Выберите хотя бы одну категорию или переключитесь на «Все категории».",
    ),
  ).toBeDefined();
  expect(fetchMock).not.toHaveBeenCalledWith(
    "/api/label-templates",
    expect.objectContaining({ method: "POST" }),
  );
});

it("warns when an EGAIS field is used but beer is outside the scope", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/chz-product-groups") {
      return jsonResponse(200, {
        items: [
          { code: 8, alias: "milk", name: "Молочная продукция" },
          { code: 15, alias: "beer", name: "Пиво" },
        ],
      });
    }
    if (url === "/api/label-templates/tpl-9" && (!init || init.method === undefined)) {
      return jsonResponse(200, {
        id: "tpl-9",
        name: "Пиво",
        spec: {
          widthMm: 58,
          heightMm: 40,
          dpi: 203,
          language: "zpl",
          elements: [
            { kind: "field", id: "e", xMm: 2, yMm: 2, field: "product.egais", fontSizePt: 8 },
          ],
        },
        enabled: true,
        chzProductGroupCodes: [15],
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      });
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderEditFlow("tpl-9");
  await screen.findByLabelText("Название");
  const hint =
    "Поле ЕГАИС заполняется только для товаров категории «Пиво». На выбранных категориях оно будет пустым.";
  expect(screen.queryByText(hint)).toBeNull();

  const beer = (await screen.findByLabelText("Пиво")) as HTMLInputElement;
  expect(beer.checked).toBe(true);
  fireEvent.click(beer);
  fireEvent.click(screen.getByLabelText("Молочная продукция"));
  expect(await screen.findByText(hint)).toBeDefined();
});
```

Сверить имена helper-ов рендера (`renderEditFlow`, `renderCreateFlow` или их аналоги) по началу файла и подставить существующие.

Run: `pnpm --filter @markiro/admin exec vitest run test/labels-editor.test.tsx` → новые тесты FAIL.

- [ ] **Step 3: Редактор — пропсы и состояние**

В `apps/admin/src/pages/labels/editor/index.tsx`:

Импорты: `Checkbox`, `RadioGroup` в импорт из `@markiro/ui`; `EGAIS_PRODUCT_GROUP_CODE`, `labelTemplateUsesField` в импорт из `@markiro/domain`; `useChzProductGroups` из `../../catalog/api.js`; `describeDefaultConflict` из `../scope.js`; `useMemo` из `react`.

`LabelEditorContentProps` дополнить:

```ts
  initialEnabled: boolean;
  initialProductGroupCodes: number[] | null;
```

В `LabelEditorPage` передавать `initialEnabled={templateQuery.data.enabled}` и `initialProductGroupCodes={templateQuery.data.chzProductGroupCodes}` в edit-ветке, `initialEnabled` `initialProductGroupCodes={null}` в create-ветке.

В `LabelEditorContent` после `const [name, setName] = useState(initialName);` добавить:

```tsx
const [enabled, setEnabled] = useState(initialEnabled);
const [scopeMode, setScopeMode] = useState<"all" | "selected">(
  initialProductGroupCodes === null ? "all" : "selected",
);
const [selectedCodes, setSelectedCodes] = useState<number[]>(initialProductGroupCodes ?? []);
const [scopeSearch, setScopeSearch] = useState("");
const [scopeError, setScopeError] = useState<string | null>(null);
// The dictionary is only needed once the operator narrows the scope.
const groupsQuery = useChzProductGroups({ enabled: scopeMode === "selected" });
const groups = groupsQuery.data ?? [];
```

После `const spec = editor.state.spec;` добавить:

```tsx
const egaisOutsideScope =
  scopeMode === "selected" &&
  !selectedCodes.includes(EGAIS_PRODUCT_GROUP_CODE) &&
  labelTemplateUsesField(spec, "product.egais");
const visibleGroups = useMemo(() => {
  const needle = scopeSearch.trim().toLocaleLowerCase("ru");
  return needle
    ? groups.filter((group) => group.name.toLocaleLowerCase("ru").includes(needle))
    : groups;
}, [groups, scopeSearch]);

function toggleCode(code: number, checked: boolean): void {
  setScopeError(null);
  setDirty(true);
  setSelectedCodes((current) =>
    checked ? [...current, code].sort((a, b) => a - b) : current.filter((value) => value !== code),
  );
}
```

- [ ] **Step 4: Редактор — сохранение и обработка 409**

`handleSave` заменить на:

```tsx
async function handleSave(): Promise<void> {
  if (hasInvalidSize) return;
  if (scopeMode === "selected" && selectedCodes.length === 0) {
    setScopeError(t("pages.labels.editor.scopeEmptyError"));
    return;
  }
  const chzProductGroupCodes = scopeMode === "all" ? null : selectedCodes;
  try {
    if (mode === "edit" && id) {
      await updateMutation.mutateAsync({
        id,
        input: { name, spec, enabled, chzProductGroupCodes },
      });
      toast("ok", t("pages.labels.editor.toasts.updateSuccess"));
      setDirty(false);
    } else {
      const created = await createMutation.mutateAsync({
        name,
        spec,
        enabled,
        chzProductGroupCodes,
      });
      toast("ok", t("pages.labels.editor.toasts.createSuccess"));
      setDirty(false);
      void navigate(`/labels/${created.id}`, { replace: true });
    }
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "LABEL_TEMPLATE_IS_DEFAULT") {
      toast("error", describeDefaultConflict(error.details, groups, t), 8000);
      return;
    }
    const fallback =
      mode === "edit"
        ? t("pages.labels.editor.toasts.updateError")
        : t("pages.labels.editor.toasts.createError");
    toast("error", error instanceof ApiRequestError ? error.message : fallback);
  }
}
```

- [ ] **Step 5: Редактор — разметка в панели настроек**

Внутри `<aside className="label-editor__settings">` после `Select` DPI и до `<p className="label-editor__languages-note">` вставить:

```tsx
          <Checkbox
            label={t("pages.labels.editor.enabledLabel")}
            hint={t("pages.labels.editor.enabledHint")}
            checked={enabled}
            onCheckedChange={(checked) => {
              setEnabled(checked);
              setDirty(true);
            }}
          />
          <RadioGroup
            label={t("pages.labels.editor.scopeTitle")}
            value={scopeMode}
            {...(scopeError ? { error: scopeError } : {})}
            onValueChange={(value) => {
              setScopeMode(value === "selected" ? "selected" : "all");
              setScopeError(null);
              setDirty(true);
              if (value !== "selected") setSelectedCodes([]);
            }}
            options={[
              { value: "all", label: t("pages.labels.editor.scopeAll") },
              { value: "selected", label: t("pages.labels.editor.scopeSelected") },
            ]}
          />
          {scopeMode === "selected" ? (
            <div className="label-editor__scope">
              <Input
                aria-label={t("pages.labels.editor.scopeSearch")}
                placeholder={t("pages.labels.editor.scopeSearch")}
                value={scopeSearch}
                onChange={(event) => setScopeSearch(event.target.value)}
              />
              {groupsQuery.isError ? (
                <Alert tone="error">{t("pages.labels.editor.scopeLoadError")}</Alert>
              ) : (
                <div className="label-editor__scope-list">
                  {visibleGroups.map((group) => (
                    <Checkbox
                      key={group.code}
                      label={group.name}
                      checked={selectedCodes.includes(group.code)}
                      onCheckedChange={(checked) => toggleCode(group.code, checked)}
                    />
                  ))}
                </div>
              )}
              {egaisOutsideScope ? (
                <Alert tone="warn">{t("pages.labels.editor.egaisScopeHint")}</Alert>
              ) : null}
            </div>
          ) : null}
```

В `editor.css` добавить:

```css
.label-editor__scope {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
}

.label-editor__scope-list {
  display: flex;
  max-height: 240px;
  overflow: auto;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-2);
}
```

Если `Input` в `@markiro/ui` не принимает `placeholder`/`aria-label` напрямую (проверить `packages/ui/src/components/Input.tsx`), использовать `label={t("pages.labels.editor.scopeSearch")}`.

- [ ] **Step 6: Запустить тесты, типы, линт**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/labels-editor.test.tsx test/i18n.test.tsx
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/pages/labels/editor/index.tsx apps/admin/src/pages/labels/editor/editor.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/labels-editor.test.tsx
git commit -m "feat(admin): template enabled flag, category scope and EGAIS hint in the label editor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Админка: настройки организации — общий дефолт только из универсальных, таблица дефолтов категорий

**Files:**

- Modify: `apps/admin/src/pages/settings/api.ts:17-33`
- Modify: `apps/admin/src/pages/settings/OrgProfilePage.tsx:60-93,118-155,163-228,274-302`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json` (`pages.settings.profile`)
- Test: `apps/admin/test/org-profile.test.tsx`

**Interfaces:**

- Consumes: `OrgProfileDto.categoryBoxLabelTemplateDefaults/productGroupsInUse` (Task 4), `LabelTemplateSummaryDto.enabled/chzProductGroupCodes` (Task 7), `useChzProductGroups`.
- Produces: `PutOrgProfileInput.categoryBoxLabelTemplateDefaults?: Array<{ chzProductGroupCode: number; templateId: string }>` — отправляется только когда таблица менялась.

- [ ] **Step 1: i18n-ключи**

`pages.settings.profile` (ru):

```json
    "defaultBoxLabelTemplateScopeHint": "Здесь доступны только включённые шаблоны для всех категорий.",
    "categoryDefaultsTitle": "Шаблоны коробки по категориям",
    "categoryDefaultsHint": "Категории берутся из товаров каталога. Дефолт категории имеет приоритет над общим.",
    "categoryDefaultsEmpty": "Назначьте товарам категории в каталоге, чтобы задать шаблон для категории.",
    "categoryDefaultsColumnCategory": "Категория",
    "categoryDefaultsColumnTemplate": "Шаблон коробки",
    "categoryDefaultInherit": "Как у организации",
    "categoryDefaultStaleOption": "Недоступный шаблон",
```

(en):

```json
    "defaultBoxLabelTemplateScopeHint": "Only enabled templates for all categories can be chosen here.",
    "categoryDefaultsTitle": "Box templates by category",
    "categoryDefaultsHint": "Categories come from catalog products. A category default takes precedence over the organisation default.",
    "categoryDefaultsEmpty": "Assign categories to catalog products to set a template per category.",
    "categoryDefaultsColumnCategory": "Category",
    "categoryDefaultsColumnTemplate": "Box template",
    "categoryDefaultInherit": "Same as organisation",
    "categoryDefaultStaleOption": "Unavailable template",
```

- [ ] **Step 2: Написать падающие тесты**

В `apps/admin/test/org-profile.test.tsx`:

1. `PROFILE` дополнить `categoryBoxLabelTemplateDefaults: [] as Array<{ chzProductGroupCode: number; templateId: string }>, productGroupsInUse: [] as number[]`.
2. Фикстуру `LABEL_TEMPLATES` дополнить `enabled: true, chzProductGroupCodes: null` у каждого элемента и добавить элемент `{ id: "tpl-beer", name: "Пиво 58×40", …, enabled: true, chzProductGroupCodes: [15] }`.
3. В `routeFetch` добавить ветку `if (url === "/api/chz-product-groups") return jsonResponse(200, { items: [{ code: 8, alias: "milk", name: "Молочная продукция" }, { code: 15, alias: "beer", name: "Пиво" }] });`.
4. Тесты:

```ts
it("offers only universal enabled templates as the organisation default", async () => {
  vi.stubGlobal("fetch", routeFetch({}));
  renderPage();
  const profileCard = await cardOf("Профиль организации");
  const select = (await within(profileCard).findByLabelText(
    "Шаблон этикетки короба по умолчанию",
  )) as HTMLSelectElement;
  const labels = Array.from(select.options).map((option) => option.textContent);
  expect(labels).not.toContain("Пиво 58×40");
  expect(labels).toContain(LABEL_TEMPLATES[0]!.name);
});

it("saves a category default chosen from eligible templates", async () => {
  let profile = { ...PROFILE, productGroupsInUse: [8, 15] };
  const fetchMock = routeFetch({
    profile: (init) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as {
          categoryBoxLabelTemplateDefaults?: unknown;
        };
        profile = {
          ...profile,
          categoryBoxLabelTemplateDefaults:
            (body.categoryBoxLabelTemplateDefaults as typeof profile.categoryBoxLabelTemplateDefaults) ??
            [],
        };
      }
      return jsonResponse(200, profile);
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  renderPage();

  const profileCard = await cardOf("Профиль организации");
  const beerRow = (await within(profileCard).findByText("Пиво")).closest("tr");
  if (!beerRow) throw new Error("Beer row not found");
  const beerSelect = within(beerRow as HTMLElement).getByRole("combobox") as HTMLSelectElement;
  const beerLabels = Array.from(beerSelect.options).map((option) => option.textContent);
  expect(beerLabels).toContain("Пиво 58×40");
  fireEvent.change(beerSelect, { target: { value: "tpl-beer" } });

  const milkRow = within(profileCard).getByText("Молочная продукция").closest("tr");
  const milkSelect = within(milkRow as HTMLElement).getByRole("combobox") as HTMLSelectElement;
  expect(Array.from(milkSelect.options).map((option) => option.textContent)).not.toContain(
    "Пиво 58×40",
  );

  fireEvent.click(within(profileCard).getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/org/profile",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          gln: PROFILE.gln,
          inn: PROFILE.inn,
          timeZone: PROFILE.timeZone,
          gs1Prefixes: PROFILE.gs1Prefixes,
          categoryBoxLabelTemplateDefaults: [{ chzProductGroupCode: 15, templateId: "tpl-beer" }],
        }),
      }),
    ),
  );
});

it("shows an empty hint when no catalog product carries a category", async () => {
  vi.stubGlobal("fetch", routeFetch({}));
  renderPage();
  const profileCard = await cardOf("Профиль организации");
  expect(
    await within(profileCard).findByText(
      "Назначьте товарам категории в каталоге, чтобы задать шаблон для категории.",
    ),
  ).toBeDefined();
});
```

Селекты категорий рендерятся `native` (как общий дефолт), поэтому `getByRole("combobox")` и `fireEvent.change` работают одинаково.

Run: `pnpm --filter @markiro/admin exec vitest run test/org-profile.test.tsx` → новые тесты FAIL.

- [ ] **Step 3: `settings/api.ts`**

```ts
export interface CategoryBoxLabelTemplateDefaultDto {
  chzProductGroupCode: number;
  templateId: string;
}

export interface OrgProfileDto {
  defaultBoxLabelTemplateId: string | null;
  categoryBoxLabelTemplateDefaults: CategoryBoxLabelTemplateDefaultDto[];
  /** Distinct ЧЗ product-group codes of non-archived catalog products. */
  productGroupsInUse: number[];
  gln: string | null;
  gs1Prefixes: string[];
  inn: string | null;
  timeZone: string;
  pickupLimitsEnabled: boolean;
  logoUrl: string | null;
  logoRevision: string | null;
}

export type PutOrgProfileInput = Partial<
  Pick<
    OrgProfileDto,
    | "defaultBoxLabelTemplateId"
    | "categoryBoxLabelTemplateDefaults"
    | "gln"
    | "gs1Prefixes"
    | "inn"
    | "pickupLimitsEnabled"
    | "timeZone"
  >
>;
```

- [ ] **Step 4: `OrgProfilePage.tsx` — схема формы и мапперы**

В `profileFormSchema` добавить `categoryDefaults: z.record(z.string(), z.string())`, в `EMPTY_PROFILE_VALUES` — `categoryDefaults: {}`.

`toProfileInput` получает третий аргумент `categoryDefaultsChanged: boolean`:

```ts
if (categoryDefaultsChanged) {
  input.categoryBoxLabelTemplateDefaults = Object.entries(values.categoryDefaults)
    .filter(([, templateId]) => templateId !== "")
    .map(([code, templateId]) => ({ chzProductGroupCode: Number(code), templateId }))
    .sort((a, b) => a.chzProductGroupCode - b.chzProductGroupCode);
}
```

`toProfileFormValues` принимает также `categoryBoxLabelTemplateDefaults` и возвращает

```ts
    categoryDefaults: Object.fromEntries(
      profile.categoryBoxLabelTemplateDefaults.map((item) => [
        String(item.chzProductGroupCode),
        item.templateId,
      ]),
    ),
```

- [ ] **Step 5: `OrgProfilePage.tsx` — данные и опции**

Импортировать `useChzProductGroups` из `../catalog/api.js`, `isBoxLabelTemplateEligible` из `@markiro/domain`, `Table`-компоненты не нужны: использовать простую `<table className="mk-table">` (проверить, какой класс таблиц используется в `apps/admin/src/pages/catalog/index.tsx`, и взять его).

После `const labelTemplates = labelTemplatesQuery.data ?? [];`:

```tsx
const groupsQuery = useChzProductGroups();
const groups = groupsQuery.data ?? [];
const categoryDefaults = watchProfile("categoryDefaults");
const universalTemplates = labelTemplates.filter(
  (template) => template.enabled && template.chzProductGroupCodes === null,
);
const savedTemplateIsUnavailable =
  defaultBoxLabelTemplateId !== "" &&
  labelTemplatesQuery.data !== undefined &&
  !universalTemplates.some((template) => template.id === defaultBoxLabelTemplateId);
const labelTemplateOptions = [
  { value: "", label: t("pages.settings.profile.defaultBoxLabelTemplateUnset") },
  ...universalTemplates.map((template) => ({ value: template.id, label: template.name })),
  ...(savedTemplateIsUnavailable
    ? [
        {
          value: defaultBoxLabelTemplateId,
          label: t("pages.settings.profile.defaultBoxLabelTemplateStaleOption"),
          disabled: true,
        },
      ]
    : []),
];
const categoryRows = [
  ...new Set([
    ...(profileQuery.data?.productGroupsInUse ?? []),
    ...Object.keys(categoryDefaults).map(Number),
  ]),
]
  .map((code) => ({
    code,
    name: groups.find((group) => group.code === code)?.name ?? String(code),
  }))
  .sort((a, b) => a.name.localeCompare(b.name, "ru"));
```

(заменив прежние `savedTemplateIsUnavailable`/`labelTemplateOptions`). В `submitProfile` передавать `profileDirtyFields.categoryDefaults !== undefined` третьим аргументом `toProfileInput`.

- [ ] **Step 6: `OrgProfilePage.tsx` — разметка**

Сразу после `<Select native label=… defaultBoxLabelTemplate …/>` добавить подсказку `<p className="mk-hint">{t("pages.settings.profile.defaultBoxLabelTemplateScopeHint")}</p>` (или `hint=` пропс `Select`, если он есть). После блока `savedTemplateIsUnavailable ? <Alert …>` добавить секцию:

```tsx
<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
  <h3 style={{ margin: 0, font: "600 14px/20px var(--font-ui)" }}>
    {t("pages.settings.profile.categoryDefaultsTitle")}
  </h3>
  <p style={{ margin: 0, color: "var(--fg-3)", font: "400 13px/18px var(--font-ui)" }}>
    {t("pages.settings.profile.categoryDefaultsHint")}
  </p>
  {categoryRows.length === 0 ? (
    <p style={{ margin: 0, color: "var(--fg-3)", font: "400 13px/18px var(--font-ui)" }}>
      {t("pages.settings.profile.categoryDefaultsEmpty")}
    </p>
  ) : (
    <table>
      <thead>
        <tr>
          <th scope="col">{t("pages.settings.profile.categoryDefaultsColumnCategory")}</th>
          <th scope="col">{t("pages.settings.profile.categoryDefaultsColumnTemplate")}</th>
        </tr>
      </thead>
      <tbody>
        {categoryRows.map((row) => {
          const value = categoryDefaults[String(row.code)] ?? "";
          const eligible = labelTemplates.filter((template) =>
            isBoxLabelTemplateEligible(template, row.code),
          );
          const stale = value !== "" && !eligible.some((template) => template.id === value);
          return (
            <tr key={row.code}>
              <td>{row.name}</td>
              <td>
                <Select
                  native
                  aria-label={row.name}
                  options={[
                    { value: "", label: t("pages.settings.profile.categoryDefaultInherit") },
                    ...eligible.map((template) => ({ value: template.id, label: template.name })),
                    ...(stale
                      ? [
                          {
                            value,
                            label: t("pages.settings.profile.categoryDefaultStaleOption"),
                            disabled: true,
                          },
                        ]
                      : []),
                  ]}
                  value={value}
                  onValueChange={(next) =>
                    setProfileValue(
                      "categoryDefaults",
                      { ...categoryDefaults, [String(row.code)]: next },
                      { shouldDirty: true },
                    )
                  }
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  )}
</div>
```

`labelTemplates` здесь уже только включённые (хук без параметров), поэтому `isBoxLabelTemplateEligible` фактически проверяет область. Если в форме уже есть `profileDirtyFields.categoryDefaults` как объект (react-hook-form помечает вложенные ключи), условие `!== undefined` корректно.

- [ ] **Step 7: Запустить тесты, типы, линт**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/org-profile.test.tsx test/i18n.test.tsx
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
```

Expected: PASS. Существующий тест `"saves a selected default box-label template UUID"` сравнивает точное тело PUT без `categoryBoxLabelTemplateDefaults` — оно остаётся таким, потому что таблица не трогалась.

- [ ] **Step 8: Commit**

```bash
git add apps/admin/src/pages/settings/api.ts apps/admin/src/pages/settings/OrgProfilePage.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/org-profile.test.tsx
git commit -m "feat(admin): per-category box label defaults in organisation settings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Админка: форма смены — фильтр по категории товара, дефолт по товару

**Files:**

- Modify: `apps/admin/src/pages/shifts/api.ts:87-89,112,136-138,177-183`
- Modify: `apps/admin/src/pages/shifts/ShiftForm.tsx:71-74,159-170,245-265,313-349,517-534`
- Modify: `apps/admin/src/pages/shifts/ShiftPanelRoute.tsx:24-34,145-153,267-278`
- Modify: `apps/admin/src/pages/shifts/index.tsx:112-119,318-352`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json` (`pages.shifts.form`)
- Test: `apps/admin/test/shifts.test.tsx`

**Interfaces:**

- Consumes: `GET /shifts/planning-config?productId=` (Task 5), `LabelTemplateSummaryDto.enabled/chzProductGroupCodes` (Task 7), `ProductDto.chzProductGroupCode/productGroup`, `isBoxLabelTemplateEligible` (Task 2).
- Produces: `useShiftPlanningConfig(productId: string | null)`; `ShiftPlanningConfigDto.defaultSource`; `ShiftFormContext` без `defaultBoxLabelTemplateId`; `ShiftsPanelContext` без `defaultBoxLabelTemplateId`.

- [ ] **Step 1: i18n-ключи**

`pages.shifts.form` (ru):

```json
    "boxLabelTemplateCategoryDefault": "По умолчанию для категории «{{category}}» — {{name}}",
    "boxLabelTemplateOrganizationDefault": "По умолчанию организации — {{name}}",
    "boxLabelTemplateSelectProduct": "Сначала выберите товар",
    "boxLabelTemplateResolving": "Загрузка шаблона по умолчанию…",
    "boxLabelTemplateNoneEligible": "Нет включённых шаблонов для категории товара",
```

`pages.shifts.form.errors` (ru): `"boxLabelTemplateResolving": "Дождитесь загрузки шаблона по умолчанию"`.

(en):

```json
    "boxLabelTemplateCategoryDefault": "Default for category “{{category}}” — {{name}}",
    "boxLabelTemplateOrganizationDefault": "Organisation default — {{name}}",
    "boxLabelTemplateSelectProduct": "Select a product first",
    "boxLabelTemplateResolving": "Loading the default template…",
    "boxLabelTemplateNoneEligible": "No enabled templates for the product's category",
```

`errors.boxLabelTemplateResolving`: `"Wait for the default template to load"`.

Существующий ключ `boxLabelTemplateOrganization` («Использовать настройку организации — {{name}}») оставить: он остаётся подписью пункта, когда дефолт разрешён из организации, и его проверяют существующие тесты. Ключ `boxLabelTemplateOrganizationDefault` тогда не нужен — не добавлять его, чтобы не плодить дубли.

- [ ] **Step 2: Написать падающие тесты**

В `apps/admin/test/shifts.test.tsx`:

1. Фикстуры шаблонов (`DEFAULT_BOX_LABEL_TEMPLATE`, `BOX_LABEL_TEMPLATE` и подобные) дополнить `enabled: true, chzProductGroupCodes: null`. Добавить `const BEER_ONLY_TEMPLATE = { ...BOX_LABEL_TEMPLATE, id: "lt-beer", name: "Пиво 58×40", chzProductGroupCodes: [15] as number[] | null };` и `const PRODUCT_BEER: ProductDto = { ...PRODUCT_A, id: "p-beer", name: "Пиво светлое", productGroup: "Пиво", chzProductGroupCode: 15 };`.
2. Во всех моках заменить `path === "/api/shifts/planning-config"` на `path.startsWith("/api/shifts/planning-config")` и добавить в ответ `defaultSource: "organization"` (или `null`, когда `defaultBoxLabelTemplateId: null`). Моки, которые не отвечают на planning-config явно, продолжают попадать в `path.startsWith("/api/shifts")` → `{ items: [] }`; форма трактует отсутствие полей как «дефолт не настроен».
3. Новый тест. В файле уже есть helper-ы `renderPage()`, `chooseOption(user, label, option)` (строка ~122: открывает Combobox кликом или Radix Select через `pointerDown` и кликает по опции) и фикстуры `PRODUCT_A`, `PLANNED_SHIFT`, `DEFAULT_BOX_LABEL_TEMPLATE`, `BOX_LABEL_TEMPLATE`, `SHIFT_PLANNING_CONFIG`:

```ts
it("offers only templates eligible for the selected product's category and labels the category default", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.startsWith("/api/shifts/planning-config")) {
      const productId = new URL(path, "http://localhost").searchParams.get("productId");
      return productId === PRODUCT_BEER.id
        ? jsonResponse(200, {
            defaultBoxLabelTemplateId: BEER_ONLY_TEMPLATE.id,
            defaultSource: "category",
          })
        : jsonResponse(200, {
            defaultBoxLabelTemplateId: DEFAULT_BOX_LABEL_TEMPLATE.id,
            defaultSource: "organization",
          });
    }
    if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
    if (path.startsWith("/api/products")) {
      return jsonResponse(200, { items: [PRODUCT_A, PRODUCT_BEER] });
    }
    if (path === "/api/label-templates") {
      return jsonResponse(200, {
        items: [DEFAULT_BOX_LABEL_TEMPLATE, BOX_LABEL_TEMPLATE, BEER_ONLY_TEMPLATE],
      });
    }
    return jsonResponse(200, { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderPage();
  await screen.findByText("Смены не запланированы");
  fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
  await screen.findByText("Новая смена");

  // No product yet: the default option asks for a product and no template is listed.
  const trigger = screen.getByRole("combobox", { name: "Шаблон этикетки короба" });
  expect(trigger.textContent).toContain("Сначала выберите товар");

  await chooseOption(user, "Продукт", PRODUCT_BEER.name);
  await waitFor(() =>
    expect(trigger.textContent).toContain("По умолчанию для категории «Пиво» — Пиво 58×40"),
  );
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/shifts/planning-config?productId=${PRODUCT_BEER.id}`,
    expect.anything(),
  );
  await chooseOption(user, "Шаблон этикетки короба", BEER_ONLY_TEMPLATE.name);

  // Switching to milk drops the beer-only template and falls back to the organisation default.
  await chooseOption(user, "Продукт", PRODUCT_A.name);
  await waitFor(() =>
    expect(trigger.textContent).toContain(
      `Использовать настройку организации — ${DEFAULT_BOX_LABEL_TEMPLATE.name}`,
    ),
  );
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerId: 1, pointerType: "mouse" });
  expect(screen.queryByRole("option", { name: BEER_ONLY_TEMPLATE.name })).toBeNull();
  expect(await screen.findByRole("option", { name: BOX_LABEL_TEMPLATE.name })).toBeDefined();
});
```

Если `Select` шаблона в форме рендерится с `native`, заменить проверки опций на `Array.from((trigger as HTMLSelectElement).options)`.

Run: `pnpm --filter @markiro/admin exec vitest run test/shifts.test.tsx -t "eligible"` → FAIL.

- [ ] **Step 3: `shifts/api.ts`**

```ts
export interface ShiftPlanningConfigDto {
  defaultBoxLabelTemplateId: string | null;
  defaultSource: "category" | "organization" | null;
}

export const SHIFT_PLANNING_CONFIG_QUERY_KEY = ["shift-planning-config"] as const;

function fetchShiftPlanningConfig(productId: string): Promise<ShiftPlanningConfigDto> {
  return apiFetch<ShiftPlanningConfigDto>(
    `/shifts/planning-config?productId=${encodeURIComponent(productId)}`,
  );
}

/** The box-template default resolved for a product (category default, then organisation default). Idle until a product is chosen. */
export function useShiftPlanningConfig(
  productId: string | null,
): UseQueryResult<ShiftPlanningConfigDto> {
  return useQuery({
    queryKey: [...SHIFT_PLANNING_CONFIG_QUERY_KEY, productId],
    queryFn: () => fetchShiftPlanningConfig(productId!),
    enabled: productId !== null,
  });
}
```

(`productId!` внутри `queryFn` допустим по образцу `useLabelTemplate(id!)` в `labels/api.ts`.)

- [ ] **Step 4: `shifts/index.tsx` и `ShiftPanelRoute.tsx`**

В `index.tsx` удалить `useShiftPlanningConfig` из импорта и `planningConfigQuery` (объявление, `defaultBoxLabelTemplateId` в контексте, `panelPending`, `panelError`, `retryPanelData`). В `ShiftPanelRoute.tsx` удалить `defaultBoxLabelTemplateId` из `ShiftsPanelContext` и из обоих `formContext`.

- [ ] **Step 5: `ShiftForm.tsx`**

Импорты: `isBoxLabelTemplateEligible` из `@markiro/domain`; `useShiftPlanningConfig` из `./api.js`.

`ShiftFormContext` оставить только `labelTemplates: LabelTemplateSummaryDto[]`.

После `const boxLabelTemplateSelection = watch("boxLabelTemplateSelection");` добавить:

```tsx
const productId = watch("productId");
const selectedProduct = products.find((product) => product.id === productId) ?? null;
const productGroupCode = selectedProduct?.chzProductGroupCode ?? null;
const planning = useShiftPlanningConfig(productId ? productId : null);
const resolvedDefaultId = planning.data?.defaultBoxLabelTemplateId ?? null;
const resolvedDefaultSource = planning.data?.defaultSource ?? null;
const eligibleTemplates = selectedProduct
  ? formContext.labelTemplates.filter((template) =>
      isBoxLabelTemplateEligible(template, productGroupCode),
    )
  : [];
```

В обработчике выбора товара (там, где форма вызывает `setValue("productId", …)`) добавить сброс непригодного выбора:

```tsx
const nextProduct = products.find((product) => product.id === value) ?? null;
const current = getValues("boxLabelTemplateSelection");
if (
  current !== BOX_TEMPLATE_SELECTION.organization &&
  current !== BOX_TEMPLATE_SELECTION.none &&
  !formContext.labelTemplates.some(
    (template) =>
      template.id === current &&
      isBoxLabelTemplateEligible(template, nextProduct?.chzProductGroupCode ?? null),
  )
) {
  setValue("boxLabelTemplateSelection", BOX_TEMPLATE_SELECTION.organization, { shouldDirty: true });
}
```

(`getValues` взять из `useForm`, если ещё не деструктурирован.)

В `submit` заменить разрешение:

```tsx
if (
  values.mode === "aggregation" &&
  values.boxLabelTemplateSelection === BOX_TEMPLATE_SELECTION.organization &&
  planning.isLoading
) {
  setError("boxLabelTemplateSelection", {
    type: "manual",
    message: "pages.shifts.form.errors.boxLabelTemplateResolving",
  });
  return;
}
const resolvedBoxLabelTemplateId = resolveBoxLabelTemplateId(
  values.boxLabelTemplateSelection,
  resolvedDefaultId,
);
```

Опции (строки 313–349) заменить:

```tsx
const currentDefaultTemplate = formContext.labelTemplates.find(
  (template) => template.id === resolvedDefaultId,
);
const defaultOptionLabel = !selectedProduct
  ? t("pages.shifts.form.boxLabelTemplateSelectProduct")
  : planning.isLoading
    ? t("pages.shifts.form.boxLabelTemplateResolving")
    : resolvedDefaultId === null
      ? t("pages.shifts.form.boxLabelTemplateOrganization", {
          name: t("pages.shifts.form.boxLabelTemplateNotConfigured"),
        })
      : resolvedDefaultSource === "category"
        ? t("pages.shifts.form.boxLabelTemplateCategoryDefault", {
            category: selectedProduct.productGroup ?? String(productGroupCode ?? ""),
            name:
              currentDefaultTemplate?.name ?? t("pages.shifts.form.boxLabelTemplateUnavailable"),
          })
        : t("pages.shifts.form.boxLabelTemplateOrganization", {
            name:
              currentDefaultTemplate?.name ?? t("pages.shifts.form.boxLabelTemplateUnavailable"),
          });
const boxLabelTemplateOptions: SelectOption[] = [
  { value: BOX_TEMPLATE_SELECTION.organization, label: defaultOptionLabel },
  ...(formMode === "edit"
    ? [{ value: BOX_TEMPLATE_SELECTION.none, label: t("pages.shifts.form.noBoxLabelTemplate") }]
    : []),
  ...eligibleTemplates.map((template) => ({ value: template.id, label: template.name })),
  ...(boxLabelTemplateSelection !== BOX_TEMPLATE_SELECTION.organization &&
  boxLabelTemplateSelection !== BOX_TEMPLATE_SELECTION.none &&
  !eligibleTemplates.some((template) => template.id === boxLabelTemplateSelection)
    ? [
        {
          value: boxLabelTemplateSelection,
          label: t("pages.shifts.form.boxLabelTemplateUnavailable"),
          disabled: true,
        },
      ]
    : []),
];
```

Поле `productGroup` у `ProductDto` (`apps/admin/src/pages/catalog/api.ts:36`) — это имя группы, поэтому дополнительный запрос справочника не нужен. Если `Select` из `@markiro/ui` показывает `hint`, при `selectedProduct && eligibleTemplates.length === 0` передать `hint={t("pages.shifts.form.boxLabelTemplateNoneEligible")}`.

- [ ] **Step 6: Запустить тесты, типы, линт**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/shifts.test.tsx test/shifts-routing.test.tsx test/i18n.test.tsx
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
```

Expected: PASS. Тесты, где после выбора товара ожидается подпись «Использовать настройку организации — …», должны отвечать на `planning-config?productId=` (см. шаг 2, п. 2); иначе форма честно покажет «Не настроен».

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/pages/shifts apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/shifts.test.tsx
git commit -m "feat(admin): shift form offers only templates eligible for the product category

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Админка: параметры инвентаризации — фильтр по категории и предзаполнение по товару

**Files:**

- Modify: `apps/admin/src/pages/inventory/InventoryParametersForm.tsx:41-63,74-76,125-141`
- Test: `apps/admin/test/inventory-preparation.test.tsx`

**Interfaces:**

- Consumes: `useShiftPlanningConfig(productId | null)` (Task 10), `useProducts` (`ProductDto.chzProductGroupCode`), `isBoxLabelTemplateEligible` (Task 2).

- [ ] **Step 1: Написать падающий тест**

В `apps/admin/test/inventory-preparation.test.tsx`:

1. В общем мок-роутере заменить `url === "/api/shifts/planning-config"` на `url.startsWith("/api/shifts/planning-config")` и в ответ добавить `defaultSource: "organization"`.
2. В `parameterDependency` (строка ~246) фикстуру шаблона `Короб 20 бутылок` дополнить `enabled: true, chzProductGroupCodes: null` и добавить в тот же `items` второй шаблон, не покрывающий пивной товар фикстуры (`chzProductGroupCode: 15`):

```ts
        {
          id: "44444444-4444-4444-8444-444444444445",
          name: "Молоко 58×40",
          widthMm: 58,
          heightMm: 40,
          dpi: 203,
          language: "zpl",
          enabled: true,
          chzProductGroupCodes: [8],
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
```

3. Тест (тот же каркас, что у первого теста файла «creates one-product parameters…»):

```ts
it("prefills the product's default template and hides templates scoped to other categories", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const { user } = renderRoute("/inventory/new", async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    const dependency = shellDependency(url);
    if (dependency) return dependency;
    const parameter = parameterDependency(url);
    if (parameter) return parameter;
    throw new Error(`Unexpected request: ${url}`);
  });

  fireEvent.click(await screen.findByRole("combobox", { name: "Продукт" }));
  fireEvent.click(await screen.findByRole("option", { name: /Пиво светлое/ }));
  await user.click(screen.getByRole("radio", { name: /С переупаковкой/ }));

  const trigger = screen.getByRole("combobox", { name: "Шаблон этикетки короба" });
  await waitFor(() => expect(trigger.textContent).toContain("Короб 20 бутылок"));
  expect(
    requests.some(({ url }) => url === `/api/shifts/planning-config?productId=${ID.product}`),
  ).toBe(true);

  fireEvent.click(trigger);
  expect(await screen.findByRole("option", { name: "Короб 20 бутылок" })).toBeDefined();
  expect(screen.queryByRole("option", { name: "Молоко 58×40" })).toBeNull();
});
```

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-preparation.test.tsx` → новый тест FAIL.

- [ ] **Step 2: `InventoryParametersForm.tsx`**

Импорт `isBoxLabelTemplateEligible` из `@markiro/domain`. Заменить блок состояния и эффектов (строки 41–63):

```tsx
const products = useProducts({ archived: "all" });
const lines = useLines();
const templates = useLabelTemplates();
const [productId, setProductId] = useState(initialValue?.productId ?? "");
const [lineId, setLineId] = useState(initialValue?.lineId ?? "");
const [mode, setMode] = useState<InventoryMode>(initialValue?.mode ?? "check");
const [templateId, setTemplateId] = useState(initialValue?.boxLabelTemplateId ?? "");
// A manual choice survives product changes only while it stays eligible;
// the default is re-applied whenever the operator has not chosen by hand.
const [templateTouched, setTemplateTouched] = useState(Boolean(initialValue?.boxLabelTemplateId));
const [from, setFrom] = useState(initialValue?.productionDateFrom ?? "");
const [to, setTo] = useState(initialValue?.productionDateTo ?? "");
const [validationError, setValidationError] = useState<string | null>(null);
const planning = useShiftPlanningConfig(productId ? productId : null);

const selectedProduct = (products.data ?? []).find((product) => product.id === productId) ?? null;
const productGroupCode = selectedProduct?.chzProductGroupCode ?? null;
const eligibleTemplates = selectedProduct
  ? (templates.data ?? []).filter((template) =>
      isBoxLabelTemplateEligible(template, productGroupCode),
    )
  : [];

useEffect(() => {
  if (!lineId && lines.data?.length === 1) setLineId(lines.data[0]!.id);
}, [lineId, lines.data]);
useEffect(() => {
  if (templateTouched) return;
  setTemplateId(planning.data?.defaultBoxLabelTemplateId ?? "");
}, [planning.data, templateTouched]);

function handleProductChange(next: string): void {
  setProductId(next);
  const nextProduct = (products.data ?? []).find((product) => product.id === next) ?? null;
  const stillEligible =
    templateId !== "" &&
    (templates.data ?? []).some(
      (template) =>
        template.id === templateId &&
        isBoxLabelTemplateEligible(template, nextProduct?.chzProductGroupCode ?? null),
    );
  if (!stillEligible) {
    setTemplateId("");
    setTemplateTouched(false);
  }
}
```

Гейт загрузки (строки 74–76) без `planning`:

```tsx
const loading = products.isPending || lines.isPending || templates.isPending;
const loadError = products.isError || lines.isError || templates.isError;
```

У `Combobox` товара заменить `onValueChange={setProductId}` на `onValueChange={handleProductChange}` (сверить точное имя пропса в текущей разметке, строки ~100–115). Селект шаблона:

```tsx
{
  mode === "repack" ? (
    <Select
      label={t("pages.inventory.create.template")}
      value={templateId}
      onValueChange={(value) => {
        setTemplateId(value);
        setTemplateTouched(true);
      }}
      options={eligibleTemplates.map((template) => ({
        value: template.id,
        label: template.name,
      }))}
      placeholder={t("pages.inventory.create.templatePlaceholder")}
    />
  ) : null;
}
```

- [ ] **Step 3: Запустить тесты, типы, линт**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/inventory-preparation.test.tsx test/inventory-routing.test.tsx
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin test
```

Expected: PASS, включая полный прогон пакета (последняя правка админки).

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/pages/inventory/InventoryParametersForm.tsx apps/admin/test/inventory-preparation.test.tsx
git commit -m "feat(admin): inventory form filters box templates by product category

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Станция: запрос шаблонов по товару

**Files:**

- Modify: `apps/station/src/pages/NewShift.tsx:143-146`
- Test: `apps/station/test/new-shift.test.tsx:754`

**Interfaces:**

- Consumes: `GET /shifts/box-label-templates?productId=` (Task 5).

- [ ] **Step 1: Обновить ожидание в тесте**

В `apps/station/test/new-shift.test.tsx` в тесте «opens the template picker for aggregation with the org default preselected…» заменить

```ts
expect(fetchMock.mock.calls[2]?.[0]).toBe("http://localhost:3000/shifts/box-label-templates");
```

на

```ts
expect(fetchMock.mock.calls[2]?.[0]).toBe(
  "http://localhost:3000/shifts/box-label-templates?productId=p1",
);
```

Run: `pnpm --filter @markiro/station exec vitest run test/new-shift.test.tsx -t "org default preselected"` → FAIL.

- [ ] **Step 2: `NewShift.tsx`**

Заменить вызов в `openTemplateStep`:

```tsx
// The server filters by the product's ЧЗ category and resolves the
// category/organisation default; the station never sees scope metadata.
const config = await client.get<{
  items: BoxLabelTemplateOption[];
  defaultBoxLabelTemplateId: string | null;
}>(`/shifts/box-label-templates?productId=${encodeURIComponent(product.id)}`);
```

- [ ] **Step 3: Прогнать гейты станции**

Run:

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/station exec vitest run test/new-shift.test.tsx
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/station/src/pages/NewShift.tsx apps/station/test/new-shift.test.tsx
git commit -m "feat(station): request box templates for the scanned product

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Документация, граф и финальные гейты

**Files:**

- Modify: `docs/working-map.md:124-131` («Labels and printing»)
- Modify: `docs/superpowers/specs/2026-09-02-label-template-scope-and-defaults-design.md` (статус)

- [ ] **Step 1: working-map**

В раздел «### Labels and printing» добавить абзац:

```markdown
Templates carry selection metadata besides the spec: `enabled` and an optional
ЧЗ product-group scope (`label_templates.chz_product_group_codes`, NULL = all).
Per-category box defaults live in `org_box_label_template_defaults`; resolution
is category default → organisation default → none. The rules are
`isBoxLabelTemplateEligible`/`resolveBoxLabelTemplateDefault` in
`packages/domain/src/labels/eligibility.ts`; the API wraps them in
`apps/api/src/modules/label-templates/box-label-template-eligibility.ts`, shared
by label-templates, org-profile, shifts and inventories.
```

В спеке заменить `**Status:** Proposed for implementation` на `**Status:** Implemented (branch claude/label-template-scope-and-defaults)`.

- [ ] **Step 2: Полные гейты**

Run:

```bash
set -a; source .env; set +a
pnpm turbo lint typecheck test build --concurrency=1 --force
pnpm format:check
git diff --check
```

Expected: всё зелёное; в отчёте перечислить, какие тесты пропущены из-за окружения (не должно быть пропусков API/DB при заданном `DATABASE_URL`).

- [ ] **Step 3: Обновить граф и закоммитить**

```bash
graphify update .
git add docs/working-map.md docs/superpowers/specs/2026-09-02-label-template-scope-and-defaults-design.md
git commit -m "docs: label template scope and category defaults in the working map

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4: Ручная проверка (не автоматизируется)**

На живом стенде: (1) в библиотеке выключить стоковый шаблон, убедиться, что он пропал из формы смены и со станции; (2) назначить дефолт категории «Пиво», создать сборочную смену по пивному товару на станции и проверить предвыбор; (3) попытаться выключить шаблон-дефолт и увидеть тост с объяснением. Результаты ручной проверки указать в финальном отчёте отдельно от автоматических.
