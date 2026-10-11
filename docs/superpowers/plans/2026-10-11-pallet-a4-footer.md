# Pallet A4 Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Привести три А4-макета Station к стилю ручного ярлыка админки без изменения сохранённых попыток и термоэтикеток.

**Architecture:** Необязательные настройки подчёркивания и подписи SSCC footer хранятся в существующем JSON шаблона. ИНН фиксируется в приватном branding snapshot. Отдельная capability разрешает новые настройки; старые шаблоны и ответы API сохраняют прежний контракт.

**Tech Stack:** TypeScript, Zod, React, NestJS, Drizzle, локальная SQLite, Vitest, Playwright.

**Spec:** [Согласованный дизайн](../specs/2026-10-11-pallet-a4-footer-design.md).

## Global Constraints

- Только вертикальный А4, горизонтальный А4 и две одинаковые А5 на А4; термоэтикетки не менять.
- ИНН из `org_profiles.inn`; отсутствующий ИНН скрывать.
- Футер и подчёркивание редактируются и переносятся через JSON.
- Не переписывать сохранённые пользовательские шаблоны, выбранные шаблоны или исторические print bytes.
- Существующие поля, высота, модуль и тихие зоны GS1 SSCC сохраняются.
- Не добавлять CDN, сетевую загрузку шрифтов или нового raster renderer.

## Review Focus

- Старый клиент со strict DTO не должен получить неизвестные ключи branding.
- Старый snapshot без ИНН должен сохранить тот же digest и печатные байты.
- Длинное название и реальные поля драйвера не должны столкнуться с футером.
- Изменение ИНН после подготовки не должно изменить незавершённое задание.
- Новая возможность в шаблоне не должна начать печататься на неподдерживающей Station.

### Task 1: Расширение модели и контроль возможностей

**Files:** `packages/domain/src/labels/pallet-sheet-model.ts`, `pallet-sheet-branding.ts`, `pallet-sheet-snapshot.ts`, `packages/domain/src/index.ts`; `apps/api/src/modules/shifts/pallet-sheet-policy.ts`, `shifts.service.ts`.

**Interfaces:** Экспортировать `PALLET_SHEET_FOOTER_CAPABILITY = "pallet-sheet-footer-v1"` и `palletSheetRequiresFooterCapability(spec: PalletSheetSpecV2): boolean`. У поля добавить необязательное `underline: { thicknessMm: number; gapMm: number }`. В `footer` добавить необязательный `caption: { fontSizePt: number; separatorThicknessMm: number; gapMm: number; showInn: boolean; platformText: string }`. Старые объекты без этих ключей сохраняются без defaults при parse.

- [ ] Добавить failing schema/JSON/snapshot тесты: новый footer round-trip, неверные размеры, старый digest без новых полей. Проверить рекурсивные узлы с подчёркиванием.
- [ ] Запустить `corepack pnpm --filter @markiro/domain exec vitest run test/pallet-sheet-model.test.ts test/pallet-sheet-json.test.ts test/pallet-sheet-snapshot.test.ts` и сохранить RED.
- [ ] Добавить минимальные поля модели и capability helper. Сохранить schemaVersion 2 и формат `pallet_sheet_v2`; расширение требует capability, а не безусловной смены протокола для всех макетов.
- [ ] В API selection/entry/reference bundle проверить capability по фактическому frozen spec до его выдачи старому клиенту. Старый v2-макет продолжает приниматься. Не выдавать неподдерживаемые ключи и не пересчитывать исторический snapshot.
- [ ] Проверить отсутствие остановки существующей смены со старым snapshot и точный код отказа для нового неподдерживаемого макета в `apps/api/test/pallet-sheet-policy.test.ts`, `pallet-sheet-selection.test.ts`, `shifts-bundle.e2e.test.ts`.
- [ ] Прогнать GREEN и commit модели/policy.

### Task 2: ИНН в opt-in branding

**Files:** `apps/api/src/modules/org-profile/org-profile.service.ts`, `station-branding.controller.ts`; `apps/station/src/lib/api-client.ts`, `organization-branding.ts`; shared branding schema из Task 1.

**Interfaces:** В descriptor и `BrandingSnapshot` — необязательное `organizationInn: string | null`. `getStationBranding(tenantId, { includeInn: boolean })` по умолчанию возвращает старый ответ. Новый Station отправляет footer capability; controller включает ИНН только при этой capability. Handheld и кабинетные ответы по умолчанию сохраняют старую форму.

- [ ] Написать failing тесты старого ответа без нового ключа, opt-in с ИНН/null, чужого tenant и старого snapshot/digest. Прочитать `apps/handheld/AGENTS.md`; проверить прежнюю форму handheld branding без изменений Kotlin.
- [ ] Реализовать tenant-scoped чтение `org_profiles.inn`. Добавить capability в существующий заголовок Station и необязательное поле локального snapshot без миграции старых записей.
- [ ] В refresh сравнивать также ИНН. Обновлённый профиль меняет только будущий branding, frozen resource задания остаётся прежним.
- [ ] Прогнать `apps/api/test/org-profile.service.test.ts`, `org-profile.controller.test.ts`, `org-profile.e2e.test.ts` и `apps/station/test/organization-branding.test.ts`. DB e2e использовать только с локальной тестовой БД.
- [ ] Обновить OpenAPI установленным генератором и проверить diff; не редактировать generated clients вручную. Commit opt-in контракта.

### Task 3: Общая отрисовка и встроенные пресеты

**Files:** `packages/domain/src/labels/pallet-sheet-render.ts`, `pallet-sheet-defaults.ts`; `apps/station/src/lib/pallet-sheet-print-snapshot.ts`, `a4-test-print.ts`, `apps/station/src/ui/PalletSheetPreview.tsx`.

**Interfaces:** `PalletSheetContext.organizationInn?: string | null`. `renderPalletSheet` резервирует высоту подписи только при `spec.footer.caption`. ИНН передаётся из frozen branding, не из текущего API или часов.

- [ ] До изменения renderer зафиксировать baseline bytes/digest старого макета без новых настроек.
- [ ] Написать failing тесты линии под фактическим названием, футера под HRI, отсутствующего ИНН, длинного ИНН/названия, трёх ориентаций, двух одинаковых А5 и реальных printable bounds.
- [ ] Нарисовать подчёркивание после текста, сохранив reservedLines. Зарезервировать caption до расчёта body/SSCC placement; при переполнении отказать до отправки. SSCC barHeight/module/quiet zones не уменьшать.
- [ ] Включить настройки в три встроенных пресета; старый spec без настроек должен выдавать baseline bytes. Сохранённые templates в БД автоматически не изменять.
- [ ] Подключить ИНН к общей подготовке и preview; generic setup test без ИНН печатает только платформенную подпись.
- [ ] Прогнать domain tests и build, затем Station `pallet-sheet-printing.test.ts`, `pallet-sheet-settings.test.tsx`, `workstation-setup.test.tsx`. Commit renderer/presets.

### Task 4: Редактор, preview, импорт/экспорт

**Files:** `apps/admin/src/pages/labels/editor/sheet/SheetEditor.tsx`, `SheetNodeInspector.tsx`, `SheetTemplatePage.tsx`, `sheet-import.ts`; `apps/admin/src/i18n/ru.json`, `en.json`; Admin preview/branding consumers.

- [ ] Добавить failing component/JSON тесты включения/выключения и настройки footer/underline; старый JSON не должен автоматически приобретать новые настройки.
- [ ] Добавить управляемые настройки к существующим inspector/SSCC controls, с существующими UI компонентами и переводами.
- [ ] Передать ИНН в preview. Редактор получает opt-in данные без изменения старых cabinet/handheld ответов.
- [ ] Предусмотреть выбор обновлённого пресета для создания или явного изменения существующего шаблона; сохранить новую revision обычным API. Не перезаписывать tenant шаблоны по seedKey автоматически.
- [ ] Прогнать `pallet-sheet-editor.test.tsx`, `pallet-sheet-json-ui.test.tsx`, `pallet-sheet-preview.test.ts`, `pallet-sheet-branding.test.ts`, `pallet-sheet-thumbnail.test.tsx`. Commit редактора.

### Task 5: Повторы и визуальная регрессия

**Files:** `apps/station/test/pallet-sheet-printing.test.ts`, `organization-branding.test.ts`; `tools/production-browser/product-labels-tests/pallet-sheet-station.spec.ts`; Admin/Station browser harnesses; `docs/acceptance/validation-pallet-a4-printing.md`.

- [ ] Проверить exact bytes для prepared/unknown попытки после изменения ИНН, шаблона и текущего branding; проверить допустимую новую попытку только по существующим правилам восстановления.
- [ ] Проверить старые referenced/inline branding snapshots без ИНН, restart и sealing credentials; старые digest не менять defaults в parser.
- [ ] Дополнить browser сценарии для каждого пресета: линия, подписи, ИНН/null, две А5, прямоугольный логотип, длинное название и production CSP.
- [ ] Просмотреть browser снимки и обновить acceptance сценарий. Не считать Chromium доказательством реальной Windows печати.
- [ ] Commit проверок/приёмки.

### Task 6: Итоговые gates и PR

- [ ] Собрать изменённые shared dependencies перед consumer checks через Turbo.
- [ ] Выполнить test/typecheck/lint/build для domain, API, Admin и Station; повторить API DB e2e с тестовой БД либо явно сообщить skips.
- [ ] Выполнить product-labels browser suite, `corepack pnpm format:check`, `git diff --check`; проверить CI affected paths и актуальный three-dot diff после fetch main.
- [ ] Провести review совместимости/повторов; исправить только подтверждённые дефекты.
- [ ] Push/PR в ранее разрешённом scope. Merge/deploy и выпуск следующей Station beta — после зелёного CI и отдельного разрешения релиза. Реальную печать/сканирование указать как отдельную приёмку.
