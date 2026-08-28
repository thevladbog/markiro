# Inventory Documents INN Error Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть issue #332 — пустой/битый ИНН организации больше не валит генерацию документов инвентаризации безликим `GENERATION_FAILED`: отдельный код ошибки до UI, логирование причины в воркере, retry подхватывает исправленный ИНН, превентивный 409 при создании рана.

**Architecture:** Точечные правки в `apps/api/src/modules/inventories/` (runner + documents service + реестр форматов), проброс кода в админку (i18n + retryable-set + обработка 409 создания). Domain-генераторы не меняются — они уже бросают `InventoryDocumentGenerationError("INVALID_ORGANIZATION_INN")`.

**Tech Stack:** NestJS + drizzle (api), vitest e2e (нужна БД — см. Контекст), React/i18next (admin).

## Global Constraints

- Тексты UI — ru/en в `apps/admin/src/i18n/{ru,en}.json`, паритет ключей обязателен.
- Прогоны перед сдачей: `pnpm --filter @markiro/admin test|lint|typecheck`, `pnpm --filter @markiro/api typecheck`, целевые api-тесты (см. Контекст), `pnpm format:check` (prettier только на затронутые файлы).
- Тестовый фильтр по файлу: `pnpm exec vitest run test/<file>` из директории пакета.
- Существующие контракты не ломать: `INVENTORY_DOCUMENT_ARTIFACTS_NOT_READY`, поведение zero-byte XML из PR #329.

**Контекст (окружение для api e2e):** порт 5432 слушает контейнер `sscc-00-format-postgres-1` (креды `markiro:markiro`). Одноразовая БД:
`docker exec sscc-00-format-postgres-1 psql -U markiro -d postgres -c "CREATE DATABASE markiro_inn_fix;"`, затем `cd packages/db && DATABASE_URL="postgres://markiro:markiro@localhost:5432/markiro_inn_fix" pnpm exec drizzle-kit migrate`. Запуск e2e: `cd apps/api && set -a && . ../../.env.example && . /Users/thevladbog/PRSOME/q/.env && set +a && DATABASE_URL="postgres://markiro:markiro@localhost:5432/markiro_inn_fix" pnpm exec vitest run test/<file>`. Перед этим `pnpm turbo build --filter='./packages/*'`. В конце работы БД можно не удалять — диспетчер удалит.

**Ключевые факты кода (проверены):**

- Safe-коды: `INVENTORY_DOCUMENT_SAFE_ERROR_CODES` в `apps/api/src/modules/inventories/inventory-document-runner.service.ts:188-198`; маппинг исключений — `safeDocumentErrorCode(...)` там же (~строка 500): ветка `InventoryDocumentGenerationError` сейчас пропускает только `VERIFIED_PRODUCTION_DATE_MISSING`, остальное → `GENERATION_FAILED`.
- Catch воркера: `execute(...)` ~строки 284-305, логгера в классе нет, `throw error` в конце глотается pg-boss.
- Снапшоты организации пишутся при создании рана: `inventory-documents.service.ts:~100-115` (`organizationNameSnapshot: organization.name`, `organizationInnSnapshot: organization.inn` — организация читается из `org_profiles` join, см. начало `create`).
- Retry: `inventory-documents.service.ts:162-186` (`retry` → `restoreFailed(existing, actorUserId, RETRYABLE_ERRORS)`); серверный набор `RETRYABLE_ERRORS` объявлен в этом же файле (grep).
- Реестр форматов: `productionInventoryDocumentGeneratorRegistry` в `inventory-document-runner.service.ts` (~294-320) — дескрипторы трёх XML-форматов там.
- Admin: сообщение ошибки рана — ключ `pages.inventory.documents.…GENERATION_FAILED` (`ru.json:1247`, найти точный путь блока); retryable-набор UI — `RETRYABLE_ERRORS` в `apps/admin/src/pages/inventory/InventoryDocuments.tsx:23`; схема `errorCode` — свободная строка (enum менять не надо).

---

### Task 1: Safe-код INVALID_ORGANIZATION_INN + лог причины в воркере

**Files:**

- Modify: `apps/api/src/modules/inventories/inventory-document-runner.service.ts`
- Test: `apps/api/test/inventory-document-runner.test.ts`

**Interfaces:**

- Produces: `"INVALID_ORGANIZATION_INN"` в `INVENTORY_DOCUMENT_SAFE_ERROR_CODES`; run со статусом `failed` и `errorCode: "INVALID_ORGANIZATION_INN"` при пустом/битом ИНН. Задачи 3–5 полагаются на этот код дословно.

- [ ] **Step 1: Падающий тест маппинга**

В `inventory-document-runner.test.ts` рядом с существующими кейсами реального реестра добавить кейс по образцу «закрытая инвентаризация без сканов» из PR #329, но с пустым `organizationInnSnapshot` (в существующей обвязке найти, где сидируется run-строка / организация, и передать `inn: null`). Выбранные форматы — только `inventory_xml_gismt_aggregation` v2. Ожидание:

```ts
expect(run.status).toBe("failed");
expect(run.errorCode).toBe("INVALID_ORGANIZATION_INN");
```

- [ ] **Step 2: Убедиться, что падает** (сейчас errorCode будет `GENERATION_FAILED`)

Run: `cd apps/api && pnpm exec vitest run test/inventory-document-runner.test.ts`

- [ ] **Step 3: Реализация**

В `INVENTORY_DOCUMENT_SAFE_ERROR_CODES` добавить `"INVALID_ORGANIZATION_INN"` (рядом с `VERIFIED_PRODUCTION_DATE_MISSING`). В `safeDocumentErrorCode` ветку `InventoryDocumentGenerationError` заменить на:

```ts
if (error instanceof InventoryDocumentGenerationError) {
  switch (error.code) {
    case "VERIFIED_PRODUCTION_DATE_MISSING":
    case "INVALID_ORGANIZATION_INN":
      return error.code;
    default:
      return "GENERATION_FAILED";
  }
}
```

Логирование: добавить в класс `private readonly logger = new Logger(InventoryDocumentRunnerService.name);` (импорт `Logger` из `@nestjs/common`), и в catch блока `execute` — до ветвления — одну строку:

```ts
this.logger.warn(
  `inventory document run ${claimed.id} generation failed`,
  error instanceof Error ? (error.stack ?? error.message) : String(error),
);
```

(точное имя поля id взять из типа `claimed` в этом методе — проверить).

- [ ] **Step 4: Зелёный прогон + commit**

Run: тот же vitest файл. Commit: `feat(api): surface INVALID_ORGANIZATION_INN from document runs and log worker failures`.

### Task 2: Дескрипторный флаг requiresOrganizationInn + превентивный 409 на создании рана

**Files:**

- Modify: `apps/api/src/modules/inventories/inventory-document-runner.service.ts` (дескрипторы трёх XML-форматов)
- Modify: `apps/api/src/modules/inventories/inventory-documents.service.ts` (`create`)
- Test: `apps/api/test/inventory-documents.e2e.test.ts`

**Interfaces:**

- Consumes: организация уже читается в `create` (там же, где пишутся снапшоты).
- Produces: `requiresOrganizationInn?: true` на дескрипторе формата; `ConflictException({ code: "ORGANIZATION_INN_REQUIRED" })` (HTTP 409) из `POST /inventories/:id/document-runs`, если среди выбранных форматов есть требующий ИНН, а `organization.inn` пуст (null/пустая строка). Задача 5 показывает этот код в UI.

- [ ] **Step 1: Падающий e2e**

В `inventory-documents.e2e.test.ts` (обвязка `seedInventory` уже есть; ИНН организации в сиде — найти и обнулить для нового кейса, либо создать организацию без inn) добавить кейс: создание рана с `inventory_xml_gismt_aggregation` v2 → `expect(409)` и body `{ code: "ORGANIZATION_INN_REQUIRED" }`; создание рана только с табличными форматами при пустом ИНН → по-прежнему 201.

- [ ] **Step 2: Красный прогон** (сейчас 201)

- [ ] **Step 3: Реализация**

В дескрипторы `inventory_xml_gismt_aggregation` (v1 и v2) и `inventory_xml_gismt_disaggregation` добавить `requiresOrganizationInn: true` (расширить тип дескриптора опциональным полем). В `create` после чтения организации и резолва форматов:

```ts
const needsInn = resolvedGenerators.some((g) => g.descriptor.requiresOrganizationInn === true);
if (needsInn && !organization.inn?.trim()) {
  throw new ConflictException({ code: "ORGANIZATION_INN_REQUIRED" });
}
```

(имена локальных переменных подставить фактические из `create`).

- [ ] **Step 4: Зелёный прогон + commit**

Run (env из Контекста): `pnpm exec vitest run test/inventory-documents.e2e.test.ts`. Commit: `feat(api): reject document runs needing an org INN before enqueueing`.

### Task 3: Retry обновляет организационные снапшоты и разрешает INVALID_ORGANIZATION_INN

**Files:**

- Modify: `apps/api/src/modules/inventories/inventory-documents.service.ts`
- Test: `apps/api/test/inventory-documents.e2e.test.ts`

**Interfaces:**

- Consumes: safe-код из задачи 1.
- Produces: `POST /inventory-document-runs/:runId/retry` для рана с `errorCode: "INVALID_ORGANIZATION_INN"` перечитывает текущие `organization.name`/`organization.inn`, обновляет `organizationNameSnapshot`/`organizationInnSnapshot` на строке рана и ставит в очередь.

- [ ] **Step 1: Падающий e2e**

Сценарий: организация без ИНН → ран с XML-форматом создать НЕ через API (409 из задачи 2 не пустит), а через прямую вставку/старую траекторию — проще: создать ран при пустом ИНН с табличным+XML до реализации задачи 2? Порядок задач фиксирован, поэтому: вставить run-строку напрямую через `db.insert(schema.inventoryDocumentRuns)` по образцу существующих хелперов файла со снапшотом `organizationInnSnapshot: null` и статусом `failed`, `errorCode: "INVALID_ORGANIZATION_INN"`; затем проставить организации ИНН (`db.update` на `org_profiles`), вызвать retry endpoint → `expect(200)`; после `runner.run(...)` — статус `ready`, а перечитанная строка рана содержит `organizationInnSnapshot` = новому ИНН.

- [ ] **Step 2: Красный прогон** (retry сейчас 409 NOT_RETRYABLE либо снапшот не обновится)

- [ ] **Step 3: Реализация**

В серверный `RETRYABLE_ERRORS` добавить `"INVALID_ORGANIZATION_INN"`. В `retry` (или `restoreFailed`) перед постановкой в очередь перечитать организацию тем же способом, что `create`, и обновить у рана `organizationNameSnapshot`/`organizationInnSnapshot` текущими значениями (для ВСЕХ retry, не только INN-ветки — реквизиты издателя должны быть актуальны на момент формирования). Если ИНН всё ещё пуст, а среди форматов рана есть `requiresOrganizationInn` — вернуть 409 `ORGANIZATION_INN_REQUIRED` (переиспользовать проверку из задачи 2, вынести её в приватный хелпер).

- [ ] **Step 4: Зелёный прогон + commit**

Commit: `feat(api): document run retry refreshes org snapshots and honours fixed INN`.

### Task 4: Admin — сообщения и retryable для нового кода

**Files:**

- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/src/pages/inventory/InventoryDocuments.tsx`
- Test: `apps/admin/test/inventory-documents.test.tsx`

**Interfaces:**

- Consumes: коды `INVALID_ORGANIZATION_INN` (ошибка рана) и `ORGANIZATION_INN_REQUIRED` (409 создания/retry).

- [ ] **Step 1: Падающий тест**

В `inventory-documents.test.tsx` по образцу существующего кейса с `GENERATION_FAILED`: ран с `errorCode: "INVALID_ORGANIZATION_INN"` → виден текст про ИНН и кнопка «Повторить формирование» присутствует. Второй кейс: мутация создания рана, отклонённая 409 `{code:"ORGANIZATION_INN_REQUIRED"}` → показано сообщение про ИНН (найти, как в этом файле мокается ошибка создания — по образцу соседних error-кейсов; если обработка ошибок создания в компоненте отсутствует вовсе — добавить её выводом `Alert` под кнопкой формирования).

- [ ] **Step 2: Красный прогон**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-documents.test.tsx`

- [ ] **Step 3: Реализация**

i18n (рядом с `GENERATION_FAILED`, точный путь блока взять из ru.json:1247):

- ru: `"INVALID_ORGANIZATION_INN": "Не заполнен или некорректен ИНН организации. Укажите ИНН в разделе «Настройки» и повторите формирование."`, `"ORGANIZATION_INN_REQUIRED": "Для XML-документов ГИС МТ нужен ИНН организации. Заполните его в разделе «Настройки»."`
- en: `"INVALID_ORGANIZATION_INN": "The organization INN is missing or invalid. Fill it in Settings and retry the generation."`, `"ORGANIZATION_INN_REQUIRED": "GIS MT XML documents require the organization INN. Fill it in Settings."`

`InventoryDocuments.tsx`: добавить `"INVALID_ORGANIZATION_INN"` в `RETRYABLE_ERRORS`; обработать 409-код создания (маппинг код→ключ по образцу существующего вывода ошибок).

- [ ] **Step 4: Зелёный прогон + commit**

Run: тот же файл, затем полный `pnpm --filter @markiro/admin test`. Commit: `feat(admin): actionable INN errors for inventory document runs`.

### Task 5: Сквозной прогон и контракты

**Files:**

- Test: `apps/api/test/inventory-documents.e2e.test.ts`, `apps/api/test/inventory-document-runner.test.ts` (полные прогоны)
- Modify: только если найдены осыпавшиеся контракты (openapi-тесты `inventories-openapi`, если они пиняют коды ошибок — проверить grep'ом `ORGANIZATION_INN_REQUIRED|INVALID_ORGANIZATION_INN|SAFE_ERROR`).

- [ ] **Step 1:** Полные прогоны обоих api-файлов + `pnpm --filter @markiro/api typecheck` + grep по openapi-тестам на пины safe-кодов (обновить, если пиняют список).
- [ ] **Step 2:** `pnpm --filter @markiro/admin test|lint|typecheck`, `pnpm format:check`.
- [ ] **Step 3:** Commit при любых правках: `test(api): cover INN error contracts end to end`.
