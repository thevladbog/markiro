# План РЕЖ: режимы смены в автономной станции — «Агрегация» и «Проверка», у «Проверки» флажок «Печатать дубликат Data Matrix» (выбор в офисе, хост, протокол, база станции, работа на линии, закрытие, выгрузки) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Владелец на первой бете: «в смене не вижу выбор режима (проверка, проверка с перепечатью, агрегация)». В облаке у смены два режима (`validation`, `aggregation`), а у режима проверки — политика печати дубликата Data Matrix (`validationPrint`: без печати или `duplicate_dm` с обязательной или необязательной проверкой отпечатка). Автономный продукт несёт столбец `mode` с этапа 2a, но хост принимает только агрегацию (`check_mode`, решение 6 спецификации 2a), офис его не показывает, а станция не ветвится по режиму. После плана офис при планировании смены выбирает один из двух режимов — «Агрегация» или «Проверка»; у «Проверки» появляется флажок «Печатать дубликат Data Matrix», а под ним — шаблон этикетки продукции и «Обязательная проверка этикетки» (как в облачном кабинете и на облачной станции). Хост принимает и замораживает режим и политику, станция работает по режиму: в «Проверке» каждый скан КМ проверяется (формат, GTIN товара, дубль на станции и на хосте) и принимается без короба, SSCC и паллет; в «Проверке» с включённым флажком на каждую принятую единицу печатается этикетка с тем же полным кодом (Data Matrix), с проверкой отпечатка сканом, пропуском проверки, перепечаткой с причиной и неизвестным исходом без самоповтора — как в облачной станции. Закрытие считает принятые коды, выгрузки по смене проверки — плоские TXT/CSV.

**Architecture:** План делится на две части, которые можно утвердить по отдельности.

- **Часть A — «Проверка» без печати (задачи A1–A9, протокол 4).** Протокол: тело входа в смену `ShiftEnter { supports }`, скан `ok` без короба в смене проверки, фикстуры. Хост: миграция `0020_validation_scans.sql` перестраивает `scans` и `code_owners` (короб у принятого скана становится необязательным; правило «скан агрегации — в коробе» держит триггер по режиму смены); `check_mode` принимает `validation`; правила смены проверки (без паллет); вход старой станции в смену проверки — отказ `station_update`; факты: принятый скан смены проверки без короба, реестр владельцев без `box_items`, коробочные и паллетные факты в смене проверки — `invalid_record`; итоги и источник выгрузки. Станция: миграция оболочки `0014_floor_validation.sql` перестраивает `floor_codes` и `floor_scans`; путь скана без короба, экран проверки, закрытие без коробов; блоки SSCC не запрашиваются. Офис: выбор режима «Режим работы» (два пункта) в диалоге смены, итоги и выгрузки по режиму.
- **Часть B — флажок печати дубликата (задачи B1–B8, протокол 5).** Политика `validationPrint` в формах смены и в снимке (шаблон назначения «Дубликат товара» замораживается целиком), миграция хоста `0021_validation_print.sql` (столбцы политики через `ALTER TABLE … ADD COLUMN`, след печати `unit_label_events`), вид факта `unit_label`, миграция оболочки `0015_floor_unit_labels.sql` (задания этикеток единиц), логика по доменной машине состояний `@markiro/domain/product-labels` (`productLabelStatus`, `applyProductLabelEvent`, `parseDuplicateKm`, `compareDuplicateKm`, `productLabelBytesDigest`), окно проверки отпечатка, запрет закрытия при нерешённой этикетке, флажок «Печатать дубликат Data Matrix» под «Проверкой» с раскрытием шаблона и обязательности проверки и счётчики печати в карточке смены.
- **Часть C — вне плана (решение владельца):** повторная обработка кодов из прошлых смен (`allowPreviouslyAcceptedCodes`), выбор режима при создании смены на станции, режимы на ТСД.

**Tech Stack:** Rust (axum, sqlx 0.8.6, serde) — `host`, `proto`, `src-tauri`; React 19.2, TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4.4.3, i18next, `@markiro/ui` (`Select`, `Checkbox`, `Alert`, `Badge`, `Button size="floor"`), `@markiro/domain` (`classifyScan`, `validateShiftScan`, `product-labels/*`, `print-forms/shift-task-form`, `shift-exports`), Vitest 4 с jsdom и `node:sqlite` за `LocalExecutor`.

**Спецификации и источники:**

- `docs/superpowers/specs/2026-09-26-standalone-station-design.md` — §2 (решение владельца 2026-09-26: «валидация с печатью дубликата DM» входит в первую версию), §10.1–10.2, §12.3 критерий 3, §13 этап 3 «Валидация и дубликат DM» (L, 4–6 тыс. строк).
- `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` — решение 6 «Режимы»: столбцы есть с 2a, хост принимает только агрегацию, «этапы 2b и 3 снимают запрет без новой формы протокола». Этот план показывает, что новая форма всё же нужна (см. Р3, Р4).
- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` — §2 (ответы владельца 2026-10-09: «Вне пилота — валидация и дубликат DM (этап 3)»), §4.2 («Что клиент теряет: режим «Проверка» и печать дубликатов»); новый раздел 32 пишет задача A9.
- Облако, образец поведения: `apps/admin/src/pages/shifts/ShiftForm.tsx` (выбор режима и печати), `apps/api/src/modules/shifts/{dto.ts,validation-print-policy.ts,shifts.service.ts}`, `apps/api/src/modules/station-scans/{station-scans.service.ts,product-label-events.ts}`, `packages/db/src/schema/{platform.ts,product-labels.ts}`, `apps/station/src/pages/WorkScreen.tsx`, `apps/station/src/lib/product-labels/{acceptance.ts,printing.ts,recovery.ts,fields.ts}`, `apps/station/src/lib/use-product-label-work.ts`, `apps/station/src/ui/work/ProductLabelVerification.tsx`, `apps/station/src/lib/shift-close.ts`, `docs/acceptance/validation-dm-duplicate.md`.
- `apps/standalone/AGENTS.md`: «Databases», «Local database», «Facts», «Floor work», «Floor printing», «Floor exceptions and close», «Warehouse reprint» (печать кода единицы уже есть: `renderLabel(..., { kmDataMatrix: "raster" })`, назначение принтера `duplicate`), «Verification».

## Что есть сегодня (проверено по коду ветки `claude/integration`, `a4eef5cd6`)

- Хост: `host/migrations/0009_shifts_sscc_blocks.sql:31` — `mode TEXT NOT NULL CHECK (mode IN ('aggregation','validation'))`; `host/src/routes/office_shifts.rs:224-234` `check_mode` отказывает всему, кроме агрегации (`validation_failed`, поле `mode`), на создании и правке; `host/src/shifts.rs:337` вставляет смену всегда с `ShiftMode::Aggregation`; `host/migrations/0010_facts.sql:50` — `CHECK ((verdict = 'ok') = (box_id IS NOT NULL))` у `scans`, `:118` — `code_owners.box_id NOT NULL`; `FactShift` (`host/src/facts/mod.rs:119-129`) режима не знает.
- Протокол: `ShiftMode` (`proto/src/lib.rs:1526-1553`, по умолчанию `Aggregation`) в `OfficeShift`, `ShiftCreate`, `ShiftUpdate`, `DeviceShift`; в `DeviceShiftCreate` и `ShiftSnapshot` режима нет; все фикстуры с `mode` — `"aggregation"`; `PROTOCOL_VERSION = 3`. Возможности устройства при подключении принимаются, но не читаются (станция шлёт пустой список, `src-tauri/src/device.rs:291,356`); у `Hello` возможностей нет; хост не знает версию протокола станции в запросе.
- Zod: `shiftModeSchema` (`src/host/protocol.ts:611`); `shiftCreate()` (`src/host/requests.ts:390-411`) всегда шлёт `mode: "aggregation"`.
- Офис: в `src/office/shifts/ShiftDialog.tsx` и `shift-form.ts` поля режима нет; режим только показывается (`ShiftsPage.tsx:64-67,220-222`, `ShiftCardPage.tsx:235-237`); «Бланк смены» передаёт `mode` и жёстко `validationPrintMode: "none"` (`src/office/forms/form-data.ts:180-208`).
- Станция: `floor_shifts.mode TEXT NOT NULL` (`src-tauri/migrations/0006_floor_production.sql:49`) пишется из копии смены и показывается бейджем «Проверка» (`src/floor/shifts/ShiftCard.tsx:79`); `scan-pipeline.ts`, `WorkScreen.tsx`, `box-close.ts`, `shift-close.ts` по режиму не ветвятся — смену проверки станция открыла бы и собирала бы в короба. `floor_codes.box_id NOT NULL`, `floor_scans` — тот же CHECK `ok ⇔ box_id`; `floor_print_jobs.purpose IN ('box','pallet')` и `sscc` 18 цифр.

## Решения владельца (2026-10-13, ответы на вопросы первой редакции плана)

- Режимы входят в пилот, обе части — A и B.
- Режим — поле **смены** (не линии); после открытия смены режим не меняется.
- Режим по умолчанию — «Агрегация».
- Повторная обработка кодов прошлых смен и выбор режима при создании смены на станции — позже (часть C).
- Шаблон короба остаётся полем смены проверки (не печатается).
- Обязательная проверка этикетки по умолчанию **выключена**, её включает администратор при планировании (в облаке по умолчанию включена — сознательное отличие).
- **Правка UX: третьего режима нет.** В выборе «Режим работы» ровно два пункта — «Агрегация» и «Проверка». При выбранной «Проверке» появляется флажок печати дубликата, а под ним — то, что к нему относится (шаблон этикетки продукции, обязательность проверки), как в облаке. Модель данных частей A/B не меняется: `mode = validation` + `validationPrint.mode = duplicate_dm`.

## Допущения

Планировщик принимает решения сам; вопросы владельцу — в конце.

- **Р1 — режим на смену, а не на линию.** Как в облаке: режим и политика печати — поля смены, задаются при планировании, меняются только пока смена запланирована; при открытии замораживаются; в активной смене не меняются (`conflict` на `shift_status`, как сегодня у прочих полей).
- **Р2 — два режима и флажок под «Проверкой» (решение владельца 2026-10-13).** В офисе — `RadioGroup` из `@markiro/ui` (как поле режима облачного кабинета, `apps/admin/src/pages/shifts/ShiftForm.tsx:681-704`; офис автонома уже использует `RadioGroup` и `Checkbox`). Подпись — «Режим работы» (слова владельца; в кабинете — «Режим», на облачной станции — «Режим смены»), пункты в порядке облака: «Проверка», «Агрегация»; выбран по умолчанию «Агрегация». При «Проверке» под выбором появляется `Checkbox` «Печатать дубликат Data Matrix» (точная подпись флажка облачной станции, `apps/station/src/pages/NewShift.tsx:833`, ключ `shifts.printDuplicate`; кабинет показывает тот же выбор радиокнопками «Печать этикетки: Без печати / Дублировать Data Matrix» — владелец выбрал флажок). При включённом флажке раскрывается секция «Печать дубликата» (заголовок кабинета `pages.shifts.duplicate.title`): `Select` «Шаблон этикетки продукции» и `Checkbox` «Обязательная проверка этикетки» с подсказкой под ним. На проводе — облачная пара полей (`mode` + `validationPrint`), чтобы формы и фикстуры совпадали с облаком. Полная таблица текстов, порядка, умолчаний, раскрытия и сбросов — Р16.
- **Р3 — короб принятому скану больше не обязателен: перестройка двух таблиц хоста.** SQLite не снимает CHECK и `NOT NULL` без перестройки. Альтернатива — отдельные таблицы владельцев для проверки — раздваивает правило «самый ранний скан владеет кодом» между режимами (облачный реестр один на арендатора и для агрегации, и для проверки: код, проверенный в одной смене, нельзя собрать в короб другой). Поэтому `0017` перестраивает `scans` и `code_owners` по процедуре SQLite (новая таблица, перенос строк, `DROP`, `RENAME`) внутри транзакции миграции sqlx под `PRAGMA defer_foreign_keys = ON` (внешние ключи `box_items`, `code_owners`, `code_conflicts` на `scans(id)` проверяются при фиксации, когда таблица уже на месте под прежним именем). Правило «принятый скан агрегации — в коробе» переезжает в триггер `scans_ok_box_by_mode` (по `shifts.mode`). Индексы `scans_record`, `scans_shift`, `scans_code_hash` пересоздаются. Таблица `shifts` не перестраивается.
- **Р4 — у смены проверки остаётся шаблон короба.** `shifts.box_template_id NOT NULL` и обязательный `ShiftSnapshot.box_template` не трогаем (иначе — перестройка `shifts`, на которую ссылается почти всё). Облако тоже показывает шаблон короба в режиме проверки без печати. В офисе поле остаётся с подсказкой «В режиме проверки этикетки коробов не печатаются»; умолчание шаблона подставляется как сегодня. `issuerPrefix` в снимке тоже остаётся (GLN у организации автонома есть всегда); блоки SSCC смена проверки не запрашивает.
- **Р5 — старая станция не входит в смену проверки.** Хост не знает протокол станции, а станция протокола 3 смену проверки собрала бы в короба. Вход (`POST /v1/device/shifts/{id}/enter`) получает необязательное тело `ShiftEnter { supports: string[] }`; смена проверки требует `"validation-v1"` (часть B — ещё `"validation-dm-duplicate-v1"` при печати), иначе `409 conflict`, `details.field = "station_update"`, станция говорит «Обновите приложение станции». Запрос без тела (старая станция) — пустой список. Агрегация входит как раньше. Хост и станция ставятся одним установщиком, но на ПК станции обновление может отстать.
- **Р6 — протокол растёт: 4 в части A, 5 в части B.** Новый смысл скана (`boxId: null` при `ok`) и новое тело входа — версия 4; новый вид факта `unit_label` — версия 5 (правило комментария к `FactKind`). `MIN_PROTOCOL_VERSION` остаётся 1: старая станция работает с новым хостом в агрегации.
- **Р7 — старые очереди совместимы.** Записи протокола 3 (скан с `boxId`, все коробочные виды) принимаются как сегодня. Скан `ok` без короба принимается только в смене проверки, в смене агрегации — `invalid_record` на `data.boxId` (как сегодня). Коробочные и паллетные факты в смене проверки — `invalid_record` с полем `shift_mode`. `shift_closed` смены проверки обязан нести `closedBoxCount = 0`.
- **Р8 — дубль: локально, затем хост, затем арбитраж — как в агрегации.** Путь скана не меняется до места «положить в короб»: `readScan` → GTIN товара → `floor_codes` (дубль `local`) → `checkCode` хоста при связи (дубль `host`) → принять. В «Проверке» принятый код пишется в `floor_codes` с `box_id = NULL`, факт `scan` — с `boxId: null`. Хост: `registry::claim` с `box_id: Option<&str>`; для проверки строка `box_items` не пишется; вытеснение раннего владельца работает как сегодня (вытеснение коробочного владельца сканом проверки снимает его строку `box_items`).
- **Р9 — исключения в «Проверке».** В облаке «Отмена последнего скана» и прочие коробочные исключения есть только в агрегации; в режиме проверки без печати исключений нет. Здесь так же: кнопка «Исключения» в смене проверки не показывается (часть B добавляет историю этикеток с перепечаткой).
- **Р10 — закрытие.** Станция закрывает смену проверки так же (причины домена при расхождении с планом), `actualQty` — число кодов смены в `floor_codes`, `closedBoxCount = 0`, запрета «открыт короб» нет. Сверки нет (в облаке её нет и для проверки). Часть B: нерешённая этикетка единицы запрещает закрытие (`label_unresolved`), как `PRODUCT_LABEL_UNRESOLVED` облачной станции; офисное закрытие не ограничено (как в облаке).
- **Р11 — итоги и выгрузки.** `ShiftTotals.acceptedUnits` для смены проверки — число строк `code_owners` смены с `box_id IS NULL`; коробов и паллет — 0. Выгрузки: диалог офиса предлагает для смены проверки только плоские TXT и CSV (`shift_txt_flat`, `shift_csv_flat`); источник выгрузки хоста (`export-source`) для смены проверки отдаёт коды владельцев смены без коробов; форматы с коробами, паллетами и XML агрегации для неё не предлагаются (облако их предлагает и падает асинхронно — здесь честнее).
- **Р12 — печать дубликата (часть B) — по доменной машине облака, без грантов.** Состояния попытки и задания, события и правила (`prepared → sending → sent | delivery_unknown`, `failed_before_send`; задание `awaiting_verification`, `completed`, `attention`; проверка `not_required | pending | verified | skipped`; перепечатка с причиной `not_printed | damaged | lost` теми же байтами и с той же датой; неизвестный исход не повторяется сам; пропуск — только после `sent`) берутся из `packages/domain/src/product-labels/{contracts,state,km}.ts`. Офлайн-гранты облака (`shift.label.prepare.v1`) в автономе не нужны. Приём единицы и создание задания — одна транзакция `local_transaction` (скан, `floor_codes`, задание, запись в `outbox`); пока задание не завершено и проверка обязательна, следующий скан идёт в проверку отпечатка, а не в приём.
- **Р13 — след печати на хосте — факты.** Задание принадлежит смене, в которую станция вошла, поэтому след идёт видом факта `unit_label` (одна запись на событие задания), хост хранит его в `unit_label_events` и считает в карточке смены (отправки, проверки, нерешённые, перепечатки). Полный код в записи не передаётся — только `codeHash`, `payloadDigest`, `bytesDigest`.
- **Р14 — снимок несёт политику.** Часть B добавляет `ShiftSnapshot.validationPrint: Option<{ verification, template: ShiftSnapshotTemplate }>` (`#[serde(default)]`, как требует комментарий к снимку). Предел снимка 327 680 байт уже включает логотип (до 87 384 символов) и шаблон короба; шаблон дубликата добавляет свой макет — отказ `snapshot_too_large` возможен при больших макетах (см. «Риски»).
- **Р15 — миграции (распределение проверено 2026-10-13).** База — `claude/integration` `578906ef2`: хост `0001`–`0012`, `0015`, `0016` (следующий свободный — `0017`), оболочка `0001`–`0010`, `0012`, `0013` (следующий свободный — `0014`; пропуск `0011` не занимать). Ветки обратной связи на момент проверки (`git branch --list 'claude/fb-*'` и их рабочие деревья):

  | Поток                                                                                             | Хост                                                                                  | Оболочка | Где                                            |
  | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------- | ---------------------------------------------- |
  | fb-people                                                                                         | `0017_employees.sql`                                                                  | —        | закоммичено в `claude/fb-people`               |
  | fb-templates                                                                                      | `0017_pallet_sheet_defaults.sql`                                                      | —        | не закоммичено, `/tmp/claude/wt/fb-templates`  |
  | fb-codesearch                                                                                     | `0017_code_search.sql` (индексы `box_items_box`, `scans_ok_gtin`, `scans_ok_scanned`) | —        | не закоммичено, `/tmp/claude/wt/fb-codesearch` |
  | fb-about, fb-hub, fb-license, fb-login, fb-misc, fb-parity, fb-station, fb-ui, fb-window, fb-work | —                                                                                     | —        | миграций нет                                   |

  Три потока заняли один номер хоста `0017`. Предлагаемое распределение (решает контроллер; номер берётся в порядке слияния в интеграцию): fb-people — `0017` (уже закоммичено), fb-templates — `0018`, fb-codesearch — `0019`, РЕЖ — хост `0020_validation_scans.sql` (часть A) и `0021_validation_print.sql` (часть B); оболочка — `0014_floor_validation.sql` (часть A) и `0015_floor_unit_labels.sql` (часть B), других претендентов нет. sqlx применяет недостающие младшие миграции позже, тесты журнала сверяют версии `MIGRATOR`. **Перед задачей A2 исполнитель заново смотрит `ls apps/standalone/{host,src-tauri}/migrations` в интеграции и в ветках `claude/fb-*`; если номер занят — берёт следующий свободный и пишет это в «Отклонения».**

- **Р16 — тексты и поведение формы — копия облака.** Источник — кабинет (`apps/admin/src/pages/shifts/ShiftForm.tsx`, `apps/admin/src/i18n/ru.json` `pages.shifts.*`) и облачная станция (`apps/station/src/pages/NewShift.tsx`, `apps/station/src/i18n/ru.json` `shifts.*`, `productLabels.*`). Новые ключи офиса — в `office.shifts.*` автонома, слова те же:

  | Ключ автонома                                    | Текст                                                                                                                             | Источник в облаке                                                               |
  | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
  | `office.shifts.fields.mode`                      | «Режим работы»                                                                                                                    | решение владельца (кабинет: «Режим», станция: «Режим смены»)                    |
  | `office.shifts.modes.validation`                 | «Проверка» (сегодня «Валидация» — меняется; ожидание `test/shifts-page.test.tsx:698-710` правится как смена продуктового решения) | станция `shifts.modeValidation`                                                 |
  | `office.shifts.modes.aggregation`                | «Агрегация»                                                                                                                       | `pages.shifts.form.modeAggregation`                                             |
  | `office.shifts.duplicate.print`                  | «Печатать дубликат Data Matrix»                                                                                                   | станция `shifts.printDuplicate`                                                 |
  | `office.shifts.duplicate.copyHint`               | «На внешнюю упаковку переносится полный код с продукции. Количество продукции не меняется.»                                       | `pages.shifts.duplicate.copyHint` / `shifts.printCopyHint`                      |
  | `office.shifts.duplicate.title`                  | «Печать дубликата»                                                                                                                | `pages.shifts.duplicate.title`                                                  |
  | `office.shifts.duplicate.template`               | «Шаблон этикетки продукции»                                                                                                       | `pages.shifts.duplicate.template`                                               |
  | `office.shifts.duplicate.templatePlaceholder`    | «Выберите шаблон»                                                                                                                 | `pages.shifts.duplicate.templatePlaceholder`                                    |
  | `office.shifts.duplicate.templateOption`         | «{{name}} · {{widthMm}} × {{heightMm}} мм · {{dpi}} dpi»                                                                          | `pages.shifts.duplicate.templateOption`                                         |
  | `office.shifts.duplicate.templateRequired`       | «Выберите шаблон этикетки продукции»                                                                                              | `pages.shifts.duplicate.templateRequired`                                       |
  | `office.shifts.duplicate.noTemplates`            | «Для этого продукта нет доступных шаблонов дубликата. Добавьте или включите подходящий шаблон в библиотеке этикеток.»             | `pages.shifts.duplicate.noTemplates`                                            |
  | `office.shifts.duplicate.verification`           | «Обязательная проверка этикетки»                                                                                                  | `pages.shifts.duplicate.verification`                                           |
  | `office.shifts.duplicate.requiredHint`           | «Оператор должен отсканировать новую этикетку перед следующей единицей.»                                                          | `pages.shifts.duplicate.requiredHint`                                           |
  | `office.shifts.duplicate.noneHint`               | «После отправки на принтер можно сканировать следующую единицу»                                                                   | `pages.shifts.duplicate.noneHint` (в кабинете без точки — скопировать как есть) |
  | `office.shifts.duplicate.frozen`                 | «Параметры печати и проверки зафиксированы при открытии смены.»                                                                   | `pages.shifts.duplicate.frozen`                                                 |
  | `office.shifts.duplicate.frozenTemplate`         | «Шаблон зафиксирован при открытии смены»                                                                                          | `pages.shifts.duplicate.frozenTemplate`                                         |
  | `office.shifts.fields.boxTemplateValidationHint` | «В режиме проверки этикетки коробов не печатаются»                                                                                | своё (решение владельца: шаблон короба остаётся)                                |

  Порядок в диалоге (как в кабинете): товар → «Режим работы» → флажок «Печатать дубликат Data Matrix» (только при «Проверке»; пока флажок выключен, под ним подсказка `copyHint`, как на облачной станции) → планирование (дата, план) → линия, контрагент → секция «Печать дубликата» (только при включённом флажке): шаблон, «Обязательная проверка этикетки», подсказка `requiredHint`/`noneHint` по состоянию флажка проверки, подсказка `copyHint` (у активной смены — `frozen`) → шаблон короба (при «Проверке» — с подсказкой `boxTemplateValidationHint`) → вместимость короба и паллеты (только при «Агрегации»; в кабинете — секция «Агрегация»).

  Умолчания: режим «Агрегация»; флажок печати выключен; шаблон пуст; «Обязательная проверка этикетки» **выключена** (решение владельца; кабинет и станция облака — включена).

  Раскрытие и сбросы (копия `onValueChange` кабинета, `ShiftForm.tsx:693-731`, и `onChange` станции, `NewShift.tsx:828-831`): выбор «Агрегации» прячет флажок и выключает его, очищает шаблон, сбрасывает «Обязательную проверку» к умолчанию (выкл.) и снимает ошибку шаблона; выбор «Проверки» снимает ошибку шаблона короба по агрегации и прячет паллеты; выключение флажка печати очищает шаблон и снимает его ошибку (обязательность проверки, как в кабинете, сохраняется до смены режима); у активной смены режим, флажок, шаблон и проверка только показываются (недоступны), шаблон — именем из снимка (`frozenTemplate`).

  Проверки при сохранении (как `submit` кабинета, `ShiftForm.tsx:390-420`): «Проверка» с флажком без шаблона — ошибка поля шаблона `templateRequired` и фокус на нём; список шаблонов пуст — `Alert` `noTemplates` (информационный), сохранение с флажком невозможно; шаблон, ставший недоступным, — пункт «Шаблон недоступен — обновите данные» недоступным (как у шаблона короба, `pages.shifts.form.boxLabelTemplateUnavailable`). Полезная нагрузка (как `toPayload`, `ShiftForm.tsx:1162-1173`): «Агрегация» — `validationPrint: { mode: "none" }`; «Проверка» без флажка — `{ mode: "none" }`; с флажком — `{ mode: "duplicate_dm", templateId, verification: verificationRequired ? "required" : "none" }`; правка активной смены `validationPrint` не шлёт.

  Тексты цеха (часть B) — `floor.unitLabels.*` автонома = облачный `productLabels.*` дословно: `title` «Дубликат Data Matrix», `scanTitle` «Отсканируйте напечатанную этикетку», `scanHint`, `requiredHint`, `noneHint`, `unknownHint`, `preparedHint`, `failedHint`, `verified` «Этикетка подтверждена», `sent` «Отправлено на принтер», `unknown` «Печать требует уточнения», `failedBeforeSend` «Этикетка не отправлена», `mismatch` «Код не совпадает», `invalid` «Не удалось прочитать полный Data Matrix», `labelProblem` «Проблема с этикеткой», `skip` «Пропустить проверку», `skipHint` «Пропуск сохранится в журнале. Этикетка останется непроверенной.», `skipped` «Проверка пропущена», `pause` «Пауза», `retry` «Повторить», `reprint` «Напечатать повторно», `reprintTitle` «Повторная печать этикетки», `reasonHint` «Укажите причину повторной печати», `reasons.not_printed` «Этикетка не напечатана», `reasons.damaged` «Этикетка повреждена», `reasons.lost` «Этикетка потеряна», `sendPrepared` «Отправить сохранённую этикетку», `printerSetup` «Настройки принтера» (в автономе ведёт в «Рабочее место»), `history` «История этикеток», `attempt` «Попытка {{count}}» (переменная переименовывается в `number`: правило автонома — переменные текстов именованные, не `count`), `emptyHistory`, `closeBlocked` «Сначала завершите сохранённые задания печати этой смены.», `closedHint`, `storageError`, `anotherShift`.

## Global Constraints

**Правила продукта**

- Офлайн-первым: приём кода, задание этикетки, состояние `sending` и неизвестный исход переживают перезапуск; неизвестный исход никогда не отправляется повторно сам.
- Идемпотентная синхронизация: запись с тем же `id` и тем же содержанием — та же квитанция; с другим — `payload_mismatch`.
- Разделитель GS1 `\u001d` и криптохвост сохраняются; дубль — по `codeHash` (без криптохвоста), печать — полный `canonical`. Полный код не попадает в URL, журналы (`tracing`, `console.*`) и записи на хост.
- Три идентичности не смешиваются: режим выбирает офисный пользователь (технолог или администратор), работает оператор (PIN/бейдж), запись делает устройство.
- Применённые миграции не меняются: хост `0001`–`0016`, оболочка `0001`–`0013`.

**Код и процесс**

- TypeScript strict: без `any`, приведений и `!`; именованные экспорты, `import type`.
- Офис — `@markiro/ui` (`Select`, `Checkbox`), мышь и клавиатура; цех — `size="floor"` (64 px), состояние словами, не только цветом.
- Тексты — `src/i18n/ru.json` (английского файла в `apps/standalone` нет — проверить `ls apps/standalone/src/i18n`), ключи уникальны.
- Каждый новый SQL на растущей таблице (`floor_codes`, `floor_scans`, `floor_unit_labels`) закреплён планом в `test/floor-schema.test.ts` **и** `src-tauri/tests/local_db.rs`, тексты побайтно совпадают.
- Формы на проводе — фикстуры `proto/fixtures`, которые читают Rust (`proto/tests/*.rs`) и Vitest (`test/protocol.test.ts`).
- Rust: `cargo fmt` чистый, без предупреждений; `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml` не меняются; `apps/station`, `apps/api`, `packages/*` не меняются (облако — только образец).
- Коммиты — явные пути, трейлер одной строкой `Co-Authored-By: …`; push и PR — не в этом плане.

## Заметки для исполнения

- Worktree от `claude/integration` (`a4eef5cd6` или новее). Зависимости — клоны APFS из `/tmp/claude/wt/integ` (`cp -c -R -P` для `node_modules`, `apps/standalone/node_modules`, `packages/*/node_modules`, `packages/*/dist`); для cargo — ещё `apps/standalone/target`.
- pnpm: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false …`; `pnpm install`/`add` не запускать. Cargo: `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml …`. Перед `cargo test -p markiro-standalone` — `pnpm … --filter @markiro/standalone build` (`tauri::generate_context!` читает `dist`).
- Тесты хоста на `TestApp` сокета не открывают; интеграционные тесты с loopback требуют отключённой песочницы.
- React-тесты экранов (A7, A8, B6, B7) — один раз `--reporter=verbose` без `stderr |` и один раз под стендом с задержкой `setImmediate` на 3 мс (временные `test/delayed-immediate.setup.ts` и `vitest.delay.config.ts`, как в плане СКЛ; удалить после прогона).
- Если обёртка `rtk` урезала вывод — `rtk proxy <команда>`.

## Файлы

- Часть A, создать: `apps/standalone/host/migrations/0020_validation_scans.sql`; `apps/standalone/src-tauri/migrations/0014_floor_validation.sql`; `apps/standalone/proto/fixtures/{shift-create-validation,office-shift-validation,device-shift-entered-validation,shift-enter,shift-enter-empty,fact-scan-validation}.json`; `apps/standalone/host/tests/validation_shifts.rs`; `apps/standalone/src/floor/work/ValidationPanel.tsx`; `apps/standalone/test/{validation-scan,validation-screen,shift-mode-select}.test.ts(x)`.
- Часть A, изменить: `proto/src/lib.rs`, `proto/tests/*.rs`; `host/src/routes/{office_shifts,device_shifts,office_exports}.rs`, `host/src/shifts.rs`, `host/src/facts/{mod,scan,registry,box_closed,pallet*,shift_closed}.rs`, `host/tests/{office_shifts,device_shifts,facts,backup_schema}.rs`; `src-tauri/src/local_db.rs`, `src-tauri/tests/local_db.rs`; `src/host/{protocol,requests,api}.ts`; `src/floor/shifts/{shift-entry,shift-copies}.ts`, `src/floor/work/{scan-pipeline,WorkScreen,block-supply,work-reads}.ts(x)`, `src/floor/close/shift-close.ts`; `src/office/shifts/{ShiftDialog.tsx,shift-form.ts,ShiftTotalsDialog.tsx,ShiftCardPage.tsx}`, `src/office/exports/export-plan.ts`; `src/i18n/ru.json`; тесты `test/{protocol,shift-dialog,shift-form,shifts-page,shift-copies,floor-schema,floor-app,export-plan}.test.ts(x)`; `apps/standalone/AGENTS.md`; спецификация пилота (раздел 32).
- Часть B, создать: `host/migrations/0021_validation_print.sql`, `host/src/facts/unit_label.rs`, `host/tests/unit_labels.rs`; `src-tauri/migrations/0015_floor_unit_labels.sql`; `src/floor/unit-labels/{unit-label-store,unit-label-work,unit-label-render}.ts`, `src/floor/unit-labels/{UnitLabelPanel,UnitLabelVerification,UnitLabelHistory}.tsx`; фикстуры `proto/fixtures/{validation-print-*,fact-unit-label-*}.json`; тесты `test/unit-label-*.test.ts(x)`.

---

## Часть A — «Проверка» без печати

## Задача A1: протокол 4 — вход с возможностями, скан проверки, фикстуры

**Files:** Modify `apps/standalone/proto/src/lib.rs`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/requests.ts`, `apps/standalone/src/host/api.ts`; Create фикстуры (6), тесты в `proto/tests/shifts.rs` и `test/protocol.test.ts`.

**Interfaces:**

- Rust: `pub const PROTOCOL_VERSION: u32 = 4;` `pub mod shift_supports { pub const VALIDATION: &str = "validation-v1"; pub const VALIDATION_DM_DUPLICATE: &str = "validation-dm-duplicate-v1"; }` (второе — объявить сейчас, хост проверяет его в части B). `#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)] pub struct ShiftEnter { #[serde(default)] pub supports: Vec<String> }`. Документация `ScanFact.box_id`: «`ok` в смене агрегации — короб; `ok` в смене проверки — `null`».
- TS: `shiftEnterSchema = z.strictObject({ supports: z.array(z.string().min(1).max(64)).max(32) })`, `SHIFT_SUPPORTS = { validation: "validation-v1", validationDmDuplicate: "validation-dm-duplicate-v1" } as const`; `HostApi.enterShift(id, enter: ShiftEnter)`; `shiftCreate(input)` берёт `mode` из `ShiftInput.mode` (по умолчанию `"aggregation"`).

- [ ] **Шаг 1: фикстуры (сначала, красные тесты читают их).** `shift-create-validation.json` — как `shift-create.json`, но `"mode": "validation"`, без паллет; `office-shift-validation.json` — `OfficeShift` с `"mode": "validation"`, итоги с `closedBoxes: 0`; `device-shift-entered-validation.json` — `DeviceShift` со снимком; `shift-enter.json` — `{ "supports": ["validation-v1"] }`; `shift-enter-empty.json` — `{}`; `fact-scan-validation.json` — запись `scan` с `verdict: "ok"`, `code`, `boxId: null`.
- [ ] **Шаг 2: красные тесты.** Rust: каждая фикстура читается и пишется без потерь; `ShiftEnter` из `{}` — пустой список; лишнее поле — ошибка. Vitest: те же фикстуры через Zod; `shiftCreate({ ...input, mode: "validation" })` шлёт `mode: "validation"`; без `mode` — `"aggregation"` (существующие ожидания `test/shift-dialog.test.tsx:207-228` не меняются). Прогон: `cargo --offline --locked test --manifest-path …/apps/standalone/Cargo.toml -p markiro-proto` и `pnpm … --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts` — падают.
- [ ] **Шаг 3: реализация** типов, Zod, `requests.ts`, `api.ts` (тело входа `{ supports: [SHIFT_SUPPORTS.validation] }` всегда — станция части A умеет проверку).
- [ ] **Шаг 4: зелёные тесты, `cargo fmt --check`, typecheck, коммит** `feat(standalone): protocol 4 — shift entry capabilities and box-less validation scans`.

## Задача A2: хост — миграция `0020_validation_scans.sql`

**Files:** Create `apps/standalone/host/migrations/0020_validation_scans.sql` (номер — по Р15); Modify `apps/standalone/host/tests/backup_schema.rs` (или новый `host/tests/migration_validation_scans.rs`).

- [ ] **Шаг 1: красный тест миграции.** База на предыдущей миграции (после слияния fb-people/fb-templates/fb-codesearch — на `0019`) с данными: смена агрегации, короб, три скана (`ok`, `duplicate`, `invalid`), владелец, конфликт; применить `MIGRATOR`; проверить: все строки на месте побайтно (`SELECT * … ORDER BY id`), `PRAGMA foreign_key_check` пуст, `PRAGMA integrity_check = ok`, индексы `scans_record`, `scans_shift`, `scans_code_hash` и (если fb-codesearch уже влит) `scans_ok_gtin`, `scans_ok_scanned` есть с прежним текстом — тест сравнивает `SELECT name, sql FROM sqlite_master WHERE tbl_name IN ('scans','code_owners')` до и после; `INSERT` скана `ok` без короба в смене агрегации — `ABORT` (`scan_needs_box`), в смене проверки — проходит; `code_owners` с `box_id NULL` — проходит.
- [ ] **Шаг 2: миграция.**

<!-- prettier-ignore -->
```sql
-- Validation shifts (plan РЕЖ, part A): an accepted scan of a validation
-- shift has no box. SQLite drops neither a CHECK nor a NOT NULL without a
-- rebuild, so `scans` and `code_owners` are rebuilt; the rule "an accepted
-- scan of an aggregation shift names its box" moves to a trigger keyed by
-- the shift's mode. The foreign keys of box_items, code_owners and
-- code_conflicts on scans(id) are checked at commit, when `scans` is back
-- under its own name.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE scans_rebuilt (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices (id),
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  verdict TEXT NOT NULL CHECK (verdict IN ('ok', 'duplicate', 'wrong_gtin', 'invalid')),
  duplicate_source TEXT CHECK (duplicate_source IS NULL OR duplicate_source IN ('local', 'host')),
  raw_kind TEXT NOT NULL CHECK (raw_kind IN ('km', 'gtin', 'sscc', 'unknown')),
  raw_length INTEGER NOT NULL CHECK (raw_length >= 0),
  code_hash TEXT,
  gtin14 TEXT,
  serial TEXT,
  canonical TEXT,
  box_id TEXT REFERENCES boxes (id),
  operator_id TEXT,
  scanned_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  CHECK ((verdict = 'invalid') = (code_hash IS NULL)),
  CHECK (box_id IS NULL OR verdict = 'ok'),
  CHECK ((verdict = 'duplicate') = (duplicate_source IS NOT NULL)),
  CHECK ((verdict = 'invalid') = (raw_kind <> 'km')),
  CHECK ((code_hash IS NULL) = (gtin14 IS NULL) AND (code_hash IS NULL) = (serial IS NULL)
    AND (code_hash IS NULL) = (canonical IS NULL)),
  CHECK (code_hash IS NULL OR length(code_hash) = 64)
);
INSERT INTO scans_rebuilt SELECT id, record_id, device_id, shift_id, verdict, duplicate_source,
  raw_kind, raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, scanned_at,
  received_at FROM scans;
DROP TABLE scans;
ALTER TABLE scans_rebuilt RENAME TO scans;
CREATE UNIQUE INDEX scans_record ON scans (device_id, record_id);
CREATE INDEX scans_shift ON scans (shift_id);
CREATE INDEX scans_code_hash ON scans (code_hash) WHERE code_hash IS NOT NULL;
-- The code search indexes of fb-codesearch (its migration precedes this one):
-- DROP TABLE dropped them with the old table.
CREATE INDEX scans_ok_gtin ON scans (gtin14, scanned_at) WHERE verdict = 'ok';
CREATE INDEX scans_ok_scanned ON scans (scanned_at) WHERE verdict = 'ok';

CREATE TRIGGER scans_ok_box_by_mode BEFORE INSERT ON scans
WHEN NEW.verdict = 'ok' AND NEW.box_id IS NULL
  AND (SELECT mode FROM shifts WHERE id = NEW.shift_id) <> 'validation'
BEGIN SELECT RAISE(ABORT, 'scan_needs_box'); END;

CREATE TABLE code_owners_rebuilt (
  code_hash TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL UNIQUE REFERENCES scans (id),
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  box_id TEXT REFERENCES boxes (id),
  scanned_at TEXT NOT NULL
);
INSERT INTO code_owners_rebuilt SELECT code_hash, scan_id, shift_id, device_id, box_id, scanned_at
  FROM code_owners;
DROP TABLE code_owners;
ALTER TABLE code_owners_rebuilt RENAME TO code_owners;
CREATE INDEX code_owners_shift_unboxed ON code_owners (shift_id) WHERE box_id IS NULL;
```

- [ ] **Шаг 2а: стык с поиском кодов (fb-codesearch).** Если поток поиска кодов влит раньше, его миграция идёт раньше по номеру и два индекса выше пересоздаются здесь после `DROP TABLE`; если не влит — эти два `CREATE INDEX` из миграции убираются (их создаст его миграция), а тест сравнения `sqlite_master` ловит расхождение. Маршрут поиска (`routes/office_codes.rs`) должен показывать принятый скан смены проверки без короба — тест в задаче A5.
- [ ] **Шаг 3: проверить на копии**, что sqlx выполняет `PRAGMA defer_foreign_keys` внутри своей транзакции (тест шага 1 с `PRAGMA foreign_keys = ON` у пула). Если тест журнала или проверка «нет PRAGMA в миграциях» существует — расширить её этой миграцией с объяснением. Проверить объекты `sqlite_master`, чьё тело упоминает `scans` или `code_owners` (триггеры из `0012`): после `RENAME` при `legacy_alter_table = OFF` они указывают на новую таблицу — закрепить тестом.
- [ ] **Шаг 4: время.** Тест-замер на 1 млн строк `scans` (только в `--ignored`): записать время в «Отклонения»; служба хоста применяет миграцию при старте.
- [ ] **Шаг 5: зелёные тесты, коммит** `feat(standalone): host migration 0020 — box-less accepted scans for validation shifts`.

## Задача A3: хост — смены проверки в офисе

**Files:** Modify `host/src/routes/office_shifts.rs`, `host/src/shifts.rs`; Modify `host/tests/office_shifts.rs` (ожидания `:508` и `:873` меняются — продуктовое решение изменилось, записать в отчёт).

- [ ] **Шаг 1: красные тесты.** Создание `mode: "validation"` — 200, строка с `mode = 'validation'`, строка `audit_log` `shift.create` с `mode` в деталях; `validation` + `palletsEnabled: true` — `validation_failed` на `palletsEnabled`; правка запланированной смены `mode: aggregation → validation` с включёнными паллетами — `validation_failed`, с выключенными — 200 и `details.changed` содержит `mode` с `{ from, to }`; правка `mode` у активной — `conflict` на `shift_status`; станционное создание (`DeviceShiftCreate`) — всегда агрегация (без изменений).
- [ ] **Шаг 2: реализация.** `check_mode` → `check_mode_rules(mode, pallets_enabled)`; `NewShift` получает `mode`; `insert` биндит `mode.as_str()`; `update` пишет `mode`.
- [ ] **Шаг 3: зелёные, коммит** `feat(standalone): host takes validation shifts from the office`.

## Задача A4: хост — вход в смену проверки только для станции, которая её умеет

**Files:** Modify `host/src/routes/device_shifts.rs`; tests `host/tests/device_shifts.rs`.

- [ ] **Шаг 1: красные тесты.** Вход без тела в смену проверки — `409 conflict`, `details.field = "station_update"`, смена остаётся `planned`, ревизии нет; с `{ "supports": ["validation-v1"] }` — открывается, снимок есть; вход в агрегацию без тела и с телом — как сегодня; тело с лишним полем — `validation_failed`; список `GET /v1/device/shifts` смены проверки отдаёт (станция части A их показывает).
- [ ] **Шаг 2: реализация** — необязательное `ApiJson<ShiftEnter>` (тело без `Content-Type` — пустое, как правило axum в AGENTS.md); проверка до заморозки снимка.
- [ ] **Шаг 3: зелёные, коммит** `feat(standalone): only a station that knows validation enters a validation shift`.

## Задача A5: хост — факты, итоги и источник выгрузки смены проверки

**Files:** Modify `host/src/facts/mod.rs` (`FactShift.mode`), `facts/scan.rs`, `facts/registry.rs`, `facts/box_*.rs`, `facts/pallet_*.rs`, `facts/shift_closed.rs`, `routes/office_shifts.rs` (итоги), `routes/office_exports.rs`; tests `host/tests/facts.rs`, `host/tests/validation_shifts.rs`.

- [ ] **Шаг 1: красные тесты.** (а) скан `ok` без `boxId` в смене проверки — `accepted`, строка `scans` с `box_id NULL`, владелец с `box_id NULL`, `box_items` пуст; (б) тот же код позже с другой станции в смене агрегации — `conflict`, `code_conflicts` с победителем-проверкой; (в) ранний скан проверки вытесняет коробочного владельца — строка `box_items` получает `displaced_at`; (г) скан `ok` с `boxId` в смене проверки — `invalid_record` `data.boxId`; (д) `box_closed`, `box_label`, `box_exception`, `pallet_*` в смене проверки — `invalid_record`, поле `shift_mode`; (е) `shift_closed` с `closedBoxCount: 1` в смене проверки — `invalid_record`; (ж) повтор пакета — те же квитанции; (ж2) если поиск кодов (fb-codesearch) влит — поиск по коду смены проверки находит скан без короба; (з) `GET /v1/office/shifts/{id}` смены проверки — `acceptedUnits` = число владельцев смены без короба, `closedBoxes = 0`; (и) `export-source` смены проверки — коды владельцев смены (порядок по `scanned_at`, затем `scan_id`), без коробов.
- [ ] **Шаг 2: реализация.** `registry::Claim.box_id: Option<&str>`; итоги: `accepted_units` = `CASE shifts.mode WHEN 'validation' THEN (SELECT COUNT(*) FROM code_owners o WHERE o.shift_id = shifts.id AND o.box_id IS NULL) ELSE <как сегодня> END` — закрепить план запроса по индексу `code_owners_shift_unboxed`.
- [ ] **Шаг 3: зелёные, `cargo test -p markiro-host`, коммит** `feat(standalone): host facts, totals and export source of validation shifts`.

## Задача A6: база станции — миграция `0014_floor_validation.sql`

**Files:** Create `src-tauri/migrations/0014_floor_validation.sql`; Modify `src-tauri/tests/local_db.rs`, `test/floor-schema.test.ts`, `test/local-executor.test.ts`.

- [ ] **Шаг 1: красные тесты** (оба движка: node:sqlite 3.53 и оболочка 3.46): строки `floor_codes`/`floor_scans` переживают миграцию; `floor_codes` с `box_id NULL` вставляется; `floor_scans` `ok` без короба вставляется, `duplicate` с коробом — отказ; планы запросов `floor_codes_box`, `floor_codes_shift`, `floor_scans_shift` прежние; новый запрос счёта кодов смены проверки — по `floor_codes_shift`.
- [ ] **Шаг 2: миграция** — перестройка `floor_codes` (`box_id TEXT`, прежний PK и оба индекса) и `floor_scans` (`CHECK (box_id IS NULL OR verdict = 'ok')`, индекс `floor_scans_shift`) по той же схеме (`*_rebuilt`, перенос, `DROP`, `RENAME`); внешних ключей и триггеров у этих таблиц нет (проверено: `grep TRIGGER src-tauri/migrations`). Правило «агрегация — в коробе» держит код станции (`scan-pipeline.ts`), как и прочие правила станции.
- [ ] **Шаг 3: класс таблиц** в забывании (`clear_copies`/`device_forget`) не меняется — обе остаются `DeviceData`; проверить список таблиц в `local-executor.test.ts`.
- [ ] **Шаг 4: зелёные, коммит** `feat(standalone): shell migration 0014 — box-less codes and scans`.

## Задача A7: станция — работа в смене проверки

**Files:** Modify `src/floor/shifts/shift-entry.ts`, `src/floor/work/scan-pipeline.ts`, `src/floor/work/WorkScreen.tsx`, `src/floor/work/block-supply.ts`, `src/floor/close/shift-close.ts`, `src/floor/work/work-reads.ts`; Create `src/floor/work/ValidationPanel.tsx`; tests `test/validation-scan.test.ts`, `test/validation-screen.test.tsx`, `test/floor-app.test.tsx`.

**Interfaces:** `runScan(context, raw)` — для `shift.copy.mode === "validation"` возвращает `{ kind: "accepted", boxId: null, acceptedCount }` вместо коробочного исхода; `ScanOutcome` расширяется вариантом `accepted` с `boxId: string | null`. `ValidationPanel({ accepted, duplicates, errors, plannedQty, lastOutcome })`.

- [ ] **Шаг 1: красные тесты пути скана** (`node:sqlite` за `LocalExecutor`): принятый код смены проверки — `floor_codes.box_id IS NULL`, `floor_scans` `ok` без короба, запись `outbox` `scan` с `boxId: null`, `floor_boxes` пуст; второй скан того же кода — `duplicate` `local`; код, известный хосту, — `duplicate` `host`; чужой GTIN — `wrong_gtin`; не КМ — `invalid`; смена агрегации — как сегодня (существующие тесты не меняются).
- [ ] **Шаг 2: красные тесты экрана.** Вход в смену проверки шлёт `supports: ["validation-v1"]`; отказ `station_update` — экран «Обновите приложение станции» и возврат к списку; на экране смены проверки — панель «Проверка»: «Принято N из плана M», последние исходы словами («Принят», «Повтор: код уже принят в смене …», «Чужой товар», «Не код маркировки»), без карточки короба, этикетки, паллеты и кнопки «Исключения»; при достижении плана — предложение закрыть смену (как в облаке); блоки SSCC не запрашиваются (`block-supply` для смены проверки ничего не делает); закрытие — `actualQty` = число кодов смены, `closedBoxCount: 0`, запрета «открыт короб» нет, причина при расхождении с планом — домен.
- [ ] **Шаг 3: реализация.** Ветка в `WorkScreen` по `shift.copy.mode` — одна точка выбора панели (как `issuerPrefix`/`productLabels.work` в облаке), без раздвоения экрана; очередь работы и `track` — как сегодня (N9/N13).
- [ ] **Шаг 4: тексты** `floor.validation.*` в `ru.json`.
- [ ] **Шаг 5: зелёные (с `--reporter=verbose` и стендом задержки), коммит** `feat(standalone): the station works a validation shift`.

## Задача A8: офис — выбор режима, итоги, выгрузки

**Files:** Modify `src/office/shifts/shift-form.ts`, `ShiftDialog.tsx`, `ShiftTotalsDialog.tsx`, `ShiftCardPage.tsx`, `src/office/exports/export-plan.ts`, `src/i18n/ru.json`; tests `test/shift-form.test.ts`, `test/shift-dialog.test.tsx`, `test/shift-mode-select.test.tsx`, `test/export-plan.test.ts`.

- [ ] **Шаг 1: красные тесты.** `shiftFieldsSchema` получает `mode: z.enum(["aggregation", "validation"])`; `newShiftFields` — `"aggregation"`; `toShiftInput` передаёт `mode` и `validationPrint: { mode: "none" }` (флажок печати придёт в части B); при `validation` — `pallets: null` и поля паллет не проверяются; `toShiftChange` шлёт `mode` только если он изменился. Диалог (`test/shift-mode-select.test.tsx`): `RadioGroup` «Режим работы» (`getByRole("radiogroup", { name: "Режим работы" })`) с пунктами в порядке «Проверка», «Агрегация», выбран «Агрегация»; стоит сразу после товара (порядок Р16); выбор «Проверка» прячет вместимость короба и «Паллеты» и показывает у шаблона короба подсказку «В режиме проверки этикетки коробов не печатаются»; возврат на «Агрегацию» возвращает поля паллет с прежними значениями формы; у активной смены оба пункта недоступны (`disabled`) и показывают сохранённый режим; клавиатура: Tab в группу, стрелки меняют выбор, видимый фокус. Бейдж в списке смен и в карточке — «Проверка» (ключ `office.shifts.modes.validation` меняет «Валидация» на «Проверка»; ожидание `test/shifts-page.test.tsx:698-710` правится — смена продуктового решения). Итоги смены проверки: «Принято кодов», без коробов и паллет. Выгрузки: для `mode = validation` — только `shift_txt_flat`, `shift_csv_flat`.
- [ ] **Шаг 2: реализация** через `RadioGroup` из `@markiro/ui` (уже используется офисом, например `src/office/exports/ExportDialog.tsx`), без своих стилей; тексты — ключи Р16.
- [ ] **Шаг 3: браузерная проверка** — dev-сервер webview (`pnpm … --filter @markiro/standalone dev`, хост замокан фикстурами Vitest/Playwright, как в соседних планах); скриншоты диалога в обоих режимах.
- [ ] **Шаг 4: зелёные, коммит** `feat(standalone): the office plans a shift as aggregation or validation`.

## Задача A9: документы, паритет с облаком, итоговые проверки части A

- [ ] **Шаг 1: золотые проверки паритета** (Vitest, без изменения облака): (а) вердикты — одна таблица сырых сканов (`packages/domain` фикстуры сканов, в том числе AIM-префикс, GS, чужой GTIN, SSCC, бейдж) даёт те же вердикты в `readScan`+GTIN автонома и в `validateShiftScan` домена; (б) «Бланк смены» смены проверки — `taskFormData` даёт заголовок «Проверка», как облачный `apps/api/test/standalone-forms-parity.test.ts`; (в) плоская выгрузка TXT/CSV смены проверки из источника хоста байт в байт совпадает с `packages/domain/src/shift-exports.ts` на тех же кодах.
- [ ] **Шаг 2: документы.** `apps/standalone/AGENTS.md` — раздел «Shift modes» (режим на смену, вход с возможностями, правило короба по режиму в триггере, исключений нет, выгрузки плоские); раздел 32 спецификации пилота уточнить по факту исполнения.
- [ ] **Шаг 3: гейты.** `pnpm … --filter @markiro/standalone test`, `typecheck`, `lint`, `build`; `cargo --offline --locked test --manifest-path …/Cargo.toml --workspace` (частями, если целиком не помещается); `cargo fmt --check`; `prettier --check` по изменённым файлам; `git diff --check`.
- [ ] **Шаг 4: коммит** `docs(standalone): shift modes, part A`.

---

## Часть B — флажок «Печатать дубликат Data Matrix» под «Проверкой»

## Задача B1: протокол 5 — политика печати, снимок, факт `unit_label`

**Interfaces:**

- Rust: `ValidationPrint` (`#[serde(tag = "mode", rename_all = "snake_case")]`: `None`, `DuplicateDm { verification: LabelVerification, template_id: String }`), `LabelVerification { None, Required }`; поле `validation_print: Option<ValidationPrint>` (`#[serde(default)]`) в `ShiftCreate`, `ShiftUpdate`, `OfficeShift`, `DeviceShift`; `ShiftSnapshot.validation_print: Option<SnapshotValidationPrint { verification, template: ShiftSnapshotTemplate }>`; `FactKind::UnitLabel` и `UnitLabelFact { job_id, code_hash, attempt_no, event: UnitLabelEvent, reason: Option<ReprintReason>, error_code: Option<String>, payload_digest, bytes_digest, at }`, где `UnitLabelEvent` — `prepared | sending | sent | failed_before_send | delivery_unknown | verified | verification_rejected | verification_skipped` (имена доменного `productLabelEventSchema`); `PROTOCOL_VERSION = 5`.
- TS: зеркала; значения перечислений берутся из `@markiro/domain` (`ReprintReason`, состояния), фикстуры общие с Rust.

- [ ] Фикстуры: `shift-create-validation-print.json` (`mode: validation`, `validationPrint: { mode: "duplicate_dm", templateId, verification: "none" }` — умолчание владельца), `office-shift-validation-print.json`, `device-shift-entered-validation-print.json` (снимок несёт `validationPrint` с шаблоном целиком и `verification`), `fact-unit-label-{prepared,sent,verified,skipped,unknown,reprint}.json`.
- [ ] Красные тесты обеих сторон: каждая фикстура читается и пишется без потерь; `validationPrint` при `mode: aggregation` и `duplicate_dm` без `templateId` — отказ Zod (а хост — в B3); снимок без `validationPrint` (снимок, замороженный до части B) читается как `None` — повторный вход в старую смену не ломается; снимок смены с печатью несёт ту же политику, что смена (`verification`, `template.id = validationPrint.templateId`).
- [ ] Реализация → коммит `feat(standalone): protocol 5 — validation print policy and unit label facts`.

## Задача B2: хост — миграция `0021_validation_print.sql`

<!-- prettier-ignore -->
```sql
ALTER TABLE shifts ADD COLUMN validation_print_mode TEXT NOT NULL DEFAULT 'none'
  CHECK (validation_print_mode IN ('none', 'duplicate_dm'));
ALTER TABLE shifts ADD COLUMN validation_print_verification TEXT
  CHECK (validation_print_verification IS NULL OR validation_print_verification IN ('none', 'required'));
ALTER TABLE shifts ADD COLUMN validation_print_template_id TEXT;
-- The cloud's shifts_validation_print_policy_check, held by triggers (a CHECK
-- across columns cannot be added without a rebuild).
CREATE TRIGGER shifts_validation_print_insert BEFORE INSERT ON shifts
WHEN NOT ((NEW.validation_print_mode = 'none' AND NEW.validation_print_verification IS NULL
           AND NEW.validation_print_template_id IS NULL)
       OR (NEW.mode = 'validation' AND NEW.validation_print_mode = 'duplicate_dm'
           AND NEW.validation_print_verification IS NOT NULL
           AND NEW.validation_print_template_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'validation_print_policy'); END;
-- … the same BEFORE UPDATE OF mode, validation_print_mode, validation_print_verification,
-- validation_print_template_id.
CREATE INDEX shifts_planned_duplicate_template ON shifts (validation_print_template_id)
  WHERE status = 'planned' AND validation_print_template_id IS NOT NULL;

CREATE TABLE unit_label_events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices (id),
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  job_id TEXT NOT NULL,
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  event TEXT NOT NULL CHECK (event IN ('prepared', 'sending', 'sent', 'failed_before_send',
    'delivery_unknown', 'verified', 'verification_rejected', 'verification_skipped')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('not_printed', 'damaged', 'lost')),
  error_code TEXT,
  payload_digest TEXT NOT NULL,
  bytes_digest TEXT NOT NULL,
  at TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE UNIQUE INDEX unit_label_events_record ON unit_label_events (device_id, record_id);
CREATE INDEX unit_label_events_shift ON unit_label_events (shift_id, job_id);
```

- [ ] Тесты миграции (данные `0020` переживают, триггеры отказывают несогласованной политике, `template_in_use` учитывает шаблон дубликата запланированной смены) → миграция → коммит.

## Задача B3: хост — политика в офисе, заморозка, факты `unit_label`

- [ ] Создание и правка запланированной смены: `validationPrint` только при `mode = validation` (иначе `validation_failed` на `validationPrint`), шаблон — назначения `product_duplicate`, включён, `templates::fits` категории товара (`validation_failed` на `validationPrint.templateId`); правка политики у активной — `conflict`; переход в агрегацию сбрасывает политику только если прислано `validationPrint: { mode: "none" }` (как облако, иначе `validation_failed`).
- [ ] Вход: смена с печатью требует `supports` с `validation-dm-duplicate-v1` (`station_update`); снимок замораживает шаблон дубликата целиком (`SnapshotValidationPrint`), предел 327 680 байт — прежний `snapshot_too_large`.
- [ ] Факт `unit_label`: смена проверки с печатью, не `planned`; станция вошла в смену; принятый скан того же `code_hash` этой станции в этой смене есть (`subject_unknown` иначе — новый код квитанции, добавить в `fact-receipt-codes.json` и `FACT_RECEIPT_CODES`); идемпотентность по `(device_id, record_id)` и дайджесту; после закрытия — `late_data_at`. Аудита нет (факты — производственные данные).
- [ ] Итоги карточки: `ShiftTotals.unitLabels: Option<{ sent, verified, skipped, unresolved, reprints }>` (только для смены с печатью; `unresolved` — задания, последнее событие которых не `verified`/`verification_skipped`/(`sent` при `verification = none`)).
- [ ] Коммит `feat(standalone): host validation print policy and unit label facts`.

## Задача B4: база станции — миграция `0015_floor_unit_labels.sql`

- [ ] Таблица `floor_unit_labels` (`id`, `host_id`, `device_id`, `shift_id`, `code_hash`, `scan_id`, `attempt_no`, `attempt_state` `prepared|sending|sent|failed_before_send|delivery_unknown`, `verification` `not_required|pending|verified|skipped`, `reason`, `error_code`, `printer` JSON, `bytes_base64`, `bytes_digest`, `payload_digest`, `template_rev`, `fields` JSON, `operator_id`, `created_at`, `updated_at`; CHECK-и по образцу `floor_print_jobs`: байты есть в `sending|sent|delivery_unknown`, `error_code` ⇔ `failed_before_send|delivery_unknown`); частичный уникальный индекс «одно нерешённое задание на смену и устройство»; индекс по смене; полный код хранится только в `fields` (как `wh_jobs.fields` плана СКЛ) и удаляется при очистке закрытой смены.
- [ ] Планы запросов в обоих тестах схемы; класс `DeviceData`; коммит.

## Задача B5: станция — логика этикетки единицы

**Interfaces:** `src/floor/unit-labels/unit-label-work.ts`: `acceptWithLabel(context, scan)` (одна транзакция: `floor_scans`, `floor_codes`, `floor_unit_labels` `prepared`, запись `outbox` `scan` + `unit_label` `prepared`), `sendUnitLabel(job)` (`sending` до передачи, `PrintRuntime.send`, `sent` или `delivery_unknown`; несовпадение принтера, языка или dpi — `failed_before_send`), `verifyUnitLabel(job, raw)` (`compareDuplicateKm`; несовпадение — `verification_rejected`), `skipVerification(job)` (только из `sent` + `pending`), `reprintUnitLabel(job, reason)` (новая попытка теми же байтами), `recoverUnitLabels()` (`sending` без живой отправки → `delivery_unknown` `interrupted`, ничего не отправляется), `canAcceptNext(job)` — по `productLabelStatus` домена.

- [ ] Красные тесты на каждое правило `docs/acceptance/validation-dm-duplicate.md` («Зафиксированное поведение») и на таблицу переходов `buildProductLabelFixtures` домена (золотой паритет машины состояний); рендер — `renderLabel(template, fields, { kmDataMatrix: "raster" })` по шаблону из снимка, поля `boxLabelFields`-аналога облачного `apps/station/src/lib/product-labels/fields.ts` (`qty = 1`, `sscc = ""`); код без криптохвоста — отказ `parseDuplicateKm` до приёма.
- [ ] Коммит `feat(standalone): unit label printing, verification and recovery`.

## Задача B6: станция — экран

- [ ] Панель этикетки единицы и окно проверки (по образцу `ProductLabelVerification.tsx` облака): заголовок «Отсканируйте напечатанную этикетку», кнопки «Проблема с этикеткой», «Пропустить проверку» (только после `sent`; подсказка «Пропуск сохранится в журнале. Этикетка останется непроверенной.»), «Пауза», «Напечатать повторно» с причиной («Этикетка не напечатана», «Этикетка повреждена», «Этикетка потеряна»), «Отправить сохранённую этикетку» для `prepared` после перезапуска, «Настройки принтера» (ведёт в «Рабочее место») при ненастроенном принтере `duplicate` — все тексты из таблицы Р16 (облачный `productLabels.*` дословно); история этикеток вместо «Исключений»; при входе в смену с нерешённой этикеткой — сразу окно этой этикетки.
- [ ] Закрытие: нерешённая этикетка — отказ `label_unresolved` с текстом «Сначала завершите сохранённые задания печати этой смены.» и переходом к этикетке.
- [ ] Подсказка до первого скана берёт обязательность проверки из снимка смены (`requiredHint` «Следующая единица доступна после проверки напечатанной этикетки.» или `noneHint`), даже когда заданий ещё нет — дефект, найденный облачной приёмкой (`docs/acceptance/validation-dm-duplicate.md`).
- [ ] Тексты `floor.unitLabels.*`, 64 px, состояние словами; стенд задержки; коммит.

## Задача B7: офис — флажок печати дубликата под «Проверкой», шаблон, проверка, счётчики

**Files:** Modify `src/office/shifts/shift-form.ts`, `ShiftDialog.tsx`, `ShiftCardPage.tsx`, `src/office/forms/form-data.ts`, `src/i18n/ru.json`; tests `test/shift-form.test.ts`, `test/shift-mode-select.test.tsx`, `test/shift-dialog.test.tsx`, `test/form-data-rules.test.ts`.

- [ ] **Шаг 1: красные тесты формы** (`shift-form.ts`): поля `printDuplicate: boolean` (умолчание `false`), `duplicateTemplateId: string` (`""`), `verificationRequired: boolean` (умолчание `false` — решение владельца); `superRefine`: `mode = validation` и `printDuplicate` без шаблона — ошибка `office.shifts.duplicate.templateRequired` на `duplicateTemplateId`; `SHIFT_FIELD_ORDER` — `productId`, `mode`, `printDuplicate`, …, `duplicateTemplateId`, `verificationRequired`, `boxTemplateId`, … (порядок Р16, первым фокус получает первое отказанное поле); `toShiftInput`: «Агрегация» → `validationPrint: { mode: "none" }` при любых значениях флажка; «Проверка» без флажка → `{ mode: "none" }`; с флажком → `{ mode: "duplicate_dm", templateId, verification: verificationRequired ? "required" : "none" }`; `shiftFields(shift)` восстанавливает три поля из `OfficeShift.validationPrint`; `toShiftChange` шлёт `validationPrint` только у запланированной смены и только при изменении.
- [ ] **Шаг 2: красные тесты диалога** (`test/shift-mode-select.test.tsx`): при «Агрегации» флажка «Печатать дубликат Data Matrix» нет в документе (`queryByRole("checkbox", { name: "Печатать дубликат Data Matrix" })` — `null`); при «Проверке» он есть, выключен, под ним подсказка «На внешнюю упаковку переносится полный код с продукции. Количество продукции не меняется.»; включение раскрывает секцию «Печать дубликата» с `Select` «Шаблон этикетки продукции» (пункты — включённые шаблоны назначения `product_duplicate`, подходящие категории товара, текстом «{{name}} · {{widthMm}} × {{heightMm}} мм · {{dpi}} dpi») и `Checkbox` «Обязательная проверка этикетки» (выключен) с подсказкой «После отправки на принтер можно сканировать следующую единицу», а при включении — «Оператор должен отсканировать новую этикетку перед следующей единицей.»; нет подходящих шаблонов — `Alert` с текстом `noTemplates`, сохранение с флажком даёт ошибку шаблона; сохранение без шаблона — ошибка «Выберите шаблон этикетки продукции» и фокус на поле; **сбросы:** выключение флажка очищает шаблон и прячет секцию, а повторное включение показывает пустой шаблон; переход на «Агрегацию» прячет флажок и секцию, и при возврате на «Проверку» флажок выключен, шаблон пуст, проверка выключена; полезная нагрузка каждого состояния — как в шаге 1; у активной смены флажок, шаблон и проверка недоступны, шаблон показан именем из снимка («Шаблон зафиксирован при открытии смены», если шаблона уже нет), подсказка «Параметры печати и проверки зафиксированы при открытии смены.»; шаблон короба при «Проверке» виден в обоих состояниях флажка (решение владельца).
- [ ] **Шаг 3: реализация** — `Checkbox`, `Select`, `Alert` из `@markiro/ui`; ключи `office.shifts.duplicate.*` из таблицы Р16; шаблоны — из копий каталога офиса (`useTemplates`/`template-options.ts`), отбор — `templates::fits`-зеркало, уже используемое для шаблона короба.
- [ ] **Шаг 4: карточка смены** — блок «Контроль печати» (кабинет: `pages.shifts.productLabels.title`) со счётчиками «Отправки на принтер», «Проверенные этикетки», «Требуют завершения», «Повторные попытки» (тексты кабинета `pages.shifts.productLabels.*`) и пропущенными проверками; строка параметров «Печать дубликата: включена / выключена, проверка обязательна / необязательна». «Бланк смены» передаёт настоящие `validationPrintMode`/`validationPrintVerification` вместо жёстких `"none"` (`form-data.ts:203-205`); тест `form-data-rules.test.ts` — строка печати бланка как у облачного `shift-task-form`.
- [ ] **Шаг 5: браузерная проверка** — dev-сервер webview с замоканным хостом; скриншоты: «Агрегация» (флажка нет), «Проверка» с выключенным флажком, с включённым флажком и раскрытой секцией, ошибка шаблона, активная смена.
- [ ] **Шаг 6: зелёные (стенд задержки для новых React-тестов), коммит** `feat(standalone): the duplicate print flag under «Проверка» in the shift dialog`.

## Задача B8: документы, паритет, итоговые проверки части B

- [ ] Паритет: байты ZPL и TSPL этикетки дубликата (203 и 300 dpi) для одного шаблона и кода совпадают с облачной станцией (`apps/station/src/lib/product-labels/fields.ts` + рендер) — тест читает облачный модуль только как образец через общий домен, облако не меняется; машина состояний — общие фикстуры домена.
- [ ] `AGENTS.md` — «Unit labels»; раздел 32 спецификации; гейты как в A9; коммит.

---

## Итоговая проверка плана

- Требование владельца (два режима «Агрегация» и «Проверка», у «Проверки» — флажок печати дубликата с шаблоном и обязательностью проверки) закрывают A8 + B7; без A1–A7 и B1–B6 выбор был бы обманом: хост отказал бы (`check_mode`), а станция собрала бы смену проверки в короба.
- Задач 17 (A — 9, B — 8). Часть A исполнима без части B. Задачи A1→A2→A3→A4→A5 и A1→A6→A7 идут по порядку, A8 — после A3; B1→B2→B3 и B1→B4→B5→B6, B7 — после B3.

## Открытые вопросы (мелкие, решает контроллер по умолчанию плана)

- Подпись поля: «Режим работы» (слова владельца) против облачных «Режим» (кабинет) и «Режим смены» (станция). План — «Режим работы».
- Порядок пунктов: облако ставит «Проверку» первой; план повторяет облако при выбранной по умолчанию «Агрегации».
- Шаблон короба при включённом флажке печати: кабинет его прячет, владелец велел оставить — план оставляет в обоих состояниях флажка.

## Риски

- **Перестройка `scans` на большой базе хоста** (A2): время старта службы после обновления на объёме реальной площадки и поведение `defer_foreign_keys` внутри транзакции sqlx — проверяется тестом и замером на копии; восстановление из копии до `0017` прогоняет миграцию снова.
- **Старые станции** (A4): закрыты отказом входа; станция протокола 3 видит смену проверки в списке с бейджем «Проверка» и получает отказ при входе — текст отказа у неё общий («хост отказал»), понятный текст — только у новой.
- **Стык с потоками обратной связи:** номера миграций хоста (Р15) и индексы поиска кодов на `scans` (fb-codesearch), которые перестройка обязана пересоздать (задача A2, шаг 2а).
- **Предел снимка** (B3): шаблон короба + шаблон дубликата + логотип; большой растровый макет даст `snapshot_too_large` при входе.
- **`WorkScreen.tsx` (2465 строк)**: ветка режима — одна точка выбора панели; рост файла — предмет ревью.
- **Печать растрового Data Matrix полного кода** на принтерах клиента и его обратный скан — только на оборудовании.

## Перенесено

- Повторная обработка кодов прошлых смен (`allowPreviouslyAcceptedCodes`, облачные `validation_code_history`, `validation_code_reprocessings`, отчёт «Повторные обработки») — часть C, решение владельца.
- Выбор режима при создании смены на станции (`DeviceShiftCreate` без `mode`) — часть C.
- Режимы на ТСД (этап 7).
- Офисная страница истории этикеток единиц с событиями задания (облачное `GET /shifts/:id/product-labels/:jobId/events`) — по запросу.

## Не проверено

- Ни один шаг не исполнялся (план написан по коду `a4eef5cd6`); фрагменты SQL — по настоящим миграциям `0010` хоста и `0006` оболочки, без прогона.
- Windows, WebView2, принтеры клиента, сканер, сенсорная панель; восстановление хоста из копии после `0020`.

## Отклонения при исполнении

- (заполняет исполнитель)
