# Исторические поля перепечатки Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перепечатывать продукцию закрытой смены с достоверной датой производства и сроком годности.

**Architecture:** Lookup использует неизменный снимок фактов конкретного принятия. Локальные факты сохраняются атомарно и синхронизируются отдельно от неизменного V1 журнала печати; старый источник восстанавливается только при доказанном происхождении.

**Tech Stack:** TypeScript, Zod, Drizzle/Postgres, pooled SQLite, React/Vite, Vitest/Playwright; существующий Tauri transport без новых зависимостей.

**Spec:** [Утверждённый дизайн](../specs/2026-10-11-station-printing-follow-up-design.md). Статус: реализован и проверен; физическая приёмка и deployment остаются отдельным этапом.

## Global Constraints

Действуют все общие правила спецификации: Node 24+, Corepack; гражданские даты; неизменность исторических снимков и байтов; tenant/device/operator isolation; offline-first; RAW и Windows; capability-gated совместимость V1; без сырого КМ в аудите. Работать на новой task branch от проверенного main, сохраняя чужие изменения. Выполнение здесь по этапам, с проверками после каждого.

## Review Focus

- Код принят повторно в другой смене: выбрать правильное вхождение, не первую строку по hash.
- Каталог изменён после смены: исторические даты и название сохраняются.
- Legacy без expiry: точная ошибка и совместимый шаблон, без выдуманной даты.
- Сбой между принятием и sync: снимок не теряется и повтор не дублирует запись.
- Полный КМ с GS и криптохвостом: печатается исходный код.

### Task 1: Источник фактов и долговечное сохранение

**Files:**

- Create: `packages/domain/src/warehouse-reprint/label-facts.ts`, `packages/domain/test/warehouse-label-facts.test.ts`.
- Create: `packages/db/src/schema/label-facts.ts`, `packages/db/test/warehouse-label-facts-migration.test.ts`; новая additive Postgres migration через генератор и её metadata.
- Modify: `packages/db/src/sqlite/schema.ts`, `packages/db/src/sqlite/migrations.ts`, `packages/db/test/sqlite-schema.test.ts`; зарегистрировать и экспортировать новый schema module в существующем DB barrel.
- Create: `apps/station/src/lib/warehouse-reprint/label-facts.ts`, `apps/station/test/warehouse-label-facts.test.ts`.
- Modify: `apps/station/src/lib/product-labels/acceptance.ts`, `apps/station/src/lib/product-labels/store.ts`, `apps/station/src/lib/sync.ts`; включить сохранение также в путь обычного принятия без печати, найденный по вызовам записи accepted scan. Не переносить его в post-commit effect.
- Create: `apps/api/src/modules/station-warehouse-reprint/label-facts.service.ts`, `apps/api/test/warehouse-label-facts.e2e.test.ts`.
- Modify: `apps/api/src/modules/station-warehouse-reprint/controller.ts`, `station-warehouse-reprint.module.ts`; route inventories, OpenAPI и access tests.

**Interfaces (новые):**

- `UnitLabelFactsV1`: `version: 1`, `shiftId`, `codeHash`, `acceptedAt`, `sourceRevision`, печатные поля без сырого КМ, `dateProvenance`, `digest`. Идентичность включает occurrence принятия; tenant/device выводит сервер из авторизации.
- `POST /station/warehouse-reprint/label-facts`: `{ protocol: "warehouse-label-facts-v1", operatorId, entries }`; per-record accepted/retryable/conflict result. Capability `warehouse-label-facts-v1`; старый сервер не получает такой batch.
- `readUnitLabelFacts(exec, owner, occurrence): Promise<UnitLabelFactsV1 | null>`; `syncUnitLabelFacts(...)` сохраняет retry identity.

- [ ] Добавить failing contract/migration tests: поля/даты/digest; 1 день, високосный год, часовой пояс; пустая и обновляемая SQLite; уникальность tenant+occurrence; конфликтующий повтор не перезаписывает данные.
- [ ] Запустить focused tests и сохранить конкретную причину FAIL; ошибка инфраструктуры не считается RED.
- [ ] Реализовать валидируемые факты, используя существующие правила эффективной даты и `shelfLifeExpiryDate`. Сохранить в том же атомарном принятии, включая aggregation без product-label job. `productionDate: null` не превращать безусловно в дату UTC-скана.
- [ ] Добавить per-record retry-safe upload. Сервер проверяет связь с реально принятым кодом/сменой, правами владельца и содержимым; факты, пришедшие раньше scan, не привязываются к несуществующему событию. Лимиты batch/JSON взять из существующих upload boundaries.
- [ ] Добавить failing Station/API tests: restart до sync, повтор batch, scan ещё не поступил, отозванный grant, смена владельца, чужой tenant, кабинет и handheld не допускаются к новой Station-only операции.
- [ ] Добиться PASS; построить domain/DB перед consumers. Проверить exact audit без КМ и изображения. Commit только путей задачи после проверки staged diff.

### Task 2: Lookup, legacy recovery и понятная ошибка

**Files:**

- Modify: `apps/api/src/modules/station-warehouse-reprint/lookup.service.ts`, `apps/api/test/station-warehouse-reprint-lookup.e2e.test.ts`.
- Modify: `apps/station/src/lib/warehouse-reprint/sources.ts`, `prepare.ts`, `apps/station/src/i18n/ru.json`, `en.json`.
- Test: `apps/station/test/warehouse-reprint-sources.test.ts`, `warehouse-reprint-prepare.test.ts`, `warehouse-reprint-screen.test.tsx`.

**Interfaces:** consumes `UnitLabelFactsV1`; produces existing `WarehouseReprintSource` with accurate `fields` and `unavailableFields`. Не добавлять новые варианты в V1 union.

- [ ] Написать RED сценарий: закрытая смена, сохранённые date/expiry, шаблон требует оба поля → lookup + prepare успешны. Нынешнее unconditional `expiry` assertion заменить двумя тестами: достоверный источник и legacy без источника.
- [ ] Добавить RED: изменение каталога не меняет сохранённые факты; старый локальный accepted job восстанавливает поля после reconnect; неизвестный expiry не вычисляется из текущего продукта. Исторический prepared job сохраняет bytes/digest.
- [ ] Извлечь локальные принятые `job.fields` с проверяемой связью с occurrence и мигрировать через Task 1. Не считать существующую серверную projection источником полей: их там нет. Иные legacy источники принимать только при доказанной неизменности и связи.
- [ ] В lookup предпочесть подтверждённые факты; удалить `expiry` из недоступных полей только при достоверном значении. Сохранить tenant-scoped поиск исходного КМ и проверки печатности источника.
- [ ] Для реально недостающих полей назвать поле в i18n и разрешить выбор совместимого шаблона. Не ослаблять `labelTemplateUsesField` guard ради зелёного теста.
- [ ] Запустить focused tests, затем package gates domain/DB/API/Station, route/OpenAPI contracts; зафиксировать PASS и skips отдельно. Commit.

**Команды:**

```bash
corepack pnpm --filter @markiro/domain exec vitest run test/warehouse-label-facts.test.ts
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/api exec vitest run test/warehouse-label-facts.e2e.test.ts test/station-warehouse-reprint-lookup.e2e.test.ts
corepack pnpm turbo run build --filter='@markiro/station^...'
corepack pnpm --filter @markiro/station exec vitest run test/warehouse-label-facts.test.ts test/warehouse-reprint-sources.test.ts test/warehouse-reprint-prepare.test.ts
```

API e2e запускать с изолированной test DB и объявленным test env; отсутствие DB отражать как непроверенный gate.

**Критерий этапа:** новая смена с датой и сохранённым сроком перепечатывается после закрытия/перезапуска; достоверные старые локальные задания восстанавливаются; неизвестные legacy сроки явно остаются неизвестными. Случай пользователя требует проверки наличия оригинального локального источника на его Station.

## Результат реализации

Этап реализован в `codex/station-printing-follow-up`. [Проверки и ограничения](2026-10-11-printing-follow-up-verification.md) фиксируют фактические результаты, исправления итогового ревью и требования к следующей beta. Исторические задания не переписываются; production deployment и физическая печать здесь не выполнялись.
