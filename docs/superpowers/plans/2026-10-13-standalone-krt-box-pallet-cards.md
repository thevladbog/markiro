# План КРТ: карточки короба и паллеты, реестр паллет поперёк смен, вкладки «Коды / Короба / Паллеты» в «Поиске кодов» (хост, протокол, офис; «Расформировать» — последней задачей) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** В облачной админке короб и паллета открываются своей карточкой из любого места: из поиска
кодов, из карточки кода, из карточки смены, из документа дезагрегации. Есть и реестр паллет
поперёк смен. В автономе всё это разбросано по карточке смены: «Состав», «Ярлык», «XML паллеты»,
состояние короба. Отдельной карточки нет, паллеты видны только внутри одной смены (строки П-14…П-17
спецификации паритета). После плана:

- в разделе «Поиск кодов» три вкладки: «Коды» (поиск потока «Поиск кодов»), «Короба» (по одной
  смене, как в облаке) и «Паллеты» (все паллеты площадки с фильтрами и «Показать ещё»);
- карточка короба показывает смену, паллету, станцию и оператора, весь состав с историей
  (в коробе, изъят, забран другим сканом — с временем) и исключения станции;
- карточка паллеты показывает её короба (и расформированные), счета, исключения, ярлык A4/A5 и XML
  паллеты;
- печать «Состав короба», «Состав паллеты», «Ярлык паллеты» и XML паллеты — те же, что в карточке
  смены;
- карточка смены и карточка кода ведут в карточки короба и паллеты;
- после слияния ДЗГ карточки показывают проведённые документы дезагрегации (задача 8);
- после ДЗГ-О в обеих карточках есть кнопка «Расформировать» (задача 9, последняя, можно
  отрезать).

**Architecture:**

- **Хост (только чтение, стиль `routes/office_codes.rs`):**
  - `GET /v1/office/boxes/{id}` — карточка короба (`routes/office_cards.rs`);
  - `GET /v1/office/pallets/{id}` — карточка паллеты (там же);
  - `GET /v1/office/pallets` — реестр поперёк смен (`routes/office_pallets.rs`). Фильтры: товар,
    линия, станция, период закрытия, SSCC. Страница 100 строк с курсором (keyset), как облачная
    догрузка;
  - миграция `0025_pallet_list.sql`: индекс по выражению для порядка реестра и предохранитель
    индекса `scans_ok_box` (Р16);
  - `GET /v1/office/shifts/{id}/boxes` получает имя оператора (П-14).

  Каждый маршрут читает в одной транзакции чтения, каждый запрос — по индексу (тест
  `EXPLAIN QUERY PLAN`). Аудита нет, как у списков смены и поиска кодов.

- **Протокол:** модуль `proto/src/pack_cards.rs` и фикстуры `office-box-card.json`,
  `office-pallet-card.json`, `office-pallet-page.json`. Zod — в `src/host/pack-cards.ts`, по
  образцу `src/host/code-search.ts`. Версия протокола устройства **не растёт**: это офисные
  маршруты чтения.
- **Офис:**
  - layout-маршрут `codes` с памятью вкладок (`CodesSection`);
  - `RegistryTabs` на `DataTabs` из `@markiro/ui`;
  - страницы `BoxesTab`, `PalletsTab`, `BoxCardPage`, `PalletCardPage`;
  - печать — `PrintFormDialog` с той же целью, что в карточке смены; XML — `ExportDialog` в режиме
    одной паллеты;
  - ссылки из `ShiftCardPage` и `CodeCard`.
- **Зависимые задачи:** 8 — строки документов ДЗГ в обеих карточках (поле `documents` есть в
  проводе с задачи 1 и до ДЗГ всегда пусто); 9 — «Расформировать» (после ДЗГ-О).

**Tech Stack:** Rust (axum, sqlx 0.8.6, serde, time) — `host`, `proto`; React 19.2, TypeScript 6
strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4.4.3, i18next,
`@tanstack/react-query` 5.101 (`useInfiniteQuery`), react-router 8 (memory router офиса),
`@markiro/ui` (`DataTabs`, `Table`, `DefinitionGrid`, `PageHeader`, `FilterBar`, `Select`,
`DatePicker`, `Input`, `Button`, `StatusChip`, `EmptyState`, `Card`, `RowActions`, `Alert`),
`@markiro/domain` (печатные формы — через существующие `render-form.ts`/`PrintFormDialog`),
Vitest 4 (jsdom).

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md` — §5.3 (раздел КРТ),
  строки П-14, П-15, П-16, П-17 матрицы, §4 «Порядок и параллельность» (КРТ ждёт «Поиска кодов»,
  «Расформировать» — после ДЗГ-О), §5.1 (ДЗГ: строки документа сами записывают действие, читатели
  истории короба объединяют исключения станции и строки проведённых документов), ПР-1.
- Облако, образец:
  - `apps/admin/src/pages/code-search/BoxCard.tsx` — состав с состояниями `active/displaced/removed`,
    исключения, «Распечатать», ссылка на паллету;
  - `apps/admin/src/pages/code-search/PalletCard.tsx` — короба паллеты (расформированные остаются
    в списке), исключения, ярлык, XML, «Расформировать» (создать черновик и перейти к документу
    с `?sscc=`);
  - `apps/admin/src/pages/code-search/{RegistryTabs.tsx,registry-location.ts,useRememberRegistryLocation.ts}` —
    три вкладки и память фильтров вкладок;
  - `apps/admin/src/pages/pallets/index.tsx` — реестр паллет: фильтры, столбцы, «Показать ещё»;
  - `apps/admin/src/pages/boxes/index.tsx` — реестр коробов с обязательным выбором смены;
  - `apps/api/src/modules/code-search/code-search.service.ts:741` (`getBoxCard`) и `:924`
    (`getPalletCard`);
  - `apps/api/src/modules/pallets/{pallets.service.ts,dto.ts}` — порядок
    `closed_at DESC NULLS FIRST, id`, keyset-курсор, 100 по умолчанию;
  - тексты — `apps/admin/src/i18n/ru.json` (`pages.codeSearch.boxCard.*`, `palletCard.*`,
    `pages.pallets.*`, `pages.boxes.*`).
- Поток «Поиск кодов»: `/tmp/claude/wt/fb-codesearch`, ветка `claude/fb-codesearch`.
- Планы `docs/superpowers/plans/2026-10-13-standalone-dzg-disaggregation.md` (таблицы `0024`,
  провод `proto/src/disaggregation.rs`, `HostApi`, права, запрос объединения для читателей) и
  `…-dzg-o-disaggregation-office.md` (маршрут `disaggregation/:id`) — для задач 8–9; источник
  имён — ДЗГ.
- `apps/standalone/AGENTS.md`: «Office pages», «Shifts», «Facts», «Floor pallets», «Shift exports»,
  «Shift card and printed forms», «Verification».

## Что есть сегодня (проверено по коду ветки `claude/integration`, `578906ef2`)

- **Хост, данные.**
  - Короба — `host/migrations/0010_facts.sql:65-92`: инстанты станции (`opened_at`, `closed_at`,
    `disassembled_at`), `operator_id`, `item_count_reported`, `digest_matches`, отметки проверки
    этикетки. Индексы `boxes_sscc`, `boxes_shift`. `boxes.pallet_id` и индекс `boxes_pallet`
    добавлены в `0012_pallets.sql:44-46`.
  - Состав — `box_items` (`0010_facts.sql:98-107`): одна строка на принятый скан-владелец,
    `removed_at` (инстант станции из исключения), `displaced_at` (время хоста). Индекс только у
    живых строк — `box_items_live (box_id, code_hash) WHERE removed_at IS NULL AND displaced_at IS NULL`.
  - Исключения коробов — `box_exceptions` (`0010_facts.sql:137-160`), индекс `box_exceptions_box`.
  - Паллеты — `0012_pallets.sql:13-39`: `box_count_reported` (счёт станции при закрытии) и
    индексы `pallets_sscc`, `pallets_shift`. Индекса для порядка «по закрытию поперёк смен» нет.
  - Исключения паллет — `pallet_exceptions` (`0012_pallets.sql:50-65`), индекс
    `pallet_exceptions_pallet`.
  - Инстант устройства — ровно `YYYY-MM-DDTHH:MM:SS.sssZ` (`host/src/facts/rules.rs:45-66`,
    `device_instant`), поэтому текст сравнивается как время. Время хоста — RFC 3339 без долей
    (`host/src/clock.rs`).
- **Хост, маршруты.**
  - `host/src/routes/office_boxes.rs` — `GET /v1/office/shifts/{id}/boxes` (`BOXES_SQL`, без
    оператора) и `…/pallets` (`PALLETS_SQL`: `boxes` — закрытые нерасформированные, `units` — их
    живые коды).
  - `host/src/routes/office_reports.rs` — `GET /v1/office/boxes/{id}/report-data` (полный
    `canonical` для DataMatrix «Состава короба»; это единственное офисное место хоста, кроме
    карточки кода потока, где уходит полный код) и `GET /v1/office/shifts/{id}/pallet-report-data`.
  - Маршруты — `host/src/server.rs:369-392`.
  - `OfficeContext` (`host/src/auth.rs:170`): роли `admin` и `technologist`, `require_admin`.
    `GET /v1/office/devices` — только администратору (`host/src/routes/devices.rs:160-164`).
  - `ApiError::validation` отвечает `400 validation_failed` с `details.field`
    (`host/src/error.rs:88`). `ApiQuery`/`ApiPath` — `host/src/error.rs:196-230`.
- **Протокол.**
  - `proto/src/lib.rs:20` — `PROTOCOL_VERSION = 3`.
  - `:2441` `OfficeBox`, `:2463` `OfficePallet`.
  - `:2088` `PalletExceptionKind`, `:2140` `ExceptionKind`, `:1473` `ShiftOrigin`, `:1501`
    `ShiftStatus`.
  - Причины исключений — `:157-178` (`exception_reasons`).
- **Поток «Поиск кодов»** (`claude/fb-codesearch`; хост — коммит `7ff64eab6`, офис — `9796384c6`,
  оба закоммичены 2026-10-13; миграция пока называется `0017_code_search.sql`, при слиянии станет
  `0019`):
  - `host/src/routes/office_codes.rs`. Запросы — фиксированный текст с `?1…?9`, драйвер по индексу
    критерия. `period_end` переводит миллисекунды в текст инстанта устройства (функция приватная).
    Тест `every_query_searches_by_an_index`. Чтение — `pool.begin()` и `rollback()`, без аудита.
  - `proto/src/code_search.rs`: `CodePlacementState` (`open_box | packed | removed | displaced`),
    `OfficeCodeItem` (с `box_id`, `pallet_id`), `OfficeCodeCard`.
  - Миграция `0017_code_search.sql`: `scans_ok_box ON scans (box_id) WHERE verdict = 'ok'` (все
    вложения короба, а не только живые), `scans_ok_gtin`, `scans_ok_scanned`.
  - Офис: `src/office/codes/{CodeSearchPage.tsx,CodeCard.tsx,code-query.ts}`, маршрут `codes`,
    пункт меню `/codes` «Поиск кодов» в разделе «Производство», роли `admin` и `technologist`.
    `src/host/code-search.ts` — Zod и `codeSearchPath`.
  - В `CodeCard.tsx` `boxLabel`/`palletLabel` — текст, не ссылки. `ShiftLink` ведёт на
    `/shifts/:id`. Полный текст кода (`canonical` с `<GS>` и криптохвостом) показывает только
    карточка кода.
- **Оболочка.** `src-tauri/src/host_client.rs:294-311` `validate_path`: путь только из
  `[A-Za-z0-9/_.~?=&-]`, без `%`, `..`, `//`. Значения запроса должны быть из этих символов
  (`:` инстанта не пройдёт).
- **Офис.**
  - `src/office/Office.tsx:82` — `createMemoryRouter(officeRoutes, { initialEntries: ["/"] })`, один
    на сессию. `src/office/OfficeShell.tsx:51-57` — `NavLink` без `end`: пункт «Поиск кодов» подсвечен
    на любом `/codes/...`.
  - `src/office/shifts/ShiftCardPage.tsx`:
    - `ShiftBoxes` (`:368`): SSCC короба — текст (`:401`), «Состав» открывает
      `PrintFormDialog({ kind: "box" })`;
    - `ShiftPallets` (`:522`): SSCC паллеты — текст (`:535`), «Состав» и «Ярлык» (`hasPlacard`);
    - `PackStateCell` — состояние словами, `palletCountDiffers`, `isLateBox`.
  - `src/office/shifts/shift-card.ts`: `packState` (`:14`), `palletCountDiffers` (`:57`) — «Счёт
    коробов станции другой», `ssccText` (`:81`).
  - `src/office/forms/PrintFormDialog.tsx:27` — `FormTarget` (`box`, `pallet`, `placard`,
    `placards`, `task`). Диалогу нужен `shift: OfficeShift` (номер в заголовке и папке; для паллет
    читает `getPalletReportRows(shift.id)`).
  - `src/office/exports/ExportDialog.tsx:488-525` — «XML паллеты» по каждой паллете внутри
    диалога выгрузки смены (`exportNow({ id: "pallet_xml_gismt_aggregation", version: 1 }, null, palletId)`).
  - `src/office/office-query.ts` — `officeKeys`, `useOfficeQuery`, `useOfficeMutation`. Хелпера для
    `useInfiniteQuery` нет.
  - `src/office/access.ts` — `editReference`, `editCatalog`, `planShifts`, `manageBackups`.
    Возможности «дезагрегация» нет.
  - `src/office/OfficePager.tsx` — постраничник офиса. `Pager` из `@markiro/ui` не используется:
    он под цех.
  - `DataTabs` есть в `@markiro/ui` (`packages/ui/src/components/DataTabs.tsx`): стрелки, `label`.
    В автономе ещё не используется.
- **Облако.**
  - Карточка короба показывает полный КМ с криптохвостом (`itemCodeLabel`, `rawKm`).
  - Реестр паллет: вид «производственная/складская», фильтр устройства по списку устройств, флаг
    `contentsChangedAfterClose` по серверным временам (`pallets.service.ts`).
  - Короба: `/boxes?shift=` (без смены — «Выберите смену, чтобы увидеть её короба»).

## Решения владельца

- **ПР-1 (2026-10-13):** дезагрегация только по закрытым сменам, как в облаке. Отсюда условие
  кнопки «Расформировать» (задача 9).
- **ПР-11 (2026-10-13):** «Продажа короба» не переносится. Карточка короба автонома без кнопки
  продажи и без раздела «Заказы на выдачу» (выбытия в автономе нет, §6 спецификации).
- **ПР-2 (2026-10-13):** XML «Расформирование упаковки» делает ДЗГ-О. КРТ его не касается.
- §4 спецификации: КРТ ждёт слияния «Поиска кодов», кнопка «Расформировать» — последняя задача,
  после ДЗГ-О.

## Допущения

- **Р1 — раздел под `/codes`, один пункт меню.** Вкладки — отдельные маршруты, как в облаке
  (`/codes`, `/boxes`, `/pallets`, `/codes/box/:id`, `/codes/pallet/:id`). Но все лежат под
  `/codes`:
  - `/codes` — «Коды»;
  - `/codes/boxes?shift=<id>` — «Короба»;
  - `/codes/pallets?…` — «Паллеты»;
  - `/codes/box/:id` и `/codes/pallet/:id` — карточки.

  Так `NavLink` «Поиск кодов» без `end` подсвечен на всём разделе, и меню не меняется (облако
  тоже свернуло три пункта в один).

- **Р2 — полного кода в карточке короба нет.** Облако показывает `rawKm` с криптохвостом; здесь в
  составе — `01<GTIN>21<serial>` (`codeText` потока) со ссылкой на карточку кода. Полный текст уже
  есть в карточке кода (решение потока). Полный код уходит из хоста только в `report-data` для
  DataMatrix «Состава короба» и в карточку кода — как сегодня. Хост карточек полного кода не
  отдаёт: в проводе его нет вовсе (тест).
- **Р3 — состояние вложения считает хост, состояние короба — офис.** Строка состава несёт
  `state: CodePlacementState` и `leftAt`, вычисленные так же, как `ItemRow::into_wire` потока:
  `removed` раньше `displaced`, иначе `packed`/`open_box` по закрытию короба. Это облачный порядок
  `itemState`. Состояние короба и паллеты офис выводит из инстантов (`packState`, как карточка
  смены), отдельного поля нет.
- **Р4 — реестр паллет: keyset, 100 строк, свой курсор.**
  - Порядок облака: открытые первыми, затем по закрытию от новых. Внутри равных — `id` по
    убыванию (у облака `id` по возрастанию; разница безвредна).
  - Ключ — `ifnull(closed_at, '~')`: `'~'` больше любой цифры, поэтому открытые идут первыми.
  - Курсор: `o~<id>` после открытой паллеты, `<миллисекунды>~<id>` после закрытой. Символы проходят
    `validate_path` оболочки без кодирования.
  - Миллисекунды переводятся обратно в текст инстанта устройства точно (`device_instant`
    гарантирует миллисекунды). Курсор, который не читается, — `400`, поле `cursor`.
  - Размер страницы — облачный `limit` по умолчанию, 100 (`PALLET_PAGE_SIZE`).
- **Р5 — линия паллеты — линия её смены.** Облако берёт текущую линию устройства. Автономная
  паллета принадлежит смене (`pallets.shift_id NOT NULL`), а станцию могли перевести на другую
  линию после смены. Фильтр «Линия» — `shifts.line_id`, товар — `shifts.product_id`.
- **Р6 — «Состав изменился после закрытия» = `palletCountDiffers`.** Облако сравнивает серверное
  время приёма разборки короба с серверным временем закрытия паллеты. У хоста автонома
  отдельного времени приёма закрытия паллеты нет (`pallets.received_at` — первый приход).
  Признак, который офис уже показывает в карточке смены, проще и не зависит от часов: счёт
  станции при закрытии (`box_count_reported`) против коробов, стоящих сейчас. Он ловит и короб,
  расформированный после закрытия. Текст облака «Состав изменился после закрытия» остаётся в
  реестре и карточке паллеты. Карточка смены сохраняет свой «Счёт коробов станции другой».
- **Р7 — список станций для фильтра — в ответе реестра.** `GET /v1/office/devices` только для
  администратора, а реестр читают обе роли. Страница несёт `stations: [{ id, name, revoked }]` —
  все устройства вида `station`, по имени. Таблица маленькая, один запрос.
- **Р8 — без вида паллеты.** Складских паллет у автонома нет: паллеты ТСД — этап 7. Столбца и
  фильтра «Вид» нет. Когда появятся складские паллеты, добавятся оба (вопрос КРТ-3).
- **Р9 — вкладка «Короба» = выбор смены поверх существующего маршрута.**
  - Смена обязательна, как в облаке; список — существующий `GET /v1/office/shifts/{id}/boxes`.
  - В выборе — смены по умолчанию из `GET /v1/office/shifts` (запланированные, активные, закрытые
    за 31 день), без запланированных и без смен проверки (`mode = validation`, у них нет коробов —
    план РЕЖ).
  - Смена из адреса, которой нет в списке (старая, открытая ссылкой), читается `getShift` и
    добавляется в выбор.
  - `OfficeBox` получает `operatorName` (П-14: «нет столбцов линия и оператор»). Линия одна на
    смену и показывается над таблицей.
- **Р10 — документы ДЗГ — поле с первого дня.** `OfficeBoxCard.documents` и
  `OfficePalletCard.documents` объявлены в задаче 1 с `#[serde(default)]` и до задачи 8 всегда
  `[]`. Поля — имена ДЗГ (`DisaggregationDocument`: `docNo`, `appliedAt`, `reasonName`,
  `appliedByName`). Раздел «Документы дезагрегации» офис показывает, только когда список не пуст.
  Карточка полностью работает до слияния ДЗГ; задача 8 добавляет только запросы и тесты.
  Проведение ДЗГ не пишет `box_exceptions`/`pallet_exceptions` (Р1 ДЗГ): действие офиса — сама
  строка проведённого документа. Карточка читает обе стороны в одном снимке и показывает их
  двумя разделами — это и есть правило ДЗГ «читатели объединяют исключения станции и строки
  проведённых документов».
- **Р11 — «Расформировать» создаёт черновик со строкой и открывает документ.** Облако создаёт
  пустой черновик и передаёт SSCC страницы в `?sscc=` (`PalletCard.tsx`, `startDisassembly`).
  Страница документа ДЗГ-О `?sscc=` не читает, а ДЗГ позволяет создать черновик без причины:
  `DisaggregationCreate { reasonId?, comment? }`, причина обязательна только у проведённого
  (`CHECK (status <> 'applied' OR reason_id IS NOT NULL)`). Поэтому кнопка делает два вызова
  ДЗГ:
  - `createDisaggregation(token, { reasonId: null, comment: null })`;
  - `addDisaggregationLines(token, id, { lines: [{ input: sscc, sscc }], import: false })`.

  Затем она переходит на `/disaggregation/:id`. Там строка уже проверена хостом, а причину
  выбирает пользователь. Страница ДЗГ-О не меняется. Кнопка видна, если выполнены все условия:
  - у роли есть `useCan("planShifts")` — это администратор и технолог, как
    `auth::disaggregates` ДЗГ (Р10 ДЗГ) и кнопка «Создать документ» ДЗГ-О;
  - короб или паллета закрыты, не расформированы и с SSCC;
  - смена закрыта (ПР-1; иначе строка получила бы `shift_open`).

  При активной смене вместо кнопки — тихая строка «Расформировать можно после закрытия смены».

- **Р12 — печать и XML те же, что в карточке смены.** Карточка читает смену (`getShift`) и
  открывает `PrintFormDialog` с целью `box`/`pallet`/`placard`. Бумага ярлыка (A4/A5) хранится в
  состоянии карточки, как в карточке смены. XML паллеты — `ExportDialog` с новым необязательным
  `palletId`: диалог показывает только эту паллету и её кнопку «XML паллеты», без форматов смены.
- **Р13 — память вкладок — в layout-маршруте раздела, не в `sessionStorage`.** У офиса
  memory-router на сессию, и ничто не переживает сессию (`office-query.ts`). `CodesSection`
  хранит последний `?…` каждой вкладки в `Map` своего состояния. Карточки возвращаются
  `navigate(-1)`; без истории (`location.key === "default"`) — на последнюю вкладку.
- **Р14 — протокол устройства не растёт.** Только офисные маршруты чтения: правило
  `proto/src/lib.rs:16-19` подъёма не требует. Резерв КРТ не заведён.
- **Р15 — чтение без аудита, все офисные роли.** Как поиск кодов и списки смены. Ключ устройства
  без сессии, чужая сессия, выдуманная сессия — `401`, и тело отказа не несёт данных короба (тест).
  Запрета роли в КРТ нет: «Расформировать» доступна обеим ролям, как документы ДЗГ (Р11).
- **Р16 — предохранитель `scans_ok_box` в `0025`.** План РЕЖ (`0020_validation_scans.sql`)
  перестраивает `scans` и пересоздаёт индексы поиска кодов под старым именем: в его таблице
  указан `box_items_box`, а пересоздаются только `scans_ok_gtin` и `scans_ok_scanned`. Поток
  «Поиск кодов» переименовал индекс в `scans_ok_box ON scans (box_id) WHERE verdict = 'ok'`, и
  `DROP TABLE scans` в `0020` его уронит. Карточка короба читает состав через этот индекс. `0025`
  идёт после `0020` (правило индексов на `scans` соблюдено) и делает
  `CREATE INDEX IF NOT EXISTS scans_ok_box …`. Если РЕЖ поправит свой список, это ничего не
  делает. Конфликт передаётся контроллеру (раздел «Риски»).
- **Р17 — пределы строк карточки.** Состав и короба паллеты читаются до `CARD_ROW_LIMIT = 10 000`
  строк; больше — `itemsCapped`/`membersCapped` и строка в офисе «Показаны первые 10 000».
  Реальный короб — десятки строк, паллета — до сотни коробов.

## Global Constraints

**Правила продукта**

- Только чтение: маршруты КРТ не пишут ни строки, ни аудита. Тест сверяет `fact_rows`,
  `audit_rows` и счётчики `pallets`, `pallet_exceptions` до и после.
- Полный код (`canonical` с `\u001d` и криптохвостом) в ответы КРТ не входит (Р2).
- Инстанты станции и хоста показываются в зоне организации (`formTimeZone`), как в карточке
  смены и поиске кодов.
- Запросы работают при `code_owners.box_id = NULL` и при сканах `ok` без короба (смены проверки
  РЕЖ). КРТ не читает `code_owners`; состав короба идёт по `scans.box_id = ?`, поэтому скан без
  короба в него не попадает. Смены проверки в выборе вкладки «Короба» не показываются.
- Офлайн цеха не затронут: станция и её очередь не меняются.
- **Ссылки других планов на карточки КРТ.** После слияния КРТ:
  - КНФ `conflict-list.ts::loserBoxLink` ведёт на `/codes/box/${scan.boxId}`, когда `boxId`
    есть. Без короба (смена проверки) — на карточку смены `/shifts/${scan.shiftId}`, как сегодня.
    Временную ссылку КНФ `/shifts/{shiftId}?box={sscc}` (Р7 КНФ) это заменяет. Правку делает тот
    план, что вливается вторым; если КНФ уже влит — задача 6 КРТ (одна строка и её тест в
    `test/conflict-list.test.ts`).
  - Строки документа ДЗГ-О ссылаются на `/codes/box/:id` и `/codes/pallet/:id`
    (`DisaggregationLine.boxId`/`palletId`).

**Миграции и протокол (распределение 2026-10-13)**

- Миграции хоста, уже занятые открытыми ветками: `0017` сотрудники (fb-people), `0018` умолчания
  листов A4 (fb-templates), `0019` поиск кодов (fb-codesearch), `0020`–`0021` режимы смены (РЕЖ).
  Миграции оболочки: `0014`–`0015` (РЕЖ). В базе применены: хост `0001`–`0012`, `0015`, `0016`;
  оболочка `0001`–`0010`, `0012`, `0013`.
- Распределение волны 1 паритета: КНФ — хост `0022`, оболочка `0016`; ТОВ — хост `0023`; ДЗГ —
  хост `0024`, оболочка `0017`; ДЗГ-О — нет; КРТ — хост `0025`; ИСТ — хост `0026`.
  Неиспользованный номер остаётся пропуском. Перед задачей миграции исполнитель заново смотрит
  `ls apps/standalone/{host,src-tauri}/migrations` в `claude/integration` и открытых ветках
  `claude/fb-*`; если номер занят — берёт следующий свободный и пишет это в «Отклонения».
- Индексы на `scans` / `code_owners` — только миграциями после `0020`: РЕЖ (часть A) перестраивает
  обе таблицы и пересоздаёт только свои индексы и индексы поиска кодов. Запросы работают при
  `code_owners.box_id` = NULL (смены проверки).
- Протокол устройства: в базе `PROTOCOL_VERSION = 3`, РЕЖ берёт 4 и 5. Резерв на случай подъёма по
  правилу `proto/src/lib.rs:16-19` (новый вид факта или новое поле `data` факта; ответы терпят
  неизвестные поля): КНФ 6, ТОВ 7, ДЗГ 8, ИСТ 9. Без нужды не поднимать; при слиянии константа
  берёт наибольший номер. **КРТ версию не поднимает** (Р14). Миграция оболочки КРТ не нужна.

**Код и процесс**

- TypeScript strict: без `any`, приведений и `!`; именованные экспорты, `import type`.
- Офис — только `@markiro/ui`; мышь и клавиатура (строка таблицы открывается Enter/пробелом —
  `Table.onRowClick` это умеет), видимый фокус, состояние словами, не только цветом.
- Строки — только `src/i18n/ru.json` (английского файла в `apps/standalone` нет — проверить
  `ls apps/standalone/src/i18n`). Переменные текстов именованные (`{{number}}`, не `{{count}}`).
- Формы на проводе — фикстуры `proto/fixtures`, их читают Rust (`proto/tests/pack_cards.rs`) и
  Vitest (`test/pack-cards-protocol.test.ts`).
- Rust: `cargo fmt` чистый, без предупреждений. `Cargo.toml`, `Cargo.lock`, `package.json`,
  `pnpm-lock.yaml` не меняются. `apps/api`, `apps/admin`, `apps/station`, `packages/*` не меняются
  (облако — только образец).
- Новые миграции — только новыми файлами. Никогда `git stash`. Коммиты с явными путями, трейлер
  одной строкой `Co-Authored-By: …`. Push и PR — не в этом плане.
- Облачный паритет — эталоны названы в каждой задаче. Набор состояний состава и видов исключений
  совпадает с облачным `GET /code-search/boxes/:id` (§5.3 спецификации).

## Заметки для исполнения

- Worktree от `claude/integration` **после слияния «Поиска кодов»** (`claude/fb-codesearch`).
  Задача 1, шаг 0 это проверяет. Зависимости — клоны APFS из `/tmp/claude/wt/integ`:
  `cp -c -R -P` для `node_modules`, `apps/standalone/node_modules`, `packages/*/node_modules`,
  `packages/*/dist`; для cargo — ещё `apps/standalone/target`.
- Команды (`<wt>` — абсолютный путь worktree):
  - Vitest: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run <файлы>`;
  - пакет: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
    (а также `typecheck`, `lint`);
  - Rust: `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test -p markiro-host --test office_cards`
    (крейты `markiro-host`, `markiro-proto`, `markiro-standalone` — проверено по `Cargo.toml`);
    `cargo fmt --manifest-path <wt>/apps/standalone/Cargo.toml --all -- --check`;
  - prettier: `<wt>/node_modules/.bin/prettier --check <тронутые файлы>`; `git -C <wt> diff --check`.
- Тесты хоста на `TestApp` сокета не открывают, песочница им не мешает. Крейт оболочки КРТ не
  трогает: `cargo test -p markiro-standalone` нужен только в итоговом прогоне, перед ним —
  `pnpm … --filter @markiro/standalone build`.
- React-тесты страниц (задачи 5, 6, 9) прогоняются дважды: один раз с `--reporter=verbose` без
  `stderr |`, второй раз под стендом с задержкой `setImmediate` на 3 мс. Стенд — временные
  `test/delayed-immediate.setup.ts` и `vitest.delay.config.ts`, как в плане СКЛ; после прогона
  удалить.
- `pnpm install`/`add` не запускать. Если обёртка `rtk` урезала вывод — `rtk proxy <команда>`.

## Файлы

- **Создать:**
  - `apps/standalone/proto/src/pack_cards.rs`, `apps/standalone/proto/tests/pack_cards.rs`;
  - `apps/standalone/proto/fixtures/{office-box-card,office-pallet-card,office-pallet-page}.json`;
  - `apps/standalone/host/migrations/0025_pallet_list.sql`;
  - `apps/standalone/host/src/routes/{office_cards,office_pallets}.rs`;
  - `apps/standalone/host/tests/{office_cards,office_pallets}.rs`;
  - `apps/standalone/src/host/pack-cards.ts`;
  - `apps/standalone/src/office/codes/{CodesSection,RegistryTabs,BoxesTab,PalletsTab,BoxCardPage,PalletCardPage,PackLinks}.tsx`,
    `apps/standalone/src/office/codes/pallet-query.ts`, `apps/standalone/src/office/codes/disassemble.ts`
    (задача 9);
  - `apps/standalone/test/{pack-cards-protocol,pallet-query}.test.ts`,
    `apps/standalone/test/{registry-tabs,boxes-tab,pallets-tab,box-card-page,pallet-card-page}.test.tsx`.
- **Изменить:**
  - `proto/src/lib.rs` (`pub mod pack_cards;`, `OfficeBox.operator_name`), `proto/fixtures/office-boxes.json`,
    `proto/tests/fixtures.rs`;
  - `host/src/routes/{mod.rs,office_boxes.rs,office_codes.rs}` (`period_end` → `pub(crate)`),
    `host/src/server.rs`, `host/tests/office_boxes.rs`;
  - `src/host/{api.ts,protocol.ts}`; `src/office/{routes.tsx,office-query.ts}`;
  - `src/office/codes/{CodeSearchPage.tsx,CodeCard.tsx,code-query.ts}` (файлы потока «Поиск кодов»);
  - `src/office/shifts/ShiftCardPage.tsx`, `src/office/exports/ExportDialog.tsx`;
  - `src/i18n/ru.json`; `test/support/office.tsx`;
  - тесты `test/{protocol,api,office-query,shift-card,export-dialog,code-search-page}.test.ts(x)`;
  - `apps/standalone/AGENTS.md`; спецификация паритета (§5.3, §8.1 — отметка об исполнении).

---

## Задача 1: протокол и Zod — карточки короба и паллеты, страница реестра, оператор короба

**Files:** Create `apps/standalone/proto/src/pack_cards.rs`,
`apps/standalone/proto/tests/pack_cards.rs`, фикстуры `office-box-card.json`,
`office-pallet-card.json`, `office-pallet-page.json`, `apps/standalone/src/host/pack-cards.ts`,
`apps/standalone/test/pack-cards-protocol.test.ts`; Modify `proto/src/lib.rs`,
`proto/fixtures/office-boxes.json`, `src/host/protocol.ts`, `src/host/api.ts`,
`test/support/office.tsx`.

**Interfaces (Rust, `proto/src/pack_cards.rs`):**

```rust
//! A box's and a pallet's cards and the list of every pallet of the site in
//! the office (plan КРТ, parity spec §5.3, the cloud's `GET
//! /code-search/boxes/:id`, `…/pallets/:id` and `GET /pallets`). Read only;
//! no full code travels here (a code is its GTIN and serial; its full text
//! is the code card's, `code_search`). `proto/fixtures/office-box-card.json`,
//! `office-pallet-card.json` and `office-pallet-page.json` hold the shapes
//! both sides read.

use serde::{Deserialize, Serialize};

use crate::code_search::CodePlacementState;
use crate::{ExceptionKind, PalletExceptionKind, ShiftStatus};

/// The most rows of one kind a card reads (`itemsCapped`, `membersCapped`).
pub const CARD_ROW_LIMIT: u32 = 10_000;
/// The rows of one page of the pallet list, the cloud's default `limit`.
pub const PALLET_PAGE_SIZE: u32 = 100;

/// The shift a box or a pallet belongs to, its product and line now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePackShift {
    pub id: String,
    pub number: String,
    pub status: ShiftStatus,
    pub production_date: String,
    pub product_name: String,
    pub line_name: String,
}

/// The pallet a box joined when it closed; the link stays when either is
/// taken apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePackPallet {
    pub id: String,
    pub sscc: Option<String>,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
}

/// One item of a box: the accepted scan that put its code there, where it
/// stands now (`removed` before `displaced`, as the cloud's `itemState`) and
/// when it left (`removed` the station's instant, `displaced` the host's).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeBoxItem {
    pub scan_id: String,
    pub code_hash: String,
    pub gtin14: String,
    pub serial: String,
    pub added_at: String,
    pub state: CodePlacementState,
    pub left_at: Option<String>,
    pub operator_name: Option<String>,
}

/// A station's exception of the box, oldest first: `codeHash` only for an
/// `undo`, a reason code only for `reprint` and `disassemble`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeBoxException {
    pub id: String,
    pub kind: ExceptionKind,
    pub code_hash: Option<String>,
    pub reason_code: Option<String>,
    pub reason_text: Option<String>,
    pub occurred_at: String,
    pub received_at: String,
    pub device_name: String,
    pub operator_name: Option<String>,
}

/// An applied disaggregation document that took the box or the pallet apart
/// (plan ДЗГ), named as `disaggregation::DisaggregationDocument` names it.
/// Empty until plan ДЗГ's tables exist (plan КРТ, task 8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePackDocument {
    pub id: String,
    /// `DSG-YY-NNNN`.
    pub doc_no: String,
    /// The host's instant of the apply.
    pub applied_at: String,
    pub reason_name: Option<String>,
    pub applied_by_name: Option<String>,
}

/// `GET /v1/office/boxes/{id}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeBoxCard {
    pub id: String,
    pub sscc: Option<String>,
    pub shift: OfficePackShift,
    pub device_id: String,
    pub device_name: String,
    pub operator_name: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    /// Live items now (neither taken out nor taken elsewhere).
    pub units: u32,
    pub item_count_reported: Option<u32>,
    pub digest_matches: Option<bool>,
    pub print_verified_at: Option<String>,
    pub print_skipped_at: Option<String>,
    pub pallet: Option<OfficePackPallet>,
    /// Every item the box ever had, newest first.
    pub items: Vec<OfficeBoxItem>,
    pub items_capped: bool,
    pub exceptions: Vec<OfficeBoxException>,
    #[serde(default)]
    pub documents: Vec<OfficePackDocument>,
}

/// A box that joined the pallet, taken apart or not, closed newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletBox {
    pub id: String,
    pub sscc: Option<String>,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub units: u32,
}

/// A station's exception of the pallet, oldest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletException {
    pub id: String,
    pub kind: PalletExceptionKind,
    pub reason_code: String,
    pub reason_text: Option<String>,
    pub occurred_at: String,
    pub received_at: String,
    pub device_name: String,
    pub operator_name: Option<String>,
}

/// `GET /v1/office/pallets/{id}`: `boxes` and `units` as `OfficePallet`
/// derives them (closed boxes not taken apart, their live items).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletCard {
    pub id: String,
    pub sscc: Option<String>,
    pub shift: OfficePackShift,
    pub device_id: String,
    pub device_name: String,
    pub operator_name: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub boxes: u32,
    pub units: u64,
    pub box_count_reported: Option<u32>,
    pub print_verified_at: Option<String>,
    pub print_skipped_at: Option<String>,
    pub members: Vec<OfficePalletBox>,
    pub members_capped: bool,
    pub exceptions: Vec<OfficePalletException>,
    #[serde(default)]
    pub documents: Vec<OfficePackDocument>,
}

/// One row of `GET /v1/office/pallets`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletRow {
    pub id: String,
    pub sscc: Option<String>,
    pub shift_id: String,
    pub shift_number: String,
    pub production_date: String,
    pub product_id: String,
    pub product_name: String,
    pub line_id: String,
    pub line_name: String,
    pub device_id: String,
    pub device_name: String,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub boxes: u32,
    pub units: u64,
    pub box_count_reported: Option<u32>,
}

/// A station the list can be narrowed to (`GET /v1/office/devices` is the
/// administrator's; the list is every office role's).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletStation {
    pub id: String,
    pub name: String,
    pub revoked: bool,
}

/// One page of the list: open pallets first, then closed newest first;
/// `nextCursor` continues below the last row, `null` on the last page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletPage {
    pub items: Vec<OfficePalletRow>,
    pub next_cursor: Option<String>,
    pub stations: Vec<OfficePalletStation>,
}
```

`OfficeBox` (`proto/src/lib.rs:2441`) после `operator_id`-подобных полей получает:

```rust
/// The operator who closed the box (plan КРТ, П-14), `null` without one.
#[serde(default)]
pub operator_name: Option<String>,
```

**Interfaces (TS, `src/host/pack-cards.ts`):**

```ts
import { z } from "zod";

import { CODE_PLACEMENT_STATES } from "./code-search.js";
import { shiftStatusSchema } from "./protocol.js";

// Plan КРТ: mirrors `markiro_proto::pack_cards`. Lenient like the Rust
// response types (a field a newer host adds is tolerated).

export const CARD_ROW_LIMIT = 10_000;
export const PALLET_PAGE_SIZE = 100;

const instant = z.iso.datetime();
const codeHash = z.string().regex(/^[0-9a-f]{64}$/);
const sscc = z.string().regex(/^[0-9]{18}$/);

export const officePackShiftSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: shiftStatusSchema,
  productionDate: z.string(),
  productName: z.string(),
  lineName: z.string(),
});
export const officePackPalletSchema = z.object({
  id: z.string(),
  sscc: sscc.nullable(),
  closedAt: instant.nullable(),
  disassembledAt: instant.nullable(),
});
export const officeBoxItemSchema = z.object({
  scanId: z.string(),
  codeHash,
  gtin14: z.string(),
  serial: z.string(),
  addedAt: instant,
  state: z.enum(CODE_PLACEMENT_STATES),
  leftAt: instant.nullable(),
  operatorName: z.string().nullable(),
});
export const officeBoxExceptionSchema = z.object({
  id: z.string(),
  kind: z.enum(["undo", "clear", "reprint", "disassemble"]),
  codeHash: codeHash.nullable(),
  reasonCode: z.string().nullable(),
  reasonText: z.string().nullable(),
  occurredAt: instant,
  receivedAt: instant,
  deviceName: z.string(),
  operatorName: z.string().nullable(),
});
export const officePackDocumentSchema = z.object({
  id: z.string(),
  docNo: z.string(),
  appliedAt: instant,
  reasonName: z.string().nullable(),
  appliedByName: z.string().nullable(),
});
/** What a box, a pallet and a row of the list share. */
const pack = {
  id: z.string(),
  sscc: sscc.nullable(),
  deviceId: z.string(),
  deviceName: z.string(),
  openedAt: instant,
  closedAt: instant.nullable(),
  disassembledAt: instant.nullable(),
};
const count = z.number().int().nonnegative();
const labelCheck = { printVerifiedAt: instant.nullable(), printSkippedAt: instant.nullable() };
const documents = z.array(officePackDocumentSchema).default([]);

export const officeBoxCardSchema = z.object({
  ...pack,
  ...labelCheck,
  shift: officePackShiftSchema,
  operatorName: z.string().nullable(),
  units: count,
  itemCountReported: count.nullable(),
  digestMatches: z.boolean().nullable(),
  pallet: officePackPalletSchema.nullable(),
  items: z.array(officeBoxItemSchema),
  itemsCapped: z.boolean(),
  exceptions: z.array(officeBoxExceptionSchema),
  documents,
});
export const officePalletBoxSchema = z.object({
  id: z.string(),
  sscc: sscc.nullable(),
  closedAt: instant.nullable(),
  disassembledAt: instant.nullable(),
  units: count,
});
export const officePalletExceptionSchema = z.object({
  id: z.string(),
  kind: z.enum(["reprint", "disassemble"]),
  reasonCode: z.string(),
  reasonText: z.string().nullable(),
  occurredAt: instant,
  receivedAt: instant,
  deviceName: z.string(),
  operatorName: z.string().nullable(),
});
const standing = {
  boxes: count,
  units: count,
  boxCountReported: z.number().int().positive().nullable(),
};
export const officePalletCardSchema = z.object({
  ...pack,
  ...labelCheck,
  ...standing,
  shift: officePackShiftSchema,
  operatorName: z.string().nullable(),
  members: z.array(officePalletBoxSchema),
  membersCapped: z.boolean(),
  exceptions: z.array(officePalletExceptionSchema),
  documents,
});
export const officePalletRowSchema = z.object({
  ...pack,
  ...standing,
  shiftId: z.string(),
  shiftNumber: z.string(),
  productionDate: z.string(),
  productId: z.string(),
  productName: z.string(),
  lineId: z.string(),
  lineName: z.string(),
});
export const officePalletPageSchema = z.object({
  items: z.array(officePalletRowSchema),
  nextCursor: z.string().nullable(),
  stations: z.array(z.object({ id: z.string(), name: z.string(), revoked: z.boolean() })),
});
export type OfficeBoxCard = z.infer<typeof officeBoxCardSchema>;
export type OfficeBoxItem = z.infer<typeof officeBoxItemSchema>;
export type OfficeBoxException = z.infer<typeof officeBoxExceptionSchema>;
export type OfficePalletCard = z.infer<typeof officePalletCardSchema>;
export type OfficePalletBox = z.infer<typeof officePalletBoxSchema>;
export type OfficePalletException = z.infer<typeof officePalletExceptionSchema>;
export type OfficePalletRow = z.infer<typeof officePalletRowSchema>;
export type OfficePalletPage = z.infer<typeof officePalletPageSchema>;
export type OfficePackDocument = z.infer<typeof officePackDocumentSchema>;

/** What `GET /v1/office/pallets` asks; every value is the shell's plain URL characters. */
export interface PalletListQuery {
  product?: string;
  line?: string;
  device?: string;
  fromMs?: number;
  toMs?: number;
  sscc?: string;
}

const PALLET_PARAMS = ["product", "line", "device", "fromMs", "toMs", "sscc"] as const;

/**
 * The path of one page of the list: the parameters in a fixed order (one
 * cache key per query), the cursor last. A value the shell's path check
 * would refuse is refused here first.
 */
export function palletListPath(query: PalletListQuery, cursor: string | null): string {
  const parts: string[] = [];
  for (const name of PALLET_PARAMS) {
    const value = query[name];
    if (value === undefined) continue;
    const text = String(value);
    if (!/^[0-9a-z-]+$/.test(text)) throw new RangeError(`not a list value: ${name}`);
    parts.push(`${name}=${text}`);
  }
  if (cursor !== null) {
    if (!/^(o|[0-9]{1,15})~[0-9a-f-]{36}$/.test(cursor)) throw new RangeError("not a cursor");
    parts.push(`cursor=${cursor}`);
  }
  return parts.length === 0 ? "/v1/office/pallets" : `/v1/office/pallets?${parts.join("&")}`;
}

/** A box's or a pallet's id as the host writes it: a lower-case hyphenated UUID. */
export function isPackId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}
```

`HostApi` (`src/host/api.ts`) — три метода по образцу `searchCodes`/`getCodeCard`:

```ts
/** A box's card (plan КРТ); `not_found` for a box the host never saw. Every office role. */
getBoxCard: (token: string, id: string) => Promise<OfficeBoxCard>;
/** A pallet's card (plan КРТ). */
getPalletCard: (token: string, id: string) => Promise<OfficePalletCard>;
/** One page of every pallet of the site (plan КРТ); `cursor` from the previous page. */
listPallets: (token: string, query: PalletListQuery, cursor: string | null) =>
  Promise<OfficePalletPage>;
```

Реализация: `getBoxCard`/`getPalletCard` отвергают id, который не `isPackId`, с `RangeError`
до запроса, как `getCodeCard`. Пути — `/v1/office/boxes/${id}`, `/v1/office/pallets/${id}`,
`palletListPath(query, cursor)`. `officeBoxSchema` (`src/host/protocol.ts:736`) получает
`operatorName: z.string().nullable().optional()`: необязательное, чтобы не менять существующие
объекты тестов карточки смены.

- [ ] **Шаг 0: стык с «Поиском кодов».**
  - `git -C <wt> log --oneline claude/integration -- apps/standalone/host/src/routes/office_codes.rs apps/standalone/src/office/codes/CodeSearchPage.tsx`
    должен показать коммиты потока.
  - `ls <wt>/apps/standalone/host/migrations | grep code_search` должен показать `0019_code_search.sql`.
  - Если поток не влит — остановиться и сообщить контроллеру.
  - Если имена отличаются от записанных в «Что есть сегодня», записать фактические в «Отклонения»
    и дальше пользоваться ими: маршрут офиса, `CodeSearchPage`, `CodeCard`, `codeText`,
    `PlacementChip`, `instantFormat`, `CODE_PLACEMENT_STATES`, `period_end`, индекс `scans_ok_box`.
- [ ] **Шаг 1: фикстуры (сначала: красные тесты читают их).**

  `office-box-card.json` — короб 1 паллеты 1. Две живые строки, одна строка `removed` (отмена),
  одна `displaced`, два исключения, документов нет:

  ```json
  {
    "id": "b0000000-0000-4000-8000-000000000001",
    "sscc": "046006820000015000",
    "shift": {
      "id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      "number": "OCT26-003",
      "status": "closed",
      "productionDate": "2026-10-08",
      "productName": "Молоко 3,2% 0,9 л",
      "lineName": "Линия 1"
    },
    "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "deviceName": "Станция на линии 1",
    "operatorName": "Анна Кузнецова",
    "openedAt": "2026-10-08T06:00:10.000Z",
    "closedAt": "2026-10-08T06:00:20.000Z",
    "disassembledAt": null,
    "units": 1,
    "itemCountReported": 2,
    "digestMatches": true,
    "printVerifiedAt": "2026-10-08T06:00:22.000Z",
    "printSkippedAt": null,
    "pallet": {
      "id": "a0000000-0000-4000-8000-000000000001",
      "sscc": "146006820000000402",
      "closedAt": "2026-10-08T06:00:41.000Z",
      "disassembledAt": null
    },
    "items": [
      {
        "scanId": "5d1e2f3a-4b5c-4d6e-8f70-81920a1b2c3d",
        "codeHash": "0000000000000000000000000000000000000000000000000000000000000003",
        "gtin14": "04600682000013",
        "serial": "S000003",
        "addedAt": "2026-10-08T06:00:12.000Z",
        "state": "removed",
        "leftAt": "2026-10-08T06:00:13.000Z",
        "operatorName": null
      },
      {
        "scanId": "4c0d1e2f-3a4b-4c5d-9e6f-708192a3b4c5",
        "codeHash": "0000000000000000000000000000000000000000000000000000000000000002",
        "gtin14": "04600682000013",
        "serial": "S000002",
        "addedAt": "2026-10-08T06:00:11.000Z",
        "state": "displaced",
        "leftAt": "2026-10-25T09:00:00Z",
        "operatorName": "Анна Кузнецова"
      },
      {
        "scanId": "3b9c0d1e-2f3a-4b4c-8d5e-6f708192a3b4",
        "codeHash": "0000000000000000000000000000000000000000000000000000000000000001",
        "gtin14": "04600682000013",
        "serial": "S000001",
        "addedAt": "2026-10-08T06:00:10.000Z",
        "state": "packed",
        "leftAt": null,
        "operatorName": null
      }
    ],
    "itemsCapped": false,
    "exceptions": [
      {
        "id": "e1000000-0000-4000-8000-000000000001",
        "kind": "undo",
        "codeHash": "0000000000000000000000000000000000000000000000000000000000000003",
        "reasonCode": null,
        "reasonText": null,
        "occurredAt": "2026-10-08T06:00:13.000Z",
        "receivedAt": "2026-10-08T06:01:00Z",
        "deviceName": "Станция на линии 1",
        "operatorName": null
      },
      {
        "id": "e1000000-0000-4000-8000-000000000002",
        "kind": "reprint",
        "codeHash": null,
        "reasonCode": "other",
        "reasonText": "Смазалась при укладке",
        "occurredAt": "2026-10-08T06:00:25.000Z",
        "receivedAt": "2026-10-08T06:01:00Z",
        "deviceName": "Станция на линии 1",
        "operatorName": "Анна Кузнецова"
      }
    ],
    "documents": []
  }
  ```

  `office-pallet-card.json`: паллета 1, станция насчитала 2 короба, стоят 1 (короб 2 расформирован
  после закрытия), одна перепечатка. `office-pallet-page.json`: три строки (открытая паллета
  3 первой, затем 1 и 2 по закрытию), `nextCursor`
  `"1791874809000~a0000000-0000-4000-8000-000000000002"` (миллисекунды `2026-10-08T06:00:09.000Z`
  посчитать командой
  `node -e 'console.log(Date.parse("2026-10-08T06:00:09.000Z"))'` и вписать), `stations` — две
  станции, одна отозвана. `office-boxes.json` — у первого короба `"operatorName": "Анна Кузнецова"`,
  у второго `null`.

- [ ] **Шаг 2: красные тесты.**

  Rust (`proto/tests/pack_cards.rs`; помощники `fixture`/`round_trip` — копия из
  `proto/tests/code_search.rs`):

  ```rust
  use markiro_proto::code_search::CodePlacementState;
  use markiro_proto::pack_cards::{
      OfficeBoxCard, OfficePalletCard, OfficePalletPage, CARD_ROW_LIMIT, PALLET_PAGE_SIZE,
  };
  use markiro_proto::{ExceptionKind, OfficeBox, PalletExceptionKind};

  #[test]
  fn a_box_card_round_trips_with_every_state_of_an_item_and_no_full_code() {
      let card: OfficeBoxCard = round_trip("office-box-card.json");
      let states: Vec<CodePlacementState> = card.items.iter().map(|item| item.state).collect();
      assert_eq!(
          states,
          [CodePlacementState::Removed, CodePlacementState::Displaced, CodePlacementState::Packed]
      );
      assert_eq!(card.exceptions[0].kind, ExceptionKind::Undo);
      // No full code on this wire: no group separator, no crypto tail.
      let text = fixture("office-box-card.json").to_string();
      assert!(!text.contains("\\u001d") && !text.contains("canonical"), "{text}");
  }

  #[test]
  fn a_card_of_a_host_before_plan_dzg_reads_without_documents() {
      let mut card = fixture("office-box-card.json");
      card.as_object_mut().unwrap().remove("documents");
      let card: OfficeBoxCard = serde_json::from_value(card).unwrap();
      assert!(card.documents.is_empty());
  }

  #[test]
  fn a_pallet_card_and_a_page_round_trip() {
      let card: OfficePalletCard = round_trip("office-pallet-card.json");
      assert_eq!((card.boxes, card.box_count_reported), (1, Some(2)));
      assert_eq!(card.members.len(), 2, "a box taken apart stays on the list");
      assert_eq!(card.exceptions[0].kind, PalletExceptionKind::Reprint);
      let page: OfficePalletPage = round_trip("office-pallet-page.json");
      assert_eq!(page.items[0].closed_at, None, "open pallets come first");
      assert_eq!((CARD_ROW_LIMIT, PALLET_PAGE_SIZE), (10_000, 100));
  }

  #[test]
  fn a_box_of_a_host_before_plan_krt_reads_without_its_operator() {
      let mut boxes = fixture("office-boxes.json");
      boxes[0].as_object_mut().unwrap().remove("operatorName");
      let boxes: Vec<OfficeBox> = serde_json::from_value(boxes).unwrap();
      assert_eq!(boxes[0].operator_name, None);
  }
  ```

  Существующий тест фикстуры `office-boxes.json` (`proto/tests/fixtures.rs`, найти
  `rtk proxy grep -n "office-boxes" apps/standalone/proto/tests/fixtures.rs`) остаётся
  круговым и должен пройти с новым полем.

  Vitest (`test/pack-cards-protocol.test.ts`, по образцу `test/code-search-protocol.test.ts`):

  ```ts
  it("parses both cards and a page without losing a field", () => {
    expect(officeBoxCardSchema.parse(BOX)).toEqual(BOX);
    expect(officePalletCardSchema.parse(PALLET)).toEqual(PALLET);
    expect(officePalletPageSchema.parse(PAGE)).toEqual(PAGE);
  });
  it("reads a card without documents as one with none", () => {
    const { documents: _, ...older } = BOX;
    expect(officeBoxCardSchema.parse(older).documents).toEqual([]);
  });
  it.each([
    ["an item state the host does not write", { items: [{ ...ITEM, state: "lost" }] }],
    ["a pallet exception kind it does not know", { exceptions: [{ ...EXC, kind: "undo" }] }],
    ["an SSCC of 17 digits", { sscc: "04600682000001500" }],
  ])("refuses a card with %s", …);
  it("writes the list's path in a fixed order with the cursor last", () => {
    expect(
      palletListPath({ sscc: "146006820000000402", product: "6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f", fromMs: 1 }, "o~a0000000-0000-4000-8000-000000000003"),
    ).toBe(
      "/v1/office/pallets?product=6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f&fromMs=1&sscc=146006820000000402&cursor=o~a0000000-0000-4000-8000-000000000003",
    );
    expect(palletListPath({}, null)).toBe("/v1/office/pallets");
  });
  it("refuses a value or a cursor the shell would refuse", () => {
    expect(() => palletListPath({ product: "x y" }, null)).toThrow(RangeError);
    expect(() => palletListPath({}, "2026-10-08T06:00:09Z~a")).toThrow(RangeError);
  });
  it("asks for no card of something that is no id", async () => {
    const { api, sent } = recording(BOX);
    await expect(api.getBoxCard("token", "../users")).rejects.toThrow(RangeError);
    expect(sent).toEqual([]);
  });
  ```

  Плюс тест `HostApi`: три метода шлют `GET` с `officeToken` на свои пути и разбирают ответ схемой
  (помощник `recording` — копия из `code-search-protocol.test.ts`).

  Прогон (должен упасть):
  - `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test -p markiro-proto`;
  - `pnpm … --filter @markiro/standalone exec vitest run test/pack-cards-protocol.test.ts test/protocol.test.ts`.

- [ ] **Шаг 3: реализация.**
  - `pub mod pack_cards;` в `proto/src/lib.rs` рядом с `pub mod code_search;`.
  - Типы и Zod — по интерфейсам выше; три метода `HostApi`; `fakeHostApi`
    (`test/support/office.tsx`) получает `getBoxCard`, `getPalletCard`, `listPallets` с
    `unexpected(…)`, как `searchCodes`.
- [ ] **Шаг 4: зелёные тесты, `cargo fmt --check`, typecheck, lint, prettier, коммит**
      `feat(standalone): box and pallet cards and the pallet list on the wire; a box's operator`.

## Задача 2: хост — карточка короба `GET /v1/office/boxes/{id}` и оператор в списке коробов смены

**Files:** Create `apps/standalone/host/src/routes/office_cards.rs`,
`apps/standalone/host/tests/office_cards.rs`; Modify `host/src/routes/mod.rs`,
`host/src/server.rs`, `host/src/routes/office_boxes.rs`, `host/tests/office_boxes.rs`.

**Interfaces:**

```rust
// routes/office_cards.rs
pub const BOX_SQL: &str;
pub const BOX_ITEMS_SQL: &str;
pub const BOX_EXCEPTIONS_SQL: &str;
/// Every query of this module by name, for the index test (task 3 adds the pallet's).
pub const QUERIES: [(&str, &str); 6];
pub async fn box_card(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<OfficeBoxCard>, ApiError>;
/// The applied disaggregation documents of a box: none before plan ДЗГ (task 8).
async fn box_documents(conn: &mut SqliteConnection, id: &str) -> Result<Vec<OfficePackDocument>, ApiError>;
```

- [ ] **Шаг 1: стенд и красные тесты** (`host/tests/office_cards.rs`).

  Стенд `Yard` строится помощниками `support::app` (имена проверены):

  ```rust
  mod support;

  use axum::http::StatusCode;
  use serde_json::{json, Value};
  use support::app::{
      add_operator, admin, audit_rows, box_closed, box_exception, box_id, code_hash, empty,
      fact, fact_rows, instant, issue_block, issue_pallet_block, login, ok_scan,
      open_pallet_floor, pair_device, pallet_closed, pallet_id, pallet_sscc, receipts,
      record_id, request, shift_setup, sscc, with_device, with_session, Admin, Floor,
  };

  const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
  const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
  const COLLEAGUE_BLOCK_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
  const COLLEAGUE_PALLET_REQUEST: &str = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

  /// A day of two stations on two lines, both shifts with pallets.
  /// The station: codes 1-3 into box 1 (2 by Анна), 3 undone; box 1 closed
  /// (serial 1500) on pallet 1; codes 4, 5 into box 2, closed (1501) on
  /// pallet 1; pallet 1 closed (serial 40, two boxes counted); box 2 then
  /// taken apart (`wrong_quantity`); pallet 1's label printed again.
  /// The colleague, a day later by the host's clock: an earlier scan of
  /// code 2 into box 11 takes it from box 1; box 11 closed (3500) on
  /// pallet 2, closed (240) before pallet 1; code 6 into box 12, closed
  /// (3501) on pallet 3, which stays open.
  struct Yard {
      admin: Admin,
      floor: Floor,
      colleague: Floor,
      tech: String,
      admin_token: String,
      operator: String,
  }

  async fn accept(admin: &Admin, floor: &Floor, records: &[Value]) {
      let answered = receipts(&admin.app, &floor.key, records).await;
      assert!(answered.iter().all(|r| r["outcome"] == "accepted"), "{answered:?}");
  }

  async fn yard() -> Yard {
      let admin = admin().await;
      let setup = shift_setup(&admin).await;
      let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
      let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
      let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
      let (operator, _) = add_operator(&admin, "1001").await;
      let shift = floor.shift.clone();
      let scan = |record: u32, code: u32, n: u32, second: u32| {
          fact(&record_id(record), "scan", &shift, ok_scan(code, &box_id(n), &instant(second, 0)))
      };
      let mut by_anna = scan(2, 2, 1, 11);
      by_anna["operatorId"] = json!(operator);
      let mut undo = box_exception("undo", &box_id(1), &instant(13, 0));
      undo["codeHash"] = json!(code_hash(3));
      undo["targetScannedAt"] = json!(instant(12, 0));
      let mut closed1 = box_closed(&box_id(1), &block, 1500, &[1, 2], &instant(10, 0), &instant(20, 0));
      closed1["palletId"] = json!(pallet_id(1));
      let mut closed2 = box_closed(&box_id(2), &block, 1501, &[4, 5], &instant(30, 0), &instant(40, 0));
      closed2["palletId"] = json!(pallet_id(1));
      let mut taken_apart = box_exception("disassemble", &box_id(2), &instant(50, 0));
      taken_apart["reasonCode"] = json!("wrong_quantity");
      let reprint = json!({
          "exception": "reprint", "palletId": pallet_id(1), "reasonCode": "damaged_label",
          "reasonText": null, "occurredAt": instant(55, 0)
      });
      let mut closed1_fact = fact(&record_id(5), "box_closed", &shift, closed1);
      closed1_fact["operatorId"] = json!(operator);
      accept(&admin, &floor, &[
          scan(1, 1, 1, 10),
          by_anna,
          scan(3, 3, 1, 12),
          fact(&record_id(4), "box_exception", &shift, undo),
          closed1_fact,
          scan(6, 4, 2, 30),
          scan(7, 5, 2, 31),
          fact(&record_id(8), "box_closed", &shift, closed2),
          fact(&record_id(9), "pallet_closed", &shift,
               pallet_closed(&pallet_id(1), &pallets, 40, 2, &instant(20, 0), &instant(41, 0))),
          fact(&record_id(10), "box_exception", &shift, taken_apart),
          fact(&record_id(11), "pallet_exception", &shift, reprint),
      ]).await;
      admin.app.clock.advance(time::Duration::days(17));
      let (_, colleague_key) = pair_device(&admin.app, "station").await;
      let colleague = open_pallet_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
      let colleague_block = issue_block(&admin.app, &colleague.key, COLLEAGUE_BLOCK_REQUEST).await;
      let colleague_pallets =
          issue_pallet_block(&admin.app, &colleague.key, COLLEAGUE_PALLET_REQUEST).await;
      let other = colleague.shift.clone();
      let mut closed11 = box_closed(&box_id(11), &colleague_block, 3500, &[2], &instant(5, 0), &instant(6, 0));
      closed11["palletId"] = json!(pallet_id(2));
      let mut closed12 = box_closed(&box_id(12), &colleague_block, 3501, &[6], &instant(7, 0), &instant(8, 0));
      closed12["palletId"] = json!(pallet_id(3));
      accept(&admin, &colleague, &[
          fact(&record_id(1), "scan", &other, ok_scan(2, &box_id(11), &instant(5, 0))),
          fact(&record_id(2), "box_closed", &other, closed11),
          fact(&record_id(3), "pallet_closed", &other,
               pallet_closed(&pallet_id(2), &colleague_pallets, 240, 1, &instant(6, 0), &instant(9, 0))),
          fact(&record_id(4), "scan", &other, ok_scan(6, &box_id(12), &instant(7, 0))),
          fact(&record_id(5), "box_closed", &other, closed12),
      ]).await;
      let tech = admin.technologist().await;
      let admin_token = login(&admin.app, &admin.key, "admin", "correct horse battery").await;
      Yard { admin, floor, colleague, tech, admin_token, operator }
  }
  ```

  Предположения стенда, проверить при запуске:
  - вторая станция получает блоки после первой: коробов 3500–5499, паллет 240–439 (подсказки
    `issue_block`/`issue_pallet_block` в `support/app.rs` говорят о первых блоках 1500–3499 и 40–239);
  - факт `pallet_exception` принимается в форме `PalletExceptionFact` (`proto/src/lib.rs:2110`);
  - `box_closed` с `palletId` принимается в смене с паллетами.

  Если что-то из этого не так — поправить стенд по `host/tests/pallet_facts.rs` и записать
  поправку в «Отклонения».

  Тесты:

  ```rust
  impl Yard {
      async fn get(&self, path: &str) -> (StatusCode, Value) {
          self.admin.call_as(&self.tech, "GET", path, None).await
      }
  }

  /// The box's card: its shift, station, operator and pallet, every item it
  /// ever had newest first with where it stands now, and its exceptions.
  #[tokio::test]
  async fn a_box_card_tells_its_items_their_states_and_its_exceptions() {
      let yard = yard().await;
      let (status, card) = yard.get(&format!("/v1/office/boxes/{}", box_id(1))).await;
      assert_eq!(status, StatusCode::OK, "{card}");
      assert_eq!(card["sscc"], sscc(1500));
      assert_eq!(card["shift"]["number"], yard.floor.number);
      assert_eq!(card["operatorName"], "Анна Кузнецова");
      assert_eq!(card["pallet"]["sscc"], pallet_sscc(40));
      assert_eq!(card["units"], 1, "code 2 was taken by the colleague's earlier scan");
      let items: Vec<(String, String)> = card["items"].as_array().unwrap().iter()
          .map(|i| (i["serial"].as_str().unwrap().to_owned(), i["state"].as_str().unwrap().to_owned()))
          .collect();
      assert_eq!(items, [
          ("S000003".to_owned(), "removed".to_owned()),
          ("S000002".to_owned(), "displaced".to_owned()),
          ("S000001".to_owned(), "packed".to_owned()),
      ]);
      assert_eq!(card["items"][0]["leftAt"], instant(13, 0));
      assert_eq!(card["items"][1]["operatorName"], "Анна Кузнецова");
      assert_eq!(card["exceptions"].as_array().unwrap().len(), 1);
      assert_eq!(card["exceptions"][0]["kind"], "undo");
      assert_eq!(card["exceptions"][0]["codeHash"], code_hash(3));
      assert_eq!(card["documents"], json!([]));
      assert_eq!(card["itemsCapped"], false);
  }

  /// A box taken apart: its items left at its disassembly's instant, its
  /// exception names the reason; no full code anywhere in the answer.
  #[tokio::test]
  async fn a_box_taken_apart_shows_its_disassembly_and_no_full_code() {
      let yard = yard().await;
      let (status, card) = yard.get(&format!("/v1/office/boxes/{}", box_id(2))).await;
      assert_eq!(status, StatusCode::OK, "{card}");
      assert_eq!(card["disassembledAt"], instant(50, 0));
      assert!(card["items"].as_array().unwrap().iter()
          .all(|i| i["state"] == "removed" && i["leftAt"] == instant(50, 0)));
      assert_eq!(card["exceptions"][0]["reasonCode"], "wrong_quantity");
      let text = card.to_string();
      assert!(!text.contains("Tail") && !text.contains("\\u001d"), "{text}");
  }

  #[tokio::test]
  async fn an_open_box_of_another_shift_is_read_too() { /* box 12: closed, on open pallet 3 */ }

  #[tokio::test]
  async fn an_unknown_box_is_not_found_and_a_malformed_id_is_refused() {
      let yard = yard().await;
      let (status, body) = yard.get("/v1/office/boxes/b0000000-0000-4000-8000-000000000099").await;
      assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
      let (status, body) = yard.get("/v1/office/boxes/B0000000-0000-4000-8000-000000000001").await;
      assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
      assert_eq!(body["error"]["details"]["field"], "id");
  }

  /// Only an office session reads a card; a refusal carries nothing of the
  /// box; a read writes nothing, not even an audit row.
  #[tokio::test]
  async fn only_an_office_session_reads_a_card_and_a_read_writes_nothing() {
      let yard = yard().await;
      let app = &yard.admin.app;
      let (_, other) = pair_device(app, "station").await;
      let facts_before = fact_rows(app).await;
      let audit_before = audit_rows(app).await;
      let path = format!("/v1/office/boxes/{}", box_id(1));
      for (who, builder) in [
          ("the station's key", with_device(request("GET", &path), &yard.floor.key)),
          ("another device with the admin's session", with_session(request("GET", &path), &other, &yard.admin_token)),
          ("a made-up session", with_session(request("GET", &path), &yard.floor.key, "operator-pin-4821")),
          ("nothing", request("GET", &path)),
      ] {
          let (status, body) = app.send(empty(builder)).await;
          assert_eq!(status, StatusCode::UNAUTHORIZED, "{who}: {body}");
          let text = body.to_string();
          for secret in [sscc(1500).as_str(), "S000001", "Кузнецова"] {
              assert!(!text.contains(secret), "{who} leaked {secret}: {text}");
          }
      }
      let (status, _) = yard.admin.call_as(&yard.admin_token, "GET", &path, None).await;
      assert_eq!(status, StatusCode::OK);
      let (status, _) = yard.get(&path).await; // the technologist
      assert_eq!(status, StatusCode::OK);
      assert_eq!(fact_rows(app).await, facts_before);
      assert_eq!(audit_rows(app).await, audit_before);
  }

  /// Every query of the cards searches by an index, never through a table.
  #[tokio::test]
  async fn every_card_query_searches_by_an_index() {
      let admin = admin().await;
      for (name, sql) in markiro_host::routes::office_cards::QUERIES {
          let plan: Vec<(i64, i64, i64, String)> =
              sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                  .bind("b0000000-0000-4000-8000-000000000001")
                  .bind(10_001_i64)
                  .fetch_all(&admin.app.state.pool)
                  .await
                  .unwrap();
          let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
          assert!(steps.iter().all(|step| !step.starts_with("SCAN")), "{name}: {steps:?}");
          let driving = match name {
              "box items" => Some("scans_ok_box"),
              "box exceptions" => Some("box_exceptions_box"),
              "pallet boxes" => Some("boxes_pallet"),
              "pallet exceptions" => Some("pallet_exceptions_pallet"),
              _ => None,
          };
          if let Some(index) = driving {
              assert!(steps.iter().any(|s| s.contains(&format!("INDEX {index}"))), "{name}: {steps:?}");
          }
      }
  }
  ```

  `add_operator` создаёт оператора «Анна Кузнецова» (`host/tests/support/app.rs:316-331`). У
  `BOX_SQL` и `PALLET_SQL` нет `?2`. Если sqlx отказывает в лишнем аргументе, тест привязывает
  второй аргумент только запросам с `?2` (`if sql.contains("?2")`).

  В `host/tests/office_boxes.rs` — новый тест «у короба, закрытого оператором, есть
  `operatorName`, у короба без оператора — `null`».

  Прогон: `cargo … test -p markiro-host --test office_cards --test office_boxes` — красный.

- [ ] **Шаг 2: реализация** (`routes/office_cards.rs`, существенная часть):

  ```rust
  //! A box's and a pallet's cards in the office (plan КРТ, parity spec §5.3,
  //! the cloud's `GET /code-search/boxes/:id` and `…/pallets/:id`). Every
  //! office role reads them; a device key alone never does. Read only:
  //! nothing is written, not even an audit row. Each card reads in one
  //! snapshot, each query by an index; no full code is read (a code is its
  //! GTIN and serial, its full text is the code card's).

  use axum::extract::State;
  use axum::Json;
  use markiro_proto::code_search::CodePlacementState;
  use markiro_proto::pack_cards::{
      OfficeBoxCard, OfficeBoxException, OfficeBoxItem, OfficePackDocument, OfficePackPallet,
      OfficePackShift, CARD_ROW_LIMIT,
  };
  use markiro_proto::{ExceptionKind, ShiftOrigin, ShiftStatus};
  use serde::de::DeserializeOwned;
  use sqlx::SqliteConnection;

  use crate::auth::OfficeContext;
  use crate::error::{ApiError, ApiPath};
  use crate::server::AppState;
  use crate::{shifts, validate};

  /// The box with its shift, product and line now, its station, operator
  /// and pallet, and its live items counted through `box_items_live`.
  pub const BOX_SQL: &str = "SELECT b.id, b.sscc, b.opened_at, b.closed_at, b.disassembled_at, \
       b.item_count_reported, b.digest_matches, b.print_verified_at, b.print_skipped_at, \
       b.device_id, d.name AS device_name, op.name AS operator_name, \
       (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
        AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units, \
       sh.id AS shift_id, sh.number_month_key, sh.number_seq, sh.created_from, \
       sh.status AS shift_status, sh.production_date, pr.name AS product_name, \
       l.name AS line_name, p.id AS pallet_id, p.sscc AS pallet_sscc, \
       p.closed_at AS pallet_closed_at, p.disassembled_at AS pallet_disassembled_at \
       FROM boxes b JOIN shifts sh ON sh.id = b.shift_id \
       JOIN products pr ON pr.id = sh.product_id JOIN lines l ON l.id = sh.line_id \
       JOIN devices d ON d.id = b.device_id LEFT JOIN operators op ON op.id = b.operator_id \
       LEFT JOIN pallets p ON p.id = b.pallet_id WHERE b.id = ?1";

  /// Every item the box ever had, newest first: every accepted scan into the
  /// box names it (`scans_ok_box`, plan «Поиск кодов»), and each item is the
  /// one of its scan. A scan that lost its code to an earlier one has no item.
  pub const BOX_ITEMS_SQL: &str = "SELECT i.scan_id, i.code_hash, s.gtin14, s.serial, \
       i.added_at, i.removed_at, i.displaced_at, op.name AS operator_name \
       FROM scans s JOIN box_items i ON i.scan_id = s.id \
       LEFT JOIN operators op ON op.id = s.operator_id \
       WHERE s.box_id = ?1 AND s.verdict = 'ok' \
       ORDER BY i.added_at DESC, i.scan_id DESC LIMIT ?2";

  /// The box's exceptions, oldest first.
  pub const BOX_EXCEPTIONS_SQL: &str = "SELECT e.id, e.kind, e.code_hash, e.reason_code, \
       e.reason_text, e.occurred_at, e.received_at, d.name AS device_name, \
       op.name AS operator_name FROM box_exceptions e JOIN devices d ON d.id = e.device_id \
       LEFT JOIN operators op ON op.id = e.operator_id \
       WHERE e.box_id = ?1 ORDER BY e.occurred_at, e.id LIMIT ?2";

  // `BoxRow`, `ItemRow`, `ExceptionRow`: `#[derive(sqlx::FromRow)]`, one field per
  // column of the query above, named as its alias; counts are `i64`, booleans
  // `Option<bool>`, counts of the station `Option<u32>` (as `office_boxes::BoxRow`).

  /// A stored word read back into its wire enum.
  fn stored<T: DeserializeOwned>(text: &str) -> Result<T, ApiError> {
      serde_json::from_value(serde_json::Value::String(text.to_owned())).map_err(ApiError::internal)
  }

  /// The shift of a card, its number as people read it.
  pub(crate) fn pack_shift(
      id: String,
      month_key: &str,
      seq: i64,
      created_from: &str,
      status: &str,
      production_date: String,
      product_name: String,
      line_name: String,
  ) -> Result<OfficePackShift, ApiError> {
      let origin: ShiftOrigin = created_from.parse().map_err(ApiError::internal)?;
      let status: ShiftStatus = status.parse().map_err(ApiError::internal)?;
      Ok(OfficePackShift {
          number: shifts::format_number(month_key, seq, origin),
          id,
          status,
          production_date,
          product_name,
          line_name,
      })
  }

  /// Where an item stands, as the code search's placements (`office_codes`):
  /// taken out wins over taken elsewhere.
  fn item_state(row: &ItemRow, box_closed: bool) -> (CodePlacementState, Option<String>) {
      match (&row.removed_at, &row.displaced_at) {
          (Some(at), _) => (CodePlacementState::Removed, Some(at.clone())),
          (None, Some(at)) => (CodePlacementState::Displaced, Some(at.clone())),
          (None, None) if box_closed => (CodePlacementState::Packed, None),
          (None, None) => (CodePlacementState::OpenBox, None),
      }
  }

  /// The id of a box or a pallet in a path: the station's lower-case UUID.
  pub(crate) fn pack_id(id: &str) -> Result<(), ApiError> {
      validate::client_uuid("id", id)
  }

  async fn read_box(conn: &mut SqliteConnection, id: &str) -> Result<Option<OfficeBoxCard>, ApiError> {
      let limit = i64::from(CARD_ROW_LIMIT);
      let Some(row): Option<BoxRow> = sqlx::query_as(BOX_SQL)
          .bind(id)
          .fetch_optional(&mut *conn)
          .await
          .map_err(ApiError::internal)?
      else {
          return Ok(None);
      };
      let mut items: Vec<ItemRow> = sqlx::query_as(BOX_ITEMS_SQL)
          .bind(id)
          .bind(limit + 1)
          .fetch_all(&mut *conn)
          .await
          .map_err(ApiError::internal)?;
      let items_capped = items.len() > CARD_ROW_LIMIT as usize;
      items.truncate(CARD_ROW_LIMIT as usize);
      let exceptions: Vec<ExceptionRow> = sqlx::query_as(BOX_EXCEPTIONS_SQL)
          .bind(id)
          .bind(limit)
          .fetch_all(&mut *conn)
          .await
          .map_err(ApiError::internal)?;
      let documents = box_documents(&mut *conn, id).await?;
      let closed = row.closed_at.is_some();
      // OfficeBoxCard field by field from `row`; besides:
      //   shift: pack_shift(row.shift_id, &row.number_month_key, row.number_seq,
      //          &row.created_from, &row.shift_status, row.production_date,
      //          row.product_name, row.line_name)?,
      //   pallet: row.pallet_id.map(|id| OfficePackPallet { id, sscc: row.pallet_sscc, … }),
      //   items: each with `let (state, left_at) = item_state(&item, closed);`,
      //   exceptions: each with `kind: stored::<ExceptionKind>(&e.kind)?`,
      //   units: u32::try_from(row.units).map_err(ApiError::internal)?,
      //   items_capped, documents.
      Ok(Some(OfficeBoxCard { /* as above */ }))
  }

  /// Plan ДЗГ's applied documents of the box; none until its tables exist
  /// (plan КРТ, task 8 reads them).
  async fn box_documents(
      _conn: &mut SqliteConnection,
      _id: &str,
  ) -> Result<Vec<OfficePackDocument>, ApiError> {
      Ok(Vec::new())
  }

  /// `GET /v1/office/boxes/{id}`: a malformed id is `validation_failed`, a box
  /// the host never saw `not_found`.
  pub async fn box_card(
      State(state): State<AppState>,
      _context: OfficeContext,
      ApiPath(id): ApiPath<String>,
  ) -> Result<Json<OfficeBoxCard>, ApiError> {
      pack_id(&id)?;
      let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
      let card = read_box(&mut tx, &id).await;
      tx.rollback().await.map_err(ApiError::internal)?;
      card?.map(Json).ok_or_else(|| ApiError::not_found("no such box"))
  }
  ```

  Код выше — существенная часть: структуры строк и сборку `OfficeBoxCard` по комментарию
  исполнитель пишет полностью, по полю на строку (образец — `office_codes.rs::ItemRow::into_wire`).
  - `server.rs`: `.route("/v1/office/boxes/{id}", get(crate::routes::office_cards::box_card))`
    рядом с `…/report-data`; `routes/mod.rs`: `pub mod office_cards;`.
  - `office_boxes.rs`: `BOXES_SQL` получает `op.name AS operator_name` и
    `LEFT JOIN operators op ON op.id = b.operator_id`; `BoxRow`/`OfficeBox` — поле. Тест индексов
    списка коробов в `host/tests/office_boxes.rs` (если есть) должен остаться зелёным:
    присоединение по первичному ключу индекс не меняет.

- [ ] **Шаг 3: зелёные тесты, `cargo fmt --check`, без предупреждений, коммит**
      `feat(standalone): host box card for the office (GET /v1/office/boxes/{id}); a box's operator in the shift's list`.

## Задача 3: хост — карточка паллеты `GET /v1/office/pallets/{id}`

**Files:** Modify `host/src/routes/office_cards.rs`, `host/src/server.rs`,
`host/tests/office_cards.rs`.

**Interfaces:**

```rust
pub const PALLET_SQL: &str;
pub const PALLET_BOXES_SQL: &str;
pub const PALLET_EXCEPTIONS_SQL: &str;
pub async fn pallet_card(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<OfficePalletCard>, ApiError>;
async fn pallet_documents(conn: &mut SqliteConnection, id: &str) -> Result<Vec<OfficePackDocument>, ApiError>;
```

- [ ] **Шаг 1: красные тесты** (стенд `Yard` задачи 2):

  ```rust
  /// The pallet's card: the station counted two boxes, one stands (box 2 was
  /// taken apart after the close) and both are on the list; its reprint.
  #[tokio::test]
  async fn a_pallet_card_lists_every_box_that_joined_it() {
      let yard = yard().await;
      let (status, card) = yard.get(&format!("/v1/office/pallets/{}", pallet_id(1))).await;
      assert_eq!(status, StatusCode::OK, "{card}");
      assert_eq!(card["sscc"], pallet_sscc(40));
      assert_eq!((card["boxes"].clone(), card["boxCountReported"].clone()), (json!(1), json!(2)));
      assert_eq!(card["units"], 1, "box 1's code 1; code 2 is the colleague's now");
      let members: Vec<(&str, bool)> = card["members"].as_array().unwrap().iter()
          .map(|b| (b["sscc"].as_str().unwrap(), b["disassembledAt"].is_null()))
          .collect();
      // Closed newest first: box 2 (closed at 40 s, taken apart), box 1.
      assert_eq!(members, [(sscc(1501).as_str(), false), (sscc(1500).as_str(), true)]);
      assert_eq!(card["exceptions"][0]["kind"], "reprint");
      assert_eq!(card["exceptions"][0]["reasonCode"], "damaged_label");
      assert_eq!(card["shift"]["lineName"], "Линия 1", "the shift's line (`shift_setup`)");
      assert_eq!(card["documents"], json!([]));
  }

  #[tokio::test]
  async fn an_open_pallet_has_no_sscc_and_its_closed_box() { /* pallet 3: sscc null, one member */ }

  #[tokio::test]
  async fn an_unknown_pallet_is_not_found() { /* 404; malformed id 400 field id */ }
  ```

  Имена линий мастера — «Линия 1» и «Линия 2» (`shift_setup`, `host/tests/support/app.rs:486-490`).
  Тест отказа задачи 2 расширяется путём паллеты. `QUERIES` получает три запроса паллеты.

- [ ] **Шаг 2: реализация.**

  ```rust
  /// The pallet with its shift, product and line now, its station and
  /// operator, and what stands on it (closed boxes not taken apart and their
  /// live items), as `office_boxes::PALLETS_SQL` derives them.
  pub const PALLET_SQL: &str = "SELECT p.id, p.sscc, p.opened_at, p.closed_at, \
       p.disassembled_at, p.box_count_reported, p.print_verified_at, p.print_skipped_at, \
       p.device_id, d.name AS device_name, op.name AS operator_name, \
       (SELECT COUNT(*) FROM boxes b WHERE b.pallet_id = p.id \
        AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS boxes, \
       (SELECT COUNT(*) FROM boxes b JOIN box_items i ON i.box_id = b.id \
        AND i.removed_at IS NULL AND i.displaced_at IS NULL \
        WHERE b.pallet_id = p.id AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) \
        AS units, \
       sh.id AS shift_id, sh.number_month_key, sh.number_seq, sh.created_from, \
       sh.status AS shift_status, sh.production_date, pr.name AS product_name, \
       l.name AS line_name \
       FROM pallets p JOIN shifts sh ON sh.id = p.shift_id \
       JOIN products pr ON pr.id = sh.product_id JOIN lines l ON l.id = sh.line_id \
       JOIN devices d ON d.id = p.device_id LEFT JOIN operators op ON op.id = p.operator_id \
       WHERE p.id = ?1";

  /// Every box that joined the pallet, taken apart or not (the only evidence
  /// that a labelled pallet left a box short), closed newest first.
  pub const PALLET_BOXES_SQL: &str = "SELECT b.id, b.sscc, b.closed_at, b.disassembled_at, \
       (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
        AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units \
       FROM boxes b WHERE b.pallet_id = ?1 ORDER BY b.closed_at DESC, b.id LIMIT ?2";

  /// The pallet's exceptions, oldest first.
  pub const PALLET_EXCEPTIONS_SQL: &str = "SELECT e.id, e.kind, e.reason_code, e.reason_text, \
       e.occurred_at, e.received_at, d.name AS device_name, op.name AS operator_name \
       FROM pallet_exceptions e JOIN devices d ON d.id = e.device_id \
       LEFT JOIN operators op ON op.id = e.operator_id \
       WHERE e.pallet_id = ?1 ORDER BY e.occurred_at, e.id LIMIT ?2";
  ```

  `read_pallet` — по образцу `read_box`: три запроса и `pallet_documents` (пока `Ok(Vec::new())`)
  в одной транзакции; `members_capped` — как `items_capped`; `boxes: u32`, `units: u64` через
  `try_from`; `kind` — `stored::<PalletExceptionKind>`. Маршрут
  `.route("/v1/office/pallets/{id}", get(crate::routes::office_cards::pallet_card))`.

- [ ] **Шаг 3: зелёные тесты, fmt, коммит**
      `feat(standalone): host pallet card for the office (GET /v1/office/pallets/{id})`.

## Задача 4: хост — реестр паллет `GET /v1/office/pallets`, миграция `0025`

**Files:** Create `apps/standalone/host/migrations/0025_pallet_list.sql`,
`apps/standalone/host/src/routes/office_pallets.rs`, `apps/standalone/host/tests/office_pallets.rs`;
Modify `host/src/routes/mod.rs`, `host/src/server.rs`, `host/src/routes/office_codes.rs`
(`period_end` → `pub(crate)`).

**Interfaces:**

```rust
// routes/office_pallets.rs
pub const LIST_SQL: &str;
pub const BY_SSCC_SQL: &str;
pub const STATIONS_SQL: &str;
/// The key before every row (`(ifnull(closed_at, '~'), id) < (FIRST_KEY, "")`).
pub const FIRST_KEY: &str = "~~";
/// An open pallet's key: after every digit, so open pallets come first.
pub const OPEN_KEY: &str = "~";
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletListQuery {
    product: Option<String>,
    line: Option<String>,
    device: Option<String>,
    from_ms: Option<String>,
    to_ms: Option<String>,
    sscc: Option<String>,
    cursor: Option<String>,
}
pub async fn list_pallets(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiQuery(query): ApiQuery<PalletListQuery>,
) -> Result<Json<OfficePalletPage>, ApiError>;
/// `o~<id>` after an open pallet, `<ms>~<id>` after a closed one.
pub fn next_cursor(id: &str, closed_at: Option<&str>) -> Result<String, ApiError>;
```

- [ ] **Шаг 0: номер миграции.** `ls <wt>/apps/standalone/host/migrations` и открытые
      `claude/fb-*`: `0025` свободен? Если занят — следующий свободный, в «Отклонения».
- [ ] **Шаг 1: красные тесты миграции и реестра** (`host/tests/office_pallets.rs`; стенд `Yard` —
      копия из `office_cards.rs`. Общий модуль тестов не заводится: каждый файл тестов хоста —
      свой крейт, а `support` — только помощники приложения).

  ```rust
  async fn page(yard: &Yard, query: &str) -> Value {
      let path = if query.is_empty() { "/v1/office/pallets".to_owned() } else { format!("/v1/office/pallets?{query}") };
      let (status, page) = yard.admin.call_as(&yard.tech, "GET", &path, None).await;
      assert_eq!(status, StatusCode::OK, "{query}: {page}");
      page
  }
  fn ids(page: &Value) -> Vec<String> {
      page["items"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap().to_owned()).collect()
  }

  /// Open pallets first, then closed newest first, across shifts, lines and stations.
  #[tokio::test]
  async fn the_list_runs_across_shifts_open_first_then_closed_newest_first() {
      let yard = yard().await;
      let first = page(&yard, "").await;
      assert_eq!(ids(&first), [pallet_id(3), pallet_id(1), pallet_id(2)]);
      assert_eq!(first["nextCursor"], Value::Null);
      let row = &first["items"][1];
      assert_eq!(row["shiftNumber"], yard.floor.number);
      assert_eq!((row["boxes"].clone(), row["boxCountReported"].clone()), (json!(1), json!(2)));
      let stations: Vec<&str> = first["stations"].as_array().unwrap().iter()
          .map(|s| s["id"].as_str().unwrap()).collect();
      assert!(stations.contains(&yard.floor.station.as_str()));
      assert!(stations.contains(&yard.colleague.station.as_str()));
  }

  #[tokio::test]
  async fn each_filter_narrows_the_list() {
      let yard = yard().await;
      // The colleague's shift is on «Линия 2» (`setup.other_line`, kept in `Yard`).
      let line = yard.other_line.clone();
      assert_eq!(ids(&page(&yard, &format!("line={line}")).await), [pallet_id(3), pallet_id(2)]);
      assert_eq!(ids(&page(&yard, &format!("device={}", yard.floor.station)).await), [pallet_id(1)]);
      assert_eq!(ids(&page(&yard, &format!("sscc={}", pallet_sscc(40))).await), [pallet_id(1)]);
      assert_eq!(ids(&page(&yard, "sscc=146006820000009999").await), Vec::<String>::new());
      // A period of closing: [from, to) in ms; an open pallet is never in one.
      let from = millis(9); let to = millis(41);
      assert_eq!(ids(&page(&yard, &format!("fromMs={from}&toMs={to}")).await), [pallet_id(2)]);
      // The product: both shifts are of setup.product, so all three; a made-up one none.
      assert_eq!(ids(&page(&yard, "product=6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f").await), Vec::<String>::new());
  }

  /// A page of 100 continues below its last row, ties of the closing instant
  /// broken by id, with nothing lost or repeated.
  #[tokio::test]
  async fn the_list_pages_by_a_cursor_through_ties() {
      let yard = yard().await;
      // 101 more pallets closed at one instant, none with a box (a pallet
      // whose boxes never reached the host opens closed: plan ПЛ-Х).
      let records: Vec<Value> = (0..101u32).map(|n| fact(
          &record_id(100 + n), "pallet_closed", &yard.floor.shift,
          pallet_closed(&pallet_id(100 + n), &yard.pallet_block, 41 + u64::from(n), 1,
              &instant(60, 0), &instant(61, 0)),
      )).collect();
      accept(&yard.admin, &yard.floor, &records).await;
      let first = page(&yard, "").await;
      assert_eq!(first["items"].as_array().unwrap().len(), 100);
      let cursor = first["nextCursor"].as_str().unwrap().to_owned();
      assert!(cursor.contains('~') && !cursor.contains(':'), "{cursor}");
      let second = page(&yard, &format!("cursor={cursor}")).await;
      assert_eq!(second["nextCursor"], Value::Null);
      let mut all = ids(&first); all.extend(ids(&second));
      assert_eq!(all.len(), 104);
      let unique: std::collections::BTreeSet<&String> = all.iter().collect();
      assert_eq!(unique.len(), 104, "nothing repeated");
  }

  #[tokio::test]
  async fn a_malformed_parameter_is_refused_with_its_field() {
      let yard = yard().await;
      for (query, field) in [
          ("product=not-a-uuid", "product"),
          ("line=A0000000-0000-4000-8000-000000000001", "line"),
          ("device=1", "device"),
          ("sscc=12345", "sscc"),
          ("fromMs=x", "fromMs"),
          ("fromMs=2000&toMs=1000", "toMs"),
          ("cursor=2026-10-08~a0000000-0000-4000-8000-000000000001", "cursor"),
          ("cursor=o~nope", "cursor"),
      ] {
          let (status, body) = yard.admin
              .call_as(&yard.tech, "GET", &format!("/v1/office/pallets?{query}"), None).await;
          assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
          assert_eq!(body["error"]["details"]["field"], field, "{query}: {body}");
      }
      let (status, _) = yard.admin.call_as(&yard.tech, "GET", "/v1/office/pallets?kind=warehouse", None).await;
      assert_eq!(status, StatusCode::BAD_REQUEST, "an unknown parameter");
  }

  #[tokio::test]
  async fn only_an_office_session_reads_the_list() { /* как в задаче 2: 401 ×4, тело без SSCC */ }

  /// The list is read through `pallets_list_order` without sorting, the SSCC
  /// through `pallets_sscc`; the stations are a scan of a table of a handful.
  #[tokio::test]
  async fn the_list_is_read_in_its_order_through_an_index() {
      let admin = admin().await;
      for (name, sql, index) in [
          ("list", markiro_host::routes::office_pallets::LIST_SQL, "pallets_list_order"),
          ("by sscc", markiro_host::routes::office_pallets::BY_SSCC_SQL, "pallets_sscc"),
      ] {
          let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
              .fetch_all(&admin.app.state.pool).await.unwrap();
          let steps: Vec<&str> = plan.iter().map(|(_, _, _, s)| s.as_str()).collect();
          assert!(steps.iter().any(|s| s.contains(&format!("INDEX {index}"))), "{name}: {steps:?}");
          assert!(steps.iter().all(|s| !s.contains("TEMP B-TREE")), "{name} sorts: {steps:?}");
          assert!(steps.iter().all(|s| !s.starts_with("SCAN") || s.contains("USING")), "{name}: {steps:?}");
      }
  }

  /// Migration 0025: the list's index exists, and `scans_ok_box` survives
  /// whatever rebuilt `scans` before it.
  #[tokio::test]
  async fn migration_0025_makes_the_lists_index_and_keeps_the_box_items_index() {
      let admin = admin().await;
      let names: Vec<String> = sqlx::query_scalar(
          "SELECT name FROM sqlite_master WHERE type = 'index' \
           AND name IN ('pallets_list_order', 'scans_ok_box') ORDER BY name")
          .fetch_all(&admin.app.state.pool).await.unwrap();
      assert_eq!(names, ["pallets_list_order", "scans_ok_box"]);
  }
  ```

  `Yard` в этом файле дополнительно хранит `pallet_block: Value` и `other_line: String`; `millis` —
  копия помощника `office_codes.rs` потока. Ожидания `boxes`/`units` строк сверить с карточкой
  (задача 3).

  Прогон: `cargo … test -p markiro-host --test office_pallets` — красный.

- [ ] **Шаг 2: миграция.**

  <!-- prettier-ignore -->
  ```sql
  -- The office's list of every pallet of the site (plan КРТ, parity spec
  -- §5.3, the cloud's `GET /pallets`): open pallets first, then closed
  -- newest first, paged by a key (`routes/office_pallets.rs`). The key is
  -- `ifnull(closed_at, '~')`: a device's instant starts with a digit, so
  -- '~' sorts after every one and an open pallet before every closed one
  -- when read backwards. Indexes only: no row is written or changed.
  CREATE INDEX pallets_list_order ON pallets (ifnull(closed_at, '~'), id);

  -- A box card reads every item of a box through the accepted scans into it
  -- (`scans_ok_box`, plan «Поиск кодов», `0019`). A rebuild of `scans`
  -- (plan РЕЖ, `0020`) drops the table's indexes with it; this makes the
  -- index again if that rebuild did not. A migration after `0020` may index
  -- `scans` (parity spec §8.1).
  CREATE INDEX IF NOT EXISTS scans_ok_box ON scans (box_id) WHERE verdict = 'ok';
  ```

  Тест `foundation.rs` (`applied == MIGRATOR.iter().count()`) остаётся зелёным сам.

- [ ] **Шаг 3: реализация** (`routes/office_pallets.rs`, существенная часть):

  ```rust
  //! The office's list of every pallet of the site (plan КРТ, parity spec
  //! §5.3, the cloud's `GET /pallets`): narrowed by product, line (the
  //! shift's), station, a period of closing and an SSCC; open pallets first,
  //! then closed newest first, 100 a page, each page below the previous
  //! one's last row (a key, never an offset, so a pallet that closes
  //! meanwhile neither skips nor repeats a row). Every office role reads it;
  //! nothing is written. Each query is a fixed text with the criteria bound.

  macro_rules! pallet_list {
      ($driver:literal) => {
          concat!(
              "SELECT p.id, p.sscc, p.opened_at, p.closed_at, p.disassembled_at, \
               p.box_count_reported, p.device_id, d.name AS device_name, \
               sh.id AS shift_id, sh.number_month_key, sh.number_seq, sh.created_from, \
               sh.production_date, sh.product_id, pr.name AS product_name, sh.line_id, \
               l.name AS line_name, \
               (SELECT COUNT(*) FROM boxes b WHERE b.pallet_id = p.id \
                AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS boxes, \
               (SELECT COUNT(*) FROM boxes b JOIN box_items i ON i.box_id = b.id \
                AND i.removed_at IS NULL AND i.displaced_at IS NULL \
                WHERE b.pallet_id = p.id AND b.closed_at IS NOT NULL \
                AND b.disassembled_at IS NULL) AS units \
               FROM pallets p JOIN shifts sh ON sh.id = p.shift_id \
               JOIN products pr ON pr.id = sh.product_id JOIN lines l ON l.id = sh.line_id \
               JOIN devices d ON d.id = p.device_id WHERE ",
              $driver,
              " AND (ifnull(p.closed_at, '~'), p.id) < (?6, ?7) \
               AND (?1 IS NULL OR sh.product_id = ?1) AND (?2 IS NULL OR sh.line_id = ?2) \
               AND (?3 IS NULL OR p.device_id = ?3) AND (?4 IS NULL OR p.closed_at >= ?4) \
               AND (?5 IS NULL OR p.closed_at < ?5) \
               ORDER BY ifnull(p.closed_at, '~') DESC, p.id DESC LIMIT ?8"
          )
      };
  }

  // Parameters, bound by every query in this order: ?1 product, ?2 line, ?3
  // station, ?4 and ?5 the period's ends (device instants' text), ?6 and ?7
  // the key below which the page starts, ?8 the limit, ?9 the SSCC.
  pub const LIST_SQL: &str = pallet_list!("?9 IS NULL");
  pub const BY_SSCC_SQL: &str = pallet_list!("p.sscc = ?9");
  pub const STATIONS_SQL: &str = "SELECT id, name, revoked_at IS NOT NULL AS revoked \
       FROM devices WHERE kind = 'station' ORDER BY name, id";

  fn uuid_param(field: &str, value: Option<String>) -> Result<Option<String>, ApiError> {
      value.map(|v| validate::client_uuid(field, &v).map(|()| v)).transpose()
  }

  fn decode_cursor(text: &str) -> Result<(String, String), ApiError> {
      let refused = || ApiError::validation("cursor", "a cursor this list gave");
      let (key, id) = text.split_once('~').ok_or_else(refused)?;
      validate::client_uuid("cursor", id).map_err(|_| refused())?;
      let key = if key == "o" {
          OPEN_KEY.to_owned()
      } else {
          office_codes::period_end("cursor", key).map_err(|_| refused())?
      };
      Ok((key, id.to_owned()))
  }

  pub fn next_cursor(id: &str, closed_at: Option<&str>) -> Result<String, ApiError> {
      match closed_at {
          None => Ok(format!("o~{id}")),
          Some(at) => {
              let at = rules::device_instant(at)
                  .ok_or_else(|| ApiError::internal("a pallet's closing is no device instant"))?;
              Ok(format!("{}~{id}", at.unix_timestamp_nanos() / 1_000_000))
          }
      }
  }

  pub async fn list_pallets(
      State(state): State<AppState>,
      _context: OfficeContext,
      ApiQuery(query): ApiQuery<PalletListQuery>,
  ) -> Result<Json<OfficePalletPage>, ApiError> {
      let product = uuid_param("product", query.product)?;
      let line = uuid_param("line", query.line)?;
      let device = uuid_param("device", query.device)?;
      let from = query.from_ms.as_deref().map(|v| office_codes::period_end("fromMs", v)).transpose()?;
      let to = query.to_ms.as_deref().map(|v| office_codes::period_end("toMs", v)).transpose()?;
      if let (Some(from), Some(to)) = (&from, &to) {
          if from >= to {
              return Err(ApiError::validation("toMs", "the period ends before it starts"));
          }
      }
      let sscc = query.sscc.map(|s| {
          if s.len() == 18 && s.bytes().all(|b| b.is_ascii_digit()) { Ok(s) }
          else { Err(ApiError::validation("sscc", "the SSCC must be 18 digits")) }
      }).transpose()?;
      let (key, after) = match query.cursor.as_deref() {
          Some(cursor) => decode_cursor(cursor)?,
          None => (FIRST_KEY.to_owned(), String::new()),
      };
      let sql = if sscc.is_some() { BY_SSCC_SQL } else { LIST_SQL };
      let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
      let read = async {
          let rows: Vec<PalletRow> = sqlx::query_as(sql)
              .bind(&product).bind(&line).bind(&device).bind(&from).bind(&to)
              .bind(&key).bind(&after).bind(i64::from(PALLET_PAGE_SIZE) + 1).bind(&sscc)
              .fetch_all(&mut *tx).await.map_err(ApiError::internal)?;
          let stations: Vec<StationRow> = sqlx::query_as(STATIONS_SQL)
              .fetch_all(&mut *tx).await.map_err(ApiError::internal)?;
          Ok::<_, ApiError>((rows, stations))
      }.await;
      tx.rollback().await.map_err(ApiError::internal)?;
      let (mut rows, stations) = read?;
      let more = rows.len() > PALLET_PAGE_SIZE as usize;
      rows.truncate(PALLET_PAGE_SIZE as usize);
      let next = match (more, rows.last()) {
          (true, Some(last)) => Some(next_cursor(&last.id, last.closed_at.as_deref())?),
          _ => None,
      };
      // rows → OfficePalletRow (shift number via shifts::format_number), stations → OfficePalletStation
      …
  }
  ```

  - В `office_codes.rs` изменить только `fn period_end` на `pub(crate) fn period_end`. Тело и тесты
    потока не трогать.
  - Маршрут — `.route("/v1/office/pallets", get(crate::routes::office_pallets::list_pallets))`,
    `routes/mod.rs` — `pub mod office_pallets;`.
  - **Если тест плана показал `TEMP B-TREE`** (планировщик не взял индекс по выражению для
    сравнения строк): заменить условие ключа на
    `(ifnull(p.closed_at, '~') < ?6 OR (ifnull(p.closed_at, '~') = ?6 AND p.id < ?7))` и прогнать
    снова. Если и так сортирует — оставить сортировку, записать замер (стенд на 20 000 паллет,
    тест `#[ignore]`) в «Отклонения» и ослабить тест плана только для `LIST_SQL`, с
    комментарием-ссылкой на замер.

- [ ] **Шаг 4: зелёные тесты (`office_pallets`, `office_cards`, `office_codes`, `foundation`),
      fmt, коммит** `feat(standalone): host list of every pallet of the site for the office (GET /v1/office/pallets), migration 0025`.

## Задача 5: офис — раздел «Поиск кодов» с вкладками; «Короба» и «Паллеты»

**Files:** Create `src/office/codes/{CodesSection,RegistryTabs,BoxesTab,PalletsTab,PackLinks}.tsx`,
`src/office/codes/pallet-query.ts`,
`test/{registry-tabs,boxes-tab,pallets-tab}.test.tsx`, `test/pallet-query.test.ts`;
Modify `src/office/routes.tsx`, `src/office/office-query.ts`,
`src/office/codes/{CodeSearchPage.tsx,code-query.ts}`, `src/i18n/ru.json`,
`test/office-query.test.tsx`, `test/code-search-page.test.tsx`.

**Interfaces:**

```ts
// office-query.ts
export function useOfficeInfiniteQuery<T>(
  key: QueryKey,
  read: (api: HostApi, token: string, cursor: string | null) => Promise<T>,
  nextCursor: (page: T) => string | null,
  options?: Pick<OfficeQueryOptions, "enabled">,
): UseInfiniteQueryResult<InfiniteData<T, string | null>, Error>;
// officeKeys
boxCard: (id: string) => ["office", "box-card", id],
palletCard: (id: string) => ["office", "pallet-card", id],
/** Every page of one query of the pallet list. */
palletList: (query: PalletListQuery) => ["office", "pallet-list", query],

// CodesSection.tsx
export type RegistryTab = "codes" | "boxes" | "pallets";
export const REGISTRY_PATHS: Record<RegistryTab, string>; // "/codes", "/codes/boxes", "/codes/pallets"
export function CodesSection(): JSX.Element;               // <Outlet/> with the tabs' memory
export function useRegistryMemory(): Map<RegistryTab, string>;
/** Where a card's «Назад» goes without history: the last tab with its filters. */
export function useLastRegistryHref(): string;

// RegistryTabs.tsx
export function RegistryTabs({ active }: { active: RegistryTab }): JSX.Element;

// pallet-query.ts
/** The list's filters as the address keeps them (`?product=&line=&device=&from=&to=&sscc=`). */
export interface PalletFilters { product: string; line: string; device: string; from: string; to: string; sscc: string }
export function palletFiltersOf(params: URLSearchParams): PalletFilters;
export function paramsOfPalletFilters(filters: PalletFilters): URLSearchParams;
/** The host's query of the filters: the days in the organization's zone, `[from 00:00, the day after to 00:00)`; `null` for an SSCC that is not 18 digits or a period backwards. */
export function palletListQuery(filters: PalletFilters, timeZone: string): PalletListQuery | null;

// PackLinks.tsx — shared by the tabs, the cards, the shift card and the code card
export function BoxLink(props: { id: string; sscc: string | null }): JSX.Element;   // /codes/box/:id, text ssccText or «Без SSCC»
export function PalletLink(props: { id: string; sscc: string | null }): JSX.Element; // /codes/pallet/:id
```

Ссылки `BoxLink`/`PalletLink` гасят `onClick` всплытие (`event.stopPropagation()`), как
`ShiftLink` потока: в строке таблицы с `onRowClick` клик по ссылке не открывает строку.

`useOfficeInfiniteQuery` — без приведения типов:

```ts
export function useOfficeInfiniteQuery<T>(
  key: QueryKey,
  read: (api: HostApi, token: string, cursor: string | null) => Promise<T>,
  nextCursor: (page: T) => string | null,
  options: Pick<OfficeQueryOptions, "enabled"> = {},
): UseInfiniteQueryResult<InfiniteData<T, string | null>, Error> {
  const { api, call } = useOfficeSession();
  return useInfiniteQuery<T, Error, InfiniteData<T, string | null>, QueryKey, string | null>({
    queryKey: key,
    queryFn: ({ pageParam }) => call((token) => read(api, token, pageParam)),
    initialPageParam: null,
    getNextPageParam: (last) => nextCursor(last) ?? undefined,
    staleTime: 0,
    enabled: options.enabled ?? true,
  });
}
```

Маршруты (`routes.tsx`) — `{ path: "codes", element: <CodeSearchPage /> }` заменяется на:

```tsx
{
  path: "codes",
  element: <CodesSection />,
  children: [
    { index: true, element: <CodeSearchPage /> },
    { path: "boxes", element: <BoxesTab /> },
    { path: "pallets", element: <PalletsTab /> },
    { path: "box/:id", element: <BoxCardPage /> },
    { path: "pallet/:id", element: <PalletCardPage /> },
  ],
},
```

(`BoxCardPage`/`PalletCardPage` — задача 6. До неё два дочерних маршрута не добавляются, и
`BoxLink`/`PalletLink` ведут на ещё не существующий путь. Поэтому задачи 5 и 6 сливаются в одну
ветку и не выпускаются по отдельности.)

`CodesSection` хранит память вкладок в состоянии: `const [memory] = useState(() => new Map<RegistryTab, string>())`
и отдаёт её через контекст (`<RegistryMemory value={memory}><Outlet /></RegistryMemory>`, React 19).
`RegistryTabs` записывает `location.search` своей вкладки в эффекте и переходит на
`${REGISTRY_PATHS[id]}${memory.get(id) ?? ""}` — как облачные `RegistryTabs` +
`useRememberRegistryLocation`, только без `sessionStorage` (Р13).

`CodeSearchPage` (поток): под `PageHeader` добавить `<RegistryTabs active="codes" />`; больше
ничего. `code-query.ts` (поток): экспортировать `nextDay`, его использует `palletListQuery`.

**Вкладка «Короба» (`BoxesTab`)** — облачный `apps/admin/src/pages/boxes/index.tsx`:

- `PageHeader` «Поиск кодов», `RegistryTabs active="boxes"`.
- `Select` «Смена» (`searchable`, `native` нет — список длинный). Варианты — `listShifts()`
  (`officeKeys.shiftList(null)`) без `status === "planned"` и без `mode === "validation"`, по
  дате производства от новых. Подпись варианта —
  `«{{number}} · {{date}} · {{product}}»` (товар — по `listProducts`). Смена из
  `?shift=<id>`, которой нет в списке, читается `getShift` и добавляется первой.
- Без смены — `EmptyState` «Выберите смену, чтобы увидеть её короба» и ни одного
  `listShiftBoxes`.
- Со сменой — над таблицей строка `«Линия: {{line}} · {{status}}»`, затем `Table` коробов
  (`listShiftBoxes`, `officeKeys.shiftBoxes(id)` — тот же ключ, что у карточки смены). Столбцы:
  SSCC (`BoxLink`), «Кодов», «Закрыт», «Паллета» (`PalletLink`, только у смены с паллетами),
  «Оператор» (`operatorName ?? «—»`), «Состояние» (`packState` словами). Строка открывает
  карточку короба (`onRowClick` → `navigate(/codes/box/:id)`). 50 на страницу через
  `OfficePager`, фильтр последних цифр SSCC — как в карточке смены (`endsWithTail`, `ssccTail`).

**Вкладка «Паллеты» (`PalletsTab`)** — облачный `apps/admin/src/pages/pallets/index.tsx`:

- Фильтры в адресе (`palletFiltersOf`/`paramsOfPalletFilters`). Каждое изменение пишет адрес,
  запрос — `useOfficeInfiniteQuery(officeKeys.palletList(query), (api, token, cursor) => api.listPallets(token, query, cursor), (page) => page.nextCursor, { enabled: zoneReady && query !== null })`.
  Зона — из `getOrg` (`formTimeZone`), как в поиске кодов.
- `FilterBar` («Что показать», «Сбросить»):
  - `Select` «Товар» (`searchable`, «Все товары» + `listProducts`, архивные — «{{name}} (в архиве)»);
  - `Select` «Линия» («Все линии» + `listLines`);
  - `Select` «Станция» («Все станции» + `page.stations` первой страницы, отозванные —
    «{{name}} (отозвана)»);
  - `DatePicker` «Закрыта с» / «по» (ошибка «Период кончается раньше, чем начинается»);
  - `Input` «SSCC паллеты» (`mono`, подсказка «18 цифр, можно отсканировать ярлык»); не 18 цифр
    после нажатия «Показать» — ошибка «SSCC паллеты — 18 цифр» и запроса нет.

  Ввод SSCC сканером — через `classifyScan` домена (как `classifySearchInput` потока). SSCC
  принимается, если `kind === "sscc"` и первая цифра `1` (расширение паллеты).

- `Table`: SSCC (`PalletLink`), «Товар», «Смена» (`ShiftLink` потока), «Линия», «Станция»,
  «Коробов», «Кодов», «Закрыта», «Состояние». В состоянии стоят три независимых чипа словами:
  - «Открыта»/«Закрыта»/«Расформирована» (`PACK_PHASE`);
  - «Состав изменился после закрытия» (`palletCountDiffers`, Р6);
  - «Расформирована {{at}}» — тихой строкой.

  Строка открывает карточку паллеты.

- Под таблицей — «Показать ещё» (`Button variant="secondary" loading={isFetchingNextPage}`),
  пока `hasNextPage`. Сводка FilterBar — «Показано: {{shown}}» (всего хост не считает).
- Пусто — «Паллет по этим условиям нет».

**Тексты (`src/i18n/ru.json`, новые ключи):**

- `office.registry.label` — «Разделы поиска кодов» (облако: `pages.codeSearch.tabs.label`).
- `office.registry.codes` — «Коды» (облако: `pages.codeSearch.tabs.codes`).
- `office.registry.boxes` — «Короба» (облако: `…tabs.boxes`).
- `office.registry.pallets` — «Паллеты» (облако: `…tabs.pallets`).
- `office.boxList.shift` — «Смена» (облако: `pages.boxes.filters.shiftLabel`).
- `office.boxList.shiftSearch` — «Поиск смены» (облако: `pages.boxes.filters.searchLabel`).
- `office.boxList.shiftPlaceholder` — «Выберите смену».
- `office.boxList.shiftOption` — «{{number}} · {{date}} · {{product}}».
- `office.boxList.selectShift` — «Выберите смену, чтобы увидеть её короба» (облако: `pages.boxes.selectShift`).
- `office.boxList.shiftLine` — «Линия: {{line}} · {{status}}».
- `office.boxList.operator` — «Оператор» (облако: `pages.boxes.table.operator`).
- `office.boxList.empty` — «В этой смене нет коробов» (облако: `pages.boxes.empty`).
- `office.palletList.filters` — «Что показать».
- `office.palletList.product` — «Товар» (облако: `pages.pallets.filters.productLabel`).
- `office.palletList.allProducts` — «Все товары» (облако: `…productAll`).
- `office.palletList.productSearch` — «Поиск товара» (облако: `…productSearchLabel`).
- `office.palletList.line` — «Линия» (облако: своё (Р5)).
- `office.palletList.allLines` — «Все линии».
- `office.palletList.station` — «Станция» (облако: `…deviceLabel` («Устройство»; в автономе — станция)).
- `office.palletList.allStations` — «Все станции» (облако: `…deviceAll`).
- `office.palletList.revokedStation` — «{{name}} (отозвана)».
- `office.palletList.from` — «Закрыта с» (облако: `…fromLabel`).
- `office.palletList.to` — «по» (облако: `…toLabel` («Закрыта по»)).
- `office.palletList.periodBackwards` — «Период кончается раньше, чем начинается» (облако: текст потока).
- `office.palletList.sscc` — «SSCC паллеты».
- `office.palletList.ssccHint` — «18 цифр, можно отсканировать ярлык».
- `office.palletList.ssccInvalid` — «SSCC паллеты — 18 цифр».
- `office.palletList.submit` — «Показать».
- `office.palletList.reset` — «Сбросить».
- `office.palletList.shown` — «Показано: {{shown}}».
- `office.palletList.empty` — «Паллет по этим условиям нет» (облако: `pages.pallets.empty`).
- `office.palletList.loadMore` — «Показать ещё» (облако: `pages.pallets.loadMore`).
- `office.palletList.changedAfterClose` — «Состав изменился после закрытия» (облако: `pages.pallets.contentsChangedAfterClose`).
- `office.palletList.table.label` — «Список паллет».
- `office.palletList.table.{sscc,product,shift,line,station,boxes,units,closedAt,state}` — «SSCC», «Товар», «Смена», «Линия», «Станция», «Коробов», «Кодов», «Закрыта», «Состояние» (облако: `pages.pallets.table.*`).
- `office.packs.noSscc` — «Без SSCC» (облако: `pages.pallets.noSscc`).

- [ ] **Шаг 1: красные тесты.**
  - `test/pallet-query.test.ts`:
    - адрес ↔ фильтры туда и обратно;
    - период в зоне `Europe/Moscow`: `from=2026-10-08` → `fromMs = Date.parse("2026-10-07T21:00:00.000Z")`,
      `to=2026-10-08` → `toMs` следующей полуночи;
    - SSCC из 17 цифр → `null`; период назад → `null`;
    - пустые фильтры → `{}`.
  - `test/office-query.test.tsx`: `useOfficeInfiniteQuery` читает первую страницу с
    `cursor = null`, `fetchNextPage` — с `nextCursor` первой, на последней `hasNextPage === false`.
  - `test/registry-tabs.test.tsx`:
    - на `/codes` есть `tablist` «Разделы поиска кодов» с вкладками «Коды», «Короба», «Паллеты»,
      выбрана «Коды», пункт меню «Поиск кодов» подсвечен;
    - стрелка вправо переводит фокус;
    - на «Паллетах» выбрать товар, перейти на «Коды», вернуться — фильтр товара на месте
      (`listPallets` вызван с тем же `product`);
    - на «Паллетах» пункт меню «Поиск кодов» тоже подсвечен.
  - `test/boxes-tab.test.tsx`:
    - без смены — «Выберите смену, чтобы увидеть её короба», `listShiftBoxes` не вызван;
    - в выборе нет запланированной смены и смены проверки (`{ ...CLOSED, mode: "validation" }`);
    - выбор смены вызывает `listShiftBoxes(token, id)`;
    - видны «Линия: …», столбец «Оператор» с «Анна Кузнецова»;
    - клик по строке и Enter на строке ведут на карточку короба (`getBoxCard` вызван с id);
    - клик по ссылке паллеты ведёт на карточку паллеты, а не короба.
  - `test/pallets-tab.test.tsx`:
    - первая страница — `listPallets(token, {}, null)`;
    - выбор товара — `listPallets(token, { product }, null)`;
    - «Показать ещё» — `listPallets(token, { product }, PAGE.nextCursor)`, строки дописываются,
      кнопка пропадает на последней;
    - SSCC «12345» → «SSCC паллеты — 18 цифр» и нового вызова нет;
    - отсканированный `(00)146006820000000402` с префиксом AIM даёт `sscc=146006820000000402`;
    - у паллеты с `boxCountReported 2, boxes 1, closed` — «Состав изменился после закрытия»;
    - станция отозвана — «(отозвана)»;
    - технолог видит страницу (`TECHNOLOGIST`).
  - `test/code-search-page.test.tsx` (поток): вкладки видны над поиском; прежние тесты зелёные.

  Прогон: `pnpm … exec vitest run test/pallet-query.test.ts test/office-query.test.tsx test/registry-tabs.test.tsx test/boxes-tab.test.tsx test/pallets-tab.test.tsx test/code-search-page.test.tsx` — красный.

- [ ] **Шаг 2: реализация** по интерфейсам и описанию выше. Компоненты держат данные в
      `useOfficeQuery`/`useOfficeInfiniteQuery`; эффекты — только для памяти вкладок. Строка
      `Table` открывается `onRowClick` (Enter/пробел встроены в `Table`).
- [ ] **Шаг 3: зелёные тесты (дважды: verbose и под стендом `setImmediate` 3 мс), typecheck, lint,
      prettier.** Коммит — вместе с задачей 6 (см. примечание к маршрутам) или отдельным
      коммитом с маршрутами карточек, закомментированными до задачи 6:
      `feat(standalone): «Поиск кодов» tabs — «Коды / Короба / Паллеты», the pallet list with «Показать ещё»`.

## Задача 6: офис — карточки короба и паллеты, печать, XML паллеты, ссылки из карточки смены и карточки кода

**Files:** Create `src/office/codes/{BoxCardPage,PalletCardPage}.tsx`,
`test/{box-card-page,pallet-card-page}.test.tsx`; Modify `src/office/routes.tsx`,
`src/office/shifts/ShiftCardPage.tsx`, `src/office/codes/CodeCard.tsx`,
`src/office/exports/ExportDialog.tsx`, `src/i18n/ru.json`,
`test/{shift-card,export-dialog,code-search-page}.test.tsx`.

**Interfaces:**

```ts
// ExportDialog.tsx
export interface ExportDialogProps {
  /** An active or closed shift. */
  shift: OfficeShift;
  /**
   * Only this pallet's ЧЗ document (plan КРТ, the pallet's card): the
   * dialog shows its row and its «XML паллеты», not the shift's formats.
   */
  palletId?: string;
  onClose: () => void;
}
```

**Карточка короба (`BoxCardPage`, маршрут `codes/box/:id`)** — облачный `BoxCard.tsx` без
«Заказов на выдачу» (ПР-11):

- «← Назад»: `navigate(-1)`, без истории — `useLastRegistryHref()`.
- `PageHeader` «Короб {{label}}» (`ssccText(sscc)` или «без SSCC»), действия (`RowActions`):
  - «Состав короба» (`PrintFormDialog` с `{ kind: "box", boxId, label }`), пока
    `getShift(card.shift.id)` не прочитан — недоступна;
  - место для «Расформировать» (задача 9).
- Строка состояния: `StatusChip` по `packState` («Открыт»/«Закрыт»/«Расформирован»), «Состав при
  закрытии не сошёлся» (`digestMatches === false` у закрытого), «Расформирован {{at}}».
- `DefinitionGrid`:
  - «Товар», «Смена» (`ShiftLink`), «Дата производства», «Линия», «Станция», «Оператор»;
  - «Открыт», «Закрыт», «Расформирован»;
  - «На паллете» (`PalletLink` или «—»);
  - «Кодов в коробе» (`units`), «Станция насчитала при закрытии» (`itemCountReported`);
  - «Этикетка» (`labelState` словами).
- Раздел «Состав» (`h2`): `Table`, строки — новые сверху.
  - Столбцы: «Код» (`codeText(item)` и ссылка «Открыть карточку кода» на
    `/codes?codeHash=<hash>`), «Добавлен», «Состояние» (`PlacementChip`), «Вышел» (`leftAt` или
    «—»), «Оператор».
  - Строки `removed`/`displaced` — с подсказкой словами в состоянии, не только приглушением.
  - `itemsCapped` — заметка «Показаны первые 10 000 кодов».
- Раздел «Исключения» (`h2`): список `ol`, как история в `CodeCard`.
  - Строка: время — вид («Отмена последнего скана», «Короб очищен», «Перепечатка этикетки»,
    «Расформирование»), причина (`floor.exceptions.reasons.{reprint|disassemble}.<code>`, у
    `other` — слова), у отмены — код (`codeText` строки состава с тем же `codeHash`).
  - Тихая строка: станция, оператор, «получено хостом {{at}}».
  - Пусто — «Исключений нет».
- Раздел «Документы дезагрегации» — только если `documents.length > 0` (задача 8 наполняет).
- Ошибка `not_found` — `EmptyState` «Короб не найден» с подсказкой «Хост знает только короба,
  собранные станциями этой площадки». Иная ошибка — `LoadError`.

**Карточка паллеты (`PalletCardPage`, `codes/pallet/:id`)** — облачный `PalletCard.tsx` без вида
и отказов членства (Р8):

- `PageHeader` «Паллета {{label}}», действия:
  - «Состав паллеты» (`{ kind: "pallet", palletId, label }`);
  - «Ярлык паллеты» (`{ kind: "placard", palletId, label }`, только `hasPlacard`; бумага A4/A5 —
    состояние карточки `useState<PlacardFormat>("a4")`, как в `ShiftCardPage`);
  - «XML паллеты» (`ExportDialog shift palletId`; только у закрытой паллеты с SSCC и смены не
    `planned`; диалог — ленивый импорт, как в карточке смены);
  - место для «Расформировать».
- Строка состояния: `packState` («Открыта»/«Закрыта»/«Расформирована»), «Состав изменился после
  закрытия» (`palletCountDiffers`).
- `DefinitionGrid`: «Товар», «Смена», «Линия», «Станция», «Оператор», «Начата», «Закрыта»,
  «Расформирована», «Коробов стоит» (`boxes`), «Станция насчитала при закрытии»
  (`boxCountReported`), «Кодов» (`units`), «Этикетка».
- Раздел «Короба на паллете»: `Table` — «SSCC короба» (`BoxLink`), «Кодов», «Закрыт»,
  «Состояние» (расформированный — чип «Короб расформирован»). Строка ведёт на карточку короба.
  `membersCapped` — заметка.
- «Исключения» — как у короба («Перепечатка ярлыка», «Разбор паллеты»).
- «Документы дезагрегации» — только непустые.

**Карточка смены (`ShiftCardPage.tsx`):**

- `ShiftBoxes`: SSCC короба (`:401`) → `<BoxLink id={box.id} sscc={box.sscc} />`; «Паллета» →
  `PalletLink` (когда паллета известна).
- `ShiftPallets`: SSCC (`:535`) → `PalletLink`.

Прочее не меняется. План КНФ добавляет в эту же страницу три раздела — конфликт текста, не
логики.

**Карточка кода (`CodeCard.tsx`, поток):**

- `boxLabel`/`palletLabel` остаются текстом. В таблице «Короба» и в строке «Сейчас» столбцы
  «Короб» и «Паллета» рендерят `BoxLink`/`PalletLink` вокруг того же текста
  (`render: (item) => <BoxLink id={item.boxId} sscc={item.boxSscc} />`, у расформированного —
  текст «· расформирован» рядом).
- После РЕЖ у вложения смены проверки `boxId` может стать `null`: тогда ссылки нет, только
  «—». Проверить тип `OfficeCodeItem.boxId` на момент исполнения.

**ExportDialog в режиме паллеты:**

- `palletId` задан → заголовок `«XML паллеты {{sscc}}»` (`office.exports.palletTitle`);
- нет `RadioGroup` форматов, деления на части и кнопки «Сформировать» в подвале;
- список паллет — `plan.plan.pallets.filter((p) => p.palletId === palletId)`;
- паллеты нет в плане (расформирована, нет SSCC) — `Alert` «Эту паллету нельзя выгрузить: …»
  с причиной `refusal`.

Остальное (чтение источника, сохранение, запись в аудит хоста) — без изменений: та же
`exportNow({ id: "pallet_xml_gismt_aggregation", version: 1 }, null, palletId)`.

**Тексты (новые ключи):**

- `office.packs.back` — «← Назад» (облако: `pages.codeSearch.backAction` («← Поиск кодов»)).
- `office.boxCard.title` — «Короб {{label}}».
- `office.boxCard.noSscc` — «без SSCC» (облако: `boxCard.noSscc`).
- `office.boxCard.print` — «Состав короба» (облако: `boxCard.printAction` («Распечатать»)).
- `office.boxCard.fields.{product,shift,productionDate,line,station,operator,openedAt,closedAt,disassembledAt,pallet,units,reported,label}` — «Товар», «Смена», «Дата производства», «Линия», «Станция», «Оператор», «Открыт», «Закрыт», «Расформирован», «На паллете», «Кодов в коробе», «Станция насчитала при закрытии», «Этикетка» (облако: `boxCard.*Label`).
- `office.boxCard.items` — «Состав» (облако: `boxCard.itemsTitle`).
- `office.boxCard.itemsEmpty` — «Короб пуст» (облако: `boxCard.itemsEmpty`).
- `office.boxCard.itemsCapped` — «Показаны первые 10 000 кодов».
- `office.boxCard.table.{code,addedAt,state,leftAt,operator}` — «Код», «Добавлен», «Состояние», «Вышел», «Оператор» (облако: `boxCard.table.*`).
- `office.boxCard.openCode` — «Открыть карточку кода {{code}}» (облако: своё (подпись ссылки)).
- `office.boxCard.exceptions` — «Исключения» (облако: `boxCard.exceptionsTitle`).
- `office.boxCard.exceptionsEmpty` — «Исключений нет» (облако: `boxCard.exceptionsEmpty`).
- `office.boxCard.exception.{undo,clear,reprint,disassemble}` — «Отмена последнего скана», «Короб очищен», «Перепечатка этикетки», «Расформирование» (облако: `boxCard.exceptionKind.*` (облако: «Отмена», «Очистка», «Перепечать», «Расформирование» — у автонома слова поиска кодов)).
- `office.boxCard.exceptionCode` — «код {{code}}».
- `office.boxCard.received` — «получено хостом {{at}}».
- `office.boxCard.notFound` — «Короб не найден».
- `office.boxCard.notHere` — «Хост знает только короба, собранные станциями этой площадки.».
- `office.boxCard.documents` — «Документы дезагрегации» (облако: `boxCard.exceptions…disaggregationDocNo`).
- `office.palletCard.title` — «Паллета {{label}}».
- `office.palletCard.print` — «Состав паллеты» (облако: `palletCard.printAction`).
- `office.palletCard.placard` — «Ярлык паллеты» (облако: `palletCard.placard.title`).
- `office.palletCard.xml` — «XML паллеты» (облако: `PalletExportsSection`).
- `office.palletCard.fields.{product,shift,line,station,operator,openedAt,closedAt,disassembledAt,boxes,reported,units,label}` — «Товар», «Смена», «Линия», «Станция», «Оператор», «Начата», «Закрыта», «Расформирована», «Коробов стоит», «Станция насчитала при закрытии», «Кодов», «Этикетка» (облако: `palletCard.*Label`).
- `office.palletCard.members` — «Короба на паллете» (облако: `palletCard.boxesTitle`).
- `office.palletCard.membersEmpty` — «На паллете нет коробов» (облако: `palletCard.boxesEmpty`).
- `office.palletCard.membersCapped` — «Показаны первые 10 000 коробов».
- `office.palletCard.table.{sscc,units,closedAt,state}` — «SSCC короба», «Кодов», «Закрыт», «Состояние» (облако: `palletCard.table.*`).
- `office.palletCard.boxDisassembled` — «Короб расформирован» (облако: `palletCard.boxDisassembled`).
- `office.palletCard.exception.{reprint,disassemble}` — «Перепечатка ярлыка», «Разбор паллеты» (облако: `palletCard.exceptionKind.*`).
- `office.palletCard.notFound` — «Паллета не найдена».
- `office.exports.palletTitle` — «XML паллеты {{sscc}}».
- `office.exports.palletUnavailable` — «Эту паллету нельзя выгрузить: {{reason}}».

- [ ] **Шаг 1: красные тесты.**
  - `test/box-card-page.test.tsx`. Фикстура `office-box-card.json`, сессия с `getOrg`,
    `getShift`, `listProducts`, `listLines`, `listCounterparties`. Вход — с карточки смены
    кликом по SSCC короба.
    - заголовок «Короб (00)046006820000015000», «Закрыт», «Анна Кузнецова», «На паллете» — ссылка
      «(00)146006820000000402»;
    - «Состав»: три строки по порядку, состояния «Изъят из короба», «Забран другим сканом», «В
      коробе»; во «Вышел» второй — время хоста в зоне Москвы;
    - текста `<GS>`, `Tail` и `\u001d` в документе нет;
    - «Исключения»: «Отмена последнего скана — код 010460068200001321S000003», «Перепечатка
      этикетки (Смазалась при укладке)»;
    - нет раздела «Документы дезагрегации»;
    - «Состав короба» открывает диалог «Состав короба (00)046006820000015000» (`PrintFormDialog`)
      и читает `getBoxReportRows`;
    - ссылка карточки кода ведёт на «Поиск кодов» с `getCodeCard(hash)`;
    - «← Назад» возвращает в карточку смены;
    - `not_found` → «Короб не найден»;
    - технолог видит карточку.
  - `test/pallet-card-page.test.tsx`:
    - два короба, второй с «Короб расформирован», состояние «Состав изменился после закрытия»;
    - «Ярлык паллеты» есть у закрытой с SSCC, у открытой нет;
    - «XML паллеты» открывает диалог «XML паллеты 146006820000000402» с одной паллетой и без
      форматов смены;
    - строка короба ведёт в карточку короба.
  - `test/shift-card.test.tsx`: SSCC короба и паллеты — ссылки на `/codes/box/…` и
    `/codes/pallet/…`; клик открывает карточку (`getBoxCard`/`getPalletCard` вызваны).
  - `test/export-dialog.test.tsx`: с `palletId` нет выбора формата и кнопки «Сформировать», есть
    одна строка паллеты; нажатие «XML паллеты» сохраняет файл и пишет запись, как прежде
    (утверждения прежнего теста паллетного XML переиспользовать).
  - `test/code-search-page.test.tsx`: в карточке кода SSCC короба и паллеты — ссылки, клик
    открывает карточку короба.
- [ ] **Шаг 2: реализация** по описанию. Карточка читает `getBoxCard`/`getPalletCard`
      (`officeKeys.boxCard(id)`, `staleTime` 0) и смену `getShift(card.shift.id)` — только для
      печати. Пока смена не прочитана, кнопки печати `aria-disabled` с подсказкой
      «Загрузка…». Маршруты `box/:id`, `pallet/:id` в `routes.tsx`.
- [ ] **Шаг 3: зелёные тесты (дважды, как в задаче 5), typecheck, lint, prettier, коммит
      задач 5–6**
      `feat(standalone): box and pallet cards in the office, printing and pallet XML from them, links from the shift's and the code's cards`.

## Задача 7: документация и полный прогон ядра (задачи 1–6)

**Files:** Modify `apps/standalone/AGENTS.md`,
`docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md`.

- [ ] **Шаг 1: `AGENTS.md`.**
  - Новый раздел `## Box and pallet cards` после «Shift card and printed forms»:
    - маршруты хоста и их правила: только чтение, один снимок, индексы, без полного кода, без
      аудита;
    - порядок и курсор реестра (`o~<id>`, `<ms>~<id>`), миграция `0025` и предохранитель
      `scans_ok_box`;
    - «Состав изменился после закрытия» = `palletCountDiffers` (Р6);
    - линия — смены (Р5);
    - станции в ответе реестра (Р7);
    - вкладки под `/codes`, память в `CodesSection`;
    - печать через `PrintFormDialog`, XML — `ExportDialog palletId`;
    - поле `documents` и задача 8;
    - что проверено только в jsdom.
  - В «Office pages» — строка о разделе «Поиск кодов» с тремя вкладками.
  - В «Shift card and printed forms» — SSCC в карточке смены ведут в карточки.
  - В «Verification» — новые файлы тестов.
- [ ] **Шаг 2: спецификация.** В §5.3 и в строке КРТ таблицы §8.1 — пометка «план исполнен
      (задачи 1–7), документы ДЗГ и «Расформировать» — задачи 8–9 после ДЗГ/ДЗГ-О», с датой.
- [ ] **Шаг 3: полный прогон** (раздел «Итоговая проверка плана»), `graphify update .`, если
      граф есть. Коммит `docs(standalone): box and pallet cards — AGENTS and the parity spec`.

## Задача 8 (зависит от ДЗГ; можно отрезать): документы дезагрегации в карточках

**Зависимость.** План ДЗГ (`docs/superpowers/plans/2026-10-13-standalone-dzg-disaggregation.md`,
хост `0024_disaggregation.sql`) влит в `claude/integration`. Имена ниже — из этого плана
(задачи 1, 2, 9 ДЗГ):

- `disaggregation_documents`: `id`, `doc_no` (`DSG-YY-NNNN`), `status`
  (`draft | applied | cancelled`), `reason_id`, `applied_at`, `applied_by → office_users`.
- `disaggregation_document_lines`: `document_id`, `box_id`, `pallet_id`, `status`
  (`ok | not_found | not_closed | shift_open | already_disassembled | duplicate`).
  `box_id`/`pallet_id` — то, что строка назвала при последней проверке. Он задан и у строки
  `already_disassembled`, поэтому фильтр `l.status = 'ok'` обязателен: проведённый документ
  состоит только из строк `ok` (Р15 ДЗГ).
- `disaggregation_reasons.name`.
- Индексы `disaggregation_lines_box (box_id) WHERE box_id IS NOT NULL` и
  `disaggregation_lines_pallet (pallet_id) WHERE pallet_id IS NOT NULL`.
- Проведение короба пишет `box_items.removed_at`, `boxes.disassembled_at` — время хоста в форме
  устройства (`facts::rules::device_text`, Р4 ДЗГ) — и строку `code_releases`. Проведение
  паллеты пишет только `pallets.disassembled_at`, короба не трогает (Р5 ДЗГ).
  `box_exceptions`/`pallet_exceptions` проведение не пишет.

**Files:** Modify `host/src/routes/office_cards.rs`, `host/tests/office_cards.rs`,
`src/office/codes/{BoxCardPage,PalletCardPage}.tsx`, `src/i18n/ru.json`, тесты страниц.

- [ ] **Шаг 0: сверка с влитым ДЗГ.** Сравнить влитую миграцию
      (`ls host/migrations | grep -i disaggregation`) и `proto/src/disaggregation.rs` с именами
      выше. Расхождение — в «Отклонения», запросы — по фактическим именам. Проверить, что ДЗГ добавил в `AGENTS.md`
      запрос объединения для читателей истории короба (задача 9 ДЗГ). Условия запросов ниже
      повторяют его ветку `office`.
- [ ] **Шаг 1: красные тесты** (`host/tests/office_cards.rs`, стенд `Yard`).
  - Закрыть смену станции (`close_from_office`).
  - Провести маршрутами ДЗГ два документа: на SSCC короба 1 (`sscc(1500)`) и на SSCC паллеты 2
    (`pallet_sscc(240)`). Последовательность:
    - `POST /v1/office/disaggregation` с `{}`;
    - `PUT …/{id}` с причиной `d15a0000-0000-4000-8000-000000000002` («Неверное количество») и
      `expectedRev`;
    - `POST …/{id}/lines` с `{ "lines": [{ "input": …, "sscc": … }] }`;
    - `POST …/{id}/apply` с `expectedRev`.
  - Третий документ на короб 12 оставить черновиком, четвёртый отменить.

  Проверки:
  - карточка короба 1 — `documents == [{ id, docNo: "DSG-26-0001", appliedAt, reasonName:
"Неверное количество", appliedByName: <имя администратора мастера> }]`; живые строки состава
    `removed` с `leftAt == disassembledAt`; `exceptions` те же, что до проведения (одна
    `undo`);
  - карточка паллеты 2 — свой документ, `disassembledAt` задан, `members` прежние (короба
    паллеты не тронуты, Р5 ДЗГ);
  - карточка короба 12 — `documents == []`: черновик и отменённый не попадают;
  - строка `already_disassembled` другого черновика на тот же короб 1 в `documents` короба 1 не
    попадает;
  - запросы документов идут по `disaggregation_lines_box` / `disaggregation_lines_pallet`
    (`QUERIES` получает `box documents`, `pallet documents`).

  Номер года в `docNo` берётся из часов `TestApp` (год создания по UTC, Р9 ДЗГ). Имя
  администратора — из `support::app::bootstrap_body`.

- [ ] **Шаг 2: реализация.** Тела `box_documents` / `pallet_documents`:

  ```rust
  /// Plan ДЗГ's applied documents that took the box apart: its applied
  /// document's `ok` line names the box (the office branch of the readers'
  /// union, plan ДЗГ task 9). A draft's or a cancelled document's lines and a
  /// line that found the box already taken apart are not.
  pub const BOX_DOCUMENTS_SQL: &str = "SELECT d.id, d.doc_no, d.applied_at, \
       r.name AS reason_name, u.name AS applied_by_name \
       FROM disaggregation_document_lines l \
       JOIN disaggregation_documents d ON d.id = l.document_id AND d.status = 'applied' \
       LEFT JOIN disaggregation_reasons r ON r.id = d.reason_id \
       LEFT JOIN office_users u ON u.id = d.applied_by \
       WHERE l.box_id = ?1 AND l.status = 'ok' ORDER BY d.applied_at, d.id LIMIT ?2";
  /// The same of a pallet (`l.pallet_id`).
  pub const PALLET_DOCUMENTS_SQL: &str = /* BOX_DOCUMENTS_SQL with `l.pallet_id = ?1` */;
  ```

  Имя столбца имени офисного пользователя (`office_users.name`) сверить с
  `host/migrations/0003_office_auth.sql`.

  Офис: раздел «Документы дезагрегации» (`h2`), список «{{docNo}} · проведён {{at}} ·
  {{reason}} · {{who}}». `docNo` — ссылка `Link` на `/disaggregation/:id` (маршрут ДЗГ-О
  `disaggregation/:id`). В составе короба строки, снятые документом, получают тихую подпись
  «по документу {{docNo}}», если `leftAt` равен `disassembledAt` и документ есть. Вид документа
  берётся только из `documents`, без догадок по исключениям. Тексты:
  - `office.packs.documents.item` — «{{docNo}} · проведён {{at}} · {{reason}} · {{who}}»;
  - `office.packs.documents.byDocument` — «по документу {{docNo}}»;
  - `office.packs.documents.open` — «Открыть документ {{docNo}}» (подпись ссылки, как у ДЗГ-О
    «Открыть документ DSG-26-0007»).

- [ ] **Шаг 3: зелёные тесты, fmt, typecheck, коммит**
      `feat(standalone): applied disaggregation documents on the box and pallet cards`. В
      `AGENTS.md` (раздел КРТ) — абзац о документах со ссылкой на запрос объединения ДЗГ.

## Задача 9 (последняя; зависит от ДЗГ и ДЗГ-О; можно отрезать): «Расформировать» в карточках паллеты и короба

**Зависимость.** ДЗГ влит: методы `HostApi` из `src/host/api.ts` (задача 1 ДЗГ) — источник
имён:

```ts
createDisaggregation: (token: string, create: DisaggregationCreate) =>
  Promise<DisaggregationDetail>;
addDisaggregationLines: (token: string, id: string, add: DisaggregationLinesAdd) =>
  Promise<DisaggregationDetail>;
// DisaggregationCreate = { reasonId: string | null; comment: string | null } (both optional on the host)
// DisaggregationLinesAdd = { lines: { input: string; sscc: string | null }[]; import: boolean }
// DisaggregationDetail = { document: DisaggregationDocument; lines: DisaggregationLine[] }
```

ДЗГ-О влит: маршрут `disaggregation/:id` (`DisaggregationDocumentPage`), право кнопки
«Создать документ» — `useCan("planShifts")`.

ДЗГ-О на 2026-10-13 называет методы иначе: `createDisaggregationDocument`,
`addDisaggregationLines(…, { ssccs, source })`. Его согласуют с ДЗГ. КРТ пишет по именам ДЗГ
и в шаге 0 сверяет влитый `api.ts`.

**Files:** Modify `src/office/codes/{BoxCardPage,PalletCardPage}.tsx`, `src/i18n/ru.json`,
`test/{box-card-page,pallet-card-page}.test.tsx`. Страница ДЗГ-О не меняется.

- [ ] **Шаг 0: сверка.** В влитом `src/host/api.ts` и `src/host/disaggregation.ts`: имена
      методов, форма `DisaggregationCreate` и `DisaggregationLinesAdd`, путь страницы документа в
      `routes.tsx`, право кнопки ДЗГ-О. Расхождение — в «Отклонения», код — по фактическим
      именам. Если хост всё же требует причину при создании (`validation_failed` на `reasonId`),
      кнопка ведёт на `/disaggregation` без записи, а SSCC показывается в `Alert` для вставки.
      Это запасной путь, вопрос КРТ-1.
- [ ] **Шаг 1: красные тесты.**
  - Паллета закрыта, с SSCC, не расформирована, смена закрыта, администратор → кнопка
    «Расформировать». Нажатие:
    - вызывает `createDisaggregation(token, { reasonId: null, comment: null })` один раз
      (повторное нажатие во время запроса ничего не шлёт: `loading`);
    - затем `addDisaggregationLines(token, DOC_ID, { lines: [{ input: "146006820000000402",
sscc: "146006820000000402" }], import: false })`;
    - затем открывает страницу документа ДЗГ-О (`getDisaggregation` вызван с `DOC_ID`).
  - Технолог видит и нажимает кнопку так же (Р10 ДЗГ: отказа роли нет).
  - Смена активна → кнопки нет, есть строка «Расформировать можно после закрытия смены» (ПР-1).
  - Паллета расформирована, открыта или без SSCC → кнопки нет.
  - Ошибка создания → `Alert` «Не удалось создать документ дезагрегации: …»
    (`errorMessageKey`), фокус на нём, карточка остаётся, `addDisaggregationLines` не вызван.
  - Черновик создан, а строка не добавилась → `Alert` «Документ {{docNo}} создан, но SSCC не
    добавлен: …» со ссылкой «Открыть документ {{docNo}}». Черновик не удаляется, у ДЗГ нет
    удаления: его можно отменить на странице документа.
  - То же для карточки короба: короб закрыт, не расформирован, с SSCC, смена закрыта.
- [ ] **Шаг 2: реализация.**

  ```ts
  const disassemble = useOfficeMutation(async (api, token, sscc: string) => {
    const created = await api.createDisaggregation(token, { reasonId: null, comment: null });
    try {
      await api.addDisaggregationLines(token, created.document.id, {
        lines: [{ input: sscc, sscc }],
        import: false,
      });
    } catch (error) {
      throw new DraftWithoutLine(created.document, error);
    }
    return created.document;
  });
  // onSuccess: navigate(`/disaggregation/${document.id}`)
  ```

  `DraftWithoutLine` — маленький класс ошибки в `src/office/codes/disassemble.ts` с полями
  `document` и `cause`; `Alert` различает два случая через `instanceof`. Тексты:
  - `office.packs.disassemble` — «Расформировать» (облако `palletCard.disassembleAction`);
  - `office.packs.disassembleAfterClose` — «Расформировать можно после закрытия смены»;
  - `office.packs.disassembleFailed` — «Не удалось создать документ дезагрегации: {{reason}}»
    (облако `palletCard.disassembleError`, «разагрегации» → «дезагрегации», как в остальном
    автономе);
  - `office.packs.disassembleLineFailed` — «Документ {{docNo}} создан, но SSCC не добавлен:
    {{reason}}».

- [ ] **Шаг 3: зелёные тесты (дважды), typecheck, lint, prettier, `AGENTS.md` (раздел КРТ — абзац
      о кнопке), полный прогон, коммит**
      `feat(standalone): «Расформировать» on the pallet and box cards makes a disaggregation draft with the SSCC`.

## Итоговая проверка плана

- `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test --workspace`
  (перед ним — `pnpm … --filter @markiro/standalone build` для крейта оболочки). Если весь
  workspace не помещается в окно песочницы — частями: `-p markiro-proto`,
  `-p markiro-host --test office_cards --test office_pallets --test office_boxes --test office_codes --test office_reports --test foundation`,
  затем остальной `-p markiro-host`, затем `-p markiro-standalone`.
- `cargo fmt --manifest-path <wt>/apps/standalone/Cargo.toml --all -- --check`; сборка без
  предупреждений (`cargo build -p markiro-host 2>&1 | grep -c warning` = 0).
- `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`,
  `… typecheck`, `… lint`.
- `<wt>/node_modules/.bin/prettier --check` на всех тронутых файлах (включая этот план и
  `AGENTS.md`); `git -C <wt> diff --check`.
- `git -C <wt> diff --stat claude/integration...HEAD` — только файлы из «Файлов» (и страница
  ДЗГ-О, если её тронула задача 9).
- Счётчики: тесты Vitest и cargo до и после — в отчёт.

## Проверки владельца

На Windows, на установленной сборке с хостом и хотя бы одной станцией:

1. Офис → «Поиск кодов»: три вкладки «Коды / Короба / Паллеты». Стрелки ←/→ переключают вкладки
   с клавиатуры, фокус виден. Пункт меню «Поиск кодов» подсвечен на всех трёх и в карточках.
2. «Короба»: в выборе смены нет запланированных и смен проверки. Выбрать закрытую смену — видны
   её короба со столбцом «Оператор» и строкой «Линия: …». Клик по строке открывает карточку
   короба.
3. Карточка короба собранной на станции смены, где была «Отмена последнего скана»:
   - изъятый код стоит в составе с «Изъят из короба» и временем;
   - «Исключения» говорят «Отмена последнего скана — код …»;
   - полного кода с криптохвостом на экране нет;
   - «Открыть карточку кода» открывает карточку кода, «← Назад» возвращает в короб.
4. «Состав короба» из карточки короба печатается на офисном принтере так же, как из карточки
   смены (тот же лист, тот же DataMatrix).
5. «Паллеты»: открытые паллеты сверху, закрытые — от новых.
   - Фильтр «Товар», «Линия», «Станция», «Закрыта с/по» сужает список.
   - Отсканировать ярлык паллеты сканером в поле «SSCC паллеты» и нажать «Показать» — одна паллета.
   - На площадке с более чем 100 паллетами «Показать ещё» догружает следующую сотню без повторов.
6. Карточка паллеты, где после закрытия расформировали короб: «Состав изменился после закрытия»,
   короб в списке с «Короб расформирован».
   - «Ярлык паллеты» A4 и A5 печатается тем же листом, что из карточки смены.
   - «XML паллеты» сохраняет файл в «Документы\Markiro\Выгрузки» и открывает папку.
   - Файл принимается ЛК ЧЗ, как файл из карточки смены (внешняя проверка).
7. Карточка смены: SSCC короба и паллеты — ссылки в карточки.
8. Технолог видит все три вкладки и обе карточки.
9. После ДЗГ-О (задача 9): «Расформировать» у закрытой паллеты закрытой смены открывает новый
   черновик документа. В нём уже есть строка этой паллеты со статусом «ok»; после выбора причины
   документ проводится. У паллеты активной смены кнопки нет, есть строка «после закрытия смены».
   После проведения карточки короба и паллеты показывают документ в «Документах дезагрегации»
   (задача 8).
10. Время реестра на реальной базе площадки (год работы): первая страница и «Показать ещё»
    открываются без заметной задержки (меньше секунды). Если дольше — сообщить: записать в
    «Отклонения» замер и план запроса.

## Открытые вопросы

- **КРТ-1 (решён по ДЗГ).** ДЗГ создаёт черновик без причины (причина обязательна только при
  проведении), поэтому «Расформировать» создаёт черновик, сразу добавляет строку с SSCC и
  открывает документ (Р11). Запасной путь (переход к списку и SSCC в подсказке) остаётся только
  на случай, если влитый ДЗГ разойдётся со своим планом.
- **КРТ-2.** Показывать ли в составе короба полный код с криптохвостом, как облако? **По
  умолчанию — нет** (Р2): полный текст есть в карточке кода, на одну ссылку дальше.
- **КРТ-3.** Нужен ли в реестре паллет фильтр по смене и столбец «Вид»? **По умолчанию — нет**:
  паллеты смены есть в её карточке, складских паллет у автонома нет до ТСД (Р8).
- **КРТ-4.** Признак «Состав изменился после закрытия» — по счёту станции (Р6) вместо облачных
  серверных времён. **По умолчанию — по счёту**: один признак с карточкой смены, без зависимости
  от часов.

## Риски

- **Конфликт с РЕЖ (Р16).** План РЕЖ пересоздаёт в `0020` индексы поиска кодов под устаревшим
  списком (`box_items_box` вместо `scans_ok_box`). Без предохранителя `0025` после РЕЖ карточка
  короба и поиск кодов по коробу и паллете читали бы весь `scans` (тест плана запросов поиска
  кодов упал бы). Передать контроллеру: РЕЖ должен пересоздавать `scans_ok_box`. КРТ всё равно
  держит `IF NOT EXISTS`.
- **Индекс по выражению и сравнение строк.** Планировщик SQLite может не взять
  `pallets_list_order` для `(…) < (?6, ?7)`. Запасной путь и замер описаны в задаче 4, шаг 3.
- **Порядок слияния.** КРТ правит файлы потока «Поиск кодов» (`CodeSearchPage.tsx`,
  `CodeCard.tsx`, `code-query.ts`, `office_codes.rs` — одна видимость). Начинать до его слияния
  нельзя (задача 1, шаг 0).
- **Общие файлы с КНФ, ТОВ, ДЗГ, ДЗГ-О:** `ru.json`, `routes.tsx`, `server.rs`,
  `routes/mod.rs`, `proto/src/lib.rs`, `src/host/api.ts`, `test/support/office.tsx`,
  `ShiftCardPage.tsx` (КНФ добавляет разделы), `ExportDialog.tsx` (КНФ трогает
  `export-checks.ts`, может и диалог). Конфликты текста, не логики.
- **КНФ и ИСТ ссылаются на карточки КРТ.** КНФ: `loserBoxLink` после слияния КРТ меняется на
  `/codes/box/:id` (Global Constraints). ИСТ: перенесённые короба должны открываться. Если ИСТ
  кладёт историю в свои таблицы, карточки их не увидят — это вопрос ИСТ, не КРТ.
- **Имена ДЗГ-О расходятся с ДЗГ** (`createDisaggregationDocument`, `{ ssccs, source }`). КРТ
  пишет по ДЗГ; если ДЗГ-О не согласуют до слияния, задача 9 шагом 0 возьмёт фактические имена.
- **`ExportDialog` в режиме паллеты читает источник всей смены** (до 200 000 кодов) и проверяет
  все форматы ради одной паллеты. Это медленно на большой смене, но не неверно. Отдельный
  маршрут XML одной паллеты — вне плана.

## Не проверено

- Ни одна команда не запускалась: план — документ. Имена потока «Поиск кодов» прочитаны в его
  рабочем дереве на 2026-10-13 (коммиты `7ff64eab6`, `9796384c6`) и могут измениться до слияния.
- Задачи 8–9 сверены с планами ДЗГ и ДЗГ-О на 2026-10-13, не с кодом: оба ещё не исполнены.
  ДЗГ-О может измениться при согласовании с ДЗГ. Каждая задача начинается со сверки с влитым
  кодом.
- Использует ли планировщик SQLite индекс по выражению для сравнения строк — не проверено.
- Номера серий SSCC второй станции в стенде и форма факта `pallet_exception` в стенде —
  предположения, проверяются первым прогоном.
- Поведение `Select searchable` с сотнями вариантов (список смен) и `DataTabs` в WebView2 — только
  jsdom; визуальная проверка — владельцу.

## Отклонения при исполнении

_(заполняет исполнитель)_
