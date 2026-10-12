# Единая форма шаблонов в админке Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Объединить назначения продукции, коробов, термо-палет и А4 под общей кнопкой Сохранить.

**Architecture:** Все назначения находятся в React Hook Form профиля, PalletSheetDefaults становится controlled section. Существующий PUT атомарно сохраняет все изменённые поля.

**Tech Stack:** TypeScript, Zod, Drizzle/Postgres, pooled SQLite, React/Vite, Vitest/Playwright; существующий Tauri transport без новых зависимостей.

**Spec:** [Утверждённый дизайн](../specs/2026-10-11-station-printing-follow-up-design.md). Статус: реализован и проверен; физическая приёмка и deployment остаются отдельным этапом.

## Global Constraints

Действуют все общие правила спецификации: Node 24+, Corepack; гражданские даты; неизменность исторических снимков и байтов; tenant/device/operator isolation; offline-first; RAW и Windows; capability-gated совместимость V1; без сырого КМ в аудите. Работать на новой task branch от проверенного main, сохраняя чужие изменения. Выполнение здесь по этапам, с проверками после каждого.

## Review Focus

- Ошибка PUT: сохраняется весь черновик, включая А4.
- Пустой выбор: правильные null/empty-array/omitted semantics.
- Категория или шаблон больше недоступны: видимая проблема без скрытой очистки.
- Refetch во время редактирования: не теряется черновик.
- Старые URLs/JSON keys: совместимы после исправления русского написания.

### Task 1: Общая форма и один запрос

**Files:**

- Modify: `apps/admin/src/pages/settings/OrgProfilePage.tsx`, `PalletSheetDefaults.tsx`.
- Test: `apps/admin/test/org-profile.test.tsx`, `pallet-sheet-defaults-ui.test.tsx`.
- Test: `apps/api/test/org-profile.e2e.test.ts`, `org-profile.service.test.ts`.
- Reference: `apps/admin/src/pages/settings/api.ts`, `apps/api/src/modules/org-profile/dto.ts`, `org-profile.service.ts`; менять контракт только если тест обнаружит реальный пробел.

**Interfaces:** add `defaultPalletSheetTemplateId` and `categoryPalletSheetTemplateDefaults` to form values/mappers. Controlled section consumes values, onChange, validation errors and templates; не имеет собственного mutation. Produces one existing `PutOrgProfileDto` containing only intentionally changed fields.

- [ ] RED: одновременно изменить defaults коробов, термо-палеты и А4 → один PUT/одна кнопка, один success reset.
- [ ] RED: rejection сохраняет все values, refetch их не затирает; очистка default и category overrides отправляет null/[]; неизменённые поля omitted.
- [ ] Перенести A4 values в общую форму и dirty mapping, убрать отдельный submit/Save. Встроить section в существующий блок Шаблоны палеты с теми же Select/table и validation conventions.
- [ ] RED и реализация catalog-only rows плюс явное исправление сохранённых orphan overrides; несовместимая категория/формат/template revision видны до отправки.
- [ ] API tests проверяют единую транзакцию: невалидный А4 не сохраняет другие настройки частично; tenant denial и существующие defaults не ломаются. Commit после PASS.

### Task 2: Терминология и browser приёмка

**Files:**

- Modify: `apps/admin/src/i18n/ru.json`; найденные через `rg` пользовательские hardcoded strings в `apps/admin/src` и соответствующие tests. Полный список включить в staged diff; без API/SQL rename.
- Test: `apps/admin/test/pallets.test.tsx`, `warehouse-pallets.test.tsx`, `pallet-sheet-defaults-ui.test.tsx`, `org-profile.test.tsx`.
- Browser: existing admin harness in `tools/production-browser/product-labels-tests/pallet-sheet.spec.ts`.

**Interfaces:** переводимые тексты меняются, keys/routes/export JSON schemas неизменны.

- [ ] Найти все формы паллет/ПАЛЛЕТ в visible UI/print strings; обновить их на палет с правильными падежами. Проверить navigation, фильтры, ошибки, карточки и печатные заголовки.
- [ ] Убедиться, что А4 не создаёт самостоятельный навигационный пункт: библиотека по-прежнему общая, тип А4 остаётся фильтром/форматом редактора.
- [ ] Browser: категории только каталога, единый layout и Save на узком/широком окне; keyboard/focus, errors и dirty form после отказа.
- [ ] Package gates admin плюс API org-profile contracts. Commit.

**Команды:**

```bash
corepack pnpm turbo run build --filter='@markiro/admin^...'
corepack pnpm --filter @markiro/admin exec vitest run test/org-profile.test.tsx test/pallet-sheet-defaults-ui.test.tsx test/pallets.test.tsx test/warehouse-pallets.test.tsx
corepack pnpm --filter @markiro/api exec vitest run test/org-profile.e2e.test.ts test/org-profile.service.test.ts
```

Привести screenshots и факт одного PUT из browser; DOM tests отдельно от визуальной проверки.

## Результат реализации

Этап реализован в `codex/station-printing-follow-up`. [Проверки и ограничения](2026-10-11-printing-follow-up-verification.md) фиксируют фактические результаты, исправления итогового ревью и требования к следующей beta. Исторические задания не переписываются; production deployment и физическая печать здесь не выполнялись.
