# Обновление трёх А4 макетов Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать шапку и футер трёх А4 читаемыми и обеспечить явное назначение обновлённых макетов существующей организации.

**Architecture:** Изменить стандартные flow nodes, сохранив renderer и GS1 геометрию. Создание пресета даёт новую запись; пользовательские шаблоны и исторические снимки не обновляются автоматически.

**Tech Stack:** TypeScript, Zod, Drizzle/Postgres, pooled SQLite, React/Vite, Vitest/Playwright; существующий Tauri transport без новых зависимостей.

**Spec:** [Утверждённый дизайн](../specs/2026-10-11-station-printing-follow-up-design.md). Статус: реализован и проверен; физическая приёмка и deployment остаются отдельным этапом.

## Global Constraints

Действуют все общие правила спецификации: Node 24+, Corepack; гражданские даты; неизменность исторических снимков и байтов; tenant/device/operator isolation; offline-first; RAW и Windows; capability-gated совместимость V1; без сырого КМ в аудите. Работать на новой task branch от проверенного main, сохраняя чужие изменения. Выполнение здесь по этапам, с проверками после каждого.

## Review Focus

- Очень широкий логотип и длинная организация: шапка помещается без пересечения.
- Нет логотипа/ИНН: резервный Маркиро и футер платформы.
- Длинная продукция/нет даты/есть ЕГАИС: ожидаемые переносы и скрытие необязательной даты.
- Две А5: две одинаковые палеты, два футера, корректная линия разреза.
- Старый шаблон и сохранённое задание: неизменные JSON и байты.

### Task 1: Компоновка и визуальная проверка

**Files:**

- Modify: `packages/domain/src/labels/pallet-sheet-defaults.ts`.
- Test: `packages/domain/test/pallet-sheet-defaults.test.ts`, `pallet-sheet-render.test.ts`, `pallet-sheet-branding.test.ts`, `pallet-sheet-json.test.ts`.
- Test: `apps/admin/test/pallet-sheet-preview.test.ts`, `pallet-sheet-branding.test.ts`; `apps/station/test/pallet-sheet-printing.test.ts`.
- Modify only if required: `packages/domain/src/labels/pallet-sheet-render.ts`; не менять модель для свойств, уже выражаемых существующими nodes.
- Browser: `tools/production-browser/product-labels-tests/pallet-sheet.spec.ts`, `pallet-sheet-station.spec.ts`.

**Interfaces:** consumes current `PalletSheetTemplateSpec`/branding; produces three specs from existing `buildPalletSheetPresets()` with unchanged format/schema capability. Preview and print consume identical specs.

- [ ] Добавить RED assertions: logo/name gap, отдельная правая область ПАЛЕТА, underline и оба footer captions; две А5 содержат два набора. Проверить, что thermal defaults неизменны.
- [ ] Реализовать вложенную brand row и отдельный заголовок справа существующими `widthMm`, `grow`, `align`, `gapMm`. Начальные размеры взять из spec; корректировать по визуальному результату с сохранением barcode bounds.
- [ ] Добавить cases широкого logo, длинных названий, отсутствующего INN/date, наличия ЕГАИС. Проверить full-page layout без overflow и прежние модули/quiet zones SSCC.
- [ ] Прогнать domain tests и consumers; отрисовать три реальных raster preview и проверить в browser на размерах Station. Проверить grayscale видимость ресурса: белый logo компании на белом фоне не является отсутствием ресурса; отдельную автоматическую перекраску в этот этап не добавлять.
- [ ] JSON roundtrip сохраняет узлы/поля; frozen branding предыдущего задания и replay digest неизменны. Commit.

### Task 2: Назначение новой версии вместо скрытой перезаписи

**Files:**

- Modify: `apps/admin/src/pages/labels/index.tsx`, `apps/admin/src/pages/labels/editor/sheet/SheetTemplatePage.tsx`, `apps/admin/src/i18n/ru.json`, `en.json` — только необходимые copy/ссылки существующего создания пресетов.
- Test: `apps/admin/test/pallet-sheet-defaults-ui.test.tsx`, `pallet-sheet-json-ui.test.tsx`, `pallet-sheet-editor.test.tsx`.
- Test: `apps/api/test/pallet-sheet-selection.test.ts`, `pallet-sheet-templates.test.ts`.

**Interfaces:** existing create-template operation creates new ID; existing profile defaults select it. Старые IDs сохраняются.

- [ ] Написать RED: у организации есть старый/редактированный А4; создание актуального стандартного варианта не меняет его и даёт новый ID с новым footer/header.
- [ ] Переиспользовать существующие кнопки создания трёх пресетов. Сделать путь обновления понятным из настроек; пояснить применение с новой смены. Не редактировать миграцию 0183 и не добавлять массовую перезапись шаблонов.
- [ ] Проверить назначение нового шаблона новой смене и неизменный snapshot старой. Приёмка футера проводится на новой смене, иначе старый снимок закономерно сохраняет прежний лист.
- [ ] Package gates domain/admin/Station и API focused selection tests; browser preview всех трёх. Commit.

**Команды:**

```bash
corepack pnpm --filter @markiro/domain exec vitest run test/pallet-sheet-defaults.test.ts test/pallet-sheet-render.test.ts test/pallet-sheet-branding.test.ts test/pallet-sheet-json.test.ts
corepack pnpm turbo run build --filter='@markiro/admin^...' --filter='@markiro/station^...'
corepack pnpm --filter @markiro/admin exec vitest run test/pallet-sheet-defaults-ui.test.tsx test/pallet-sheet-json-ui.test.tsx test/pallet-sheet-editor.test.tsx
corepack pnpm --filter @markiro/station exec vitest run test/pallet-sheet-printing.test.ts
```

Browser suite запускать по текущему manifest/workflow; сохранить screenshots через test output paths. Физический Windows А4 и scan GS1 — отдельная приёмка, browser её не заменяет.

## Результат реализации

Этап реализован в `codex/station-printing-follow-up`. [Проверки и ограничения](2026-10-11-printing-follow-up-verification.md) фиксируют фактические результаты, исправления итогового ревью и требования к следующей beta. Исторические задания не переписываются; production deployment и физическая печать здесь не выполнялись.
