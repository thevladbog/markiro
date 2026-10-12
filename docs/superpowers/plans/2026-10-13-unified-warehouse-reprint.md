# Единая перепечатка продукции, коробов и палет — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Один сеанс перепечатки с тремя заранее выбранными шаблонами; скан автоматически печатает продукцию, короб или палету на назначенном принтере.

**Architecture:** Общий контроллер сеанса определяет тип объекта по историческим данным и использует существующие журналы отправки и восстановления. Данные палеты отделены от шаблона исходной печати; выбранный шаблон создаёт новую попытку с собственными сохранёнными байтами. API и Station договариваются о поддержке нового контракта через capability, сохраняя старые протоколы и очереди.

**Tech Stack:** TypeScript, Zod, React, @markiro/ui, Vitest, Playwright, SQLite/Tauri, NestJS/Drizzle/Postgres; Node 24+, Corepack и закреплённый pnpm репозитория.

**Spec:** Уточнения пользователя от 13.10.2026 в этом чате: единое окно; три шаблона до начала сеанса; сразу печать по скану; формат палеты по флагу А4 назначенного принтера; настройка оборудования только в настройках станции. Этот план заменяет отдельный режим палеты и обязательное подтверждение каждой новой печати из [предыдущего дизайна](../specs/2026-10-12-pallet-reprint-screen-and-template-design.md) и [плана](2026-10-12-pallet-reprint-screen-and-template.md). Исторические документы остаются описанием выпущенного поведения.

**Status:** Реализован на ветке `codex/unified-warehouse-reprint`; результаты и границы приёмки — в [отчёте](../../acceptance/2026-10-13-unified-warehouse-reprint.md).

## Global Constraints

- Один экран и один сеанс; нет переключателя «Продукция и короба / Палета».
- До старта: причина и три шаблона — продукция, короб, палета. Названия и назначенные принтеры видны сразу. При отсутствии пригодного шаблона старт блокируется с конкретной причиной и ссылкой на настройку/обновление каталога.
- Оборудование и назначения `duplicate`, `box`, `pallet` меняются только в существующих настройках станции. В перепечатке нет второго редактора принтеров.
- `resolvePrinter(hardware, "pallet")?.paper === "a4"`: показывать А4; иначе — термошаблоны палеты. А4 требует Windows driver и 300 dpi по существующему контракту. У термопринтера сохраняются RAW ZPL/TSPL или Windows driver и его DPI.
- Впервые напечатанная на А4 палета может перепечатываться на 75×120 и обратно при наличии исторических полей. Изменение формата не меняет SSCC, даты, количество или состав.
- Новые источники палеты содержат данные, а не исходный шаблон/растр. Снимок выбранного макета и байты фиксируются в конкретной попытке перед отправкой; восстановление этой попытки не пересчитывает их.
- Только закрытые производственные палеты; складские сборные палеты не входят в этап.
- Продукция → этикетка продукции; SSCC короба → короб; SSCC палеты → палета. Скан продукции/короба не печатает родительскую палету.
- Тип SSCC определяется по базе, а не по префиксу. Неоднозначность, отсутствие записи, открытый/расформированный объект и чужой tenant не приводят к печати.
- Offline-first, tenant/device/operator isolation, credential leases, durable outbox и идемпотентность сохраняются. Не добавлять сетевые шрифты или внешние runtime assets.
- Отправка не означает физическую проверку. Неизвестная доставка конкретной попытки требует восстановления; отсутствие старого шаблона или старого receipt само по себе не доказывает неизвестную доставку.
- Старые V1/V2 клиенты, задания, ревизии источников и аудит сохраняются. Не переписывать существующие source digest и уже отправленные байты.
- Пользовательские А4-шаблоны не перезаписываются. Новые стандартные макеты должны быть доступны и явно различимы со старыми; новые сеансы используют выбранную актуальную версию.

## Review Focus

1. Одинаково выглядящий SSCC короба/палеты: печатается фактический объект, при двух совпадениях — понятная ошибка без отправки.
2. Палета со старым А4-снимком и назначенным термопринтером: доступен 75×120, сохраняются исторические даты и количества.
3. Перезапуск/смена владельца во время отправки: нет повторной автоматической отправки или записи под новым владельцем.
4. Экран 1024×768, длинные русские названия и широкий логотип: основные действия доступны; нет вложенных вертикальных скроллов.
5. Старый пользовательский макет и быстрые переключения шаблонов: пользовательский JSON не меняется, запоздалое превью не заменяет выбранное.

## Подтверждённые причины текущих проблем

- `PalletTemplatePicker.tsx` фильтрует каталог по `source.rendering.kind`; `palletTemplateUnavailable` и `makePalletRenderingV2/assertPalletRenderingMatchesSource` запрещают другой вид бумаги. Ограничение есть и в API.
- `WarehouseReprint.tsx` держит отдельный режим/контроллер палеты. `PalletConfirmation.tsx` сначала получает источник, потом даёт выбрать шаблон и подтвердить печать.
- `warehouse-reprint-mode-panel`, палетная область и боковая панель допускают независимую прокрутку; `warehouse-work-grid:has(.warehouse-pallet-card)` запрещает сжатие по доступной высоте.
- А4-превью каждый раз отрисовывается в полном размере 300 dpi, затем декодируется пиксельным циклом в canvas. Отмена effect скрывает результат, но не прекращает уже начатую работу. Время отдельных фаз ещё нужно измерить.
- Текущий `buildPalletSheetPresets()` уже задаёт отступ logo/name, правый крупный заголовок, подчёркивание и footer. Миграция 0183 создала старую компоновку; предыдущий этап намеренно не обновлял существующие записи. Путь применения новой версии должен стать частью приёмки.

### Task 1: Данные палеты без зависимости от исходного макета

**Files:**

- Create: `packages/domain/src/warehouse-reprint/pallet-data.ts`, `packages/domain/test/pallet-data.test.ts`.
- Modify: exports `packages/domain/src/index.ts`; `apps/api/src/modules/station-warehouse-reprint/pallet.service.ts`, `pallet-renderings.service.ts` и существующие controller/DTO/capabilities этого модуля.
- Modify: `apps/station/src/lib/warehouse-reprint/pallet-sources.ts`, `pallet-rendering.ts`, `pallet-work.ts`.
- Modify: `packages/db/src/schema/pallet-label-sources.ts`, `packages/db/src/sqlite/pallet-reprint-schema.ts`, authoritative `packages/db/src/sqlite/migrations.ts`; добавить новые миграции, не менять применённые.
- Test: `packages/domain/test/pallet-reprint-v2.test.ts`, `apps/api/test/warehouse-pallet-v2.e2e.test.ts`, `apps/station/test/warehouse-pallet-sources.test.ts`, `warehouse-pallet-v2-store.test.ts`, DB source/schema/migration suites.

**Interfaces:** Новый capability `warehouse-unified-reprint-v3`. Новый versioned источник данных палеты: SSCC, shift ID/number, время закрытия, состав/digest, исторические label fields с гражданскими датами/готовой датой годности, branding и revision. Источник не содержит template/rendering. Domain функции `parsePalletData` и `renderingFromPalletData(data, choice)` принимают данные и выбранный `PalletTemplateChoice`; обе ветки rendering проверяются по одним историческим фактам. Старые функции V1/V2 продолжают обслуживать старые очереди.

- [ ] RED: источник А4 + thermal 75×120 и источник thermal + А4 дают тот же SSCC/количество/дату; старый V2 сохраняет прежнюю валидацию.
- [ ] RED: шаблон, запрашивающий отсутствующее историческое поле, отвергается точным кодом; пустое необязательное поле допустимо. Не восстанавливать дату/срок из сегодняшнего каталога.
- [ ] Ввести строгий versioned DTO и canonical digest данных. Для старого А4 адаптер читает `facts`; для старого thermal — замороженные поля. Готовую старую дату годности сохранить; если восстановить обязательное поле доказуемо нельзя, не выдумывать его.
- [ ] Новая запись исторических данных при закрытии палеты не сохраняет исходный макет. Для старых источников использовать проверенный адаптер без изменения исходной ревизии/аудита. Ни отсутствие исходной картинки, ни отсутствие receipt у legacy сами по себе не блокируют данные закрытой палеты.
- [ ] Новая попытка фиксирует выбранный snapshot, факты, профиль и bytes. API проверяет факты/состав/tenant, а не равенство виду исходного шаблона; сервер не растеризует.
- [ ] RED/GREEN: чужой tenant/device, изменённый состав, неподтверждённая конкретная отправка, повтор receipt и legacy outbox. Проверить точные actor/action/result аудита.
- [ ] Прогнать domain/DB gates, rebuild DB перед API e2e; проверить миграции на изолированной базе и in-memory копии предоставленного mirror, исходный файл не менять. Зафиксировать результат этапа.

### Task 2: Определение объекта и общий durable сеанс

**Files:**

- Create: `apps/station/src/lib/warehouse-reprint/dispatch.ts`, `apps/station/test/warehouse-reprint-dispatch.test.ts`.
- Modify: `apps/station/src/lib/warehouse-reprint/work.ts`, `types.ts`, `store.ts`, `templates.ts`, `pallet-work.ts`, `pallet-templates.ts`, `sync.ts`; hooks `use-warehouse-reprint.ts`, `use-warehouse-pallet-reprint.ts`.
- Modify: `packages/db/src/sqlite/warehouse-reprint-schema.ts`, `warehouse-reprint-migrations.ts`, `migrations.ts`; source persistence и route contracts API для V3 lookup.
- Test: `warehouse-reprint-work.test.ts`, `warehouse-reprint-store.test.ts`, `warehouse-reprint-session-close.test.ts`, `warehouse-pallet-work.test.ts`, `warehouse-pallet-v2-sync.test.ts`; API lookup/OpenAPI/CORS/route inventory suites.

**Interfaces:** `resolveReprintTarget(raw)` возвращает discriminated `unit | box | pallet | unavailable`, после локального/серверного lookup. Общий сеанс сохраняет reason, три template choices, статус и счётчики. Для нового API versioned lookup `/station/warehouse-reprint/lookup-v3`; доступ только paired Station с авторизованным оператором. Старые маршруты не меняют смысл.

```ts
// Целевая маршрутизация; kind определяется lookup, не одним парсером SSCC.
switch (target.kind) {
  case "unit":
    return printUnit(target, session.unitTemplate);
  case "box":
    return printBox(target, session.boxTemplate);
  case "pallet":
    return printPallet(target, session.palletTemplate);
  case "unavailable":
    return showLookupError(target.code);
}
```

- [ ] RED: поочерёдные сканы продукции, короба и палеты дают три правильные отправки без кнопки подтверждения; скан продукции внутри палеты не печатает палету.
- [ ] RED: неизвестный и неоднозначный SSCC не отправляют ничего; локальная палета не теряется из-за того, что старый parser называет любой SSCC коробом.
- [ ] Добавить единый lookup: проверка кандидатов в зеркалах и authoritative ответ API. Не переходить к другому типу после network/authorization/conflict error. Офлайн использовать только допустимые сохранённые данные.
- [ ] Добавить настройки третьего шаблона в общий durable session. Старый сеанс не запускать автоматически: показать существующие два выбора и предложить настроить палету. Восстановление старых незавершённых заданий доступно до нового старта.
- [ ] Переиспользовать существующие prepare/claim/send/event команды. Не оборачивать pooled SQLite-вызовы в фиктивную транзакцию. Общая очередь не принимает следующий скан во время отправки или unresolved recovery; повторный скан текущей этикетки не создаёт случайную повторную отправку.
- [ ] RED/GREEN: два быстрых одинаковых скана, рестарт prepared/sending, owner change, закрытие сеанса и запоздалый lookup; последующая явная перепечатка с причиной создаёт отдельную попытку.
- [ ] Обновить pending counters, синхронизацию и retention для новых rows. Протестировать всё с задержанными ack и старой офлайн-очередью; новые каналы не блокируют существующие.
- [ ] Обновить capability, OpenAPI, CORS и affected CI ownership; gates Station/DB/API. Зафиксировать результат этапа.

### Task 3: Единое окно и выбор трёх шаблонов до сканирования

**Files:**

- Modify: `apps/station/src/pages/WarehouseReprint.tsx`, `src/ui/warehouse-reprint/TemplatePicker.tsx`, `PalletTemplatePicker.tsx`, `PalletConfirmation.tsx`, `ReprintStatus.tsx`, `src/station.css`, RU/EN i18n.
- Test: `apps/station/test/warehouse-reprint-screen.test.tsx`, `warehouse-reprint-language.test.tsx`, `warehouse-pallet-template-picker.test.tsx`, `warehouse-pallet-screen.test.tsx`.
- Browser: `tools/production-browser/station-inventory-tests/warehouse-reprint.spec.ts`, `product-labels-tests/pallet-reprint.spec.ts` и существующий browser harness.

**Interfaces:** Экран использует один `state.session`; template picker доступен до lookup. Выбор палеты фильтруется по текущему назначенному профилю `pallet`, а не по найденному источнику. В общем рабочем экране — результат последней печати и суммарный счётчик всех типов; отдельные counts доступны в деталях, не создают дополнительных панелей.

- [ ] RED: до старта видны три шаблона и причина; старт без пригодных трёх выборов отключён. Флаг А4 даёт только А4, отсутствие флага — только thermal. Принтер определяется существующим routing.
- [ ] Убрать tabs режимов и промежуточную карточку подтверждения палеты. Общие «Ввести код вручную», «Выбрать шаблоны», «Изменить причину», «Завершить сеанс» работают для трёх типов.
- [ ] Настройка оборудования открывается существующей ссылкой. Возврат после смены printer/paper повторно валидирует выбор; несовместимый шаблон сбрасывается/предлагается совместимый до возобновления сканирования. Незавершённая отправка сохраняет свой старый профиль и recovery.
- [ ] Убрать исходный сохранённый макет из настроек нового сеанса. Старый snapshot показывать только в восстановлении соответствующей попытки.
- [ ] Оставить один scroll owner у основного содержимого; header/actions доступны. Боковая панель не имеет отдельного вертикального scroll; убрать несовместимый `min-content/flex-shrink:0` палетной сетки. Диалог выбора имеет собственную единственную область прокрутки.
- [ ] Browser assertions на 1024×768 и 1280×800: кнопки доступны без вложенных скроллов, длинные названия/RU/EN/light/dark, ручной ввод/скан всех типов, отсутствие post-scan confirm.
- [ ] Прогнать focused UI/browser и Station gates. Сохранить screenshots в `testInfo.outputPath`; визуально проверить фактические размеры. Зафиксировать результат этапа.

### Task 4: Быстрый предпросмотр без повторной полной растеризации

**Files:**

- Create: `apps/station/src/lib/warehouse-reprint/preview-cache.ts`, `apps/station/test/warehouse-reprint-preview-cache.test.ts`.
- Modify: `pallet-rendering.ts`, `TemplatePicker.tsx`, `PalletTemplatePicker.tsx`, `src/ui/LabelRasterPreview.tsx`; domain sheet preview helper только если замеры требуют отдельной raster geometry.
- Test: `warehouse-reprint-preview.test.tsx`, `warehouse-pallet-template-picker.test.tsx`; domain `pallet-sheet-render.test.ts` при изменении renderer.

**Interfaces:** Preview key включает kind, template digest, facts digest, branding digest и DPI/geometry. Ограниченный in-memory cache, максимум 6 превью; нет новой постоянной копии полной картинки в источнике палеты. До первого скана шаблоны показывают явно обозначенные демонстрационные данные.

- [ ] Замерить отдельно lookup каталога, fonts, layout/rasterize, encode, canvas upload на всех трёх А4 и 75×120. Записать холодное/повторное открытие и объём памяти; не объявлять ускорение по одному mock-тесту.
- [ ] RED: повторное открытие того же выбора не растеризует заново; смена digest/branding/DPI меняет cache key; результат отменённого старого выбора не появляется.
- [ ] Сначала использовать cache/dedup и отмену ещё не начавших работу запросов; рендерить только выбранный шаблон. Каталог взять из существующего owner-scoped cache сразу и обновлять в фоне с guarded commit, без двух обязательных сетевых round trips для открытия окна.
- [ ] Для А4 отделить экранное превью от печатных bytes: ограничить preview размером 800 px по длинной стороне через общий layout и downsample. Сохранить производственный renderer/300 dpi и проверку GS1 размеров; preview не отправлять на принтер и не использовать для геометрических доказательств.
- [ ] Проверить соответствие текста/переносов/логотипа/SSCC между preview и полной печатью. На повторном открытии нет индикатора полной перерисовки; быстрое переключение не тормозит остальные controls.
- [ ] Прогнать focused cache/UI/domain tests и browser замеры. Реальные показатели Windows WebView фиксируются отдельно от Mac/browser. Зафиксировать результат этапа.

### Task 5: Реальное применение новых А4-макетов

**Files:**

- Modify: `packages/domain/src/labels/pallet-sheet-defaults.ts` только при обнаруженной проблеме компоновки; `apps/admin/src/pages/labels/index.tsx`, editor sheet page и i18n для понятного обновления стандартов.
- Add: новая Postgres миграция стандартных preset revisions; tests `packages/db/test/pallet-sheet-templates-migration.test.ts` и fixture старой 0183.
- Test: domain `pallet-sheet-defaults.test.ts`, `pallet-sheet-render.test.ts`; admin `pallet-sheet-defaults-ui.test.tsx`, `pallet-sheet-json-ui.test.tsx`; browser `pallet-sheet.spec.ts`, `pallet-sheet-station.spec.ts`.

**Interfaces:** Новые стандартные версии трёх А4 доступны в библиотеке и свежем каталоге Station. Связь старый/новый стандарт хранится явно; historical shift/job snapshots остаются прежними. Новая перепечатка использует выбор сеанса, а не snapshot смены.

- [ ] RED migration: исходные немодифицированные presets из 0183 получают актуальную версию; повторное применение идемпотентно. Пользовательский/переименованный/выключенный шаблон, JSON которого отличается от исторического стандарта, не меняется автоматически.
- [ ] Обновлять только доказанно нетронутый стандарт с повышением revision. Для изменённых экземпляров создать отдельный актуальный стандарт, сохранить прежние ID/JSON и предоставить явное назначение. Не назначать другую версию за пользователя, если у него выбран собственный макет.
- [ ] На станции обновлённый digest инвалидирует каталог/preview cache и устаревший выбор будущего сеанса; текущая незавершённая попытка не меняется.
- [ ] Визуальная приёмка на настоящем JSON каталога после миграции: gap logo/name 5 мм (3 мм для двух А5), отдельная правая область «ПАЛЕТА» 18 pt (12 pt для двух А5), подчёркивание, ИНН при наличии и «Сформировано в Маркиро». Широкий logo/длинная организация не пересекаются с заголовком.
- [ ] Проверить две идентичные А5, отсутствие даты, ЕГАИС, длинную продукцию и сохранение модулей/quiet zones GS1. Старый source А4 перепечатать новыми А4 и thermal; отдельно убедиться, что старое unresolved задание восстанавливает старые bytes.
- [ ] Прогнать domain/DB/admin/Station gates и API template selection tests; при миграции проверить реальную изолированную БД. Зафиксировать результат этапа.

## Итоговые проверки и выпуск

- [ ] После каждого этапа — focused RED/GREEN и краткая запись результата; перед общим review — package test/typecheck/lint/build всех изменённых пакетов, `git diff --check`, `pnpm format:check`.
- [ ] Shared dist сначала перестроить через Turbo; DB e2e выполнять с явно подготовленной изолированной test DB. Skips не считать доказательством.
- [ ] Проверить полную three-dot diff от актуального `origin/main`, сохранить чужие изменения. Коммиты/пуш/PR и релиз выполнять только в пределах действующей авторизации; обновление плана само по себе релиз не запускает.
- [ ] Добавить acceptance документ: один сеанс unit → box → pallet; палета А4 → 75×120 → А4; изменения принтера до/во время сеанса; offline/restart/unknown/owner change; UI без вложенных scroll; cold/warm preview timings; новые реальные шаблоны.
- [ ] На Windows физически проверить А4, 75×120 ZPL/TSPL или доступный thermal driver, считывание SSCC и updater. Browser/host Cargo это не заменяют.
- [ ] Rollout: DB/API с новым capability и маршрутами/CORS → проверка живого API → Station beta. Старые станции продолжают работать до обновления. До stable нужна физическая приёмка.

Примеры focused команд (точные новые имена suites перечислены в соответствующих этапах):

```sh
corepack pnpm --filter @markiro/domain exec vitest run test/pallet-data.test.ts test/pallet-reprint-v2.test.ts test/pallet-sheet-render.test.ts
corepack pnpm turbo run build --filter='@markiro/station^...' --filter='@markiro/api^...' --filter='@markiro/admin^...'
corepack pnpm --filter @markiro/station exec vitest run test/warehouse-reprint-dispatch.test.ts test/warehouse-reprint-work.test.ts test/warehouse-reprint-screen.test.tsx test/warehouse-reprint-preview-cache.test.ts
corepack pnpm --filter @markiro/api exec vitest run test/warehouse-pallet-v2.e2e.test.ts test/station-warehouse-reprint-lookup.e2e.test.ts test/station-warehouse-reprint-openapi.test.ts
corepack pnpm test:station-release:contract
```

## Самопроверка плана

- Все новые пользовательские требования покрыты этапами 1–5; настройка принтеров остаётся существующей.
- Старый источник и новая попытка разделены; нет обещания менять уже отправленные bytes или автоматически восстановить отсутствующие исторические даты.
- SSCC определяется по данным; не заложен ошибочный переход от скана продукции к печати всей палеты.
- Скорость включает измерения и cache invalidation; визуальная приёмка использует реальные migrated templates, а не только builder.
- Релиз/production/физическая печать отделены от автоматических проверок.
