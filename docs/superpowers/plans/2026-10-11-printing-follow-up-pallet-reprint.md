# Перепечатка производственной палеты по скану Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Находить закрытую производственную палету по SSCC, коробу или продукции и печатать после явного подтверждения.

**Architecture:** Отдельный Station-only протокол и режим UI используют неизменный палетный источник и существующие журналы доставки. Новая попытка перепечатки не изменяет исходную неопределённую производственную попытку.

**Tech Stack:** TypeScript, Zod, Drizzle/Postgres, pooled SQLite, React/Vite, Vitest/Playwright; существующий Tauri transport без новых зависимостей.

**Spec:** [Утверждённый дизайн](../specs/2026-10-11-station-printing-follow-up-design.md). Статус: реализован и проверен; физическая приёмка и deployment остаются отдельным этапом.

## Global Constraints

Действуют все общие правила спецификации: Node 24+, Corepack; гражданские даты; неизменность исторических снимков и байтов; tenant/device/operator isolation; offline-first; RAW и Windows; capability-gated совместимость V1; без сырого КМ в аудите. Работать на новой task branch от проверенного main, сохраняя чужие изменения. Выполнение здесь по этапам, с проверками после каждого.

## Review Focus

- Код перемещён/повторно принят: поиск по актуальному активному составу, без произвольного выбора.
- Разобранная/открытая/пустая палета: печать запрещена, stale cache не обходит отказ.
- Двойной скан/двойное подтверждение: одна отправка.
- Restart/owner change/delivery unknown: восстановление без автоматической печати.
- Другая Station или legacy без snapshot: честная доступность источника и ресурсов.

### Task 1: Неизменный палетный источник и поиск

**Files:**

- Create: `packages/domain/src/warehouse-reprint/pallet-contracts.ts`, `packages/domain/test/warehouse-pallet-reprint-contracts.test.ts`.
- Create: `packages/db/src/schema/pallet-label-sources.ts`, `packages/db/test/pallet-label-sources-migration.test.ts`; additive Postgres migration и registration в DB barrel.
- Modify: `packages/db/src/sqlite/schema.ts`, `migrations.ts`; test existing `sqlite-schema.test.ts`.
- Create: `apps/station/src/lib/warehouse-reprint/pallet-sources.ts`, `apps/station/test/warehouse-pallet-sources.test.ts`.
- Modify: `apps/station/src/lib/close-pallet.ts`, `pallet-sheet-print-snapshot.ts`, `pallet-sheet-printing.ts`, `sync.ts`; thermal producer in `apps/station/src/pages/WorkScreen.tsx` сохраняет такой же источник до первой отправки.
- Create: `apps/api/src/modules/station-warehouse-reprint/pallet-lookup.service.ts`, `pallet-sources.service.ts`, `apps/api/test/warehouse-pallet-reprint-lookup.e2e.test.ts`.
- Modify: existing warehouse controller/module/access and OpenAPI/route inventory tests.

**Interfaces (новые, не расширение V1):**

- Capability/protocol `warehouse-pallet-reprint-v1`.
- `PalletLabelSourceV1`: sourceId/revision/digest, закрытая production pallet SSCC, counts, frozen facts, discriminated thermal/A4 template snapshot, frozen branding resource digests, rendererVersion, исходные print attempt refs если имеются.
- `POST /station/warehouse-reprint/pallet-sources` retry-safe source upload; `POST /station/warehouse-reprint/pallet-lookup` `{ protocol, operatorId, raw }` → found(source)/not_found/unavailable/network_required. Существующая V1 lookup не меняется.
- `resolveWarehousePalletSource(...)` использует local source + membership, затем сервер согласно текущим offline/grant правилам.

- [ ] RED contract/migration tests: обе print формы, digest и принадлежность SSCC; прежний V1 продолжает отклонять pallet; unsupported renderer/corrupt resource не печатаются. Не логировать сырой scan.
- [ ] RED: закрытие палеты атомарно сохраняет источник и outbox; restart не теряет source. Для А4 привязать существующий снимок с printer geometry; не подменять оригинальный branding актуальным.
- [ ] Реализовать durable source: image rendering остаётся client-side. Метаданные и frozen logo resources sync с авторизованным доступом/size limits. Source arriving before pallet ingestion ожидает проверяемой связи, конфликтующий digest не перезаписывает сохранённое.
- [ ] RED API/local cases: SSCC палеты, GS1 SSCC короба, полный КМ с GS; tenant denial, unit occurrence/membership, closed/nonempty/production constraints; разобранная палета и запрет обхода отказа через cache; ambiguity не выбирает первую строку.
- [ ] Реализовать tenant-scoped resolution и актуальную membership. Для старых локальных A4 — импорт доказанного render snapshot; отсутствующие исторические источники возвращают precise unavailable, а не текущие catalog facts.
- [ ] PASS focused tests + DB/domain gates + API route/OpenAPI coverage. В тестах явно запретить новый канал handheld/cabinet/kiosk; прежние V1 fixtures не меняются. Commit.

### Task 2: Отдельный режим, подтверждение и доставка

**Files:**

- Modify: `apps/station/src/pages/WarehouseReprint.tsx`, `apps/station/src/lib/use-warehouse-reprint.ts`, `warehouse-reprint/work.ts`, `types.ts`, `sync.ts`, `apps/station/src/i18n/ru.json`, `en.json`.
- Create: `apps/station/src/ui/warehouse-reprint/PalletConfirmation.tsx`, `apps/station/src/lib/warehouse-reprint/pallet-printing.ts`, `apps/station/test/warehouse-pallet-reprint-printing.test.ts`.
- Test: `apps/station/test/warehouse-reprint-screen.test.tsx`, `use-warehouse-reprint.test.tsx`, `pallet-sheet-printing.test.ts`, `warehouse-reprint-session-close.test.ts`.
- Create: `apps/api/test/warehouse-pallet-reprint-events.e2e.test.ts`; modify existing events service/controller/module for separate versioned route `POST /station/warehouse-reprint/pallet-events`.

**Interfaces:** UI mode `codes_boxes | pallet`; scan in pallet mode populates confirmation only. `confirmPalletReprint(sourceRevision)` revalidates selected revision/owner/printer before durable prepare. New event protocol carries sourceId/revision, attempt identity, actor, reason, format and delivery result, без КМ/image. Existing print delivery adapter consumes frozen source; journal remains authoritative.

- [ ] RED: обычный режим не печатает палету; pallet scan показывает SSCC/product/dates/counts/template/printer; отмена не создаёт attempt и не вызывает transport.
- [ ] RED: двойной confirm/scan, устаревший async lookup после смены режима, изменение выбранного источника, принтера или owner → нет неверной отправки. Заблокировать смену режима при неразрешённой попытке.
- [ ] Реализовать UI и отдельный work orchestration без переноса всего большого экрана. RAW/thermal используют текущие routing/rendering, А4 — текущие Windows preflight/dispatch и `printer_deliveries` с самостоятельным job/attempt ID и source link.
- [ ] RED: driver refusal before send, неизвестная доставка, restart, очищенный raster, geometry change, owner lease, event retry/audit. Оригинальная неизвестная производственная попытка сохраняет статус при новой перепечатке; её разрешает только явная recovery action.
- [ ] Реализовать event upload и точный audit tenant/device/operator/reason/source/revision/format/result. Recovery не делает автоматический rerender неизвестной попытки под другой DPI; проверяет старый digest/resources.
- [ ] PASS package Station/API gates, browser режимов, Windows candidate checks. Проверить реально RAW и драйвер А4, три вида скана, offline restart и owner transfer отдельно на hardware. Commit.

**Команды:**

```bash
corepack pnpm --filter @markiro/domain exec vitest run test/warehouse-pallet-reprint-contracts.test.ts test/warehouse-reprint-contracts.test.ts
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/api exec vitest run test/warehouse-pallet-reprint-lookup.e2e.test.ts test/warehouse-pallet-reprint-events.e2e.test.ts test/station-warehouse-reprint-openapi.test.ts
corepack pnpm turbo run build --filter='@markiro/station^...'
corepack pnpm --filter @markiro/station exec vitest run test/warehouse-pallet-sources.test.ts test/warehouse-pallet-reprint-printing.test.ts test/warehouse-reprint-screen.test.tsx test/pallet-sheet-printing.test.ts
```

Команды новых файлов становятся runnable после соответствующего RED шага. Пока это план, результатов выполнения нет. Kotlin gates нужны при изменении consumed shared fixtures; при выбранном отдельном Station protocol старые fixtures проверяются на неизменность, без нового функционала ТСД.

## Результат реализации

Этап реализован в `codex/station-printing-follow-up`. [Проверки и ограничения](2026-10-11-printing-follow-up-verification.md) фиксируют фактические результаты, исправления итогового ревью и требования к следующей beta. Исторические задания не переписываются; production deployment и физическая печать здесь не выполнялись.
