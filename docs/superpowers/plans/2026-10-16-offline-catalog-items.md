# План: офлайн-доступные позиции каталога (тарифы и дополнения для клиентов без кабинета)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** На позиции каталога (тариф, дополнение) появляется флаг «Доступно офлайн-клиентам»; помеченные позиции можно назначать клиенту без кабинета (`cabinet_access = 'none'`) через «Прямое назначение», а выпуск офлайн-лицензии автонома для такого клиента берёт права из его действующих назначений, как путь «из подписки»; ручные «Офлайн-условия» заменяются.

**Architecture:** Флаг — колонка `catalog_items.offline_available` (на позиции, не на версии: опубликованные версии неизменяемы триггерами). Страж `assertKindAllowedForTenant` становится `assertCatalogAllowedForTenant` (вид + флаг версии → позиции). Выпуск лицензии получает третий источник `offline_assignments`, читающий снимок прав тем же `subscriptionTerms`, что и путь `subscription`; старый источник `offline` остаётся только для чтения. Выдача кабинета не создаёт демо, если у клиента уже есть «текущая» подписка. SaaS-админка: переключатель и бейдж в каталоге, панель назначений и фильтр позиций для клиента без кабинета, блок прав в диалоге выпуска.

**Tech Stack:** NestJS + Drizzle/Postgres, Zod-контракты `@markiro/platform-contracts`, React + react-query + react-hook-form в `apps/saas-admin`, Vitest.

**Спецификация:** `docs/superpowers/specs/2026-10-16-offline-catalog-items-design.md` (решения владельца — раздел 2, решения автора Р1–Р14 — раздел 3, открытые вопросы В1–В4 — раздел 16). Ниже «Спец §N» — раздел спецификации.

**Источники в коде (проверены при написании):**

- `apps/api/src/subscriptions/tenant-cabinet-access.ts`, `subscription-lifecycle.service.ts` (стр. 345, 589), `apps/api/src/modules/billing/billing.service.ts` (стр. 165), `apps/api/src/modules/platform-offers/platform-offer-draft.ts` (стр. 48).
- `apps/api/src/modules/platform-catalog/platform-catalog.service.ts` (`lockItem`, `archive`, `toDto`, `updateVersion`), `platform-catalog.controller.ts`.
- `apps/api/src/modules/standalone-licenses/standalone-license-issuance.service.ts`, `standalone-license-authority.ts`, `standalone-license-rights.ts`, `standalone-sites.service.ts`.
- `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts` (`grantCabinetAccessInTransaction`, `insertPendingDemo`).
- `packages/db/src/schema/saas.ts` (`catalogItems`), `packages/db/src/schema/standalone-licenses.ts`, миграции `0030`, `0132`, `0192`, `0194`.
- `packages/platform-contracts/src/tenants.ts` (`assignableCatalogVersionSchema`, `grantCabinetAccessResponseSchema`), `catalog.ts`, `standalone-licenses.ts`.
- `apps/saas-admin/src/pages/{catalog,tenants,documents}/…`.
- Документы `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` и план `…-lc0-saas-offline-license-export.md` лежат в ветке `claude/integration`; в `origin/main` их нет (файлы кода выпуска в `main` есть).

## Global Constraints

- Рабочее дерево — отдельный worktree от свежего `origin/main`; перед правками `git status --short`; чужие изменения не трогать; без `git stash`.
- Новая миграция, применённые не переписываем. Номер — следующий свободный на момент реализации (на момент написания `0195`; проверить `ls packages/db/migrations | tail -3`, при расхождении — переименовать файл, тег журнала и тесты). После правок `@markiro/db` и `@markiro/platform-contracts` — `pnpm --filter <пакет> build` до тестов потребителей.
- Схемы платформенных контрактов `.strict()`: каждое новое поле — вместе со всеми фикстурами потребителей в том же коммите.
- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`): без `any`, `!`, широких приведений; `import type`.
- Аудит проверяется по точным полям (актор, роль, клиент, действие, цель, исход, основание, `before`/`after`), не по числу строк.
- Платформенные маршруты — платформенные возможности и роль (`RequirePlatformCapabilities` + роль в сервисе), без кабинетной сессии и ключей устройств; новый маршрут добавляется в `apps/api/test/platform-route-contracts.ts` и OpenAPI-проверки (`apps/api/AGENTS.md`).
- Текст интерфейса — ключи `apps/saas-admin/src/i18n/ru.json` и `en.json` одновременно; доступность: метки, фокус, состояния не только цветом.
- Не пересчитывать сохранённые факты: строки журнала `source = 'offline'`, причина `offline_term`, выданные файлы остаются как есть.
- Окружение: `export pnpm_config_verify_deps_before_run=false`; БД-тесты — `DATABASE_URL` (общий dev-Postgres может иметь дрейф журнала: тогда одноразовый контейнер, общие данные не трогать); пропуски отчётом.
- Коммиты — только с явного разрешения владельца; стадировать явные пути, не `git add -A`; трейлер `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Код в примерах плана не запускался; ожидаемые результаты — ожидания, а не наблюдения; расхождение — повод остановиться и сверить с кодом.

## Структура файлов

| Файл                                                                                                                                                                | Ответственность                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/db/src/schema/saas.ts`                                                                                                                                    | `catalogItems.offlineAvailable` и проверка вида                                                |
| `packages/db/src/schema/standalone-licenses.ts`                                                                                                                     | `sourceAssignments`, новый источник, пересозданная проверка                                    |
| `packages/db/migrations/0195_offline_catalog_items.sql` (+ `meta`)                                                                                                  | миграция                                                                                       |
| `packages/db/test/offline-catalog-items-{schema,migration}.test.ts`                                                                                                 | тесты БД                                                                                       |
| `packages/platform-contracts/src/{tenants,catalog,standalone-licenses}.ts`                                                                                          | поле `offlineAvailable`, контракт флага, источник и `sourceAssignments`, ответ выдачи кабинета |
| `apps/api/src/subscriptions/tenant-cabinet-access.ts`                                                                                                               | `assertCatalogAllowedForTenant`                                                                |
| `apps/api/src/modules/platform-catalog/{platform-catalog.service,platform-catalog.controller,dto}.ts`                                                               | маршрут и сервис флага, `offlineAvailable` в `toDto`                                           |
| `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts` и контроллер/сервис тенантов                                                                 | выдача кабинета без демо при текущей подписке                                                  |
| `apps/api/src/modules/standalone-licenses/{standalone-license-issuance.service,standalone-license-authority,standalone-license-rights,standalone-license-views}.ts` | источник `offline_assignments`, удаление офлайн-условий                                        |
| `apps/saas-admin/src/pages/catalog/*`, `pages/tenants/*`, `pages/documents/CatalogPositionPicker.tsx`, `i18n/*.json`                                                | интерфейс                                                                                      |
| `docs/operations/standalone-licenses.md`, спека 2026-10-13 (после переноса в `main`), `tools/production-browser/*`                                                  | документация, браузерные фикстуры                                                              |

---

### Task 1: БД — флаг позиции, источник и назначения в журнале выдачи

**Files:**

- Modify: `packages/db/src/schema/saas.ts` (таблица `catalogItems`, стр. ~102)
- Modify: `packages/db/src/schema/standalone-licenses.ts` (`standaloneLicenseIssuances`)
- Create (генерация + правка вручную): `packages/db/migrations/0195_offline_catalog_items.sql`, `packages/db/migrations/meta/0195_snapshot.json`, запись в `_journal.json`
- Test: `packages/db/test/offline-catalog-items-schema.test.ts`, `packages/db/test/offline-catalog-items-migration.test.ts`
- Modify (тест по журналу): `packages/db/test/standalone-support-diagnostics-migration.test.ts`
- Modify: `packages/db/test/standalone-licenses-migration.test.ts`, `standalone-licenses-schema.test.ts` (если проверяют старое условие)

**Interfaces:**

- Produces: `schema.catalogItems.offlineAvailable: boolean` (not null, default `false`); `schema.standaloneLicenseIssuances.sourceAssignments: Array<{kind:"plan"|"addon"; id:string; catalogVersionId:string}> | null`; `source: "subscription" | "offline" | "offline_assignments"`.

- [ ] **Step 1: Падающий тест схемы**

Create `packages/db/test/offline-catalog-items-schema.test.ts`:

```ts
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("offline catalog items schema (spec 2026-10-16)", () => {
  it("keeps the offline flag on the catalog item, false by default", () => {
    const config = getTableConfig(schema.catalogItems);
    const column = config.columns.find((candidate) => candidate.name === "offline_available");
    expect(column?.notNull).toBe(true);
    expect(column?.default).toBe(false);
    expect(config.checks.map((check) => check.name)).toContain("catalog_items_offline_kind_check");
    // The flag is deliberately not on versions: published versions are immutable.
    const versions = getTableConfig(schema.catalogItemVersions);
    expect(versions.columns.map((candidate) => candidate.name)).not.toContain("offline_available");
  });

  it("journals the assignments a license was issued from", () => {
    const config = getTableConfig(schema.standaloneLicenseIssuances);
    const column = config.columns.find((candidate) => candidate.name === "source_assignments");
    expect(column?.notNull).toBe(false);
    expect(config.checks.map((check) => check.name)).toContain(
      "standalone_license_issuances_shape_check",
    );
  });
});
```

- [ ] **Step 2: Запустить — упасть**

Run: `pnpm --filter @markiro/db exec vitest run test/offline-catalog-items-schema.test.ts`
Expected: FAIL (`column` is `undefined`, `expected undefined to be true`).

- [ ] **Step 3: Схема**

В `packages/db/src/schema/saas.ts` в `catalogItems` добавить колонку после `status` и проверку:

```ts
    status: catalogItemStatus("status").notNull().default("active"),
    /**
     * Spec 2026-10-16: a plan or add-on a tenant without a cabinet may be
     * assigned. On the item, not the version: published versions are immutable.
     */
    offlineAvailable: boolean("offline_available").notNull().default(false),
```

и в массив ограничений:

```ts
    check(
      "catalog_items_offline_kind_check",
      sql`${table.offlineAvailable} = false or ${table.kind} in ('plan', 'addon')`,
    ),
```

(`boolean`, `check`, `sql` в этом файле уже импортированы — проверить шапку файла.)

В `packages/db/src/schema/standalone-licenses.ts`: тип `source` → `"subscription" | "offline" | "offline_assignments"`; после `validUntilReason` добавить

```ts
    /** The plan and add-on rows a `offline_assignments` file was issued from (spec 2026-10-16). */
    sourceAssignments: jsonb("source_assignments").$type<
      Array<{ kind: "plan" | "addon"; id: string; catalogVersionId: string }>
    >(),
```

и заменить SQL `standalone_license_issuances_shape_check`: список `source` → `('subscription','offline','offline_assignments')`; условие `(${t.source} <> 'offline' or ${t.plan} = 'subscription')` → `(${t.source} not in ('offline','offline_assignments') or ${t.plan} = 'subscription')`; дописать в конец `and ((${t.source} = 'offline_assignments') = (${t.sourceAssignments} is not null)) and (${t.sourceAssignments} is null or (jsonb_typeof(${t.sourceAssignments}) = 'array' and jsonb_array_length(${t.sourceAssignments}) between 1 and 65))`.

- [ ] **Step 4: Сгенерировать и проверить миграцию**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/db db:generate -- --name offline_catalog_items`
Expected: создан `packages/db/migrations/0195_offline_catalog_items.sql` (проверить, что номер следующий за `0194`; иначе переименовать). Открыть файл и убедиться, что в нём ровно: `ALTER TABLE "catalog_items" ADD COLUMN "offline_available" boolean DEFAULT false NOT NULL`; `ADD CONSTRAINT "catalog_items_offline_kind_check"`; `ALTER TABLE "standalone_license_issuances" ADD COLUMN "source_assignments" jsonb`; `DROP CONSTRAINT "standalone_license_issuances_shape_check"` и `ADD CONSTRAINT` с новым условием. Если drizzle-kit не пересоздал проверку — дописать пару `DROP`/`ADD` вручную с текстом из схемы. Backfill-операторов нет (все существующие позиции — `false`).

- [ ] **Step 5: Миграционный тест**

Create `packages/db/test/offline-catalog-items-migration.test.ts` по образцу `custom-logo-migration.test.ts` (`copyMigrationsThroughIndex` до 194 → вставить позицию, площадку и выдачу `source='offline'` → применить `runRuntimeMigrations`):

```ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

// Migration 0195: the offline flag of catalog items and the assignments journal.
describe.skipIf(!databaseUrl)("offline catalog items migration", () => {
  const databaseName = `markiro_offline_catalog_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;
  const planItem = randomUUID();
  const serviceItem = randomUUID();
  const tenant = `offline-cat-${randomUUID()}`;
  const site = randomUUID();
  const legacyIssuance = randomUUID();

  async function issuance(overrides: {
    source: string;
    reason: string;
    assignments: string | null;
  }) {
    return pool.query(
      `INSERT INTO standalone_license_issuances
        (id, tenant_id, site_id, sequence, request_id, host_id, plan, plan_version_id, entitlement_revision,
         payload, compact, sha256, kid, grace_days, issued_at, valid_from, valid_until, source,
         valid_until_reason, source_assignments, issued_by_platform_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,'subscription',$7,$8,'{}','x',$9,'k',14,now(),now(),now() + interval '30 days',$10,$11,$12::jsonb,'cat-admin')`,
      [
        randomUUID(),
        tenant,
        site,
        Math.floor(Math.random() * 1_000_000) + 10,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        overrides.source === "offline" ? 0 : 5,
        "a".repeat(64),
        overrides.source,
        overrides.reason,
        overrides.assignments,
      ],
    );
  }

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-offline-catalog-migration-"));
    const before = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: before,
      lastIncludedIndex: 194,
    });
    await migrate(drizzle(pool), { migrationsFolder: before });
    await pool.query(
      "INSERT INTO catalog_items (id,code,kind,name_ru,name_en) VALUES ($1,$1::text,'plan','Тест','Test'),($2,$2::text,'service','Услуга','Service')",
      [planItem, serviceItem],
    );
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at,cabinet_access) VALUES ($1,'T',$1,now(),'none')",
      [tenant],
    );
    await pool.query(
      "INSERT INTO platform_users (id,email,name,role,status,two_factor_enabled) VALUES ('cat-admin','cat@example.invalid','C','platform_admin','active',true)",
    );
    await pool.query(
      `INSERT INTO standalone_sites (id,tenant_id,host_id,name,last_activation_request,host_history,request_id,created_by_platform_user_id)
       VALUES ($1,$2,$3,'Цех','{"format":"x"}','[{"hostId":"x"}]',$4,'cat-admin')`,
      [site, tenant, randomUUID(), randomUUID()],
    );
    await pool.query(
      `INSERT INTO standalone_license_issuances
        (id,tenant_id,site_id,sequence,request_id,host_id,plan,plan_version_id,entitlement_revision,payload,compact,sha256,kid,grace_days,issued_at,valid_from,valid_until,source,valid_until_reason,issued_by_platform_user_id)
       VALUES ($1,$2,$3,1,$4,$5,'subscription',$6,0,'{}','x',$7,'k',14,now(),now(),now() + interval '30 days','offline','offline_term','cat-admin')`,
      [legacyIssuance, tenant, site, randomUUID(), randomUUID(), randomUUID(), "b".repeat(64)],
    );
    const applied = await runRuntimeMigrations({
      databaseUrl: scratchUrl.toString(),
      migrationsFolder,
      log: () => undefined,
    });
    expect(applied.applied).toBeGreaterThan(0);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("leaves every existing item unavailable offline and the old journal rows intact", async () => {
    const items = await pool.query("SELECT offline_available FROM catalog_items");
    expect(
      items.rows.every((row: { offline_available: boolean }) => row.offline_available === false),
    ).toBe(true);
    const old = await pool.query(
      "SELECT source, valid_until_reason, source_assignments FROM standalone_license_issuances WHERE id = $1",
      [legacyIssuance],
    );
    expect(old.rows).toEqual([
      { source: "offline", valid_until_reason: "offline_term", source_assignments: null },
    ]);
  });

  it("allows the flag on plans and add-ons only", async () => {
    await pool.query("UPDATE catalog_items SET offline_available = true WHERE id = $1", [planItem]);
    await expect(
      pool.query("UPDATE catalog_items SET offline_available = true WHERE id = $1", [serviceItem]),
    ).rejects.toThrow(/catalog_items_offline_kind_check/);
  });

  it("accepts an offline_assignments row with its assignments and refuses malformed ones", async () => {
    const assignments = JSON.stringify([
      { kind: "plan", id: randomUUID(), catalogVersionId: randomUUID() },
    ]);
    await expect(
      issuance({ source: "offline_assignments", reason: "one_year_cap", assignments }),
    ).resolves.toBeDefined();
    await expect(
      issuance({ source: "offline_assignments", reason: "offline_term", assignments }),
    ).rejects.toThrow(/standalone_license_issuances_shape_check/);
    await expect(
      issuance({ source: "offline_assignments", reason: "one_year_cap", assignments: null }),
    ).rejects.toThrow(/standalone_license_issuances_shape_check/);
    await expect(
      issuance({ source: "offline_assignments", reason: "one_year_cap", assignments: "[]" }),
    ).rejects.toThrow(/standalone_license_issuances_shape_check/);
    await expect(
      issuance({ source: "subscription", reason: "one_year_cap", assignments }),
    ).rejects.toThrow(/standalone_license_issuances_shape_check/);
  });
});
```

(Поля `INSERT INTO standalone_sites`/`organization` сверить с `standalone-licenses-migration.test.ts` и `tenant-cabinet-access-migration.test.ts`; если в таблицах есть обязательные колонки, не вошедшие в пример, добавить их — тест должен падать только по проверяемой причине.)

- [ ] **Step 6: Починить тест журнала миграций**

В `packages/db/test/standalone-support-diagnostics-migration.test.ts` заменить

```ts
expect(journal.entries.at(-1)?.tag).toBe("0194_standalone_support_diagnostics");
journal.entries.pop();
```

на усечение по имени записи (тест не должен ломаться при каждой следующей миграции):

```ts
const diagnosticsIndex = journal.entries.findIndex(
  (entry) => entry.tag === "0194_standalone_support_diagnostics",
);
expect(diagnosticsIndex).toBeGreaterThanOrEqual(0);
journal.entries.splice(diagnosticsIndex);
```

и перед этим скопировать только файлы миграций, нужных усечённому журналу не требуется (драйвер читает журнал). Если тест дальше проверяет, что до применения последней миграции таблицы нет (`to_regclass(...) IS NULL`) — оставить как есть.

- [ ] **Step 7: Прогон**

Run: `pnpm --filter @markiro/db build && pnpm --filter @markiro/db exec vitest run test/offline-catalog-items-schema.test.ts test/offline-catalog-items-migration.test.ts test/standalone-licenses-migration.test.ts test/standalone-licenses-schema.test.ts test/standalone-support-diagnostics-migration.test.ts test/saas-schema.test.ts`
Expected: PASS (миграционные — с `DATABASE_URL`; без него — SKIPPED, отметить в отчёте). Затем `pnpm --filter @markiro/db test && pnpm --filter @markiro/db typecheck && pnpm --filter @markiro/db lint`.
Если `standalone-licenses-migration.test.ts` проверяет старое условие `source in ('subscription','offline')` — обновить ожидание на три значения.

- [ ] **Step 8: Коммит**

```bash
git add packages/db/src/schema/saas.ts packages/db/src/schema/standalone-licenses.ts \
  packages/db/migrations/0195_offline_catalog_items.sql packages/db/migrations/meta \
  packages/db/test/offline-catalog-items-schema.test.ts packages/db/test/offline-catalog-items-migration.test.ts \
  packages/db/test/standalone-support-diagnostics-migration.test.ts packages/db/test/standalone-licenses-migration.test.ts \
  packages/db/test/standalone-licenses-schema.test.ts
git commit -m "feat(db): offline flag on catalog items and license assignments journal"
```

(Стадировать только реально изменённые файлы; `git diff --cached --stat` перед коммитом.)

---

### Task 2: Контракты — `offlineAvailable`, флаг, источник выпуска, ответ выдачи кабинета

**Files:**

- Modify: `packages/platform-contracts/src/tenants.ts` (`assignableCatalogVersionSchema`, `grantCabinetAccessResponseSchema`)
- Modify: `packages/platform-contracts/src/catalog.ts` (новые схемы, `platformCatalogContracts.setOfflineAvailability`, экспорт)
- Modify: `packages/platform-contracts/src/standalone-licenses.ts` (источник, `sourceMatchesReason`, `sourceAssignments`)
- Modify: `packages/platform-contracts/src/index.ts` (экспорт новых схем и типов, если barrel перечисляет имена)
- Test: `packages/platform-contracts/test/{catalog,tenants,standalone-licenses}.test.ts`; фикстуры в `catalog-v3.test.ts`, `commercial-terms.test.ts`

**Interfaces:**

- Consumes: Task 1 типы БД (только для согласования значений).
- Produces: `catalogOfflineAvailabilityBodySchema`, `catalogOfflineAvailabilityResponseSchema`, `standaloneAssignmentRefSchema`, `STANDALONE_ISSUANCE_SOURCES = ["subscription","offline","offline_assignments"]`; поле `offlineAvailable: boolean` во всех ответах каталога; `grantCabinetAccessResponseSchema` с `offlineAssignments` и `demoCreated`.

- [ ] **Step 1: Падающие тесты**

В `packages/platform-contracts/test/catalog.test.ts` (рядом с существующими тестами версий) добавить:

```ts
import {
  catalogOfflineAvailabilityBodySchema,
  catalogOfflineAvailabilityResponseSchema,
  catalogVersionSchema,
} from "../src/index.js";

describe("offline availability contracts", () => {
  it("requires offlineAvailable in every catalog version response", () => {
    const { offlineAvailable: _omitted, ...withoutFlag } = planVersionFixture({
      offlineAvailable: true,
    });
    expect(catalogVersionSchema.safeParse(withoutFlag).success).toBe(false);
    expect(
      catalogVersionSchema.safeParse(planVersionFixture({ offlineAvailable: false })).success,
    ).toBe(true);
  });

  it("accepts a reasoned, strict flag change and refuses extras", () => {
    expect(
      catalogOfflineAvailabilityBodySchema.safeParse({
        offlineAvailable: true,
        reason: "Продаём автоном",
      }).success,
    ).toBe(true);
    expect(catalogOfflineAvailabilityBodySchema.safeParse({ offlineAvailable: true }).success).toBe(
      false,
    );
    expect(
      catalogOfflineAvailabilityBodySchema.safeParse({
        offlineAvailable: true,
        reason: "x",
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      catalogOfflineAvailabilityBodySchema.safeParse({ offlineAvailable: true, reason: "" })
        .success,
    ).toBe(false);
  });

  it("answers with the item, the result and the holders, plan or add-on only", () => {
    const answer = {
      catalogItemId: "6f1b5ea0-0000-4000-8000-000000000001",
      catalogItemCode: "plan-a",
      kind: "plan",
      offlineAvailable: true,
      changed: true,
      offlineTenantHolders: 2,
    };
    expect(catalogOfflineAvailabilityResponseSchema.safeParse(answer).success).toBe(true);
    expect(
      catalogOfflineAvailabilityResponseSchema.safeParse({ ...answer, kind: "service" }).success,
    ).toBe(false);
  });
});
```

(`planVersionFixture` — существующий в файле построитель версии плана; если его нет, взять объект плана из соседнего теста и обернуть в функцию с переопределением `offlineAvailable`.)

В `standalone-licenses.test.ts` (контракт выпуска; создать файл, если его нет, по образцу соседних) — три источника и `sourceMatchesReason`:

```ts
import { describe, expect, it } from "vitest";
import { STANDALONE_ISSUANCE_SOURCES, standaloneIssuanceSummarySchema } from "../src/index.js";

describe("standalone issuance sources", () => {
  it("knows the three sources", () => {
    expect([...STANDALONE_ISSUANCE_SOURCES]).toEqual([
      "subscription",
      "offline",
      "offline_assignments",
    ]);
  });

  it("ties each source to its term reasons", () => {
    const ok = (source: string, reason: string, assignments: unknown) =>
      standaloneIssuanceSummarySchema.safeParse(
        summaryFixture({ source, validUntilReason: reason, sourceAssignments: assignments }),
      ).success;
    const refs = [
      {
        kind: "plan",
        id: "6f1b5ea0-0000-4000-8000-000000000002",
        catalogVersionId: "6f1b5ea0-0000-4000-8000-000000000003",
      },
    ];
    expect(ok("offline", "offline_term", null)).toBe(true);
    expect(ok("offline_assignments", "one_year_cap", refs)).toBe(true);
    expect(ok("offline_assignments", "offline_term", refs)).toBe(false);
    expect(ok("offline_assignments", "one_year_cap", null)).toBe(false);
    expect(ok("subscription", "offline_term", null)).toBe(false);
  });
});
```

(`summaryFixture` — собрать из полей `standaloneIssuanceSummarySchema`: `licenseId, siteId, sequence, hostId, source, plan:"subscription", planVersionId, entitlementRevision:"5", validFrom, validUntil, validUntilReason, graceDays:14, kid, sha256, issuedAt, issuedByPlatformUserId, replaces:null, customer:{name,inn}, rights, sourceAssignments`; взять значения из `apps/saas-admin/test/standalone-fixtures.ts`.)

В `tenants.test.ts` — ответ выдачи кабинета:

```ts
it("describes the offline assignments a cabinet grant left in place", () => {
  const base = {
    tenantId: "t1",
    userId: "u",
    memberId: "m",
    deliveryId: "6f1b5ea0-0000-4000-8000-000000000004",
  };
  expect(
    grantCabinetAccessResponseSchema.safeParse({
      ...base,
      offlineAssignments: { plans: 1, addons: 2 },
      demoCreated: false,
    }).success,
  ).toBe(true);
  expect(grantCabinetAccessResponseSchema.safeParse(base).success).toBe(false);
});
```

- [ ] **Step 2: Запустить — упасть**

Run: `pnpm --filter @markiro/platform-contracts exec vitest run test/catalog.test.ts test/tenants.test.ts test/standalone-licenses.test.ts`
Expected: FAIL (отсутствуют экспорты / поле).

- [ ] **Step 3: Реализация**

`tenants.ts`: в `assignableCatalogVersionSchema` после `catalogItemCode` добавить `offlineAvailable: z.boolean(),`. В `grantCabinetAccessResponseSchema` добавить

```ts
  offlineAssignments: z.object({
    plans: z.number().int().min(0),
    addons: z.number().int().min(0),
  }),
  demoCreated: z.boolean(),
```

`catalog.ts` (рядом с `archiveCatalogItemResponseSchema`):

```ts
export const catalogOfflineAvailabilityBodySchema = z
  .object({
    offlineAvailable: z.boolean(),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();
export const catalogOfflineAvailabilityResponseSchema = z
  .object({
    catalogItemId: platformUuidSchema,
    catalogItemCode: z.string().min(1).max(128),
    kind: z.enum(["plan", "addon"]),
    offlineAvailable: z.boolean(),
    changed: z.boolean(),
    offlineTenantHolders: z.number().int().min(0),
  })
  .strict();
```

и в `platformCatalogContracts` после `archiveItem`:

```ts
  setOfflineAvailability: {
    params: catalogItemParamsSchema,
    body: catalogOfflineAvailabilityBodySchema,
    response: catalogOfflineAvailabilityResponseSchema,
  },
```

плюс типы `CatalogOfflineAvailabilityBody`/`Response`. Убедиться, что `platformUuidSchema` импортирован в `catalog.ts` (иначе импорт из `./primitives.js`).

`standalone-licenses.ts`: `STANDALONE_ISSUANCE_SOURCES = ["subscription", "offline", "offline_assignments"] as const`; новая схема

```ts
export const standaloneAssignmentRefSchema = z
  .object({
    kind: z.enum(["plan", "addon"]),
    id: platformUuidSchema,
    catalogVersionId: platformUuidSchema,
  })
  .strict();
export const standaloneAssignmentRefsSchema = z.array(standaloneAssignmentRefSchema).min(1).max(65);
```

`sourceMatchesReason` принимает `sourceAssignments` и возвращает:

```ts
function sourceMatchesReason(value: {
  source: StandaloneIssuanceSource;
  plan: "demo" | "subscription";
  validUntilReason: z.infer<typeof validUntilReasonSchema>;
  sourceAssignments: unknown[] | null;
}): boolean {
  if (value.source === "offline")
    return (
      value.validUntilReason === "offline_term" &&
      value.plan === "subscription" &&
      value.sourceAssignments === null
    );
  if (value.source === "offline_assignments")
    return (
      value.validUntilReason !== "offline_term" &&
      value.plan === "subscription" &&
      value.sourceAssignments !== null
    );
  return value.validUntilReason !== "offline_term" && value.sourceAssignments === null;
}
```

В `standaloneIssuanceSummarySchema` и в `standaloneIssuancePreviewSchema.next` добавить `sourceAssignments: standaloneAssignmentRefsSchema.nullable(),`. Схемы запроса (`…PreviewRequestSchema`, `…ConfirmSchema`) не менять (Спец Р7). Экспорты через `index.ts` (проверить, как он реэкспортирует: `export * from "./standalone-licenses.js"` или поимённо).

- [ ] **Step 4: Исправить фикстуры**

Run: `grep -rln "catalogItemCode:" packages/platform-contracts/test apps tools --include='*.ts' --include='*.tsx' | grep -v node_modules` — в каждом файле, где строится объект версии каталога, добавить `offlineAvailable: false` (в `apps/api/test/support/subscription-fixtures.ts` — опция, Task 3). Где строятся строки журнала/предпросмотр (`standalone-fixtures.ts`, `standalone-license-flows.test.tsx`, `standalone-api.test.ts`, `standalone-sites-panel.test.tsx`) — `sourceAssignments: null`. Этот шаг доводит до зелёного ТОЛЬКО пакет контрактов; сборки потребителей чинят их задачи (Task 3, 5–8), но фикстуры saas-admin и production-browser правятся здесь же, чтобы их наборы не краснели.

- [ ] **Step 5: Прогон**

Run: `pnpm --filter @markiro/platform-contracts build && pnpm --filter @markiro/platform-contracts test && pnpm --filter @markiro/platform-contracts typecheck && pnpm --filter @markiro/platform-contracts lint`
Expected: PASS. Затем `pnpm --filter @markiro/saas-admin typecheck` — ожидаются ошибки только там, где ещё не подключено новое поле в коде (исправляются в Task 6–8); фикстурные ошибки должны отсутствовать.

- [ ] **Step 6: Коммит**

```bash
git add packages/platform-contracts/src packages/platform-contracts/test apps/saas-admin/test tools/production-browser/service-periods-tests/fixture.ts
git commit -m "feat(contracts): offlineAvailable on catalog versions, offline-availability action, assignments source"
```

---

### Task 3: API — страж «вид + флаг» и маршрут флага

**Files:**

- Modify: `apps/api/src/subscriptions/tenant-cabinet-access.ts`
- Modify: `apps/api/src/subscriptions/subscription-lifecycle.service.ts` (стр. 21, 345, 589)
- Modify: `apps/api/src/modules/billing/billing.service.ts` (стр. 56, 163–166)
- Modify: `apps/api/src/modules/platform-offers/platform-offer-draft.ts` (стр. 12, 48)
- Modify: `apps/api/src/modules/platform-catalog/platform-catalog.service.ts` (`toDto`, `updateVersion`, новый `setOfflineAvailability`)
- Modify: `apps/api/src/modules/platform-catalog/platform-catalog.controller.ts`, `dto.ts`
- Modify: `apps/api/test/support/subscription-fixtures.ts` (опция `offlineAvailable`)
- Test: `apps/api/test/tenant-cabinet-access-guard.e2e.test.ts`, `apps/api/test/platform-catalog.e2e.test.ts`, `apps/api/test/platform-route-contracts.ts`, `apps/api/test/platform-contract-openapi.test.ts`, `apps/api/test/grant-cabinet-access.e2e.test.ts` (код стража)

**Interfaces:**

- Consumes: Task 1 (`catalogItems.offlineAvailable`), Task 2 (контракты).
- Produces: `assertCatalogAllowedForTenant(tx, tenantId, { kind, catalogVersionId })`; `PlatformCatalogService.setOfflineAvailability(principal, itemRef, input)`; маршрут `PATCH /platform/catalog/items/:id/offline-availability`; фикстура `createPublishedPlan(db, { …, offlineAvailable?: boolean })` и `createPublishedAddon(db, effects, { offlineAvailable? })`.

- [ ] **Step 1: Фикстуры с флагом**

В `apps/api/test/support/subscription-fixtures.ts`: в `createPublishedPlan` добавить в тип входа `offlineAvailable?: boolean` и в вставку позиции `offlineAvailable: input.offlineAvailable ?? false`; в `createPublishedAddon` третьим параметром `options: { offlineAvailable?: boolean } = {}` и то же поле при вставке позиции. Отдельный помощник:

```ts
export async function setItemOfflineAvailable(db: Db, versionId: string, value: boolean) {
  const [version] = await db
    .select({ itemId: schema.catalogItemVersions.catalogItemId })
    .from(schema.catalogItemVersions)
    .where(eq(schema.catalogItemVersions.id, versionId));
  if (!version) throw new Error("fixture version missing");
  await db
    .update(schema.catalogItems)
    .set({ offlineAvailable: value })
    .where(eq(schema.catalogItems.id, version.itemId));
}
```

- [ ] **Step 2: Падающие e2e стража**

В `tenant-cabinet-access-guard.e2e.test.ts`: `createPublishedVersion(kind, demoDurationDays, offline = false)` — при `offline` проставляет `offlineAvailable: true` в `catalogItems.values`. В `beforeAll` добавить `offlinePlanVersionId = await createPublishedVersion("plan", null, true)` и `offlineAddonVersionId = await createPublishedVersion("addon", null, true)`. Новые тесты:

```ts
it("assigns an offline-flagged plan and add-on to a none tenant", async () => {
  const id = await createOfflineTenant();
  const plan = await admin
    .post(`/platform/tenants/${id}/subscription/plan`)
    .set("X-Markiro-Commercial-Version", "2")
    .send({
      catalogVersionId: offlinePlanVersionId,
      activationPolicy: "immediate",
      reason: "Поставка автонома",
    })
    .expect(201);
  const subscriptionId = (plan.body as { id: string }).id;
  await admin
    .post(`/platform/tenants/${id}/subscription/addons`)
    .set("X-Markiro-Commercial-Version", "2")
    .send({
      catalogVersionId: offlineAddonVersionId,
      activationPolicy: "immediate",
      quantity: 2,
      reason: "Две линии",
      expectedSubscriptionId: subscriptionId,
    })
    .expect(201);
  expect(await subscriptionCount(id)).toBe(1);
  const audit = await setup.db
    .select()
    .from(schema.platformAuditEvents)
    .where(eq(schema.platformAuditEvents.tenantId, id));
  expect(audit.map((row) => row.action).sort()).toEqual([
    "platform.tenant.subscription.addon_assigned",
    "platform.tenant.subscription.plan_assigned",
  ]);
});

it("refuses an unflagged plan and add-on for a none tenant, also in offers and invoices", async () => {
  const id = await createOfflineTenant();
  const refused = await admin
    .post(`/platform/tenants/${id}/subscription/plan`)
    .set("X-Markiro-Commercial-Version", "2")
    .send({ catalogVersionId: planVersionId, activationPolicy: "immediate", reason: "x" });
  expect(refused.status).toBe(409);
  expect((refused.body as { code: string }).code).toBe(OFFLINE_CODE);
  const offer = await admin
    .post("/platform/offers")
    .set("X-Markiro-Commercial-Version", "2")
    .send({ tenantId: id, lines: [offerLine("plan", planVersionId)] });
  expect(offer.status).toBe(409);
  await admin
    .post("/platform/offers")
    .set("X-Markiro-Commercial-Version", "2")
    .send({ tenantId: id, lines: [offerLine("plan", offlinePlanVersionId)] })
    .expect(201);
});

it("does not let one tenant's assignment admit another tenant's unflagged plan", async () => {
  const flagged = await createOfflineTenant();
  const other = await createOfflineTenant();
  await admin
    .post(`/platform/tenants/${flagged}/subscription/plan`)
    .set("X-Markiro-Commercial-Version", "2")
    .send({ catalogVersionId: offlinePlanVersionId, activationPolicy: "immediate", reason: "x" })
    .expect(201);
  const refused = await admin
    .post(`/platform/tenants/${other}/subscription/plan`)
    .set("X-Markiro-Commercial-Version", "2")
    .send({ catalogVersionId: planVersionId, activationPolicy: "immediate", reason: "x" });
  expect(refused.status).toBe(409);
  expect(await subscriptionCount(other)).toBe(0);
});
```

Существующий тест «assign plan to a none tenant is refused with 409» остаётся (`planVersionId` без флага) — теперь он проверяет именно «без флага». Гонка со снятием флага (замок строки позиции), детерминированно, без барьерных триггеров:

```ts
it("makes an assignment wait for a withdrawal that holds the item row lock, then refuses it", async () => {
  const id = await createOfflineTenant();
  const [version] = await setup.db
    .select({ itemId: schema.catalogItemVersions.catalogItemId })
    .from(schema.catalogItemVersions)
    .where(eq(schema.catalogItemVersions.id, offlinePlanVersionId));
  const client = await setup.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM catalog_items WHERE id = $1 FOR UPDATE", [version!.itemId]);
    let settled = false;
    const assignment = admin
      .post(`/platform/tenants/${id}/subscription/plan`)
      .set("X-Markiro-Commercial-Version", "2")
      .send({ catalogVersionId: offlinePlanVersionId, activationPolicy: "immediate", reason: "x" })
      .then((response) => {
        settled = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false);
    await client.query("UPDATE catalog_items SET offline_available = false WHERE id = $1", [
      version!.itemId,
    ]);
    await client.query("COMMIT");
    const response = await assignment;
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe(OFFLINE_CODE);
    expect(await subscriptionCount(id)).toBe(0);
  } finally {
    client.release();
    await setup.db
      .update(schema.catalogItems)
      .set({ offlineAvailable: true })
      .where(eq(schema.catalogItems.id, version!.itemId));
  }
});
```

- [ ] **Step 3: Падающие e2e флага**

В `apps/api/test/platform-catalog.e2e.test.ts` (в файле уже есть агенты `admin`, `accountant`, `support`, `adminId`, `setup`, тело `basicPlan`, помощник `publishHttp`) добавить импорты `createManagedSubscription`, `createOrganization` из `./support/subscription-fixtures` и `createTenantWithoutCabinet` из `./support/standalone-license-fixture`, затем блок:

```ts
describe("offline availability of a catalog item", () => {
  const flagPath = (code: string) => `/platform/catalog/items/${code}/offline-availability`;

  async function publishedPlan() {
    const draft = await admin
      .post(`/platform/catalog/items/plan-offline-${randomUUID()}/versions`)
      .send(basicPlan)
      .expect(201);
    const versionPath = `/platform/catalog/items/${draft.body.catalogItemCode}/versions/${draft.body.id}`;
    await publishHttp(versionPath);
    return {
      code: draft.body.catalogItemCode as string,
      itemId: draft.body.catalogItemId as string,
      versionId: draft.body.id as string,
      versionPath,
    };
  }

  async function flagAudit(itemId: string) {
    return setup.db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.targetId, itemId),
          eq(schema.platformAuditEvents.action, "catalog.item.offline_availability_changed"),
        ),
      );
  }

  it("changes the flag with an exact audit row and is idempotent", async () => {
    const { code, itemId, versionId } = await publishedPlan();
    expect(
      (await admin.get(`/platform/catalog/items/${code}/versions/${versionId}`).expect(200)).body
        .offlineAvailable,
    ).toBe(false);
    const first = await admin
      .patch(flagPath(code))
      .send({ offlineAvailable: true, reason: "Поставка автонома" })
      .expect(200);
    expect(first.body).toEqual({
      catalogItemId: itemId,
      catalogItemCode: code,
      kind: "plan",
      offlineAvailable: true,
      changed: true,
      offlineTenantHolders: 0,
    });
    const [audit] = await flagAudit(itemId);
    expect(audit).toMatchObject({
      actorPlatformUserId: adminId,
      actorRole: "platform_admin",
      tenantId: null,
      targetType: "catalog_item",
      targetId: itemId,
      outcome: "success",
      reason: "Поставка автонома",
      before: { offlineAvailable: false },
      after: {
        offlineAvailable: true,
        catalogItemCode: code,
        kind: "plan",
        offlineTenantHolders: 0,
      },
    });
    const again = await admin
      .patch(flagPath(code))
      .send({ offlineAvailable: true, reason: "Повтор" })
      .expect(200);
    expect(again.body).toMatchObject({ changed: false, offlineAvailable: true });
    expect(await flagAudit(itemId)).toHaveLength(1);
    expect(
      (await admin.get(`/platform/catalog/items/${code}/versions/${versionId}`).expect(200)).body
        .offlineAvailable,
    ).toBe(true);
  });

  it("refuses services, archived and unknown items and every role but platform_admin, with no audit row", async () => {
    const body = { offlineAvailable: true, reason: "x" };
    const serviceCode = `service-offline-${randomUUID()}`;
    const [service] = await setup.db
      .insert(schema.catalogItems)
      .values({ code: serviceCode, nameRu: "Услуга", nameEn: "Service", kind: "service" })
      .returning();
    const serviceRefusal = await admin.patch(flagPath(serviceCode)).send(body);
    expect(serviceRefusal.status).toBe(409);
    expect(serviceRefusal.body).toMatchObject({ code: "catalog_item_offline_kind_invalid" });
    expect(await flagAudit(service!.id)).toHaveLength(0);

    const { code, itemId, versionPath } = await publishedPlan();
    for (const [agent, status, errorCode] of [
      [accountant, 409, "catalog_offline_availability_forbidden"],
      [support, 403, undefined],
    ] as const) {
      const refusal = await agent.patch(flagPath(code)).send(body);
      expect(refusal.status).toBe(status);
      if (errorCode) expect(refusal.body).toMatchObject({ code: errorCode });
    }
    expect(await flagAudit(itemId)).toHaveLength(0);

    const unknown = await admin.patch(flagPath(`plan-missing-${randomUUID()}`)).send(body);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: "catalog_item_not_found" });

    await accountant.post(`${versionPath}/retire`).send({}).expect(200);
    await admin.post(`/platform/catalog/items/${code}/archive`).send({}).expect(200);
    const archived = await admin.patch(flagPath(code)).send(body);
    expect(archived.status).toBe(409);
    expect(archived.body).toMatchObject({ code: "catalog_item_archived" });
    expect(await flagAudit(itemId)).toHaveLength(0);
  });

  it("counts only tenants without a cabinet and keeps their assignments when the flag is withdrawn", async () => {
    const { code, versionId } = await publishedPlan();
    await admin.patch(flagPath(code)).send({ offlineAvailable: true, reason: "on" }).expect(200);
    const noneTenant = await createTenantWithoutCabinet(setup.db);
    const enabledTenant = await createOrganization(setup.db);
    await createManagedSubscription(setup.db, {
      tenantId: noneTenant,
      planVersionId: versionId,
      status: "active",
    });
    await createManagedSubscription(setup.db, {
      tenantId: enabledTenant,
      planVersionId: versionId,
      status: "active",
    });
    const withdrawn = await admin
      .patch(flagPath(code))
      .send({ offlineAvailable: false, reason: "off" })
      .expect(200);
    expect(withdrawn.body).toMatchObject({
      changed: true,
      offlineAvailable: false,
      offlineTenantHolders: 1,
    });
    const [kept] = await setup.db
      .select({ status: schema.tenantSubscriptions.status })
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, noneTenant));
    expect(kept?.status).toBe("active");
  });

  it("keeps editing a draft version working now that offlineAvailable is a response field", async () => {
    const draft = await admin
      .post(`/platform/catalog/items/plan-offline-draft-${randomUUID()}/versions`)
      .send(basicPlan)
      .expect(201);
    const edited = await admin
      .patch(`/platform/catalog/items/${draft.body.catalogItemCode}/versions/${draft.body.id}`)
      .send({ nameRu: "Правка черновика" })
      .expect(200);
    expect(edited.body).toMatchObject({ nameRu: "Правка черновика", offlineAvailable: false });
  });
});
```

(`and`, `eq` из `drizzle-orm` и `randomUUID` в файле уже импортированы; если нет — добавить. Каждый тест должен падать по правильной причине до реализации: 404 маршрута, `undefined` вместо `offlineAvailable`.)

- [ ] **Step 4: Запустить — упасть**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/db build && pnpm --filter @markiro/platform-contracts build && pnpm --filter @markiro/api exec vitest run test/tenant-cabinet-access-guard.e2e.test.ts test/platform-catalog.e2e.test.ts`
Expected: FAIL (новые тесты: страж отказывает по виду; маршрут `PATCH …/offline-availability` — 404).

- [ ] **Step 5: Страж**

Переписать `apps/api/src/subscriptions/tenant-cabinet-access.ts`:

```ts
import { ConflictException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

export const OFFLINE_TENANT_KIND_ERROR = "catalog_kind_not_allowed_for_offline_tenant";

/**
 * A tenant created without a cabinet may order services, and the plans and
 * add-ons whose catalog item is flagged `offline_available` (spec 2026-10-16).
 * Callers run this inside the transaction that writes. The subscription
 * lifecycle callers hold the tenant subscription timeline lock here, and the
 * cabinet grant takes the same lock before it switches `none` to `enabled`, so
 * for them the check and the grant serialize; they also take the item row
 * FOR SHARE, so a withdrawal of the flag (which locks the row FOR UPDATE and no
 * tenant lock) serializes with them: lock order is timeline, item, version.
 * Offer and invoice drafts take neither lock; that is still safe for the cabinet
 * because access only moves from `none` to `enabled`, and a stale flag read at
 * most admits a document whose licence is re-checked here when it is applied.
 */
export async function assertCatalogAllowedForTenant(
  tx: Pick<Db, "select" | "execute">,
  tenantId: string,
  target: { kind: "plan" | "addon" | "service"; catalogVersionId: string | null },
  options: { lockItem: boolean } = { lockItem: false },
): Promise<void> {
  if (target.kind === "service") return;
  const [tenant] = await tx
    .select({ cabinetAccess: schema.organization.cabinetAccess })
    .from(schema.organization)
    .where(eq(schema.organization.id, tenantId))
    .limit(1);
  if (tenant?.cabinetAccess !== "none") return;
  if (target.catalogVersionId !== null) {
    if (options.lockItem) {
      await tx.execute(sql`
        select item.id from catalog_items item
        join catalog_item_versions version on version.catalog_item_id = item.id
        where version.id = ${target.catalogVersionId} for share of item`);
    }
    const [row] = await tx
      .select({
        offlineAvailable: schema.catalogItems.offlineAvailable,
        kind: schema.catalogItems.kind,
      })
      .from(schema.catalogItemVersions)
      .innerJoin(
        schema.catalogItems,
        eq(schema.catalogItems.id, schema.catalogItemVersions.catalogItemId),
      )
      .where(eq(schema.catalogItemVersions.id, target.catalogVersionId))
      .limit(1);
    if (row?.offlineAvailable === true && row.kind === target.kind) return;
  }
  throw new ConflictException({ code: OFFLINE_TENANT_KIND_ERROR });
}
```

Вызовы: `subscription-lifecycle.service.ts:345` → `await assertCatalogAllowedForTenant(tx, tenantId, { kind: "plan", catalogVersionId: input.catalogVersionId }, { lockItem: true });` (импорт переименовать, строка 21); `:589` — `kind: "addon"` с `lockItem: true`; `billing.service.ts:165` — `await assertCatalogAllowedForTenant(tx, normalizedInput.tenantId, { kind: line.kind, catalogVersionId: line.catalogVersionId ?? null });` (у строки счёта поле версии называется так же — проверить тип `line`, при расхождении использовать фактическое имя); `platform-offer-draft.ts:48` — `{ kind: line.kind, catalogVersionId: line.catalogVersionId ?? null }`. Для строки `service` проверка возвращается раньше. Другие вызовы (`tenant-provisioning.service.ts` — только комментарий) обновить текст комментария.

- [ ] **Step 6: Сервис и маршрут флага**

В `platform-catalog.service.ts`: в `common` внутри `toDto` добавить `offlineAvailable: item.offlineAvailable,`; в `updateVersion` в набор `responseFields` добавить `"offlineAvailable"` (иначе правка черновика склеит поле ответа с телом и строгая схема её отвергнет — Спец §14, риск 10). Новый метод:

```ts
  async setOfflineAvailability(
    principal: PlatformPrincipal,
    itemRef: string,
    input: CatalogOfflineAvailabilityBody,
  ): Promise<CatalogOfflineAvailabilityResponse> {
    if (principal.role !== "platform_admin")
      throw new ConflictException({ code: "catalog_offline_availability_forbidden" });
    try {
      return await this.db.transaction(async (tx) => {
        const found = await this.findItem(itemRef, tx);
        if (!found) throw new NotFoundException({ code: "catalog_item_not_found" });
        const item = await this.lockItem(tx, found.id);
        if (item.status === "archived") throw new ConflictException({ code: "catalog_item_archived" });
        if (item.kind !== "plan" && item.kind !== "addon")
          throw new ConflictException({ code: "catalog_item_offline_kind_invalid" });
        const holders = await this.offlineTenantHolders(tx, item.id);
        const answer = {
          catalogItemId: item.id,
          catalogItemCode: item.code,
          kind: item.kind,
          offlineAvailable: input.offlineAvailable,
          offlineTenantHolders: holders,
        } as const;
        if (item.offlineAvailable === input.offlineAvailable) return { ...answer, changed: false };
        await tx
          .update(schema.catalogItems)
          .set({ offlineAvailable: input.offlineAvailable, updatedAt: sql`now()` })
          .where(eq(schema.catalogItems.id, item.id));
        await this.audit.record(tx, {
          actorPlatformUserId: principal.userId,
          actorRole: principal.role,
          action: "catalog.item.offline_availability_changed",
          outcome: "success",
          tenantId: null,
          targetType: "catalog_item",
          targetId: item.id,
          reason: input.reason,
          before: { offlineAvailable: item.offlineAvailable },
          after: {
            offlineAvailable: input.offlineAvailable,
            catalogItemCode: item.code,
            kind: item.kind,
            offlineTenantHolders: holders,
          },
          requestId: null,
        });
        return { ...answer, changed: true };
      });
    } catch (error) {
      catalogDatabaseError(error);
    }
  }

  /** Tenants without a cabinet holding a live assignment of any version of the item. */
  private async offlineTenantHolders(tx: CatalogTransaction, itemId: string): Promise<number> {
    const result = await tx.execute<{ holders: number }>(sql`
      select count(distinct holder.tenant_id)::int as holders from (
        select s.tenant_id from tenant_subscriptions s
          join catalog_item_versions v on v.id = s.plan_version_id
         where v.catalog_item_id = ${itemId}
           and s.status in ('pending_activation', 'trial', 'active', 'scheduled')
        union all
        select a.tenant_id from subscription_addons a
          join catalog_item_versions v on v.id = a.addon_version_id
         where v.catalog_item_id = ${itemId} and a.status in ('active', 'scheduled')
      ) holder
      join organization o on o.id = holder.tenant_id and o.cabinet_access = 'none'`);
    return result.rows[0]?.holders ?? 0;
  }
```

(`ConflictException`, `NotFoundException`, `sql`, `eq` уже импортированы в файле — проверить; тип `CatalogTransaction` использует `lockItem` в файле. Типы `CatalogOfflineAvailability*` — из `@markiro/platform-contracts`.)

Контроллер, после `archive`:

```ts
  @Patch("items/:id/offline-availability")
  @ApiOperation({ summary: "Mark a catalog item as available to tenants without a cabinet" })
  @PlatformApiProtectedOk({
    body: platformCatalogContracts.setOfflineAvailability.body,
    response: platformCatalogContracts.setOfflineAvailability.response,
  })
  @RequirePlatformCapabilities("catalog.write")
  async setOfflineAvailability(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Body(new ZodValidationPipe(catalogOfflineAvailabilityBodySchema)) body: CatalogOfflineAvailabilityBody,
  ) {
    return parsePlatformResponse(
      platformCatalogContracts.setOfflineAvailability.response,
      await this.catalog.setOfflineAvailability(request.platformPrincipal!, id, body),
    );
  }
```

Импорты: `catalogOfflineAvailabilityBodySchema` и тип — через `dto.ts` (реэкспорт), как соседние. Сверить, что `PlatformApiProtectedOk` принимает `body` без `commercialV*` (маршрут `archive` его не задаёт; `PATCH` версий — задаёт; если декоратор требует `commercialV2`, использовать форму архивного маршрута без `body` и вынести тело в схему `@Body` — тогда тело задокументировать `@ApiBody`; решение принять по фактической сигнатуре декоратора).

- [ ] **Step 7: Реестр маршрутов и OpenAPI**

В `apps/api/test/platform-route-contracts.ts` после строки `archive` добавить:

```ts
  route(
    "patch",
    "/platform/catalog/items/{id}/offline-availability",
    "200",
    platformCatalogContracts.setOfflineAvailability.response,
    { body: platformCatalogContracts.setOfflineAvailability.body },
  ),
```

Запустить `pnpm --filter @markiro/api exec vitest run test/platform-contract-openapi.test.ts test/openapi-coverage.test.ts test/subscription-route-inventory.test.ts`; в `platform-contract-openapi.test.ts` обновить `CURRENT_SHARED_SCHEMAS toHaveLength(266)` на число из сообщения падения (добавлены именованные схемы Task 2). Если `subscription-route-inventory` требует строку для платформенного маршрута — добавить по образцу соседнего каталожного.

- [ ] **Step 8: Прогон**

Run: `pnpm --filter @markiro/api exec vitest run test/tenant-cabinet-access-guard.e2e.test.ts test/platform-catalog.e2e.test.ts test/grant-cabinet-access.e2e.test.ts test/platform-contract-openapi.test.ts test/openapi-coverage.test.ts test/subscription-route-inventory.test.ts test/commercial-v4.integration.test.ts`
Expected: PASS. Затем `pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint`.
Дополнительно (риск 6, Спец §14) — исследование без записи кода: открыть `applyPaidLicense` (`subscription-lifecycle.service.ts`) и вызывающие его пути оплаты (`grep -rn "applyPaidLicense" apps/api/src`) и определить, что происходит с платежом, когда `assignPlanInTransaction` бросает `ConflictException(catalog_kind_not_allowed_for_offline_tenant)`: откатывается ли вся транзакция оплаты, остаётся ли документ в состоянии, из которого оператор может повторить применение после возврата флага. Результат записать абзацем в Спец §14 (риск 6) и в отчёт. Если оплата застревает без пути повтора — это блокер до выкладки: остановиться и доложить владельцу (вопрос В4 меняет ответ на «запретить снятие, пока есть открытые документы»).

- [ ] **Step 9: Коммит**

```bash
git add apps/api/src/subscriptions apps/api/src/modules/billing/billing.service.ts \
  apps/api/src/modules/platform-offers/platform-offer-draft.ts apps/api/src/modules/platform-catalog \
  apps/api/test
git commit -m "feat(api): offline-flagged catalog items for tenants without a cabinet"
```

---

### Task 4: API — выдача кабинета клиенту с офлайн-назначениями

**Files:**

- Modify: `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts` (`grantCabinetAccessInTransaction`, тип `GrantCabinetAccessResult`)
- Modify: `apps/api/src/modules/platform-tenants/platform-tenants.service.ts`, `platform-tenants.controller.ts` (проброс нового ответа)
- Test: `apps/api/test/grant-cabinet-access.e2e.test.ts`

**Interfaces:**

- Consumes: Task 2 (`grantCabinetAccessResponseSchema`).
- Produces: `GrantCabinetAccessResult` с `offlineAssignments: { plans: number; addons: number }` и `demoCreated: boolean`; аудит `platform.tenant.cabinet_access.granted` с расширенным `after`.

- [ ] **Step 1: Падающие тесты**

В `grant-cabinet-access.e2e.test.ts` (в файле есть `admin`, `createNoneTenant()`, `grantedEmail()`, `planVersionId`, `demoVersionId`, `defaultDemo`, `tenantState`, `setup`) добавить импорт `createManagedSubscription` из `./support/subscription-fixtures` (назначение вставляется напрямую, как это сделал бы страж; флаг для вставки не нужен) и тесты:

```ts
async function auditFor(tenantId: string, action: string) {
  return setup.db
    .select()
    .from(schema.platformAuditEvents)
    .where(
      and(
        eq(schema.platformAuditEvents.tenantId, tenantId),
        eq(schema.platformAuditEvents.action, action),
      ),
    );
}

async function subscriptionRows(tenantId: string) {
  return setup.db
    .select({
      id: schema.tenantSubscriptions.id,
      planVersionId: schema.tenantSubscriptions.planVersionId,
      status: schema.tenantSubscriptions.status,
      endsAt: schema.tenantSubscriptions.endsAt,
    })
    .from(schema.tenantSubscriptions)
    .where(eq(schema.tenantSubscriptions.tenantId, tenantId))
    .orderBy(schema.tenantSubscriptions.id);
}

it("keeps an offline plan assignment and creates no demo when the cabinet is granted", async () => {
  const tenantId = await createNoneTenant();
  const assigned = await createManagedSubscription(setup.db, {
    tenantId,
    planVersionId,
    status: "active",
  });
  const before = await subscriptionRows(tenantId);

  const response = await admin
    .post(`/platform/tenants/${tenantId}/cabinet-access`)
    .send({ email: grantedEmail() })
    .expect(201);

  expect(response.body).toMatchObject({
    tenantId,
    offlineAssignments: { plans: 1, addons: 0 },
    demoCreated: false,
  });
  expect(await subscriptionRows(tenantId)).toEqual(before);
  expect(before.map((row) => row.id)).toEqual([assigned.subscriptionId]);
  const [audit] = await auditFor(tenantId, "platform.tenant.cabinet_access.granted");
  expect(audit).toMatchObject({
    actorPlatformUserId: adminId,
    actorRole: "platform_admin",
    targetType: "member",
    before: { cabinetAccess: "none" },
    after: {
      cabinetAccess: "enabled",
      demoCreated: false,
      subscriptionId: null,
      subscriptionStatus: null,
      planVersionId: null,
      offlineAssignments: { plans: 1, addons: 0 },
    },
  });
});

it("grants without a configured default demo when a current assignment exists, and still refuses without one", async () => {
  await defaultDemo.install(planVersionId); // a plan without a demo duration is no usable default demo
  try {
    const held = await createNoneTenant();
    await createManagedSubscription(setup.db, { tenantId: held, planVersionId, status: "active" });
    await admin
      .post(`/platform/tenants/${held}/cabinet-access`)
      .send({ email: grantedEmail() })
      .expect(201);
    const bare = await createNoneTenant();
    const refused = await admin
      .post(`/platform/tenants/${bare}/cabinet-access`)
      .send({ email: grantedEmail() })
      .expect(409);
    expect(refused.body.code).toBe("default_demo_not_configured");
  } finally {
    await defaultDemo.install(demoVersionId);
  }
});

it("still creates the pending demo when the only subscription has expired", async () => {
  const tenantId = await createNoneTenant();
  await createManagedSubscription(setup.db, {
    tenantId,
    planVersionId,
    status: "active",
    startsAt: new Date(Date.now() - 7_200_000),
    endsAt: new Date(Date.now() - 3_600_000),
  });
  await setup.db
    .update(schema.tenantSubscriptions)
    .set({ status: "expired" })
    .where(eq(schema.tenantSubscriptions.tenantId, tenantId));
  const response = await admin
    .post(`/platform/tenants/${tenantId}/cabinet-access`)
    .send({ email: grantedEmail() })
    .expect(201);
  expect(response.body).toMatchObject({
    offlineAssignments: { plans: 0, addons: 0 },
    demoCreated: true,
  });
  const rows = await subscriptionRows(tenantId);
  expect(rows.map((row) => row.status).sort()).toEqual(["expired", "pending_activation"]);
});
```

(`adminId`, `and`, `eq` — проверить, что они есть в файле; иначе взять id актора как другие тесты файла, например `actorPlatformUserId` в тесте «denies the accountant…».)

- [ ] **Step 2: Запустить — упасть**

Run: `pnpm --filter @markiro/api exec vitest run test/grant-cabinet-access.e2e.test.ts`
Expected: FAIL (ответ без `demoCreated`, вставка демо падает на `tenant_subscriptions_one_current_uq`).

- [ ] **Step 3: Реализация**

В `grantCabinetAccessInTransaction` после проверки `cabinetAccess` и до `lockDefaultDemo`:

```ts
const [current] = await tx
  .select({ id: schema.tenantSubscriptions.id })
  .from(schema.tenantSubscriptions)
  .where(
    and(
      eq(schema.tenantSubscriptions.tenantId, tenantId),
      inArray(schema.tenantSubscriptions.status, ["pending_activation", "trial", "active"]),
    ),
  )
  .limit(1);
const offlineAssignments = await this.countAssignments(tx, tenantId);
// One current subscription per tenant (tenant_subscriptions_one_current_uq): an
// offline plan assignment already is that subscription, so no demo is added.
const demo = current ? null : await this.lockDefaultDemo(tx, false);
if (!current && !demo) throw new ConflictException({ code: "default_demo_not_configured" });
```

(заменив прежние две строки `const demo = …; if (!demo) throw …`). После `provisionOwner` и обновления `cabinetAccess`: `const subscriptionId = demo ? await this.insertPendingDemo(tx, {...}) : null;`. В аудите `after`: `subscriptionId`, `subscriptionStatus: demo ? "pending_activation" : null`, `planVersionId: demo?.versionId ?? null`, плюс `demoCreated: demo !== null`, `offlineAssignments`. Результат метода — добавить `offlineAssignments`, `demoCreated`. Новый приватный метод:

```ts
  private async countAssignments(tx: ProvisionTransaction, tenantId: string) {
    const [plans] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.tenantSubscriptions)
      .where(and(
        eq(schema.tenantSubscriptions.tenantId, tenantId),
        inArray(schema.tenantSubscriptions.status, ["pending_activation", "trial", "active", "scheduled"]),
      ));
    const [addons] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.subscriptionAddons)
      .where(and(
        eq(schema.subscriptionAddons.tenantId, tenantId),
        inArray(schema.subscriptionAddons.status, ["active", "scheduled"]),
      ));
    return { plans: plans?.count ?? 0, addons: addons?.count ?? 0 };
  }
```

Типы результата (`GrantCabinetAccessResult`) и пробрасывающие слои (`platform-tenants.service.ts`, контроллер: `parsePlatformResponse(platformTenantContracts.grantCabinetAccess.response, …)`) — добавить два поля. Импорты `inArray`, `and`, `sql` — проверить в шапке. Порядок замков не меняется (демо-замки берутся только когда демо нужно; он остаётся «e-mail → slug → линия → организация → демо»).

- [ ] **Step 4: Прогон**

Run: `pnpm --filter @markiro/api exec vitest run test/grant-cabinet-access.e2e.test.ts test/tenant-provisioning*.test.ts test/platform-contract-openapi.test.ts` и `pnpm --filter @markiro/api typecheck`.
Expected: PASS. Проверить, что `activatePendingDemo` для клиента без ожидающего демо возвращает `null` (тест активации владельца у клиента с назначением — добавить в этот же файл: активация не создаёт и не меняет подписки).

- [ ] **Step 5: Коммит**

```bash
git add apps/api/src/modules/platform-tenants apps/api/test/grant-cabinet-access.e2e.test.ts
git commit -m "feat(api): cabinet grant keeps offline assignments and skips the demo"
```

---

### Task 5: API — выпуск лицензии из назначений клиента без кабинета

**Files:**

- Modify: `apps/api/src/modules/standalone-licenses/standalone-license-authority.ts` (`issuanceSourceFor`)
- Modify: `apps/api/src/modules/standalone-licenses/standalone-license-issuance.service.ts`
- Modify: `apps/api/src/modules/standalone-licenses/standalone-license-rights.ts` (удаление `exportPlanRights`, `PlanEntitlementRow`, `offlineValidity`; `LicenseValidity.reason` остаётся)
- Modify: `apps/api/src/modules/standalone-licenses/standalone-license-views.ts` (`sourceAssignments` в `issuanceSummary`/`licenseFile`)
- Test: `apps/api/test/standalone-license-issuance.e2e.test.ts`, `apps/api/test/standalone-license-rights.test.ts`, `apps/api/test/platform-standalone-licenses.routes.test.ts`

**Interfaces:**

- Consumes: Tasks 1–2, `EntitlementsService.loadSnapshotTimeline`, снимок прав `EntitlementSnapshotV1.sources`.
- Produces: путь `offline_assignments`; коды `standalone_license_assignments_required`, `standalone_license_offline_terms_removed`; журнал/аудит с `sourceAssignments`.

- [ ] **Step 1: Падающие e2e**

В `standalone-license-issuance.e2e.test.ts` (в файле уже есть `db`, `clock`, `DAY`, `issuance`, `sites`, `NO_FEATURES`, `UNMAPPED`, `httpRefusal`, `issuedRows`, `trustedKeyset`, `cloudFootprint`) заменить помощник `offlineSiteFor` (стр. ~822) и блок `describe(… "offline licenses for a tenant without a cabinet" …)` (стр. ~893–1170: пять тестов «issues a file from offline terms…», «requires offline terms…», «refuses the offline file when the tenant got a cabinet…», «refuses offline terms or a sequence…», «denies support and accountant…»). Помощник:

```ts
type OfflineAssignments = {
  plan?: {
    maxLines: number | null;
    maxStations: number | null;
    maxKiosks: number | null;
    maxCabinetUsers: number | null;
  };
  endsAt?: Date | null;
  addonLines?: { increment: number; quantity: number; endsAt?: Date | null };
};

/** A tenant without a cabinet, its organization INN, one site and its direct assignments (spec 2026-10-16). */
async function offlineSiteFor(
  assign: OfflineAssignments = {
    plan: { maxLines: 1, maxStations: 2, maxKiosks: 0, maxCabinetUsers: 3 },
  },
) {
  clock = new Date();
  const admin = await platformActor(db);
  const tenantId = await createTenantWithoutCabinet(db);
  await setTenantInns(db, tenantId, { org: "7707083893" });
  const request = activationRequest({ inn: "7707083893" });
  const site = await sites.register(admin, tenantId, {
    intent: "create",
    requestId: randomUUID(),
    name: "Офлайн-цех",
    request,
    acknowledgedWarnings: [],
  });
  let subscriptionId = "";
  let planVersionId = "";
  let addonVersionId = "";
  let addonId = "";
  if (assign.plan) {
    const managed = await createManagedSubscription(db, {
      tenantId,
      status: "active",
      startsAt: new Date(clock.getTime() - 60_000),
      endsAt: assign.endsAt === undefined ? null : assign.endsAt,
      ...assign.plan,
    });
    subscriptionId = managed.subscriptionId;
    planVersionId = managed.planVersionId;
    if (assign.addonLines) {
      addonVersionId = await createPublishedAddon(db, [
        { entitlementKey: "lines", increment: assign.addonLines.increment },
      ]);
      const [addon] = await db
        .insert(schema.subscriptionAddons)
        .values({
          tenantId,
          subscriptionId,
          addonVersionId,
          quantity: assign.addonLines.quantity,
          startsAt: new Date(clock.getTime() - 60_000),
          endsAt: assign.addonLines.endsAt ?? null,
          status: "active",
          source: "manual",
        })
        .returning({ id: schema.subscriptionAddons.id });
      addonId = addon!.id;
    }
  }
  return { admin, tenantId, site, subscriptionId, planVersionId, addonVersionId, addonId };
}
```

Блок тестов:

```ts
describe.skipIf(!process.env.DATABASE_URL)(
  "offline licenses from the assignments of a tenant without a cabinet (spec 2026-10-16)",
  () => {
    it("issues a file from the plan and add-on assignments with an exact journal row and audit", async () => {
      const f = await offlineSiteFor({
        plan: { maxLines: 2, maxStations: 3, maxKiosks: 0, maxCabinetUsers: 5 },
        addonLines: { increment: 3, quantity: 2 },
        endsAt: null,
      });
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      const assignments = [
        { kind: "plan", id: f.subscriptionId, catalogVersionId: f.planVersionId },
        { kind: "addon", id: f.addonId, catalogVersionId: f.addonVersionId },
      ];
      expect(preview.next).toMatchObject({
        sequence: 1,
        source: "offline_assignments",
        plan: "subscription",
        planVersionId: f.planVersionId,
        validUntil: new Date(clock.getTime() + 365 * DAY).toISOString(),
        validUntilReason: "one_year_cap",
        graceDays: 14,
        rights: { quotas: { lines: 8, stations: 3, kiosks: 0, cabinetUsers: 5 } },
        sourceAssignments: assignments,
      });
      expect(preview.next.entitlementRevision).not.toBe("0");
      expect(preview.warnings).toEqual(
        expect.arrayContaining([{ code: "feature_unmapped", feature: "handheld" }]),
      );

      const requestId = randomUUID();
      const file = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId,
        graceDays: null,
        offline: null,
        expected: preview.expected,
      });
      expect(await verifyStandaloneLicense(file.compact, trustedKeyset())).toMatchObject({
        ok: true,
        license: {
          tenantId: f.tenantId,
          plan: "subscription",
          planVersionId: f.planVersionId,
          entitlementRevision: preview.next.entitlementRevision,
          quotas: { lines: 8, stations: 3, kiosks: 0, cabinetUsers: 5 },
        },
      });
      const [row] = await issuedRows(f.tenantId);
      expect(row).toMatchObject({
        source: "offline_assignments",
        validUntilReason: "one_year_cap",
        sourceAssignments: assignments,
      });
      const issued = (await auditRows(db, f.tenantId)).filter(
        (entry) => entry.action === "standalone_license.issued",
      );
      expect(issued).toHaveLength(1);
      expect(issued[0]).toMatchObject({
        actorPlatformUserId: f.admin.userId,
        actorRole: "platform_admin",
        tenantId: f.tenantId,
        action: "standalone_license.issued",
        outcome: "success",
        targetType: "standalone_license",
        targetId: file.issuance.licenseId,
        reason: null,
        requestId,
        before: null,
        after: {
          source: "offline_assignments",
          offlineTerms: null,
          sourceAssignments: assignments,
          entitlementRevision: preview.next.entitlementRevision,
          validUntilReason: "one_year_cap",
          quotas: { lines: 8, stations: 3, kiosks: 0, cabinetUsers: 5 },
        },
      });
      // Issuing changes nothing in the cloud: no cabinet, no new subscription rows, no documents.
      const footprint = await cloudFootprint(f.tenantId);
      expect(footprint.cabinetAccess).toBe("none");
      expect(footprint.subscriptions).toEqual([{ id: f.subscriptionId }]);
      expect(footprint.members).toEqual([]);
      const documents = await db
        .select({ id: schema.invoices.id })
        .from(schema.invoices)
        .where(eq(schema.invoices.tenantId, f.tenantId));
      expect(documents).toEqual([]);
    });

    it("ends the file with the assignment when it has an end date", async () => {
      const endsAt = new Date(Date.now() + 90 * DAY);
      const f = await offlineSiteFor({
        plan: { maxLines: 1, maxStations: 1, maxKiosks: 0, maxCabinetUsers: 1 },
        endsAt,
      });
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      expect(preview.next.validUntil).toBe(endsAt.toISOString());
      expect(preview.next.validUntilReason).toBe("subscription_end");
    });

    it("cuts the file where an add-on ends and the rights shrink", async () => {
      const addonEnds = new Date(Date.now() + 30 * DAY);
      const f = await offlineSiteFor({
        plan: { maxLines: 1, maxStations: 1, maxKiosks: 0, maxCabinetUsers: 1 },
        endsAt: null,
        addonLines: { increment: 2, quantity: 1, endsAt: addonEnds },
      });
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      expect(preview.next.validUntil).toBe(addonEnds.toISOString());
      expect(preview.next.validUntilReason).toBe("entitlement_reduction");
    });

    it("refuses a tenant without a current plan assignment, also after it has expired", async () => {
      const bare = await offlineSiteFor({});
      expect(
        await httpRefusal(
          issuance.preview(bare.admin, bare.tenantId, bare.site.id, {
            graceDays: null,
            offline: null,
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_assignments_required" } });
      const f = await offlineSiteFor({
        plan: { maxLines: 1, maxStations: 1, maxKiosks: 0, maxCabinetUsers: 1 },
        endsAt: null,
      });
      await db
        .update(schema.tenantSubscriptions)
        .set({ status: "expired", endsAt: new Date(clock.getTime() - 1_000) })
        .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
      expect(
        await httpRefusal(
          issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null, offline: null }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_assignments_required" } });
      expect(await issuedRows(f.tenantId)).toEqual([]);
    });

    it("refuses a stale preview when an assignment changes before confirmation", async () => {
      const f = await offlineSiteFor({
        plan: { maxLines: 1, maxStations: 1, maxKiosks: 0, maxCabinetUsers: 1 },
        endsAt: null,
      });
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      const addonVersionId = await createPublishedAddon(db, [
        { entitlementKey: "lines", increment: 1 },
      ]);
      await db.insert(schema.subscriptionAddons).values({
        tenantId: f.tenantId,
        subscriptionId: f.subscriptionId,
        addonVersionId,
        quantity: 1,
        startsAt: new Date(clock.getTime() - 60_000),
        status: "active",
        source: "manual",
      });
      expect(
        await httpRefusal(
          issuance.confirm(f.admin, f.tenantId, f.site.id, {
            requestId: randomUUID(),
            graceDays: null,
            offline: null,
            expected: preview.expected,
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_preview_stale" } });
      expect(await issuedRows(f.tenantId)).toEqual([]);
    });

    it("refuses the removed offline terms and keeps replaying an offline issuance made before", async () => {
      const f = await offlineSiteFor();
      const offline = { planVersionId: f.planVersionId, termDays: 30 };
      expect(
        await httpRefusal(
          issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null, offline }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_offline_terms_removed" } });

      // A row of the removed manual path, as the journal holds it from before.
      const legacyRequestId = randomUUID();
      const legacyId = randomUUID();
      await db.insert(schema.standaloneLicenseIssuances).values({
        id: legacyId,
        tenantId: f.tenantId,
        siteId: f.site.id,
        sequence: 1,
        requestId: legacyRequestId,
        hostId: f.site.hostId,
        source: "offline",
        plan: "subscription",
        planVersionId: f.planVersionId,
        entitlementRevision: 0n,
        payload: { legacy: true },
        compact: "legacy.compact.value",
        sha256: "c".repeat(64),
        kid: "test-lic-api",
        graceDays: 14,
        issuedAt: clock,
        validFrom: clock,
        validUntil: new Date(clock.getTime() + 30 * DAY),
        validUntilReason: "offline_term",
        issuedByPlatformUserId: f.admin.userId,
      });
      await db
        .update(schema.standaloneSites)
        .set({ lastIssuedSequence: 1 })
        .where(eq(schema.standaloneSites.id, f.site.id));
      const [summary] = (await issuance.listIssuances(f.admin, f.tenantId, f.site.id)).items;
      expect(summary).toMatchObject({
        source: "offline",
        validUntilReason: "offline_term",
        entitlementRevision: "0",
        sourceAssignments: null,
      });
      const replay = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId: legacyRequestId,
        graceDays: null,
        offline,
        expected: {
          entitlementRevision: "0",
          previousSequence: 0,
          boundaryAt: null,
          termsDigest: "d".repeat(64),
        },
      });
      expect(replay.issuance.licenseId).toBe(legacyId);
      expect(
        await httpRefusal(
          issuance.confirm(f.admin, f.tenantId, f.site.id, {
            requestId: legacyRequestId,
            graceDays: null,
            offline: null,
            expected: {
              entitlementRevision: "0",
              previousSequence: 0,
              boundaryAt: null,
              termsDigest: "d".repeat(64),
            },
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_request_conflict" } });
    });

    it("keeps tenants apart and denies roles without the capability", async () => {
      const a = await offlineSiteFor();
      const b = await offlineSiteFor();
      expect(
        await httpRefusal(issuance.listIssuances(a.admin, a.tenantId, b.site.id)),
      ).toMatchObject({ status: 404 });
      for (const role of ["support", "accountant"] as const) {
        const actor = await platformActor(db, role);
        expect(
          await httpRefusal(
            issuance.preview(actor, a.tenantId, a.site.id, { graceDays: null, offline: null }),
          ),
        ).toMatchObject({ status: 403 });
      }
    });

    it("issues from the subscription path once the tenant has a cabinet, with the same rights", async () => {
      const f = await offlineSiteFor();
      await db
        .update(schema.organization)
        .set({ cabinetAccess: "enabled" })
        .where(eq(schema.organization.id, f.tenantId));
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      expect(preview.next).toMatchObject({
        source: "subscription",
        sourceAssignments: null,
        rights: { quotas: { lines: 1, stations: 2, kiosks: 0, cabinetUsers: 3 } },
      });
    });
  },
);
```

(Сверить перед вставкой: `platformActor(db, role?)` — вторая сигнатура в `support/standalone-license-fixture.ts`, при отличии использовать существующий способ получить `support`/`accountant` из старого теста «denies support and accountant the offline path too»; таблица счетов — `schema.invoices` (`packages/db/src/schema/billing.ts`); импорты `createManagedSubscription`, `createPublishedAddon` уже есть в шапке файла. Тесты «из подписки» ниже по файлу (стр. ~140–560) передают `offline: null` — остаются без изменений, кроме добавленного в Task 2 `sourceAssignments: null` в ожиданиях.)

- [ ] **Step 2: Запустить — упасть**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/standalone-license-issuance.e2e.test.ts`
Expected: FAIL (`source: "offline"`, `entitlementRevision: "0"`, нет `sourceAssignments`).

- [ ] **Step 3: Реализация**

`standalone-license-authority.ts`:

```ts
export function issuanceSourceFor(cabinetAccess: "enabled" | "none"): StandaloneIssuanceSource {
  return cabinetAccess === "none" ? "offline_assignments" : "subscription";
}
```

`standalone-license-issuance.service.ts` — `IssuanceDraft` получает `sourceAssignments: StandaloneAssignmentRef[] | null`. `draft()`:

```ts
const source = issuanceSourceFor(tenant.cabinetAccess);
if (body.offline !== null)
  throw new ConflictException({ code: "standalone_license_offline_terms_removed" });
const terms = await this.assignmentTerms(
  tx,
  site.tenantId,
  now,
  source === "offline_assignments"
    ? "standalone_license_assignments_required"
    : "standalone_license_subscription_required",
);
```

и в возвращаемом объекте `sourceAssignments: source === "offline_assignments" ? terms.sourceAssignments : null`. Метод `subscriptionTerms` переименовать в `assignmentTerms(tx, tenantId, now, missingCode)`, убрать параметр `offline` и ветку `offline_not_allowed` (заменена проверкой выше), `standalone_license_subscription_required` → `missingCode`; защита: для источника `offline_assignments` `subscription.status === "trial"` → тот же `missingCode`; добавить в результат

```ts
      sourceAssignments: first.sources.flatMap((source) =>
        source.kind === "plan" || source.kind === "addon"
          ? [{ kind: source.kind, id: source.id, catalogVersionId: source.versionId }]
          : [],
      ),
```

Метод `offlineTerms()` и константу `OFFLINE_ENTITLEMENT_REVISION` удалить. `preview()` — в `next` добавить `sourceAssignments: draft.sourceAssignments`; `termsDigest(draft, hostId, offline)` не менять по форме (передавать `null`). `confirm()`: порядок — сначала ветка повтора (`replay`): `sameTerms(replay, body.offline)` оставить (для `offline` строк сохраняет прежнюю идемпотентность; для остальных требует `offline === null`), и только после неё (в `draft()`) срабатывает отказ `offline_terms_removed`. Вставка строки: добавить `sourceAssignments: draft.sourceAssignments`; аудит `after`: добавить `sourceAssignments: draft.sourceAssignments`, `offlineTerms` теперь всегда `null` (оставить ключ). `licenseFile`/`issuanceSummary` в `standalone-license-views.ts` — читать `row.sourceAssignments ?? null` и отдавать в сводку; тип строки берётся из схемы БД (Task 1).

Строгий тип `StandaloneIssuanceSource` расширен в Task 2; переключатель по источнику (`source === "offline"` в `draft`) убрать.

- [ ] **Step 4: Удалить мёртвый код**

Из `standalone-license-rights.ts` убрать `PlanEntitlementRow`, `exportPlanRights`, `offlineValidity`; импорты в сервисе почистить; в `standalone-license-rights.test.ts` удалить тесты этих функций. `MAX_LICENSE_TERM_MS` и `DAY_MS` оставить, если используются `licenseValidity`.

Run: `grep -rn "exportPlanRights\|offlineValidity\|OFFLINE_ENTITLEMENT_REVISION\|PlanEntitlementRow" apps packages --include='*.ts' --include='*.tsx' | grep -v node_modules`
Expected: пусто.

- [ ] **Step 5: Проверка хоста автонома**

Run: `rg -n "entitlement_revision|entitlementRevision" apps/standalone --glob '!node_modules'` (в ветке, где есть `apps/standalone`; в `origin/main` каталога может не быть — тогда шаг помечается «не выполнен в этой ветке»).
Expected: только проверка формы десятичной строки; сравнений с `"0"` нет. Иначе — остановиться и доложить.

- [ ] **Step 6: Прогон**

Run: `pnpm --filter @markiro/api exec vitest run test/standalone-license-issuance.e2e.test.ts test/standalone-license-rights.test.ts test/platform-standalone-licenses.routes.test.ts test/platform-contract-openapi.test.ts && pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add apps/api/src/modules/standalone-licenses apps/api/test/standalone-license-issuance.e2e.test.ts apps/api/test/standalone-license-rights.test.ts
git commit -m "feat(api): standalone license from the assignments of a tenant without a cabinet"
```

---

### Task 6: SaaS-админка — редактор каталога: переключатель и бейдж

**Files:**

- Create: `apps/saas-admin/src/pages/catalog/CatalogOfflineAvailability.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/api.ts` (`setCatalogOfflineAvailability`)
- Modify: `apps/saas-admin/src/pages/catalog/CatalogPage.tsx` (бейдж в колонке имени)
- Modify: `apps/saas-admin/src/pages/catalog/CatalogVersionPanel.tsx` (шапка панели: переключатель и бейдж)
- Modify: `apps/saas-admin/src/i18n/ru.json`, `en.json` (ключи `catalog.offline.*`, `tenants.errors.catalog_*`)
- Test: `apps/saas-admin/test/catalog-offline-availability.test.tsx`, `apps/saas-admin/test/catalog.test.tsx` (фикстуры)

**Interfaces:**

- Consumes: Task 2 (`platformCatalogContracts.setOfflineAvailability`, `CatalogVersionV4.offlineAvailable`).
- Produces: `setCatalogOfflineAvailability(itemCode, input)`; компонент `CatalogOfflineAvailability({ item, canEdit })`; бейдж с текстом «Офлайн».

- [ ] **Step 1: Падающий компонентный тест**

Create `apps/saas-admin/test/catalog-offline-availability.test.tsx` (помощники `installCatalogApi`, `renderSaasApp`, `PLATFORM_ADMIN_ME`, `ACCOUNTANT_ME`, `PUBLISHED_PLAN`, `SERVICE` — из `./render.js`; `installCatalogApi` принимает ответы по ключам — как в `catalog.test.tsx`, сверить сигнатуру и добавить маршрут `PATCH /catalog/items/:id/offline-availability`):

```tsx
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNTANT_ME,
  PLATFORM_ADMIN_ME,
  PUBLISHED_PLAN,
  SERVICE,
  installCatalogApi,
  renderSaasApp,
} from "./render.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("offline availability in the catalog editor", () => {
  it("shows an Offline badge for a flagged item in the list", async () => {
    installCatalogApi({
      me: PLATFORM_ADMIN_ME,
      items: [{ ...PUBLISHED_PLAN, offlineAvailable: true }, SERVICE],
    });
    renderSaasApp({ initialEntry: "/catalog" });
    const row = (await screen.findByRole("button", { name: /Базовый/ })).closest("tr");
    expect(within(row as HTMLElement).getByText("Офлайн")).toBeDefined();
  });

  it("lets a platform admin flag a published plan with a reason and reports the holders", async () => {
    const calls = installCatalogApi({
      me: PLATFORM_ADMIN_ME,
      items: [{ ...PUBLISHED_PLAN, offlineAvailable: false }],
      offlineAvailability: {
        status: 200,
        body: {
          catalogItemId: PUBLISHED_PLAN.catalogItemId,
          catalogItemCode: PUBLISHED_PLAN.catalogItemCode,
          kind: "plan",
          offlineAvailable: true,
          changed: true,
          offlineTenantHolders: 0,
        },
      },
    });
    renderSaasApp({ initialEntry: "/catalog" });
    await userEvent.click(await screen.findByRole("button", { name: /Базовый/ }));
    const toggle = await screen.findByRole("checkbox", { name: "Доступно офлайн-клиентам" });
    await userEvent.click(toggle);
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Основание"), "Поставка автонома");
    await userEvent.click(within(dialog).getByRole("button", { name: "Подтвердить" }));
    await waitFor(() =>
      expect(calls.offlineAvailability).toEqual([
        {
          code: PUBLISHED_PLAN.catalogItemCode,
          body: { offlineAvailable: true, reason: "Поставка автонома" },
        },
      ]),
    );
    expect(await screen.findByRole("status")).toBeDefined();
  });

  it("does not offer the switch for a service or to a non-admin, only the badge", async () => {
    installCatalogApi({
      me: ACCOUNTANT_ME,
      items: [{ ...PUBLISHED_PLAN, offlineAvailable: true }],
    });
    renderSaasApp({ initialEntry: "/catalog" });
    await userEvent.click(await screen.findByRole("button", { name: /Базовый/ }));
    expect(screen.queryByRole("checkbox", { name: "Доступно офлайн-клиентам" })).toBeNull();
    expect(screen.getAllByText("Офлайн").length).toBeGreaterThan(0);
  });

  it("shows a refusal as text", async () => {
    installCatalogApi({
      me: PLATFORM_ADMIN_ME,
      items: [{ ...PUBLISHED_PLAN, offlineAvailable: false }],
      offlineAvailability: {
        status: 409,
        body: { code: "catalog_offline_availability_forbidden" },
      },
    });
    renderSaasApp({ initialEntry: "/catalog" });
    await userEvent.click(await screen.findByRole("button", { name: /Базовый/ }));
    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Доступно офлайн-клиентам" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Основание"), "Причина");
    await userEvent.click(within(dialog).getByRole("button", { name: "Подтвердить" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Менять доступность может только администратор платформы",
    );
  });
});
```

(Имена фикстур и точные подписи — по фактическим `PUBLISHED_PLAN`; если ключ ответа у `installCatalogApi` иной — расширить помощник в `render.tsx`, не копируя разметку. Подписи кнопок и меток сверить с фактическим `ConfirmDialog` и ключами i18n.)

- [ ] **Step 2: Запустить — упасть**

Run: `pnpm --filter @markiro/saas-admin exec vitest run test/catalog-offline-availability.test.tsx`
Expected: FAIL (нет бейджа/переключателя).

- [ ] **Step 3: Клиент API**

В `apps/saas-admin/src/pages/catalog/api.ts` (рядом с `archiveCatalogItem`):

```ts
export function setCatalogOfflineAvailability(
  itemCode: string,
  input: { offlineAvailable: boolean; reason: string },
) {
  const body = platformCatalogContracts.setOfflineAvailability.body.parse(input);
  return platformApiFetch(`/catalog/items/${encodeURIComponent(itemCode)}/offline-availability`, {
    method: "PATCH",
    body: JSON.stringify(body),
    responseSchema: platformCatalogContracts.setOfflineAvailability.response,
  });
}
```

(импорт `platformCatalogContracts` из `@markiro/platform-contracts`; заголовок коммерческой версии маршрут не требует.)

- [ ] **Step 4: Компонент и подключение**

`CatalogOfflineAvailability.tsx`:

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Checkbox, ConfirmDialog, Input } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { setCatalogOfflineAvailability, type CatalogVersionDto } from "./api.js";

export function CatalogOfflineAvailability({
  item,
  canEdit,
}: {
  item: CatalogVersionDto;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<boolean | null>(null);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const mutation = useMutation({
    mutationFn: (offlineAvailable: boolean) =>
      setCatalogOfflineAvailability(item.catalogItemCode, {
        offlineAvailable,
        reason: reason.trim(),
      }),
    onSuccess: async (answer) => {
      setNotice({
        tone: "ok",
        text: answer.offlineAvailable
          ? t("catalog.offline.enabled")
          : t("catalog.offline.withdrawn", { count: answer.offlineTenantHolders }),
      });
      setTarget(null);
      setReason("");
      await queryClient.invalidateQueries({ queryKey: ["platform", "catalog"] });
    },
    onError: (error) => {
      setTarget(null);
      const code = error instanceof ApiRequestError ? error.code : undefined;
      setNotice({
        tone: "error",
        text: t(code ? `catalog.offline.errors.${code}` : "catalog.offline.errors.generic", {
          defaultValue: t("catalog.offline.errors.generic"),
        }),
      });
    },
  });
  if (item.kind === "service") return null;
  return (
    <div className="catalog-offline-availability">
      {canEdit ? (
        <Checkbox
          label={t("catalog.offline.label")}
          hint={t("catalog.offline.hint")}
          checked={item.offlineAvailable}
          disabled={mutation.isPending}
          onCheckedChange={(checked) => {
            setNotice(null);
            setTarget(checked);
          }}
        />
      ) : null}
      {notice ? (
        <Alert
          tone={notice.tone === "ok" ? "ok" : "error"}
          role={notice.tone === "ok" ? "status" : "alert"}
        >
          {notice.text}
        </Alert>
      ) : null}
      <ConfirmDialog
        open={target !== null}
        title={t(
          target ? "catalog.offline.confirmEnableTitle" : "catalog.offline.confirmWithdrawTitle",
        )}
        description={
          <Input
            label={t("catalog.offline.reason")}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1_000}
          />
        }
        confirmLabel={t("catalog.offline.confirm")}
        cancelLabel={t("catalog.cancel")}
        busy={mutation.isPending}
        onCancel={() => {
          setTarget(null);
          setReason("");
        }}
        onConfirm={() => {
          if (target !== null && reason.trim() !== "") mutation.mutate(target);
        }}
      />
    </div>
  );
}
```

(Сверить: `ConfirmDialog` принимает `description` как узел (в `TenantPage.tsx` так и используется); `catalog.cancel` — существующий ключ или `tenants.cancel`; `ApiRequestError.code` — как в `StandaloneLicenseIssue.tsx`. Кнопка «Подтвердить» неактивна без основания — реализовать через `confirmDisabled`, если пропс есть, иначе пустое основание не отправляется, а поле показывает `error`.)

В `CatalogVersionPanel.tsx`: в `<header>` под `<h2>` отрисовать бейдж `item.offlineAvailable ? <StatusChip phase="neutral" label={t("catalog.offline.badge")} /> : null` (взять фазу из `TagPhase`, нейтральную; тест `tag-semantics.test.ts` проверяет допустимые фазы — сверить) и `<CatalogOfflineAvailability item={item} canEdit={canWrite && principal.role === "platform_admin"} />`; панель получает роль через `usePlatformPrincipal()` (в файле он уже может использоваться; иначе пробросить пропсом из `CatalogPage`). В `CatalogPage.tsx` колонка `nameRu`: после `<small>{item.catalogItemCode}</small>` — `{item.offlineAvailable ? <StatusChip phase="neutral" label={t("catalog.offline.badge")} /> : null}`.

i18n (`ru.json`/`en.json`, ветка `catalog`): `offline.badge` «Офлайн»/«Offline»; `offline.label` «Доступно офлайн-клиентам»/«Available to offline customers»; `offline.hint` «Позицию можно назначать клиентам без кабинета. Облачным клиентам она доступна как обычно. Действует на все версии позиции.»; `offline.reason` «Основание»; `offline.confirmEnableTitle` «Сделать позицию доступной офлайн-клиентам?»; `offline.confirmWithdrawTitle` «Снять доступность для офлайн-клиентов?»; `offline.confirm` «Подтвердить»; `offline.enabled` «Позиция доступна офлайн-клиентам.»; `offline.withdrawn` «Снято. У {{count}} клиентов без кабинета назначения остаются в силе.»; `offline.errors.generic` «Не удалось изменить доступность позиции.», `.catalog_offline_availability_forbidden` «Менять доступность может только администратор платформы.», `.catalog_item_offline_kind_invalid` «Услуге пометка не нужна: клиенту без кабинета услуги доступны всегда.», `.catalog_item_archived` «Позиция в архиве.», `.catalog_item_not_found` «Позиция не найдена.». Английские тексты — парные.

- [ ] **Step 5: Фикстуры каталога**

В `apps/saas-admin/test/render.tsx` и `catalog.test.tsx`/`commercial-v2-fixtures.ts`: `offlineAvailable: false` в `DRAFT_PLAN`, `PUBLISHED_PLAN`, `ADDON`, `SERVICE` и других построителях версий (Task 2 уже добавил — убедиться); `installCatalogApi` получает необязательный ответ `offlineAvailability` и записывает вызовы.

- [ ] **Step 6: Прогон**

Run: `pnpm --filter @markiro/platform-contracts build && pnpm --filter @markiro/saas-admin exec vitest run test/catalog-offline-availability.test.tsx test/catalog.test.tsx test/catalog-v3-client.test.ts test/tag-semantics.test.ts && pnpm --filter @markiro/saas-admin typecheck && pnpm --filter @markiro/saas-admin lint`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add apps/saas-admin/src/pages/catalog apps/saas-admin/src/i18n apps/saas-admin/test
git commit -m "feat(saas-admin): offline availability switch and badge in the catalog editor"
```

---

### Task 7: SaaS-админка — карточка клиента без кабинета, выбор позиций документов, выдача кабинета

**Files:**

- Modify: `apps/saas-admin/src/pages/tenants/TenantPage.tsx` (панель назначений для `none`)
- Modify: `apps/saas-admin/src/pages/tenants/SubscriptionPanel.tsx` (проп `offlineTenant`: фильтр версий, пояснение, скрытие использования; якорь `#tenant-subscription` уже есть на строке 511 и прокручивается `TenantPage.tsx:64`)
- Modify: `apps/saas-admin/src/pages/tenants/GrantCabinetAccessPanel.tsx` (предупреждение до и после)
- Modify: `apps/saas-admin/src/pages/documents/CatalogPositionPicker.tsx`, `DocumentComposer.tsx` (проп `offlineTenant`), `CreateOfferPage.tsx`/`CreateInvoicePage.tsx` (передать `cabinetAccess` выбранного клиента)
- Modify: `apps/saas-admin/src/pages/documents/commercialError.ts`, `src/i18n/*.json`
- Test: `apps/saas-admin/test/tenants-cabinet-access.test.tsx`, новый `apps/saas-admin/test/tenants-offline-assignments.test.tsx`, `apps/saas-admin/test/document-composer.test.tsx`

**Interfaces:**

- Consumes: Task 2 (`offlineAvailable`, ответ выдачи кабинета).
- Produces: прямое назначение для клиента без кабинета, фильтр `offlineAvailable`; предупреждение выдачи кабинета.

- [ ] **Step 1: Падающие тесты**

Create `apps/saas-admin/test/tenants-offline-assignments.test.tsx` — образец `tenant-detail.test.tsx` (`chooseOption(user, "Версия тарифа", …)`, кнопки «Проверить назначение» и «Назначить точную версию», `api.mutationCalls()`); `installTenantApi` принимает каталог как `catalogResponse` и клиента как `detail`. Построители версии берутся из `render.tsx` (`PUBLISHED_PLAN`); подпись варианта в списке — «`{имя} · {код} · версия {N}`»:

```tsx
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PLATFORM_ADMIN_ME,
  PUBLISHED_PLAN,
  SUPPORT_ME,
  TENANT_DETAIL,
  TENANT_ID,
  installTenantApi,
  renderSaasApp,
} from "./render.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const OFFLINE_DETAIL = {
  ...structuredClone(TENANT_DETAIL),
  tenant: { ...structuredClone(TENANT_DETAIL.tenant), cabinetAccess: "none" },
  subscriptionStatus: "unmanaged",
  ownerActivation: null,
  currentSubscription: null,
  scheduledSubscription: null,
  activeAddons: [],
  scheduledAddons: [],
  events: [],
};
const FLAGGED = {
  ...PUBLISHED_PLAN,
  id: "92111111-1111-4111-8111-111111111111",
  nameRu: "Автоном",
  catalogItemCode: "plan-standalone",
  version: 1,
  offlineAvailable: true,
};
const CLOUD_ONLY = {
  ...PUBLISHED_PLAN,
  id: "93111111-1111-4111-8111-111111111111",
  nameRu: "Облачный",
  catalogItemCode: "plan-cloud",
  version: 1,
  offlineAvailable: false,
};

async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(await screen.findByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("direct assignment for a tenant without a cabinet", () => {
  it("shows the form with only the offline-flagged versions, an explanation and no cabinet usage", async () => {
    installTenantApi({
      me: PLATFORM_ADMIN_ME,
      detail: OFFLINE_DETAIL,
      catalogResponse: { items: [FLAGGED, CLOUD_ONLY] },
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Прямое назначение" })).toBeDefined();
    expect(screen.getByText(/Клиент без кабинета: можно назначить только/)).toBeDefined();
    await user.click(await screen.findByRole("combobox", { name: "Версия тарифа" }));
    expect(
      await screen.findByRole("option", { name: "Автоном · plan-standalone · версия 1" }),
    ).toBeDefined();
    expect(screen.queryByRole("option", { name: /Облачный/ })).toBeNull();
    expect(screen.queryByText("Использование")).toBeNull();
  });

  it("says so when no version is flagged", async () => {
    installTenantApi({
      me: PLATFORM_ADMIN_ME,
      detail: OFFLINE_DETAIL,
      catalogResponse: { items: [CLOUD_ONLY] },
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    expect(await screen.findByText(/Нет позиций, помеченных офлайн/)).toBeDefined();
  });

  it("posts the assignment of a flagged version with the entered reason", async () => {
    const api = installTenantApi({
      me: PLATFORM_ADMIN_ME,
      detail: OFFLINE_DETAIL,
      catalogResponse: { items: [FLAGGED, CLOUD_ONLY] },
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    await chooseOption(user, "Тип операции", "Тариф");
    await chooseOption(user, "Версия тарифа", "Автоном · plan-standalone · версия 1");
    await user.type(screen.getByLabelText("Причина"), "Поставка автонома");
    await user.click(screen.getByRole("button", { name: "Проверить назначение" }));
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Назначить точную версию" }));

    expect(api.mutationCalls()).toEqual([
      {
        method: "POST",
        path: `/api/platform/tenants/${TENANT_ID}/subscription/plan`,
        body: {
          catalogVersionId: FLAGGED.id,
          activationPolicy: "immediate",
          reason: "Поставка автонома",
        },
      },
    ]);
  });

  it("does not offer direct assignment to support", async () => {
    installTenantApi({
      me: SUPPORT_ME,
      detail: OFFLINE_DETAIL,
      catalogResponse: { items: [FLAGGED] },
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Прямое назначение" })).toBeNull();
  });
});
```

(Если в `installTenantApi` по умолчанию кнопка подтверждения или поля иначе названы — сверить с тестом `tenant-detail.test.tsx` стр. ~276–310 и взять его формулировки; `TENANT_DETAIL.tenant.cabinetAccess` проверить в `render.tsx`.) Для выдачи кабинета расширить мок в `render.tsx`: ответ `201` по `cabinet-access` теперь содержит `offlineAssignments: { plans: 0, addons: 0 }, demoCreated: true`, а `grantResponses` принимает необязательное поле `body` (Task 2 уже добавил поля в ответ — иначе строгая схема ответа отвергнет мок). Тест в `tenants-cabinet-access.test.tsx`:

```tsx
it("warns that offline assignments stay in force before the grant and says so after it", async () => {
  const detail = {
    ...structuredClone(OFFLINE_DETAIL),
    currentSubscription: structuredClone(TENANT_DETAIL.currentSubscription),
    activeAddons: structuredClone(TENANT_DETAIL.activeAddons),
  };
  const api = installTenantApi({
    me: SUPPORT_ME,
    detail,
    detailResponses: [detail, ENABLED_AFTER_GRANT],
    grantResponses: [
      {
        status: 201,
        body: {
          tenantId: TENANT_ID,
          userId: "owner-user-1",
          memberId: "member-1",
          deliveryId: "c1111111-1111-4111-8111-111111111111",
          offlineAssignments: { plans: 1, addons: 1 },
          demoCreated: false,
        },
      },
    ],
  });
  renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Выдать доступ в кабинет" }));
  expect(screen.getByText(/У клиента есть офлайн-назначения/)).toBeDefined();
  await user.type(screen.getByLabelText(/E-mail/), "owner@example.com");
  await user.click(screen.getByRole("button", { name: /Выдать/ }));
  expect(await screen.findByText(/демо не создано/)).toBeDefined();
  expect(api.mutationCalls()).toHaveLength(1);
});
```

(Название кнопок формы и поле e-mail — сверить с существующим тестом «grants cabinet access with the owner email and reloads the tenant» в этом же файле, стр. ~162, и взять его селекторы.)

В `document-composer.test.tsx`: для клиента с `cabinetAccess: "none"` комбобокс позиций содержит услугу и помеченный тариф и не содержит непомеченный (по образцу соседних тестов файла: открыть комбобокс «Позиция каталога» и проверить `getByRole("option", …)` / `queryByRole`).

- [ ] **Step 2: Запустить — упасть**

Run: `pnpm --filter @markiro/saas-admin exec vitest run test/tenants-offline-assignments.test.tsx test/tenants-cabinet-access.test.tsx test/document-composer.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Реализация**

`TenantPage.tsx`: убрать условие `cabinetEnabled ? <SubscriptionPanel…> : <Alert…>`; всегда рисовать

```tsx
{
  !cabinetEnabled ? <Alert tone="info">{t("tenants.detail.offline.documentsNotice")}</Alert> : null;
}
<SubscriptionPanel
  detail={detail}
  canDirectAssign={canDirectAssign}
  capabilities={principal.capabilities}
  financialVisible={financialVisible}
  accountant={principal.role === "accountant"}
  offlineTenant={!cabinetEnabled}
/>;
```

`SubscriptionPanel.tsx`: проп `offlineTenant: boolean`; `publishedVersions` → дополнительно `.filter((item) => !offlineTenant || item.offlineAvailable)`; в `<Card className="assignment-card" …>` для `offlineTenant` — перед формой `<Alert tone="info">{t("tenants.assignment.offlineNote")}</Alert>`; при `offlineTenant && versionOptions.length === 0` — вместо пустого комбобокса текст `tenants.assignment.offlineEmpty` со ссылкой на `/catalog` (если `capabilities.includes("catalog.read")`); блок использования (`tenants.usage.*`, около стр. 403) — `{offlineTenant ? null : …}`.

`GrantCabinetAccessPanel.tsx`: проп `hasAssignments: { plans: number; addons: number } | null` (из `detail`: `(currentSubscription ? 1 : 0) + (scheduledSubscription ? 1 : 0)` и `activeAddons.length + scheduledAddons.length`); при `open && hasAssignments` — `<Alert tone="warn">{t("tenants.detail.offline.assignmentsWarning", {plans, addons})}</Alert>`; `onGranted` получает ответ и показывает в `TenantPage` (`grantedNotice`) расширенный текст: при `demoCreated === false` — ключ `tenants.detail.offline.grantedNoDemo` с числами. Сверить: `grantCabinetAccess` в `tenants/api.ts` валидирует ответ `grantCabinetAccessResponseSchema` — Task 2 уже расширил его.

`CatalogPositionPicker.tsx`: проп `offlineTenant?: boolean`; `selectableCatalog = catalog.filter((v) => v.unitPrice !== undefined && (!offlineTenant || v.kind === "service" || v.offlineAvailable))`; `DocumentComposer` пробрасывает проп из выбранного клиента (`tenants.find((tenant) => tenant.id === draft.tenantId)?.cabinetAccess === "none"`).

`commercialError.ts`: сообщение `catalog_kind_not_allowed_for_offline_tenant` — уже в списке кодов; текст в i18n уточнить (раздел «i18n» ниже).

i18n ru (ветка `tenants.assignment`): `offlineNote` «Клиент без кабинета: можно назначить только тарифы и дополнения с пометкой «Доступно офлайн-клиентам». По этим назначениям выпускается офлайн-лицензия автонома.»; `offlineEmpty` «Нет позиций, помеченных офлайн. Пометить позицию можно в каталоге.»; `tenants.detail.offline.assignmentsWarning` «У клиента есть офлайн-назначения (тарифов: {{plans}}, дополнений: {{addons}}). Они остаются в силе; демо не создаётся. Права кабинета будут равны этим назначениям.»; `tenants.detail.offline.grantedNoDemo` «Кабинет выдан. Офлайн-назначения сохранены (тарифов: {{plans}}, дополнений: {{addons}}), демо не создано.»; `tenants.errors.catalog_kind_not_allowed_for_offline_tenant` (стр. 2463) → «У клиента нет кабинета: ему можно продать услуги и позиции, помеченные как доступные офлайн-клиентам.»; en — парные тексты (стр. 2461).

- [ ] **Step 4: Прогон**

Run: `pnpm --filter @markiro/saas-admin exec vitest run test/tenants-offline-assignments.test.tsx test/tenants-cabinet-access.test.tsx test/tenant-detail.test.tsx test/document-composer.test.tsx test/offer-editor.test.tsx test/offer-create-offline-tenant.test.tsx && pnpm --filter @markiro/saas-admin typecheck && pnpm --filter @markiro/saas-admin lint`
Expected: PASS (`offer-editor.test.tsx` упоминает код отказа — ожидание сообщения обновить под новый текст).

- [ ] **Step 5: Коммит**

```bash
git add apps/saas-admin/src apps/saas-admin/test
git commit -m "feat(saas-admin): direct assignment for tenants without a cabinet, offline filter, grant warning"
```

---

### Task 8: SaaS-админка — диалог выпуска из назначений

**Files:**

- Modify: `apps/saas-admin/src/pages/tenants/StandaloneLicenseIssue.tsx` (удалить раздел «Офлайн», добавить блок «Права из назначений клиента»)
- Create: `apps/saas-admin/src/pages/tenants/StandaloneAssignmentsSummary.tsx`
- Modify: `apps/saas-admin/src/pages/tenants/StandaloneSitesPanel.tsx` (текст для нового источника), `standalone-format.ts` (ошибки)
- Modify: `apps/saas-admin/src/pages/tenants/standalone-api.ts` (если запросы собирают `offline`; всегда `null`)
- Modify: `src/i18n/*.json` (`tenants.detail.standalone.*`)
- Test: `apps/saas-admin/test/standalone-license-flows.test.tsx`, `standalone-sites-panel.test.tsx`, `standalone-api.test.ts`, `standalone-fixtures.ts`

**Interfaces:**

- Consumes: Task 2 (источник, `sourceAssignments`), Task 5 (коды ошибок).
- Produces: диалог без ручных условий; `StandaloneAssignmentsSummary({ tenantId })`.

- [ ] **Step 1: Падающие тесты**

В `apps/saas-admin/test/standalone-license-flows.test.tsx` прочитать блок `describe("offline license issuance (plan ЛЦ-0)")` (стр. ~214–410: тесты с предпросмотром `offlinePreview`, выбором тарифа и сроком 200 дней) и заменить его тестами ниже, переиспользуя тот же способ установки API (`installStandaloneApi`-подобный помощник файла/`standalone-fixtures.ts`, ключи `PREVIEW`, `jsonResponse`, `PUBLISHED_PLAN`, `STANDALONE_SITE_LIST`) — имена сверить с прочитанным блоком:

```tsx
describe("offline license from the assignments of a tenant without a cabinet (spec 2026-10-16)", () => {
  const assignmentsPreview = {
    ...PREVIEW_RESPONSE, // предпросмотр «из подписки» этого файла
    next: {
      ...PREVIEW_RESPONSE.next,
      source: "offline_assignments",
      validUntilReason: "one_year_cap",
      sourceAssignments: [
        {
          kind: "plan",
          id: SUBSCRIPTION_ID,
          catalogVersionId: PREVIEW_RESPONSE.next.planVersionId,
        },
      ],
    },
  };

  it("has no manual offline section; shows the assignments and a link to change them", async () => {
    // Клиент без кабинета: список площадок отдаёт issuanceSource "offline_assignments",
    // деталь клиента (GET /tenants/:id) — текущий тариф и дополнение.
    installOfflineAssignmentsApi({ preview: assignmentsPreview });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}?tab=equipment` });
    await userEvent.click(await screen.findByRole("button", { name: /Выпустить/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Офлайн-условия")).toBeNull();
    expect(within(dialog).queryByLabelText(/Срок/)).toBeNull();
    const summary = within(dialog).getByRole("region", { name: "Права из назначений клиента" });
    expect(within(summary).getByText(/Тариф:/)).toBeDefined();
    expect(
      within(summary).getByRole("link", { name: "Изменить права клиента" }).getAttribute("href"),
    ).toBe(`/tenants/${TENANT_ID}#tenant-subscription`);
  });

  it("previews and confirms with offline: null and shows the rights table", async () => {
    const calls = installOfflineAssignmentsApi({ preview: assignmentsPreview });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}?tab=equipment` });
    await userEvent.click(await screen.findByRole("button", { name: /Выпустить/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Предпросмотр" }));
    expect(await within(dialog).findByRole("table")).toBeDefined();
    await userEvent.click(within(dialog).getByRole("button", { name: "Подтвердить выпуск" }));
    await waitFor(() =>
      expect(calls.confirm).toEqual([
        {
          requestId: expect.any(String),
          graceDays: null,
          offline: null,
          expected: assignmentsPreview.expected,
        },
      ]),
    );
    expect(calls.preview).toEqual([{ graceDays: null, offline: null }]);
  });

  it("explains a missing assignment with a link, and a stale-cache refusal", async () => {
    installOfflineAssignmentsApi({
      previewStatus: 409,
      previewCode: "standalone_license_assignments_required",
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}?tab=equipment` });
    await userEvent.click(await screen.findByRole("button", { name: /Выпустить/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Предпросмотр" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "Нет действующего назначения тарифа",
    );
    expect(within(dialog).getByRole("link", { name: "Изменить права клиента" })).toBeDefined();
  });
});
```

`installOfflineAssignmentsApi` — небольшой помощник в `standalone-fixtures.ts` по образцу существующих установщиков этого файла: подставляет `STANDALONE_SITE_LIST` с `issuanceSource: "offline_assignments"`, деталь клиента `none` с `currentSubscription` и `activeAddons` (`TENANT_DETAIL` из `render.tsx` с `cabinetAccess: "none"`), ответ предпросмотра/подтверждения (или статус и код ошибки) и записывает тела `preview`/`confirm` в `calls`. Подписи кнопок («Выпустить», «Предпросмотр», «Подтвердить выпуск») сверить с `tenants.detail.standalone.issue.*` в `ru.json`. В `standalone-sites-panel.test.tsx` тест «says that a tenant without a cabinet gets offline licenses only, with no cloud access» заменить на «says the license is issued from the tenant's assignments» (`issuanceSource: "offline_assignments"`, текст «по назначениям клиента»); добавить тест: история площадки с выдачей `source: "offline"` показывает подпись «офлайн-условия» (ключ `tenants.detail.standalone.source.offline` сохраняется).

- [ ] **Step 2: Запустить — упасть**

Run: `pnpm --filter @markiro/saas-admin exec vitest run test/standalone-license-flows.test.tsx test/standalone-sites-panel.test.tsx test/standalone-api.test.ts`
Expected: FAIL.

- [ ] **Step 3: Реализация**

`StandaloneLicenseIssue.tsx`: убрать импорты `useQuery`, `Combobox`, `StandaloneOfflineTerms`, `listAssignableCatalogVersions`, состояния `planVersionId`, `term`, `termDays`, `termValid`, `catalog`, `planOptions`, константу `MAX_OFFLINE_TERM_DAYS`, `offlinePath` и фиксированный `<fieldset className="standalone-offline-terms">`; `offline` в запросах — литерал `null`; `termsReady` убрать из `disabled`. Добавить:

```tsx
{
  source === "offline_assignments" ? <StandaloneAssignmentsSummary tenantId={tenantId} /> : null;
}
```

`StandaloneAssignmentsSummary.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Alert } from "@markiro/ui";

import { getTenant } from "./api.js";

/** Rights of a tenant without a cabinet are its direct assignments (spec 2026-10-16 §10). */
export function StandaloneAssignmentsSummary({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const tenant = useQuery({
    queryKey: ["platform", "tenants", tenantId],
    queryFn: () => getTenant(tenantId),
  });
  const detail = tenant.data;
  const rows = detail
    ? [
        ...(detail.currentSubscription
          ? [
              {
                key: detail.currentSubscription.id,
                kind: "plan" as const,
                name: detail.currentSubscription.planName,
                until: detail.currentSubscription.endsAt,
                quantity: 1,
              },
            ]
          : []),
        ...detail.activeAddons.map((addon) => ({
          key: addon.id,
          kind: "addon" as const,
          name: addon.addonName,
          until: addon.endsAt,
          quantity: addon.quantity,
        })),
      ]
    : [];
  return (
    <section
      aria-label={t("tenants.detail.standalone.assignments.title")}
      className="standalone-assignments"
    >
      <h3>{t("tenants.detail.standalone.assignments.title")}</h3>
      {tenant.isError ? (
        <Alert tone="error" role="alert">
          {t("tenants.detail.standalone.assignments.loadError")}
        </Alert>
      ) : null}
      {detail && rows.length === 0 ? (
        <Alert tone="warn" role="alert">
          {t("tenants.detail.standalone.assignments.empty")}
        </Alert>
      ) : null}
      {rows.length > 0 ? (
        <ul>
          {rows.map((row) => (
            <li key={row.key}>
              {t(`tenants.detail.standalone.assignments.${row.kind}`, {
                name: row.name,
                quantity: row.quantity,
              })}
            </li>
          ))}
        </ul>
      ) : null}
      <Link to={`/tenants/${tenantId}#tenant-subscription`}>
        {t("tenants.detail.standalone.assignments.change")}
      </Link>
    </section>
  );
}
```

(Имена полей `planName`, `addonName`, `quantity`, `endsAt` взять из `tenantSubscriptionSchema`/`tenantSubscriptionAddonSchema` в `packages/platform-contracts/src/tenants.ts`; если полей названий нет — выводить `planVersionId`/`catalogItemCode`. Якорь `#tenant-subscription` прокручивается существующим эффектом `TenantPage.tsx:64–65`.)

`StandaloneSitesPanel.tsx`: условие на стр. 119 → `query.data.issuanceSource === "offline_assignments"` с ключом `tenants.detail.standalone.assignmentsTenant`; `source={query.data?.issuanceSource ?? "subscription"}` не меняется. `standalone-format.ts`: в список кодов (стр. ~42–44) убрать `standalone_license_offline_terms_required`, `standalone_license_offline_not_allowed`, `standalone_license_offline_plan_unavailable` из активных, добавить `standalone_license_assignments_required`, `standalone_license_offline_terms_removed` (старые коды оставить в i18n, пока API их может вернуть старой сборке — нет, API их больше не возвращает: удалить ключи).

i18n ru: `tenants.detail.standalone.source.offline_assignments` «назначения клиента»; `…assignmentsTenant` «Лицензия выпускается по назначениям клиента (тариф и дополнения). Облачный доступ не открывается.»; `…assignments.title` «Права из назначений клиента»; `.plan` «Тариф: {{name}}»; `.addon` «Дополнение: {{name}} × {{quantity}}»; `.change` «Изменить права клиента»; `.empty` «У клиента нет действующего тарифа. Назначьте тариф с пометкой «Доступно офлайн-клиентам»»; `.loadError` «Не удалось загрузить назначения клиента.»; ошибки `tenants.detail.standalone.errors.standalone_license_assignments_required` «Нет действующего назначения тарифа. Измените права клиента.» и `…offline_terms_removed` «Ручные офлайн-условия больше не поддерживаются. Обновите страницу.»; `validUntilReason` — подпись `one_year_cap` уже есть. Удалить ключи `tenants.detail.standalone.issue.offline.*`. en — парные.

- [ ] **Step 4: Прогон**

Run: `pnpm --filter @markiro/saas-admin exec vitest run test/standalone-license-flows.test.tsx test/standalone-sites-panel.test.tsx test/standalone-api.test.ts test/tenants-offline-assignments.test.tsx && pnpm --filter @markiro/saas-admin test && pnpm --filter @markiro/saas-admin typecheck && pnpm --filter @markiro/saas-admin lint && pnpm --filter @markiro/saas-admin build`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add apps/saas-admin/src apps/saas-admin/test
git commit -m "feat(saas-admin): license issuance from the assignments of a tenant without a cabinet"
```

---

### Task 9: Документация, браузерные фикстуры и итоговые проверки

**Files:**

- Modify: `docs/operations/standalone-licenses.md` (раздел «Что берётся в файл»)
- Modify: спецификация лицензий `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` и `…-lc0-saas-offline-license-export.md` — **только после переноса ветки в `main`**; в этой ветке их нет, поэтому вместо правки — абзац-отсылка в `docs/superpowers/specs/2026-10-16-offline-catalog-items-design.md` («Статус»: реализовано; что заменено) и запись в `docs/operations/standalone-licenses.md`
- Modify: `tools/production-browser/tenant-equipment-tests/fixture.ts`, `workspace.spec.ts` (клиент без кабинета с назначениями и диалог выпуска); `tools/production-browser/service-periods-tests/fixture.ts` (если не сделано в Task 2)
- Modify: `docs/superpowers/specs/2026-09-29-tenants-without-cabinet-design.md` (пометка в «Deferred follow-ups»: фильтр композитора закрыт этим планом)

**Interfaces:**

- Consumes: все предыдущие задачи.
- Produces: актуальная памятка оператора, браузерный сценарий, итог проверок.

- [ ] **Step 1: Памятка оператора**

В `docs/operations/standalone-licenses.md` заменить подраздел «Клиент без кабинета — из офлайн-условий» на:

```markdown
**Клиент без кабинета (`cabinet_access = none`) — из его назначений:**

- Права клиента — это «Прямое назначение» на карточке клиента (тариф плюс дополнения с количеством;
  начало, конец, основание). Назначить такому клиенту можно только позицию, помеченную в каталоге
  «Доступно офлайн-клиентам» (пометка — на позиции, действует на все её версии; меняет `platform_admin`,
  с основанием, в аудите `catalog.item.offline_availability_changed`).
- Квоты и возможности файла — кандидат снимка прав клиента, как на пути из подписки; несопоставленная
  возможность уходит «выключено» и подсвечена в предпросмотре.
- `validUntil` — конец назначения, ближайшее уменьшение прав или год от выпуска, что раньше; у
  назначения без даты окончания файл действует год.
- В журнале выдачи `source = offline_assignments` и `source_assignments` (идентификаторы тарифа и
  дополнений); аудит `standalone_license.issued`: `after.source`, `after.sourceAssignments`,
  `after.entitlementRevision`. Строки прежнего пути `source = offline` (`offline_term`) остаются в
  журнале как есть и читаются; файлы не перевыпускаются.
- Нет действующего тарифа — `409 standalone_license_assignments_required`; поле `offline` в запросе
  выпуска принимается, но непустое значение отвергается `409 standalone_license_offline_terms_removed`.
- Назначение само не создаёт счетов и актов. При выдаче такому клиенту кабинета назначения остаются в
  силе, демо не создаётся, диалог предупреждает об этом.
```

- [ ] **Step 2: Браузерные сценарии**

Run: `grep -rn "cabinetAccess\|standalone" tools/production-browser/tenant-equipment-tests/*.ts | head`; в `fixture.ts` добавить клиента `cabinetAccess: "none"` с `issuanceSource: "offline_assignments"`, текущей подпиской и дополнением; в `workspace.spec.ts` — сценарий: открыть диалог выпуска, увидеть блок «Права из назначений клиента» и ссылку «Изменить права клиента», отсутствие раздела «Офлайн-условия»; без новых интерактивных элементов станции (ограничение на ≥64 px относится к станции, не к saas-admin). Запуск — вне песочницы (`tools/production-browser/package.json`, `test:equipment` или актуальное имя скрипта; проверить `grep -n '"test' tools/production-browser/package.json`); если запуск невозможен в среде — явно записать в отчёт «не выполнено».

- [ ] **Step 3: Итоговые проверки**

Run (по очереди, с `DATABASE_URL`):

```bash
git diff --check
pnpm --filter @markiro/db build && pnpm --filter @markiro/db test && pnpm --filter @markiro/db typecheck && pnpm --filter @markiro/db lint
pnpm --filter @markiro/platform-contracts build && pnpm --filter @markiro/platform-contracts test && pnpm --filter @markiro/platform-contracts typecheck && pnpm --filter @markiro/platform-contracts lint
pnpm --filter @markiro/api test && pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint && pnpm --filter @markiro/api build
pnpm --filter @markiro/saas-admin test && pnpm --filter @markiro/saas-admin typecheck && pnpm --filter @markiro/saas-admin lint && pnpm --filter @markiro/saas-admin build
pnpm format:check
pnpm test:production-bundle:contract
```

Expected: всё зелёное; пропущенные БД-наборы (без `DATABASE_URL`) перечислить в отчёте. Если шире-прогон падает только в полном запуске — записать и исследовать (общие состояния, сборка зависимостей), не повышать таймауты.

- [ ] **Step 4: Ручные/внешние проверки (не автотесты, в отчёт отдельной строкой)**

Браузерный обход каталога (переключатель, бейдж, подтверждение), карточки клиента без кабинета и диалога выпуска; приём выпущенного файла хостом автонома на Windows (формат файла не менялся: `plan: "subscription"`, настоящий `entitlementRevision`); кэш старой сборки saas-admin при выкладке (порядок: API, затем saas-admin).

- [ ] **Step 5: Граф и коммит**

```bash
graphify update .
git add docs/operations/standalone-licenses.md docs/superpowers/specs/2026-09-29-tenants-without-cabinet-design.md tools/production-browser
git commit -m "docs: offline catalog items runbook and browser fixtures"
```

---

## Самопроверка плана

- Решения владельца: (1) флаг на позиции, редактор, бейдж, облачные клиенты не затронуты — T1, T3, T6; (2) страж «вид + флаг», форма «Прямое назначение», предложения и счета — T3, T7; (3) выпуск из назначений, замена ручных условий, срок, журнал/аудит — T5, T8; (4) нет автобиллинга — T5, тест «issues a file…» проверяет отсутствие счетов у клиента; (5) выдача кабинета — T4, T7.
- Контракты и фикстуры — T2; OpenAPI/число схем — T3 (Step 7); миграция — T1; риски блокировок — T3 (комментарий и тест гонки), T4 (порядок замков); фоновые задания — спецификация §13: истёкшее назначение → `assignments_required` покрыто тестом T5.
- Имена, использованные в нескольких задачах: `assertCatalogAllowedForTenant` (T3), `setOfflineAvailability` (T2, T3), `setCatalogOfflineAvailability` (T6), `offline_assignments` (T1, T2, T5, T8), `sourceAssignments` (T1, T2, T5, T8), `StandaloneAssignmentsSummary` (T8), `offlineTenant` (T7), `demoCreated`/`offlineAssignments` (T2, T4, T7).

## Отклонения при исполнении

(Заполняется по ходу: каждое расхождение плана с фактическим кодом.)

**Задача 1.** `pnpm db:generate` не принимает `--` перед `--name` (`pnpm --filter @markiro/db db:generate --name offline_catalog_items`). Миграционный тест: `$1` и `$1::text` в одном запросе дают «inconsistent types deduced for parameter», поэтому код и slug передаются отдельными параметрами; `runRuntimeMigrations` возвращает `{ packaged, … }`, а не `applied`, ожидание — `packaged` содержит `0195_offline_catalog_items`. Тест схемы написан после правки схемы (красный шаг для него не наблюдался; миграционный тест красный по `column "offline_available" does not exist` не проверялся отдельно, так как он требует уже применённой схемы). Комментарий над `source` в схеме журнала обновлён.

**Задача 2.** `planVersionFixture` в `catalog.test.ts` нет: использован существующий `responseBase` (в него добавлен `offlineAvailable: false`). `index.ts` перечисляет экспорты поимённо — добавлены `catalogOfflineAvailability*` и типы. Вложенные в подписку/дополнение версии (`detailPlanVersionSchema`, `listPlanVersionSchema`) не содержат `offlineAvailable` (флаг нужен только в `assignableCatalogVersionSchema` и производных): фикстуры вложенных версий (`planVersion` в `tenants.test.ts`, `base` в `catalog-v3.test.ts`, `TENANT_DETAIL.currentSubscription.planVersion` и т.п. в saas-admin) флаг не получают. Сводка выпуска в фикстуре saas-admin `standalone-fixtures.ts` получила `sourceAssignments: null` (и в предпросмотре). В мок выдачи кабинета `render.tsx` добавлены `offlineAssignments`/`demoCreated`. Устаревший `packages/domain/dist` клонированной копии (из ветки integ) давал ложное падение `pallet-sheet-templates-migration.test.ts`; после пересборки домена — зелёный. Полный прогон `@markiro/db` под нагрузкой один раз упал по таймауту 20 с в `runtime-migrate.test.ts` (в одиночку проходит).

**Задача 3.** Помимо перечисленных файлов: `prepareOfferDraft` и тип `OfferDraftExecutor` в `platform-offer-draft.ts` расширены `execute` (страж теперь выполняет сырой запрос); запись `PlatformCatalogController.setOfflineAvailability` добавлена в `subscription-route-inventory.test.ts`; `platform-contract-openapi.test.ts` — число общих схем 266 → 268; `commercial-v4.integration.test.ts` и граничный тест контроллера в `platform-catalog.e2e.test.ts` получили `offlineAvailable: false` в фикстурах; ожидание тела ответа первого теста `grant-cabinet-access.e2e` дополнено новыми полями (в сервисе до Задачи 4 стояла заглушка `offlineAssignments: {0,0}`, `demoCreated: true`, чтобы коммит собирался). Тест гонки со снятием флага написан с `setup.pool.connect()` (в плане был `setup.pool`). Фикстуре `createPublishedAddon` добавлен третий параметр. Исследование `applyPaidLicense` — в разделе 14 спецификации, риск 6.

**Задача 4.** Подсчёт назначений — приватный метод `countOfflineAssignments` (в плане `countAssignments`) в `tenant-provisioning.service.ts`; считаются тарифные подписки со статусами `pending_activation`/`trial`/`active`/`scheduled` и дополнения `active`/`scheduled`. Тест «активация не создаёт и не меняет подписки» написан напрямую на `SubscriptionLifecycleService.activatePendingDemo` (возвращает `null`), а не через токен владельца. Существующие точные ожидания аудита `platform.tenant.cabinet_access.granted` в двух местах `grant-cabinet-access.e2e.test.ts` дополнены `demoCreated`/`offlineAssignments`.

**Задача 5.** `termsDigest` потерял параметр `offline` (оно всегда `null`) и получил идентификаторы назначений; `subscriptionTerms` и `offlineTerms` заменены одним `assignmentTerms(tx, tenantId, now, missingCode)`. Для старой сборки saas-admin и клиента с кабинетом непустое `offline` теперь тоже даёт `standalone_license_offline_terms_removed` (раньше у клиента с кабинетом — `standalone_license_offline_not_allowed`). Устаревшая строка журнала в тесте повторного ответа строится настоящей полезной нагрузкой (`standaloneLicensePayloadV1Schema`), потому что сводка разбирает `payload` строки (`{ legacy: true }` из плана не разбирается). Добавлены тесты, которых в плане нет: пробный (`trial`) тариф клиента без кабинета отказывается кодом `assignments_required`; «получил кабинет между предпросмотром и подтверждением» даёт `preview_stale`; изоляция назначений двух клиентов; повтор запроса того же `requestId` для источника назначений. Существующие точные ожидания (`preview.next`, аудит) пути «из подписки» дополнены `sourceAssignments: null`. Шаг 5 (проверка хоста автонома): в этой ветке `apps/standalone` отсутствует (каталог без отслеживаемых файлов), проверен только контракт `packages/domain/src/standalone-license/contracts.ts:120` — десятичная строка `0|[1-9][0-9]{0,18}`, сравнений с `"0"` в TypeScript нет; Rust-хост в этой ветке не проверен.

**Задача 6.** Бейдж «Офлайн» — `Badge` (тег категории без глифа, тон `teal`), а не `StatusChip` нейтральной фазы: глиф закреплён за фазой жизненного цикла (комментарий в `packages/ui/src/components/Badge.tsx`), а флаг — не фаза. В таблице бейдж стоит рядом с кнопкой «Открыть …» (внутри кнопки он не попал бы в доступное имя: оно задано `aria-label`); для этого строка имени обёрнута в `div.table-name-cell`. Роль определяется `usePlatformPrincipal()` внутри `CatalogVersionPanel` (проп не добавлялся); переключатель вынесен из шапки в отдельный блок под ней (`.catalog-offline-availability`), чтобы длинная подсказка не ломала шапку на узких экранах. В подтверждении добавлены тексты `enableDescription`/`withdrawDescription` (при снятии — «уже сделанные назначения остаются в силе»), основание обязательно (`confirmDisabled`), ошибка показывается в самом диалоге (`ConfirmDialog.error`). Число держателей известно только после ответа сервера (раздел 10 спецификации), поэтому оно показывается в `Alert` после снятия; ответ «без изменений» (`changed: false`) даёт отдельный текст. `installCatalogApi` получил опцию `offlineAvailability` и метод `offlineAvailabilityCalls()` (имя, а не `calls.offlineAvailability`, по образцу соседних методов), мок обновляет флаг у всех версий позиции. Клиент API использует `platformCatalogV4Contracts.setOfflineAvailability` (наследует из базовых контрактов). Устаревший `packages/ui/dist` клонированной копии пересобран.

**Задача 7.** Текст ошибки отказа стража живёт в `commercial.errors.catalog_kind_not_allowed_for_offline_tenant` (не в `tenants.errors`, как в плане) — обновлён там и в `offer-editor.test.tsx`; для «Прямого назначения» код стража добавлен в `ASSIGNMENT_ERROR_KEYS` (раньше показывалось общее «не удалось назначить») с новым ключом `tenants.errors.catalog_kind_not_allowed_for_offline_tenant`. Блок кабинетных лимитов (`EntitlementsPanel`: снимок прав с использованием и подготовкой временных источников) для клиента без кабинета скрыт целиком: отдельного блока `tenants.usage.*` в панели нет, эти ключи используются только в подтверждении назначения. Пустой список помеченных позиций заменяет форму предупреждением (`Alert warn`) со ссылкой «Открыть каталог» через проп `action` общего `Alert` (ссылка только при `catalog.read`). Предупреждение выдачи кабинета показывается в раскрытой форме над полем e-mail (не на закрытой панели). Моки `installTenantApi`: `grantResponses` принимает необязательное `body`. Тест композитора использует подпись комбобокса «Добавить позицию» (не «Позиция каталога»); добавлен парный тест для клиента с кабинетом. В полном прогоне saas-admin под нагрузкой один раз упал `tenant-detail.test.tsx › scrolls a decision-queue anchor…` (16 с на файл), в одиночку проходит.

**Задача 8.** Вместо помощника `installOfflineAssignmentsApi` в `standalone-fixtures.ts` тесты используют существующий `stubApi` файла и `TENANT_DETAIL` с `cabinetAccess: "none"`; `renderPanel` в `standalone-license-flows.test.tsx` и `standalone-sites-panel.test.tsx` обёрнут в `MemoryRouter` (панель теперь содержит `Link`). Сводка назначений — список (не таблица с `caption`) в `<section aria-label>`; пустое состояние и ошибка отказа используют проп `action` общего `Alert` со ссылкой. Тест «выпуск из офлайн-условий» удалён вместе с блоком; остальные тесты блока «offline license issuance (plan ЛЦ-0)» (путь из подписки) оставлены. Добавлены: тест подписи источников истории (`подписка`/`офлайн-условия`/`назначения клиента`) и тест для старой сборки (`standalone_license_offline_terms_removed`). `yearCapNote` обновлён: «подписки или назначения без даты окончания». Стала лишней ветка `source === "offline"` у карточки площадки: подпись `source.offline` оставлена для истории.

**Задача 9.** Браузерный сценарий — новый `tenant-equipment-tests/offline-assignments.spec.ts` (диалог выпуска клиента без кабинета, 1440/390 × ru/en, без горизонтальной прокрутки) и переключатель `fixture.offlineAssignments` в `fixture.ts`; `workspace.spec.ts` не менялся. Скриншоты реальным браузером выявили и исправлено: пустое состояние и ошибка `assignments_required` с ссылкой в `action` общего `Alert` сжимали текст в столбик на 390 px — ссылка вынесена под `Alert`; сводке назначений добавлена рамка и отступы (`.standalone-assignments`); бейдж «Офлайн» в шапке панели версии сгруппирован со статусом (`.version-panel__tags`), чтобы не разъезжаться на мобильном; формулировка «Снято…» уточнена; строка дополнения «версия 1 × 2» заменена на «количество 2». В `StandaloneLicenseIssue` ссылка при ошибке — отдельный элемент под предупреждением (в диалоге при пустых назначениях ссылок две). `tools/production-browser/node_modules` склонирован копированием из чужого worktree (только чтение источника), в коммит не входит.

