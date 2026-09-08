# National Catalog Product Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пользователь Markiro выбирает свои карточки ЧЗ или вводит GTIN, подтверждает создание товара либо связь и выбранные изменения, переносит одно фото и видит состояние карточки в каталоге.

**Architecture:** Расширяем существующий модуль National Catalog, регуляторные предложения и приватное хранение изображений. Возобновляемая сессия хранит список и сравнения до создания товара; подтверждённая связь отделена от наблюдений и принятых значений. Применение каждой позиции выполняется одной транзакцией, фотография имеет отдельный восстанавливаемый результат.

**Tech Stack:** Node.js 24+, pnpm 11.22.0 через Corepack, TypeScript strict, NestJS, Drizzle/Postgres, pg-boss, Zod, Vitest, React/Vite, TanStack Query, `@markiro/ui`, существующий обработчик WebP, Playwright.

**Spec:** [Согласованная спецификация](../specs/2026-09-08-national-catalog-product-import-design.md).

## Global Constraints

- Два входа в один процесс: «Мои товары» и «По GTIN».
- Доступны опубликованные карточки и черновики. Архивные скрыты по умолчанию.
- Совпадение GTIN предлагает связь, но не создаёт её автоматически.
- Связь можно сохранить без переноса полей и фотографии.
- Пользователь принимает отдельные изменения. Фоновые проверки не перезаписывают принятые значения, категорию или фотографию.
- У товара остаётся одно активное фото; основное фото ЧЗ выбрано по умолчанию, пользователь может выбрать другое или отказаться от загрузки.
- Замена существующего фото требует явного выбора. Ошибка фото не блокирует товар.
- В каталоге есть отдельные колонки «Статус Markiro» и «Честный знак», фильтр ЧЗ, переход к сравнению и время последней успешной проверки.
- Интеграция только читает ЧЗ; публичный `product` не подтверждает собственный/предоставленный доступ при новом импорте.
- Одна сессия: 100 000 строк; одно применение: 100 выбранных позиций; сессии и неподтверждённые предпросмотры: 24 часа.
- `/v4/product-list`: страница до 1000, период до 10 000; `/v3/feed-product`: до 25 GTIN или идентификаторов.
- Фото: максимум 5 MiB, общий срок скачивания 15 секунд, максимум два перенаправления; декодирование: два параллельных задания, очередь восемь.
- JPEG/PNG/WebP преобразуются существующим процессором в WebP с длинной стороной до 1200 px, без увеличения и метаданных; анимация отклоняется.
- Одна внешняя операция на tenant между процессами, максимум четыре одновременно в процессе. Три автоматические повторные попытки после первой, задержка 60–900 секунд, больший `Retry-After` соблюдается.
- 30 минут — период постановки проверки актуальности в очередь, не обещание проверки каждого товара за 30 минут.
- Начальное связывание категории, выбранные поля, товар, связь, снимок и аудит фиксируются атомарно. Фото применяется отдельным восстанавливаемым этапом.
- Все идентификаторы разрешаются с tenant scope; права и подписка повторно проверяются перед фоновой записью.
- Использовать текущие правила готовности, происхождения значений, уникальности неархивного GTIN и истории архива. `externalRef` остаётся связью с 1С.
- Миграция только добавляет данные/структуры; старые снимки не превращаются в подтверждённые связи.
- `@markiro/ui`, существующие ru/en переводы, доступность и автоматическая ширина таблицы. Не вводить `table-layout: fixed`.
- Не читать и не открывать `.pen` локальными инструментами; эта работа не требует изменения макетов.
- Не печатать токены, URL с секретами, персональные данные и содержимое карточек в диагностике. Не добавлять runtime-зависимости в offline-пути Station/Kiosk.

---

## База и порядок выполнения

Проверено на `main` `f78928a0e4f0ab4030c428b45c767515a1ac628a`; спецификация зафиксирована коммитом `67465999e`. Рабочая ветка подготовки: `codex/national-catalog-import-design`, worktree `.worktrees/national-catalog-import-design`. Перед реализацией проверить свежий `AGENTS.md`, `git status --short` и изменения перечисленных файлов относительно этой базы; чужие изменения сохранять.

Это одна сквозная функция. Выполнять задачи по порядку; HTTP и UI остаются за выключенными возможностями до завершения соответствующих ворот. Задачи 1–5 дают проверяемые внутренние компоненты; 6–11 — серверный процесс; 12–14 — пользовательский процесс и проверку поставки. Не публиковать ветку, PR или релиз без отдельного запроса.

Все пути ниже относительно корня **рабочего worktree**, не другого checkout. Команды запускаются там. Примеры тестов обозначают конкретную первую регрессию; таблицы обязательных сценариев в каждой задаче задают остальные проверки. Утилиты существующих тестов использовать только в указанном файле, где они уже определены.

## Карта файлов и ответственности

| Область                     | Создать                                                                                                                                                                                                                                                                                         | Изменить                                                                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Чистые правила              | `packages/domain/src/catalog/national-catalog.ts`, `packages/domain/test/national-catalog.test.ts`                                                                                                                                                                                              | `packages/domain/src/index.ts`                                                                                                                                                            |
| Tenant API                  | `packages/platform-contracts/src/tenant-national-catalog.ts`, `packages/platform-contracts/test/tenant-national-catalog.test.ts`                                                                                                                                                                | `packages/platform-contracts/src/index.ts`                                                                                                                                                |
| Хранение                    | `packages/db/src/schema/national-catalog-import.ts`, `packages/db/test/national-catalog-import-schema.test.ts`, `packages/db/test/national-catalog-import-migration.test.ts`                                                                                                                    | `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`; файлы новой сгенерированной миграции и её metadata                                                                          |
| Клиент провайдера           | `apps/api/src/modules/national-catalog/national-catalog-list-parser.ts`                                                                                                                                                                                                                         | `national-catalog.client.ts`, `national-catalog.types.ts` в том же модуле; `apps/api/test/national-catalog.client.test.ts`                                                                |
| Общее безопасное скачивание | `apps/api/src/modules/media/bounded-image-download.ts`                                                                                                                                                                                                                                          | `apps/api/src/modules/exchange/commerceml/image-download.ts`, `apps/api/test/commerceml-image-download.test.ts`                                                                           |
| Очередь/квота               | `apps/api/src/modules/national-catalog/national-catalog-request-coordinator.ts`, `apps/api/test/national-catalog-request-coordinator.test.ts`                                                                                                                                                   | `national-catalog.module.ts`, `national-catalog.tokens.ts`                                                                                                                                |
| Сессии                      | `national-catalog-import.types.ts`, `national-catalog-import.repository.ts`, `national-catalog-import.service.ts`, `national-catalog-enumeration.ts` в модуле National Catalog; `apps/api/test/national-catalog-import.service.test.ts`, `apps/api/test/national-catalog-enumeration.test.ts`   | —                                                                                                                                                                                         |
| Предпросмотр                | `national-catalog-import-preview.service.ts` в том же модуле; `apps/api/test/national-catalog-import-preview.test.ts`                                                                                                                                                                           | `national-catalog-proposal.service.ts`                                                                                                                                                    |
| Общая транзакция            | `apps/api/src/modules/product-regulatory/product-regulatory-writer.ts`, `apps/api/src/modules/products/product-writer.ts`                                                                                                                                                                       | `product-regulatory.service.ts`, `products.service.ts`, `apps/api/src/modules/products/dto.ts`; существующие `product-regulatory.e2e.test.ts`, `products.e2e.test.ts`                     |
| Применение                  | `national-catalog-import-apply.service.ts`, `national-catalog-link.service.ts` в модуле; `apps/api/test/national-catalog-import.e2e.test.ts`                                                                                                                                                    | `product-writer.ts`, `product-regulatory-writer.ts`                                                                                                                                       |
| Фото                        | `national-catalog-image.service.ts` в модуле; `apps/api/test/national-catalog-image.test.ts`                                                                                                                                                                                                    | `products.service.ts`, `apps/api/src/modules/media/media-assets.service.ts`                                                                                                               |
| Состояние/актуальность      | `national-catalog-summary.ts` в модуле; `apps/api/test/national-catalog-summary.test.ts`                                                                                                                                                                                                        | `national-catalog-freshness.service.ts`, `products.service.ts`, `products.controller.ts`, `apps/api/test/national-catalog-freshness.service.test.ts`                                      |
| HTTP/фон                    | `national-catalog-import.controller.ts`, `national-catalog-link.controller.ts` в модуле; `apps/api/test/national-catalog-import-auth.e2e.test.ts`                                                                                                                                               | `national-catalog.module.ts`, `apps/api/src/jobs/jobs.module.ts`, `apps/api/src/env.ts`, `.env.example`, `.env.production.example`                                                        |
| UI импорта                  | `apps/admin/src/pages/catalog/national-catalog/{api.ts,ImportPanel.tsx,ImportSelection.tsx,ImportReview.tsx,ImportResult.tsx}`; `apps/admin/test/national-catalog-import.test.tsx`                                                                                                              | `apps/admin/src/App.tsx`, `apps/admin/src/pages/catalog/index.tsx`, `apps/admin/src/i18n/{ru,en}.json`                                                                                    |
| UI связи/статуса            | `apps/admin/src/pages/catalog/national-catalog/{LinkPanel.tsx,ChzStatus.tsx}`, `apps/admin/test/national-catalog-status.test.tsx`                                                                                                                                                               | `apps/admin/src/pages/catalog/{api.ts,index.tsx,ProductForm.tsx,ProductPanelRoute.tsx,catalog.css}`, `apps/admin/src/App.tsx`, ru/en переводы, `apps/admin/test/catalog-routing.test.tsx` |
| Проверка поставки           | `tools/production-browser/national-catalog.playwright.config.ts`, `tools/production-browser/national-catalog-tests/import.spec.ts`, `apps/admin/test/browser/national-catalog-harness.tsx`, `apps/admin/test/browser/national-catalog-harness.html`, `docs/runbooks/national-catalog-import.md` | `tools/production-browser/package.json`, `.github/workflows/ci.yml`, `docs/architecture.md`; существующие диагностические тесты НК                                                        |

Имена без полного пути в строках сервера относятся к `apps/api/src/modules/national-catalog/`. Новые тесты API находятся в `apps/api/test/`. Не переносить весь существующий модуль в новую структуру.

## Контракт между задачами

Задача 1 создаёт строгие Zod-схемы и одноимённые типы ниже в `tenant-national-catalog.ts`. Каждая входная схема `.strict()`. UUID проверять как UUID, GTIN как нормализованный GTIN-14, даты как ISO UTC. `unknown` допускается только в сыром серверном снимке, не в клиентских решениях.

```ts
export type CatalogEnvironment = "production" | "sandbox";
export type ChzStatusKey =
  "draft" | "moderation" | "errors" | "unsigned" | "published" | "archived" | "unknown";
export type ImportStart = { mode: "own_catalog" } | { mode: "gtins"; text: string };
export type ImportSessionState =
  "queued" | "loading" | "ready" | "partial" | "blocked" | "cancelled" | "expired";
export type ImportSession = {
  id: string;
  revision: number;
  mode: ImportStart["mode"];
  state: ImportSessionState;
  loaded: number;
  selected: number;
  startedAt: string;
  throughAt: string;
  expiresAt: string;
  complete: boolean;
  reason: string | null;
};
export type ImportItem = {
  id: string;
  gtin14: string | null;
  input: string | null;
  cardId: string | null;
  name: string | null;
  brand: string | null;
  statusKeys: ChzStatusKey[];
  selected: boolean;
  match:
    | "new"
    | "existing"
    | "linked"
    | "other_link"
    | "archived_local"
    | "ambiguous"
    | "invalid"
    | "inaccessible"
    | "not_found";
  productId: string | null;
  selectable: boolean;
  reason: string | null;
};
export type ImportSelection = {
  expectedRevision: number;
  itemIds: string[];
};
export type ImportPrepare = {
  itemIds: string[];
  manualNames: Array<{ itemId: string; name: string }>;
  categoryChoices: Array<{ itemId: string; optionId: string }>;
};
export type ImportField = {
  id: string;
  label: string;
  before: string | null;
  after: string | null;
  applicable: boolean;
  reason: string | null;
  source: "national_catalog" | "manual";
  selectedByDefault: boolean;
};
export type ImportPhoto = {
  candidateId: string;
  previewPath: string | null;
  state: "pending" | "ready" | "failed";
  primary: boolean;
};
export type ImportPreview = {
  id: string;
  itemId: string;
  productId: string | null;
  expiresAt: string;
  fields: ImportField[];
  photos: ImportPhoto[];
  linkAction: "attach" | "keep" | "replace";
  categoryOptions: Array<{ optionId: string; label: string; selected: boolean }>;
  canApply: boolean;
  reason: string | null;
};
export type ImportDecision = {
  previewId: string;
  acceptedEntryIds: string[];
  linkAction: "attach" | "keep" | "replace";
  photo: { kind: "keep" } | { kind: "candidate"; candidateId: string };
};
export type ImportApply = { requestId: string; decisions: ImportDecision[] };
export type ImportResult = {
  operationId: string;
  state: "pending" | "running" | "finished" | "cancelled";
  items: Array<{
    previewId: string;
    productId: string | null;
    product: "pending" | "applied" | "conflict" | "failed" | "cancelled";
    image: "none" | "pending" | "applied" | "unchanged" | "failed";
    reason: string | null;
  }>;
};
export type ChzSummary = {
  linkId: string | null;
  revision: number | null;
  statusKeys: ChzStatusKey[];
  rawStatus: string | null;
  rawDetailedStatuses: string[];
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  refreshing: boolean;
  lastOutcome: "ok" | "error" | "never";
  hasChanges: boolean;
};
export type CatalogCapabilities = {
  ownCatalog: boolean;
  gtinLookup: boolean;
  photos: boolean;
};
export type ImportItemsQuery = {
  cursor: string | null;
  search: string;
  statuses: ChzStatusKey[];
  includeArchived: boolean;
  limit: number;
};
```

Схемы называются `importStartSchema`, `importSessionSchema`, `importItemSchema`, `importSelectionSchema`, `importPrepareSchema`, `importPreviewSchema`, `importDecisionSchema`, `importApplySchema`, `importResultSchema`, `chzSummarySchema`, `catalogCapabilitiesSchema`, `importItemsQuerySchema`. Типы выводить через `z.infer`, блок выше — контракт, не вторая декларация типов. Для списков возвращать `{ items, nextCursor }`, для подготовки `{ items: ImportPreview[] }`. `reason` — стабильный код причины с переводом UI, не текст исключения провайдера. `optionId` категории — серверный UUID, связанный с item и проверенными group/category/schema; запрос не назначает категорию по произвольному ID. Пустой `categoryChoices` разрешает импорт без начальной привязки.

Серверные общие типы задачи 6 (`national-catalog-import.types.ts`):

```ts
import type { Db } from "@markiro/db";
import type { CatalogEnvironment } from "@markiro/platform-contracts";
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type ImportActor = { tenantId: string; userId: string };
export type ImportContext = ImportActor & { environment: CatalogEnvironment };
export type { ImportItemsQuery } from "@markiro/platform-contracts";
export type LinkChange = {
  expectedRevision: number;
  action: "remove";
};
```

`environment` получается из серверной конфигурации интеграции, никогда из клиентского тела. Все методы с `actor` повторно авторизуют его на записи; чтение использует авторизованный tenant из guard. Схемы ответов и этот блок являются единой точкой согласования между сервером и UI.

### Task 1: Нормализация ввода и строгий контракт импорта

**Files:** новые domain/contract файлы и два `src/index.ts` из карты.

**Interfaces:** `parseImportGtins(text: string): { gtins: string[]; invalid: string[] }`; схемы/типы из контракта выше. Domain не импортирует API-контракты или переводы.

- [ ] Добавить в `packages/domain/test/national-catalog.test.ts` тест нормализации, контрольной цифры и объединения дублей:

```ts
import { expect, it } from "vitest";
import { parseImportGtins } from "../src/catalog/national-catalog.js";
it("keeps valid normalized GTINs while reporting invalid entries", () => {
  expect(parseImportGtins("4006381333931; 04006381333931\n4006381333930, abc")).toEqual({
    gtins: ["04006381333931"],
    invalid: ["4006381333930", "abc"],
  });
});
```

- [ ] Запустить `pnpm --filter @markiro/domain exec vitest run test/national-catalog.test.ts`; ожидать отказ разрешения нового модуля.
- [ ] Реализовать чистую функцию и экспорт:

```ts
import { isValidGtin, normalizeToGtin14 } from "../gs1/gtin.js";
export function parseImportGtins(text: string): { gtins: string[]; invalid: string[] } {
  const gtins = new Set<string>();
  const invalid = new Set<string>();
  for (const input of text.split(/[\s,;]+/u).filter(Boolean)) {
    if (isValidGtin(input)) gtins.add(normalizeToGtin14(input));
    else invalid.add(input);
  }
  return { gtins: [...gtins], invalid: [...invalid] };
}
```

- [ ] Создать Zod-контракты из общего блока. Выбор `ImportSelection.itemIds`: 0–100 уникальных значений, чтобы можно было снять весь выбор; prepare itemIds и apply decisions: 1–100. `acceptedEntryIds`: уникальные UUID; `manualNames`: уникальные itemId, имя после trim 1–200 символов по текущему `createProductSchema`; categoryChoices: максимум один optionId на item из этой сессии. Ввод GTIN ограничить 1 500 000 символов и 100 000 токенов; превышение возвращает отдельную ошибку лимита. Лимит HTTP тела применять только к этому маршруту, не ослаблять глобальные настройки. Фото принимает только candidateId, ссылки отсутствуют в теле.

```ts
it("rejects a caller-controlled photo URL", () => {
  expect(
    importDecisionSchema.safeParse({
      previewId: "00000000-0000-4000-8000-000000000001",
      acceptedEntryIds: [],
      linkAction: "attach",
      photo: {
        kind: "candidate",
        candidateId: "00000000-0000-4000-8000-000000000002",
        url: "https://attacker.example/photo",
      },
    }).success,
  ).toBe(false);
});
```

- [ ] Добавить проверки границ 100/101, повторного previewId и неизвестного поля, GTIN-8/12/13/14, пустого ввода. Выполнить тесты, typecheck, lint, build domain и contracts. Коммитить четыре новых файла и два index явно: `feat: define tenant National Catalog import contracts`.

### Task 2: Долговечные сессии, связи и результаты

**Files:** DB-файлы из карты и новая миграция.

**Interfaces:** экспорт Drizzle-таблиц `nationalCatalogImportSessions`, `nationalCatalogImportItems`, `nationalCatalogImportPreviews`, `nationalCatalogImportOperations`, `nationalCatalogImportOperationItems`, `nationalCatalogProductLinks`, `nationalCatalogRequestLeases`, `nationalCatalogImportImages`. Все PK UUID, кроме tenant-ключа lease. Composite UNIQUE `(tenant_id,id)` используется каждой межтабличной FK.

- [ ] В новом schema-тесте проверить tenant FK, единственную текущую связь и отсутствие глобальной уникальности cardId. Первая регрессия:

```ts
import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { nationalCatalogProductLinks } from "../src/schema/national-catalog-import.js";
it("scopes a product link to the product tenant", () => {
  const keys = getTableConfig(nationalCatalogProductLinks).foreignKeys;
  expect(
    keys.some(
      (key) =>
        key
          .reference()
          .columns.map((c) => c.name)
          .join(",") === "tenant_id,product_id",
    ),
  ).toBe(true);
});
```

- [ ] Запустить новый schema-тест; ожидать отсутствие экспорта. Создать схемы со следующими обязательными данными:

| Таблица         | Данные и ограничения                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sessions        | tenant, actor, environment, mode, state, revision, start/through/expiry, loaded/selected, interval stack/cursor/checkpoint, catch-up boundary, incomplete reason, cancelledAt                                                            |
| items           | tenant+session, input, normalized GTIN, cardId, краткие поля списка, match, selected, собственный/предоставленный источник, сырой ограниченный снимок, hash; unique session+cardId+GTIN для найденных карточек; ошибочные входы отдельны |
| previews        | tenant+session+item, expiresAt, pinned source/hash, ожидаемые product/profile/link/schema revisions, старые значения/фото, diff, manual provenance; immutable после выдачи                                                               |
| operations      | tenant+session, actor, requestId, canonical decision hash, state, timestamps; unique tenant+requestId; enqueuePending                                                                                                                    |
| operation_items | tenant+operation+preview, exact decision, product result, image result, productId, error code, attempts/nextAttempt; unique operation+preview                                                                                            |
| links           | tenant+product, environment, cardId, boundGtin14, revision, confirmedBy/At, closedBy/At/reason, latestSnapshotId, reviewedSnapshotId, lastAttempt/Success/outcome, raw statuses, meaningful observed/reviewed hashes                     |
| request_leases  | tenant PK, owner UUID, fence bigint, leaseUntil, nextAllowedAt, total/method quota metadata, updatedAt                                                                                                                                   |
| images          | tenant+session+preview+candidate, source snapshot reference, private staged asset reference, processed checksum/size/dimensions, state/expiry; URL хранится только на сервере                                                            |

- [ ] Добавить SQL-ограничения в генерируемую миграцию средствами Drizzle. Ключевая уникальность:

```sql
CREATE UNIQUE INDEX national_catalog_product_links_current
ON national_catalog_product_links (tenant_id, product_id)
WHERE closed_at IS NULL;
```

FK снимков подтверждённой связи должна проверять tenant+product, а не только UUID. `reviewedSnapshotId` и `latestSnapshotId` nullable до первой проверки; relation не требует наличие regulatory profile. Закрытые связи не удаляются вместе с истечением сессии. Удаление временного payload разрешено только при отсутствии незавершённого применения/фото; compact operation receipts и применённые снимки сохраняются. Нельзя cascade-delete аудит или продуктовую историю.

- [ ] Добавить schema-файл в явный список `drizzle.config.ts`, экспортировать через schema.ts. Выполнить `pnpm --filter @markiro/db db:generate --name national_catalog_product_import`; использовать фактически созданный номер миграции (на проверенной базе следующий 0116), не переписывать старые SQL/metadata.
- [ ] Написать migration-тест по изолированной scratch-DB схеме `product-regulatory-hardening-migration.test.ts`: копировать миграции до текущего предыдущего index; создать tenant/product/старый snapshot; применить новую; убедиться, что текущих links ноль, snapshot/GTIN/name/provenance сохранены. Проверить отказ cross-tenant FK и две карточки с одним cardId для двух packaging GTIN. SQL проверки отсутствия автоматической связи:

```sql
SELECT count(*)::int AS count FROM national_catalog_product_links;
SELECT id, tenant_id, product_id, gtin14, card_id
FROM national_catalog_card_snapshots ORDER BY id;
```

Для второго запроса проверять исходные значения fixture, не только count. Никогда не мигрировать тестом production или очищать общую development DB.

- [ ] Выполнить DB test/typecheck/lint/build, новый migration-тест с тестовым DATABASE_URL. При отсутствии DB этот этап не считать принятым. Проверить SQL и staged diff; коммит `feat(db): persist National Catalog import sessions and links` только перечисленных schema/test и реально созданных migration paths.

### Task 3: Список своих карточек и чтение по cardId

**Files:** клиент/типы/parser и существующий client-тест из карты.

**Interfaces:** добавить в `national-catalog.types.ts`:

```ts
export type NationalCatalogListRequest = {
  updatedFrom: string;
  updatedTo: string;
  offset: number;
  limit: number;
};
export type NationalCatalogListRow = {
  cardId: string;
  gtins: string[];
  name: string | null;
  brand: string | null;
  status: string | null;
  detailedStatuses: string[];
  raw: Record<string, unknown>;
};
export type NationalCatalogListPage = {
  rows: NationalCatalogListRow[];
  nextOffset: number | null;
};
export type NationalCatalogListResult =
  NationalCatalogResult<NationalCatalogListPage> | { status: "selection_too_large" };
```

Методы клиента: `listOwnProducts(auth: NationalCatalogAuth, request: NationalCatalogListRequest): Promise<NationalCatalogListResult>`; `getFeedProductsByIds(auth: NationalCatalogAuth, cardIds: string[], options?: NationalCatalogRequestOptions): Promise<NationalCatalogResult<NationalCatalogProductsResponse>>`. Старые методы сохраняются. В нормализованный `NationalCatalogProduct` добавить `detailedStatuses: string[]` и `images: Array<{ sourceId: string; url: string; barcode: string | null; primary: boolean }>`.

- [ ] Добавить в существующий `national-catalog.client.test.ts`:

```ts
it("does not interpret an oversized period as an empty catalogue", async () => {
  const client = new NationalCatalogClient(
    dependencies(async () => new Response("", { status: 413 })),
  );
  await expect(
    client.listOwnProducts(auth, {
      updatedFrom: "1970-01-01 00:00:00",
      updatedTo: "2026-09-08 12:00:00",
      offset: 0,
      limit: 1000,
    }),
  ).resolves.toEqual({ status: "selection_too_large" });
});
```

- [ ] Запустить файл; ожидать отсутствие метода. Добавить отдельный путь списка, сохранив общий `NationalCatalogResult` для прежних потребителей. Конкретное правило обработки статуса перед общим разбором:

```ts
if (response.status === 413) return { status: "selection_too_large" };
```

Wire-контракт повторно проверен 2026-09-08: список — GET с `from_date`, `to_date`, `offset`, `limit`; ответ `result.goods`, `result.total/offset/limit`. Row содержит `good_id`, `gtin`, `good_name`, `brand_name`, `good_status`, `good_detailed_status`. ID-поиск — GET `good_ids`, разделитель `;`, без одновременной передачи single selectors. Авторизация — существующий Bearer. [Официальный контракт](https://docs.crpt.ru/gismt/API_%D0%9D%D0%9A/).

```ts
const query = new URLSearchParams({
  from_date: request.updatedFrom,
  to_date: request.updatedTo,
  offset: String(request.offset),
  limit: String(request.limit),
});
const path = `/v4/product-list?${query.toString()}`;
```

Не запрашивать offset+limit >10000. `nextOffset=null` только при подтверждённом `offset+goods.length >= total`; пустая страница при невыполненном условии — invalid_response. Проверить echoed offset, total 0–10000, целые безопасные ID и размер страницы. Неизвестные статусы сохраняются; detailed `notsigned` отображается внутренним `unsigned`. Фото `good_img`/`good_images` разбирать с type guard, неправильную отдельную фотографию отбрасывать с причиной, правильную карточку сохранять.

- [ ] Закрепить запросы period/offset/limit, batch 25/26, multi GTIN на cardId, несколько detailed statuses, primary/photo barcode, 401/403/404/429/413/5xx, Retry-After и ограничения ответа. Отдельно доказать, что метод по cardId использует `good_id`, а не повторный поиск другого товара по GTIN.
- [ ] Выполнить client-тест, API typecheck/lint. Коммит `feat(api): read own National Catalog pages and cards by id`.

### Task 4: Общий ограниченный загрузчик изображений

**Files:** общий downloader, CommerceML wrapper и существующий тест из карты.

**Interfaces:** `downloadBoundedImage(rawUrl: string, policy: ImageDownloadPolicy, deps?: ImageDownloadDeps): Promise<Buffer>`, где `ImageDownloadPolicy = { maxBytes: number; timeoutMs: number; maxRedirects: number; allowedHosts: readonly string[] | null }`. `ImageDownloadDeps` сохраняет текущее `{ request?: typeof httpsRequest }`. Экспортировать существующие `ImageDownloadError`, `isForbiddenAddress` из нового файла и реэкспортировать wrapper для совместимости.

- [ ] В существующем `commerceml-image-download.test.ts`, где уже определён `fakeRequestFor`, добавить тест нового импорта:

```ts
it("checks the allowlist again after a redirect", async () => {
  await expect(
    downloadBoundedImage(
      "https://images.example/a",
      {
        maxBytes: 5 * 1024 * 1024,
        timeoutMs: 15_000,
        maxRedirects: 2,
        allowedHosts: ["images.example"],
      },
      {
        request: fakeRequestFor({
          "https://images.example/a": {
            status: 302,
            headers: { location: "https://other.example/a" },
          },
        }),
      },
    ),
  ).rejects.toMatchObject({ reason: "forbidden_host" });
});
```

- [ ] Выполнить тест и получить отсутствие экспорта. Перенести текущую реализацию без изменения connection-time guardedLookup, IPv4/IPv6/NAT64 правил, общего дедлайна и slow-drip защиты. Перед каждым hop добавить:

```ts
if (url.username !== "" || url.password !== "") {
  throw new ImageDownloadError("forbidden_host", "credentials in URL");
}
if (policy.allowedHosts !== null && !policy.allowedHosts.includes(url.hostname.toLowerCase())) {
  throw new ImageDownloadError("forbidden_host", "host outside configured allowlist");
}
```

Новый reason включить в union. Пустой allowlist для ЧЗ запрещает скачивание; `null` используется только старым CommerceML. Не отправлять bearer/cookies и не поддерживать произвольные заголовки из карточки. Лимиты bytes/deadline/redirect брать из policy; переносить проверку каждого параметра в начало (положительные числа, redirects 0–3).

- [ ] Оставить `downloadImage(rawUrl,deps)` CommerceML-обёрткой с прежними 5 MiB/10 секунд/3 redirects и `allowedHosts: null`. Расширить тесты: второй redirect допустим, третий отказ; DNS rebinding; redirect на private IP; IPv6; 5 MiB+1; общий 15s deadline; credentials; отсутствующий/ошибочный content-type не обходит декодер.
- [ ] Выполнить весь `commerceml-image-download.test.ts`, связанные image processor тесты и API typecheck/lint. Коммит `refactor(api): share bounded private-address-safe image downloads`.

### Task 5: Общая квота и восстановимые внешние запросы

**Files:** coordinator, его тесты, tokens/module из карты.

**Interfaces:** `NationalCatalogRequestCoordinator.run<T>(context: ImportContext, request: () => Promise<T>): Promise<T>`; `nextRetryAt(attempt: number, now: Date, retryAfterSeconds: number | null): Date`; `verifyCatalogEnvironment(expected: CatalogEnvironment, trueApiBaseUrl: string, catalogBaseUrl: string): void` (отказ до HTTP при несогласованной зарегистрированной паре).

- [ ] Создать первый тест:

```ts
import { expect, it } from "vitest";
import { nextRetryAt } from "../src/modules/national-catalog/national-catalog-request-coordinator";
it("honors a Retry-After longer than the ordinary backoff", () => {
  const now = new Date("2026-09-08T09:00:00Z");
  expect(nextRetryAt(1, now, 1800).toISOString()).toBe("2026-09-08T09:30:00.000Z");
});
```

- [ ] Запустить файл до реализации. Реализовать расчёт:

```ts
export function nextRetryAt(attempt: number, now: Date, retryAfterSeconds: number | null): Date {
  const delay = Math.max(Math.min(900, 60 * 2 ** Math.max(0, attempt - 1)), retryAfterSeconds ?? 0);
  return new Date(now.getTime() + delay * 1000);
}
```

- [ ] Реализовать tenant lease: атомарный `UPDATE ... WHERE lease_until <= now() AND next_allowed_at <= now() RETURNING fence`; если строки нет — безопасный insert/on-conflict-do-nothing и повторная попытка, без ожидания внутри DB-транзакции. Lease 60s; HTTP принудительно прерывается за 15s, результат принимается только при совпадающих owner/fence и ещё действующей lease. Освобождение CAS по owner/fence. При сомнении во времени истечения проверять Postgres `now()`, не часы worker. Пример условия записи:

```sql
UPDATE national_catalog_request_leases
SET lease_until = now(), updated_at = now()
WHERE tenant_id = $1 AND owner = $2 AND fence = $3;
```

Локальный semaphore 4 оборачивает фактический запрос, не ожидание backoff. Все новые list/detail/refresh операции используют coordinator; полученные total/method quota и Retry-After сохраняются до освобождения. Удалённая/просроченная auth даёт blocked без бесконечных ретраев. Ошибки транспорта/429/5xx — максимум три повтора; после этого visible partial/failed, явный ручной retry получает новый цикл в пределах срока сессии. Не держать транзакцию открытой на HTTP.

- [ ] Проверить двумя worker-экземплярами на тестовой DB: maxActive per tenant=1, разные tenants обслуживаются, maxActive процесса=4; истечение lease, stale fence, restart, квота общая между list и refresh, HTTP никогда не вызывается при mismatch environment. Сравнить baseUrl токена из ChzTokenService с реестром разрешённых пар, URL с портом/путём/подменой host отклонять.
- [ ] Выполнить тесты и API gates; коммит `feat(api): coordinate National Catalog requests across workers`.

### Task 6: Возобновляемый список и ввод GTIN

**Files:** четыре файла сессий/типов/enumeration и два теста из карты.

**Interfaces:** `NationalCatalogImportService.start(actor: ImportActor, body: ImportStart): Promise<ImportSession>`, `read(tenantId: string, sessionId: string): Promise<ImportSession>`, `items(tenantId: string, sessionId: string, query: ImportItemsQuery): Promise<{ items: ImportItem[]; nextCursor: string | null }>`, `select(actor: ImportActor, sessionId: string, body: ImportSelection): Promise<ImportSession>`, `cancel(actor: ImportActor, sessionId: string): Promise<ImportSession>`, `resume(tenantId: string, sessionId: string): Promise<void>`. Repository хранит и блокирует строки внутри переданного `DbTx`; публичные операции не принимают tenant из body.

- [ ] В `national-catalog-enumeration.test.ts` определить тест деления интервала с перекрытием:

```ts
import { expect, it } from "vitest";
import { splitCatalogInterval } from "../src/modules/national-catalog/national-catalog-enumeration";
it("overlaps the midpoint and refuses an unsplittable second", () => {
  expect(splitCatalogInterval(0, 4000)).toEqual([
    [0, 2000],
    [2000, 4000],
  ]);
  expect(splitCatalogInterval(0, 1000)).toBeNull();
});
```

- [ ] Выполнить тест красным. Реализовать чистое правило:

```ts
export function splitCatalogInterval(
  from: number,
  to: number,
): [[number, number], [number, number]] | null {
  const midpoint = Math.floor((from + to) / 2000) * 1000;
  return midpoint <= from || midpoint >= to
    ? null
    : [
        [from, midpoint],
        [midpoint, to],
      ];
}
```

- [ ] Реализовать `resume`: прочитать durable checkpoint, получить одну страницу через coordinator, транзакционно upsert items по card+GTIN и продвинуть checkpoint/revision. 413 разбивает интервал, несжимаемый интервал помечается incomplete; курсор, hash повторной страницы, лимит строк проверяются до продвижения. Завершив основной обход, зафиксировать новую throughAt и выполнить один catch-up проход от startedAt минус одна секунда; точность и timezone преобразовать через один provider formatter, подтверждаемый live gate. Стабильный курсор UI — последняя `(created_at,id)` строка, не provider offset.
- [ ] Реализовать режим GTIN: сохранить invalid отдельно, chunk нормализованных кодов по 25, только feed-product. Несколько карточек сохраняются отдельными item, требуя явного выбора; packaging идентичность card+GTIN сохраняется. Provider 403, 404 и пустой успешный результат дают разные коды. При ошибке пачки успешно обработанные другие пачки остаются. Архивные карточки не selectable; local archived товар требует штатного ручного сценария. Выбор сохраняется сервером и валидируется по session revision; 101 позиция — 422 без частичного изменения выбора.
- [ ] Добавить DB/service fixtures и проверить crash между HTTP и commit, crash после commit, repeated page, 413, unsplittable interval, 100001-я строка, catch-up, один itemId другого tenant, отмена/expiry, выбор между страницами, retry partial, GTIN access без public fallback. Для crash-after-commit дважды вызвать `resume` с одним checkpoint: число item и курсор не меняются второй раз. Финальный `complete=true` ставить только после обоих завершённых обходов.
- [ ] Выполнить новые тесты, DB build перед API consumers, API gates. Коммит `feat(api): persist resumable National Catalog selection sessions`.

### Task 7: Сравнение до создания товара

**Files:** preview service/test, существующий proposal service.

**Interfaces:** `NationalCatalogImportPreviewService.prepare(actor: ImportActor, sessionId: string, body: ImportPrepare): Promise<{ items: ImportPreview[] }>`; `defaultAcceptedEntries(mode: "new" | "existing", fields: ImportField[]): string[]` в preview service. При подготовке сохранять неизменяемый server diff, для UI отдавать только разрешённые значения и candidate IDs.

- [ ] Создать тест defaults:

```ts
import { expect, it } from "vitest";
import { defaultAcceptedEntries } from "../src/modules/national-catalog/national-catalog-import-preview.service";
it("requires explicit field acceptance for an existing product", () => {
  const fields = [
    {
      id: "name",
      label: "Название",
      before: "Моё",
      after: "Из ЧЗ",
      applicable: true,
      reason: null,
      source: "national_catalog" as const,
      selectedByDefault: false,
    },
  ];
  expect(defaultAcceptedEntries("existing", fields)).toEqual([]);
  expect(defaultAcceptedEntries("new", fields)).toEqual(["name"]);
});
```

- [ ] Выполнить красным. Реализовать правило:

```ts
export function defaultAcceptedEntries(mode: "new" | "existing", fields: ImportField[]): string[] {
  return mode === "existing"
    ? []
    : fields.filter((field) => field.applicable).map((field) => field.id);
}
```

- [ ] Подготовка запрашивает detail только для выбранных cardId, проверяет bound GTIN и own/delegated source. `good_name` создаёт отдельный валидированный entry независимо от regulatory profile. Если имя отсутствует, `manualNames` даёт entry source=manual; без имени новая позиция canApply=false. Прочие stable/attribute entries строить существующим `buildNationalCatalogImportEntries`, только с активной совместимой схемой и reviewed mapping. Без неё показать исходные данные read-only, разрешить связь/name/photo/status. Не активировать схему автоматически.
- [ ] Для начальной категории вернуть `categoryOptions` из активных схем и reviewed group mappings, сохранить их optionId рядом с item. Первый prepare без categoryChoices возвращает варианты; UI отправляет выбранный optionId повторным prepare. Выбор создаёт явный category entry и зависимые attribute entries; принять attribute без его начального category entry нельзя. Для существующего profile использовать его категорию; смену категории выполнять штатным отдельным category-change процессом. Для нового товара без category choice группа и capacities остаются null, статус вычисляется прежним правилом.
- [ ] Зафиксировать expected product identity, старые stable values, profile revision, schema version/status, link revision/cardId/environment, текущий image descriptor, latest/reviewed hashes. При отсутствии product хранить `expectedAbsentGtin`; при существующем product с другой связью выдать `replace`, не подтверждать его за пользователя. Подготовка не создаёт product/link/regulatory proposal с вымышленным productId. Server diff хранится в preview, после применения materialize в существующую историю с реальным productId.
- [ ] Фото-кандидаты выбираются по совпадающему barcode/GTIN, затем good_img, затем единственной однозначной альтернативе; чужой barcode никогда не выбирается автоматически. Кандидат сначала pending, preview bytes появятся в задаче 9. Нельзя использовать истёкший snapshot из другой сессии, подменённый cardId или переданное клиентом before/after.
- [ ] Проверить unbound product, blank draft/manual name, inactive schema, несовместимую группу, несколько cardId, архивы, replacement link, cross-tenant snapshot/preview, отсутствие изменений и link-only. Запустить новый тест и `national-catalog-proposal.service.test.ts`; коммит `feat(api): prepare National Catalog comparisons before product creation`.

### Task 8: Атомарное применение и подтверждённая связь

**Files:** writers, apply/link services, существующие regulatory/product e2e и новый import e2e из карты.

**Interfaces:** вынести внутреннюю часть `ProductRegulatoryService.applyProposal` в `ProductRegulatoryWriter.applyInTransaction(tx: DbTx, tenantId: string, actorUserId: string, productId: string, proposalId: string, body: ApplyRegulatoryProposalDto): Promise<"applied" | "replay" | "stale">`. DTO импортируется из существующего `product-regulatory/dto.ts`; writer не инжектирует service и не открывает свою транзакцию. `ProductWriter.createInTransaction(tx: DbTx, tenantId: string, data: CreateProductDto): Promise<string>` возвращает productId с прежними валидациями, DTO из `products/dto.ts`. `NationalCatalogImportApplyService.start(actor: ImportActor, sessionId: string, body: ImportApply): Promise<ImportResult>`, `read(tenantId: string, sessionId: string, operationId: string): Promise<ImportResult>`, `resume(tenantId: string, operationId: string): Promise<void>`, `retry(actor: ImportActor, sessionId: string, operationId: string, previewIds: string[]): Promise<ImportResult>`. `NationalCatalogLinkService.read(tenantId: string, productId: string): Promise<ChzSummary>`, `remove(actor: ImportActor, productId: string, body: LinkChange): Promise<ChzSummary>`.

- [ ] Начать с refactor guard: в существующем `product-regulatory.e2e.test.ts` закрепить точный persisted source/sourceRef, accepted IDs и rollback при stale profile. В новом import e2e использовать setup `AppModule`/Better Auth/активной подписки из этого файла; создать две реальные организации, HTTP-агенты и override NationalCatalogClient/ObjectStorage. Первый тест после fixture setup обязан выполнить link-only и проверить имя:

```ts
expect(result.items[0]).toMatchObject({ productId, product: "applied", image: "none" });
expect(after.name).toBe(before.name);
expect(currentLink).toMatchObject({ tenantId, productId, cardId: "720679", closedAt: null });
expect(audit).toMatchObject({
  organizationId: tenantId,
  actorUserId,
  action: "national_catalog.link.confirmed",
  outcome: "success",
  targetType: "product",
  targetId: productId,
});
```

Здесь `result` — ответ apply/read HTTP сценария, `before/after/currentLink/audit` — реальные запросы тестовой DB по её tenant; объявить их в тесте. Не подменять ответ apply фиксированным fixture и не проверять лишь число строк аудита.

- [ ] Выполнить новые regression assertions до реализации; получить отсутствие пути/связи. Извлечь writers перемещением проверенного тела, оставив публичные методы тонкими transaction wrappers. Сохранить порядок блокировок product→profile→proposal; initial category binding и subsequent attribute proposal формируются и применяются в **одной** внешней transaction. Новые записи origin используют реальный sourceRef снимка и manual source для исправленного имени.

Публичный `applyProposal` сохраняет нынешнюю семантику: stale marker commit, затем 409; после успеха `getProfile` вызывается уже после commit. Импорт при `stale` откатывает всю позицию, включая начальную категорию, и отдельно сохраняет conflict receipt. Writer не читает профиль через другой connection внутри ещё открытой transaction.

Прямое `good_name` не маскировать под stable-field mapping с вымышленным mappingId/schemaVersion. Оно проходит `createProductSchema.shape.name` и optimistic before-value проверку; его snapshot sourceRef, before/after, source и accepted entryId сохраняются в immutable operation item и аудите. При этом regulatory entries продолжают идти через текущий proposal engine с реальными mapping IDs. Для одного target `name` создавать только один entry, прямой `good_name` имеет приоритет над дублирующим attribute mapping; ручная корректировка меняет source этого entry на manual. Новая позиция без принятого валидного имени отклоняется даже если пользователь снял checkbox после preview.

- [ ] Сохранить apply request и exact decisions до очереди. `requestId` unique per tenant: повтор тех же canonical decisions возвращает сохранённый result; иное тело — 409. Canonical representation сортирует решения по previewId и accepted IDs, но сохраняет link/photo choices:

```ts
const canonicalDecisions = body.decisions
  .map((decision) => ({
    previewId: decision.previewId,
    acceptedEntryIds: [...decision.acceptedEntryIds].sort(),
    linkAction: decision.linkAction,
    photo:
      decision.photo.kind === "keep"
        ? { kind: "keep" }
        : { kind: "candidate", candidateId: decision.photo.candidateId },
  }))
  .sort((a, b) => a.previewId.localeCompare(b.previewId));
const decisionHash = createHash("sha256").update(JSON.stringify(canonicalDecisions)).digest("hex");
```

Использовать fixed-key объект при сериализации каждого decision/photo, чтобы порядок ключей JSON не влиял на digest. Exact stored request сравнивать через одну каноническую функцию и применять её в retry.

- [ ] Для каждой позиции: повторная auth/subscription/tenant проверка; lock operation item; сначала replay уже applied; затем expiry/identity/revisions/old values/old image/schema. Конкурентно созданный GTIN превращается в conflict, не update. При замене закрыть прежнюю link с actor/reason, вставить новую; при keep проверить тот же cardId. Materialize snapshot с productId, применить выбранные поля/writers, обновить reviewed baseline даже link-only, записать точный аудит и receipt. Все действия позиции — один commit. Исключение инфраструктуры откатывает позицию и остаётся retryable, бизнес-конфликт сохраняется отдельным результатом; следующая позиция продолжается.
- [ ] Удаление связи закрывает history, сохраняет поля/фото, пишет аудит. Редактирование GTIN в `ProductsService.updateProduct` при текущей связи без явного detach отклоняется 409 `CHZ_LINK_REQUIRES_DETACH`. Расширить `updateProductSchema` полем `chzLinkChange: { action: "detach"; expectedRevision: number }`, optional, strict nested object. GTIN+detach выполняются в существующей transaction атомарно; при stale revision оба откатываются. Старые клиенты без detach получают 409. Новая связь на новый GTIN создаётся только новым preview.
- [ ] Проверить initial category+attrs rollback, неизменность operational fields, replay после expiry уже применённой позиции, другой body с тем же requestId, две операции на один GTIN, stale link/profile/schema/old field, duplicate target IDs, cross-tenant все session/item/preview/product/link/operation ID, actor потерял роль после preview, закрытый tenant/subscription, exact audit target/result/metadata. Не подавлять 23505 от нецелевого ограничения как GTIN conflict.
- [ ] Выполнить новые e2e и все regulatory/product regression tests с DB, API gates; коммит `feat(api): apply confirmed National Catalog links and selected fields atomically`.

### Task 9: Приватное фото и независимый повтор

**Files:** image service/test, products/media services из карты.

**Interfaces:** `NationalCatalogImageService.prepare(actor: ImportActor, sessionId: string, previewId: string, candidateId: string): Promise<ImportPhoto>`, `apply(tenantId: string, operationId: string, previewId: string): Promise<void>`, `readPreview(tenantId: string, sessionId: string, candidateId: string): Promise<{ buffer: Buffer; contentType: "image/webp" }>`; сервер не принимает URL от пользователя. Новый внутренний `ProductsService.applyPreparedImage` принимает processed descriptor, actor и expected current descriptor, использует существующую stage/activate схему с CAS в transaction; типы взять из существующего processor, не дублировать WebP модель.

- [ ] Добавить image-service тест выбора по GTIN с функцией `chooseDefaultPhoto(gtin14: string, photos: Array<{ candidateId: string; barcode: string | null; primary: boolean }>): string | null`:

```ts
it("does not select a primary photo belonging to a different GTIN", () => {
  expect(
    chooseDefaultPhoto("04006381333931", [
      { candidateId: "other", barcode: "04601234567893", primary: true },
    ]),
  ).toBeNull();
});
```

- [ ] Запустить красным. Реализовать выбор:

```ts
export function chooseDefaultPhoto(
  gtin14: string,
  photos: Array<{
    candidateId: string;
    barcode: string | null;
    primary: boolean;
  }>,
): string | null {
  const matching = photos.filter((photo) => photo.barcode === gtin14);
  const candidates =
    matching.length > 0 ? matching : photos.filter((photo) => photo.barcode === null);
  const primary = candidates.filter((photo) => photo.primary);
  if (primary.length === 1) return primary[0]?.candidateId ?? null;
  return candidates.length === 1 ? (candidates[0]?.candidateId ?? null) : null;
}
```

Нормализовать barcode перед вызовом через domain, ошибочный barcode не превращать в «не указан». good_img отмечать primary только при отсутствии более точного matching GTIN. Кандидат ID — UUID серверной записи, пример коротких ID выше используется только чистым тестом.

- [ ] `prepare` разрешает URL только из pinned snapshot, применяет downloader policy 5 MiB/15s/2redirects+verified host list и существующий bounded decoder. Сохранить нормализованные bytes и checksum в приватном staging; именно эти bytes отдавать preview и активировать после подтверждения. Не скачивать оригинал повторно после согласия, иначе пользователь примет другое фото. Просроченный preview требует нового выбора; отсутствие оригинала не удаляет действующее фото.
- [ ] Фото после product commit ставится pending в том же operation item; `apply` проверяет product applied, выбранный candidate, tenant, актуальное право actor и expected descriptor перед swap. Равный checksum → unchanged; изменённое после preview локальное фото → failed conflict, не замена. Failed download/decode/storage оставляет product applied; отдельный retry не повторяет product/field writes. Durable enqueue repair поднимает pending image после crash. Cleanup удаляет только временные/неактивные assets без ссылок; принятый source snapshot/receipt остаётся.
- [ ] Проверить ready preview checksum=active checksum, явный выбор замены, отсутствие фото, oversized/animated/corrupt, очередь decoder2/8, другойtenant candidate/session, private preview auth, retry после product success, crash перед swap/после swap, прежний offline descriptor/version. Выполнить image tests и существующий `product-image-device-access.e2e.test.ts`; коммит `feat(api): import one selected National Catalog image with independent retry`.

### Task 10: Наблюдения, сравнение и статус каталога

**Files:** summary/test, freshness service/test, products service/controller.

**Interfaces:** `buildChzSummary(input: { linkId: string | null; revision: number | null; statusKeys: ChzStatusKey[]; rawStatus: string | null; rawDetailedStatuses: string[]; lastSuccessAt: string | null; lastAttemptAt: string | null; refreshing: boolean; lastOutcome: "ok" | "error" | "never"; observedHash: string | null; reviewedHash: string | null }): ChzSummary`; `NationalCatalogLinkService.refresh(actor: ImportActor, productId: string): Promise<ChzSummary>` только ставит deduplicated job. `read` возвращает сохранённые сведения без внешнего HTTP.

- [ ] Добавить тест сохранения статуса после ошибки:

```ts
it("retains the last known status and success time on a failed refresh", () => {
  const value = buildChzSummary({
    linkId: "link",
    revision: 1,
    statusKeys: ["published"],
    rawStatus: "published",
    rawDetailedStatuses: [],
    lastSuccessAt: "2026-09-08T09:00:00Z",
    lastAttemptAt: "2026-09-08T10:00:00Z",
    refreshing: false,
    lastOutcome: "error",
    observedHash: "reviewed",
    reviewedHash: "reviewed",
  });
  expect(value).toMatchObject({
    statusKeys: ["published"],
    lastSuccessAt: "2026-09-08T09:00:00Z",
    lastOutcome: "error",
    hasChanges: false,
  });
});
```

- [ ] Выполнить красным. Реализовать hasChanges только по осмысленной наблюдаемой проекции:

```ts
const hasChanges =
  input.linkId !== null &&
  input.observedHash !== null &&
  input.reviewedHash !== null &&
  input.observedHash !== input.reviewedHash;
```

Проекция включает поддерживаемые переносимые значения и checksum выбранного соответствующего фото, исключает технические поля, порядок атрибутов, время получения, URL. Значения приводятся теми же mapping conversions, что preview. `reviewedHash` обновляется при accept/reject/link-only; rejected diff остаётся доступным в сравнении, но не создаёт вечный badge. Ошибка скачивания фото не утверждает, что фото изменилось. Unknown raw статусы сохранять; mapping ключей подтверждать provider fixture, не угадывать смысл числового статуса.

- [ ] Перевести freshness на текущие confirmed links и чтение по cardId; проверять boundGTIN и environment после ответа. Утрата GTIN → visible conflict, без перепривязки. Из отсутствия карточки в частичном списке архив не выводить. При ошибке обновлять lastAttempt/outcome, сохранять lastSuccess/status/snapshot. Порядок due links — справедливая ротация tenant и oldest attempt; ручной refresh дедуплицируется. ETag применять только когда поддержан методом; content hash не отправлять как ETag.
- [ ] Добавить `chz?: ChzSummary` в ProductDto: новый сервер всегда выдаёт summary, отсутствующий ключ от старого сервера означает «Сведения недоступны», linkId=null — «Не связан». Product list делает один tenant-scoped join current links, не N+1 и не внешний HTTP. Фильтр `chzStatus` разрешает unlinked/unknown и любой показанный statusKey; multi-status совпадает по любому. Station/kiosk не получают сырые снимки или токен; guard GET products сохранить совместимым с `AllowStationOrPermissions`.
- [ ] Проверить link never checked, removed link, multiple labels, unknown raw, error/stale, reject then same refresh, raw-only changes, changedphoto sameURL, unchangedphoto newURL, pagination/filter isolation. Выполнить summary/freshness/products tests; коммит `feat(api): expose confirmed CHZ status and meaningful change tracking`.

### Task 11: HTTP, фоновые задания и доступность возможностей

**Files:** controllers/module/jobs/env/auth e2e из карты.

**Interfaces:** все маршруты ниже используют общие схемы, серверный tenant/actor и существующие auth/subscription guards.

| Метод/путь                                                                       | Данные                                    | Доступ                                |
| -------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------- |
| GET `/national-catalog/capabilities`                                             | CatalogCapabilities                       | OPERATIONS_READ                       |
| POST `/national-catalog/import-sessions`                                         | ImportStart → ImportSession               | OPERATIONS_WRITE + subscription write |
| GET `/national-catalog/import-sessions/:sessionId`                               | ImportSession                             | READ                                  |
| GET `/national-catalog/import-sessions/:sessionId/items`                         | ImportItemsQuery → items/cursor           | READ                                  |
| PUT `/national-catalog/import-sessions/:sessionId/selection`                     | ImportSelection → ImportSession           | WRITE                                 |
| POST `/national-catalog/import-sessions/:sessionId/previews`                     | ImportPrepare → previews                  | WRITE                                 |
| GET `/national-catalog/import-sessions/:sessionId/images/:candidateId`           | private WebP                              | READ                                  |
| POST `/national-catalog/import-sessions/:sessionId/applies`                      | ImportApply → ImportResult                | WRITE                                 |
| GET `/national-catalog/import-sessions/:sessionId/applies/:operationId`          | ImportResult                              | READ                                  |
| POST `/national-catalog/import-sessions/:sessionId/applies/:operationId/retries` | `{ previewIds: string[] }` → ImportResult | WRITE                                 |
| POST `/national-catalog/import-sessions/:sessionId/cancel`                       | ImportSession                             | WRITE                                 |
| GET `/products/:id/national-catalog/link`                                        | ChzSummary                                | READ                                  |
| POST `/products/:id/national-catalog/link/refresh`                               | ChzSummary                                | WRITE                                 |
| DELETE `/products/:id/national-catalog/link`                                     | LinkChange → ChzSummary                   | WRITE                                 |

WRITE в таблице всегда включает subscription write. Legacy `/lookups` и `/import-previews` сохраняются. Query-schema ограничивает limit 1–100, search до 500 символов и status enum; cursor opaque и tenant/session bound. Методы применяются без bodytenant/environment. Station auth не открывает новые tenant routes.

- [ ] Добавить auth e2e по существующему реальному Better Auth setup. Для каждого маршрута проверить кабинет read/write, чужой tenant ID, отозванную membership, Station credential. Стабильный набор кодов: 401 unauthenticated, 403 no capability/subscription write, 404 foreign tenant object, 409 stale/identity/idempotency conflict, 422 invalid decision, 410 expired preparation. Первый red assertion для authenticated reader:

```ts
expect(writeResponse.status).toBe(403);
expect(readResponse.status).toBe(200);
expect(foreignSessionResponse.status).toBe(404);
```

Ответы получить реальными supertest запросами к новым маршрутам, не mock controller.

- [ ] Реализовать controllers по existing guard patterns. Пример обязательных metadata для mutation:

```ts
@Post(":sessionId/previews")
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
@RequireSubscriptionWrite()
```

Импорты: `CABINET_CAPABILITY` из `@markiro/domain`, `RequirePermissions` из `../../authorization/access-policy`, `RequireSubscriptionWrite` из `../../subscriptions/subscription-access-policy`. На controllers поставить `@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)` и `@AllowSubscriptionReadOnly("read")`, как в `product-regulatory.controller.ts`. Привязать strict schemas через текущий ZodValidationPipe/DTO pattern, все server errors переводить в установленные стабильные коды.

- [ ] Добавить pg-boss queues `national-catalog-import-enumerate`, `national-catalog-import-apply`, `national-catalog-import-image`, `national-catalog-link-refresh`, cleanup/repair tick. Payload только tenant+session/operation/preview/link IDs; токен загружается непосредственно перед HTTP. DB operation+enqueuePending записываются вместе, sender после successful send помечает delivered; повтор send безопасен благодаря item receipt/lease. Repair раз в минуту поднимает pending без живой lease, bounded batch 100 oldest, с ротацией tenant. Cancellation прекращает будущие product writes, уже applied receipts сохраняет; expiry не удаляет применённую историю.
- [ ] Добавить env-флаги (по умолчанию false) `NATIONAL_CATALOG_OWN_IMPORT_ENABLED`, `NATIONAL_CATALOG_GTIN_IMPORT_ENABLED`, `NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED`, список `NATIONAL_CATALOG_IMAGE_ALLOWED_HOSTS`. Pairing environment/baseUrl — явная валидированная конфигурация, а не guessed host. Возможности вычисляются сервером из флагов+валидного подключения+разрешённых endpoints/hosts; потеря token показывает восстановимый blocked, не скрывает сохранённый результат. Выключенный flag прекращает новые provider tasks, чтение истории доступно.
- [ ] Обновить OpenAPI response/request types и env примеры без значений секретов. Проверить startup module, job replay, crashgap repair, actor потерял права до queued write, fair tenants, expiry/retry, флаги и auth matrix. Выполнить API tests/typecheck/lint/build; коммит `feat(api): wire authorized National Catalog import jobs and endpoints`.

### Task 12: Выбор, сравнение и результат в кабинете

**Files:** пять UI файлов импорта, App/catalog/i18n/test из карты.

**Interfaces:** API-клиент экспортирует `startImport(body: ImportStart)`, `getImportSession(sessionId: string)`, `getImportItems(sessionId: string, query: ImportItemsQuery)`, `saveImportSelection(sessionId: string, body: ImportSelection)`, `prepareImport(sessionId: string, body: ImportPrepare)`, `applyImport(sessionId: string, body: ImportApply)`, `getImportResult(sessionId: string, operationId: string)`, `retryImport(sessionId: string, operationId: string, previewIds: string[])`, `cancelImport(sessionId: string)`. Возвращаемые Promise соответствуют таблице HTTP. UI `ImportItemsQuery` создать из strict query schema contracts, не импортировать серверный types.ts в браузер. `ImportSelection` компонент переименовать при type collision на локальный alias типа, не менять wire name.

- [ ] В `national-catalog-import.test.tsx` использовать RTL+userEvent и настоящую route/query обвязку из `catalog-routing.test.tsx`. Замокать fetch с envelope `{ items, nextCursor }`; первый тест проходит две страницы и возвращается:

```ts
await user.click(screen.getByRole("checkbox", { name: /4006381333931/ }));
await user.click(screen.getByRole("button", { name: "Следующая страница" }));
await user.click(screen.getByRole("button", { name: "Предыдущая страница" }));
expect(screen.getByRole("checkbox", { name: /4006381333931/ })).toBeChecked();
expect(screen.getByText("Выбрано: 1 из 100")).toBeInTheDocument();
```

Объявить `user=userEvent.setup()`, импортировать `screen`/expect; fixture выбранного item сохраняется через PUT handler, GET отдаёт server state. Тест должен упасть на отсутствии маршрута/действия до реализации.

- [ ] Добавить protected `/catalog/import` route panel с query `sessionId`, кнопкой входа из каталога и возвратом к исходным фильтрам. `ImportPanel` владеет server state/query keys, `ImportSelection` вводом и таблицей, `ImportReview` per-item choices, `ImportResult` сохранённым прогрессом/повтором. API responses разбирать общими схемами; query key включает tenant+session/operation, сбрасывается при смене tenant. Новый requestId генерировать **один раз** на подтверждённый набор decisions и сохранять до получения receipt, повтор HTTP сохраняет его.
- [ ] Реализовать явные шаги «Выбор товаров» → «Сравнение» → «Результат». Copy для неполного списка и ошибок:

```json
{
  "selectionCount": "Выбрано: {{count}} из 100",
  "searchLoaded": "Поиск по загруженным товарам",
  "partialList": "Список загружен не полностью. Доступные товары можно добавить.",
  "linkOnly": "Добавить связь без изменения полей",
  "imageFailed": "Товар добавлен. Фото не загрузилось.",
  "retryImage": "Повторить загрузку фото",
  "archivedReadOnly": "Архивная карточка: доступен только просмотр"
}
```

Добавить эквиваленты en по текущей namespace структуре. «Выбрать все на странице» указывает число доступных строк и сохраняет предел 100. Draft blank name предлагает обязательный input; archived local предлагает перейти в штатную карточку. Existing fields defaults off, new applicable on; другая link требует явного replace подтверждения внутри review. Фото существующего товара по умолчанию «Сохранить текущее», нового — выбранное primary; варианты только ready preview или «Без фото».

- [ ] Сохранять decision state по previewId; новый preview отменяет старое решение. При наличии categoryOptions показывать выбор начальной категории и «Без привязки категории»; выбор вызывает новый prepare с categoryChoices, после чего показываются допустимые зависимые поля. При 409 показать конкретные устаревшие позиции и обновить сравнение, не повторять silent apply. При pending/partial/error доступна навигация, возврат открывает server receipt; polling только пока loading/running/refreshing и при фокусе. Итог разделяет applied product/failed photo/conflict. Отмена прекращает будущие позиции и показывает уже применённые.
- [ ] Проверить both entry modes, invalid GTIN per row, 101 selection, search partial, draft/manual name, sameGTIN link-only, replace confirmation, comparison toggles, photo choice/failure/retry, session expiry, refresh/reopen, reader без mutation actions, keyboard focus/labels. Выполнить новый UI тест и admin tests/typecheck/lint/build; коммит `feat(admin): add National Catalog selection and import review`.

### Task 13: Статус ЧЗ и действия со связью в каталоге

**Files:** LinkPanel/ChzStatus, catalogue/form/API/routes/styles/i18n/tests из карты.

**Interfaces:** `ChzStatus({ summary }: { summary: ChzSummary | undefined })`; LinkPanel читает `/products/:id/national-catalog/link`, отправляет refresh/remove, запускает existing comparison через новую сессию GTIN с явно выбранным текущим cardId. `/catalog/:productId/chz` защищён READ, кнопки изменения WRITE. Форма редактирования использует явный atomic detach+GTIN update из задачи 8.

- [ ] В новом status-тесте проверить три различных состояния до реализации:

```ts
it("does not label a missing legacy response field as an unlinked product", () => {
  render(<ChzStatus summary={undefined} />);
  expect(screen.getByText("Сведения недоступны")).toBeInTheDocument();
  expect(screen.queryByText("Не связан")).not.toBeInTheDocument();
});
```

- [ ] Выполнить красным. Реализовать состояние по наличию данных, не truthy status:

```ts
if (summary === undefined) return <span>{t("catalog.chz.unavailable")}</span>;
if (summary.linkId === null) return <span>{t("catalog.chz.unlinked")}</span>;
if (summary.lastSuccessAt === null) return <span>{t("catalog.chz.unverified")}</span>;
```

Остальной вывод использует все statusKeys, текст+цвет, raw unknown в detail. «Статус Markiro» сохраняет исходную draft/active семантику. Для нескольких статусов показать компактный набор и число дополнительных с доступной расшифровкой; filter совпадает с любым. LastSuccess показывается в detail/tooltip, ошибка проверки рядом сохраняет последний статус. Различия badge только hasChanges.

- [ ] Добавить отдельную колонку «Честный знак», фильтр, переход в LinkPanel; сохранить текущие действия строки и автоматический layout таблицы. Не делать product row кликабельной целиком, если это конфликтует с checkbox/actions. Панель показывает environment/card identity, подтверждение связи, время успеха/ошибки, «Обновить», «Сравнить», «Удалить связь». Удаление поясняет сохранение товара и принятых значений; expected revision защищает от stale operation.
- [ ] GTIN input при текущей связи: изменение требует явного checkbox «Удалить связь с ЧЗ при сохранении нового GTIN», отправляет expectedLinkRevision+detach вместе с update. Без checkbox серверный 409 отображается рядом с полем. Закрытие формы не меняет связь. Смена GTIN не переиспользует старый snapshot/status для новой идентичности.
- [ ] Проверить unknown/unlinked/unverified, published+detail, stale error, multi filter, no provider GET при загрузке каталога, read-only link panel, refresh progress, remove stale409, atomic GTIN detach cancel/save, catalogue query invalidation. Выполнить status/import/catalog-routing/catalog-images и admin gates; коммит `feat(admin): show CHZ card status and confirmed link actions in catalogue`.

### Task 14: Сквозная проверка, документация и включение

**Files:** browser harness/config/spec, runbook, архитектура/CI из карты. Не менять Rust или offline media механизм при отсутствии подтверждённой регрессии.

**Interfaces:** новый browser harness импортирует существующий `cabinet-harness.tsx`, устанавливает детерминированные auth/catalog/NC fixtures и поддерживает светлую/тёмную тему. Playwright config использует отдельный admin Vite port 43183 и имеющийся test/browser Vite config; не зависит от production API. Endpoint fixtures соответствуют общим схемам. Добавить script `test:national-catalog` в отдельный tools package.

- [ ] Добавить первый browser тест переполнения с реальными текстами/фото/status/actions:

```ts
for (const width of [390, 768, 1280, 1600]) {
  test(`catalogue CHZ status remains usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/test/browser/national-catalog-harness.html");
    await expect(
      page.getByRole("columnheader", { name: "Честный знак", exact: true }),
    ).toBeVisible();
    const overflow = await page
      .getByRole("table")
      .locator("td")
      .evaluateAll(
        (cells) => cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length,
      );
    expect(overflow).toBe(0);
  });
}
```

Создать `apps/admin/test/browser/national-catalog-harness.html`, подключающий новый `.tsx`. В Playwright config задать `use.baseURL="http://127.0.0.1:43183"`, Vite запускать с root `../../apps/admin` и `--config ../../apps/admin/test/browser/vite.config.ts --host 127.0.0.1 --port 43183 --strictPort`. Проверять допустимый horizontal scroll контейнера отдельно; намеренно ellipsized name cells исключать по явному существующему классу, но не исключать status/actions. На ширинах с карточным представлением проверять соответствующую структуру вместо несуществующей таблицы. Тест адаптируется к **реальному** текущему responsive поведению.

- [ ] Запустить новый Playwright файл до UI, убедиться в отказе отсутствующего harness/колонки. Завершить harness и test flows: own-list partial→selection→existing link-only→draft create→photo failure/retry; reopen result; status refresh error retains published; filter; keyboard focus; ru/en; обе темы. Сохранить screenshots в output test artifacts, показать пользователю минимум catalogue+review после реализации.
- [ ] Выполнить браузерный gate:

```bash
pnpm --dir tools/production-browser --ignore-workspace exec playwright test --config national-catalog.playwright.config.ts
```

Подключить команду в существующий подходящий CI job с установкой Chromium и публикацией trace/screenshots при ошибке; не расширять production browser smoke на внешнюю ЧЗ. Выполнить existing kiosk product-images и station product-image-cache тесты, API device access. Проверку офлайн restart/reconnect реального Station/Kiosk проводить отдельно; host-тесты не подтверждают Windows/железо.

- [ ] После локальной реализации выполнить полные затронутые package gates domain/contracts/db/api/admin и общий gate при настроенной тестовой инфраструктуре:

```bash
pnpm turbo lint typecheck test build --concurrency=1 --force
pnpm format:check
git diff --check
```

Перед API tests/build пересобрать db/contracts/domain. Отдельно сообщить DB skips и недоступные сервисы; зелёный skipped suite не закрывает migration/e2e gate. Из-за нового env/флагов проверить production configuration contract, не копировать development env в production. После изменения кода выполнить `graphify update .`, если локальный graph существует; graph ignored, не включать его в commit.

- [ ] Обновить архитектуру и runbook точной моделью link/snapshot/reviewed baseline, routes, TTL, cancellation/retry, job repair, audit, enabled capabilities и безопасным rollback: выключение новых provider jobs, сохранение истории/receipts, без отката additive migration с удалением данных. В runbook включить checklist живой проверки из спецификации:

| Внешняя проверка   | Условие включения                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Собственный список | Совпадение с кабинетом по старым/новым draft/published/archive, multi-page; подтверждённый допустимый нижний предел даты/timezone; отсутствие тихого усечения; 413/split/catch-up поведение |
| GTIN и cardId      | Собственный и предоставленный доступ, не найден/нет доступа отдельно; несколько GTIN на карточке; не происходит public fallback; реальные статусы                                           |
| Фото               | Реальные разрешённые hosts и redirects, доступ без передачи bearer CDN, preview=stored checksum, лимиты/ошибки; whitelist включать только по этой проверке                                  |
| Авторизация/квота  | Просроченный token, mismatch environment, 429/Retry-After, квота на несколько workers, восстановление подключения                                                                           |
| Восстановление     | Перезапуск worker на enumeration/apply/photo и receipt replay без дублей; пользовательский visible partial/retry                                                                            |

Live проверка выполняется с явно предоставленным тестовым tenant/token через существующий диагностический путь, без вывода секрета. Пока доступов нет, флаги остаются false; результаты назвать «документация и fixture», не «проверено в ЧЗ». Согласованный план не разрешает production deploy, внешнюю запись или расход средств.

- [ ] Финальный review diff против спецификации, scoped commits и отчёт: поведение, области файлов, автоматические результаты, browser screenshots, выполненные/невыполненные внешние проверки. Коммит `test: verify National Catalog import flow and document enablement`.

## Проверка полноты плана

| Требование спецификации                                        | Задачи             |
| -------------------------------------------------------------- | ------------------ |
| §1–3 scope, reuse, отсутствие тихих изменений                  | 1, 7–8, 10, 12–13  |
| §4 реальные endpoints, интервалы, курсоры, полнота, лимиты     | 3, 5–6, 11, 14     |
| §5 два входа, архивы, совпадения, имя, фото, ручной выбор      | 1, 6–9, 12         |
| §6 link identity/history, tenant/environment, no backfill      | 2, 5, 8, 10–11, 13 |
| §7 mapping/provenance, initial category transaction, conflicts | 7–8                |
| §8 фото, SSRF, normalized preview, retry, offline descriptor   | 4, 9, 12, 14       |
| §9 отдельный статус, несколько состояний, reviewed differences | 10, 13             |
| §10 jobs/quota/auth/capabilities                               | 5–6, 10–11         |
| §11 crash recovery/idempotency/cancellation/audit              | 2, 6, 8–9, 11      |
| §12 tests/tenant denial/browser/DB/consumer gates              | 1–14               |
| §13 живые проверки и ограниченное включение                    | 3, 5, 11, 14       |

Документ фиксирует план, а не подтверждает реализацию. Checkbox отмечается только после выполнения шага с проверяемым результатом. Бизнес-сценарий и спецификация уже одобрены; способ выполнения выбирается отдельно при передаче плана.
