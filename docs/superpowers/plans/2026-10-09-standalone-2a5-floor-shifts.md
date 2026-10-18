# План 2a5: цех — копии смен, список и вход, новая смена, сеанс оператора, смена линии и отказ посреди смены — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Оператор, вошедший на станции, видит смены своей линии, открывает запланированную (хост замораживает снимок, станция проверяет и хранит его), продолжает уже открытую им смену и без хоста, создаёт смену на станции при связи с хостом и попадает в рабочий экран смены; выход из смены дожидается начатой работы; отказ устройства и перевод станции на другую линию посреди смены не обрывают работу; строка состояния называет устройство и смену. Первая часть цеха этапа 2a — на критическом пути пилота у текущего клиента.

**Architecture:**

- Локальная миграция `0006_floor_production.sql` — все производственные таблицы станции из §5.3 спецификации (`floor_shifts`, `floor_sscc_blocks`, `floor_block_requests`, `floor_boxes`, `floor_codes`, `floor_scans`, `floor_exceptions`, `outbox`), класса «данные устройства» в `TABLE_CLASSES`, с правилами, которые нужны планам 2a6–2a8 (задача 1). Таблицы, кроме `floor_shifts` и `outbox`, план 2a5 только создаёт и закрепляет тестами схемы; пишут в них планы 2a6–2a8.
- Протокол смен устройства в вебвью: Zod `deviceShiftSchema`, `shiftSnapshotSchema`, `enteredShiftSchema`, `deviceShiftCreateSchema`, построитель `deviceShiftCreate`, методы `HostApi.getDeviceShifts`, `createDeviceShift`, `enterShift` (задача 2).
- Копии смен (`src/floor/shifts/shift-copies.ts`) и проверка снимка (`shift-snapshot.ts`): ответ списка заменяет строки подключения одной транзакцией, а снимок, время входа и локальное закрытие станции списком не трогаются (задача 3).
- Оболочка: номер сеанса оператора (`sessionId`), `operator_refreshed`, работа смены в редьюсере (`floorWork`) с отложенными отказом устройства (`pendingRejection`, вопрос В8) и сменой линии (`pendingDevice`, вопрос В9); чтение смен в `useHostLink` по образцу `device_refresh`; признак `deviceNotSaved` (задача 4).
- Экраны цеха: список смен и вход (`ShiftList.tsx`, `shift-entry.ts`, задача 5), новая смена (`NewShift.tsx`, `new-shift.ts`, задача 6), автомат цеха `FloorApp` с воротами работы (`work-gate.ts`), бездействием, проверкой оператора после синхронизации и заглушкой рабочего экрана `src/floor/work/WorkScreen.tsx`, который заполнит план 2a6 (задача 7). `FloorOperatorScreen` удаляется.
- Строка состояния (имя устройства, номер смены, предупреждение о несохранённом изменении), экраны отказа с подтверждением «забывания» при неотправленных записях (вопрос В7, выход Б), защита `notQuarantinedNewer` у `org_profile` и `lines` (задача 8); документы (задача 9).
- Хост, `proto`, `apps/station`, `packages/*`, `package.json`, `pnpm-lock.yaml`, `Cargo.toml` и `Cargo.lock` не меняются. Из Rust меняются только `src-tauri/src/local_db.rs` (список классов и подсчёт неотправленного) и тесты `src-tauri/tests/local_db.rs`, `ipc.rs`.

**Tech Stack:** React 19.2, TypeScript 6 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4.4.3, i18next, `@markiro/ui` (`Card`, `Button` `size="floor"`, `Input` `size="floor"`, `StatusChip`, `Badge`, `Alert`), `@markiro/domain` (`classifyScan`, `isValidGtin`, `labelTemplateSpecSchema`), Vitest 4 с jsdom и `node:sqlite` за `LocalExecutor`; Rust — sqlx 0.8.6 (SQLite), Tauri 2.11 (mock runtime в `tests/ipc.rs`).

**Спецификации:**

- `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` — решения 1–3, 5, 7, 15, 26–30, §5.1 (оболочка), §5.3 (локальная база), §5.4 (копии смен), §5.7.1–5.7.2 (список, вход, новая смена), §5.7.9 (строка состояния), §8 (строка 2a5), §11 (вопросы), §12 (перенесённое: сеанс, имя устройства, линия, `notQuarantinedNewer`), §15–16 (уточнения 2a1, 2a2, 2a4).
- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` — §3 (на каком ПК хост), §4.1 (срез пилота: 2a5 — «копии смен, список, вход, новая смена на станции, сеанс оператора»), §9.1–9.2 (Wi-Fi: что можно без хоста), §12.5 (критический путь), §13 (что можно урезать, пункты 1 и 4), §14 (П1, П10, П17).
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` — §5.3–5.6 (локальная база, синхронизация, вход оператора, цех).
- `apps/standalone/AGENTS.md` — «Local database», «Reference sync», «Operators and badges», «App shell», «Shifts», «Logs», «Verification».
- План 2a1 (`docs/superpowers/plans/2026-10-08-standalone-2a1-host-shifts.md`) и код хоста `host/src/routes/device_shifts.rs` — список, создание и вход станции, отказы и их порядок; план 2a4 (`docs/superpowers/plans/2026-10-09-standalone-2a4-shell.md`), его «Контракт для 2a5–2a7»; план 2a3 (`src/lib/civil-date.ts`, `src/lib/box-template-choice.ts`, правила формы смены в `src/lib/rules.ts`).
- Итоговые ревью 1f, 1f2, 2a1 и ревью задач 2a3–2a4 (`.superpowers/sdd/`): мутанты, которых пропускали тесты плана; гонки эффектов; застрявшие флаги и фокус; ловушки («запертое окно», «станция не восстанавливается»); границы снимков и идемпотентности.
- Облачная станция (переносится своими модулями, не импортом): `apps/station/src/pages/ShiftSelection.tsx`, `ui/ShiftCard.tsx`, `pages/NewShift.tsx`, `src/i18n/ru.json` (`shifts.*`).

## Допущения по вопросам владельцу

Владелец не ответил ни на вопросы раздела 11 спецификации 2a, ни на вопросы раздела 14 спецификации пилота. План исполняет рекомендованные варианты; ниже — что принято и что поменять, если ответ будет другим.

- **П1 — хост на ПК станции (вариант Б), но план верен для обоих вариантов.** При Б станция ходит к хосту на `localhost`, и всё ниже работает при любом Wi-Fi. При А (хост на ПК администратора) открыть запланированную смену и создать новую можно только при связи: снимок замораживает и номер выдаёт хост. Поэтому «Открыть» и «Новая смена» без связи выключены с объяснением, а «Продолжить» входит в уже открытую этой станцией смену по сохранённому снимку без хоста; запрос, не нашедший хоста при связи `online`, тоже откатывается к сохранённому снимку. Рекомендация пилота §9.2 «входить в смены заранее, пока связь есть» исполняется этим без нового кода: вход фиксирует снимок, оператор выходит в список, а позже продолжает смену без связи.
- **П10 — вопросы В1–В14 по рекомендации.** В1 А: на смене одно устройство, чужая активная смена — «Занята другой станцией». В7 А с выходом Б: экраны отказа устройства, другого хоста и повреждённой настройки при отказе `unsent_facts` называют число неотправленных записей и предлагают «Сбросить всё равно» (`keepUnsent: true`; план 2a4 передал этот экран сюда). В8 Б: отказ устройства во время работы смены ждёт, пока оператор выйдет из смены; связь останавливается сразу. В9 А: перевод станции на другую линию ждёт окончания начатой работы, затем выводит оператора с уведомлением «Станция перешла на другую линию»; смена остаётся открытой на хосте. В10 А: любой вошедший оператор входит в смены и создаёт их. В6: чисел 2a5 не задаёт.
- **В12 (случайные сканы на экране входа) — направление принято, но в 2a5 не входит.** Рекомендация «не хешировать и не считать сканы, похожие на GTIN или SSCC, а офис не даст сохранить такой бейдж» небезопасна для пилота: план переноса ИМП (спецификация пилота §8.3) переносит облачные бейджи хешами, их коды неизвестны, и импортированный числовой бейдж с верной контрольной цифрой EAN перестал бы входить. Решение — вместе с ИМП (в «Перенесено»).
- **П17 (скан «Бланка смены» на станции) — нет в 2a5.** Бланк появится в офисе только с планом О-Ф; сканировать на станции до него нечего (в «Перенесено»).
- **П2 (паллеты-лайт) — вне 2a5.** Схема `0006` оставляет им место: у `outbox.kind` нет `CHECK`, а `floor_pallets` и назначение `pallet` печати придут своей миграцией плана ПЛ-Ц.

## Global Constraints

**Из спецификации этапа** (дословные значения)

- Решение 2: смены приходят не через ленту, а маршрутом `GET /v1/device/shifts` (смены линии устройства и смены, в которые оно входило); станция перечитывает его в те же моменты, что `device_refresh`: после подписки на связь и после каждого события ревизии.
- Решение 3: снимок пишет хост при открытии смены; станция получает снимок в ответе на вход и хранит его; печать и перепечатка берут только его. Станция проверяет `labelTemplateSpecSchema` при входе и не пускает в смену с нечитаемым макетом.
- Решение 15: скан с вердиктом `invalid` не хранит и не отправляет сырой текст — только длину и класс (`classifyScan`: `unknown`, `gtin`, `sscc`).
- Решение 26: явный счётчик сеансов в оболочке (`sessionId`); имя и роль обновляются из копии после синхронизации без нового сеанса.
- Решения 28–29 (вопросы В9, В8 — см. допущения): смена линии ждёт незавершённой работы, выводит оператора и показывает смены новой линии; отказ устройства во время рабочего экрана не снимает цех сразу: связь считается потерянной, очередь не отправляется, вход в новые смены и создание закрыты; после выхода из рабочего экрана — экран отказа.
- Решение 30 и «Local database»: производственные таблицы и `outbox` — данные устройства, `clear_copies` их не трогает; каждая строка несёт `host_id` и `device_id` подключения, в котором записана; чтения цеха фильтруют строки текущим подключением.
- §5.3: таблицы `floor_shifts`, `floor_sscc_blocks`, `floor_boxes` (частичный уникальный индекс «один открытый короб на смену»), `floor_codes`, `floor_scans` (сырой текст `invalid` не хранится), `floor_exceptions`, `floor_block_requests`, `outbox` (`acked_at` — квитанция); связанные записи — одной `local_transaction` (32 оператора, 64 КБ SQL, 256 значений; BLOB не читается).
- §5.4: ответ списка заменяет строки `floor_shifts` подключения одной транзакцией: новые и изменённые вставляются, отсутствующие запланированные удаляются, а `snapshot`, `entered_at` и `local_state` не трогаются; статус `closed` от хоста при открытом рабочем экране выводит оператора со смены с уведомлением «Смену закрыли в офисе»; вход — хост на связи: `POST …/enter`, без связи — только в активную смену, в которую это устройство уже входило и снимок которой хранится.
- §5.7.1: карточки — номер, товар, контрагент, статус («Не начата», «В работе», «Закрывается»), дата производства, план («План не указан»), «Агрегация»; действия «Открыть» и «Продолжить»; закрываемая локально смена — «Закрывается», вход выключен; «Новая смена» выключена без связи с объяснением. Кнопки — 64 px.
- §5.7.2: товар сканом (GTIN или КМ, `classifyScan`, поиск по `ref_products_gtin14`) или поиском по названию среди `active` и не в архиве; шаблон по порядку решения 7 (выбор, если подходящих несколько и правило не выбрало); дата производства — сегодня по часовому поясу организации; план — необязательно; `POST /v1/device/shifts` с `requestId`, затем вход.
- §5.7.9: строка состояния получает имя устройства, смену (номер) и предупреждение о несохранённой линии (сбой записи `device.json` при `device_refresh`). Очередь и остаток номеров SSCC — план 2a6.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!` в исходниках; именованные экспорты, `import type`; члены интерфейсов, которые передаются несвязанными, — свойства-функции (`@typescript-eslint/unbound-method`).
- Экраны цеха: только `@markiro/ui` (ESLint запрещает нативные поля в `src/`), каждая кнопка — `size="floor"` (64 px), состояние — словами, а не цветом; ни одна кнопка ухода («Сменить оператора», «Назад») не держится запросом, который может не ответить.
- Тексты — ключи `src/i18n/ru.json`, кириллица буквами; неразрывный пробел в ожидаемых числах тестов пишется `\u00a0`. Числа в текстах — именованные переменные (`number`, `quantity`, `records`, `gtin`), не `count`.
- Тесты не зависят от гонки эффектов: перед действием, которое требует сработавшего эффекта (подписка сканера, работа, отданная воротам), тест ждёт этого явно; новые и изменённые файлы проходят стенд с задержкой `setImmediate` и verbose-прогон без `stderr`.
- Rust: `cargo fmt` чистый, сборка без предупреждений; `Cargo.toml`, `Cargo.lock` не меняются.
- Не меняются: `apps/station`, `packages/*`, `apps/standalone/host`, `apps/standalone/proto`, `package.json`, `pnpm-lock.yaml`.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Решения планировщика

- Миграция `0006` несёт все таблицы §5.3, хотя 2a5 пишет только `floor_shifts`: строка 2a5 раздела 8 спецификации отдаёт миграцию `0006` этому плану, а план 2a4 ждёт отсюда `outbox`. Правила, на которые опираются 2a6–2a8, закреплены тестами схемы сейчас (§5.3 не уточняет их — уточняет этот план): `CHECK` «код маркировки есть ровно у скана вида `km`» (решение 15), «закрытый короб — с SSCC, блоком и номером», «курсор блока в пределах блока», «поля исключения по его виду», «квитанция вместе со временем», уникальность SSCC среди всех подключений. Если план 2a6 увидит, что схеме чего-то не хватает, он добавит свою миграцию, а `0006` не правит.
- `floor_shifts` и `floor_codes` ключуются парой подключения: «забывание» оставляет данные устройства, и повторное подключение к тому же хосту видит те же идентификаторы смен (§5.3 даёт `id PRIMARY KEY`). `floor_scans` и `floor_exceptions` несут `shift_id` (записи `FactRecord` его требуют). `outbox.kind` без `CHECK` — паллеты пилота добавят виды, а `CHECK` в SQLite меняется только пересборкой таблицы; `seq` — псевдоним rowid без `AUTOINCREMENT`, который создал бы неклассифицированную `sqlite_sequence`. Внешних ключей нет, и тест `every_table_has_a_forget_class` проверяет это (пункт ревью задачи 4 плана 2a4).
- Копия смены, в которую станция входила, остаётся при любом списке хоста (её факты называют её; срок хранения — план 2a8) и никогда не возвращается в `planned`: так может сказать только список, прочитанный до входа и применённый после него. Список на экране — запланированные и активные смены текущей линии и закрываемая станцией; закрытая хостом или станцией не показывается.
- Снимок проверяется схемой, GTIN-14 и девятью цифрами префикса выпуска (`validate::issuer_prefix`), а не только макетом: печать 2a7 берёт из снимка всё это. Нечитаемый снимок не сохраняется (инвариант: «сохранённый снимок прошёл проверку сборки, которая его сохранила»); хранится снимок, разобранный этой сборкой.
- «Открыть» и «Новая смена» выключены, пока связь не `online`; «Продолжить» без связи доступна только для смены со снимком. Запрос, не нашедший хоста при связи `online` (транспортный отказ, кроме `certificate_mismatch`), откатывается к сохранённому снимку; ответ хоста с отказом — нет.
- Номер сеанса даёт редьюсер (`lastSessionId + 1`): `App` больше не различает сеансы по объекту оператора, и ссылка `currentOperator` уходит; `FloorApp` ключуется сеансом.
- Работа смены — в редьюсере (`floorWork`), потому что отказ устройства и смена линии — решения редьюсера. Ждущий отказ сразу останавливает связь (`App` считает его отказом для `useHostLink`): ничего больше не уходит на хост, который отказал. Цех сам выходит из смены при ждущей смене линии (В9 — «ждёт незавершённой работы, затем выводит»), а при отказе ждёт, пока оператор выйдет (В8). Отказ побеждает смену линии. `other_host` по-прежнему снимает цех сразу (редкий случай замены хоста по тому же адресу; в «Перенесено»).
- Ворота работы (`createWorkGate`) — механизм, которым рабочий экран 2a6 держит выход: каждый отданный кусок работы держит `drain`, упавший — нет, отданный во время ожидания — держит. Выход, чьё ожидание кончилось после размонтирования, ничего не делает. Локальная запись ограничена на деле примерно 35 с (тайм-аут занятости 5 с и ожидание пула sqlx 30 с), отправка на печать — 5 с оболочки, проверка кода — 300 мс, поэтому ожидание не вечное; таймаута, который пустил бы выход посреди записи, нет.
- Дата производства новой смены меняется кнопками «На день раньше» и «На день позже», а не полем ввода: на сенсорном экране в киоск-режиме ввод даты неудобен, а календарь `DatePicker` не 64 px. Контрагента станция не выбирает (`counterpartyId: null`): копий контрагентов на станции нет, а пилот (В2 А) печатает контрагента только у смен из офиса.
- Один `requestId` на форму новой смены, и он переживает повторы: повтор после потерянного ответа отдаёт первую смену, даже если поля с тех пор менялись (номер и план видны на рабочем экране). После перезапуска приложения посреди создания `requestId` теряется, и повтор создаёт вторую запланированную смену `/S`, которую офис удаляет (в «Перенесено»).
- Строка состояния читает номер смены из копий по `floorWork.shiftId`, а не из нового поля действия: номер смены не меняется, а остальное строка и так читает из копий.
- `deviceNotSaved` ставит любой сбой `storage` у `device_refresh` (линия или имя), снимает следующий удачный ответ; станция работает по прежней линии.
- Защита `notQuarantinedNewer` у `org_profile` и `lines` (перенесённое из 1f2, §12): цех теперь называет их и читает часовой пояс и шаблон по умолчанию организации; версия набора сущностей не меняется (форма записей та же).

## Контракт для 2a6–2a8

**Локальная база (`src-tauri/migrations/0006_floor_production.sql`).** Все восемь таблиц — `TableClass::DeviceData`; у каждой строки `host_id` и `device_id` подключения, в котором она записана; цех читает только строки текущего подключения (`DeviceStatus.hostId`, `deviceId`); факт и его запись `outbox` — одна `local_transaction`; внешних ключей нет и не добавлять.

| Таблица                | Ключ                              | Кто пишет                                                                                                       | Правила схемы (тест `test/floor-schema.test.ts`)                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `floor_shifts`         | `(host_id, device_id, id)`        | 2a5: список, создание, вход; 2a8: `local_state` (`closing` с записью `shift_closed`, `closed` по квитанции)     | `snapshot` (JSON) ровно при `entered_at`; `local_state` только у смены, в которую станция входила; `status` — `planned`/`active`/`closed`                                                                                                                                 |
| `floor_sscc_blocks`    | `block_id`                        | 2a6: ответ на запрос блока, в транзакции, которая удаляет его `floor_block_requests`                            | `extension` 0 или 1; `to_serial >= from_serial`; `next_serial` от `from_serial` до `to_serial + 1` (`to_serial + 1` — блок израсходован); списание номера — `UPDATE … SET next_serial = next_serial + 1 WHERE block_id = ? AND next_serial = ?`, `expectedChanges: 1`     |
| `floor_block_requests` | `request_id`                      | 2a6: до запроса блока; хранит `issuer_prefix` и `extension`, повтор — тем же телом                              | `extension` 0 или 1                                                                                                                                                                                                                                                       |
| `floor_boxes`          | `id` (UUID станции)               | 2a6: открытие при первом принятом коде, закрытие с SSCC; 2a8: `disassembled_at`; 2a6: `needs_fix` по `conflict` | открытый — без `sscc`, `block_id`, `serial`, `disassembled_at`; закрытый — со всеми тремя; один открытый короб на `(host_id, device_id, shift_id)`; `sscc` уникален среди всех подключений                                                                                |
| `floor_codes`          | `(host_id, device_id, code_hash)` | 2a6: принятый код; 2a8: удаление при `undo`, `clear`, `disassemble`                                             | реестр дублей внутри подключения                                                                                                                                                                                                                                          |
| `floor_scans`          | `id`                              | 2a6: каждый скан рабочего экрана                                                                                | `verdict` — `ok`/`duplicate`/`wrong_gtin`/`invalid`; `duplicate_source` ровно у `duplicate`; `box_id` ровно у `ok`; `raw_kind = 'km'` ровно у не-`invalid`; `code_hash`, `gtin14`, `serial`, `canonical` есть ровно у `km` (решение 15)                                   |
| `floor_exceptions`     | `id`                              | 2a8                                                                                                             | `undo` — код и время скана без причины; `clear` — ничего; `reprint`, `disassemble` — причина; `reason_text` только при `reason_code = 'other'`                                                                                                                            |
| `outbox`               | `seq` (rowid), `id` уникален      | 2a6–2a8: в транзакции факта; 2a6: квитанции                                                                     | `payload` — запись `FactRecord` целиком (`{ id, kind, shiftId, operatorId, data }`), `json_valid`; `id` — `id` записи; неотправленная — `acked_at IS NULL`; `outcome` и `acked_at` — вместе; `outcome_code`, `outcome_details` — только с `outcome`; у `kind` нет `CHECK` |

`countUnsentRecords(local, pairing | null)` (`src/local/outbox.ts`) — число неотправленных подключения или всех (как считает оболочка); строка состояния 2a6 берёт его же.

**Оболочка (`src/app/shell.ts`).**

- `ShellState.operator: FloorSession | null` (`{ sessionId, id, login, name, role }`), `floorWork: { sessionId, shiftId } | null`, `pendingRejection`, `pendingDevice`, `shiftReads: { done, failed }`, `deviceNotSaved`.
- `work_entered` и `work_left` шлёт только `FloorApp`. Ошибку вызова хоста из цеха с отказом ключа или сменой сертификата цех отдаёт оболочке: `shellActionFor(error, null)` → `dispatch`; во время работы смены редьюсер откладывает отказ (`pendingRejection`).
- `App` останавливает связь (`useHostLink`) при `rejection`, `pendingRejection` и `other_host`. Доставка фактов плана 2a6 — ещё один планировщик внутри `useHostLink` (по образцу чтения смен): она живёт ровно, пока живёт связь, и сама останавливается при ждущем отказе.

**Рабочий экран (`src/floor/work/WorkScreen.tsx`).** План 2a6 заменяет тело компонента, сохраняя `WorkScreenProps`:

```ts
interface WorkScreenProps {
  shift: WorkShift; // { copy: ShiftCopy; snapshot: CheckedSnapshot }
  operator: FloorSession;
  pairing: Pairing; // { hostId, deviceId }
  local: LocalExecutor;
  online: boolean; // связь `online`
  track: <T>(work: Promise<T>) => Promise<T>;
  touch: () => void;
  onLeave: () => void;
  leaving: boolean;
}
```

- Каждый кусок работы, который пишет локальную базу, отправляет на хост или на печать, рабочий экран отдаёт `track` до начала (очередь сканов, закрытие короба, задание печати). Пока `leaving`, экран не принимает сканы. Выход по бездействию, по удалению оператора, по закрытию смены в офисе и по смене линии делает `FloorApp`, дождавшись `drain`.
- `touch` — каждый скан COM-сканера (он не нажимает клавиш).
- Решение 34 (`set_system_awake(true)` на рабочем экране, `false` при уходе) — план 2a7, в монтировании и размонтировании рабочего экрана.

**Снимок и копии.** `CheckedSnapshot` (`src/floor/shifts/shift-snapshot.ts`): `product` (`id`, `gtin14` — проверенный GTIN-14, `name`, `printName`, `chzProductGroupCode`, `shelfLifeDays`), `boxTemplate.spec: LabelTemplateSpec` (уже разобран доменом), `issuerPrefix` (9 цифр), `counterpartyName`. Факт смены несёт `shiftId: shift.copy.id`; проверка GTIN — против `shift.snapshot.product.gtin14`; номер, дата производства и вместимость — `shift.copy.number`, `productionDate`, `boxCapacity`. Функции `src/floor/shifts/shift-copies.ts`: `replaceShiftCopies(local, pairing, shifts, seenAt)`, `keepCreatedShift`, `keepEnteredShift(local, pairing, shift, enteredAt, seenAt)`, `readShiftCopies(local, pairing, lineId)`, `readShiftCopy(local, pairing, shiftId)`, `readStoredWork(local, pairing, shiftId): { kind: "ready"; shift } | { kind: "missing" } | { kind: "unreadable"; reason }`.

**Протокол.** `HostApi.getDeviceShifts`, `createDeviceShift`, `enterShift` (`src/host/api.ts`); план 2a6 добавляет рядом `requestSsccBlock`, `checkCode` (с `timeoutMs: 300`), `sendFacts` и их схемы в `src/host/protocol.ts`.

**Строка состояния.** `FloorStatusBar` получает `deviceName`, `shiftId`, `deviceNotSaved`; план 2a6 добавляет число неотправленных, отклонённых и конфликтов и остаток номеров SSCC префикса смены — новыми свойствами, читающими копии.

**Тексты.** Ключи `floor.shifts.*`, `floor.newShift.*`, `floor.work.*` (`floor.work.stub` план 2a6 заменяет), `floor.status.device`, `floor.status.shift`, `floor.status.deviceNotSaved`, `shell.unsent.*`.

## Заметки для исполнения

**Основа плана**

- 2a5 стоит на коде планов 2a1 (в ветке), 2a3 (задачи 1–2: `src/lib/civil-date.ts`, `src/lib/box-template-choice.ts`, правила смены в `src/lib/rules.ts`) и 2a4 (задачи 3–5 и 9: `deviceName` в `DeviceStatus`, `TABLE_CLASSES`, `device_forget` с `keepUnsent` и текстом `errors.device.unsent_facts`, `src/hardware/hardware.ts`). План 2a2 не нужен. Перед задачей 1 убедиться, что `git log --oneline` содержит коммиты этих задач; если 2a3 или 2a4 ещё не влиты, остановиться и назвать это в отчёте.
- Фрагменты построены сценарием на копии репозитория: ветка `claude/2a4-shell` на `939a2c8dc` (задачи 1–4 плана 2a4), влитые `bf4235cc8` (основная ветка) и `claude/2a3-office` на `1756f5664` (задачи 1–4 плана 2a3), затем задачи 5–9 плана 2a4, применённые по тексту плана (`local_db.rs` и `tests/local_db.rs` — в виде задачи 4 плана, без добавленного исполнителем `clear_classed`); задача за задачей план применён к этой копии, и каждая команда ниже запущена на ней. Настоящее дерево будет другим: исполненные задачи 5–9 плана 2a4, задачи 5–9 плана 2a3 (`src/host/protocol.ts`, `requests.ts`, `api.ts`, `ru.json`, `shell.css`, страницы офиса, `AGENTS.md`, спецификация), план 2a2 (хост, `proto`, `test/fact-rules.test.ts`). Фрагмент, который из-за них не находится, применяется к тому же месту по смыслу, а расхождение записывается в «Отклонения при исполнении». Номер раздела спецификации задачи 9 — следующий свободный.

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, с отступами; на свою очередь он встречается в файле ровно один раз. Фрагменты одной правки идут сверху вниз по файлу и применяются по порядку. Шаг 1 (тесты) применяется раньше шага 3 (реализация).
- «Создать» — новый файл, ровно как в блоке. «Удалить» — `git rm` файла.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках отформатирован prettier и `cargo fmt`: расхождение при проверке значит опечатку.
- Русский текст в коде и в `ru.json` — буквами. Каждая задача с вебвью кончается `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное совпадение — `src/host/pairing-code.ts:66`.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие защиты. Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из шага; команда — ожидаемый FAIL с названным тестом; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить. Мутация миграции `0006` проверяется Vitest (он читает каталог миграций при каждом запуске), без сборки Rust.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON, CSS, MD; Rust — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`.

**pnpm, git, Cargo и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. Команды — из корня репозитория, без `cd`. Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата; если обёртка `rtk` урезала вывод, `rtk proxy <команда>`. Если `/usr/bin/git` отвечает требованием принять лицензию Xcode, тот же git — `/Library/Developer/CommandLineTools/usr/bin/git`.
- В свежем worktree сначала: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`, а перед Cargo — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (оболочка встраивает `apps/standalone/dist`).
- Cargo — с `--offline --locked`. В песочнице проходят библиотека оболочки и `--test local_db`; `--test ipc` открывает сокет на loopback и идёт вне песочницы.
- React 19.2 запускает пассивные эффекты задачей планировщика (`setImmediate`), а `waitFor` после успеха ждёт `setTimeout(0)`: утверждение сразу после `findBy*`, которое зависит от следующего эффекта, — скрытый флейк. Поэтому тесты этого плана ждут явно: сканер подписан (`scanner.listening()`), рабочий экран отдал работу воротам (`work.tracked()`), заголовок рабочего экрана показан. Новые и изменённые тестовые файлы один раз запускаются с `--reporter=verbose`: stderr пуст. Те же файлы один раз запускаются под стендом с задержкой `setImmediate` на 3 мс — два временных файла внутри пакета, удалить сразу после прогона, до `lint`:

  `apps/standalone/test/delayed-immediate.setup.ts`:

  <!-- prettier-ignore -->
  ```ts
  // Temporary stand (never committed): React's scheduler runs passive effects
  // through `setImmediate`; delaying it by 3 ms makes every effect lose the race
  // with Testing Library's `setTimeout(0)`, so an assertion that depends on an
  // effect right after `findBy*` fails every time instead of now and then.
  const realSetTimeout = globalThis.setTimeout;
  Object.defineProperty(globalThis, "setImmediate", {
    configurable: true,
    writable: true,
    value: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
      realSetTimeout(callback, 3, ...args),
  });
  ```

  `apps/standalone/vitest.delay.config.ts`:

  <!-- prettier-ignore -->
  ```ts
  import react from "@vitejs/plugin-react";
  import { defineConfig } from "vitest/config";

  export default defineConfig({
    plugins: [react()],
    test: {
      environment: "jsdom",
      globals: true,
      include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
      setupFiles: ["test/delayed-immediate.setup.ts", "test/setup.ts"],
    },
  });
  ```

  Запуск: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts <файлы>`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts` и `git status --short` без этих файлов.

- Тесты с таймерами (`vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true })`) держат запас не меньше 800 мс до таймера, которого ещё не должно быть: часы идут и реальным временем.
- Под сильной нагрузкой машины (на копии плана — средняя загрузка около 30) полный прогон Vitest ронял тайм-аутом 5 с несколько старых тестов офиса (`shifts-page`, `template-editor`, `template-defaults-page`); отдельным прогоном они проходили. Это не дефект плана; падение в полном прогоне записывается и разбирается, а не лечится повтором.

**Счёт тестов** (измерено на копии плана; на настоящем дереве Vitest больше на тесты задач 5–9 плана 2a3 и плана 2a2, а числа ниже сдвигаются на столько же)

- До плана: Vitest — 74 файла, 1929 тестов; оболочка — `local_db` 16, `ipc` 18 (после плана 2a4).
- По задачам, полный прогон Vitest: 1 — 75 файлов, 1939 тестов; 2 — 75, 1948; 3 — 76, 1960; 4 — 77, 1988; 5 — 78, 2009; 6 — 80, 2032; 7 — 81, 2042 (`test/floor-operator.test.tsx` удалён, его тесты — в `test/floor-app.test.tsx`); 8 — 82, 2050; 9 — без изменений. Оболочка: `local_db` 16 и `ipc` 18 во всех задачах (задача 1 меняет тесты, а не их число).
- После: Vitest — 82 файла, 2050 тестов; Cargo — числа оболочки прежние.

## Файлы

Задачи выполняются по порядку: 1–3 — данные, 4 — оболочка, 5–6 — экраны по отдельности, 7 — автомат цеха, который их собирает, 8 — строка состояния и экраны отказа, 9 — документы.

<!-- prettier-ignore -->
```text
apps/standalone/src-tauri/migrations/0006_floor_production.sql (новый)  задача 1
apps/standalone/src-tauri/src/local_db.rs                               задача 1
apps/standalone/src-tauri/tests/{local_db,ipc}.rs                       задача 1
apps/standalone/test/{floor-schema (новый),local-executor}.test.ts      задача 1
apps/standalone/src/host/{protocol,requests,api}.ts                     задача 2
apps/standalone/test/{protocol,api}.test.ts, test/support/office.tsx    задача 2
apps/standalone/src/floor/shifts/{shift-copies,shift-snapshot}.ts (новые),
apps/standalone/test/shift-copies.test.ts (новый)                       задача 3
apps/standalone/src/app/{shell,host-link}.ts, src/app/App.tsx           задачи 4, 7, 8
apps/standalone/test/shell.test.ts, test/host-link-shifts.test.ts (новый) задача 4
apps/standalone/test/app.test.tsx                                       задачи 4, 7, 8
apps/standalone/src/floor/shifts/{ShiftCard.tsx,ShiftList.tsx,shift-entry.ts,shift-text.ts} (новые),
apps/standalone/test/floor-shift-list.test.tsx (новый)                  задача 5
apps/standalone/src/floor/shifts/{NewShift.tsx,new-shift.ts} (новые),
apps/standalone/test/{floor-new-shift.test.tsx,floor-shift-text.test.ts} (новые)  задача 6
apps/standalone/src/floor/shifts/shift-text.ts                          задачи 5, 6
apps/standalone/src/i18n/ru.json, src/app/shell.css                     задачи 5–8
apps/standalone/src/floor/{FloorApp.tsx,work-gate.ts,work/WorkScreen.tsx} (новые),
apps/standalone/src/floor/{idle-lock,sign-in}.ts,
apps/standalone/test/{floor-app.test.tsx,work-gate.test.ts} (новые),
apps/standalone/src/floor/FloorOperatorScreen.tsx, test/floor-operator.test.tsx (удаляются)  задача 7
apps/standalone/src/floor/FloorStatusBar.tsx, src/app/screens.tsx,
apps/standalone/src/local/{outbox (новый),reference-sync}.ts,
apps/standalone/test/{floor-status-bar.test.tsx,outbox.test.ts (новый),reference-sync.test.ts}  задача 8
apps/standalone/AGENTS.md, спецификация этапа (раздел «Уточнения плана 2a5»)  задача 9
```

---

### Task 1: Локальная миграция `0006` — производственные таблицы станции и их классы

Все таблицы §5.3 спецификации одной миграцией, класса `DeviceData` в `TABLE_CLASSES`, с правилами, на которые опираются планы 2a6–2a8 (раздел «Контракт для 2a6–2a8»). Временная `outbox` тестов плана 2a4 (константа `OUTBOX`, четыре столбца) заменяется записями в настоящую таблицу; проверка `pragma_table_list` в `unsent_records`, которая ждала эту миграцию, уходит: таблица теперь есть всегда. Тест классов ещё проверяет, что ни у одной таблицы нет внешнего ключа (пункт ревью задачи 4 плана 2a4: ключ с `ON DELETE CASCADE` от данных устройства к одноразовой таблице молча менял бы сохраняемые строки), и что данные устройства — ровно таблицы `0006`, а `floor_sign_in_failures` остаётся одноразовой (открытый вопрос владельцу). Очистка проверяется на строке в каждой таблице `0006`: одноразовые пусты, остальные — нет.

**Files:**

- Create: `apps/standalone/src-tauri/migrations/0006_floor_production.sql`
- Modify: `apps/standalone/src-tauri/src/local_db.rs`
- Test: `apps/standalone/src-tauri/tests/local_db.rs`, `apps/standalone/src-tauri/tests/ipc.rs`, `apps/standalone/test/local-executor.test.ts` (Modify); `apps/standalone/test/floor-schema.test.ts` (Create)

**Interfaces:**

- Consumes: `TableClass`, `TABLE_CLASSES`, `table_class`, `UnsentGuard`, `LocalDb::clear_copies` (план 2a4, задачи 4–5); `openLocalDb` (`test/support/local-db.ts`, читает каталог миграций).
- Produces: таблицы `floor_shifts`, `floor_sscc_blocks`, `floor_block_requests`, `floor_boxes`, `floor_codes`, `floor_scans`, `floor_exceptions`, `outbox` со столбцами и правилами из блока миграции; восемь строк `TableClass::DeviceData` в `TABLE_CLASSES`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-schema.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { LocalExecutor, LocalStatement } from "../src/local/executor.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const AT = "2026-10-09T08:00:00.000Z";

/** The tables of this device's own records (migration `0006`, `TableClass::DeviceData`). */
const DEVICE_TABLES = [
  "floor_block_requests",
  "floor_boxes",
  "floor_codes",
  "floor_exceptions",
  "floor_scans",
  "floor_shifts",
  "floor_sscc_blocks",
  "outbox",
];

function shift(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  const row: Record<string, unknown> = {
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    id,
    number: "OCT26-004",
    status: "planned",
    mode: "aggregation",
    pallets_enabled: 0,
    created_from: "office",
    line_id: LINE_ID,
    product_id: "product-1",
    product_name: "Молоко",
    product_gtin14: "04600682000013",
    production_date: "2026-10-09",
    box_capacity: 12,
    box_template_id: "template-1",
    seen_at: 1_790_000_000_000,
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO floor_shifts (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

function box(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  const row: Record<string, unknown> = {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: "shift-1",
    opened_at: AT,
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO floor_boxes (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

function scan(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  const row: Record<string, unknown> = {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: "shift-1",
    box_id: "box-1",
    verdict: "ok",
    raw_kind: "km",
    raw_length: 31,
    code_hash: "a".repeat(64),
    gtin14: "04600682000013",
    serial: "abc",
    canonical: "0104600682000013215abc",
    scanned_at: AT,
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO floor_scans (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

function exception(id: string, overrides: Record<string, unknown>): LocalStatement {
  const row: Record<string, unknown> = {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: "shift-1",
    box_id: "box-1",
    occurred_at: AT,
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO floor_exceptions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

function record(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  const row: Record<string, unknown> = {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    kind: "scan",
    shift_id: "shift-1",
    payload: JSON.stringify({ id, kind: "scan" }),
    created_at: AT,
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO outbox (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

const BLOCK: LocalStatement = {
  sql:
    "INSERT INTO floor_sscc_blocks (block_id, host_id, device_id, issuer_prefix, extension, " +
    "from_serial, to_serial, next_serial, received_at) VALUES (?, ?, ?, '460068200', 0, 1, 2, ?, ?)",
  values: ["block-1", HOST_ID, DEVICE_ID, 1, AT],
};

async function refused(local: LocalExecutor, statement: LocalStatement): Promise<void> {
  await expect(local.transaction([statement])).rejects.toMatchObject({ code: "statement_failed" });
}

async function accepted(local: LocalExecutor, statement: LocalStatement): Promise<void> {
  await expect(local.transaction([statement])).resolves.toEqual([1]);
}

describe("the station's own production tables (migration 0006)", () => {
  it("tag every row with its pairing and have no foreign key", async () => {
    const { executor } = openLocalDb();
    const columns = await executor.query(
      'SELECT t.name AS tableName, c.name AS columnName, c."notnull" AS required ' +
        "FROM pragma_table_list AS t, pragma_table_info(t.name) AS c " +
        "WHERE t.schema = 'main' AND c.name IN ('host_id', 'device_id') ORDER BY t.name, c.name",
      [],
      z.object({ tableName: z.string(), columnName: z.string(), required: z.number() }),
    );
    expect(columns).toEqual(
      DEVICE_TABLES.flatMap((tableName) => [
        { tableName, columnName: "device_id", required: 1 },
        { tableName, columnName: "host_id", required: 1 },
      ]),
    );
    const keys = await executor.query(
      "SELECT t.name AS name FROM pragma_table_list AS t, pragma_foreign_key_list(t.name) AS k " +
        "WHERE t.schema = 'main' AND t.type = 'table'",
      [],
      z.object({ name: z.string() }),
    );
    expect(keys).toEqual([]);
  });

  it("keep a snapshot exactly for a shift the station entered, and close only such a shift", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, shift("planned"));
    await accepted(
      executor,
      shift("entered", {
        status: "active",
        snapshot: "{}",
        entered_at: AT,
        local_state: "closing",
      }),
    );
    await refused(executor, shift("snapshot-alone", { snapshot: "{}" }));
    await refused(executor, shift("entry-alone", { entered_at: AT }));
    await refused(executor, shift("closed-unentered", { local_state: "closed" }));
    await refused(executor, shift("bad-json", { snapshot: "{", entered_at: AT }));
    await refused(executor, shift("bad-status", { status: "running" }));
    await refused(
      executor,
      shift("bad-state", { snapshot: "{}", entered_at: AT, local_state: "open" }),
    );
  });

  it("keep one row per shift and pairing, so another pairing to the same host has its own", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, shift("shift-1"));
    await refused(executor, shift("shift-1"));
    await accepted(executor, shift("shift-1", { device_id: OTHER_DEVICE }));
  });

  it("never keep the text of a scan that is no code of marking", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, scan("scan-ok"));
    const invalid = {
      verdict: "invalid",
      raw_kind: "unknown",
      box_id: null,
      code_hash: null,
      gtin14: null,
      serial: null,
      canonical: null,
    };
    await accepted(executor, scan("scan-invalid", invalid));
    await refused(executor, scan("scan-text", { ...invalid, canonical: "MRK-000742" }));
    await refused(executor, scan("scan-serial", { ...invalid, serial: "000742" }));
    await refused(executor, scan("scan-hash", { ...invalid, code_hash: "b".repeat(64) }));
    // A code of marking is never `invalid`, and an `invalid` scan is never one.
    await refused(executor, scan("scan-km-invalid", { verdict: "invalid", box_id: null }));
    await refused(executor, scan("scan-gtin-ok", { ...invalid, verdict: "ok", box_id: "box-1" }));
  });

  it("name a box for an accepted scan only, and a source for a duplicate only", async () => {
    const { executor } = openLocalDb();
    await refused(executor, scan("ok-without-box", { box_id: null }));
    await refused(
      executor,
      scan("duplicate-in-box", { verdict: "duplicate", duplicate_source: "local" }),
    );
    await accepted(
      executor,
      scan("duplicate", { verdict: "duplicate", duplicate_source: "host", box_id: null }),
    );
    await refused(
      executor,
      scan("duplicate-without-source", { verdict: "duplicate", box_id: null }),
    );
    await refused(
      executor,
      scan("wrong-gtin-with-source", {
        verdict: "wrong_gtin",
        duplicate_source: "local",
        box_id: null,
      }),
    );
  });

  it("close a box whole, with its SSCC, block and serial, or keep it open without them", async () => {
    const { executor } = openLocalDb();
    const closed = { closed_at: AT, sscc: "146006820000000017", block_id: "block-1", serial: 1 };
    await accepted(executor, box("box-1"));
    await accepted(executor, box("box-2", { shift_id: "shift-2", ...closed }));
    await refused(executor, box("box-3", { shift_id: "shift-3", closed_at: AT }));
    await refused(executor, box("box-4", { shift_id: "shift-4", sscc: "146006820000000024" }));
    await refused(executor, box("box-5", { shift_id: "shift-5", disassembled_at: AT }));
    await accepted(
      executor,
      box("box-6", {
        shift_id: "shift-6",
        ...closed,
        sscc: "146006820000000031",
        disassembled_at: AT,
      }),
    );
  });

  it("hold one open box per shift and pairing, and an SSCC on one box under any pairing", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, box("open-1"));
    await refused(executor, box("open-2"));
    await accepted(executor, box("open-3", { device_id: OTHER_DEVICE }));
    const closed = { closed_at: AT, block_id: "block-1", serial: 1, sscc: "146006820000000017" };
    await accepted(executor, box("closed-1", closed));
    await accepted(executor, box("closed-2", { ...closed, sscc: "146006820000000024" }));
    await refused(executor, box("closed-3", { ...closed, device_id: OTHER_DEVICE }));
  });

  it("move a block's cursor only from the value read, within the block", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, BLOCK);
    const take = (read: number): LocalStatement => ({
      sql:
        "UPDATE floor_sscc_blocks SET next_serial = next_serial + 1 " +
        "WHERE block_id = ? AND next_serial = ?",
      values: ["block-1", read],
      expectedChanges: 1,
    });
    await expect(executor.transaction([take(1)])).resolves.toEqual([1]);
    // A second writer that read the same cursor loses: the serial is spent.
    await expect(executor.transaction([take(1)])).rejects.toMatchObject({
      code: "changes_mismatch",
    });
    await expect(executor.transaction([take(2)])).resolves.toEqual([1]);
    // The block of serials 1–2 is used up at 3, and goes no further.
    await expect(executor.transaction([take(3)])).rejects.toMatchObject({
      code: "statement_failed",
    });
  });

  it("take an exception with the fields of its kind only", async () => {
    const { executor } = openLocalDb();
    const undo = { kind: "undo", code_hash: "a".repeat(64), target_scanned_at: AT };
    await accepted(executor, exception("undo", undo));
    await refused(executor, exception("undo-reason", { ...undo, reason_code: "other" }));
    await refused(executor, exception("undo-bare", { kind: "undo" }));
    await accepted(executor, exception("clear", { kind: "clear" }));
    await refused(executor, exception("clear-code", { kind: "clear", code_hash: "a".repeat(64) }));
    await accepted(executor, exception("reprint", { kind: "reprint", reason_code: "printer_jam" }));
    await refused(executor, exception("reprint-bare", { kind: "reprint" }));
    await accepted(
      executor,
      exception("other", { kind: "disassemble", reason_code: "other", reason_text: "Брак" }),
    );
    await refused(
      executor,
      exception("words", {
        kind: "disassemble",
        reason_code: "wrong_product",
        reason_text: "Брак",
      }),
    );
    await refused(executor, exception("pallet", { kind: "pallet", reason_code: "other" }));
  });

  it("keep outbox records in their order, with a receipt and its time together", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, record("record-b"));
    await accepted(executor, record("record-a"));
    await accepted(
      executor,
      record("record-c", { outcome: "accepted", acked_at: AT, outcome_details: "{}" }),
    );
    expect(
      await executor.query(
        "SELECT id FROM outbox WHERE acked_at IS NULL ORDER BY seq",
        [],
        z.object({ id: z.string() }),
      ),
    ).toEqual([{ id: "record-b" }, { id: "record-a" }]);
    await refused(executor, record("record-a"));
    await refused(executor, record("no-time", { outcome: "rejected", outcome_code: "x" }));
    await refused(executor, record("no-outcome", { acked_at: AT }));
    await refused(executor, record("code-alone", { outcome_code: "invalid_record" }));
    await refused(executor, record("bad-payload", { payload: "{" }));
    await refused(executor, record("bad-outcome", { outcome: "lost", acked_at: AT }));
    // A kind the pilot's pallets add later needs no new migration.
    await accepted(executor, record("pallet", { kind: "pallet_closed" }));
  });
});
```

Правка `apps/standalone/test/local-executor.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts

describe("local database on node:sqlite", () => {
  it("has exactly the shell's reference tables", async () => {
    const { executor } = openLocalDb();
    const tables = await executor.query(
```

заменить на:

<!-- prettier-ignore -->
```ts

describe("local database on node:sqlite", () => {
  it("has exactly the shell's tables", async () => {
    const { executor } = openLocalDb();
    const tables = await executor.query(
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
    );
    expect(tables.map((table) => table.name)).toEqual([
      "floor_sign_in_failures",
      "ref_lines",
      "ref_operator_badges",
```

заменить на:

<!-- prettier-ignore -->
```ts
    );
    expect(tables.map((table) => table.name)).toEqual([
      "floor_block_requests",
      "floor_boxes",
      "floor_codes",
      "floor_exceptions",
      "floor_scans",
      "floor_shifts",
      "floor_sign_in_failures",
      "floor_sscc_blocks",
      "outbox",
      "ref_lines",
      "ref_operator_badges",
```

Правка `apps/standalone/src-tauri/tests/local_db.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
        names,
        [
            "floor_sign_in_failures",
            "ref_lines",
            "ref_operator_badges",
```

заменить на:

<!-- prettier-ignore -->
```rust
        names,
        [
            "floor_block_requests",
            "floor_boxes",
            "floor_codes",
            "floor_exceptions",
            "floor_scans",
            "floor_shifts",
            "floor_sign_in_failures",
            "floor_sscc_blocks",
            "outbox",
            "ref_lines",
            "ref_operator_badges",
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
        "TABLE_CLASSES names each table of the migrations once, and nothing else"
    );
    // Until plan 2a5 brings the first records of the device's own, every
    // table is a copy or this pairing's bookkeeping.
    assert!(TABLE_CLASSES
        .iter()
        .all(|(_, class)| *class == TableClass::Disposable));
}

```

заменить на:

<!-- prettier-ignore -->
```rust
        "TABLE_CLASSES names each table of the migrations once, and nothing else"
    );
    // This device's own records are the production tables of `0006`; the
    // sign-in lockouts stay with the copies (an open owner question).
    let device_data: Vec<&str> = TABLE_CLASSES
        .iter()
        .filter(|(_, class)| *class == TableClass::DeviceData)
        .map(|(table, _)| *table)
        .collect();
    assert_eq!(
        device_data,
        [
            "floor_block_requests",
            "floor_boxes",
            "floor_codes",
            "floor_exceptions",
            "floor_scans",
            "floor_shifts",
            "floor_sscc_blocks",
            "outbox"
        ]
    );
    assert_eq!(
        table_class("floor_sign_in_failures"),
        Some(TableClass::Disposable)
    );
    // No foreign key anywhere: a delete of a forget would fail on one, or
    // change a kept row through `ON DELETE CASCADE` or `SET NULL`.
    let keys = db
        .query(
            "SELECT t.name AS name FROM pragma_table_list AS t, \
             pragma_foreign_key_list(t.name) AS k WHERE t.schema = 'main' AND t.type = 'table'",
            vec![],
        )
        .await
        .unwrap();
    assert!(keys.is_empty(), "foreign keys: {keys:?}");
}

```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
    .await
    .unwrap();
    // Tables as a later migration might add them; the webview may not create
    // tables, so a raw connection does.
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    for sql in [
        "CREATE TABLE kept_device_records (id TEXT PRIMARY KEY)",
        "CREATE TABLE kept_workstation_settings (key TEXT PRIMARY KEY)",
        "INSERT INTO kept_device_records (id) VALUES ('scan-1')",
        "INSERT INTO kept_workstation_settings (key) VALUES ('printers')",
    ] {
        sqlx::query(sql).execute(&mut raw).await.unwrap();
    }
    raw.close().await.unwrap();
    let journal = "SELECT count(*) AS n FROM _sqlx_migrations";
    let migrations = db.query(journal, vec![]).await.unwrap();
```

заменить на:

<!-- prettier-ignore -->
```rust
    .await
    .unwrap();
    // One record in each table of this device's own (`0006`).
    db.transaction(device_records()).await.unwrap();
    // A table of the workstation's settings as plan 2a7 will add it; the
    // webview may not create tables, so a raw connection does.
    run_raw(
        dir.path(),
        &[
            "CREATE TABLE kept_workstation_settings (key TEXT PRIMARY KEY)",
            "INSERT INTO kept_workstation_settings (key) VALUES ('printers')",
        ],
    )
    .await;
    let journal = "SELECT count(*) AS n FROM _sqlx_migrations";
    let migrations = db.query(journal, vec![]).await.unwrap();
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
    assert_eq!(db.clear_copies(UnsentGuard::Ignore).await, Ok(()));

    for (table, _) in TABLE_CLASSES {
        let left = db
            .query(&format!("SELECT count(*) AS n FROM {table}"), vec![])
```

заменить на:

<!-- prettier-ignore -->
```rust
    assert_eq!(db.clear_copies(UnsentGuard::Ignore).await, Ok(()));

    for (table, class) in TABLE_CLASSES {
        let left = db
            .query(&format!("SELECT count(*) AS n FROM {table}"), vec![])
```

Фрагмент 5:

<!-- prettier-ignore -->
```rust
            .await
            .unwrap();
        assert_eq!(Value::Object(left[0].clone()), json!({ "n": 0 }), "{table}");
    }
    let kept = db
        .query(
            "SELECT (SELECT count(*) FROM kept_device_records) \
             + (SELECT count(*) FROM kept_workstation_settings) AS n",
            vec![],
        )
```

заменить на:

<!-- prettier-ignore -->
```rust
            .await
            .unwrap();
        let expected = if *class == TableClass::Disposable {
            0
        } else {
            1
        };
        assert_eq!(
            Value::Object(left[0].clone()),
            json!({ "n": expected }),
            "{table}"
        );
    }
    let kept = db
        .query(
            "SELECT count(*) AS n FROM kept_workstation_settings",
            vec![],
        )
```

Фрагмент 6:

<!-- prettier-ignore -->
```rust
        .await
        .unwrap();
    assert_eq!(Value::Object(kept[0].clone()), json!({ "n": 2 }));
    assert_eq!(db.query(journal, vec![]).await.unwrap(), migrations);
    // The database takes writes afterwards as before.
```

заменить на:

<!-- prettier-ignore -->
```rust
        .await
        .unwrap();
    assert_eq!(Value::Object(kept[0].clone()), json!({ "n": 1 }));
    assert_eq!(db.query(journal, vec![]).await.unwrap(), migrations);
    // The database takes writes afterwards as before.
```

Фрагмент 7:

<!-- prettier-ignore -->
```rust

/// Runs `statements` on a raw connection, as a later migration would: the
/// webview may not create tables. `outbox` here stands for plan 2a5's table
/// with only the columns a forget reads; plan 2a5 replaces it with its own.
async fn run_raw(dir: &std::path::Path, statements: &[&str]) {
    let mut raw = SqliteConnectOptions::new()
```

заменить на:

<!-- prettier-ignore -->
```rust

/// Runs `statements` on a raw connection, as a later migration would: the
/// webview may not create tables.
async fn run_raw(dir: &std::path::Path, statements: &[&str]) {
    let mut raw = SqliteConnectOptions::new()
```

Фрагмент 8:

<!-- prettier-ignore -->
```rust
}

const OUTBOX: &str = "CREATE TABLE outbox (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, \
    device_id TEXT NOT NULL, acked_at TEXT)";

async fn count(db: &LocalDb, table: &str) -> Value {
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// An outbox record of the pairing `(host, device)`, acknowledged at `acked`
/// (an `accepted` receipt) or not yet.
fn outbox_record(id: &str, host: &str, device: &str, acked: Option<&str>) -> LocalStatement {
    statement(
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, \
         outcome, acked_at) VALUES (?, ?, ?, 'scan', 'shift-1', '{}', \
         '2026-10-09T08:00:00.000Z', ?, ?)",
        json!([id, host, device, acked.map(|_| "accepted"), acked]),
    )
}

/// One row in each table of this device's own records (migration `0006`),
/// each of the pairing `(HOST, DEVICE)`, as the floor's writers will write
/// them through `local_transaction`.
fn device_records() -> Vec<LocalStatement> {
    vec![
        statement(
            "INSERT INTO floor_shifts (host_id, device_id, id, number, status, mode, \
             pallets_enabled, created_from, line_id, product_id, product_name, product_gtin14, \
             production_date, box_capacity, box_template_id, owner_device_id, opened_at, \
             snapshot, entered_at, seen_at) VALUES (?, ?, 'shift-1', 'OCT26-004', 'active', \
             'aggregation', 0, 'office', ?, 'product-1', 'Молоко', '04600682000013', \
             '2026-10-08', 12, 'template-1', ?, '2026-10-08T06:02:00Z', '{}', \
             '2026-10-08T06:02:01.000Z', 1790000000000)",
            json!([HOST, DEVICE, LINE_1, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_sscc_blocks (block_id, host_id, device_id, issuer_prefix, \
             extension, from_serial, to_serial, next_serial, received_at) \
             VALUES ('block-1', ?, ?, '460068200', 0, 1, 2000, 1, '2026-10-08T06:02:02.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_block_requests (request_id, host_id, device_id, issuer_prefix, \
             extension, requested_at) VALUES ('request-1', ?, ?, '460068200', 0, \
             '2026-10-08T06:02:02.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, item_count) \
             VALUES ('box-1', ?, ?, 'shift-1', '2026-10-08T06:03:00.000Z', 1)",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, \
             scanned_at) VALUES (?, ?, 'hash-1', 'shift-1', 'box-1', 'scan-1', \
             '2026-10-08T06:03:00.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_scans (id, host_id, device_id, shift_id, box_id, verdict, \
             raw_kind, raw_length, code_hash, gtin14, serial, canonical, scanned_at) \
             VALUES ('scan-1', ?, ?, 'shift-1', 'box-1', 'ok', 'km', 31, 'hash-1', \
             '04600682000013', 'abc', 'code', '2026-10-08T06:03:00.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_exceptions (id, host_id, device_id, shift_id, kind, box_id, \
             occurred_at) VALUES ('exception-1', ?, ?, 'shift-1', 'clear', 'box-1', \
             '2026-10-08T06:04:00.000Z')",
            json!([HOST, DEVICE]),
        ),
        outbox_record("record-1", HOST, DEVICE, None),
    ]
}

async fn count(db: &LocalDb, table: &str) -> Value {
```

Фрагмент 9:

<!-- prettier-ignore -->
```rust
#[tokio::test]
async fn a_forget_refuses_while_unsent_records_remain() {
    let (dir, db) = open().await;
    db.transaction(vec![statement(
        INSERT_LINE,
```

заменить на:

<!-- prettier-ignore -->
```rust
#[tokio::test]
async fn a_forget_refuses_while_unsent_records_remain() {
    let (_dir, db) = open().await;
    db.transaction(vec![statement(
        INSERT_LINE,
```

Фрагмент 10:

<!-- prettier-ignore -->
```rust
    .await
    .unwrap();
    let mine = format!("INSERT INTO outbox VALUES ('a', '{HOST}', '{DEVICE}', NULL)");
    let others = format!("INSERT INTO outbox VALUES ('b', '{HOST}', '{OTHER_DEVICE}', NULL)");
    run_raw(dir.path(), &[OUTBOX, &mine, &others]).await;

    assert_eq!(
```

заменить на:

<!-- prettier-ignore -->
```rust
    .await
    .unwrap();
    db.transaction(vec![
        outbox_record("a", HOST, DEVICE, None),
        outbox_record("b", HOST, OTHER_DEVICE, None),
    ])
    .await
    .unwrap();

    assert_eq!(
```

Фрагмент 11:

<!-- prettier-ignore -->
```rust

/// Records with a receipt, and another pairing's, do not stop this
/// pairing's forget; nor does a database without an outbox yet (before plan
/// 2a5's migration).
#[tokio::test]
async fn sent_records_and_other_pairings_do_not_stop_a_forget() {
    let (dir, db) = open().await;
    assert_eq!(
        db.clear_copies(UnsentGuard::Pairing(HOST, DEVICE)).await,
```

заменить на:

<!-- prettier-ignore -->
```rust

/// Records with a receipt, and another pairing's, do not stop this
/// pairing's forget; nor does an empty outbox.
#[tokio::test]
async fn sent_records_and_other_pairings_do_not_stop_a_forget() {
    let (_dir, db) = open().await;
    assert_eq!(
        db.clear_copies(UnsentGuard::Pairing(HOST, DEVICE)).await,
```

Фрагмент 12:

<!-- prettier-ignore -->
```rust
    assert_eq!(db.clear_copies(UnsentGuard::AnyPairing).await, Ok(()));

    let acked = format!(
        "INSERT INTO outbox VALUES ('a', '{HOST}', '{DEVICE}', '2026-10-09T08:00:00.000Z')"
    );
    let others = format!("INSERT INTO outbox VALUES ('b', '{HOST}', '{OTHER_DEVICE}', NULL)");
    run_raw(dir.path(), &[OUTBOX, &acked, &others]).await;
    assert_eq!(
        db.clear_copies(UnsentGuard::Pairing(HOST, DEVICE)).await,
```

заменить на:

<!-- prettier-ignore -->
```rust
    assert_eq!(db.clear_copies(UnsentGuard::AnyPairing).await, Ok(()));

    db.transaction(vec![
        outbox_record("a", HOST, DEVICE, Some("2026-10-09T08:00:00.000Z")),
        outbox_record("b", HOST, OTHER_DEVICE, None),
    ])
    .await
    .unwrap();
    assert_eq!(
        db.clear_copies(UnsentGuard::Pairing(HOST, DEVICE)).await,
```

Правка `apps/standalone/src-tauri/tests/ipc.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
}

/// `outbox` as plan 2a5's migration will create it, with only the columns a
/// forget reads; plan 2a5 replaces it with its own table here.
const OUTBOX: &str = "CREATE TABLE outbox (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, \
    device_id TEXT NOT NULL, acked_at TEXT)";
const PAIRED_HOST: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const PAIRED_DEVICE: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// An outbox record without a receipt of the pairing `(host, device)`, in
/// the table of migration `0006`.
fn unsent_record(id: &str, host: &str, device: &str) -> String {
    format!(
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) \
         VALUES ('{id}', '{host}', '{device}', 'scan', 'shift-1', '{{}}', \
         '2026-10-09T08:00:00.000Z')"
    )
}
const PAIRED_HOST: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const PAIRED_DEVICE: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
    save_pairing(app_dir.path());
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    let unsent =
        format!("INSERT INTO outbox VALUES ('r1', '{PAIRED_HOST}', '{PAIRED_DEVICE}', NULL)");
    run_raw(
        app_dir.path(),
        &[
            OUTBOX,
            &unsent,
            "INSERT INTO sync_state (key, value) VALUES ('last_rev', '1')",
```

заменить на:

<!-- prettier-ignore -->
```rust
    save_pairing(app_dir.path());
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    let unsent = unsent_record("r1", PAIRED_HOST, PAIRED_DEVICE);
    run_raw(
        app_dir.path(),
        &[
            &unsent,
            "INSERT INTO sync_state (key, value) VALUES ('last_rev', '1')",
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
    run_raw(
        app_dir.path(),
        &[
            OUTBOX,
            "INSERT INTO outbox VALUES ('r1', 'another-host', 'another-device', NULL)",
        ],
    );
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);
```

заменить на:

<!-- prettier-ignore -->
```rust
    run_raw(
        app_dir.path(),
        &[&unsent_record("r1", "another-host", "another-device")],
    );
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-schema.test.ts test/local-executor.test.ts`
Expected: FAIL — `Tests  11 failed | 53 passed (64)`: десять тестов `floor-schema` (`no such table: floor_shifts`, `floor_scans`, `floor_boxes`, `outbox` …) и `local-executor` › «has exactly the shell's tables».

Run (в песочнице): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`
Expected: FAIL — `5 failed`: `opening_creates_the_reference_tables_in_wal_mode_and_keeps_data`, `every_table_has_a_forget_class`, `clearing_the_copies_empties_the_disposable_tables_and_nothing_else`, `a_forget_refuses_while_unsent_records_remain`, `sent_records_and_other_pairings_do_not_stop_a_forget`.

Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc`
Expected: FAIL — `2 failed`: `forgetting_the_device_waits_for_this_pairings_unsent_records` и `with_an_unreadable_pairing_any_unsent_record_stops_a_forget` (`no such table: outbox`).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src-tauri/migrations/0006_floor_production.sql`:

<!-- prettier-ignore -->
```sql
-- The station's own production records (stage 2a spec §5.3, plan 2a5): the
-- copies of its line's shifts with the snapshot of each shift it entered, the
-- SSCC blocks the host issued to it and the requests for them, its boxes, the
-- codes it accepted, every scan, the box exceptions and the outbox of facts
-- for the host. Unlike the reference copies these are this device's data: a
-- forget keeps them (`TableClass::DeviceData` in `src-tauri/src/local_db.rs`),
-- and every row carries the pairing it was written under (`host_id`,
-- `device_id`), so the floor reads only the current pairing's rows and a
-- forget with unsent records leaves them on disk for support.
--
-- No foreign keys: a key between tables of different classes would make a
-- forget fail or, with `ON DELETE CASCADE`, silently change kept rows. The
-- writers keep the links (one `local_transaction` per fact and its outbox
-- record). Times are UTC RFC 3339 text as `Date.toISOString` writes it,
-- except `seen_at` (Unix milliseconds on this computer's clock); a production
-- date is a civil date `YYYY-MM-DD`. `kind` of the outbox has no CHECK on
-- purpose: the pallets of the pilot add kinds, and a SQLite CHECK changes
-- only by rebuilding its table.

-- What the host lists in `GET /v1/device/shifts` (`DeviceShift`), as the last
-- read saw it, plus what this station keeps of a shift it entered: the
-- snapshot from the answer to `POST …/enter` (the frozen product, layout and
-- issuer prefix; JSON text) and when it first entered. A read replaces the
-- host's fields and never the station's own; `local_state` is this station's
-- close (plan 2a8), which overrides a stale `active` from the host.
CREATE TABLE floor_shifts (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  id TEXT NOT NULL,
  number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'closed')),
  mode TEXT NOT NULL,
  pallets_enabled INTEGER NOT NULL CHECK (pallets_enabled IN (0, 1)),
  created_from TEXT NOT NULL CHECK (created_from IN ('office', 'station')),
  line_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  product_gtin14 TEXT NOT NULL,
  counterparty_name TEXT,
  production_date TEXT NOT NULL,
  planned_qty INTEGER CHECK (planned_qty IS NULL OR planned_qty > 0),
  box_capacity INTEGER NOT NULL CHECK (box_capacity > 0),
  box_template_id TEXT NOT NULL,
  owner_device_id TEXT,
  opened_at TEXT,
  closed_at TEXT,
  snapshot TEXT CHECK (snapshot IS NULL OR json_valid(snapshot)),
  entered_at TEXT,
  local_state TEXT CHECK (local_state IN ('closing', 'closed')),
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, device_id, id),
  -- A snapshot is kept exactly for a shift this station entered.
  CHECK ((snapshot IS NULL) = (entered_at IS NULL)),
  -- Only a shift it entered can this station close.
  CHECK (local_state IS NULL OR entered_at IS NOT NULL)
);

CREATE INDEX floor_shifts_line ON floor_shifts (host_id, device_id, line_id);

-- The SSCC serials the host issued to this station (`SsccBlock`):
-- `next_serial` is the next one to use, moved by a compare-and-set in the
-- transaction that closes a box; `to_serial + 1` means the block is used up.
CREATE TABLE floor_sscc_blocks (
  block_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  issuer_prefix TEXT NOT NULL,
  extension INTEGER NOT NULL CHECK (extension IN (0, 1)),
  from_serial INTEGER NOT NULL CHECK (from_serial >= 0),
  to_serial INTEGER NOT NULL,
  next_serial INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  CHECK (to_serial >= from_serial),
  CHECK (next_serial BETWEEN from_serial AND to_serial + 1)
);

CREATE INDEX floor_sscc_blocks_prefix
  ON floor_sscc_blocks (host_id, device_id, issuer_prefix, extension);

-- A block request without an answer yet: written before the request and
-- deleted in the transaction that keeps the block, so a retry after a failure
-- or a restart repeats the same request (`requestId`), whole.
CREATE TABLE floor_block_requests (
  request_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  issuer_prefix TEXT NOT NULL,
  extension INTEGER NOT NULL CHECK (extension IN (0, 1)),
  requested_at TEXT NOT NULL
);

-- A box of a shift: open (no SSCC) until it closes with the serial of one of
-- this station's blocks. An SSCC is never on two boxes, under any pairing: a
-- second box with a printed number is a duplicate label.
CREATE TABLE floor_boxes (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  sscc TEXT,
  block_id TEXT,
  serial INTEGER,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  closed_by TEXT,
  disassembled_at TEXT,
  needs_fix INTEGER NOT NULL DEFAULT 0 CHECK (needs_fix IN (0, 1)),
  CHECK (CASE WHEN closed_at IS NULL
    THEN sscc IS NULL AND block_id IS NULL AND serial IS NULL AND disassembled_at IS NULL
    ELSE sscc IS NOT NULL AND block_id IS NOT NULL AND serial IS NOT NULL END)
);

CREATE UNIQUE INDEX floor_boxes_sscc ON floor_boxes (sscc) WHERE sscc IS NOT NULL;

-- One open box per shift.
CREATE UNIQUE INDEX floor_boxes_open
  ON floor_boxes (host_id, device_id, shift_id) WHERE closed_at IS NULL;

-- The codes this station accepted and still holds in a box: its own check for
-- duplicates (`kmHash`), within the pairing. An exception that takes a code
-- out of a box deletes its row.
CREATE TABLE floor_codes (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  box_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  PRIMARY KEY (host_id, device_id, code_hash)
);

-- Every scan of the work screen, accepted or not (a `scan` fact). A scan that
-- is no code of marking keeps only its length and what it looked like, never
-- its text: it may be a badge, whose code is a secret (decision 15).
CREATE TABLE floor_scans (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  box_id TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('ok', 'duplicate', 'wrong_gtin', 'invalid')),
  duplicate_source TEXT CHECK (duplicate_source IN ('local', 'host')),
  raw_kind TEXT NOT NULL CHECK (raw_kind IN ('km', 'gtin', 'sscc', 'unknown')),
  raw_length INTEGER NOT NULL CHECK (raw_length >= 0),
  code_hash TEXT,
  gtin14 TEXT,
  serial TEXT,
  canonical TEXT,
  scanned_at TEXT NOT NULL,
  operator_id TEXT,
  conflict INTEGER NOT NULL DEFAULT 0 CHECK (conflict IN (0, 1)),
  CHECK ((verdict = 'duplicate') = (duplicate_source IS NOT NULL)),
  CHECK ((verdict = 'invalid') = (raw_kind <> 'km')),
  CHECK ((verdict = 'ok') = (box_id IS NOT NULL)),
  CHECK (CASE WHEN raw_kind = 'km'
    THEN code_hash IS NOT NULL AND gtin14 IS NOT NULL AND serial IS NOT NULL
      AND canonical IS NOT NULL
    ELSE code_hash IS NULL AND gtin14 IS NULL AND serial IS NULL AND canonical IS NULL END)
);

CREATE INDEX floor_scans_shift ON floor_scans (host_id, device_id, shift_id);

-- A box exception (a `box_exception` fact) with the fields of its kind, as the
-- host's rules have them: `undo` names the code and its scan's time, `clear`
-- nothing, `reprint` and `disassemble` a reason, whose words come only with
-- the reason `other`.
CREATE TABLE floor_exceptions (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('undo', 'clear', 'reprint', 'disassemble')),
  box_id TEXT NOT NULL,
  code_hash TEXT,
  target_scanned_at TEXT,
  reason_code TEXT,
  reason_text TEXT,
  occurred_at TEXT NOT NULL,
  operator_id TEXT,
  CHECK (CASE kind
    WHEN 'undo' THEN code_hash IS NOT NULL AND target_scanned_at IS NOT NULL
      AND reason_code IS NULL
    WHEN 'clear' THEN code_hash IS NULL AND target_scanned_at IS NULL AND reason_code IS NULL
    ELSE code_hash IS NULL AND target_scanned_at IS NULL AND reason_code IS NOT NULL END),
  CHECK (reason_text IS NULL OR reason_code = 'other')
);

-- The facts for the host, in the order they happened (`seq`): `payload` is the
-- whole `FactRecord` as it is sent (`{ id, kind, shiftId, operatorId, data }`),
-- written in the transaction of the fact itself. A record without a receipt
-- (`acked_at IS NULL`) is unsent, and a forget refuses while this pairing has
-- one (`device_forget`, `unsent_facts`). `seq` is a plain rowid alias, not
-- AUTOINCREMENT, which would add the unclassified table `sqlite_sequence`.
CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at TEXT,
  outcome TEXT CHECK (outcome IN ('accepted', 'conflict', 'rejected')),
  outcome_code TEXT,
  outcome_details TEXT CHECK (outcome_details IS NULL OR json_valid(outcome_details)),
  acked_at TEXT,
  CHECK ((outcome IS NULL) = (acked_at IS NULL)),
  CHECK (outcome IS NOT NULL OR (outcome_code IS NULL AND outcome_details IS NULL))
);

CREATE INDEX outbox_unsent ON outbox (host_id, device_id, seq) WHERE acked_at IS NULL;
```

Правка `apps/standalone/src-tauri/src/local_db.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
/// adds a table adds it here in the same change: `tests/local_db.rs` fails on
/// a table without a class, and on a name here that no migration creates. No
/// table has a foreign key; one between tables of different classes would
/// make a forget fail at its commit, so add none.
pub const TABLE_CLASSES: &[(&str, TableClass)] = &[
    ("floor_sign_in_failures", TableClass::Disposable),
    ("ref_lines", TableClass::Disposable),
    ("ref_operator_badges", TableClass::Disposable),
```

заменить на:

<!-- prettier-ignore -->
```rust
/// adds a table adds it here in the same change: `tests/local_db.rs` fails on
/// a table without a class, and on a name here that no migration creates. No
/// table has a foreign key (the same test checks): one would make a forget
/// fail at its delete or, with `ON DELETE CASCADE` or `SET NULL`, silently
/// change rows a forget keeps, so add none. `floor_sign_in_failures` is
/// disposable although this device wrote it: a new pairing brings a new
/// roster (`apps/standalone/AGENTS.md`, «Local database»), and keeping the
/// lockout counters across a forget is an open owner question.
pub const TABLE_CLASSES: &[(&str, TableClass)] = &[
    ("floor_block_requests", TableClass::DeviceData),
    ("floor_boxes", TableClass::DeviceData),
    ("floor_codes", TableClass::DeviceData),
    ("floor_exceptions", TableClass::DeviceData),
    ("floor_scans", TableClass::DeviceData),
    ("floor_shifts", TableClass::DeviceData),
    ("floor_sign_in_failures", TableClass::Disposable),
    ("floor_sscc_blocks", TableClass::DeviceData),
    ("outbox", TableClass::DeviceData),
    ("ref_lines", TableClass::Disposable),
    ("ref_operator_badges", TableClass::Disposable),
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
/// How many outbox records without a receipt (`acked_at IS NULL`) `guard`
/// protects, counted inside the forget's own transaction, so no record can
/// arrive between the count and the clear. 0 while no migration has created
/// `outbox` (plan 2a5 does, with the columns `host_id`, `device_id` and
/// `acked_at`).
async fn unsent_records(
    tx: &mut sqlx::SqliteConnection,
```

заменить на:

<!-- prettier-ignore -->
```rust
/// How many outbox records without a receipt (`acked_at IS NULL`) `guard`
/// protects, counted inside the forget's own transaction, so no record can
/// arrive between the count and the clear (`outbox`, migration `0006`).
async fn unsent_records(
    tx: &mut sqlx::SqliteConnection,
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
    let failed = |_| LocalDbError::StatementFailed;
    if guard == UnsentGuard::Ignore {
        return Ok(0);
    }
    let outbox: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pragma_table_list WHERE schema = 'main' AND name = 'outbox'",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(failed)?;
    if outbox == 0 {
        return Ok(0);
    }
```

заменить на:

<!-- prettier-ignore -->
```rust
    let failed = |_| LocalDbError::StatementFailed;
    if guard == UnsentGuard::Ignore {
        return Ok(0);
    }
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-schema.test.ts test/local-executor.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  64 passed (64)`.

Run (в песочнице): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`
Expected: PASS — `local_db` 16.

Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc`
Expected: PASS — `ipc` 18.

- [ ] **Step 5: Мутации**

1. `apps/standalone/src-tauri/migrations/0006_floor_production.sql`: `  CHECK (CASE WHEN raw_kind = 'km'` → `  CHECK (1 OR CASE WHEN raw_kind = 'km'`. Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-schema.test.ts`. Expected: FAIL — «never keep the text of a scan that is no code of marking».
2. Тот же файл: `ON floor_boxes (host_id, device_id, shift_id) WHERE closed_at IS NULL;` → `ON floor_boxes (host_id, device_id, shift_id);`. Тот же Run. Expected: FAIL — «hold one open box per shift and pairing, and an SSCC on one box under any pairing» (`UNIQUE constraint failed: floor_boxes.host_id, floor_boxes.device_id, floor_boxes.shift_id`).
3. `apps/standalone/src-tauri/src/local_db.rs`, фильтр классов в `clear_copies` (в исполненном плане 2a4 он может стоять в `clear_classed`): `.filter(|(_, class)| *class == TableClass::Disposable);` → `.filter(|_| true);`. Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`. Expected: FAIL — `clearing_the_copies_empties_the_disposable_tables_and_nothing_else` (`floor_block_requests`), `a_forget_refuses_while_unsent_records_remain` («the records stay»), `sent_records_and_other_pairings_do_not_stop_a_forget`.
4. Тот же файл: `    ("outbox", TableClass::DeviceData),` → `    ("outbox", TableClass::Disposable),`. Тот же Run. Expected: FAIL — `every_table_has_a_forget_class`, `a_forget_refuses_while_unsent_records_remain`, `sent_records_and_other_pairings_do_not_stop_a_forget`.

Мутации 1–2 правят миграцию: файл возвращается побайтно (`cmp`, тот же `shasum`) до сборки Rust, иначе sqlx встроит изменённый текст.

- [ ] **Step 6: Чистота**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/test/floor-schema.test.ts apps/standalone/test/local-executor.test.ts`; `git diff --check`
Expected: чисто.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src-tauri/migrations/0006_floor_production.sql apps/standalone/src-tauri/src/local_db.rs apps/standalone/src-tauri/tests/local_db.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/test/floor-schema.test.ts apps/standalone/test/local-executor.test.ts
git commit -m "feat(standalone): the station's production tables as its own data, each row of its pairing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Протокол смен устройства — схемы Zod, построитель, `HostApi`

Схемы по фикстурам плана 2a1: `deviceShiftSchema` (ответ — `z.object`, незнакомое поле нового хоста не роняет разбор), `deviceShiftsSchema`, `shiftSnapshotSchema` с макетом-непрозрачным объектом (`templateSpecSchema`: макет проверяет станция при входе, задача 3), `enteredShiftSchema` (ответ входа — смена со снимком, без снимка — отказ разбора), строгая `deviceShiftCreateSchema`. Построитель `deviceShiftCreate` шлёт каждое поле и `counterpartyId: null`: копий контрагентов на станции нет. Методы `HostApi` идут с ключом устройства, без сессии офиса. Поддельный `HostApi` тестов (`fakeHostApi`) отвечает на `getDeviceShifts` пустым списком: с задачи 4 приложение читает смены при каждом чтении устройства, а тесты, которые не о сменах, их не задают.

**Files:**

- Modify: `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/requests.ts`, `apps/standalone/src/host/api.ts`
- Test: `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/api.test.ts`, `apps/standalone/test/support/office.tsx` (Modify)

**Interfaces:**

- Consumes: `shiftStatusSchema`, `shiftModeSchema`, `shiftOriginSchema`, `civilDateTextSchema`, `templateSpecSchema` (`src/host/protocol.ts`); фикстуры `proto/fixtures/device-shifts.json`, `device-shift-entered.json`, `device-shift-create.json`.
- Produces:
  - `src/host/protocol.ts`: `shiftSnapshotProductSchema`, `shiftSnapshotTemplateSchema`, `shiftSnapshotSchema`, `type ShiftSnapshot`, `deviceShiftSchema`, `type DeviceShift`, `deviceShiftsSchema`, `enteredShiftSchema`, `type EnteredShift` (`DeviceShift & { snapshot: ShiftSnapshot }`), `deviceShiftCreateSchema`, `type DeviceShiftCreate`;
  - `src/host/requests.ts`: `interface DeviceShiftInput { requestId; productId; boxTemplateId; productionDate; boxCapacity: number; plannedQty: number | null }`, `deviceShiftCreate(shift: DeviceShiftInput): DeviceShiftCreate`;
  - `src/host/api.ts`: `HostApi.getDeviceShifts: () => Promise<DeviceShift[]>`, `createDeviceShift: (create: DeviceShiftCreate) => Promise<DeviceShift>`, `enterShift: (id: string) => Promise<EnteredShift>`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/protocol.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  deviceInfoSchema,
  deviceRecordSchema,
  deviceUpdateSchema,
  errorBodySchema,
  helloSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
  deviceInfoSchema,
  deviceRecordSchema,
  deviceShiftCreateSchema,
  deviceShiftsSchema,
  deviceUpdateSchema,
  enteredShiftSchema,
  errorBodySchema,
  helloSchema,
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  counterpartyCreate,
  counterpartyUpdate,
  deviceUpdate,
  lineCreate,
```

заменить на:

<!-- prettier-ignore -->
```ts
  counterpartyCreate,
  counterpartyUpdate,
  deviceShiftCreate,
  deviceUpdate,
  lineCreate,
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  ["error-shift-busy.json", errorBodySchema],
  ["error-sscc-exhausted.json", errorBodySchema],
] as const;

```

заменить на:

<!-- prettier-ignore -->
```ts
  ["error-shift-busy.json", errorBodySchema],
  ["error-sscc-exhausted.json", errorBodySchema],
  ["device-shifts.json", deviceShiftsSchema],
  ["device-shift-entered.json", enteredShiftSchema],
] as const;

```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  ["shift-update.json", shiftUpdateSchema],
  ["shift-close.json", shiftCloseSchema],
] as const;

```

заменить на:

<!-- prettier-ignore -->
```ts
  ["shift-update.json", shiftUpdateSchema],
  ["shift-close.json", shiftCloseSchema],
  ["device-shift-create.json", deviceShiftCreateSchema],
] as const;

```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
      fixture("shift-close.json"),
    );
  });

```

заменить на:

<!-- prettier-ignore -->
```ts
      fixture("shift-close.json"),
    );
  });

  it("a station's new shift, with no counterparty, of which the station keeps no copy", () => {
    const shift = deviceShiftCreateSchema.parse(fixture("device-shift-create.json"));
    // The screen holds more than the builder names: the product's name must not go.
    const typed = {
      requestId: shift.requestId,
      productId: shift.productId,
      boxTemplateId: shift.boxTemplateId,
      productionDate: shift.productionDate,
      boxCapacity: 12,
      plannedQty: null,
      productName: "Молоко 3,2% 0,9 л",
    };
    expect(deviceShiftCreate(typed)).toStrictEqual(fixture("device-shift-create.json"));
    expect(deviceShiftCreate({ ...typed, plannedQty: 1200 })).toStrictEqual({
      ...shift,
      plannedQty: 1200,
    });
  });

```

Правка `apps/standalone/test/api.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  counterpartyCreateSchema,
  counterpartyUpdateSchema,
  deviceUpdateSchema,
  labelTemplateSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
  counterpartyCreateSchema,
  counterpartyUpdateSchema,
  deviceShiftCreateSchema,
  deviceUpdateSchema,
  labelTemplateSchema,
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
      { method: "GET", path: "/v1/changes?since=41", body: undefined, officeToken: undefined },
    ]);
  });
});
```

заменить на:

<!-- prettier-ignore -->
```ts
      { method: "GET", path: "/v1/changes?since=41", body: undefined, officeToken: undefined },
    ]);
  });
});

describe("HostApi device shifts", () => {
  const list = fixture("device-shifts.json");
  const entered = fixture("device-shift-entered.json");
  const CREATE = deviceShiftCreateSchema.parse(fixture("device-shift-create.json"));

  it("reads, creates and enters shifts with the device key only, no office session", async () => {
    const reading = recording(list);
    await expect(reading.api.getDeviceShifts()).resolves.toMatchObject([
      { number: "OCT26-004", status: "active" },
      { number: "OCT26-005/S", status: "planned" },
    ]);
    const creating = recording((list as { shifts: unknown[] }).shifts[1]);
    await expect(creating.api.createDeviceShift(CREATE)).resolves.toMatchObject({
      number: "OCT26-005/S",
    });
    const entering = recording(entered);
    await expect(entering.api.enterShift(SHIFT_ID)).resolves.toMatchObject({
      status: "active",
      snapshot: { issuerPrefix: "460068200" },
    });
    expect([...reading.sent, ...creating.sent, ...entering.sent]).toEqual([
      { method: "GET", path: "/v1/device/shifts", body: undefined, officeToken: undefined },
      { method: "POST", path: "/v1/device/shifts", body: CREATE, officeToken: undefined },
      {
        method: "POST",
        path: `/v1/device/shifts/${SHIFT_ID}/enter`,
        body: undefined,
        officeToken: undefined,
      },
    ]);
  });

  it("rejects a list without its shifts and an entry without its snapshot", async () => {
    await expect(
      recording({ shifts: [entered, { id: 1 }] }).api.getDeviceShifts(),
    ).rejects.toThrow();
    await expect(
      recording((list as { shifts: unknown[] }).shifts).api.getDeviceShifts(),
    ).rejects.toThrow();
    const withoutSnapshot = { ...(entered as Record<string, unknown>) };
    delete withoutSnapshot["snapshot"];
    await expect(recording(withoutSnapshot).api.enterShift(SHIFT_ID)).rejects.toThrow();
    await expect(recording(withoutSnapshot).api.createDeviceShift(CREATE)).resolves.toMatchObject({
      id: SHIFT_ID,
    });
  });
});
```

Правка `apps/standalone/test/support/office.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
}

/** Every method a test did not stub fails loudly; `officeLogout` succeeds. */
export function fakeHostApi(overrides: Partial<FakeHostApi> = {}): FakeHostApi {
  return {
```

заменить на:

<!-- prettier-ignore -->
```tsx
}

/**
 * Every method a test did not stub fails loudly; `officeLogout` succeeds and
 * `getDeviceShifts` answers no shifts.
 */
export function fakeHostApi(overrides: Partial<FakeHostApi> = {}): FakeHostApi {
  return {
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
    deleteShift: vi.fn<HostApi["deleteShift"]>(() => unexpected("deleteShift")),
    closeShift: vi.fn<HostApi["closeShift"]>(() => unexpected("closeShift")),
    ...overrides,
  };
```

заменить на:

<!-- prettier-ignore -->
```tsx
    deleteShift: vi.fn<HostApi["deleteShift"]>(() => unexpected("deleteShift")),
    closeShift: vi.fn<HostApi["closeShift"]>(() => unexpected("closeShift")),
    // The floor reads its shifts whenever it reads its device record; a test
    // about something else gets none.
    getDeviceShifts: vi.fn<HostApi["getDeviceShifts"]>(async () => []),
    createDeviceShift: vi.fn<HostApi["createDeviceShift"]>(() => unexpected("createDeviceShift")),
    enterShift: vi.fn<HostApi["enterShift"]>(() => unexpected("enterShift")),
    ...overrides,
  };
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`
Expected: FAIL — `Tests  7 failed | 208 passed (215)` и упавший файл `test/api.test.ts` (`Cannot read properties of undefined (reading 'parse')`: схем ещё нет): фикстуры `device-shifts.json`, `device-shift-entered.json`, `device-shift-create.json` и «a station's new shift, with no counterparty, of which the station keeps no copy».

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/host/protocol.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
export type OfficeShift = z.infer<typeof officeShiftSchema>;

// --- Request bodies (strict) ---

```

заменить на:

<!-- prettier-ignore -->
```ts
export type OfficeShift = z.infer<typeof officeShiftSchema>;

/**
 * The product as a shift froze it when a station opened it
 * (`markiro_proto::ShiftSnapshotProduct`); only an active product opens a
 * shift, so it has a group.
 */
export const shiftSnapshotProductSchema = z.object({
  id: z.uuid(),
  gtin14: z.string(),
  name: z.string(),
  printName: z.string().nullable(),
  chzProductGroupCode: z.number().int().nonnegative(),
  shelfLifeDays: z.number().int().positive().nullable(),
});

/**
 * The box template as a shift froze it, with its whole layout: opaque here,
 * as in the feed (`templateSpecSchema`), and checked with the domain's
 * `labelTemplateSpecSchema` where the station enters the shift
 * (`checkShiftSnapshot`, `src/floor/shifts/shift-snapshot.ts`).
 */
export const shiftSnapshotTemplateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  rev: z.number().int(),
  spec: templateSpecSchema,
});

/**
 * What a shift freezes when a station opens it (`markiro_proto::ShiftSnapshot`):
 * the station prints and reprints from this alone. A response type, so a
 * field a newer host adds is tolerated (and dropped).
 */
export const shiftSnapshotSchema = z.object({
  product: shiftSnapshotProductSchema,
  boxTemplate: shiftSnapshotTemplateSchema,
  issuerPrefix: z.string(),
  counterpartyName: z.string().nullable(),
});
export type ShiftSnapshot = z.infer<typeof shiftSnapshotSchema>;

/**
 * A shift as a station sees it (`GET /v1/device/shifts`,
 * `markiro_proto::DeviceShift`): named by the snapshot once open and by the
 * records before; `ownerDeviceId` is the station that opened it, and another
 * station's id means the shift is busy.
 */
export const deviceShiftSchema = z.object({
  id: z.uuid(),
  number: z.string().min(1),
  status: shiftStatusSchema,
  mode: shiftModeSchema,
  palletsEnabled: z.boolean(),
  createdFrom: shiftOriginSchema,
  lineId: z.uuid(),
  productId: z.uuid(),
  productName: z.string(),
  productGtin14: z.string(),
  counterpartyName: z.string().nullable(),
  productionDate: civilDateTextSchema,
  plannedQty: z.number().int().positive().nullable(),
  boxCapacity: z.number().int().positive(),
  boxTemplateId: z.uuid(),
  ownerDeviceId: z.uuid().nullable(),
  openedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
});
export type DeviceShift = z.infer<typeof deviceShiftSchema>;

/** `GET /v1/device/shifts`: the station's shifts, without snapshots. */
export const deviceShiftsSchema = z.object({ shifts: z.array(deviceShiftSchema) });

/**
 * The answer of `POST /v1/device/shifts/{id}/enter`: the shift, now active and
 * this station's, with its snapshot (the same one on every re-entry).
 */
export const enteredShiftSchema = deviceShiftSchema.extend({ snapshot: shiftSnapshotSchema });
export type EnteredShift = z.infer<typeof enteredShiftSchema>;

// --- Request bodies (strict) ---

```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  .strict();
export type ShiftClose = z.infer<typeof shiftCloseSchema>;
```

заменить на:

<!-- prettier-ignore -->
```ts
  .strict();
export type ShiftClose = z.infer<typeof shiftCloseSchema>;

/**
 * `POST /v1/device/shifts` (`markiro_proto::DeviceShiftCreate`): a station's
 * planned shift on its own line. `requestId`, a UUID the station made up,
 * makes it repeatable: the same request answers the shift it created.
 */
export const deviceShiftCreateSchema = z
  .object({
    requestId: z.uuid(),
    productId: z.uuid(),
    boxTemplateId: z.uuid(),
    productionDate: z.string(),
    boxCapacity: z.number().int().positive().optional(),
    plannedQty: z.number().int().positive().nullable().optional(),
    counterpartyId: z.uuid().nullable().optional(),
  })
  .strict();
export type DeviceShiftCreate = z.infer<typeof deviceShiftCreateSchema>;
```

Правка `apps/standalone/src/host/requests.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  CounterpartyUpdate,
  DeviceRecord,
  DeviceUpdate,
  LabelTemplate,
```

заменить на:

<!-- prettier-ignore -->
```ts
  CounterpartyUpdate,
  DeviceRecord,
  DeviceShiftCreate,
  DeviceUpdate,
  LabelTemplate,
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  return { reason, expectedRev };
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  return { reason, expectedRev };
}

/** What a station's new shift carries: the operator's choices and the request's id. */
export interface DeviceShiftInput {
  requestId: string;
  productId: string;
  boxTemplateId: string;
  productionDate: string;
  boxCapacity: number;
  plannedQty: number | null;
}

/**
 * `POST /v1/device/shifts` (`device-shift-create.json`): every field, `null`
 * for no plan, and no counterparty, of which the station keeps no copy. The
 * line is the station's own and no field.
 */
export function deviceShiftCreate(shift: DeviceShiftInput): DeviceShiftCreate {
  return {
    requestId: shift.requestId,
    productId: shift.productId,
    boxTemplateId: shift.boxTemplateId,
    productionDate: shift.productionDate,
    boxCapacity: shift.boxCapacity,
    plannedQty: shift.plannedQty,
    counterpartyId: null,
  };
}
```

Правка `apps/standalone/src/host/api.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  counterpartyRecordSchema,
  deviceRecordSchema,
  labelTemplateSchema,
  labelTemplateSummarySchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
  counterpartyRecordSchema,
  deviceRecordSchema,
  deviceShiftSchema,
  deviceShiftsSchema,
  enteredShiftSchema,
  labelTemplateSchema,
  labelTemplateSummarySchema,
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  type CounterpartyUpdate,
  type DeviceRecord,
  type DeviceUpdate,
  type LabelTemplate,
  type LabelTemplateSummary,
```

заменить на:

<!-- prettier-ignore -->
```ts
  type CounterpartyUpdate,
  type DeviceRecord,
  type DeviceShift,
  type DeviceShiftCreate,
  type DeviceUpdate,
  type EnteredShift,
  type LabelTemplate,
  type LabelTemplateSummary,
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  deleteShift: (token: string, id: string) => Promise<void>;
  closeShift: (token: string, id: string, close: ShiftClose) => Promise<OfficeShift>;
}

```

заменить на:

<!-- prettier-ignore -->
```ts
  deleteShift: (token: string, id: string) => Promise<void>;
  closeShift: (token: string, id: string, close: ShiftClose) => Promise<OfficeShift>;
  /**
   * The station's shifts, with the device key only: the planned and active
   * shifts of its line and those it entered, active or closed within 30
   * days. Stations only (`forbidden` for another kind).
   */
  getDeviceShifts: () => Promise<DeviceShift[]>;
  /** A planned shift on the station's own line; the same `requestId` answers the same shift. */
  createDeviceShift: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  /**
   * Opens a planned shift or enters again the active one this station opened;
   * the answer carries the frozen snapshot.
   */
  enterShift: (id: string) => Promise<EnteredShift>;
}

```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
      });
    },
    closeShift: (token, id, close) =>
      client.request("POST", `/v1/office/shifts/${id}/close`, {
```

заменить на:

<!-- prettier-ignore -->
```ts
      });
    },
    getDeviceShifts: async () =>
      (await client.request("GET", "/v1/device/shifts", { schema: deviceShiftsSchema })).shifts,
    createDeviceShift: (create) =>
      client.request("POST", "/v1/device/shifts", { body: create, schema: deviceShiftSchema }),
    enterShift: (id) =>
      client.request("POST", `/v1/device/shifts/${id}/enter`, { schema: enteredShiftSchema }),
    closeShift: (token, id, close) =>
      client.request("POST", `/v1/office/shifts/${id}/close`, {
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  269 passed (269)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`
Expected: без ошибок.

- [ ] **Step 5: Мутации**

1. `apps/standalone/src/host/requests.ts`, в `deviceShiftCreate`: удалить строку `    counterpartyId: null,`. Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`. Expected: FAIL — «a station's new shift, with no counterparty, of which the station keeps no copy».
2. `apps/standalone/src/host/api.ts`, в `enterShift`: `{ schema: enteredShiftSchema }` → `{ schema: deviceShiftSchema }`. Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/api.test.ts`. Expected: FAIL — «reads, creates and enters shifts with the device key only, no office session» и «rejects a list without its shifts and an entry without its snapshot».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/src/host/api.ts apps/standalone/test/protocol.test.ts apps/standalone/test/api.test.ts apps/standalone/test/support/office.tsx`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `git diff --check`
Expected: чисто.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/src/host/api.ts apps/standalone/test/protocol.test.ts apps/standalone/test/api.test.ts apps/standalone/test/support/office.tsx
git commit -m "feat(standalone): the webview reads a station's shifts, creates one and enters it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Копии смен на станции и проверка снимка

`src/floor/shifts/shift-copies.ts` хранит список хоста в `floor_shifts` текущего подключения (§5.4): одна транзакция из двух операторов — удалить смены, которых нет в ответе и в которые станция не входила, и вставить или обновить остальные полями хоста (`json_each`, как синхронизация справочников). Столбцы станции — `snapshot`, `entered_at`, `local_state` — список не трогает. Смена, в которую станция входила, не возвращается в `planned`: так может сказать только список, прочитанный до входа и применённый после (условие `WHERE` у `ON CONFLICT`). `keepEnteredShift` пишет ответ входа со снимком и сохраняет время первого входа; `readStoredWork` читает сохранённый снимок и проверяет его снова. `src/floor/shifts/shift-snapshot.ts` — `checkShiftSnapshot`: схема снимка, GTIN-14 с контрольной цифрой, девять цифр префикса выпуска и макет по `labelTemplateSpecSchema` домена (решение 3: станция не пускает в смену с нечитаемым макетом).

**Files:**

- Create: `apps/standalone/src/floor/shifts/shift-copies.ts`, `apps/standalone/src/floor/shifts/shift-snapshot.ts`
- Test: `apps/standalone/test/shift-copies.test.ts` (Create)

**Interfaces:**

- Consumes: `DeviceShift`, `EnteredShift`, `shiftSnapshotSchema`, `shiftStatusSchema`, `shiftModeSchema`, `shiftOriginSchema` (задача 2); `LocalExecutor`, `LocalStatement` (`src/local/executor.ts`); `Pairing` (`src/local/reference-sync.ts`); `isValidGtin`, `labelTemplateSpecSchema`, `type LabelTemplateSpec` (`@markiro/domain`); таблица `floor_shifts` (задача 1).
- Produces:
  - `shift-snapshot.ts`: `interface CheckedSnapshot { product; boxTemplate: { id; name; rev; spec: LabelTemplateSpec }; issuerPrefix; counterpartyName }`, `type SnapshotRefusal = "shape" | "gtin" | "prefix" | "layout"`, `checkShiftSnapshot(raw: unknown): { ok: true; snapshot } | { ok: false; reason }`;
  - `shift-copies.ts`: `interface ShiftCopy` (поля `DeviceShift` и `localState: "closing" | "closed" | null`, `entered: boolean`), `interface WorkShift { copy: ShiftCopy; snapshot: CheckedSnapshot }`, `replaceShiftCopies(local, pairing, shifts, seenAt)`, `keepCreatedShift(local, pairing, shift, seenAt)`, `keepEnteredShift(local, pairing, shift: EnteredShift, enteredAt: string, seenAt: number)`, `readShiftCopies(local, pairing, lineId): Promise<ShiftCopy[]>`, `readShiftCopy(local, pairing, shiftId): Promise<ShiftCopy | null>`, `type StoredWork`, `readStoredWork(local, pairing, shiftId): Promise<StoredWork>`.

- [ ] **Step 1: Написать падающий тест**

Создать `apps/standalone/test/shift-copies.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  keepCreatedShift,
  keepEnteredShift,
  readShiftCopies,
  readShiftCopy,
  readStoredWork,
  replaceShiftCopies,
} from "../src/floor/shifts/shift-copies.js";
import { checkShiftSnapshot } from "../src/floor/shifts/shift-snapshot.js";
import {
  deviceShiftsSchema,
  enteredShiftSchema,
  type DeviceShift,
  type EnteredShift,
} from "../src/host/protocol.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const OTHER_PAIRING = { hostId: HOST_ID, deviceId: "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f" };
const [ACTIVE, PLANNED] = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts as [
  DeviceShift,
  DeviceShift,
];
const ENTERED: EnteredShift = enteredShiftSchema.parse(fixture("device-shift-entered.json"));
const OTHER_LINE = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
const SEEN = 1_790_000_000_000;
const AT = "2026-10-09T08:00:00.000Z";

const storedRow = z.object({
  status: z.string(),
  snapshot: z.string().nullable(),
  entered_at: z.string().nullable(),
  seen_at: z.number(),
});

async function stored(local: ReturnType<typeof openLocalDb>["executor"], id: string) {
  return local.query(
    "SELECT status, snapshot, entered_at, seen_at FROM floor_shifts WHERE id = ? ORDER BY device_id",
    [id],
    storedRow,
  );
}

describe("the station's copies of its shifts", () => {
  it("take the host's list as this pairing's, and show the line's open shifts by date", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [PLANNED, ACTIVE], SEEN);
    const copies = await readShiftCopies(executor, PAIRING, LINE_ID);
    expect(copies.map((copy) => copy.number)).toEqual(["OCT26-004", "OCT26-005/S"]);
    expect(copies[0]).toEqual({
      id: ACTIVE.id,
      number: "OCT26-004",
      status: "active",
      localState: null,
      mode: "aggregation",
      palletsEnabled: false,
      createdFrom: "office",
      lineId: LINE_ID,
      productId: ACTIVE.productId,
      productName: "Молоко 3,2% 0,9 л",
      productGtin14: "04600682000013",
      counterpartyName: "ООО «Северный берег»",
      productionDate: "2026-10-08",
      plannedQty: 1200,
      boxCapacity: 12,
      boxTemplateId: ACTIVE.boxTemplateId,
      ownerDeviceId: ACTIVE.ownerDeviceId,
      openedAt: "2026-10-08T06:02:00Z",
      closedAt: null,
      entered: false,
    });
    expect(await readShiftCopies(executor, PAIRING, OTHER_LINE)).toEqual([]);
    expect(await readShiftCopies(executor, OTHER_PAIRING, LINE_ID)).toEqual([]);
  });

  it("follow a later list: changed fields, and a planned shift that left the list goes", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [ACTIVE, PLANNED], SEEN);
    const edited = { ...PLANNED, plannedQty: 600, productionDate: "2026-10-10" };
    await replaceShiftCopies(executor, PAIRING, [edited], SEEN + 1);
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toMatchObject([
      { id: PLANNED.id, plannedQty: 600, productionDate: "2026-10-10" },
    ]);
    expect(await readShiftCopy(executor, PAIRING, ACTIVE.id)).toBeNull();
    await replaceShiftCopies(executor, PAIRING, [], SEEN + 2);
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toEqual([]);
  });

  it("keep a shift this station entered, with its snapshot, whatever a later list says", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [PLANNED], SEEN);
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN + 1);
    await replaceShiftCopies(executor, PAIRING, [], SEEN + 2);
    const [row] = await stored(executor, ENTERED.id);
    expect(row).toEqual({
      status: "active",
      snapshot: JSON.stringify(ENTERED.snapshot),
      entered_at: AT,
      seen_at: SEEN + 1,
    });
    // An entered shift the host closed leaves the list but not the copies.
    await replaceShiftCopies(
      executor,
      PAIRING,
      [{ ...ACTIVE, status: "closed", closedAt: "2026-10-08T18:00:00Z" }],
      SEEN + 3,
    );
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toEqual([]);
    expect(await readShiftCopy(executor, PAIRING, ENTERED.id)).toMatchObject({
      status: "closed",
      entered: true,
    });
  });

  it("keep the first entry's time and never take an entered shift back to planned", async () => {
    const { executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-09T09:00:00.000Z", SEEN + 1);
    // A list read before the entry and applied after it.
    await replaceShiftCopies(
      executor,
      PAIRING,
      [{ ...ACTIVE, status: "planned", ownerDeviceId: null, openedAt: null }],
      SEEN + 2,
    );
    expect(await stored(executor, ENTERED.id)).toEqual([
      {
        status: "active",
        snapshot: JSON.stringify(ENTERED.snapshot),
        entered_at: AT,
        seen_at: SEEN + 1,
      },
    ]);
  });

  it("show a shift this station is closing, and neither one it closed nor one the host closed", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    await replaceShiftCopies(executor, PAIRING, [ACTIVE, PLANNED], SEEN);
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE id = ?").run(ACTIVE.id);
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toMatchObject([
      { id: ACTIVE.id, localState: "closing", entered: true },
      { id: PLANNED.id, localState: null, entered: false },
    ]);
    db.prepare("UPDATE floor_shifts SET local_state = 'closed' WHERE id = ?").run(ACTIVE.id);
    // A stale `active` from the host does not bring a closed shift back.
    await replaceShiftCopies(executor, PAIRING, [ACTIVE, PLANNED], SEEN + 1);
    expect((await readShiftCopies(executor, PAIRING, LINE_ID)).map((copy) => copy.id)).toEqual([
      PLANNED.id,
    ]);
  });

  it("leave another pairing's rows alone, the same shift ids included", async () => {
    const { executor } = openLocalDb();
    await keepEnteredShift(executor, OTHER_PAIRING, ENTERED, AT, SEEN);
    await replaceShiftCopies(executor, OTHER_PAIRING, [PLANNED], SEEN);
    await replaceShiftCopies(executor, PAIRING, [], SEEN + 1);
    await replaceShiftCopies(executor, PAIRING, [{ ...PLANNED, plannedQty: 5 }], SEEN + 2);
    expect(await readShiftCopies(executor, OTHER_PAIRING, LINE_ID)).toMatchObject([
      { id: ENTERED.id, entered: true },
      { id: PLANNED.id, plannedQty: null },
    ]);
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toMatchObject([
      { id: PLANNED.id, plannedQty: 5, entered: false },
    ]);
  });

  it("take a shift the station created before a list brings it, and keep it through a stale list", async () => {
    const { executor } = openLocalDb();
    await keepCreatedShift(executor, PAIRING, PLANNED, SEEN);
    expect(await readShiftCopy(executor, PAIRING, PLANNED.id)).toMatchObject({
      number: "OCT26-005/S",
      createdFrom: "station",
      entered: false,
    });
  });
});

describe("a stored shift to work", () => {
  it("is the copy and its snapshot, checked again", async () => {
    const { executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    const work = await readStoredWork(executor, PAIRING, ENTERED.id);
    if (work.kind !== "ready") throw new Error(`not ready: ${work.kind}`);
    expect(work.shift.copy).toMatchObject({ id: ENTERED.id, entered: true });
    expect(work.shift.snapshot).toMatchObject({
      issuerPrefix: "460068200",
      product: { gtin14: "04600682000013", shelfLifeDays: 10 },
      boxTemplate: { rev: 62, spec: { widthMm: 58, language: "tspl" } },
    });
  });

  it("is missing for a shift not entered here or of another pairing", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [PLANNED], SEEN);
    await keepEnteredShift(executor, OTHER_PAIRING, ENTERED, AT, SEEN);
    expect(await readStoredWork(executor, PAIRING, PLANNED.id)).toEqual({ kind: "missing" });
    expect(await readStoredWork(executor, PAIRING, ENTERED.id)).toEqual({ kind: "missing" });
  });

  it("is unreadable when the stored layout is not one the domain reads", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    const broken = {
      ...ENTERED.snapshot,
      boxTemplate: { ...ENTERED.snapshot.boxTemplate, spec: { widthMm: 5 } },
    };
    db.prepare("UPDATE floor_shifts SET snapshot = ?").run(JSON.stringify(broken));
    expect(await readStoredWork(executor, PAIRING, ENTERED.id)).toEqual({
      kind: "unreadable",
      reason: "layout",
    });
  });
});

describe("checkShiftSnapshot", () => {
  const snapshot = ENTERED.snapshot;

  it("reads the host's snapshot with its layout", () => {
    expect(checkShiftSnapshot(snapshot)).toMatchObject({
      ok: true,
      snapshot: { boxTemplate: { spec: { dpi: 203, elements: [{ id: "name" }] } } },
    });
  });

  it("refuses a layout, a GTIN and a prefix the station cannot print from", () => {
    expect(
      checkShiftSnapshot({ ...snapshot, boxTemplate: { ...snapshot.boxTemplate, spec: {} } }),
    ).toEqual({ ok: false, reason: "layout" });
    for (const gtin14 of ["4600682000013", "04600682000014", "0460068200001x"]) {
      expect(checkShiftSnapshot({ ...snapshot, product: { ...snapshot.product, gtin14 } })).toEqual(
        { ok: false, reason: "gtin" },
      );
    }
    for (const issuerPrefix of ["46006820", "4600682000", "46006820a"]) {
      expect(checkShiftSnapshot({ ...snapshot, issuerPrefix })).toEqual({
        ok: false,
        reason: "prefix",
      });
    }
    // A whole shift is no snapshot.
    for (const raw of [{ ...snapshot, product: undefined }, fixture("device-shift-entered.json")]) {
      expect(checkShiftSnapshot(raw)).toEqual({ ok: false, reason: "shape" });
    }
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-copies.test.ts`
Expected: FAIL — `Failed to resolve import "../src/floor/shifts/shift-copies.js"`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/floor/shifts/shift-snapshot.ts`:

<!-- prettier-ignore -->
```ts
import { isValidGtin, labelTemplateSpecSchema, type LabelTemplateSpec } from "@markiro/domain";

import { shiftSnapshotSchema, type ShiftSnapshot } from "../../host/protocol.js";

/**
 * A snapshot this build can work a shift from: the host's frozen product,
 * issuer prefix and counterparty, and the box layout read by the domain's
 * `labelTemplateSpecSchema`, the model the label is printed from (stage 2a
 * spec, decisions 3 and 22).
 */
export interface CheckedSnapshot {
  product: ShiftSnapshot["product"];
  boxTemplate: { id: string; name: string; rev: number; spec: LabelTemplateSpec };
  issuerPrefix: string;
  counterpartyName: string | null;
}

/**
 * Why a snapshot cannot be worked from: not a snapshot at all (`shape`), a
 * product GTIN that is no GTIN-14 (`gtin`), an issuer prefix that is not the
 * nine digits of a GLN (`prefix`), or a layout the domain does not read
 * (`layout`, a template a newer office made, or a damaged one).
 */
export type SnapshotRefusal = "shape" | "gtin" | "prefix" | "layout";

export type SnapshotCheck =
  { ok: true; snapshot: CheckedSnapshot } | { ok: false; reason: SnapshotRefusal };

const GTIN14 = /^[0-9]{14}$/;
const ISSUER_PREFIX = /^[0-9]{9}$/;

/**
 * Checks a shift's snapshot before the station works the shift: once when it
 * enters (the host never checks a layout, stage 2a spec §4.2) and again when
 * a stored one is read back. A snapshot that fails keeps the operator out of
 * the shift; nothing is printed from a layout the domain does not read.
 */
export function checkShiftSnapshot(raw: unknown): SnapshotCheck {
  const parsed = shiftSnapshotSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "shape" };
  const { product, boxTemplate, issuerPrefix, counterpartyName } = parsed.data;
  if (!GTIN14.test(product.gtin14) || !isValidGtin(product.gtin14)) {
    return { ok: false, reason: "gtin" };
  }
  if (!ISSUER_PREFIX.test(issuerPrefix)) return { ok: false, reason: "prefix" };
  const spec = labelTemplateSpecSchema.safeParse(boxTemplate.spec);
  if (!spec.success) return { ok: false, reason: "layout" };
  return {
    ok: true,
    snapshot: {
      product,
      boxTemplate: {
        id: boxTemplate.id,
        name: boxTemplate.name,
        rev: boxTemplate.rev,
        spec: spec.data,
      },
      issuerPrefix,
      counterpartyName,
    },
  };
}
```

Создать `apps/standalone/src/floor/shifts/shift-copies.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import {
  shiftModeSchema,
  shiftOriginSchema,
  shiftStatusSchema,
  type DeviceShift,
  type EnteredShift,
  type ShiftMode,
  type ShiftOrigin,
  type ShiftStatus,
} from "../../host/protocol.js";
import type { LocalExecutor, LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import {
  checkShiftSnapshot,
  type CheckedSnapshot,
  type SnapshotRefusal,
} from "./shift-snapshot.js";

/**
 * A shift as this station keeps it (`floor_shifts`, migration `0006`): what
 * the host's last list said, this station's own close (`localState`, plan
 * 2a8), and whether it entered the shift and keeps its snapshot.
 */
export interface ShiftCopy {
  id: string;
  number: string;
  status: ShiftStatus;
  localState: "closing" | "closed" | null;
  mode: ShiftMode;
  palletsEnabled: boolean;
  createdFrom: ShiftOrigin;
  lineId: string;
  productId: string;
  productName: string;
  productGtin14: string;
  counterpartyName: string | null;
  productionDate: string;
  plannedQty: number | null;
  boxCapacity: number;
  boxTemplateId: string;
  ownerDeviceId: string | null;
  openedAt: string | null;
  closedAt: string | null;
  entered: boolean;
}

/** A shift the station works: its copy and the snapshot this build read. */
export interface WorkShift {
  copy: ShiftCopy;
  snapshot: CheckedSnapshot;
}

/** The host's fields of a shift: its column and the `DeviceShift` key it comes from. */
const HOST_FIELDS = [
  ["id", "id"],
  ["number", "number"],
  ["status", "status"],
  ["mode", "mode"],
  ["pallets_enabled", "palletsEnabled"],
  ["created_from", "createdFrom"],
  ["line_id", "lineId"],
  ["product_id", "productId"],
  ["product_name", "productName"],
  ["product_gtin14", "productGtin14"],
  ["counterparty_name", "counterpartyName"],
  ["production_date", "productionDate"],
  ["planned_qty", "plannedQty"],
  ["box_capacity", "boxCapacity"],
  ["box_template_id", "boxTemplateId"],
  ["owner_device_id", "ownerDeviceId"],
  ["opened_at", "openedAt"],
  ["closed_at", "closedAt"],
] as const;

const COLUMNS = HOST_FIELDS.map(([column]) => column).join(", ");
// `->>` yields a JSON boolean as 1 or 0 and a JSON null as NULL.
const VALUES = HOST_FIELDS.map(([, key]) => `value ->> '${key}'`).join(", ");
const UPDATES = HOST_FIELDS.filter(([column]) => column !== "id")
  .map(([column]) => `${column} = excluded.${column}`)
  .join(", ");

/**
 * The host's fields of every shift in the JSON array parameter, as this
 * pairing's: new rows come in, known ones take the host's values, and the
 * station's own columns (`snapshot`, `entered_at`, `local_state`) are never
 * touched. A shift this station entered never goes back to `planned`: the
 * host never does, so only a list read before the entry (and applied after
 * it) could say so. Parameters: host id, device id, seen at, the array.
 */
const UPSERT =
  `INSERT INTO floor_shifts (host_id, device_id, ${COLUMNS}, seen_at) ` +
  `SELECT ?, ?, ${VALUES}, ? FROM json_each(?) WHERE true ` +
  `ON CONFLICT (host_id, device_id, id) DO UPDATE SET ${UPDATES}, seen_at = excluded.seen_at ` +
  "WHERE NOT (floor_shifts.entered_at IS NOT NULL AND excluded.status = 'planned')";

/**
 * This pairing's shifts the host no longer lists and this station never
 * entered: planned shifts the office deleted or moved to another line, and
 * shifts another station opened. A shift this station entered stays, with its
 * snapshot, whatever the list says: its facts name it (plan 2a8 decides when
 * it goes). Parameters: host id, device id, the listed shifts.
 */
const DROP_UNLISTED =
  "DELETE FROM floor_shifts WHERE host_id = ? AND device_id = ? AND entered_at IS NULL " +
  "AND id NOT IN (SELECT value ->> 'id' FROM json_each(?))";

/**
 * What the station keeps when it enters: the host's fields, the snapshot and
 * the time of its first entry, which a later entry keeps. Parameters: host
 * id, device id, seen at, the shift (a one-item array), the snapshot, the
 * time of the entry.
 */
const KEEP_ENTERED =
  `INSERT INTO floor_shifts (host_id, device_id, ${COLUMNS}, seen_at, snapshot, entered_at) ` +
  `SELECT ?, ?, ${VALUES}, ?, ?, ? FROM json_each(?) WHERE true ` +
  `ON CONFLICT (host_id, device_id, id) DO UPDATE SET ${UPDATES}, seen_at = excluded.seen_at, ` +
  "snapshot = excluded.snapshot, entered_at = coalesce(floor_shifts.entered_at, excluded.entered_at)";

/**
 * Replaces this pairing's copies with the host's list (`GET /v1/device/shifts`)
 * in one transaction (stage 2a spec §5.4). Another pairing's rows, kept by a
 * forget with records not yet sent, are never touched.
 */
export async function replaceShiftCopies(
  local: LocalExecutor,
  pairing: Pairing,
  shifts: readonly DeviceShift[],
  seenAt: number,
): Promise<void> {
  const listed = JSON.stringify(shifts);
  await local.transaction([
    { sql: DROP_UNLISTED, values: [pairing.hostId, pairing.deviceId, listed] },
    { sql: UPSERT, values: [pairing.hostId, pairing.deviceId, seenAt, listed] },
  ]);
}

/** Keeps the shift this station has just created, before any list brings it. */
export async function keepCreatedShift(
  local: LocalExecutor,
  pairing: Pairing,
  shift: DeviceShift,
  seenAt: number,
): Promise<void> {
  await local.transaction([
    { sql: UPSERT, values: [pairing.hostId, pairing.deviceId, seenAt, JSON.stringify([shift])] },
  ]);
}

/**
 * Keeps the answer of an entry: the shift and its snapshot, which the caller
 * has checked (`checkShiftSnapshot`). The stored snapshot is the one this
 * build parsed: a field a newer host added is dropped, and the next entry
 * with the host brings it again.
 */
export async function keepEnteredShift(
  local: LocalExecutor,
  pairing: Pairing,
  shift: EnteredShift,
  enteredAt: string,
  seenAt: number,
): Promise<void> {
  const { snapshot, ...fields } = shift;
  const statement: LocalStatement = {
    sql: KEEP_ENTERED,
    values: [
      pairing.hostId,
      pairing.deviceId,
      seenAt,
      JSON.stringify(snapshot),
      enteredAt,
      JSON.stringify([fields]),
    ],
    expectedChanges: 1,
  };
  await local.transaction([statement]);
}

const copyRow = z.object({
  id: z.string(),
  number: z.string(),
  status: shiftStatusSchema,
  local_state: z.enum(["closing", "closed"]).nullable(),
  mode: shiftModeSchema,
  pallets_enabled: z.number(),
  created_from: shiftOriginSchema,
  line_id: z.string(),
  product_id: z.string(),
  product_name: z.string(),
  product_gtin14: z.string(),
  counterparty_name: z.string().nullable(),
  production_date: z.string(),
  planned_qty: z.number().nullable(),
  box_capacity: z.number(),
  box_template_id: z.string(),
  owner_device_id: z.string().nullable(),
  opened_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  entered: z.number(),
});

const COPY_COLUMNS =
  "id, number, status, local_state, mode, pallets_enabled, created_from, line_id, product_id, " +
  "product_name, product_gtin14, counterparty_name, production_date, planned_qty, " +
  "box_capacity, box_template_id, owner_device_id, opened_at, closed_at, " +
  "entered_at IS NOT NULL AS entered";

function toCopy(row: z.infer<typeof copyRow>): ShiftCopy {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    localState: row.local_state,
    mode: row.mode,
    palletsEnabled: row.pallets_enabled === 1,
    createdFrom: row.created_from,
    lineId: row.line_id,
    productId: row.product_id,
    productName: row.product_name,
    productGtin14: row.product_gtin14,
    counterpartyName: row.counterparty_name,
    productionDate: row.production_date,
    plannedQty: row.planned_qty,
    boxCapacity: row.box_capacity,
    boxTemplateId: row.box_template_id,
    ownerDeviceId: row.owner_device_id,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    entered: row.entered === 1,
  };
}

/**
 * The shifts of `lineId` the floor's list shows, from this pairing's copies:
 * planned and active ones, and one this station is closing; neither a shift
 * the host closed nor one this station closed. By production date, then
 * number.
 */
export async function readShiftCopies(
  local: LocalExecutor,
  pairing: Pairing,
  lineId: string,
): Promise<ShiftCopy[]> {
  const rows = await local.query(
    `SELECT ${COPY_COLUMNS} FROM floor_shifts WHERE host_id = ? AND device_id = ? ` +
      "AND line_id = ? AND status <> 'closed' AND (local_state IS NULL OR local_state = 'closing') " +
      "ORDER BY production_date, number, id",
    [pairing.hostId, pairing.deviceId, lineId],
    copyRow,
  );
  return rows.map(toCopy);
}

/** One shift of this pairing's copies, or `null`. */
export async function readShiftCopy(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<ShiftCopy | null> {
  const [row] = await local.query(
    `SELECT ${COPY_COLUMNS} FROM floor_shifts WHERE host_id = ? AND device_id = ? AND id = ?`,
    [pairing.hostId, pairing.deviceId, shiftId],
    copyRow,
  );
  return row === undefined ? null : toCopy(row);
}

/** A stored shift to work: there, not entered here, or entered with a snapshot this build does not read. */
export type StoredWork =
  | { kind: "ready"; shift: WorkShift }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: SnapshotRefusal };

const snapshotRow = z.object({ snapshot: z.string().nullable() });

/**
 * A shift this station entered, with its stored snapshot checked again: what
 * the station works from without the host (stage 2a spec §5.4) and what the
 * work screen reads.
 */
export async function readStoredWork(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<StoredWork> {
  const copy = await readShiftCopy(local, pairing, shiftId);
  if (copy === null || !copy.entered) return { kind: "missing" };
  const [row] = await local.query(
    "SELECT snapshot FROM floor_shifts WHERE host_id = ? AND device_id = ? AND id = ?",
    [pairing.hostId, pairing.deviceId, shiftId],
    snapshotRow,
  );
  if (row === undefined || row.snapshot === null) return { kind: "missing" };
  let raw: unknown;
  try {
    raw = JSON.parse(row.snapshot);
  } catch {
    return { kind: "unreadable", reason: "shape" };
  }
  const checked = checkShiftSnapshot(raw);
  return checked.ok
    ? { kind: "ready", shift: { copy, snapshot: checked.snapshot } }
    : { kind: "unreadable", reason: checked.reason };
}
```

- [ ] **Step 4: Тест проходит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-copies.test.ts`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  12 passed (12)`.

- [ ] **Step 5: Мутации**

Все в `apps/standalone/src/floor/shifts/shift-copies.ts`; Run каждой: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-copies.test.ts`.

1. `  "WHERE NOT (floor_shifts.entered_at IS NOT NULL AND excluded.status = 'planned')";` → `  "WHERE true";`. Expected: FAIL — «keep the first entry's time and never take an entered shift back to planned».
2. В `DROP_UNLISTED`: `AND device_id = ? AND entered_at IS NULL " +` → `AND device_id = ? " +`. Expected: FAIL — «keep a shift this station entered, with its snapshot, whatever a later list says» и «leave another pairing's rows alone, the same shift ids included».
3. `"DELETE FROM floor_shifts WHERE host_id = ? AND device_id = ? AND entered_at IS NULL " +` → `"DELETE FROM floor_shifts WHERE ? IS NOT NULL AND ? IS NOT NULL AND entered_at IS NULL " +`. Expected: FAIL — «leave another pairing's rows alone, the same shift ids included».
4. `entered_at = coalesce(floor_shifts.entered_at, excluded.entered_at)` → `entered_at = excluded.entered_at`. Expected: FAIL — «keep the first entry's time and never take an entered shift back to planned».
5. В `readShiftCopies`: `AND line_id = ? AND status <> 'closed' AND` → `AND line_id = ? AND`. Expected: FAIL — «keep a shift this station entered, with its snapshot, whatever a later list says».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/shifts/shift-copies.ts apps/standalone/src/floor/shifts/shift-snapshot.ts apps/standalone/test/shift-copies.test.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `git diff --check`
Expected: чисто.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/shifts/shift-copies.ts apps/standalone/src/floor/shifts/shift-snapshot.ts apps/standalone/test/shift-copies.test.ts
git commit -m "feat(standalone): the station keeps its line's shifts and the snapshot of each it entered" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Оболочка — номер сеанса, обновление имени, работа смены и что её ждёт, чтение смен

Редьюсер (`src/app/shell.ts`):

- Сеанс оператора — `FloorSession` (`FloorOperator` и `sessionId`); номер даёт `operator_signed_in` (`lastSessionId + 1`), `operator_signed_out` сравнивает номер, а не идентификатор оператора, поэтому поздний таймер прежнего сеанса того же оператора ничего не завершает (пункты 20 и 22 очереди 1f1). `operator_refreshed { sessionId, name, role }` меняет имя и роль только своего сеанса и не начинает нового; одинаковые значения не меняют состояния.
- Работа смены: `work_entered { sessionId, shiftId }` (только своего сеанса и один раз) и `work_left { sessionId }`. Пока `floorWork` задан, отказ устройства — из `link_status` и из `device_rejected` без токена — ждёт в `pendingRejection` (вопрос В8), а другая линия из `device_refreshed` — в `pendingDevice` (вопрос В9); `work_left` и выход оператора применяют ждущее, отказ первым. Ответ с прежней линией снимает ждущий переход. Офис, новое подключение, «забывание», проба хоста, другой хост и выбор линии сбрасывают работу и ждущее вместе с оператором (`NO_FLOOR_SESSION`).
- `device_refreshed` с той же линией и новым именем обновляет статус устройства, не выводя оператора (имя видно в строке состояния, задача 8).
- `shifts_read { ok }` считает удачные чтения смен (`shiftReads.done`) и помнит, упало ли последнее; `device_not_saved` поднимает `deviceNotSaved`, удачный `device_refreshed` снимает.

`useHostLink` (`src/app/host-link.ts`) читает смены (`deviceShifts`, `HostApi.getDeviceShifts`) в те же моменты, что устройство (решение 2), своим планировщиком «по одному, ещё один после текущего» и своим счётчиком повторов (2, 4, 8, 16, 32 с, затем 60 с, только пока связь `online`); ответ — в `replaceShiftCopies` (задача 3), и ответ, пришедший после смены подключения, ничего не пишет. Отказ ключа останавливает все три планировщика (`stopAll`). Сбой `storage` у чтения устройства — `device_not_saved`.

`App`: связь (`useHostLink`) не идёт и при ждущем отказе (ничего больше не уходит на хост, который отказал); обратный вызов выхода привязан к номеру сеанса (`currentOperator` и сравнение объектов уходят). Цех на экране пока прежний — `FloorOperatorScreen` получает `FloorSession` и не меняется; его заменит задача 7.

**Files:**

- Modify: `apps/standalone/src/app/shell.ts`, `apps/standalone/src/app/host-link.ts`, `apps/standalone/src/app/App.tsx`
- Test: `apps/standalone/test/shell.test.ts`, `apps/standalone/test/app.test.tsx` (Modify); `apps/standalone/test/host-link-shifts.test.ts` (Create)

**Interfaces:**

- Consumes: `replaceShiftCopies` (задача 3); `DeviceShift` (задача 2); `HostApi.getDeviceShifts` (задача 2); `DeviceStatus.deviceName` (план 2a4).
- Produces:
  - `src/app/shell.ts`: `interface FloorSession extends FloorOperator { sessionId: number }`, `interface FloorWork { sessionId: number; shiftId: string }`; поля `ShellState`: `operator: FloorSession | null`, `lastSessionId: number`, `floorWork: FloorWork | null`, `pendingRejection: RejectionReason | null`, `pendingDevice: DeviceStatus | null`, `shiftReads: { done: number; failed: boolean }`, `deviceNotSaved: boolean`; действия `{ type: "operator_signed_out"; sessionId; notice }`, `{ type: "operator_refreshed"; sessionId; name; role }`, `{ type: "work_entered"; sessionId; shiftId }`, `{ type: "work_left"; sessionId }`, `{ type: "shifts_read"; ok: boolean }`, `{ type: "device_not_saved" }`; вид `floor_operator` несёт `FloorSession`;
  - `src/app/host-link.ts`: `HostLinkOptions.deviceShifts: () => Promise<DeviceShift[]>`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/shell.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { HostError } from "../src/host/client.js";
import { DeviceError } from "../src/host/device.js";
import type { HostStatus } from "../src/host/protocol.js";
import { DEVICE_STATUS, NEW_STATION, observation, SESSION } from "./support/fixtures.js";

```

заменить на:

<!-- prettier-ignore -->
```ts
import { HostError } from "../src/host/client.js";
import { DeviceError } from "../src/host/device.js";
import type { DeviceStatus, HostStatus } from "../src/host/protocol.js";
import { DEVICE_STATUS, NEW_STATION, observation, SESSION } from "./support/fixtures.js";

```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
    role: null,
  };
  const signIn: Extract<ShellAction, { type: "operator_signed_in" }> = {
    type: "operator_signed_in",
```

заменить на:

<!-- prettier-ignore -->
```ts
    role: null,
  };
  /** Anna as the first session of a pairing has her. */
  const ANNA_SESSION = { ...ANNA, sessionId: 1 };
  const signIn: Extract<ShellAction, { type: "operator_signed_in" }> = {
    type: "operator_signed_in",
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  it("shows the signed-in operator's floor, and the sign-in again once they leave", () => {
    const floor = signedIn();
    expect(nextShellView(floor, ADDRESS)).toEqual({ kind: "floor_operator", operator: ANNA });
    const left = shellReducer(floor, {
      type: "operator_signed_out",
      operatorId: ANNA.id,
      notice: null,
    });
```

заменить на:

<!-- prettier-ignore -->
```ts
  it("shows the signed-in operator's floor, and the sign-in again once they leave", () => {
    const floor = signedIn();
    expect(nextShellView(floor, ADDRESS)).toEqual({
      kind: "floor_operator",
      operator: ANNA_SESSION,
    });
    const left = shellReducer(floor, {
      type: "operator_signed_out",
      sessionId: 1,
      notice: null,
    });
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  });

  it("stores exactly the operator's four fields, in a fresh object, whatever the action carries", () => {
    // The sign-in builds `{ id, login, name, role }` itself; the reducer does
    // not rely on it, so a hash that slipped into the object never reaches the
```

заменить на:

<!-- prettier-ignore -->
```ts
  });

  it("stores exactly the operator's four fields and a new session number, whatever the action carries", () => {
    // The sign-in builds `{ id, login, name, role }` itself; the reducer does
    // not rely on it, so a hash that slipped into the object never reaches the
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
    // state (and with it the screen, the idle timer and the router).
    const carrying = { ...ANNA, pinPhc: "pbkdf2$sha256$100000$c2FsdA==$ZGlnZXN0" };
    const stored = shellReducer(paired(), { ...signIn, operator: carrying }).operator;
    expect(stored).toEqual(ANNA);
    expect(Object.keys(stored ?? {}).sort()).toEqual(["id", "login", "name", "role"]);
    expect(stored).not.toBe(carrying);
    // One fresh object per sign-in: the session token of `App` is the object.
    const again = shellReducer(paired(), { ...signIn, operator: carrying }).operator;
    expect(again).not.toBe(stored);
  });

```

заменить на:

<!-- prettier-ignore -->
```ts
    // state (and with it the screen, the idle timer and the router).
    const carrying = { ...ANNA, pinPhc: "pbkdf2$sha256$100000$c2FsdA==$ZGlnZXN0" };
    const first = shellReducer(paired(), { ...signIn, operator: carrying });
    expect(first.operator).toEqual(ANNA_SESSION);
    expect(Object.keys(first.operator ?? {}).sort()).toEqual([
      "id",
      "login",
      "name",
      "role",
      "sessionId",
    ]);
    // The same operator again is another session, with the next number.
    const left = shellReducer(first, { type: "operator_signed_out", sessionId: 1, notice: null });
    const again = shellReducer(left, { ...signIn, operator: carrying });
    expect(again.operator).toEqual({ ...ANNA, sessionId: 2 });
    expect(again.lastSessionId).toBe(2);
  });

```

Фрагмент 6:

<!-- prettier-ignore -->
```ts
    const idle = shellReducer(signedIn(), {
      type: "operator_signed_out",
      operatorId: ANNA.id,
      notice: "idle",
    });
```

заменить на:

<!-- prettier-ignore -->
```ts
    const idle = shellReducer(signedIn(), {
      type: "operator_signed_out",
      sessionId: 1,
      notice: "idle",
    });
```

Фрагмент 7:

<!-- prettier-ignore -->
```ts
    expect(idle.floorNotice).toBe("idle");
    const next = shellReducer(idle, { ...signIn, operator: BORIS });
    expect(next.operator).toEqual(BORIS);
    expect(next.floorNotice).toBeNull();
  });
```

заменить на:

<!-- prettier-ignore -->
```ts
    expect(idle.floorNotice).toBe("idle");
    const next = shellReducer(idle, { ...signIn, operator: BORIS });
    expect(next.operator).toEqual({ ...BORIS, sessionId: 2 });
    expect(next.floorNotice).toBeNull();
  });
```

Фрагмент 8:

<!-- prettier-ignore -->
```ts
    const left = shellReducer(signedIn(), {
      type: "operator_signed_out",
      operatorId: ANNA.id,
      notice: null,
    });
    const boris = shellReducer(left, { ...signIn, operator: BORIS });
    expect(boris.operator).toEqual(BORIS);
    expect(
      shellReducer(boris, { type: "operator_signed_out", operatorId: ANNA.id, notice: "idle" }),
    ).toBe(boris);
    const nobody = paired();
    expect(
      shellReducer(nobody, { type: "operator_signed_out", operatorId: ANNA.id, notice: "removed" }),
    ).toBe(nobody);
  });
```

заменить на:

<!-- prettier-ignore -->
```ts
    const left = shellReducer(signedIn(), {
      type: "operator_signed_out",
      sessionId: 1,
      notice: null,
    });
    const boris = shellReducer(left, { ...signIn, operator: BORIS });
    expect(boris.operator).toEqual({ ...BORIS, sessionId: 2 });
    expect(shellReducer(boris, { type: "operator_signed_out", sessionId: 1, notice: "idle" })).toBe(
      boris,
    );
    const nobody = paired();
    expect(
      shellReducer(nobody, { type: "operator_signed_out", sessionId: 1, notice: "removed" }),
    ).toBe(nobody);
  });
```

Фрагмент 9:

<!-- prettier-ignore -->
```ts
      state = shellReducer(state, action);
    }
    expect(nextShellView(state, ADDRESS)).toEqual({ kind: "floor_operator", operator: ANNA });
  });
});
```

заменить на:

<!-- prettier-ignore -->
```ts
      state = shellReducer(state, action);
    }
    expect(nextShellView(state, ADDRESS)).toEqual({
      kind: "floor_operator",
      operator: ANNA_SESSION,
    });
  });
});
```

Фрагмент 10:

<!-- prettier-ignore -->
```ts
    role: "brigadier",
  };
  const OTHER_LINE = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
  const OTHER_DEVICE = "5d1c2b3a-4f6e-4a8b-9c0d-7e8f9a0b1c2d";
```

заменить на:

<!-- prettier-ignore -->
```ts
    role: "brigadier",
  };
  const ANNA_SESSION = { ...ANNA, sessionId: 1 };
  const OTHER_LINE = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
  const OTHER_DEVICE = "5d1c2b3a-4f6e-4a8b-9c0d-7e8f9a0b1c2d";
```

Фрагмент 11:

<!-- prettier-ignore -->
```ts
    operator_signed_out: [
      {
        action: { type: "operator_signed_out", operatorId: ANNA.id, notice: null },
        survives: false,
      },
      {
        action: { type: "operator_signed_out", operatorId: BORIS.id, notice: "idle" },
        survives: true,
      },
    ],
  };

```

заменить на:

<!-- prettier-ignore -->
```ts
    operator_signed_out: [
      {
        action: { type: "operator_signed_out", sessionId: 1, notice: null },
        survives: false,
      },
      {
        action: { type: "operator_signed_out", sessionId: 2, notice: "idle" },
        survives: true,
      },
    ],
    // A refresh with the same name and role changes nothing; another
    // session's is ignored; neither ends the session.
    operator_refreshed: [
      {
        action: { type: "operator_refreshed", sessionId: 1, name: ANNA.name, role: ANNA.role },
        survives: true,
      },
      {
        action: { type: "operator_refreshed", sessionId: 2, name: "Борис", role: null },
        survives: true,
      },
    ],
    work_entered: [
      { action: { type: "work_entered", sessionId: 1, shiftId: OTHER_LINE }, survives: true },
      { action: { type: "work_entered", sessionId: 2, shiftId: OTHER_LINE }, survives: true },
    ],
    // Leaving work that never began changes nothing.
    work_left: [{ action: { type: "work_left", sessionId: 1 }, survives: true }],
    shifts_read: [
      { action: { type: "shifts_read", ok: true }, survives: true },
      { action: { type: "shifts_read", ok: false }, survives: true },
    ],
    device_not_saved: [{ action: { type: "device_not_saved" }, survives: true }],
  };

```

Фрагмент 12:

<!-- prettier-ignore -->
```ts
    (_name, { action, survives }) => {
      const after = shellReducer(signedIn(), action);
      expect(after.operator).toEqual(survives ? ANNA : null);
    },
  );
```

заменить на:

<!-- prettier-ignore -->
```ts
    (_name, { action, survives }) => {
      const after = shellReducer(signedIn(), action);
      expect(after.operator).toEqual(survives ? ANNA_SESSION : null);
    },
  );
```

Фрагмент 13:

<!-- prettier-ignore -->
```ts
  it("holds the operator's identity and nothing that could open a door", () => {
    const state = signedIn();
    expect(Object.keys(state.operator ?? {}).sort()).toEqual(["id", "login", "name", "role"]);
    expect(JSON.stringify(state)).not.toMatch(/pin|badge|hash|pbkdf|secret/i);
  });
```

заменить на:

<!-- prettier-ignore -->
```ts
  it("holds the operator's identity and nothing that could open a door", () => {
    const state = signedIn();
    expect(Object.keys(state.operator ?? {}).sort()).toEqual([
      "id",
      "login",
      "name",
      "role",
      "sessionId",
    ]);
    expect(JSON.stringify(state)).not.toMatch(/pin|badge|hash|pbkdf|secret/i);
  });
```

Фрагмент 14:

<!-- prettier-ignore -->
```ts
      const left = shellReducer(signedIn(), {
        type: "operator_signed_out",
        operatorId: ANNA.id,
        notice,
      });
```

заменить на:

<!-- prettier-ignore -->
```ts
      const left = shellReducer(signedIn(), {
        type: "operator_signed_out",
        sessionId: 1,
        notice,
      });
```

Фрагмент 15:

<!-- prettier-ignore -->
```ts
    // A sign-in that began on the new line is the one that counts.
    const next = shellReducer(moved, { ...signIn, lineId: OTHER_LINE });
    expect(next.operator).toEqual(ANNA);
  });

```

заменить на:

<!-- prettier-ignore -->
```ts
    // A sign-in that began on the new line is the one that counts.
    const next = shellReducer(moved, { ...signIn, lineId: OTHER_LINE });
    expect(next.operator).toEqual(ANNA_SESSION);
  });

```

Фрагмент 16:

<!-- prettier-ignore -->
```ts
    const left = shellReducer(running, {
      type: "operator_signed_out",
      operatorId: ANNA.id,
      notice: null,
    });
    expect(shellReducer(left, { ...signIn, operator: BORIS }).operator).toEqual(BORIS);
  });

```

заменить на:

<!-- prettier-ignore -->
```ts
    const left = shellReducer(running, {
      type: "operator_signed_out",
      sessionId: 1,
      notice: null,
    });
    expect(shellReducer(left, { ...signIn, operator: BORIS }).operator).toEqual({
      ...BORIS,
      sessionId: 2,
    });
  });

```

Фрагмент 17:

<!-- prettier-ignore -->
```ts
    });
    expect(nextShellView(remote, ADDRESS)).toEqual({ kind: "floor" });
    expect(shellReducer(remote, signIn).operator).toEqual(ANNA);
  });

```

заменить на:

<!-- prettier-ignore -->
```ts
    });
    expect(nextShellView(remote, ADDRESS)).toEqual({ kind: "floor" });
    expect(shellReducer(remote, signIn).operator).toEqual(ANNA_SESSION);
  });

```

Фрагмент 18:

<!-- prettier-ignore -->
```ts
    // The operator signed in while the start-up probe was still running.
    const floor = signedIn({ localHost: { kind: "probing" } });
    expect(floor.operator).toEqual(ANNA);
    const probed = shellReducer(floor, {
      type: "host_probed",
```

заменить на:

<!-- prettier-ignore -->
```ts
    // The operator signed in while the start-up probe was still running.
    const floor = signedIn({ localHost: { kind: "probing" } });
    expect(floor.operator).toEqual(ANNA_SESSION);
    const probed = shellReducer(floor, {
      type: "host_probed",
```

Фрагмент 19:

<!-- prettier-ignore -->
```ts
    // Whatever way an operator is in the state on that screen (a sign-in that
    // answers late), the wizard's office must end the session itself.
    const withOperator = { ...probed, operator: ANNA };
    const opened = shellReducer(shellReducer(withOperator, { type: "host_initialized" }), {
      type: "office_opened",
```

заменить на:

<!-- prettier-ignore -->
```ts
    // Whatever way an operator is in the state on that screen (a sign-in that
    // answers late), the wizard's office must end the session itself.
    const withOperator = { ...probed, operator: ANNA_SESSION };
    const opened = shellReducer(shellReducer(withOperator, { type: "host_initialized" }), {
      type: "office_opened",
```

Фрагмент 20:

<!-- prettier-ignore -->
```ts
    });
    const back = shellReducer(opened, { type: "office_closed" });
    expect(shellReducer(back, signIn).operator).toEqual(ANNA);
  });

```

заменить на:

<!-- prettier-ignore -->
```ts
    });
    const back = shellReducer(opened, { type: "office_closed" });
    expect(shellReducer(back, signIn).operator).toEqual(ANNA_SESSION);
  });

```

Фрагмент 21:

<!-- prettier-ignore -->
```ts
      });
      const floor = shellReducer(state, { ...signIn, lineId: null });
      expect(floor.operator).toEqual(ANNA);
      expect(nextShellView(floor, ADDRESS)).toEqual({ kind: "floor_operator", operator: ANNA });
      // An answer that began on a line is not this device's: it has none.
      expect(shellReducer(state, signIn)).toBe(state);
```

заменить на:

<!-- prettier-ignore -->
```ts
      });
      const floor = shellReducer(state, { ...signIn, lineId: null });
      expect(floor.operator).toEqual(ANNA_SESSION);
      expect(nextShellView(floor, ADDRESS)).toEqual({
        kind: "floor_operator",
        operator: ANNA_SESSION,
      });
      // An answer that began on a line is not this device's: it has none.
      expect(shellReducer(state, signIn)).toBe(state);
```

Фрагмент 22:

<!-- prettier-ignore -->
```ts
    expect(fresh.floorNotice).toBeNull();
  });
});
```

заменить на:

<!-- prettier-ignore -->
```ts
    expect(fresh.floorNotice).toBeNull();
  });
});

describe("the operator's session, the shift's work and what waits for it", () => {
  const ANNA = {
    id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
    login: "0042",
    name: "Анна",
    role: null,
  };
  const SHIFT_ID = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b";
  const OTHER_LINE = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
  const MOVED: DeviceStatus = { ...DEVICE_STATUS, lineId: OTHER_LINE };
  const signIn: ShellAction = {
    type: "operator_signed_in",
    deviceId: DEVICE_STATUS.deviceId,
    lineId: DEVICE_STATUS.lineId,
    address: ADDRESS,
    operator: ANNA,
  };

  function working(): ShellState {
    return shellReducer(shellReducer(paired(), signIn), {
      type: "work_entered",
      sessionId: 1,
      shiftId: SHIFT_ID,
    });
  }

  it("refreshes the name and role of the running session only, without a new session", () => {
    const floor = shellReducer(paired(), signIn);
    const renamed = shellReducer(floor, {
      type: "operator_refreshed",
      sessionId: 1,
      name: "Анна Кузнецова",
      role: "Упаковщик",
    });
    expect(renamed.operator).toEqual({
      ...ANNA,
      sessionId: 1,
      name: "Анна Кузнецова",
      role: "Упаковщик",
    });
    expect(renamed.lastSessionId).toBe(1);
    const late = shellReducer(renamed, {
      type: "operator_refreshed",
      sessionId: 2,
      name: "Кто-то",
      role: null,
    });
    expect(late).toBe(renamed);
    expect(
      shellReducer(renamed, {
        type: "operator_refreshed",
        sessionId: 1,
        name: "Анна Кузнецова",
        role: "Упаковщик",
      }),
    ).toBe(renamed);
  });

  it("enters the work of the running session once, and leaves it", () => {
    const state = working();
    expect(state.floorWork).toEqual({ sessionId: 1, shiftId: SHIFT_ID });
    expect(shellReducer(state, { type: "work_entered", sessionId: 1, shiftId: OTHER_LINE })).toBe(
      state,
    );
    const floor = shellReducer(paired(), signIn);
    expect(shellReducer(floor, { type: "work_entered", sessionId: 2, shiftId: SHIFT_ID })).toBe(
      floor,
    );
    expect(shellReducer(state, { type: "work_left", sessionId: 2 })).toBe(state);
    const left = shellReducer(state, { type: "work_left", sessionId: 1 });
    expect(left.floorWork).toBeNull();
    expect(left.operator).toEqual({ ...ANNA, sessionId: 1 });
  });

  it.each([
    [
      "the link refuses the key",
      { type: "link_status", status: linkStatus({ lastError: "key_rejected" }) },
    ],
    ["a call refuses the key", { type: "device_rejected", reason: "key_rejected" }],
  ] satisfies [string, ShellAction][])(
    "keeps the operator in the shift when %s, and refuses the device once they leave it",
    (_name, action) => {
      const refused = shellReducer(working(), action);
      expect(refused.rejection).toBeNull();
      expect(refused.pendingRejection).toBe("key_rejected");
      expect(nextShellView(refused, ADDRESS)).toEqual({
        kind: "floor_operator",
        operator: { ...ANNA, sessionId: 1 },
      });
      const left = shellReducer(refused, { type: "work_left", sessionId: 1 });
      expect(left.rejection).toBe("key_rejected");
      expect(left.operator).toBeNull();
      expect(left.pendingRejection).toBeNull();
      expect(nextShellView(left, ADDRESS)).toEqual({
        kind: "device_rejected",
        reason: "key_rejected",
      });
    },
  );

  it("refuses the device at once when the operator is not in a shift", () => {
    const floor = shellReducer(paired(), signIn);
    const refused = shellReducer(floor, {
      type: "link_status",
      status: linkStatus({ lastError: "certificate_mismatch" }),
    });
    expect(refused.rejection).toBe("host_changed");
    expect(refused.operator).toBeNull();
  });

  it("keeps the station on its line while the operator works, and moves it once they leave", () => {
    const moved = shellReducer(working(), { type: "device_refreshed", status: MOVED });
    expect(moved.pendingDevice).toEqual(MOVED);
    expect(moved.device).toEqual({ kind: "ready", status: DEVICE_STATUS });
    expect(moved.operator).toEqual({ ...ANNA, sessionId: 1 });
    const left = shellReducer(moved, { type: "work_left", sessionId: 1 });
    expect(left.device).toEqual({ kind: "ready", status: MOVED });
    expect(left.operator).toBeNull();
    expect(left.floorNotice).toBe("line_changed");
    // A cleared line waits too, then sends the station to choose one.
    const cleared = shellReducer(working(), { type: "device_refreshed", status: NEW_STATION });
    expect(nextShellView(cleared, ADDRESS).kind).toBe("floor_operator");
    expect(
      nextShellView(shellReducer(cleared, { type: "work_left", sessionId: 1 }), ADDRESS),
    ).toEqual({ kind: "line_select" });
  });

  it("forgets a waiting move when the office moves the station back before the work ends", () => {
    const moved = shellReducer(working(), { type: "device_refreshed", status: MOVED });
    const back = shellReducer(moved, { type: "device_refreshed", status: DEVICE_STATUS });
    expect(back.pendingDevice).toBeNull();
    const left = shellReducer(back, { type: "work_left", sessionId: 1 });
    expect(left.operator).toEqual({ ...ANNA, sessionId: 1 });
    expect(left.floorNotice).toBeNull();
  });

  it("lets a refused device win over another line when the work ends", () => {
    const both = shellReducer(
      shellReducer(working(), { type: "device_refreshed", status: MOVED }),
      { type: "device_rejected", reason: "key_rejected" },
    );
    const left = shellReducer(both, { type: "work_left", sessionId: 1 });
    expect(nextShellView(left, ADDRESS)).toEqual({
      kind: "device_rejected",
      reason: "key_rejected",
    });
    expect(left.pendingDevice).toBeNull();
  });

  it("ends the work with a sign-out, and what waited for it happens then", () => {
    const idle = shellReducer(working(), {
      type: "operator_signed_out",
      sessionId: 1,
      notice: "idle",
    });
    expect(idle.floorWork).toBeNull();
    expect(idle.floorNotice).toBe("idle");
    const moved = shellReducer(working(), { type: "device_refreshed", status: MOVED });
    const out = shellReducer(moved, { type: "operator_signed_out", sessionId: 1, notice: "idle" });
    expect(out.device).toEqual({ kind: "ready", status: MOVED });
    expect(out.floorNotice).toBe("line_changed");
  });

  it("drops the work and what waits for it with the operator: the office, a new pairing, a forget", () => {
    const waiting = shellReducer(
      shellReducer(working(), { type: "device_refreshed", status: MOVED }),
      { type: "device_rejected", reason: "key_rejected" },
    );
    for (const action of [
      { type: "office_requested" },
      { type: "paired", status: DEVICE_STATUS },
      { type: "forgotten" },
      { type: "host_probed", localHost: { kind: "probing" } },
    ] satisfies ShellAction[]) {
      const after = shellReducer(waiting, action);
      expect(after.floorWork).toBeNull();
      expect(after.pendingRejection).toBeNull();
      expect(after.pendingDevice).toBeNull();
    }
  });

  it("takes a new name of the device on the same line without ending the session", () => {
    const floor = shellReducer(paired(), signIn);
    const renamed = shellReducer(floor, {
      type: "device_refreshed",
      status: { ...DEVICE_STATUS, deviceName: "Станция у окна" },
    });
    expect(renamed.device).toEqual({
      kind: "ready",
      status: { ...DEVICE_STATUS, deviceName: "Станция у окна" },
    });
    expect(renamed.operator).toEqual({ ...ANNA, sessionId: 1 });
  });

  it("says the office's change was not saved until a read of the device lands", () => {
    const failed = shellReducer(paired(), { type: "device_not_saved" });
    expect(failed.deviceNotSaved).toBe(true);
    expect(shellReducer(failed, { type: "device_not_saved" })).toBe(failed);
    const saved = shellReducer(failed, { type: "device_refreshed", status: DEVICE_STATUS });
    expect(saved.deviceNotSaved).toBe(false);
    const fresh = shellReducer(failed, { type: "paired", status: DEVICE_STATUS });
    expect(fresh.deviceNotSaved).toBe(false);
  });

  it("counts the reads of the station's shifts and keeps whether the last failed", () => {
    let state = paired();
    state = shellReducer(state, { type: "shifts_read", ok: true });
    state = shellReducer(state, { type: "shifts_read", ok: false });
    expect(state.shiftReads).toEqual({ done: 1, failed: true });
    state = shellReducer(state, { type: "shifts_read", ok: true });
    expect(state.shiftReads).toEqual({ done: 2, failed: false });
    expect(shellReducer(state, { type: "forgotten" }).shiftReads).toEqual({
      done: 0,
      failed: false,
    });
  });
});
```

Создать `apps/standalone/test/host-link-shifts.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { useHostLink } from "../src/app/host-link.js";
import type { ShellAction } from "../src/app/shell.js";
import { HostError } from "../src/host/client.js";
import type { ConnectionApi, ConnectionHandlers } from "../src/host/connection.js";
import { DeviceError } from "../src/host/device.js";
import {
  deviceShiftsSchema,
  type ChangesResponse,
  type DeviceShift,
  type DeviceStatus,
  type HostStatus,
} from "../src/host/protocol.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
const SHIFTS = deviceShiftsSchema.parse(
  JSON.parse(readFileSync(new URL("../proto/fixtures/device-shifts.json", testModuleUrl), "utf8")),
).shifts;
const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };
const OFFLINE: HostStatus = {
  state: "offline",
  lastContactAt: 1,
  lastError: "unreachable",
  seq: 2,
};

/** The shell's link as the test drives it: `watch` reports "online" at once. */
function fakeConnection() {
  let handlers: ConnectionHandlers | null = null;
  const connection: ConnectionApi = {
    watch: vi.fn(async (next: ConnectionHandlers) => {
      handlers = next;
      next.onStatus(ONLINE);
      return () => {
        handlers = null;
      };
    }),
  };
  return {
    connection,
    status: (status: HostStatus) =>
      act(async () => {
        handlers?.onStatus(status);
      }),
    revision: (rev: number) =>
      act(async () => {
        handlers?.onRevision(rev);
      }),
  };
}

const rowSchema = z.object({ id: z.string(), device_id: z.string() });

function link(deviceShifts: () => Promise<DeviceShift[]>, deviceId = DEVICE_ID) {
  const { db, executor } = openLocalDb();
  const connection = fakeConnection();
  const dispatch = vi.fn<(action: ShellAction) => void>();
  const changes = vi.fn(async (): Promise<ChangesResponse> => ({
    hostId: HOST_ID,
    rev: 1,
    hasMore: false,
    items: [],
  }));
  const refresh = vi.fn(async (): Promise<DeviceStatus> => DEVICE_STATUS);
  const hook = renderHook(
    ({ id }) =>
      useHostLink({
        hostId: HOST_ID,
        deviceId: id,
        connection: connection.connection,
        local: executor,
        changes,
        refresh,
        deviceShifts,
        dispatch,
      }),
    { initialProps: { id: deviceId } },
  );
  const copies = () =>
    executor.query("SELECT id, device_id FROM floor_shifts ORDER BY id", [], rowSchema);
  const reads = () =>
    dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "shifts_read");
  return { db, connection, dispatch, refresh, hook, copies, reads };
}

/** Two turns of React's effect scheduler and the promises they started. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the station's shifts on the link", () => {
  it("are read once the link is watched and after every revision, into this pairing's copies", async () => {
    const deviceShifts = vi.fn(async () => SHIFTS);
    const { connection, copies, reads, hook } = link(deviceShifts);
    await waitFor(() => expect(reads()).toEqual([{ type: "shifts_read", ok: true }]));
    expect(await copies()).toEqual(
      SHIFTS.map((shift) => ({ id: shift.id, device_id: DEVICE_ID })).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    );
    deviceShifts.mockResolvedValueOnce([]);
    await connection.revision(7);
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(await copies()).toEqual([]);
    expect(deviceShifts).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("are read one at a time: revisions during a read ask for exactly one more", async () => {
    let answer: (shifts: DeviceShift[]) => void = () => undefined;
    const deviceShifts = vi.fn(async () => SHIFTS);
    const { connection, reads, hook } = link(deviceShifts);
    await waitFor(() => expect(reads()).toHaveLength(1));
    deviceShifts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await connection.revision(7);
    await connection.revision(8);
    await connection.revision(9);
    await settle();
    expect(deviceShifts).toHaveBeenCalledTimes(2);
    await act(async () => {
      answer(SHIFTS);
    });
    await waitFor(() => expect(reads()).toHaveLength(3));
    await settle();
    expect(deviceShifts).toHaveBeenCalledTimes(3);
    hook.unmount();
  });

  it("keep the copies and are tried again after 2 s, then 4 s, while the link is online", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const deviceShifts = vi
      .fn<() => Promise<DeviceShift[]>>()
      .mockResolvedValueOnce(SHIFTS)
      .mockRejectedValueOnce(down)
      .mockRejectedValueOnce(down)
      .mockResolvedValue([]);
    const { connection, copies, reads, hook } = link(deviceShifts);
    await waitFor(() => expect(reads()).toHaveLength(1));
    await connection.revision(7);
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(reads()[1]).toEqual({ type: "shifts_read", ok: false });
    expect(await copies()).toHaveLength(2);
    // The clock also runs with real time (`shouldAdvanceTime`): every check
    // keeps 800 ms from the retry it must not reach yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(deviceShifts).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(deviceShifts).toHaveBeenCalledTimes(3));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(deviceShifts).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(reads().at(-1)).toEqual({ type: "shifts_read", ok: true }));
    expect(await copies()).toEqual([]);
    hook.unmount();
  });

  it("drop the retry while the link is down, and are read at once when it is back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const deviceShifts = vi
      .fn<() => Promise<DeviceShift[]>>()
      .mockRejectedValueOnce(down)
      .mockResolvedValue(SHIFTS);
    const { connection, reads, hook } = link(deviceShifts);
    await waitFor(() => expect(reads()).toEqual([{ type: "shifts_read", ok: false }]));
    await connection.status(OFFLINE);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(deviceShifts).toHaveBeenCalledTimes(1);
    await connection.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(reads().at(-1)).toEqual({ type: "shifts_read", ok: true }));
    expect(deviceShifts).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("refuse the device on a refused key, and nothing more is read", async () => {
    const refused = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    const deviceShifts = vi.fn(async (): Promise<DeviceShift[]> => {
      throw refused;
    });
    const { connection, dispatch, refresh, hook } = link(deviceShifts);
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: "device_rejected", reason: "key_rejected" }),
    );
    const refreshes = refresh.mock.calls.length;
    await connection.revision(7);
    await settle();
    expect(deviceShifts).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(refreshes);
    hook.unmount();
  });

  it("write nothing when the answer lands after the pairing changed", async () => {
    let answer: (shifts: DeviceShift[]) => void = () => undefined;
    const deviceShifts = vi.fn(
      () =>
        new Promise<DeviceShift[]>((resolve) => {
          answer = resolve;
        }),
    );
    const { copies, hook, reads } = link(deviceShifts);
    await waitFor(() => expect(deviceShifts).toHaveBeenCalledTimes(1));
    const late = answer;
    deviceShifts.mockResolvedValue([]);
    hook.rerender({ id: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f" });
    await waitFor(() => expect(deviceShifts).toHaveBeenCalledTimes(2));
    await act(async () => {
      late(SHIFTS);
    });
    await settle();
    expect(await copies()).toEqual([]);
    expect(reads()).toEqual([{ type: "shifts_read", ok: true }]);
    hook.unmount();
  });
});

describe("the device read on the link", () => {
  it("says so when the office's change could not be saved on this computer", async () => {
    const { dispatch, refresh, hook } = link(async () => []);
    refresh.mockRejectedValue(new DeviceError("storage", "disk full"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "device_not_saved" }));
    hook.unmount();
  });
});
```

Правка `apps/standalone/test/app.test.tsx`:

Фрагмент:

<!-- prettier-ignore -->
```tsx
          changes,
          refresh,
          dispatch,
        }),
```

заменить на:

<!-- prettier-ignore -->
```tsx
          changes,
          refresh,
          deviceShifts: async () => [],
          dispatch,
        }),
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/host-link-shifts.test.ts test/app.test.tsx`
Expected: FAIL — на копии плана `Tests  66 failed | 161 passed (227)`: все семь тестов `host-link-shifts` (чтения смен ещё нет: `expected [] to deeply equal [ { type: 'shifts_read', ok: true } ]`), новый раздел `shell.test.ts` «the operator's session, the shift's work and what waits for it» и прежние тесты сеанса, которые теперь ждут `sessionId` (`expected { …(4) } to deeply equal { …(5) }`). `app.test.tsx` проходит: в нём меняется только аргумент `deviceShifts`.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/app/shell.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
export type FloorNotice = "idle" | "removed" | "line_changed";

export interface ShellState {
  device: DeviceState;
```

заменить на:

<!-- prettier-ignore -->
```ts
export type FloorNotice = "idle" | "removed" | "line_changed";

/**
 * The operator signed in on the floor, and the number of this sign-in's
 * session (stage 2a spec, decision 26): every sign-in starts a session with a
 * new number, and the floor's timers and checks name the session they belong
 * to, so a late one of an earlier session of the same operator ends nothing.
 * A refresh of the name and role from the copies keeps the session.
 */
export interface FloorSession extends FloorOperator {
  sessionId: number;
}

/** The shift the operator of `sessionId` works in, from entering it until leaving it. */
export interface FloorWork {
  sessionId: number;
  shiftId: string;
}

export interface ShellState {
  device: DeviceState;
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
   * the line all sign the operator out. Never an office user (spec §4.8).
   */
  operator: FloorOperator | null;
  /** Why the last operator was signed out, until the next one signs in. */
  floorNotice: FloorNotice | null;
}

```

заменить на:

<!-- prettier-ignore -->
```ts
   * the line all sign the operator out. Never an office user (spec §4.8).
   */
  operator: FloorSession | null;
  /** The number of the last session; the next sign-in's is one more. */
  lastSessionId: number;
  /** Why the last operator was signed out, until the next one signs in. */
  floorNotice: FloorNotice | null;
  /**
   * The shift the operator works in. While it is set, what would take the
   * floor away waits until the operator leaves the shift: a refused device
   * (`pendingRejection`, question В8) and another line (`pendingDevice`,
   * question В9).
   */
  floorWork: FloorWork | null;
  pendingRejection: RejectionReason | null;
  pendingDevice: DeviceStatus | null;
  /**
   * The station's reads of its shifts (`GET /v1/device/shifts`): how many
   * landed in the copies since the pairing, so a screen reading them knows
   * when to read again, and whether the last one failed.
   */
  shiftReads: { done: number; failed: boolean };
  /** The office's change of this device could not be saved on this computer. */
  deviceNotSaved: boolean;
}

```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  /** The floor with nobody signed in: the operator sign-in and the way into the office. */
  | { kind: "floor" }
  /** The floor with an operator signed in (stage 1's stub until the shifts of plan 2a). */
  | { kind: "floor_operator"; operator: FloorOperator }
  | { kind: "office_login"; notice: OfficeLoginNotice | null }
  | { kind: "office"; session: OfficeSession };
```

заменить на:

<!-- prettier-ignore -->
```ts
  /** The floor with nobody signed in: the operator sign-in and the way into the office. */
  | { kind: "floor" }
  /** The floor with an operator signed in: their shifts (`FloorApp`). */
  | { kind: "floor_operator"; operator: FloorSession }
  | { kind: "office_login"; notice: OfficeLoginNotice | null }
  | { kind: "office"; session: OfficeSession };
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
    }
  // `notice: null` is the operator's own «Сменить оператора».
  | { type: "operator_signed_out"; operatorId: string; notice: FloorNotice | null };

const CLOSED_OFFICE: OfficeState = { kind: "closed" };
const IDLE_SYNC: SyncState = { kind: "idle", synced: 0, failure: null, quarantined: 0 };

export const initialShellState: ShellState = {
```

заменить на:

<!-- prettier-ignore -->
```ts
    }
  // `notice: null` is the operator's own «Сменить оператора».
  | { type: "operator_signed_out"; sessionId: number; notice: FloorNotice | null }
  // The name and role of the session's operator, as a sync brought them.
  | { type: "operator_refreshed"; sessionId: number; name: string; role: string | null }
  | { type: "work_entered"; sessionId: number; shiftId: string }
  | { type: "work_left"; sessionId: number }
  | { type: "shifts_read"; ok: boolean }
  // `device_refresh` could not keep the host's answer in `device.json`.
  | { type: "device_not_saved" };

const CLOSED_OFFICE: OfficeState = { kind: "closed" };
const IDLE_SYNC: SyncState = { kind: "idle", synced: 0, failure: null, quarantined: 0 };
const NO_SHIFT_READS = { done: 0, failed: false };

/** No operator, so no work and nothing waiting for it. */
const NO_FLOOR_SESSION = {
  operator: null,
  floorWork: null,
  pendingRejection: null,
  pendingDevice: null,
} as const;

export const initialShellState: ShellState = {
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
  hostRevision: null,
  operator: null,
  floorNotice: null,
};

```

заменить на:

<!-- prettier-ignore -->
```ts
  hostRevision: null,
  operator: null,
  lastSessionId: 0,
  floorNotice: null,
  floorWork: null,
  pendingRejection: null,
  pendingDevice: null,
  shiftReads: NO_SHIFT_READS,
  deviceNotSaved: false,
};

```

Фрагмент 6:

<!-- prettier-ignore -->
```ts
}

export function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
```

заменить на:

<!-- prettier-ignore -->
```ts
}

/** The station moves to the line of `status`: an operator signed in for one line is not for another. */
function changeLine(state: ShellState, status: DeviceStatus): ShellState {
  return {
    ...state,
    device: { kind: "ready", status },
    ...NO_FLOOR_SESSION,
    floorNotice: state.operator === null ? state.floorNotice : "line_changed",
  };
}

/**
 * The operator left the shift: what waited for that happens now, a refused
 * device first (it ends everything), then another line.
 */
function endWork(state: ShellState): ShellState {
  const left = { ...state, floorWork: null, pendingRejection: null, pendingDevice: null };
  if (state.pendingRejection !== null) {
    return { ...left, rejection: state.pendingRejection, office: CLOSED_OFFICE, operator: null };
  }
  if (state.pendingDevice !== null) return changeLine(left, state.pendingDevice);
  return left;
}

/**
 * A refusal of this device: at once, or, while the operator works in a shift,
 * once they leave it (question В8): the line finishes its box, and nothing
 * reaches the host meanwhile.
 */
function reject(state: ShellState, reason: RejectionReason): ShellState {
  if (state.floorWork !== null) return { ...state, pendingRejection: reason };
  return { ...state, rejection: reason, office: CLOSED_OFFICE, ...NO_FLOOR_SESSION };
}

export function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
```

Фрагмент 7:

<!-- prettier-ignore -->
```ts
      // after it (a blocked version screen, another host). Losing the link
      // is not a probe, and keeps the operator.
      return { ...state, localHost: action.localHost, operator: null };
    case "pairing_started":
      return { ...state, pairing: { kind: "pairing" } };
```

заменить на:

<!-- prettier-ignore -->
```ts
      // after it (a blocked version screen, another host). Losing the link
      // is not a probe, and keeps the operator.
      return { ...state, localHost: action.localHost, ...NO_FLOOR_SESSION };
    case "pairing_started":
      return { ...state, pairing: { kind: "pairing" } };
```

Фрагмент 8:

<!-- prettier-ignore -->
```ts
        sync: IDLE_SYNC,
        hostRevision: null,
        operator: null,
        floorNotice: null,
      };
    case "pairing_failed":
```

заменить на:

<!-- prettier-ignore -->
```ts
        sync: IDLE_SYNC,
        hostRevision: null,
        ...NO_FLOOR_SESSION,
        floorNotice: null,
        shiftReads: NO_SHIFT_READS,
        deviceNotSaved: false,
      };
    case "pairing_failed":
```

Фрагмент 9:

<!-- prettier-ignore -->
```ts
        sync: IDLE_SYNC,
        hostRevision: null,
        operator: null,
        floorNotice: null,
      };
    case "host_initialized":
```

заменить на:

<!-- prettier-ignore -->
```ts
        sync: IDLE_SYNC,
        hostRevision: null,
        ...NO_FLOOR_SESSION,
        floorNotice: null,
        shiftReads: NO_SHIFT_READS,
        deviceNotSaved: false,
      };
    case "host_initialized":
```

Фрагмент 10:

<!-- prettier-ignore -->
```ts
        ...state,
        office: { kind: "signing_in", notice: action.notice ?? null },
        operator: null,
        floorNotice: null,
      };
```

заменить на:

<!-- prettier-ignore -->
```ts
        ...state,
        office: { kind: "signing_in", notice: action.notice ?? null },
        ...NO_FLOOR_SESSION,
        floorNotice: null,
      };
```

Фрагмент 11:

<!-- prettier-ignore -->
```ts
        ...state,
        office: { kind: "open", session: action.session },
        operator: null,
        floorNotice: null,
      };
```

заменить на:

<!-- prettier-ignore -->
```ts
        ...state,
        office: { kind: "open", session: action.session },
        ...NO_FLOOR_SESSION,
        floorNotice: null,
      };
```

Фрагмент 12:

<!-- prettier-ignore -->
```ts
        return state;
      }
      return { ...state, rejection: action.reason, office: CLOSED_OFFICE, operator: null };
    }
    case "office_user_refreshed":
```

заменить на:

<!-- prettier-ignore -->
```ts
        return state;
      }
      return reject(state, action.reason);
    }
    case "office_user_refreshed":
```

Фрагмент 13:

<!-- prettier-ignore -->
```ts
      const rejection = linkRejection(action.status);
      if (rejection === null) return { ...state, link: action.status };
      return { ...state, link: action.status, rejection, office: CLOSED_OFFICE, operator: null };
    }
    case "host_revision":
```

заменить на:

<!-- prettier-ignore -->
```ts
      const rejection = linkRejection(action.status);
      if (rejection === null) return { ...state, link: action.status };
      return reject({ ...state, link: action.status }, rejection);
    }
    case "host_revision":
```

Фрагмент 14:

<!-- prettier-ignore -->
```ts
          sync: { ...state.sync, kind: "other_host" },
          office: CLOSED_OFFICE,
          operator: null,
        };
      }
```

заменить на:

<!-- prettier-ignore -->
```ts
          sync: { ...state.sync, kind: "other_host" },
          office: CLOSED_OFFICE,
          ...NO_FLOOR_SESSION,
        };
      }
```

Фрагмент 15:

<!-- prettier-ignore -->
```ts
      };
    case "line_selected":
      return { ...state, device: { kind: "ready", status: action.status }, operator: null };
    case "device_refreshed": {
      // The line the office assigned (plan 1d3). Only the pairing the answer
      // belongs to takes it, so a late answer cannot bring back a pairing
      // that ended or changed; an answer with the same line changes nothing.
      // A cleared line sends the station back to choosing one.
      if (state.device.kind !== "ready" || state.device.status === null) return state;
      const current = state.device.status;
      if (
        current.deviceId !== action.status.deviceId ||
        current.hostId !== action.status.hostId ||
        current.lineId === action.status.lineId
      ) {
        return state;
      }
      // An operator signed in for one line is not signed in for another.
      return {
        ...state,
        device: { kind: "ready", status: action.status },
        operator: null,
        floorNotice: state.operator === null ? state.floorNotice : "line_changed",
      };
    }
    case "operator_signed_in": {
```

заменить на:

<!-- prettier-ignore -->
```ts
      };
    case "line_selected":
      return { ...state, device: { kind: "ready", status: action.status }, ...NO_FLOOR_SESSION };
    case "device_refreshed": {
      // The line and the name the office assigned (plans 1d3, 2a4). Only the
      // pairing the answer belongs to takes it, so a late answer cannot bring
      // back a pairing that ended or changed. A cleared line sends the
      // station back to choosing one.
      if (state.device.kind !== "ready" || state.device.status === null) return state;
      const current = state.device.status;
      if (current.deviceId !== action.status.deviceId || current.hostId !== action.status.hostId) {
        return state;
      }
      if (current.lineId === action.status.lineId) {
        // The same line: a new name at most, and an earlier move that waits
        // for the work is undone by this one.
        if (
          current.deviceName === action.status.deviceName &&
          state.pendingDevice === null &&
          !state.deviceNotSaved
        ) {
          return state;
        }
        return {
          ...state,
          device: { kind: "ready", status: action.status },
          pendingDevice: null,
          deviceNotSaved: false,
        };
      }
      const saved = { ...state, deviceNotSaved: false };
      // Another line waits until the operator leaves the shift (question В9).
      if (state.floorWork !== null) return { ...saved, pendingDevice: action.status };
      return changeLine(saved, action.status);
    }
    case "operator_signed_in": {
```

Фрагмент 16:

<!-- prettier-ignore -->
```ts
      }
      // The four fields, copied: a hash that slipped into the action's object
      // never reaches the state. A fresh object per sign-in, because `App`
      // tells one session from the next by this object.
      const { id, login, name, role } = action.operator;
      return { ...state, operator: { id, login, name, role }, floorNotice: null };
    }
    case "operator_signed_out":
      // A late sign-out (an idle timer, a check of the copies) for an
      // operator who already left must not sign out the next one.
      if (state.operator?.id !== action.operatorId) return state;
      return { ...state, operator: null, floorNotice: action.notice };
  }
}
```

заменить на:

<!-- prettier-ignore -->
```ts
      }
      // The four fields, copied: a hash that slipped into the action's object
      // never reaches the state; and a new session number.
      const { id, login, name, role } = action.operator;
      const sessionId = state.lastSessionId + 1;
      return {
        ...state,
        operator: { sessionId, id, login, name, role },
        lastSessionId: sessionId,
        floorNotice: null,
      };
    }
    case "operator_signed_out": {
      // A late sign-out (an idle timer, a check of the copies) of a session
      // that already ended must not sign out the next one, even of the same
      // operator.
      if (state.operator?.sessionId !== action.sessionId) return state;
      // A sign-out in the middle of the work ends the work first: what waited
      // for it (a refused device, another line) takes the floor.
      const left = state.floorWork === null ? state : endWork(state);
      if (left.operator === null) return left;
      return { ...left, ...NO_FLOOR_SESSION, floorNotice: action.notice };
    }
    case "operator_refreshed": {
      const operator = state.operator;
      if (operator?.sessionId !== action.sessionId) return state;
      if (operator.name === action.name && operator.role === action.role) return state;
      return { ...state, operator: { ...operator, name: action.name, role: action.role } };
    }
    case "work_entered":
      if (state.operator?.sessionId !== action.sessionId || state.floorWork !== null) return state;
      return {
        ...state,
        floorWork: { sessionId: action.sessionId, shiftId: action.shiftId },
      };
    case "work_left":
      if (state.floorWork?.sessionId !== action.sessionId) return state;
      return endWork(state);
    case "shifts_read":
      return {
        ...state,
        shiftReads: action.ok
          ? { done: state.shiftReads.done + 1, failed: false }
          : { done: state.shiftReads.done, failed: true },
      };
    case "device_not_saved":
      return state.deviceNotSaved ? state : { ...state, deviceNotSaved: true };
  }
}
```

Правка `apps/standalone/src/app/host-link.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { HostError } from "../host/client.js";
import type { ConnectionApi } from "../host/connection.js";
import { DeviceError } from "../host/device.js";
import type { ChangesResponse, DeviceStatus } from "../host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../local/executor.js";
import {
```

заменить на:

<!-- prettier-ignore -->
```ts
import { HostError } from "../host/client.js";
import type { ConnectionApi } from "../host/connection.js";
import { replaceShiftCopies } from "../floor/shifts/shift-copies.js";
import { DeviceError } from "../host/device.js";
import type { ChangesResponse, DeviceShift, DeviceStatus } from "../host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../local/executor.js";
import {
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  /** `DeviceApi.refresh`: this device's record, read again with the office's line. */
  refresh: () => Promise<DeviceStatus>;
  dispatch: (action: ShellAction) => void;
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  /** `DeviceApi.refresh`: this device's record, read again with the office's line. */
  refresh: () => Promise<DeviceStatus>;
  /** `HostApi.getDeviceShifts`: this station's shifts, kept in `floor_shifts`. */
  deviceShifts: () => Promise<DeviceShift[]>;
  dispatch: (action: ShellAction) => void;
}
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
 * carries it. A failed read — not a rejected device, not a missing pairing —
 * keeps the line the station has and is retried the same way, with a count
 * of its own. Returns a function that asks for a sync and a read now.
 */
export function useHostLink({
```

заменить на:

<!-- prettier-ignore -->
```ts
 * carries it. A failed read — not a rejected device, not a missing pairing —
 * keeps the line the station has and is retried the same way, with a count
 * of its own. The station's shifts are read at the same moments and the same
 * way (stage 2a spec §5.4): the answer replaces this pairing's copies
 * (`replaceShiftCopies`), and a failed read keeps the copies the station has.
 * Returns a function that asks for a sync and both reads now.
 */
export function useHostLink({
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  changes,
  refresh,
  dispatch,
}: HostLinkOptions): () => void {
```

заменить на:

<!-- prettier-ignore -->
```ts
  changes,
  refresh,
  deviceShifts,
  dispatch,
}: HostLinkOptions): () => void {
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
      refreshRetry = null;
    };
    const scheduler = createSyncScheduler(async () => {
      if (!active) return;
```

заменить на:

<!-- prettier-ignore -->
```ts
      refreshRetry = null;
    };
    // And for reading the station's shifts.
    let shiftFailures = 0;
    let shiftRetry: ReturnType<typeof setTimeout> | null = null;
    const cancelShiftRetry = () => {
      if (shiftRetry === null) return;
      clearTimeout(shiftRetry);
      shiftRetry = null;
    };
    // Nothing more should reach a host that refused this device's key or
    // presented another certificate.
    const stopAll = () => {
      scheduler.stop();
      refresher.stop();
      shiftReader.stop();
      cancelRetry();
      cancelRefreshRetry();
      cancelShiftRetry();
    };
    const scheduler = createSyncScheduler(async () => {
      if (!active) return;
```

Фрагмент 6:

<!-- prettier-ignore -->
```ts
          // also stops the scheduler) only runs after React re-renders with
          // `hostId: null`, and that is later than this microtask chain.
          scheduler.stop();
          refresher.stop();
        }
        dispatch({ type: "sync_finished", result });
```

заменить на:

<!-- prettier-ignore -->
```ts
          // also stops the scheduler) only runs after React re-renders with
          // `hostId: null`, and that is later than this microtask chain.
          stopAll();
        }
        dispatch({ type: "sync_finished", result });
```

Фрагмент 7:

<!-- prettier-ignore -->
```ts
          // Same reasoning as above: nothing more should reach a host that
          // just refused this device's key or presented another certificate.
          scheduler.stop();
          refresher.stop();
          dispatch(action);
        }
```

заменить на:

<!-- prettier-ignore -->
```ts
          // Same reasoning as above: nothing more should reach a host that
          // just refused this device's key or presented another certificate.
          stopAll();
          dispatch(action);
        }
```

Фрагмент 8:

<!-- prettier-ignore -->
```ts
        const reason = deviceRejection(error);
        if (reason !== null) {
          scheduler.stop();
          refresher.stop();
          cancelRetry();
          cancelRefreshRetry();
          dispatch({ type: "device_rejected", reason });
          return;
```

заменить на:

<!-- prettier-ignore -->
```ts
        const reason = deviceRejection(error);
        if (reason !== null) {
          stopAll();
          dispatch({ type: "device_rejected", reason });
          return;
```

Фрагмент 9:

<!-- prettier-ignore -->
```ts
        // nothing to read again.
        if (error instanceof DeviceError && error.code === "not_paired") return;
        // Anything else — the host away, an answer this build cannot read, a
        // failed write of `device.json` — keeps the line this station already
```

заменить на:

<!-- prettier-ignore -->
```ts
        // nothing to read again.
        if (error instanceof DeviceError && error.code === "not_paired") return;
        // The host's answer did not reach `device.json`: the station stays on
        // the line it has, and says so (plan 1d3's open item).
        if (error instanceof DeviceError && error.code === "storage") {
          dispatch({ type: "device_not_saved" });
        }
        // Anything else — the host away, an answer this build cannot read, a
        // failed write of `device.json` — keeps the line this station already
```

Фрагмент 10:

<!-- prettier-ignore -->
```ts
      }
    });
    syncNow.current = () => {
      scheduler.trigger();
      refresher.trigger();
    };
    let unwatch: (() => void) | null = null;
    connection
```

заменить на:

<!-- prettier-ignore -->
```ts
      }
    });
    // One read of the station's shifts at a time, retried like the reads
    // above. A refused key ends the link as everywhere; any other failure —
    // the host away, an answer this build cannot read, this computer's
    // database — keeps the copies the station has (offline first).
    const shiftReader = createSyncScheduler(async () => {
      if (!active) return;
      cancelShiftRetry();
      try {
        const shifts = await deviceShifts();
        if (!active) return;
        await replaceShiftCopies(local, { hostId, deviceId }, shifts, Date.now());
        if (!active) return;
        shiftFailures = 0;
        dispatch({ type: "shifts_read", ok: true });
      } catch (error) {
        if (!active) return;
        const action = shellActionFor(error, null);
        if (action) {
          stopAll();
          dispatch(action);
          return;
        }
        if (error instanceof HostError && error.code === "not_paired") return;
        shiftFailures += 1;
        dispatch({ type: "shifts_read", ok: false });
        if (online) {
          shiftRetry = setTimeout(() => {
            shiftRetry = null;
            shiftReader.trigger();
          }, nextSyncRetryMs(shiftFailures));
        }
      }
    });
    const everything = () => {
      scheduler.trigger();
      refresher.trigger();
      shiftReader.trigger();
    };
    syncNow.current = everything;
    let unwatch: (() => void) | null = null;
    connection
```

Фрагмент 11:

<!-- prettier-ignore -->
```ts
            cancelRetry();
            cancelRefreshRetry();
            return;
          }
```

заменить на:

<!-- prettier-ignore -->
```ts
            cancelRetry();
            cancelRefreshRetry();
            cancelShiftRetry();
            return;
          }
```

Фрагмент 12:

<!-- prettier-ignore -->
```ts
            scheduler.trigger();
          }
          // The same for a failed read of this device.
          if (refreshFailures > 0 && refreshRetry === null) refresher.trigger();
        },
        onRevision: (rev) => {
```

заменить на:

<!-- prettier-ignore -->
```ts
            scheduler.trigger();
          }
          // The same for a failed read of this device and of its shifts.
          if (refreshFailures > 0 && refreshRetry === null) refresher.trigger();
          if (shiftFailures > 0 && shiftRetry === null) shiftReader.trigger();
        },
        onRevision: (rev) => {
```

Фрагмент 13:

<!-- prettier-ignore -->
```ts
          if (!active) return;
          dispatch({ type: "host_revision", rev });
          scheduler.trigger();
          refresher.trigger();
        },
      })
```

заменить на:

<!-- prettier-ignore -->
```ts
          if (!active) return;
          dispatch({ type: "host_revision", rev });
          everything();
        },
      })
```

Фрагмент 14:

<!-- prettier-ignore -->
```ts
          // not replayed, so a sync started earlier could miss a commit that
          // landed between its fetch and the listener.
          scheduler.trigger();
          refresher.trigger();
        },
        () => {
          // Without events the copies sync and the device is read once here,
          // and both again on request. `online` never becomes true, so neither
          // a failed sync nor a failed read is retried on its own.
          if (!active) return;
          scheduler.trigger();
          refresher.trigger();
        },
      );
```

заменить на:

<!-- prettier-ignore -->
```ts
          // not replayed, so a sync started earlier could miss a commit that
          // landed between its fetch and the listener.
          everything();
        },
        () => {
          // Without events the copies sync and the device and its shifts are
          // read once here, and again on request. `online` never becomes true,
          // so no failed run is retried on its own.
          if (!active) return;
          everything();
        },
      );
```

Фрагмент 15:

<!-- prettier-ignore -->
```ts
      active = false;
      syncNow.current = () => undefined;
      scheduler.stop();
      refresher.stop();
      cancelRetry();
      cancelRefreshRetry();
      unwatch?.();
    };
  }, [hostId, deviceId, connection, local, changes, refresh, dispatch]);
  return useCallback(() => syncNow.current(), []);
}
```

заменить на:

<!-- prettier-ignore -->
```ts
      active = false;
      syncNow.current = () => undefined;
      stopAll();
      unwatch?.();
    };
  }, [hostId, deviceId, connection, local, changes, refresh, deviceShifts, dispatch]);
  return useCallback(() => syncNow.current(), []);
}
```

Правка `apps/standalone/src/app/App.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";

```

заменить на:

<!-- prettier-ignore -->
```tsx
import { useCallback, useEffect, useMemo, useReducer, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
    pairedStatus !== null && pairedStatus.hostAddress !== address ? pairedStatus.hostAddress : null;

  const linked =
    pairedStatus !== null && state.rejection === null && state.sync.kind !== "other_host"
      ? pairedStatus
      : null;
```

заменить на:

<!-- prettier-ignore -->
```tsx
    pairedStatus !== null && pairedStatus.hostAddress !== address ? pairedStatus.hostAddress : null;

  // A refusal that waits for the operator to leave the shift (question В8)
  // already stops the link: nothing more reaches a host that refused us.
  const linked =
    pairedStatus !== null &&
    state.rejection === null &&
    state.pendingRejection === null &&
    state.sync.kind !== "other_host"
      ? pairedStatus
      : null;
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
    changes: hostApi.getChanges,
    refresh: deviceApi.refresh,
    dispatch,
  });
```

заменить на:

<!-- prettier-ignore -->
```tsx
    changes: hostApi.getChanges,
    refresh: deviceApi.refresh,
    deviceShifts: hostApi.getDeviceShifts,
    dispatch,
  });
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
    (operator: FloorOperator, lineId: string | null) => {
      if (pairedDeviceId !== null) {
        // A copy, and the reducer stores a fresh object of its own, so each
        // sign-in is a session of its own: the sign-out below tells a session
        // from the next one of the same operator by the STORED object, never
        // by the operator's id.
        dispatch({
          type: "operator_signed_in",
```

заменить на:

<!-- prettier-ignore -->
```tsx
    (operator: FloorOperator, lineId: string | null) => {
      if (pairedDeviceId !== null) {
        // The reducer gives the sign-in a new session number.
        dispatch({
          type: "operator_signed_in",
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
          lineId,
          address,
          operator: { ...operator },
        });
      }
```

заменить на:

<!-- prettier-ignore -->
```tsx
          lineId,
          address,
          operator,
        });
      }
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
    [pairedDeviceId, address],
  );
  // The operator of the session on screen, as the last commit has it.
  const signedIn = state.operator;
  const currentOperator = useRef<FloorOperator | null>(null);
  useLayoutEffect(() => {
    currentOperator.current = signedIn;
  }, [signedIn]);
  // Bound to ONE session (`signedIn` is the object that session's sign-in
  // made): a late idle timer or copy check of an earlier session of the same
  // operator must not end the session that followed it. The callback changes
  // only with the session, so the screen's idle timer is not restarted by
  // every event of the link.
  const operatorSignedOut = useCallback(
    (notice: FloorNotice | null) => {
      if (signedIn === null || currentOperator.current !== signedIn) return;
      dispatch({ type: "operator_signed_out", operatorId: signedIn.id, notice });
    },
    [signedIn],
  );

```

заменить на:

<!-- prettier-ignore -->
```tsx
    [pairedDeviceId, address],
  );
  // Bound to ONE session by its number: a late idle timer or copy check of an
  // earlier session of the same operator ends nothing (the reducer compares
  // the number). The callback changes only with the session, so the screen's
  // idle timer is not restarted by every event of the link or a new name.
  const sessionId = state.operator?.sessionId ?? null;
  const operatorSignedOut = useCallback(
    (notice: FloorNotice | null) => {
      if (sessionId !== null) dispatch({ type: "operator_signed_out", sessionId, notice });
    },
    [sessionId],
  );

```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/host-link-shifts.test.ts test/app.test.tsx`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  227 passed (227)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`
Expected: без ошибок.

- [ ] **Step 5: Мутации**

Run мутаций 1–4: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/host-link-shifts.test.ts`.

1. `apps/standalone/src/app/shell.ts`, в `reject`: удалить строку `  if (state.floorWork !== null) return { ...state, pendingRejection: reason };`. Expected: FAIL — «keeps the operator in the shift when the link refuses the key, and refuses the device once they leave it» и «… when a call refuses the key …».
2. Там же, в `device_refreshed`: удалить строку `      if (state.floorWork !== null) return { ...saved, pendingDevice: action.status };`. Expected: FAIL — «keeps the station on its line while the operator works, and moves it once they leave» и «forgets a waiting move when the office moves the station back before the work ends».
3. Там же, в `operator_signed_out`: `      if (state.operator?.sessionId !== action.sessionId) return state;` → `      if (state.operator === null) return state;`. Expected: FAIL — «ignores a late sign-out for an operator who already left» и строка таблицы `operator_signed_out {"type":"operator_signed_out","sessionId":2,…}`.
4. Там же, в `operator_refreshed`: `      if (operator?.sessionId !== action.sessionId) return state;` → `      if (operator === null) return state;`. Expected: FAIL — «refreshes the name and role of the running session only, without a new session» и строка таблицы `operator_refreshed {…"sessionId":2…}`.
5. `apps/standalone/src/app/host-link.ts`, в читателе смен: удалить строку `        if (!active) return;` сразу после `        const shifts = await deviceShifts();`. Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-link-shifts.test.ts`. Expected: FAIL — «write nothing when the answer lands after the pairing changed».
6. Там же, в `stopAll`: удалить строку `      shiftReader.stop();`. Тот же Run. Expected: FAIL — «refuse the device on a refused key, and nothing more is read».
7. Там же: удалить строку `          dispatch({ type: "device_not_saved" });`. Тот же Run. Expected: FAIL — «says so when the office's change could not be saved on this computer».

Защиту `state.pendingRejection === null` в `App` проверяет приложение целиком — мутация задачи 7.

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/app/shell.ts apps/standalone/src/app/host-link.ts apps/standalone/src/app/App.tsx apps/standalone/test/shell.test.ts apps/standalone/test/host-link-shifts.test.ts apps/standalone/test/app.test.tsx`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `git diff --check`; один verbose-прогон трёх файлов без `stderr` и прогон под стендом с задержкой `setImmediate` (заметки).
Expected: чисто; под стендом — те же `Test Files  3 passed (3)`, `Tests  227 passed (227)`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/app/shell.ts apps/standalone/src/app/host-link.ts apps/standalone/src/app/App.tsx apps/standalone/test/shell.test.ts apps/standalone/test/host-link-shifts.test.ts apps/standalone/test/app.test.tsx
git commit -m "feat(standalone): an operator's session has a number, the shift's work holds back a refusal and a new line, and the link reads the station's shifts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Список смен линии и вход в смену

`src/floor/shifts/shift-entry.ts` — `enterShift(context, copy)` (§5.4): со связью `online` — `POST …/enter`; ответ хоста проверяется (`checkShiftSnapshot`) и только тогда сохраняется (`keepEnteredShift`) и читается обратно (`readStoredWork`); нечитаемый снимок не сохраняется и не открывает работу. Без связи, и когда запрос при связи `online` не нашёл хоста (транспортный отказ, кроме смены сертификата, — его `shellActionFor` отдаёт оболочке), — только сохранённый снимок активной смены этой станции. Отказы хоста по `details.constraint` (`shift_busy`, `shift_status`, `shift_line`, `product_inactive`, `template_not_fit`) и `not_found` — словами; отказ ключа или смена сертификата — `rejected`, который экран отдаёт оболочке.

`ShiftCard.tsx` — карточка (облачная `ShiftCard` без фото): номер, статус фазой и словом («Не начата», «В работе», «Закрывается»), товар, дата производства `ДД.ММ.ГГГГ`, режим, план или «План не указан», контрагент, одна кнопка 64 px. `cardAction`: запланированная — «Открыть» (нужна связь); активная этой станции — «Продолжить» (без связи — только со снимком); активная другой станции — «Занята другой станцией»; закрываемая станцией — «Закрывается»; где нужна связь, а её нет, — подпись «Нужна связь с хостом». `ShiftList.tsx` — список (облачная `ShiftSelection` на локальных данных): копии подключения перечитываются при каждом удачном чтении хоста (`shiftReads.done`) и после отказа во входе; одна попытка входа за раз (охрана — ссылка, а не состояние: два нажатия в одном такте); «Сменить оператора» не держится попыткой; ответ после размонтирования отбрасывается; «Новая смена» выключена без связи с объяснением. Сообщения — в вежливой живой области: отказ, «Смену … закрыли в офисе», «Нет связи с хостом: показаны смены, полученные раньше…», «Список смен не обновился с хоста…».

**Files:**

- Create: `apps/standalone/src/floor/shifts/shift-entry.ts`, `apps/standalone/src/floor/shifts/shift-text.ts`, `apps/standalone/src/floor/shifts/ShiftCard.tsx`, `apps/standalone/src/floor/shifts/ShiftList.tsx`
- Modify: `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`
- Test: `apps/standalone/test/floor-shift-list.test.tsx` (Create)

**Interfaces:**

- Consumes: `ShiftCopy`, `WorkShift`, `keepEnteredShift`, `readShiftCopies`, `readStoredWork` (задача 3); `checkShiftSnapshot` (задача 3); `EnteredShift` (задача 2); `FloorSession`, `shellActionFor` (задача 4, `src/app/shell.ts`); `HostError` (`src/host/client.ts`).
- Produces:
  - `shift-entry.ts`: `type EntryRefusal = "no_link" | "busy" | "closed" | "other_line" | "not_found" | "product_inactive" | "template_not_fit" | "unreadable" | "local" | "failed"`, `type EntryResult = { kind: "entered"; shift: WorkShift; offline: boolean } | { kind: "refused"; reason } | { kind: "rejected"; error }`, `interface EntryContext { local; pairing; online; enter; now }`, `enterShift(context, copy): Promise<EntryResult>`;
  - `shift-text.ts`: `formatCivilDate(date): string`, `formatQuantity(n): string`;
  - `ShiftCard.tsx`: `type CardAction`, `cardAction(copy, deviceId, online): CardAction`, `ShiftCard`;
  - `ShiftList.tsx`: `type ShiftListNotice = { kind: "office_closed"; number: string }`, `interface ShiftListProps { local; pairing; lineId; operator; online; shiftReads; notice; enter; onEntered; onHostError; onNew; onSignOut }`, `ShiftList`;
  - ключи `floor.shifts.*`; классы `shift-list`, `shift-list__cards`, `shift-card*`.

- [ ] **Step 1: Написать падающий тест**

Создать `apps/standalone/test/floor-shift-list.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { readFileSync } from "node:fs";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorSession } from "../src/app/shell.js";
import {
  keepEnteredShift,
  readShiftCopy,
  replaceShiftCopies,
  type WorkShift,
} from "../src/floor/shifts/shift-copies.js";
import { ShiftList, type ShiftListNotice } from "../src/floor/shifts/ShiftList.js";
import { HostError } from "../src/host/client.js";
import {
  deviceShiftsSchema,
  enteredShiftSchema,
  type DeviceShift,
  type EnteredShift,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const [ACTIVE, PLANNED] = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts as [
  DeviceShift,
  DeviceShift,
];
const ENTERED: EnteredShift = enteredShiftSchema.parse(fixture("device-shift-entered.json"));
/** The planned shift as the host answers its opening: active, this station's. */
const OPENED: EnteredShift = {
  ...ENTERED,
  id: PLANNED.id,
  number: PLANNED.number,
  createdFrom: "station",
  productionDate: PLANNED.productionDate,
  plannedQty: null,
  counterpartyName: null,
  snapshot: { ...ENTERED.snapshot, counterpartyName: null },
};
const ANNA: FloorSession = {
  sessionId: 1,
  id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
};
const OTHER_STATION = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const READ = { done: 1, failed: false };
const SEEN = 1_790_000_000_000;

interface Options {
  online?: boolean;
  shiftReads?: { done: number; failed: boolean };
  notice?: ShiftListNotice | null;
  enter?: (id: string) => Promise<EnteredShift>;
}

function listOf(local: LocalExecutor, handlers: ReturnType<typeof handlersOf>, options: Options) {
  return (
    <ThemeProvider>
      <ShiftList
        local={local}
        pairing={PAIRING}
        lineId={LINE_ID}
        operator={ANNA}
        online={options.online ?? true}
        shiftReads={options.shiftReads ?? READ}
        notice={options.notice ?? null}
        enter={options.enter ?? handlers.enter}
        onEntered={handlers.onEntered}
        onHostError={handlers.onHostError}
        onNew={handlers.onNew}
        onSignOut={handlers.onSignOut}
      />
    </ThemeProvider>
  );
}

function handlersOf() {
  return {
    enter: vi.fn<(id: string) => Promise<EnteredShift>>(async () => OPENED),
    onEntered: vi.fn<(shift: WorkShift) => void>(),
    onHostError: vi.fn<(error: unknown) => void>(),
    onNew: vi.fn(),
    onSignOut: vi.fn(),
  };
}

async function copiesOf(shifts: DeviceShift[], entered: EnteredShift[] = []) {
  const opened = openLocalDb();
  for (const shift of entered) {
    await keepEnteredShift(opened.executor, PAIRING, shift, "2026-10-09T06:00:00.000Z", SEEN);
  }
  await replaceShiftCopies(opened.executor, PAIRING, shifts, SEEN);
  return opened;
}

function renderList(local: LocalExecutor, options: Options = {}) {
  const handlers = handlersOf();
  const view = render(listOf(local, handlers, options));
  return { handlers, view };
}

function card(number: string): HTMLElement {
  const label = screen.getByText(number);
  const element = label.closest(".shift-card");
  if (!(element instanceof HTMLElement)) throw new Error(`no card for ${number}`);
  return element;
}

/** This station's active shift as the list reads it: owned by this device. */
const MINE: DeviceShift = { ...ACTIVE, ownerDeviceId: DEVICE_ID };
const ENTERED_MINE: EnteredShift = { ...ENTERED, ownerDeviceId: DEVICE_ID };

describe("the shifts of the station's line", () => {
  it("names each shift, its product, date, plan and counterparty in words", async () => {
    const { executor } = await copiesOf([PLANNED, MINE]);
    renderList(executor);
    await screen.findByText("OCT26-004");
    const active = card("OCT26-004");
    expect(within(active).getByText("В работе")).toBeTruthy();
    expect(within(active).getByText("Молоко 3,2% 0,9 л")).toBeTruthy();
    expect(within(active).getByText("Дата производства: 08.10.2026")).toBeTruthy();
    // The thousands are parted by a no-break space, as `Intl` writes them for Russian.
    expect(active.textContent).toContain("План: 1\u00a0200");
    expect(within(active).getByText("Для: ООО «Северный берег»")).toBeTruthy();
    expect(within(active).getByText("Агрегация")).toBeTruthy();
    const planned = card("OCT26-005/S");
    expect(within(planned).getByText("Не начата")).toBeTruthy();
    expect(within(planned).getByText("План не указан")).toBeTruthy();
    expect(within(planned).getByRole("button", { name: "Открыть" })).toBeTruthy();
    expect(screen.getByText("Вошёл: Анна Кузнецова, табельный номер 0042.")).toBeTruthy();
  });

  it("opens a planned shift with the host and hands over the shift with its checked snapshot", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const { handlers } = renderList(executor);
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(handlers.enter).toHaveBeenCalledWith(PLANNED.id);
    const [shift] = handlers.onEntered.mock.calls[0] ?? [];
    expect(shift).toMatchObject({
      copy: { id: PLANNED.id, status: "active", entered: true },
      snapshot: { issuerPrefix: "460068200", boxTemplate: { spec: { language: "tspl" } } },
    });
    expect(await readShiftCopy(executor, PAIRING, PLANNED.id)).toMatchObject({ entered: true });
  });

  it("keeps a planned shift and a new one closed without the host, and says why", async () => {
    const { executor } = await copiesOf([PLANNED]);
    renderList(executor, { online: false });
    await screen.findByText("OCT26-005/S");
    const planned = card("OCT26-005/S");
    expect(within(planned).getByRole("button", { name: "Открыть" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(planned).getByText("Нужна связь с хостом")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Новая смена" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Новую смену можно создать только при связи с хостом.")).toBeTruthy();
    expect(
      screen.getByText(
        "Нет связи с хостом: показаны смены, полученные раньше. Продолжить можно смену, которую эта станция уже открыла.",
      ),
    ).toBeTruthy();
  });

  it("continues the shift this station entered from its stored snapshot without the host", async () => {
    const { executor } = await copiesOf([MINE], [ENTERED_MINE]);
    const { handlers } = renderList(executor, { online: false });
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(handlers.enter).not.toHaveBeenCalled();
    expect(handlers.onEntered.mock.calls[0]?.[0]).toMatchObject({
      copy: { id: ACTIVE.id, entered: true },
    });
  });

  it("continues from the stored snapshot when the request finds no host though the link said online", async () => {
    const { executor } = await copiesOf([MINE], [ENTERED_MINE]);
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const { handlers } = renderList(executor, { enter: vi.fn(async () => Promise.reject(down)) });
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
  });

  it("does not continue a shift of this station whose snapshot it lost, until the host answers", async () => {
    const { executor } = await copiesOf([MINE]);
    renderList(executor, { online: false });
    expect(await screen.findByRole("button", { name: "Продолжить" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it.each([
    ["shift_busy", "Эту смену уже открыла другая станция."],
    ["shift_status", "Смена закрыта."],
    ["shift_line", "Смена не на линии этой станции."],
    ["product_inactive", "Товар смены выключен или в архиве: смену не открыть. Обратитесь в офис."],
    [
      "template_not_fit",
      "Шаблон этикетки смены выключен или не подходит товару: смену не открыть. Обратитесь в офис.",
    ],
  ])("says why the host refused the entry (%s) and keeps the list", async (constraint, text) => {
    const { executor } = await copiesOf([PLANNED]);
    const refused = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "no",
      details: { constraint },
    });
    const { handlers } = renderList(executor, {
      enter: vi.fn(async () => Promise.reject(refused)),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(handlers.onEntered).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Открыть" })).toHaveProperty("disabled", false),
    );
  });

  it("says a shift the office deleted is gone", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const gone = new HostError({ kind: "api", code: "not_found", status: 404, message: "no" });
    renderList(executor, { enter: vi.fn(async () => Promise.reject(gone)) });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(await screen.findByText("Смены больше нет на хосте: её удалили в офисе.")).toBeTruthy();
  });

  it("neither keeps nor works a shift whose layout this build does not read", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const broken = {
      ...OPENED,
      snapshot: { ...OPENED.snapshot, boxTemplate: { ...OPENED.snapshot.boxTemplate, spec: {} } },
    };
    const { handlers } = renderList(executor, { enter: vi.fn(async () => broken) });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(
      await screen.findByText(
        "Этикетку этой смены приложение прочитать не может. Обновите приложение или попросите офис закрыть смену.",
      ),
    ).toBeTruthy();
    expect(handlers.onEntered).not.toHaveBeenCalled();
    expect(await readShiftCopy(executor, PAIRING, PLANNED.id)).toMatchObject({ entered: false });
  });

  it("hands a refused device key to the shell", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const rejected = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    const { handlers } = renderList(executor, {
      enter: vi.fn(async () => Promise.reject(rejected)),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await waitFor(() => expect(handlers.onHostError).toHaveBeenCalledWith(rejected));
    expect(handlers.onEntered).not.toHaveBeenCalled();
  });

  it("enters one shift at a time and keeps «Сменить оператора» while an entry hangs", async () => {
    const { executor } = await copiesOf([PLANNED, MINE], [ENTERED_MINE]);
    let answer: (shift: EnteredShift) => void = () => undefined;
    const enter = vi.fn(
      () =>
        new Promise<EnteredShift>((resolve) => {
          answer = resolve;
        }),
    );
    const { handlers } = renderList(executor, { enter });
    const open = await screen.findByRole("button", { name: "Открыть" });
    act(() => {
      fireEvent.click(open);
      fireEvent.click(open);
    });
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    expect(enter).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Открываем смену…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Продолжить" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Новая смена" })).toHaveProperty("disabled", true);
    const signOut = screen.getByRole("button", { name: "Сменить оператора" });
    expect(signOut).toHaveProperty("disabled", false);
    fireEvent.click(signOut);
    expect(handlers.onSignOut).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer(OPENED);
    });
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
  });

  it("drops an entry whose answer lands after the screen is gone", async () => {
    const { executor } = await copiesOf([PLANNED]);
    let answer: (shift: EnteredShift) => void = () => undefined;
    const enter = vi.fn(
      () =>
        new Promise<EnteredShift>((resolve) => {
          answer = resolve;
        }),
    );
    const { handlers, view } = renderList(executor, { enter });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    view.unmount();
    await act(async () => {
      answer(OPENED);
    });
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(handlers.onEntered).not.toHaveBeenCalled();
  });

  it("offers nothing on a shift another station opened or one this station is closing", async () => {
    const { db, executor } = await copiesOf(
      [{ ...ACTIVE, ownerDeviceId: OTHER_STATION }, PLANNED],
      [],
    );
    await keepEnteredShift(executor, PAIRING, { ...OPENED }, "2026-10-09T06:00:00.000Z", SEEN);
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE id = ?").run(PLANNED.id);
    renderList(executor);
    await screen.findByText("OCT26-004");
    const busy = card("OCT26-004");
    expect(within(busy).getByRole("button", { name: "Занята другой станцией" })).toHaveProperty(
      "disabled",
      true,
    );
    const closing = card("OCT26-005/S");
    expect(within(closing).getByRole("button", { name: "Закрывается" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("reads its copies again after every read of the host's list", async () => {
    const { executor } = await copiesOf([]);
    const handlers = handlersOf();
    const view = render(listOf(executor, handlers, {}));
    expect(
      await screen.findByText(
        "Открытых смен на линии нет. Создайте смену или дождитесь плана из офиса.",
      ),
    ).toBeTruthy();
    await replaceShiftCopies(executor, PAIRING, [PLANNED], SEEN + 1);
    view.rerender(listOf(executor, handlers, { shiftReads: { done: 2, failed: false } }));
    expect(await screen.findByText("OCT26-005/S")).toBeTruthy();
  });

  it("says the shifts were never read rather than that there are none", async () => {
    const { executor } = await copiesOf([]);
    renderList(executor, { shiftReads: { done: 0, failed: false } });
    expect(
      await screen.findByText("Смены ещё не получены с хоста. Проверьте связь с хостом."),
    ).toBeTruthy();
  });

  it("says when the host's list did not update, and when a shift was closed in the office", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const handlers = handlersOf();
    const view = render(listOf(executor, handlers, { shiftReads: { done: 1, failed: true } }));
    expect(
      await screen.findByText("Список смен не обновился с хоста — показаны полученные раньше."),
    ).toBeTruthy();
    view.rerender(
      listOf(executor, handlers, { notice: { kind: "office_closed", number: "OCT26-004" } }),
    );
    expect(screen.getByText("Смену OCT26-004 закрыли в офисе.")).toBeTruthy();
  });

  it("explains a copy it cannot read and reads again on «Повторить»", async () => {
    const real = (await copiesOf([PLANNED])).executor;
    let broken = true;
    const flaky: LocalExecutor = {
      query: (sql, params, row) =>
        broken ? Promise.reject(new Error("disk")) : real.query(sql, params, row),
      transaction: (statements) => real.transaction(statements),
    };
    renderList(flaky);
    expect(await screen.findByText("Не удалось прочитать смены на этом компьютере.")).toBeTruthy();
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("OCT26-005/S")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-list.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/floor/shifts/ShiftList.js"`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/floor/shifts/shift-text.ts`:

<!-- prettier-ignore -->
```ts
/** A civil date `YYYY-MM-DD` as the floor shows it: `ДД.ММ.ГГГГ`, never through a clock. */
export function formatCivilDate(date: string): string {
  const [year, month, day] = date.split("-");
  return year === undefined || month === undefined || day === undefined
    ? date
    : `${day}.${month}.${year}`;
}

const QUANTITY = new Intl.NumberFormat("ru-RU");

/** A count of units as the floor shows it, with the Russian thousands separator. */
export function formatQuantity(quantity: number): string {
  return QUANTITY.format(quantity);
}
```

Создать `apps/standalone/src/floor/shifts/shift-entry.ts`:

<!-- prettier-ignore -->
```ts
import { HostError } from "../../host/client.js";
import type { EnteredShift } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { shellActionFor } from "../../app/shell.js";
import {
  keepEnteredShift,
  readStoredWork,
  type ShiftCopy,
  type WorkShift,
} from "./shift-copies.js";
import { checkShiftSnapshot } from "./shift-snapshot.js";

/**
 * Why the station did not enter a shift: the host is away and the shift is
 * not one this station entered before (`no_link`); the host refused it
 * (`busy`: another station opened it, `closed`, `other_line`, `not_found`:
 * deleted, `product_inactive`, `template_not_fit`); its layout is one this
 * build does not read (`unreadable`); this computer could not keep it
 * (`local`); or anything else (`failed`).
 */
export type EntryRefusal =
  | "no_link"
  | "busy"
  | "closed"
  | "other_line"
  | "not_found"
  | "product_inactive"
  | "template_not_fit"
  | "unreadable"
  | "local"
  | "failed";

export type EntryResult =
  | { kind: "entered"; shift: WorkShift; offline: boolean }
  | { kind: "refused"; reason: EntryRefusal }
  /** The host refused this device's key or showed another certificate: the shell's to handle. */
  | { kind: "rejected"; error: unknown };

export interface EntryContext {
  local: LocalExecutor;
  pairing: Pairing;
  /** The link to the host is online now. */
  online: boolean;
  /** `HostApi.enterShift`. */
  enter: (shiftId: string) => Promise<EnteredShift>;
  now: () => Date;
}

/** The refusals of `POST /v1/device/shifts/{id}/enter` by `details.constraint` (stage 2a spec §4.8). */
const CONFLICTS: Readonly<Record<string, EntryRefusal>> = {
  shift_busy: "busy",
  shift_status: "closed",
  shift_line: "other_line",
  product_inactive: "product_inactive",
  template_not_fit: "template_not_fit",
};

/** The stored shift to work without the host, or why there is none. */
async function storedWork(context: EntryContext, shiftId: string): Promise<EntryResult> {
  const stored = await readStoredWork(context.local, context.pairing, shiftId);
  switch (stored.kind) {
    case "ready":
      return { kind: "entered", shift: stored.shift, offline: true };
    case "missing":
      return { kind: "refused", reason: "no_link" };
    case "unreadable":
      return { kind: "refused", reason: "unreadable" };
  }
}

/**
 * Enters `copy` (stage 2a spec §5.4). With the link online the host opens a
 * planned shift or answers the snapshot of one this station opened, which is
 * checked (`checkShiftSnapshot`) and kept before the station works from it;
 * a snapshot this build does not read is neither kept nor worked from. With
 * the link down, or a request that never reached the host, only an active
 * shift this station entered before is entered, from its stored snapshot.
 * Opening a planned shift and freezing its snapshot are the host's, so a
 * station on a PC away from the host enters its planned shifts while the
 * link is up and works them later without it.
 */
export async function enterShift(context: EntryContext, copy: ShiftCopy): Promise<EntryResult> {
  if (copy.localState !== null) return { kind: "refused", reason: "closed" };
  if (!context.online) return storedWork(context, copy.id);
  let answer: EnteredShift;
  try {
    answer = await context.enter(copy.id);
  } catch (error) {
    if (shellActionFor(error, null) !== null) return { kind: "rejected", error };
    if (!(error instanceof HostError)) return { kind: "refused", reason: "failed" };
    // No answer at all: the link said online, but the request found no host.
    if (error.kind === "transport") return storedWork(context, copy.id);
    if (error.code === "not_found") return { kind: "refused", reason: "not_found" };
    const constraint = error.details["constraint"];
    const refusal =
      error.code === "conflict" && typeof constraint === "string"
        ? CONFLICTS[constraint]
        : undefined;
    return { kind: "refused", reason: refusal ?? "failed" };
  }
  if (!checkShiftSnapshot(answer.snapshot).ok) return { kind: "refused", reason: "unreadable" };
  try {
    const at = context.now();
    await keepEnteredShift(context.local, context.pairing, answer, at.toISOString(), at.getTime());
    const stored = await readStoredWork(context.local, context.pairing, copy.id);
    if (stored.kind !== "ready") return { kind: "refused", reason: "local" };
    return { kind: "entered", shift: stored.shift, offline: false };
  } catch {
    return { kind: "refused", reason: "local" };
  }
}
```

Создать `apps/standalone/src/floor/shifts/ShiftCard.tsx`:

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { Badge, Button, Card, StatusChip, type TagPhase } from "@markiro/ui";

import type { ShiftCopy } from "./shift-copies.js";
import { formatCivilDate, formatQuantity } from "./shift-text.js";

/**
 * What the card offers: open a planned shift, continue the active one this
 * station opened, or nothing for a shift another station opened or one this
 * station is closing. `enabled` is false where the host is needed and away.
 */
export type CardAction =
  | { kind: "open"; enabled: boolean }
  | { kind: "continue"; enabled: boolean }
  | { kind: "busy" }
  | { kind: "closing" };

/**
 * The action of `copy` on this station (`deviceId`) with the link `online`
 * or not: opening a planned shift needs the host (it freezes the snapshot);
 * continuing an active shift of this station needs it only when this
 * station keeps no snapshot of it (a database lost since the entry).
 */
export function cardAction(copy: ShiftCopy, deviceId: string, online: boolean): CardAction {
  if (copy.localState === "closing") return { kind: "closing" };
  if (copy.status === "active") {
    if (copy.ownerDeviceId !== deviceId) return { kind: "busy" };
    return { kind: "continue", enabled: online || copy.entered };
  }
  return { kind: "open", enabled: online };
}

const PHASE: Record<"planned" | "active" | "closing", TagPhase> = {
  planned: "planned",
  active: "active",
  closing: "running",
};

export interface ShiftCardProps {
  copy: ShiftCopy;
  action: CardAction;
  /** Another entry runs, or this one: every card waits. */
  busy: boolean;
  onAction: () => void;
}

/** One shift of the line (the cloud station's `ShiftCard` without the photo panel). */
export function ShiftCard({ copy, action, busy, onAction }: ShiftCardProps) {
  const { t } = useTranslation();
  const phase =
    copy.localState === "closing" ? "closing" : copy.status === "active" ? "active" : "planned";
  const enabled = (action.kind === "open" || action.kind === "continue") && action.enabled;
  const needsLink = (action.kind === "open" || action.kind === "continue") && !action.enabled;
  return (
    <Card className="shift-card">
      <div className="shift-card__heading">
        <span className="shift-card__number">{copy.number}</span>
        <StatusChip size="floor" phase={PHASE[phase]} label={t(`floor.shifts.status.${phase}`)} />
      </div>
      <p className="shift-card__product">{copy.productName}</p>
      <p>{t("floor.shifts.productionDate", { date: formatCivilDate(copy.productionDate) })}</p>
      <div className="shift-card__facts">
        <Badge size="floor">{t(`floor.shifts.mode.${copy.mode}`)}</Badge>
        <span>
          {copy.plannedQty === null
            ? t("floor.shifts.noPlan")
            : t("floor.shifts.plan", { quantity: formatQuantity(copy.plannedQty) })}
        </span>
      </div>
      {copy.counterpartyName !== null && (
        <p>{t("floor.shifts.counterparty", { name: copy.counterpartyName })}</p>
      )}
      <Button
        size="floor"
        fullWidth
        variant={action.kind === "continue" ? "primary" : "secondary"}
        disabled={busy || !enabled}
        onClick={onAction}
      >
        {t(`floor.shifts.action.${action.kind}`)}
      </Button>
      {needsLink && <p className="shift-card__hint">{t("floor.shifts.needsLink")}</p>}
    </Card>
  );
}
```

Создать `apps/standalone/src/floor/shifts/ShiftList.tsx`:

<!-- prettier-ignore -->
```tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card } from "@markiro/ui";

import type { FloorSession } from "../../app/shell.js";
import type { EnteredShift } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { readShiftCopies, type ShiftCopy, type WorkShift } from "./shift-copies.js";
import { enterShift, type EntryRefusal } from "./shift-entry.js";
import { cardAction, ShiftCard } from "./ShiftCard.js";

/** What the list says it was brought back for: the office closed the shift the operator worked in. */
export type ShiftListNotice = { kind: "office_closed"; number: string };

export interface ShiftListProps {
  local: LocalExecutor;
  pairing: Pairing;
  /** The station's line: the list shows its shifts. */
  lineId: string;
  operator: FloorSession;
  /** The link to the host is online. */
  online: boolean;
  /** `ShellState.shiftReads`: the list reads its copies again after every read. */
  shiftReads: { done: number; failed: boolean };
  notice: ShiftListNotice | null;
  /** `HostApi.enterShift`. */
  enter: (shiftId: string) => Promise<EnteredShift>;
  onEntered: (shift: WorkShift) => void;
  /** A refused key or a changed certificate: the shell's to route. */
  onHostError: (error: unknown) => void;
  onNew: () => void;
  onSignOut: () => void;
}

type Copies = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; copies: ShiftCopy[] };

/**
 * The shifts of the station's line (stage 2a spec §5.7.1, the cloud station's
 * `ShiftSelection` on local data): the copies this station keeps, read again
 * after every read of the host's list, so the list stays on screen with the
 * host away. One entry at a time; «Сменить оператора» is never held by an
 * entry, so one that never settles does not trap the station here, and an
 * answer that lands after the screen is gone is dropped.
 */
export function ShiftList({
  local,
  pairing,
  lineId,
  operator,
  online,
  shiftReads,
  notice,
  enter,
  onEntered,
  onHostError,
  onNew,
  onSignOut,
}: ShiftListProps) {
  const { t } = useTranslation();
  const { hostId, deviceId } = pairing;
  const [copies, setCopies] = useState<Copies>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [entering, setEntering] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<EntryRefusal | null>(null);
  const alive = useRef(true);
  // The guard of one entry at a time: two presses in one turn both pass a
  // check of `entering`, which only the next render changes.
  const running = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The latest props, for an entry's answer that lands after a render.
  const current = useRef({ online, onEntered, onHostError });
  useLayoutEffect(() => {
    current.current = { online, onEntered, onHostError };
  });

  useEffect(() => {
    let cancelled = false;
    readShiftCopies(local, { hostId, deviceId }, lineId).then(
      (read) => {
        if (!cancelled) setCopies({ kind: "ready", copies: read });
      },
      () => {
        if (!cancelled) setCopies({ kind: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, lineId, shiftReads.done, attempt]);

  const choose = async (copy: ShiftCopy) => {
    if (running.current) return;
    running.current = true;
    setEntering(copy.id);
    setRefusal(null);
    try {
      const result = await enterShift(
        {
          local,
          pairing: { hostId, deviceId },
          online: current.current.online,
          enter,
          now: () => new Date(),
        },
        copy,
      );
      if (!alive.current) return;
      if (result.kind === "entered") {
        current.current.onEntered(result.shift);
        return;
      }
      if (result.kind === "rejected") {
        current.current.onHostError(result.error);
        return;
      }
      setRefusal(result.reason);
      // The host may have changed the shift (closed, opened elsewhere): read again.
      setAttempt((value) => value + 1);
    } finally {
      running.current = false;
      if (alive.current) setEntering(null);
    }
  };

  const busy = entering !== null;
  const body = () => {
    if (copies.kind === "loading") return <p>{t("floor.shifts.loading")}</p>;
    if (copies.kind === "failed") {
      return (
        <Alert
          tone="error"
          action={
            <Button size="floor" variant="secondary" onClick={() => setAttempt((v) => v + 1)}>
              {t("floor.shifts.retry")}
            </Button>
          }
        >
          {t("floor.shifts.readFailed")}
        </Alert>
      );
    }
    if (copies.copies.length === 0) {
      return <p>{t(shiftReads.done === 0 ? "floor.shifts.notRead" : "floor.shifts.empty")}</p>;
    }
    return (
      <div className="shift-list__cards">
        {copies.copies.map((copy) => (
          <ShiftCard
            key={copy.id}
            copy={copy}
            action={cardAction(copy, deviceId, online)}
            busy={busy}
            onAction={() => void choose(copy)}
          />
        ))}
      </div>
    );
  };

  return (
    <Card className="standalone-card shift-list" title={t("floor.shifts.title")} titleAs="h2">
      <div className="standalone-form">
        <p className="floor-sign-in__prompt">
          {t("floor.operator.signedIn", { name: operator.name, login: operator.login })}
        </p>
        <div className="floor-sign-in__message" aria-live="polite">
          {refusal !== null ? (
            <Alert tone="error">{t(`floor.shifts.refused.${refusal}`)}</Alert>
          ) : notice !== null ? (
            <Alert tone="info">{t("floor.shifts.officeClosed", { number: notice.number })}</Alert>
          ) : !online ? (
            <Alert tone="warn">{t("floor.shifts.offline")}</Alert>
          ) : shiftReads.failed ? (
            <Alert tone="warn">{t("floor.shifts.readHostFailed")}</Alert>
          ) : null}
          {busy && <p>{t("floor.shifts.entering")}</p>}
        </div>
        {body()}
        <div className="standalone-form__actions">
          <Button size="floor" disabled={busy || !online} onClick={onNew}>
            {t("floor.shifts.new")}
          </Button>
          {/* Never held by an entry: one that never settles must not trap the station here. */}
          <Button size="floor" variant="secondary" onClick={onSignOut}>
            {t("floor.operator.signOut")}
          </Button>
        </div>
        {!online && <p className="shift-card__hint">{t("floor.shifts.newNeedsLink")}</p>}
      </div>
    </Card>
  );
}
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент:

<!-- prettier-ignore -->
```json
      "stub": "Смены и сканирование продукции появятся в следующем обновлении.",
      "signOut": "Сменить оператора"
    },
    "signIn": {
```

заменить на:

<!-- prettier-ignore -->
```json
      "stub": "Смены и сканирование продукции появятся в следующем обновлении.",
      "signOut": "Сменить оператора"
    },
    "shifts": {
      "title": "Смены линии",
      "loading": "Читаем смены…",
      "readFailed": "Не удалось прочитать смены на этом компьютере.",
      "retry": "Повторить",
      "notRead": "Смены ещё не получены с хоста. Проверьте связь с хостом.",
      "empty": "Открытых смен на линии нет. Создайте смену или дождитесь плана из офиса.",
      "offline": "Нет связи с хостом: показаны смены, полученные раньше. Продолжить можно смену, которую эта станция уже открыла.",
      "readHostFailed": "Список смен не обновился с хоста — показаны полученные раньше.",
      "officeClosed": "Смену {{number}} закрыли в офисе.",
      "entering": "Открываем смену…",
      "productionDate": "Дата производства: {{date}}",
      "plan": "План: {{quantity}}",
      "noPlan": "План не указан",
      "counterparty": "Для: {{name}}",
      "needsLink": "Нужна связь с хостом",
      "new": "Новая смена",
      "newNeedsLink": "Новую смену можно создать только при связи с хостом.",
      "status": {
        "planned": "Не начата",
        "active": "В работе",
        "closing": "Закрывается"
      },
      "mode": {
        "aggregation": "Агрегация",
        "validation": "Проверка"
      },
      "action": {
        "open": "Открыть",
        "continue": "Продолжить",
        "busy": "Занята другой станцией",
        "closing": "Закрывается"
      },
      "refused": {
        "no_link": "Нет связи с хостом. Открыть эту смену можно только при связи с ним.",
        "busy": "Эту смену уже открыла другая станция.",
        "closed": "Смена закрыта.",
        "other_line": "Смена не на линии этой станции.",
        "not_found": "Смены больше нет на хосте: её удалили в офисе.",
        "product_inactive": "Товар смены выключен или в архиве: смену не открыть. Обратитесь в офис.",
        "template_not_fit": "Шаблон этикетки смены выключен или не подходит товару: смену не открыть. Обратитесь в офис.",
        "unreadable": "Этикетку этой смены приложение прочитать не может. Обновите приложение или попросите офис закрыть смену.",
        "local": "Не удалось сохранить смену на этом компьютере. Попробуйте ещё раз.",
        "failed": "Не удалось открыть смену. Попробуйте ещё раз."
      }
    },
    "signIn": {
```

Правка `apps/standalone/src/app/shell.css`:

Фрагмент:

<!-- prettier-ignore -->
```text
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
```

заменить на:

<!-- prettier-ignore -->
```text
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

/* The shifts of the line: cards one under another, each with its 64 px action. */
.shift-list {
  width: min(720px, 100%);
}

.shift-list__cards {
  display: grid;
  gap: 16px;
}

.shift-card {
  display: grid;
  gap: 8px;
  padding: 16px;
}

.shift-card p {
  margin: 0;
}

.shift-card__heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.shift-card__number {
  font: var(--floor-lg);
}

.shift-card__product {
  font: var(--floor-body-strong);
}

.shift-card__facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.shift-card__hint {
  color: var(--fg-2);
}
```

- [ ] **Step 4: Тест проходит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-list.test.tsx`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  21 passed (21)`.

- [ ] **Step 5: Мутации**

Run каждой: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-list.test.tsx`.

1. `apps/standalone/src/floor/shifts/shift-entry.ts`: `    if (error.kind === "transport") return storedWork(context, copy.id);` → `    if (error.kind === "transport") return { kind: "refused", reason: "no_link" };`. Expected: FAIL — «continues from the stored snapshot when the request finds no host though the link said online».
2. Там же: удалить строку `  if (!checkShiftSnapshot(answer.snapshot).ok) return { kind: "refused", reason: "unreadable" };`. Expected: FAIL — «neither keeps nor works a shift whose layout this build does not read».
3. `apps/standalone/src/floor/shifts/ShiftList.tsx`: удалить строку `    if (running.current) return;`. Expected: FAIL — «enters one shift at a time and keeps «Сменить оператора» while an entry hangs».
4. Там же: удалить строку `      if (!alive.current) return;` перед `      if (result.kind === "entered") {`. Expected: FAIL — «drops an entry whose answer lands after the screen is gone».
5. `apps/standalone/src/floor/shifts/ShiftCard.tsx`: `    return { kind: "continue", enabled: online || copy.entered };` → `    return { kind: "continue", enabled: true };`. Expected: FAIL — «does not continue a shift of this station whose snapshot it lost, until the host answers».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/shifts apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/floor-shift-list.test.tsx`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`; verbose-прогон и стенд с задержкой `setImmediate` для `test/floor-shift-list.test.tsx`.
Expected: чисто; `\u04` — только `src/host/pairing-code.ts:66`; verbose без `stderr`; под стендом — те же 21.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/shifts/shift-entry.ts apps/standalone/src/floor/shifts/shift-text.ts apps/standalone/src/floor/shifts/ShiftCard.tsx apps/standalone/src/floor/shifts/ShiftList.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/floor-shift-list.test.tsx
git commit -m "feat(standalone): the floor lists its line's shifts and enters one, with the host or from its stored snapshot" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Новая смена на станции

`src/floor/shifts/new-shift.ts`: `readNewShiftChoices` читает из копий подключения (после `copiesReady`) товары в работе и не в архиве, шаблоны короба, умолчания категорий и организации и часовой пояс организации; `findScannedProduct` — товар по скану (GTIN или GTIN кода маркировки, `classifyScan`; SSCC и прочее — не товар; два товара в работе с одним GTIN — без угадывания); `fittingTemplates` — шаблоны, подходящие группе товара (`templateFitsSlot`); `createStationShift` — `POST /v1/device/shifts` построителем `deviceShiftCreate` и сразу копия (`keepCreatedShift`; сбой записи копии — не отказ: смена хоста придёт со следующим чтением, а вход скажет о сбое записи); отказы хоста словами (`product_inactive`, `shift_line` — «нет линии», `validation_failed` на `boxTemplateId` — шаблон больше не подходит, иное поле — «не принял поля»); `createdCopy` — копия созданной смены для входа.

`NewShift.tsx` (облачная `NewShift` без облачных частей): шаг товара — скан или поиск по названию (от двух букв, не больше пяти результатов), поле имени забирает клавиатуру у сканера на время фокуса, а при исчезновении поля без потери фокуса сканер возвращается (как поиск оператора плана 1f2); шаг формы — шаблон по правилу решения 7 (`suggestBoxTemplate`), выбор кнопками только если правило не выбрало, а подходящих несколько, предупреждение, если не подходит ни один; дата производства — сегодня по часовому поясу организации (`civilToday`; неизвестный пояс — дата ПК с подписью), меняется кнопками «На день раньше» / «На день позже» (`addCivilDays`); план необязателен (`plannedQtyRule`), вместимость из товара (`shiftBoxCapacityRule`); «Создать и открыть» выключена без связи и без шаблона. Один `requestId` на форму (выбор товара), он переживает повторы; одна отправка за раз; «Назад» не держится запросом; ответ после размонтирования отбрасывается. Созданная смена сразу открывается (`enterShift`, задача 5); отказ во входе — «Смена … создана, но не открыта.» и причина словами.

**Files:**

- Create: `apps/standalone/src/floor/shifts/new-shift.ts`, `apps/standalone/src/floor/shifts/NewShift.tsx`
- Modify: `apps/standalone/src/floor/shifts/shift-text.ts`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`
- Test: `apps/standalone/test/floor-new-shift.test.tsx`, `apps/standalone/test/floor-shift-text.test.ts` (Create)

**Interfaces:**

- Consumes: `keepCreatedShift`, `ShiftCopy`, `WorkShift` (задача 3); `enterShift`, `EntryRefusal`, `formatCivilDate` (задача 5); `deviceShiftCreate`, `DeviceShiftInput`, `DeviceShift`, `DeviceShiftCreate`, `EnteredShift` (задача 2); `shellActionFor` (задача 4); `suggestBoxTemplate`, `BoxTemplateCandidate`, `BoxTemplateDefaults` (`src/lib/box-template-choice.ts`, план 2a3); `civilToday`, `isKnownTimeZone` (`src/lib/civil-date.ts`, план 2a3); `plannedQtyRule`, `shiftBoxCapacityRule`, `toCount` (`src/lib/rules.ts`); `templateFitsSlot`; `copiesReady`; `ScanSource` (`src/floor/scan-source.ts`); `classifyScan` (`@markiro/domain`).
- Produces:
  - `new-shift.ts`: `interface ShiftProduct`, `interface ShiftTemplate`, `interface NewShiftChoices`, `readNewShiftChoices(local, pairing): Promise<NewShiftChoices | null>`, `type ProductScan`, `findScannedProduct(products, raw)`, `fittingTemplates(product, templates)`, `type CreateRefusal`, `type CreateResult`, `interface CreateContext { local; pairing; create; now }`, `createStationShift(context, input): Promise<CreateResult>`, `createdCopy(shift: DeviceShift): ShiftCopy`;
  - `NewShift.tsx`: `interface NewShiftProps { local; pairing; online; source; create; enter; onEntered; onHostError; onBack; newRequestId?; now? }`, `NewShift`;
  - `shift-text.ts`: `addCivilDays(date, days): string`;
  - ключи `floor.newShift.*`; классы `new-shift__choice`, `new-shift__date`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-new-shift.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { readFileSync } from "node:fs";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import type { WorkShift } from "../src/floor/shifts/shift-copies.js";
import { readShiftCopy } from "../src/floor/shifts/shift-copies.js";
import { NewShift } from "../src/floor/shifts/NewShift.js";
import { HostError } from "../src/host/client.js";
import {
  deviceShiftsSchema,
  enteredShiftSchema,
  type ChangeItem,
  type ChangesResponse,
  type DeviceShift,
  type DeviceShiftCreate,
  type EnteredShift,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const CATALOG = (fixture("changes-catalog.json") as ChangesResponse).items;
const MILK = "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b";
const MILK_TEMPLATE = "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d";
const REQUEST_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
/** The id a second form (or a second draw for the same form) would get. */
const NEXT_REQUEST_ID = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
const [, PLANNED] = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts as [
  DeviceShift,
  DeviceShift,
];
const ENTERED: EnteredShift = enteredShiftSchema.parse(fixture("device-shift-entered.json"));
const OPENED: EnteredShift = {
  ...ENTERED,
  id: PLANNED.id,
  number: PLANNED.number,
  createdFrom: "station",
  productionDate: "2026-10-09",
  plannedQty: null,
};
/** 9 October 2026, 22:30 UTC: already 10 October in Moscow, the organization's zone. */
const NOW = new Date("2026-10-09T22:30:00Z");
const KM = "0104600682000013215abcde\u001d93AbCd";
const SSCC = "046006820000000013";

function item(entity: string, id: string, rev: number, data: unknown): ChangeItem {
  return { entity, id, rev, deleted: false, data };
}

async function copiesOf(items: ChangeItem[]): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev: 100, hasMore: false, items }),
    local: executor,
    ...PAIRING,
  });
  return executor;
}

/** A scanner the test reads into, and what the screen asked of it. */
function fakeSource() {
  let listener: ScanListener | null = null;
  const manual = vi.fn<(active: boolean) => void>();
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    clearPendingInput: () => undefined,
    setManualTextEntryActive: manual,
  };
  return {
    source,
    manual,
    listening: () => listener !== null,
    read: (raw: string) =>
      act(() => {
        listener?.(raw);
      }),
  };
}

interface Options {
  online?: boolean;
  create?: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  enter?: (id: string) => Promise<EnteredShift>;
}

function renderNew(local: LocalExecutor, options: Options = {}) {
  const scanner = fakeSource();
  const ids = [REQUEST_ID, NEXT_REQUEST_ID];
  let drawn = 0;
  const handlers = {
    create: vi.fn(options.create ?? (async () => PLANNED)),
    enter: vi.fn(options.enter ?? (async () => OPENED)),
    onEntered: vi.fn<(shift: WorkShift) => void>(),
    onHostError: vi.fn<(error: unknown) => void>(),
    onBack: vi.fn(),
  };
  const view = render(
    <ThemeProvider>
      <NewShift
        local={local}
        pairing={PAIRING}
        online={options.online ?? true}
        source={scanner.source}
        create={handlers.create}
        enter={handlers.enter}
        onEntered={handlers.onEntered}
        onHostError={handlers.onHostError}
        onBack={handlers.onBack}
        newRequestId={() => ids[drawn++] ?? "00000000-0000-4000-8000-000000000000"}
        now={() => NOW}
      />
    </ThemeProvider>,
  );
  return { scanner, handlers, view };
}

async function chooseMilk(): Promise<void> {
  fireEvent.change(await screen.findByLabelText("Название товара"), {
    target: { value: "мол" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Молоко 3,2% 0,9 л — 04600682000013" }));
  await screen.findByText("Молоко 3,2% 0,9 л, GTIN 04600682000013");
}

const CREATED_BODY: DeviceShiftCreate = {
  requestId: REQUEST_ID,
  productId: MILK,
  boxTemplateId: MILK_TEMPLATE,
  productionDate: "2026-10-10",
  boxCapacity: 12,
  plannedQty: null,
  counterpartyId: null,
};

describe("a new shift on the station", () => {
  it("finds a product in use by its name and starts from its template, today and its capacity", async () => {
    renderNew(await copiesOf(CATALOG));
    fireEvent.change(await screen.findByLabelText("Название товара"), { target: { value: "к" } });
    // One letter finds nothing yet, and the archived draft never shows.
    expect(screen.queryByRole("button", { name: /Кефир/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Название товара"), { target: { value: "кеф" } });
    expect(
      await screen.findByText("Ничего не нашли. Проверьте название или отсканируйте товар."),
    ).toBeTruthy();
    await chooseMilk();
    // The product's own template fits its group, so the rule picks it.
    expect(screen.getByText("Шаблон этикетки короба: Молоко 58×40")).toBeTruthy();
    expect(screen.getByText("Дата производства: 10.10.2026")).toBeTruthy();
    expect(screen.getByLabelText("В коробе, шт.")).toHaveProperty("value", "12");
    expect(screen.getByLabelText("План, шт.")).toHaveProperty("value", "");
  });

  it("chooses the product a scan names, by its barcode or its code of marking", async () => {
    const local = await copiesOf(CATALOG);
    for (const raw of ["4600682000013", KM]) {
      const { scanner, view } = renderNew(local);
      // The scanner listens once the screen's effect has run, after the field shows.
      await waitFor(() => expect(scanner.listening()).toBe(true));
      scanner.read(raw);
      expect(await screen.findByText("Молоко 3,2% 0,9 л, GTIN 04600682000013")).toBeTruthy();
      // The scanner listens on the first step only.
      expect(scanner.listening()).toBe(false);
      view.unmount();
    }
  });

  it("says what a scan that names no product in use was", async () => {
    const { scanner } = renderNew(await copiesOf(CATALOG));
    await waitFor(() => expect(scanner.listening()).toBe(true));
    scanner.read(SSCC);
    expect(
      await screen.findByText(
        "Это не код товара. Отсканируйте штрихкод товара или код маркировки.",
      ),
    ).toBeTruthy();
    scanner.read("04600682000020");
    expect(
      await screen.findByText(
        "Товара с GTIN 04600682000020 нет среди товаров в работе. Проверьте товар в офисе.",
      ),
    ).toBeTruthy();
  });

  it("does not guess between two products in use with one GTIN", async () => {
    const twin = item("products", "6b5a4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d", 101, {
      gtin14: "04600682000013",
      name: "Молоко 3,2% 0,9 л (акция)",
      printName: null,
      chzProductGroupCode: 8,
      boxCapacity: 12,
      palletBoxCapacity: null,
      shelfLifeDays: 10,
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: null,
      archived: false,
      status: "active",
    });
    const { scanner } = renderNew(await copiesOf([...CATALOG, twin]));
    await waitFor(() => expect(scanner.listening()).toBe(true));
    scanner.read("04600682000013");
    expect(
      await screen.findByText(
        "GTIN 04600682000013 есть у нескольких товаров в работе. Выберите товар по названию.",
      ),
    ).toBeTruthy();
  });

  it("creates the shift with the host and enters it at once", async () => {
    const local = await copiesOf(CATALOG);
    const { handlers } = renderNew(local);
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls).toEqual([[CREATED_BODY]]);
    expect(handlers.enter.mock.calls).toEqual([[PLANNED.id]]);
    expect(handlers.onEntered.mock.calls[0]?.[0]).toMatchObject({
      copy: { id: PLANNED.id, entered: true },
      snapshot: { issuerPrefix: "460068200" },
    });
    expect(await readShiftCopy(local, PAIRING, PLANNED.id)).toMatchObject({ entered: true });
  });

  it("sends the plan, the capacity and another day as the operator set them", async () => {
    const { handlers } = renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "На день раньше" }));
    fireEvent.click(screen.getByRole("button", { name: "На день раньше" }));
    fireEvent.click(screen.getByRole("button", { name: "На день позже" }));
    expect(screen.getByText("Дата производства: 09.10.2026")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: " 1200 " } });
    fireEvent.change(screen.getByLabelText("В коробе, шт."), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toEqual({
      ...CREATED_BODY,
      productionDate: "2026-10-09",
      plannedQty: 1200,
      boxCapacity: 6,
    });
  });

  it("checks the plan and the capacity before it asks the host", async () => {
    const { handlers } = renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("В коробе, шт."), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    expect(
      await screen.findByText("Укажите целое число от 1 до 10 000 000 или оставьте пустым"),
    ).toBeTruthy();
    expect(screen.getByText("Укажите целое число от 1 до 100 000")).toBeTruthy();
    expect(handlers.create).not.toHaveBeenCalled();
  });

  it("asks the operator to choose when the rule leaves several templates, and creates none without one", async () => {
    const org = CATALOG.find((each) => each.entity === "org_profile");
    const items = [
      ...CATALOG.filter((each) => each.entity !== "org_profile"),
      item("org_profile", "1", 102, {
        ...(org?.data as Record<string, unknown>),
        defaultBoxTemplateId: null,
      }),
      item("products", "6b5a4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d", 103, {
        gtin14: "04600682000037",
        name: "Сметана 20%",
        printName: null,
        chzProductGroupCode: 15,
        boxCapacity: 20,
        palletBoxCapacity: null,
        shelfLifeDays: 14,
        defaultBoxTemplateId: null,
        defaultPalletTemplateId: null,
        archived: false,
        status: "active",
      }),
      item("label_templates", "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1b", 104, {
        name: "Короб 100×150",
        purpose: "box",
        enabled: true,
        chzProductGroupCodes: null,
        stock: false,
        spec: { widthMm: 100, heightMm: 150, dpi: 203, language: "zpl", elements: [] },
      }),
    ];
    const { handlers } = renderNew(await copiesOf(items));
    fireEvent.change(await screen.findByLabelText("Название товара"), {
      target: { value: "смет" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сметана 20% — 04600682000037" }));
    expect(await screen.findByText("Выберите шаблон этикетки короба.")).toBeTruthy();
    const create = screen.getByRole("button", { name: "Создать и открыть" });
    expect(create).toHaveProperty("disabled", true);
    const group = screen.getByRole("group", { name: "Шаблон этикетки короба" });
    fireEvent.click(within(group).getByRole("button", { name: "Короб 100×150" }));
    expect(within(group).getByRole("button", { name: "Короб 100×150" })).toHaveProperty(
      "ariaPressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toMatchObject({
      boxTemplateId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1b",
      boxCapacity: 20,
    });
  });

  it("says so when no box template fits the product", async () => {
    const items = CATALOG.filter(
      (each) => each.entity !== "label_templates" || each.id === MILK_TEMPLATE,
    ).map((each) =>
      each.entity === "label_templates"
        ? { ...each, data: { ...(each.data as Record<string, unknown>), enabled: false } }
        : each,
    );
    renderNew(await copiesOf(items));
    await chooseMilk();
    expect(
      screen.getByText(
        "Для этого товара нет подходящего шаблона этикетки короба. Шаблоны настраивают в офисе.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Создать и открыть" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("creates nothing without the host, and says why", async () => {
    renderNew(await copiesOf(CATALOG), { online: false });
    await chooseMilk();
    expect(screen.getByRole("button", { name: "Создать и открыть" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText("Создать смену можно только при связи с хостом.")).toBeTruthy();
  });

  it.each([
    [
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
      "Нет связи с хостом. Создать смену можно только при связи с ним.",
    ],
    [
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "no",
        details: { constraint: "product_inactive" },
      }),
      "Товар выключен или в архиве: смену не создать. Обратитесь в офис.",
    ],
    [
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "no",
        details: { field: "boxTemplateId" },
      }),
      "Шаблон этикетки больше не подходит товару. Выберите другой шаблон или обратитесь в офис.",
    ],
  ])("says why the host did not create the shift: %s", async (error, text) => {
    const { handlers } = renderNew(await copiesOf(CATALOG), {
      create: async () => Promise.reject(error),
    });
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(handlers.enter).not.toHaveBeenCalled();
  });

  it("repeats the same request after a failure, so a lost answer makes no second shift", async () => {
    const down = new HostError({ kind: "transport", code: "timeout", message: "slow" });
    const create = vi
      .fn<(create: DeviceShiftCreate) => Promise<DeviceShift>>()
      .mockRejectedValueOnce(down)
      .mockResolvedValue(PLANNED);
    const { handlers } = renderNew(await copiesOf(CATALOG), { create });
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await screen.findByText("Нет связи с хостом. Создать смену можно только при связи с ним.");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Создать и открыть" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(create.mock.calls.map(([body]) => body.requestId)).toEqual([REQUEST_ID, REQUEST_ID]);
  });

  it("says the shift was created but not opened when the entry is refused", async () => {
    const busy = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "no",
      details: { constraint: "shift_busy" },
    });
    renderNew(await copiesOf(CATALOG), { enter: async () => Promise.reject(busy) });
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    expect(
      await screen.findByText(
        "Смена OCT26-005/S создана, но не открыта. Эту смену уже открыла другая станция.",
      ),
    ).toBeTruthy();
  });

  it("hands a refused device key to the shell", async () => {
    const rejected = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    const { handlers } = renderNew(await copiesOf(CATALOG), {
      create: async () => Promise.reject(rejected),
    });
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.onHostError).toHaveBeenCalledWith(rejected));
  });

  it("sends one request at a time, and «Назад» is never held by one", async () => {
    let answer: (shift: DeviceShift) => void = () => undefined;
    const create = vi.fn(
      () =>
        new Promise<DeviceShift>((resolve) => {
          answer = resolve;
        }),
    );
    const { handlers } = renderNew(await copiesOf(CATALOG), { create });
    await chooseMilk();
    const button = screen.getByRole("button", { name: "Создать и открыть" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Создаём смену…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer(PLANNED);
    });
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
  });

  it("takes no scan while the name is typed, and gives the scanner back when the step goes", async () => {
    const { scanner } = renderNew(await copiesOf(CATALOG));
    const field = await screen.findByLabelText("Название товара");
    fireEvent.focus(field);
    expect(scanner.manual.mock.calls).toEqual([[true]]);
    fireEvent.change(field, { target: { value: "мол" } });
    // Choosing a result takes the field away without a blur.
    fireEvent.click(screen.getByRole("button", { name: "Молоко 3,2% 0,9 л — 04600682000013" }));
    await screen.findByText("Молоко 3,2% 0,9 л, GTIN 04600682000013");
    expect(scanner.manual.mock.calls.at(-1)).toEqual([false]);
  });

  it("explains copies that are not ready and a read that failed", async () => {
    const { executor } = openLocalDb();
    const first = renderNew(executor);
    expect(
      await screen.findByText(
        "Справочники ещё не загружены с хоста. Создать смену можно после синхронизации.",
      ),
    ).toBeTruthy();
    first.view.unmount();
    const failing: LocalExecutor = {
      query: () => Promise.reject(new Error("disk")),
      transaction: () => Promise.reject(new Error("disk")),
    };
    renderNew(failing);
    expect(
      await screen.findByText("Не удалось прочитать справочники на этом компьютере."),
    ).toBeTruthy();
  });

  it("keeps every button at the floor's 64 px", async () => {
    const { view } = renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    const buttons = view.container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(3);
    for (const button of buttons) expect(button.className).toContain("mk-btn--floor");
  });
});
```

Создать `apps/standalone/test/floor-shift-text.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import { addCivilDays, formatCivilDate, formatQuantity } from "../src/floor/shifts/shift-text.js";

describe("the floor's words for dates and counts", () => {
  it("shows a civil date day first, as written, never through a clock", () => {
    expect(formatCivilDate("2026-10-09")).toBe("09.10.2026");
    expect(formatCivilDate("0099-01-02")).toBe("02.01.0099");
  });

  it("moves a civil date by whole days over months, years and a leap day", () => {
    expect(addCivilDays("2026-10-09", 1)).toBe("2026-10-10");
    expect(addCivilDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addCivilDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCivilDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addCivilDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addCivilDays("2100-02-28", 1)).toBe("2100-03-01");
    // `Date.UTC` would take the year 99 for 1999.
    expect(addCivilDays("0099-12-31", 1)).toBe("0100-01-01");
  });

  it("parts the thousands of a count with a no-break space", () => {
    expect(formatQuantity(1200)).toBe("1\u00a0200");
    expect(formatQuantity(12)).toBe("12");
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-new-shift.test.tsx test/floor-shift-text.test.ts`
Expected: FAIL — `Failed to resolve import "../src/floor/shifts/NewShift.js"` и «moves a civil date by whole days over months, years and a leap day» (`addCivilDays is not a function`).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/floor/shifts/shift-text.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
  return QUANTITY.format(quantity);
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  return QUANTITY.format(quantity);
}

/**
 * The civil date `days` after `date` (before it, for a negative count), by
 * the calendar alone, never by a clock or a zone. `Date.UTC` would read the
 * years 0–99 as 1900–1999; `setUTCFullYear` does not.
 */
export function addCivilDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return date;
  const moment = new Date(0);
  moment.setUTCFullYear(year, month - 1, day + days);
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return `${pad(moment.getUTCFullYear(), 4)}-${pad(moment.getUTCMonth() + 1, 2)}-${pad(moment.getUTCDate(), 2)}`;
}
```

Создать `apps/standalone/src/floor/shifts/new-shift.ts`:

<!-- prettier-ignore -->
```ts
import { classifyScan } from "@markiro/domain";
import { z } from "zod";

import { shellActionFor } from "../../app/shell.js";
import { HostError } from "../../host/client.js";
import type { DeviceShift, DeviceShiftCreate } from "../../host/protocol.js";
import { deviceShiftCreate, type DeviceShiftInput } from "../../host/requests.js";
import type { BoxTemplateCandidate, BoxTemplateDefaults } from "../../lib/box-template-choice.js";
import { templateFitsSlot } from "../../lib/template-eligibility.js";
import type { LocalExecutor } from "../../local/executor.js";
import { copiesReady, type Pairing } from "../../local/reference-sync.js";
import { keepCreatedShift, type ShiftCopy } from "./shift-copies.js";

/** A product a station may start a shift of: in use (`active`) and not archived. */
export interface ShiftProduct {
  id: string;
  gtin14: string;
  name: string;
  chzProductGroupCode: number | null;
  boxCapacity: number | null;
  defaultBoxTemplateId: string | null;
}

/** A box template of the copies, with what decides whether it fits. */
export interface ShiftTemplate extends BoxTemplateCandidate {
  name: string;
}

/** What a new shift is chosen from: the copies of products, templates and defaults, and the site's zone. */
export interface NewShiftChoices {
  products: ShiftProduct[];
  templates: ShiftTemplate[];
  defaults: BoxTemplateDefaults;
  timeZone: string | null;
}

const productRow = z.object({
  id: z.string(),
  gtin14: z.string(),
  name: z.string(),
  chz_group_code: z.number().nullable(),
  box_capacity: z.number().nullable(),
  default_box_template_id: z.string().nullable(),
});
const templateRow = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.enum(["box", "pallet", "product_duplicate"]),
  enabled: z.number(),
  category_codes: z.string().nullable(),
});
const defaultRow = z.object({
  chz_group_code: z.number(),
  purpose: z.string(),
  template_id: z.string(),
});
const orgRow = z.object({
  time_zone: z.string(),
  default_box_template_id: z.string().nullable(),
});
const codesSchema = z.array(z.number().int());

/**
 * What a new shift is chosen from, out of this pairing's copies once a sync
 * has begun to fill them (`copiesReady`); `null` before that. Products in use
 * and not archived only, by name; box templates only (the rule of decision 7
 * reads them, `suggestBoxTemplate`), by name.
 */
export async function readNewShiftChoices(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<NewShiftChoices | null> {
  if (!(await copiesReady(local, pairing))) return null;
  const products = await local.query(
    "SELECT id, gtin14, name, chz_group_code, box_capacity, default_box_template_id " +
      "FROM ref_products WHERE status = 'active' AND archived = 0 ORDER BY name, id",
    [],
    productRow,
  );
  const templates = await local.query(
    "SELECT id, name, purpose, enabled, category_codes FROM ref_templates " +
      "WHERE purpose = 'box' ORDER BY name, id",
    [],
    templateRow,
  );
  const categories = await local.query(
    "SELECT chz_group_code, purpose, template_id FROM ref_template_defaults",
    [],
    defaultRow,
  );
  const [org] = await local.query(
    "SELECT time_zone, default_box_template_id FROM ref_org",
    [],
    orgRow,
  );
  return {
    products: products.map((row) => ({
      id: row.id,
      gtin14: row.gtin14,
      name: row.name,
      chzProductGroupCode: row.chz_group_code,
      boxCapacity: row.box_capacity,
      defaultBoxTemplateId: row.default_box_template_id,
    })),
    templates: templates.map((row) => ({
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      enabled: row.enabled === 1,
      chzProductGroupCodes:
        row.category_codes === null ? null : codesSchema.parse(JSON.parse(row.category_codes)),
    })),
    defaults: {
      defaultBoxTemplateId: org?.default_box_template_id ?? null,
      categories: categories.map((row) => ({
        chzProductGroupCode: row.chz_group_code,
        purpose: row.purpose,
        templateId: row.template_id,
      })),
    },
    timeZone: org?.time_zone ?? null,
  };
}

/** What a scan on the product step found. */
export type ProductScan =
  | { kind: "found"; product: ShiftProduct }
  | { kind: "not_found"; gtin14: string }
  | { kind: "ambiguous"; gtin14: string }
  | { kind: "not_product" };

/**
 * The product a scan names (stage 2a spec §5.7.2): its GTIN, or the GTIN of a
 * code of marking (`classifyScan`), among the products in use. An SSCC or
 * anything else is no product; a GTIN two products in use share is not
 * guessed between.
 */
export function findScannedProduct(products: readonly ShiftProduct[], raw: string): ProductScan {
  const scan = classifyScan(raw);
  const gtin14 = scan.kind === "gtin" ? scan.gtin14 : scan.kind === "km" ? scan.km.gtin14 : null;
  if (gtin14 === null) return { kind: "not_product" };
  const found = products.filter((product) => product.gtin14 === gtin14);
  const [product] = found;
  if (product === undefined) return { kind: "not_found", gtin14 };
  if (found.length > 1) return { kind: "ambiguous", gtin14 };
  return { kind: "found", product };
}

/** The box templates that fit `product`'s group (`templates::fits`), in the copies' order. */
export function fittingTemplates(
  product: ShiftProduct,
  templates: readonly ShiftTemplate[],
): ShiftTemplate[] {
  return templates.filter((template) =>
    templateFitsSlot(template, {
      purpose: "box",
      chzProductGroupCode: product.chzProductGroupCode,
    }),
  );
}

/**
 * Why the host did not create the shift: no answer (`no_link`), the product
 * was turned off or archived since the copies (`product_inactive`), the
 * template no longer fits it (`template`), another field it refused
 * (`invalid`), the station has no line (`no_line`), or anything else
 * (`failed`).
 */
export type CreateRefusal =
  "no_link" | "product_inactive" | "template" | "invalid" | "no_line" | "failed";

export type CreateResult =
  | { kind: "created"; shift: DeviceShift }
  | { kind: "refused"; reason: CreateRefusal }
  | { kind: "rejected"; error: unknown };

export interface CreateContext {
  local: LocalExecutor;
  pairing: Pairing;
  /** `HostApi.createDeviceShift`. */
  create: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  now: () => number;
}

/**
 * Creates the shift on the host (`POST /v1/device/shifts`) and keeps it with
 * the copies at once. The same `requestId` again answers the same shift, so a
 * retry after a lost answer makes no second one (and the answer is that first
 * shift, whatever the form says now). A copy this computer fails to keep is no
 * refusal: the shift is the host's, the next read of the list brings it, and
 * the entry that follows says so if this computer cannot write.
 */
export async function createStationShift(
  context: CreateContext,
  input: DeviceShiftInput,
): Promise<CreateResult> {
  let shift: DeviceShift;
  try {
    shift = await context.create(deviceShiftCreate(input));
  } catch (error) {
    if (shellActionFor(error, null) !== null) return { kind: "rejected", error };
    if (!(error instanceof HostError)) return { kind: "refused", reason: "failed" };
    if (error.kind === "transport") return { kind: "refused", reason: "no_link" };
    if (error.code === "conflict") {
      const constraint = error.details["constraint"];
      if (constraint === "product_inactive") return { kind: "refused", reason: "product_inactive" };
      if (constraint === "shift_line") return { kind: "refused", reason: "no_line" };
      return { kind: "refused", reason: "failed" };
    }
    if (error.code === "validation_failed") {
      return { kind: "refused", reason: error.field === "boxTemplateId" ? "template" : "invalid" };
    }
    return { kind: "refused", reason: "failed" };
  }
  await keepCreatedShift(context.local, context.pairing, shift, context.now()).catch(
    () => undefined,
  );
  return { kind: "created", shift };
}

/** The copy of a shift the station has just created, to enter it at once. */
export function createdCopy(shift: DeviceShift): ShiftCopy {
  return { ...shift, localState: null, entered: false };
}
```

Создать `apps/standalone/src/floor/shifts/NewShift.tsx`:

<!-- prettier-ignore -->
```tsx
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Input } from "@markiro/ui";

import type { DeviceShift, DeviceShiftCreate, EnteredShift } from "../../host/protocol.js";
import { suggestBoxTemplate } from "../../lib/box-template-choice.js";
import { civilToday, isKnownTimeZone } from "../../lib/civil-date.js";
import { plannedQtyRule, shiftBoxCapacityRule, toCount } from "../../lib/rules.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { ScanSource } from "../scan-source.js";
import {
  createdCopy,
  createStationShift,
  findScannedProduct,
  fittingTemplates,
  readNewShiftChoices,
  type CreateRefusal,
  type NewShiftChoices,
  type ShiftProduct,
} from "./new-shift.js";
import type { WorkShift } from "./shift-copies.js";
import { enterShift, type EntryRefusal } from "./shift-entry.js";
import { addCivilDays, formatCivilDate } from "./shift-text.js";

/** At most this many products answer a search by name. */
const RESULTS = 5;
/** A search starts at two letters, as the operator search does. */
const MIN_QUERY_LETTERS = 2;

export interface NewShiftProps {
  local: LocalExecutor;
  pairing: Pairing;
  online: boolean;
  /** The scanner of the floor: a product is chosen by its barcode or code of marking. */
  source: ScanSource;
  /** `HostApi.createDeviceShift`. */
  create: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  /** `HostApi.enterShift`. */
  enter: (shiftId: string) => Promise<EnteredShift>;
  onEntered: (shift: WorkShift) => void;
  /** A refused key or a changed certificate: the shell's to route. */
  onHostError: (error: unknown) => void;
  onBack: () => void;
  /** A new request id per form; tests give their own. */
  newRequestId?: () => string;
  /** This computer's clock; tests give their own. */
  now?: () => Date;
}

type Choices =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "not_ready" }
  | { kind: "ready"; choices: NewShiftChoices };

interface Form {
  product: ShiftProduct;
  requestId: string;
  templateId: string | null;
  /** The rule chose the template, or only one fits: nothing to choose. */
  templateFixed: boolean;
  productionDate: string;
  plannedQty: string;
  boxCapacity: string;
}

type Problem =
  | { kind: "scan"; key: string; gtin: string | null }
  | { kind: "create"; reason: CreateRefusal }
  | { kind: "enter"; number: string; reason: EntryRefusal };

type Step = { kind: "product" } | { kind: "form"; form: Form };

function letters(text: string): number {
  return Array.from(text).filter((character) => /\p{L}/u.test(character)).length;
}

/**
 * A shift created on the station (stage 2a spec §5.7.2, the cloud station's
 * `NewShift` without its cloud parts): the product by its barcode or code of
 * marking, or by name, among the products in use; the box template by the
 * rule of decision 7 (`suggestBoxTemplate`), chosen by the operator when the
 * rule leaves several; the production date, today in the organization's
 * zone; the plan, optional; the capacity from the product. It needs the host:
 * the host numbers the shift, then the station enters it at once. One
 * request id per form, kept through retries, so a retry after a lost answer
 * makes no second shift.
 */
export function NewShift({
  local,
  pairing,
  online,
  source,
  create,
  enter,
  onEntered,
  onHostError,
  onBack,
  newRequestId = () => crypto.randomUUID(),
  now = () => new Date(),
}: NewShiftProps) {
  const { t } = useTranslation();
  const { hostId, deviceId } = pairing;
  const [choices, setChoices] = useState<Choices>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [step, setStep] = useState<Step>({ kind: "product" });
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [errors, setErrors] = useState<{ plannedQty?: string; boxCapacity?: string }>({});
  const [busy, setBusy] = useState<"creating" | "entering" | null>(null);
  const running = useRef(false);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The latest props, for answers that land later and for the scanner's
  // listener, which is not restarted (and its keys dropped) on every render.
  const current = useRef({ online, onEntered, onHostError, newRequestId, now });
  useLayoutEffect(() => {
    current.current = { online, onEntered, onHostError, newRequestId, now };
  });

  useEffect(() => {
    let cancelled = false;
    readNewShiftChoices(local, { hostId, deviceId }).then(
      (read) => {
        if (!cancelled)
          setChoices(read === null ? { kind: "not_ready" } : { kind: "ready", choices: read });
      },
      () => {
        if (!cancelled) setChoices({ kind: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, attempt]);

  const ready = choices.kind === "ready" ? choices.choices : null;
  const choose = useCallback(
    (product: ShiftProduct) => {
      if (ready === null) return;
      const fitting = fittingTemplates(product, ready.templates);
      const suggested = suggestBoxTemplate(product, ready.templates, ready.defaults);
      const [only] = fitting;
      const fixed = suggested ?? (fitting.length === 1 && only !== undefined ? only.id : null);
      setProblem(null);
      setErrors({});
      setStep({
        kind: "form",
        form: {
          product,
          requestId: current.current.newRequestId(),
          templateId: fixed,
          templateFixed: fixed !== null,
          productionDate: civilToday(ready.timeZone, current.current.now()),
          plannedQty: "",
          boxCapacity: product.boxCapacity === null ? "" : String(product.boxCapacity),
        },
      });
    },
    [ready],
  );

  // The scanner chooses the product on the first step.
  const onProductStep = step.kind === "product";
  useEffect(() => {
    if (!onProductStep || ready === null) return;
    return source.start((raw) => {
      const found = findScannedProduct(ready.products, raw);
      if (found.kind === "found") {
        choose(found.product);
        return;
      }
      setProblem({
        kind: "scan",
        key: found.kind,
        gtin: found.kind === "not_product" ? null : found.gtin14,
      });
    });
  }, [onProductStep, ready, source, choose]);
  // Typing a name takes no scan; the scanner is given back when the field
  // goes, whatever made it go.
  useLayoutEffect(() => {
    if (!onProductStep) return;
    return () => source.setManualTextEntryActive(false);
  }, [onProductStep, source]);

  const update = (change: Partial<Form>) =>
    setStep((previous) =>
      previous.kind === "form" ? { kind: "form", form: { ...previous.form, ...change } } : previous,
    );

  const submit = async (form: Form) => {
    if (running.current || form.templateId === null) return;
    const plan = plannedQtyRule.safeParse(form.plannedQty);
    const capacity = shiftBoxCapacityRule.safeParse(form.boxCapacity);
    if (!plan.success || !capacity.success) {
      setErrors({
        ...(plan.success ? {} : { plannedQty: t("rules.plannedQty") }),
        ...(capacity.success ? {} : { boxCapacity: t("rules.shiftBoxCapacity") }),
      });
      return;
    }
    setErrors({});
    running.current = true;
    setBusy("creating");
    setProblem(null);
    try {
      const created = await createStationShift(
        {
          local,
          pairing: { hostId, deviceId },
          create,
          now: () => current.current.now().getTime(),
        },
        {
          requestId: form.requestId,
          productId: form.product.id,
          boxTemplateId: form.templateId,
          productionDate: form.productionDate,
          boxCapacity: toCount(capacity.data) ?? 0,
          plannedQty: toCount(plan.data),
        },
      );
      if (!alive.current) return;
      if (created.kind === "rejected") {
        current.current.onHostError(created.error);
        return;
      }
      if (created.kind === "refused") {
        setProblem({ kind: "create", reason: created.reason });
        return;
      }
      setBusy("entering");
      const entry = await enterShift(
        {
          local,
          pairing: { hostId, deviceId },
          online: current.current.online,
          enter,
          now: () => current.current.now(),
        },
        createdCopy(created.shift),
      );
      if (!alive.current) return;
      if (entry.kind === "entered") {
        current.current.onEntered(entry.shift);
        return;
      }
      if (entry.kind === "rejected") {
        current.current.onHostError(entry.error);
        return;
      }
      setProblem({ kind: "enter", number: created.shift.number, reason: entry.reason });
    } finally {
      running.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const problemText = (shown: Problem): string => {
    switch (shown.kind) {
      case "scan":
        return t(`floor.newShift.scan.${shown.key}`, { gtin: shown.gtin ?? "" });
      case "create":
        return t(`floor.newShift.refused.${shown.reason}`);
      case "enter":
        return `${t("floor.newShift.notEntered", { number: shown.number })} ${t(
          `floor.shifts.refused.${shown.reason}`,
        )}`;
    }
  };

  const productStep = () => {
    if (choices.kind === "loading") return <p>{t("floor.newShift.loading")}</p>;
    if (choices.kind === "failed") {
      return (
        <Alert
          tone="error"
          action={
            <Button size="floor" variant="secondary" onClick={() => setAttempt((v) => v + 1)}>
              {t("floor.newShift.retry")}
            </Button>
          }
        >
          {t("floor.newShift.readFailed")}
        </Alert>
      );
    }
    if (choices.kind === "not_ready")
      return <Alert tone="warn">{t("floor.newShift.notReady")}</Alert>;
    if (choices.choices.products.length === 0) {
      return <Alert tone="warn">{t("floor.newShift.noProducts")}</Alert>;
    }
    const needle = query.trim().toLocaleLowerCase("ru");
    const found =
      letters(needle) < MIN_QUERY_LETTERS
        ? []
        : choices.choices.products
            .filter((product) => product.name.toLocaleLowerCase("ru").includes(needle))
            .slice(0, RESULTS);
    return (
      <>
        <p className="floor-sign-in__prompt">{t("floor.newShift.productPrompt")}</p>
        <Input
          size="floor"
          label={t("floor.newShift.searchLabel")}
          hint={t("floor.newShift.searchHint")}
          value={query}
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          onFocus={() => source.setManualTextEntryActive(true)}
          onBlur={() => source.setManualTextEntryActive(false)}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <div className="floor-sign-in__results" aria-live="polite">
          {letters(needle) >= MIN_QUERY_LETTERS && found.length === 0 ? (
            <p>{t("floor.newShift.searchEmpty")}</p>
          ) : (
            found.map((product) => (
              <Button
                key={product.id}
                size="floor"
                variant="secondary"
                fullWidth
                onClick={() => choose(product)}
              >
                {t("floor.newShift.result", { name: product.name, gtin: product.gtin14 })}
              </Button>
            ))
          )}
        </div>
      </>
    );
  };

  const formStep = (form: Form, from: NewShiftChoices) => {
    const fitting = fittingTemplates(form.product, from.templates);
    const chosen = fitting.find((template) => template.id === form.templateId) ?? null;
    const zoneKnown = from.timeZone !== null && isKnownTimeZone(from.timeZone);
    return (
      <>
        <p className="shift-card__product">
          {t("floor.newShift.product", { name: form.product.name, gtin: form.product.gtin14 })}
        </p>
        {fitting.length === 0 ? (
          <Alert tone="error">{t("floor.newShift.noTemplate")}</Alert>
        ) : form.templateFixed && chosen !== null ? (
          <p>{t("floor.newShift.templateChosen", { name: chosen.name })}</p>
        ) : (
          <div className="new-shift__choice" role="group" aria-label={t("floor.newShift.template")}>
            {chosen === null && <p>{t("floor.newShift.templateChoose")}</p>}
            {fitting.map((template) => (
              <Button
                key={template.id}
                size="floor"
                variant={template.id === form.templateId ? "primary" : "secondary"}
                aria-pressed={template.id === form.templateId}
                disabled={busy !== null}
                onClick={() => update({ templateId: template.id })}
              >
                {template.name}
              </Button>
            ))}
          </div>
        )}
        <div
          className="new-shift__date"
          role="group"
          aria-label={t("floor.newShift.productionDate")}
        >
          <p className="floor-sign-in__prompt">
            {t("floor.newShift.productionDateValue", {
              date: formatCivilDate(form.productionDate),
            })}
          </p>
          {!zoneKnown && <p className="shift-card__hint">{t("floor.newShift.pcDate")}</p>}
          <div className="standalone-form__actions">
            <Button
              size="floor"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => update({ productionDate: addCivilDays(form.productionDate, -1) })}
            >
              {t("floor.newShift.dayBefore")}
            </Button>
            <Button
              size="floor"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => update({ productionDate: addCivilDays(form.productionDate, 1) })}
            >
              {t("floor.newShift.dayAfter")}
            </Button>
          </div>
        </div>
        <Input
          size="floor"
          label={t("floor.newShift.plannedQty")}
          hint={t("floor.newShift.optional")}
          inputMode="numeric"
          value={form.plannedQty}
          disabled={busy !== null}
          {...(errors.plannedQty === undefined ? {} : { error: errors.plannedQty })}
          onChange={(event) => update({ plannedQty: event.currentTarget.value })}
        />
        <Input
          size="floor"
          label={t("floor.newShift.boxCapacity")}
          inputMode="numeric"
          value={form.boxCapacity}
          disabled={busy !== null}
          {...(errors.boxCapacity === undefined ? {} : { error: errors.boxCapacity })}
          onChange={(event) => update({ boxCapacity: event.currentTarget.value })}
        />
        <div className="standalone-form__actions">
          <Button
            size="floor"
            loading={busy !== null}
            disabled={!online || form.templateId === null}
            onClick={() => void submit(form)}
          >
            {t("floor.newShift.create")}
          </Button>
          <Button
            size="floor"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => {
              setProblem(null);
              setStep({ kind: "product" });
            }}
          >
            {t("floor.newShift.otherProduct")}
          </Button>
        </div>
        {!online && <p className="shift-card__hint">{t("floor.newShift.needsLink")}</p>}
      </>
    );
  };

  return (
    <Card className="standalone-card shift-list" title={t("floor.newShift.title")} titleAs="h2">
      <div className="standalone-form">
        <div className="floor-sign-in__message" aria-live="polite">
          {problem !== null && <Alert tone="error">{problemText(problem)}</Alert>}
          {busy !== null && <p>{t(`floor.newShift.${busy}`)}</p>}
        </div>
        {step.kind === "form" && ready !== null ? formStep(step.form, ready) : productStep()}
        <div className="standalone-form__actions">
          {/* Never held by a request: one that never settles must not trap the station here. */}
          <Button size="floor" variant="secondary" onClick={onBack}>
            {t("floor.newShift.back")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент:

<!-- prettier-ignore -->
```json
        "local": "Не удалось сохранить смену на этом компьютере. Попробуйте ещё раз.",
        "failed": "Не удалось открыть смену. Попробуйте ещё раз."
      }
    },
```

заменить на:

<!-- prettier-ignore -->
```json
        "local": "Не удалось сохранить смену на этом компьютере. Попробуйте ещё раз.",
        "failed": "Не удалось открыть смену. Попробуйте ещё раз."
      }
    },
    "newShift": {
      "title": "Новая смена",
      "loading": "Читаем справочники…",
      "readFailed": "Не удалось прочитать справочники на этом компьютере.",
      "retry": "Повторить",
      "notReady": "Справочники ещё не загружены с хоста. Создать смену можно после синхронизации.",
      "noProducts": "Нет товаров в работе. Товары добавляют в офисе, в разделе «Товары».",
      "productPrompt": "Отсканируйте штрихкод товара или код маркировки либо найдите товар по названию.",
      "searchLabel": "Название товара",
      "searchHint": "Наберите хотя бы две буквы.",
      "searchEmpty": "Ничего не нашли. Проверьте название или отсканируйте товар.",
      "result": "{{name}} — {{gtin}}",
      "scan": {
        "not_product": "Это не код товара. Отсканируйте штрихкод товара или код маркировки.",
        "not_found": "Товара с GTIN {{gtin}} нет среди товаров в работе. Проверьте товар в офисе.",
        "ambiguous": "GTIN {{gtin}} есть у нескольких товаров в работе. Выберите товар по названию."
      },
      "product": "{{name}}, GTIN {{gtin}}",
      "template": "Шаблон этикетки короба",
      "templateChosen": "Шаблон этикетки короба: {{name}}",
      "templateChoose": "Выберите шаблон этикетки короба.",
      "noTemplate": "Для этого товара нет подходящего шаблона этикетки короба. Шаблоны настраивают в офисе.",
      "productionDate": "Дата производства",
      "productionDateValue": "Дата производства: {{date}}",
      "pcDate": "Часовой пояс организации неизвестен: взята дата этого компьютера.",
      "dayBefore": "На день раньше",
      "dayAfter": "На день позже",
      "plannedQty": "План, шт.",
      "optional": "Необязательно",
      "boxCapacity": "В коробе, шт.",
      "create": "Создать и открыть",
      "creating": "Создаём смену…",
      "entering": "Открываем смену…",
      "otherProduct": "Другой товар",
      "back": "Назад",
      "needsLink": "Создать смену можно только при связи с хостом.",
      "notEntered": "Смена {{number}} создана, но не открыта.",
      "refused": {
        "no_link": "Нет связи с хостом. Создать смену можно только при связи с ним.",
        "product_inactive": "Товар выключен или в архиве: смену не создать. Обратитесь в офис.",
        "template": "Шаблон этикетки больше не подходит товару. Выберите другой шаблон или обратитесь в офис.",
        "invalid": "Хост не принял поля смены. Проверьте план и вместимость короба.",
        "no_line": "У станции нет линии: смену не создать.",
        "failed": "Не удалось создать смену. Попробуйте ещё раз."
      }
    },
```

Правка `apps/standalone/src/app/shell.css`:

Фрагмент:

<!-- prettier-ignore -->
```text
.shift-card__hint {
  color: var(--fg-2);
}
```

заменить на:

<!-- prettier-ignore -->
```text
.shift-card__hint {
  color: var(--fg-2);
}

/* A new shift: the template choice and the production date's two steps. */
.new-shift__choice,
.new-shift__date {
  display: grid;
  gap: 8px;
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-new-shift.test.tsx test/floor-shift-text.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  23 passed (23)`.

- [ ] **Step 5: Мутации**

Run каждой: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-new-shift.test.tsx`.

1. `apps/standalone/src/floor/shifts/NewShift.tsx`: `    if (running.current || form.templateId === null) return;` → `    if (form.templateId === null) return;`. Expected: FAIL — «sends one request at a time, and «Назад» is never held by one».
2. Там же: `          requestId: form.requestId,` → `          requestId: current.current.newRequestId(),`. Expected: FAIL — «creates the shift with the host and enters it at once», «sends the plan, the capacity and another day as the operator set them», «repeats the same request after a failure, so a lost answer makes no second shift».
3. Там же: `    return () => source.setManualTextEntryActive(false);` → `    return () => undefined;`. Expected: FAIL — «takes no scan while the name is typed, and gives the scanner back when the step goes».
4. `apps/standalone/src/floor/shifts/new-shift.ts`: удалить строку `  if (found.length > 1) return { kind: "ambiguous", gtin14 };`. Expected: FAIL — «does not guess between two products in use with one GTIN».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/shifts apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/floor-new-shift.test.tsx apps/standalone/test/floor-shift-text.test.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`; verbose-прогон и стенд с задержкой `setImmediate` для обоих файлов.
Expected: чисто; verbose без `stderr`; под стендом — те же 23.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/shifts/new-shift.ts apps/standalone/src/floor/shifts/NewShift.tsx apps/standalone/src/floor/shifts/shift-text.ts apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/floor-new-shift.test.tsx apps/standalone/test/floor-shift-text.test.ts
git commit -m "feat(standalone): a station creates a shift of a scanned or found product and enters it at once" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Автомат цеха `FloorApp`, ворота работы и заглушка рабочего экрана

`src/floor/FloorApp.tsx` — цех после входа оператора (§5.1): виды «список», «новая смена», «работа смены», как ручной автомат облачной станции. `App` ключует его сеансом. Вход в смену — `work_entered` и рабочий экран; выход — назад в список, выход оператора (свой, по бездействию, удалённого хостом), закрытие смены офисом (видно в копии после чтения: «Смену … закрыли в офисе»), смена линии — ждёт работу рабочего экрана (`createWorkGate`), затем `work_left`, и только тогда отказ устройства или новая линия, ждавшие в редьюсере, забирают цех. При ждущей смене линии цех выходит из смены сам; при ждущем отказе ждёт, пока выйдет оператор (вопросы В9, В8). Бездействие (облачные 10 минут) идёт весь сеанс; `touch` перезапускает его для скана, не нажимающего клавиш (COM-сканер плана 2a6). После каждой синхронизации цех читает оператора в копиях (`readOperatorCopy` вместо `operatorStillAllowed`): нет — выход «removed» после работы; другое имя или роль — `operator_refreshed`; копии не готовы или не читаются — ничего (как раньше: проверка не мешает работе).

`src/floor/work-gate.ts` — ворота: `track(work)` держит каждый следующий `drain` до того, как работа уладится; упавшая работа ворот не держит и `drain` не роняет; работа, отданная во время ожидания, ждётся тоже (ожидание идёт кругами). `src/floor/work/WorkScreen.tsx` — заглушка рабочего экрана с договорёнными свойствами (`WorkScreenProps`, раздел «Контракт для 2a6–2a8»): номер смены и товар из снимка, «Выйти из смены» (64 px), «Дожидаемся окончания начатой работы…» во время выхода.

`App` монтирует `FloorApp` вместо `FloorOperatorScreen` (удаляется вместе со своими тестами: тесты бездействия и выданного входом оператора переезжают в `test/floor-app.test.tsx`); заглушка текста `floor.operator.stub` уходит. В `app.test.tsx` подсматривание обратного вызова выхода переходит с `FloorOperatorScreen` на `FloorApp`, и четыре новых теста проводят смену через всё приложение: список хоста и вход; отказ ключа во время смены — связь останавливается сразу, экран отказа — после выхода; перевод станции на другую линию — после работы, с уведомлением; новое имя оператора — без нового сеанса.

**Files:**

- Create: `apps/standalone/src/floor/FloorApp.tsx`, `apps/standalone/src/floor/work-gate.ts`, `apps/standalone/src/floor/work/WorkScreen.tsx`
- Modify: `apps/standalone/src/floor/idle-lock.ts`, `apps/standalone/src/floor/sign-in.ts`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/i18n/ru.json`
- Delete: `apps/standalone/src/floor/FloorOperatorScreen.tsx`, `apps/standalone/test/floor-operator.test.tsx`
- Test: `apps/standalone/test/floor-app.test.tsx`, `apps/standalone/test/work-gate.test.ts` (Create); `apps/standalone/test/app.test.tsx` (Modify)

**Interfaces:**

- Consumes: `ShiftList`, `ShiftListNotice` (задача 5); `NewShift` (задача 6); `readShiftCopy`, `WorkShift` (задача 3); `FloorSession`, `FloorNotice`, `ShellAction`, `SyncState`, `shellActionFor`, поля `ShellState` `shiftReads`, `pendingDevice` (задача 4); `HostApi.enterShift`, `createDeviceShift` (задача 2); `createOperatorIdleLock`, `OPERATOR_IDLE_TIMEOUT_MS` (`src/floor/idle-lock.ts`); `ScanSource`.
- Produces:
  - `work-gate.ts`: `interface WorkGate { track: <T>(work: Promise<T>) => Promise<T>; drain: () => Promise<void>; pending: () => number }`, `createWorkGate(): WorkGate`;
  - `work/WorkScreen.tsx`: `interface WorkScreenProps { shift; operator; pairing; local; online; track; touch; onLeave; leaving }`, `WorkScreen`;
  - `FloorApp.tsx`: `interface FloorAppProps { operator; local; device; link; sync; shiftReads; lineChangePending; enter; create; source; idleTimeoutMs?; workScreen?; dispatch; onSignOut }`, `FloorApp`;
  - `idle-lock.ts`: `OperatorIdleLock.touch: () => void`;
  - `sign-in.ts`: `type OperatorCopy = { kind: "present"; name; role } | { kind: "absent" } | { kind: "unknown" }`, `readOperatorCopy(context, operatorId): Promise<OperatorCopy>` (`operatorStillAllowed` удаляется);
  - ключи `floor.work.*`; ключ `floor.operator.stub` удаляется.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/work-gate.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import { createWorkGate } from "../src/floor/work-gate.js";

/** A promise the test settles. */
function held<T>() {
  let settle: { resolve: (value: T) => void; reject: (error: unknown) => void } = {
    resolve: () => undefined,
    reject: () => undefined,
  };
  const promise = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
}

/** Whether `promise` has settled after every pending microtask ran. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

describe("the work gate of a shift's screen", () => {
  it("lets a leave through at once when nothing runs", async () => {
    const gate = createWorkGate();
    expect(await settled(gate.drain())).toBe(true);
    expect(gate.pending()).toBe(0);
  });

  it("holds a leave until the tracked work settles, and hands the work back unchanged", async () => {
    const gate = createWorkGate();
    const work = held<string>();
    const tracked = gate.track(work.promise);
    expect(tracked).toBe(work.promise);
    expect(gate.pending()).toBe(1);
    const drained = gate.drain();
    expect(await settled(drained)).toBe(false);
    work.resolve("box closed");
    expect(await settled(drained)).toBe(true);
    await expect(tracked).resolves.toBe("box closed");
    expect(gate.pending()).toBe(0);
  });

  it("is not held for good by work that fails, and does not fail itself", async () => {
    const gate = createWorkGate();
    const work = held<never>();
    const tracked = gate.track(work.promise);
    const drained = gate.drain();
    work.reject(new Error("disk"));
    await expect(tracked).rejects.toThrow("disk");
    await expect(drained).resolves.toBeUndefined();
  });

  it("waits for work tracked while it already waits", async () => {
    const gate = createWorkGate();
    const first = held<void>();
    const second = held<void>();
    gate.track(first.promise);
    const drained = gate.drain();
    gate.track(second.promise);
    first.resolve();
    expect(await settled(drained)).toBe(false);
    second.resolve();
    expect(await settled(drained)).toBe(true);
  });
});
```

Создать `apps/standalone/test/floor-app.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { readFileSync } from "node:fs";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorNotice, FloorSession, ShellAction, SyncState } from "../src/app/shell.js";
import { FloorApp } from "../src/floor/FloorApp.js";
import { createOperatorIdleLock, OPERATOR_IDLE_TIMEOUT_MS } from "../src/floor/idle-lock.js";
import type { ScanSource } from "../src/floor/scan-source.js";
import { keepEnteredShift, replaceShiftCopies } from "../src/floor/shifts/shift-copies.js";
import { signInWithPin } from "../src/floor/sign-in.js";
import type { WorkScreenProps } from "../src/floor/work/WorkScreen.js";
import {
  deviceShiftsSchema,
  enteredShiftSchema,
  type ChangeItem,
  type DeviceShift,
  type EnteredShift,
  type HostStatus,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const ANNA = {
  id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
  login: "0042",
  name: "Анна Кузнецова",
  role: "Упаковщик",
};
const SESSION: FloorSession = { ...ANNA, sessionId: 1 };
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
const OPERATOR: ChangeItem = {
  entity: "operators",
  id: ANNA.id,
  rev: 5,
  deleted: false,
  data: { login: "0042", name: ANNA.name, role: ANNA.role, pinPhc: PIN_PHC },
};
const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };
const SYNCED: SyncState = { kind: "done", synced: 1, failure: null, quarantined: 0 };
const [, PLANNED] = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts as [
  DeviceShift,
  DeviceShift,
];
const ENTERED: EnteredShift = enteredShiftSchema.parse(fixture("device-shift-entered.json"));
const OPENED: EnteredShift = {
  ...ENTERED,
  id: PLANNED.id,
  number: PLANNED.number,
  ownerDeviceId: DEVICE_ID,
};
const SEEN = 1_790_000_000_000;

async function synced(items: ChangeItem[], rev = 10): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev, hasMore: false, items }),
    local: executor,
    ...PAIRING,
  });
  return executor;
}

const SILENT_SOURCE: ScanSource = {
  start: () => () => undefined,
  clearPendingInput: () => undefined,
  setManualTextEntryActive: () => undefined,
};

interface Options {
  sync?: SyncState;
  shiftReads?: { done: number; failed: boolean };
  lineChangePending?: boolean;
  idleTimeoutMs?: number;
  workScreen?: ComponentType<WorkScreenProps>;
}

function floorOf(
  local: LocalExecutor,
  handlers: ReturnType<typeof handlersOf>,
  options: Options = {},
) {
  return (
    <ThemeProvider>
      <FloorApp
        operator={SESSION}
        local={local}
        device={DEVICE_STATUS}
        link={ONLINE}
        sync={options.sync ?? SYNCED}
        shiftReads={options.shiftReads ?? { done: 1, failed: false }}
        lineChangePending={options.lineChangePending ?? false}
        enter={handlers.enter}
        create={handlers.create}
        source={SILENT_SOURCE}
        {...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs })}
        {...(options.workScreen === undefined ? {} : { workScreen: options.workScreen })}
        dispatch={handlers.dispatch}
        onSignOut={handlers.onSignOut}
      />
    </ThemeProvider>
  );
}

function handlersOf() {
  return {
    enter: vi.fn(async () => OPENED),
    create: vi.fn(async () => PLANNED),
    dispatch: vi.fn<(action: ShellAction) => void>(),
    onSignOut: vi.fn<(notice: FloorNotice | null) => void>(),
  };
}

/** The copies with Anna and the line's planned shift. */
async function floorCopies(items: ChangeItem[] = [OPERATOR]): Promise<LocalExecutor> {
  const local = await synced(items);
  await replaceShiftCopies(local, PAIRING, [PLANNED], SEEN);
  return local;
}

function types(handlers: ReturnType<typeof handlersOf>): string[] {
  return handlers.dispatch.mock.calls.map(([action]) => action.type);
}

async function enterPlanned(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
}

/** Two turns of React's effect scheduler and the promises they started. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

/** A work screen that holds the leave with a piece of work the test settles. */
function holdingWork() {
  let release: () => void = () => undefined;
  let fail: () => void = () => undefined;
  const leaving: boolean[] = [];
  let touch: () => void = () => undefined;
  let tracking = false;
  function Work(props: WorkScreenProps) {
    const { track } = props;
    useEffect(() => {
      tracking = true;
      void track(
        new Promise<void>((resolve, reject) => {
          release = resolve;
          fail = () => reject(new Error("disk"));
        }),
      ).catch(() => undefined);
    }, [track]);
    touch = props.touch;
    leaving.push(props.leaving);
    return (
      <button type="button" onClick={props.onLeave}>
        {`Работа ${props.shift.copy.number}`}
      </button>
    );
  }
  return {
    Work,
    release: () => act(async () => release()),
    fail: () => act(async () => fail()),
    leaving,
    touch: () => touch(),
    /** The screen's effect has handed its work to the gate: only then may the test leave. */
    tracked: () =>
      waitFor(() => {
        if (!tracking) throw new Error("the work screen has not tracked its work yet");
      }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the floor after an operator signed in", () => {
  it("enters a shift into its work screen, tells the shell, and comes back to the list", async () => {
    const handlers = handlersOf();
    const view = render(floorOf(await floorCopies(), handlers));
    await enterPlanned();
    expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
    expect(handlers.dispatch).toHaveBeenCalledWith({
      type: "work_entered",
      sessionId: 1,
      shiftId: PLANNED.id,
    });
    const leave = screen.getByRole("button", { name: "Выйти из смены" });
    expect(leave.className).toContain("mk-btn--floor");
    fireEvent.click(leave);
    expect(await screen.findByRole("button", { name: "Продолжить" })).toBeTruthy();
    expect(handlers.dispatch).toHaveBeenCalledWith({ type: "work_left", sessionId: 1 });
    view.unmount();
  });

  it("leaves the shift only once the work its screen tracks has settled", async () => {
    const handlers = handlersOf();
    const work = holdingWork();
    render(floorOf(await floorCopies(), handlers, { workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    fireEvent.click(screen.getByRole("button", { name: "Работа OCT26-005/S" }));
    await settle();
    expect(work.leaving.at(-1)).toBe(true);
    expect(types(handlers)).not.toContain("work_left");
    await work.release();
    expect(await screen.findByRole("button", { name: "Продолжить" })).toBeTruthy();
    expect(types(handlers)).toContain("work_left");
  });

  it("is not held for good by tracked work that failed", async () => {
    const handlers = handlersOf();
    const work = holdingWork();
    render(floorOf(await floorCopies(), handlers, { workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    fireEvent.click(screen.getByRole("button", { name: "Работа OCT26-005/S" }));
    await work.fail();
    await waitFor(() => expect(types(handlers)).toContain("work_left"));
  });

  it("drops a leave whose work settles after the floor is gone", async () => {
    const handlers = handlersOf();
    const work = holdingWork();
    const view = render(floorOf(await floorCopies(), handlers, { workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    fireEvent.click(screen.getByRole("button", { name: "Работа OCT26-005/S" }));
    view.unmount();
    await work.release();
    await settle();
    expect(types(handlers)).not.toContain("work_left");
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("signs the operator out as idle at once on the list, and after the work in a shift", async () => {
    const local = await floorCopies();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const first = handlersOf();
    const view = render(floorOf(local, first, { idleTimeoutMs: 3_000 }));
    await screen.findByRole("button", { name: "Открыть" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(first.onSignOut).toHaveBeenCalledWith("idle");
    view.unmount();

    const second = handlersOf();
    const work = holdingWork();
    render(floorOf(local, second, { idleTimeoutMs: 3_000, workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(second.onSignOut).not.toHaveBeenCalled();
    expect(work.leaving.at(-1)).toBe(true);
    await work.release();
    await waitFor(() => expect(second.onSignOut).toHaveBeenCalledWith("idle"));
    // The shell hears the work end before the sign-out.
    const order = second.dispatch.mock.invocationCallOrder.at(-1) ?? 0;
    expect(order).toBeLessThan(second.onSignOut.mock.invocationCallOrder[0] ?? 0);
  });

  it("starts the idle wait again when the work screen touches it (a COM scan presses no key)", async () => {
    const local = await floorCopies();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const handlers = handlersOf();
    const work = holdingWork();
    render(floorOf(local, handlers, { idleTimeoutMs: 4_000, workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    // Margins of 1 500 ms on both sides of the touch: the clock also runs with real time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    work.touch();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(work.leaving.at(-1)).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_700);
    });
    expect(work.leaving.at(-1)).toBe(true);
  });

  it("signs out an operator a sync took out of the copies, after the work", async () => {
    const local = await floorCopies();
    const handlers = handlersOf();
    const work = holdingWork();
    const view = render(floorOf(local, handlers, { workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    await syncReferences({
      changes: async () => ({
        hostId: HOST_ID,
        rev: 11,
        hasMore: false,
        items: [{ entity: "operators", id: ANNA.id, rev: 6, deleted: true }],
      }),
      local,
      ...PAIRING,
    });
    view.rerender(
      floorOf(local, handlers, { workScreen: work.Work, sync: { ...SYNCED, synced: 2 } }),
    );
    await waitFor(() => expect(work.leaving.at(-1)).toBe(true));
    expect(handlers.onSignOut).not.toHaveBeenCalled();
    await work.release();
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("removed"));
  });

  it("brings a new name and role from the copies after a sync, without a new session", async () => {
    const renamed = {
      ...OPERATOR,
      rev: 6,
      data: { login: "0042", name: "Анна Петрова", role: "Бригадир", pinPhc: PIN_PHC },
    };
    const handlers = handlersOf();
    render(floorOf(await floorCopies([renamed]), handlers));
    await waitFor(() =>
      expect(handlers.dispatch).toHaveBeenCalledWith({
        type: "operator_refreshed",
        sessionId: 1,
        name: "Анна Петрова",
        role: "Бригадир",
      }),
    );
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("signs nobody out and refreshes nothing on copies that are not this pairing's yet", async () => {
    const handlers = handlersOf();
    const { executor } = openLocalDb();
    render(floorOf(executor, handlers));
    await screen.findByText(
      "Открытых смен на линии нет. Создайте смену или дождитесь плана из офиса.",
    );
    await settle();
    expect(handlers.onSignOut).not.toHaveBeenCalled();
    expect(types(handlers)).not.toContain("operator_refreshed");
  });

  it("takes the operator back to the list when the office closed the shift", async () => {
    const local = await floorCopies();
    const handlers = handlersOf();
    const view = render(floorOf(local, handlers));
    await enterPlanned();
    await screen.findByText("Смена OCT26-005/S");
    await replaceShiftCopies(
      local,
      PAIRING,
      [{ ...OPENED, status: "closed", closedAt: "2026-10-09T18:00:00Z" }],
      SEEN + 1,
    );
    view.rerender(floorOf(local, handlers, { shiftReads: { done: 2, failed: false } }));
    expect(await screen.findByText("Смену OCT26-005/S закрыли в офисе.")).toBeTruthy();
    expect(types(handlers)).toContain("work_left");
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("stays in the shift after a read that finds it still open", async () => {
    const local = await floorCopies();
    const handlers = handlersOf();
    const view = render(floorOf(local, handlers));
    await enterPlanned();
    await screen.findByText("Смена OCT26-005/S");
    await replaceShiftCopies(local, PAIRING, [OPENED], SEEN + 1);
    view.rerender(floorOf(local, handlers, { shiftReads: { done: 2, failed: false } }));
    await settle();
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
    expect(types(handlers)).not.toContain("work_left");
  });

  it("leaves the shift for another line once the work is done, and nothing more", async () => {
    const local = await floorCopies();
    const handlers = handlersOf();
    const work = holdingWork();
    const view = render(floorOf(local, handlers, { workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    view.rerender(floorOf(local, handlers, { workScreen: work.Work, lineChangePending: true }));
    await waitFor(() => expect(work.leaving.at(-1)).toBe(true));
    expect(types(handlers)).not.toContain("work_left");
    await work.release();
    await waitFor(() => expect(types(handlers)).toContain("work_left"));
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("opens the new shift and comes back to the list", async () => {
    const handlers = handlersOf();
    render(floorOf(await floorCopies(), handlers));
    fireEvent.click(await screen.findByRole("button", { name: "Новая смена" }));
    expect(await screen.findByText("Новая смена", { selector: "h2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByRole("button", { name: "Открыть" })).toBeTruthy();
  });

  it("signs the operator out on «Сменить оператора»", async () => {
    const handlers = handlersOf();
    render(floorOf(await floorCopies(), handlers));
    fireEvent.click(await screen.findByRole("button", { name: "Сменить оператора" }));
    expect(handlers.onSignOut).toHaveBeenCalledWith(null);
  });
});

describe("the work screen of plan 2a5", () => {
  it("names the shift and its product from the snapshot", async () => {
    const local = await floorCopies();
    await keepEnteredShift(local, PAIRING, OPENED, "2026-10-09T06:00:00.000Z", SEEN);
    const handlers = handlersOf();
    render(floorOf(local, handlers));
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
    expect(screen.getByText("Молоко 3,2% 0,9 л")).toBeTruthy();
    expect(
      screen.getByText(
        "Сканирование кодов и сборка коробов появятся в следующем обновлении приложения.",
      ),
    ).toBeTruthy();
  });
});

describe("the operator a sign-in hands over", () => {
  it("is a new object of identity fields only each time, never the credential's row", async () => {
    const context = {
      local: await synced([OPERATOR]),
      pairing: PAIRING,
      now: () => 1_790_000_000_000,
    };
    const first = await signInWithPin(context, "0042", "4821");
    const second = await signInWithPin(context, "0042", "4821");
    if (first.kind !== "signed_in" || second.kind !== "signed_in") throw new Error("not signed in");
    expect(second.operator).not.toBe(first.operator);
    expect(Object.keys(first.operator).sort()).toEqual(["id", "login", "name", "role"]);
    expect(first.operator).toEqual(ANNA);
  });
});

describe("the operator idle lock", () => {
  it("waits ten minutes by default, and every touch starts the wait again", () => {
    vi.useFakeTimers();
    expect(OPERATOR_IDLE_TIMEOUT_MS).toBe(600_000);
    const onIdle = vi.fn();
    const lock = createOperatorIdleLock({ target: window, onIdle });
    lock.start();
    vi.advanceTimersByTime(599_999);
    fireEvent.pointerDown(window);
    vi.advanceTimersByTime(599_999);
    fireEvent.keyDown(window, { key: "1" });
    vi.advanceTimersByTime(599_999);
    lock.touch();
    vi.advanceTimersByTime(599_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    // Once idle, it waits for nothing more until started again: not a touch either.
    fireEvent.pointerDown(window);
    lock.touch();
    vi.advanceTimersByTime(600_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    lock.stop();
  });

  it("restarts the wait on a touch of the screen as on a press", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const lock = createOperatorIdleLock({ target: window, onIdle, timeoutMs: 1_000 });
    lock.start();
    vi.advanceTimersByTime(999);
    fireEvent.touchStart(window);
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    lock.stop();
  });

  it("listens for exactly a pointer, a key and a touch, and removes the same listeners", () => {
    const added: Array<[string, unknown]> = [];
    const removed: Array<[string, unknown]> = [];
    const target = {
      addEventListener: (type: string, listener: unknown) => void added.push([type, listener]),
      removeEventListener: (type: string, listener: unknown) => void removed.push([type, listener]),
    };
    const lock = createOperatorIdleLock({ target, onIdle: () => undefined, timeoutMs: 1_000 });
    lock.stop();
    expect(removed).toEqual([]);
    lock.start();
    expect(added.map(([type]) => type).sort()).toEqual(["keydown", "pointerdown", "touchstart"]);
    lock.stop();
    expect(removed.slice().sort()).toEqual(added.slice().sort());
    lock.stop();
    expect(removed).toHaveLength(3);
  });

  it("stops listening when stopped, and a touch after it starts nothing", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const lock = createOperatorIdleLock({ target: window, onIdle, timeoutMs: 1_000 });
    lock.start();
    lock.stop();
    fireEvent.pointerDown(window);
    lock.touch();
    vi.advanceTimersByTime(2_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
```

Правка `apps/standalone/test/app.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
} from "../src/app/lockdown.js";
import type { FloorNotice } from "../src/app/shell.js";
import type { FloorOperatorScreenProps } from "../src/floor/FloorOperatorScreen.js";
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import type { HostApi } from "../src/host/api.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
} from "../src/app/lockdown.js";
import type { FloorNotice } from "../src/app/shell.js";
import type { FloorAppProps } from "../src/floor/FloorApp.js";
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import type { HostApi } from "../src/host/api.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  ChangeItem,
  ChangesResponse,
  DeviceStatus,
  HostStatus,
} from "../src/host/protocol.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
  ChangeItem,
  ChangesResponse,
  DeviceShift,
  DeviceStatus,
  EnteredShift,
  HostStatus,
} from "../src/host/protocol.js";
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
const signOutHandles = vi.hoisted(() => [] as Array<(notice: FloorNotice | null) => void>);

vi.mock("../src/floor/FloorOperatorScreen.js", async (importOriginal) => {
  const actual = await importOriginal<{
    FloorOperatorScreen: ComponentType<FloorOperatorScreenProps>;
  }>();
  return {
    ...actual,
    FloorOperatorScreen: (props: FloorOperatorScreenProps) => {
      if (signOutHandles.at(-1) !== props.onSignOut) signOutHandles.push(props.onSignOut);
      return <actual.FloorOperatorScreen {...props} />;
    },
  };
```

заменить на:

<!-- prettier-ignore -->
```tsx
const signOutHandles = vi.hoisted(() => [] as Array<(notice: FloorNotice | null) => void>);

vi.mock("../src/floor/FloorApp.js", async (importOriginal) => {
  const actual = await importOriginal<{ FloorApp: ComponentType<FloorAppProps> }>();
  return {
    ...actual,
    FloorApp: (props: FloorAppProps) => {
      if (signOutHandles.at(-1) !== props.onSignOut) signOutHandles.push(props.onSignOut);
      return <actual.FloorApp {...props} />;
    },
  };
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  }

  it("shows the status bar above the sign-in and the stub, with the line and the operator", async () => {
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }

  it("shows the status bar above the sign-in and the shifts, with the line and the operator", async () => {
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
  });

  it("signs an operator in with a badge without asking the host, shows the floor's stub and signs out on request", async () => {
    const { host } = await onTheFloor();
    scan("MRK-000742");
```

заменить на:

<!-- prettier-ignore -->
```tsx
  });

  it("signs an operator in with a badge without asking the host, shows the line's shifts and signs out on request", async () => {
    const { host } = await onTheFloor();
    scan("MRK-000742");
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
    expect(screen.getByText(PROMPT)).toBeTruthy();
  });
});

```

заменить на:

<!-- prettier-ignore -->
```tsx
    expect(screen.getByText(PROMPT)).toBeTruthy();
  });

  /** The line's planned shift as the host lists it, and as it answers its opening. */
  const PLANNED: DeviceShift = {
    id: "4e7a1c9d-2b5f-4d8e-a3c6-9f0b1e2d3c4a",
    number: "OCT26-005/S",
    status: "planned",
    mode: "aggregation",
    palletsEnabled: false,
    createdFrom: "station",
    lineId: LINE_ID,
    productId: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
    productName: "Молоко 3,2% 0,9 л",
    productGtin14: "04600682000013",
    counterpartyName: null,
    productionDate: "2026-10-09",
    plannedQty: null,
    boxCapacity: 12,
    boxTemplateId: "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
    ownerDeviceId: null,
    openedAt: null,
    closedAt: null,
  };
  const OPENED: EnteredShift = {
    ...PLANNED,
    status: "active",
    ownerDeviceId: DEVICE_ID,
    openedAt: "2026-10-09T06:00:00Z",
    snapshot: {
      product: {
        id: PLANNED.productId,
        gtin14: "04600682000013",
        name: "Молоко 3,2% 0,9 л",
        printName: null,
        chzProductGroupCode: 8,
        shelfLifeDays: 10,
      },
      boxTemplate: {
        id: PLANNED.boxTemplateId,
        name: "Молоко 58×40",
        rev: 62,
        spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "tspl", elements: [] },
      },
      issuerPrefix: "460068200",
      counterpartyName: null,
    },
  };

  /** Anna signed in, in the line's shift, on a station whose host lists it. */
  async function inTheShift() {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    host.getDeviceShifts.mockResolvedValue([PLANNED]);
    host.enterShift.mockResolvedValue(OPENED);
    renderApp({ probe: probeAnswering(true), device, host, connection: link.connection });
    await screen.findByText(PROMPT);
    scan("MRK-000742");
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
    return { link, device, host };
  }

  it("shows the shifts the host lists for the line and opens one into its work screen", async () => {
    const { host } = await inTheShift();
    expect(host.enterShift).toHaveBeenCalledWith(PLANNED.id);
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    expect(await screen.findByRole("button", { name: "Продолжить" })).toBeTruthy();
    expect(screen.getByText(SIGNED_IN)).toBeTruthy();
  });

  it("keeps the operator in the shift when the host refuses the key, and refuses the device once they leave", async () => {
    const { link } = await inTheShift();
    await link.status({ ...ONLINE, lastError: "key_rejected", seq: 2 });
    // The link stops at once: nothing more reaches a host that refused us.
    await waitFor(() => expect(link.stop).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
    expect(screen.queryByText("Хост не принимает это устройство")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
  });

  it("moves the station to the office's new line only after the operator's work, and says so", async () => {
    const { link, device } = await inTheShift();
    device.refresh.mockResolvedValue({
      ...DEVICE_STATUS,
      lineId: "5d1f6a52-0b7e-4c0e-8f51-3a4b9c2d7e10",
    });
    await link.revision(43);
    expect(await screen.findByText("Станция перешла на другую линию. Войдите снова.")).toBeTruthy();
    expect(screen.queryByText("Смена OCT26-005/S")).toBeNull();
  });

  it("shows a name the office changed without ending the operator's session", async () => {
    const { link, host } = await inTheShift();
    host.getChanges.mockResolvedValueOnce(
      feedPage(43, [
        {
          entity: "operators",
          id: ANNA,
          rev: 43,
          deleted: false,
          data: { login: "0042", name: "Анна Петрова", role: null, pinPhc: PIN_PHC },
        },
      ]),
    );
    await link.revision(43);
    const bar = screen.getByRole("region", { name: "Строка состояния цеха" });
    expect(await within(bar).findByText("Анна Петрова, табельный номер 0042")).toBeTruthy();
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
  });
});

```

Удалить `apps/standalone/test/floor-operator.test.tsx` (`git rm`): его тесты бездействия, проверки оператора и выданного входом оператора — в `test/floor-app.test.tsx`.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx test/work-gate.test.ts test/app.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/floor/work-gate.js"` и `"../src/floor/FloorApp.js"`; в `app.test.tsx` — `Tests  5 failed | 90 passed (95)`: четыре новых теста смены (`Unable to find role="button" and name "Открыть"`) и «ends only its own session: an earlier session's late sign-out leaves the next one» (подсматривание теперь ждёт `FloorApp`).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/floor/work-gate.ts`:

<!-- prettier-ignore -->
```ts
/**
 * The work of the shift's screen that must end before the operator leaves it
 * (stage 2a spec §5.1; `apps/station/AGENTS.md`, «Task closure»: unmounting
 * proves nothing stopped). The work screen hands every such piece of work to
 * `track` — a scan on its way through the pipeline, a box closing, a label
 * being sent — and the floor leaves the shift only after `drain`.
 */
export interface WorkGate {
  /** Holds every later `drain` until `work` settles; returns `work` itself. */
  track: <T>(work: Promise<T>) => Promise<T>;
  /**
   * Resolves once every tracked piece of work has settled, a rejected one
   * included, and work tracked while it waits as well.
   */
  drain: () => Promise<void>;
  /** How many pieces of work are still running. */
  pending: () => number;
}

export function createWorkGate(): WorkGate {
  const running = new Set<Promise<void>>();
  return {
    track: (work) => {
      // Removed when it settles, before anything awaiting it runs on.
      const settled: Promise<void> = work.then(
        () => {
          running.delete(settled);
        },
        () => {
          running.delete(settled);
        },
      );
      running.add(settled);
      return work;
    },
    drain: async () => {
      // Each round waits for what runs now and forgets it; work tracked
      // meanwhile makes another round.
      while (running.size > 0) {
        const round = [...running];
        await Promise.all(round);
        for (const done of round) running.delete(done);
      }
    },
    pending: () => running.size,
  };
}
```

Правка `apps/standalone/src/floor/idle-lock.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  start(): void;
  stop(): void;
}

```

заменить на:

<!-- prettier-ignore -->
```ts
  start(): void;
  stop(): void;
  /**
   * Starts the wait again, as a press does: a scan from a COM scanner presses
   * no key. A function-typed property: the floor hands it on unbound.
   */
  touch: () => void;
}

```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
    },
    stop,
  };
}
```

заменить на:

<!-- prettier-ignore -->
```ts
    },
    stop,
    touch: activity,
  };
}
```

Правка `apps/standalone/src/floor/sign-in.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
}

const OPERATOR_PRESENT = `SELECT o.id FROM ref_operators AS o WHERE o.id = ? AND ${NOT_QUARANTINED_OPERATOR}`;

/**
 * Whether the signed-in operator would still be let in, after a sync:
 * `false` only when this pairing's copies are ready (a sync has begun to fill
 * them) and no longer hold the operator (the host turned them off, or their
 * record waits in quarantine). Copies that are not ready say nothing either
 * way.
 */
export async function operatorStillAllowed(
  context: SignInContext,
  operatorId: string,
): Promise<boolean> {
  if (!(await copiesReady(context.local, context.pairing))) return true;
  const rows = await context.local.query(
    OPERATOR_PRESENT,
    [operatorId],
    z.object({ id: z.string() }),
  );
  return rows.length > 0;
}

```

заменить на:

<!-- prettier-ignore -->
```ts
}

const OPERATOR_PRESENT = `SELECT o.name, o.role FROM ref_operators AS o WHERE o.id = ? AND ${NOT_QUARANTINED_OPERATOR}`;

/**
 * The signed-in operator as the copies have them now, after a sync: there,
 * with the name and role to show (`present`); turned off by the host or
 * waiting in quarantine (`absent`); or `unknown` while this pairing's copies
 * are not ready, which says nothing either way.
 */
export type OperatorCopy =
  { kind: "present"; name: string; role: string | null } | { kind: "absent" } | { kind: "unknown" };

export async function readOperatorCopy(
  context: SignInContext,
  operatorId: string,
): Promise<OperatorCopy> {
  if (!(await copiesReady(context.local, context.pairing))) return { kind: "unknown" };
  const [row] = await context.local.query(
    OPERATOR_PRESENT,
    [operatorId],
    z.object({ name: z.string(), role: z.string().nullable() }),
  );
  return row === undefined
    ? { kind: "absent" }
    : { kind: "present", name: row.name, role: row.role };
}

```

Создать `apps/standalone/src/floor/work/WorkScreen.tsx`:

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { Button, Card } from "@markiro/ui";

import type { FloorSession } from "../../app/shell.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { WorkShift } from "../shifts/shift-copies.js";

/**
 * What the floor gives the work screen of a shift (the contract plans 2a6–2a8
 * build on): the shift with the snapshot this build read, the session, the
 * pairing whose rows it writes, the local database and the link; `track`
 * holds the leave until a piece of work settles; `touch` restarts the
 * operator's idle wait (a COM scanner presses no key); `onLeave` asks to go
 * back to the list, which the floor does once the tracked work has settled,
 * and `leaving` says it is waiting for that.
 */
export interface WorkScreenProps {
  shift: WorkShift;
  operator: FloorSession;
  pairing: Pairing;
  local: LocalExecutor;
  online: boolean;
  track: <T>(work: Promise<T>) => Promise<T>;
  touch: () => void;
  onLeave: () => void;
  leaving: boolean;
}

/**
 * The work screen of a shift. Plan 2a5 shows the shift and the way back to
 * the list; plan 2a6 replaces the body with scanning and boxes.
 */
export function WorkScreen({ shift, leaving, onLeave }: WorkScreenProps) {
  const { t } = useTranslation();
  return (
    <Card
      className="standalone-card"
      title={t("floor.work.title", { number: shift.copy.number })}
      titleAs="h2"
    >
      <div className="standalone-form">
        <p className="shift-card__product">{shift.snapshot.product.name}</p>
        <p>{t("floor.work.stub")}</p>
        {leaving && <p aria-live="polite">{t("floor.work.leaving")}</p>}
        <div className="standalone-form__actions">
          <Button size="floor" variant="secondary" disabled={leaving} onClick={onLeave}>
            {t("floor.work.leave")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
```

Создать `apps/standalone/src/floor/FloorApp.tsx`:

<!-- prettier-ignore -->
```tsx
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";

import {
  shellActionFor,
  type FloorNotice,
  type FloorSession,
  type ShellAction,
  type SyncState,
} from "../app/shell.js";
import type {
  DeviceShift,
  DeviceShiftCreate,
  DeviceStatus,
  EnteredShift,
  HostStatus,
} from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import { createOperatorIdleLock, OPERATOR_IDLE_TIMEOUT_MS } from "./idle-lock.js";
import type { ScanSource } from "./scan-source.js";
import { NewShift } from "./shifts/NewShift.js";
import { readShiftCopy, type WorkShift } from "./shifts/shift-copies.js";
import { ShiftList, type ShiftListNotice } from "./shifts/ShiftList.js";
import { readOperatorCopy } from "./sign-in.js";
import { createWorkGate } from "./work-gate.js";
import { WorkScreen, type WorkScreenProps } from "./work/WorkScreen.js";

/** Why the operator leaves the shift: back to the list, the office closed it, a sign-out, another line. */
type Leave =
  | { kind: "list"; notice: ShiftListNotice | null }
  | { kind: "sign_out"; notice: FloorNotice | null }
  | { kind: "line_changed" };

type FloorView =
  | { kind: "list"; notice: ShiftListNotice | null }
  | { kind: "new_shift" }
  | { kind: "work"; shift: WorkShift; leaving: boolean };

export interface FloorAppProps {
  operator: FloorSession;
  local: LocalExecutor;
  /** The pairing and the station's line. */
  device: DeviceStatus;
  link: HostStatus | null;
  sync: SyncState;
  /** `ShellState.shiftReads`. */
  shiftReads: { done: number; failed: boolean };
  /** The office moved the station to another line, and the move waits for the work (`pendingDevice`). */
  lineChangePending: boolean;
  /** `HostApi.enterShift`. */
  enter: (shiftId: string) => Promise<EnteredShift>;
  /** `HostApi.createDeviceShift`. */
  create: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  /** The floor's scanner: a new shift's product is chosen by a scan. */
  source: ScanSource;
  /** Nobody touched the station this long: the operator is signed out. */
  idleTimeoutMs?: number;
  /** The work screen of a shift; tests give their own. */
  workScreen?: ComponentType<WorkScreenProps>;
  dispatch: (action: ShellAction) => void;
  /** `null` is the operator's own «Сменить оператора». */
  onSignOut: (notice: FloorNotice | null) => void;
}

/**
 * The floor after an operator signed in (stage 2a spec §5.1): the shifts of
 * the line and the work screen of the one entered, as a small machine of its
 * own like the cloud station's. It belongs to one session (`App` keys it by
 * the session), so nothing of one operator's screen outlives their sign-out.
 *
 * Leaving the shift — back to the list, a sign-out (the operator's own, idle,
 * removed by the host), the office's close of the shift, another line — waits
 * for the work the screen tracks (`createWorkGate`), then tells the shell
 * (`work_left`), which is when a refusal of this device or a line change that
 * waited for the work takes the floor. The idle wait and the check of the
 * operator after a sync run for the whole session; the check also brings a
 * new name or role (`operator_refreshed`), without a new session.
 */
export function FloorApp({
  operator,
  local,
  device,
  link,
  sync,
  shiftReads,
  lineChangePending,
  enter,
  create,
  source,
  idleTimeoutMs = OPERATOR_IDLE_TIMEOUT_MS,
  workScreen: Work = WorkScreen,
  dispatch,
  onSignOut,
}: FloorAppProps) {
  const { hostId, deviceId, lineId } = device;
  const { sessionId } = operator;
  const online = link?.state === "online";
  const [view, setView] = useState<FloorView>({ kind: "list", notice: null });
  const gate = useMemo(() => createWorkGate(), []);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The view and the callbacks as the last commit has them, for timers and
  // answers that land later.
  const current = useRef({ view, onSignOut, dispatch });
  useLayoutEffect(() => {
    current.current = { view, onSignOut, dispatch };
  });
  const leavingRef = useRef(false);

  const finish = useCallback((leave: Leave) => {
    if (leave.kind === "sign_out") {
      current.current.onSignOut(leave.notice);
      return;
    }
    // Another line: `work_left` already moved the station and ended the session.
    if (leave.kind === "list") setView({ kind: "list", notice: leave.notice });
  }, []);

  /** Leaves the work (or, outside it, the floor) once its tracked work has settled. */
  const leave = useCallback(
    (reason: Leave) => {
      if (current.current.view.kind !== "work") {
        finish(reason);
        return;
      }
      if (leavingRef.current) return;
      leavingRef.current = true;
      setView((now) => (now.kind === "work" ? { ...now, leaving: true } : now));
      void gate.drain().then(() => {
        leavingRef.current = false;
        if (!alive.current) return;
        current.current.dispatch({ type: "work_left", sessionId });
        finish(reason);
      });
    },
    [finish, gate, sessionId],
  );

  const idle = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    idle.current = () => leave({ kind: "sign_out", notice: "idle" });
  });
  const lock = useMemo(
    () =>
      createOperatorIdleLock({
        target: window,
        timeoutMs: idleTimeoutMs,
        onIdle: () => idle.current(),
      }),
    [idleTimeoutMs],
  );
  useEffect(() => {
    lock.start();
    return () => lock.stop();
  }, [lock]);

  // After every sync: the operator the host turned off is signed out; a new
  // name or role is shown. A copy that cannot be read signs nobody out.
  useEffect(() => {
    if (sync.synced === 0) return;
    let cancelled = false;
    readOperatorCopy({ local, pairing: { hostId, deviceId }, now: Date.now }, operator.id).then(
      (copy) => {
        if (cancelled) return;
        if (copy.kind === "absent") leave({ kind: "sign_out", notice: "removed" });
        if (copy.kind === "present") {
          current.current.dispatch({
            type: "operator_refreshed",
            sessionId,
            name: copy.name,
            role: copy.role,
          });
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, operator.id, sessionId, sync.synced, leave]);

  // After every read of the host's list: a shift the office closed while the
  // operator works in it takes them back to the list.
  const workShiftId = view.kind === "work" ? view.shift.copy.id : null;
  useEffect(() => {
    if (workShiftId === null || shiftReads.done === 0) return;
    let cancelled = false;
    readShiftCopy(local, { hostId, deviceId }, workShiftId).then(
      (copy) => {
        if (cancelled || copy === null) return;
        if (copy.status === "closed" && copy.localState === null) {
          leave({ kind: "list", notice: { kind: "office_closed", number: copy.number } });
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, workShiftId, shiftReads.done, leave]);

  // Another line waits for the work (question В9): leave the shift for it.
  useEffect(() => {
    if (lineChangePending && workShiftId !== null) leave({ kind: "line_changed" });
  }, [lineChangePending, workShiftId, leave]);

  const entered = useCallback(
    (shift: WorkShift) => {
      current.current.dispatch({ type: "work_entered", sessionId, shiftId: shift.copy.id });
      setView({ kind: "work", shift, leaving: false });
    },
    [sessionId],
  );
  const hostError = useCallback((error: unknown) => {
    const action = shellActionFor(error, null);
    if (action !== null) current.current.dispatch(action);
  }, []);

  if (view.kind === "work") {
    return (
      <Work
        shift={view.shift}
        operator={operator}
        pairing={{ hostId, deviceId }}
        local={local}
        online={online}
        track={gate.track}
        touch={lock.touch}
        leaving={view.leaving}
        onLeave={() => leave({ kind: "list", notice: null })}
      />
    );
  }
  if (view.kind === "new_shift") {
    return (
      <NewShift
        local={local}
        pairing={{ hostId, deviceId }}
        online={online}
        source={source}
        create={create}
        enter={enter}
        onEntered={entered}
        onHostError={hostError}
        onBack={() => setView({ kind: "list", notice: null })}
      />
    );
  }
  return (
    <ShiftList
      local={local}
      pairing={{ hostId, deviceId }}
      // Only a station reaches the floor with a line chosen; a device of
      // another kind (none pairs so in stage 2a) sees no shifts, and the host
      // refuses a shift it would create (`shift_line`): never a blank screen.
      lineId={lineId ?? ""}
      operator={operator}
      online={online}
      shiftReads={shiftReads}
      notice={view.notice}
      enter={enter}
      onEntered={entered}
      onHostError={hostError}
      onNew={() => setView({ kind: "new_shift" })}
      onSignOut={() => leave({ kind: "sign_out", notice: null })}
    />
  );
}
```

Правка `apps/standalone/src/app/App.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { FloorOperatorScreen } from "../floor/FloorOperatorScreen.js";
import { FloorStatusBar } from "../floor/FloorStatusBar.js";
import { OperatorSignIn } from "../floor/OperatorSignIn.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { FloorApp } from "../floor/FloorApp.js";
import { FloorStatusBar } from "../floor/FloorStatusBar.js";
import { OperatorSignIn } from "../floor/OperatorSignIn.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
            />
          ) : (
            <FloorOperatorScreen
              operator={view.operator}
              local={localDb}
              pairing={pairedStatus}
              sync={state.sync}
              {...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs })}
              onSignOut={operatorSignedOut}
            />
```

заменить на:

<!-- prettier-ignore -->
```tsx
            />
          ) : (
            <FloorApp
              // One session's screen: nothing of it outlives the sign-out.
              key={`${pairedStatus.hostId}:${pairedStatus.deviceId}:${view.operator.sessionId}`}
              operator={view.operator}
              local={localDb}
              device={pairedStatus}
              link={state.link}
              sync={state.sync}
              shiftReads={state.shiftReads}
              lineChangePending={state.pendingDevice !== null}
              enter={hostApi.enterShift}
              create={hostApi.createDeviceShift}
              source={scanner}
              {...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs })}
              dispatch={dispatch}
              onSignOut={operatorSignedOut}
            />
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент:

<!-- prettier-ignore -->
```json
    "operator": {
      "signedIn": "Вошёл: {{name}}, табельный номер {{login}}.",
      "stub": "Смены и сканирование продукции появятся в следующем обновлении.",
      "signOut": "Сменить оператора"
    },
    "shifts": {
```

заменить на:

<!-- prettier-ignore -->
```json
    "operator": {
      "signedIn": "Вошёл: {{name}}, табельный номер {{login}}.",
      "signOut": "Сменить оператора"
    },
    "work": {
      "title": "Смена {{number}}",
      "stub": "Сканирование кодов и сборка коробов появятся в следующем обновлении приложения.",
      "leaving": "Дожидаемся окончания начатой работы…",
      "leave": "Выйти из смены"
    },
    "shifts": {
```

Удалить `apps/standalone/src/floor/FloorOperatorScreen.tsx` (`git rm`).

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx test/work-gate.test.ts test/app.test.tsx`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  119 passed (119)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`
Expected: без ошибок и предупреждений (`touch` — свойство-функция: `FloorApp` передаёт его несвязанным).

- [ ] **Step 5: Мутации**

Run мутаций 1–6: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx`.

1. `apps/standalone/src/floor/FloorApp.tsx`: `      void gate.drain().then(() => {` → `      void Promise.resolve().then(() => {`. Expected: FAIL — «leaves the shift only once the work its screen tracks has settled», «signs the operator out as idle at once on the list, and after the work in a shift», «signs out an operator a sync took out of the copies, after the work», «leaves the shift for another line once the work is done, and nothing more».
2. Там же: удалить строку `        if (!alive.current) return;` (в `leave`). Expected: FAIL — «drops a leave whose work settles after the floor is gone».
3. Там же: `        if (copy.kind === "absent") leave({ kind: "sign_out", notice: "removed" });` → `        if (copy.kind === "absent") current.current.onSignOut("removed");`. Expected: FAIL — «signs out an operator a sync took out of the copies, after the work».
4. Там же: `        if (copy.status === "closed" && copy.localState === null) {` → `        if (copy.localState === null) {`. Expected: FAIL — среди прочих «stays in the shift after a read that finds it still open».
5. Там же: удалить строку `    if (lineChangePending && workShiftId !== null) leave({ kind: "line_changed" });`. Expected: FAIL — «leaves the shift for another line once the work is done, and nothing more».
6. Там же: `        touch={lock.touch}` → `        touch={() => undefined}`. Expected: FAIL — «starts the idle wait again when the work screen touches it (a COM scan presses no key)».
7. `apps/standalone/src/floor/work-gate.ts`: `      while (running.size > 0) {` → `      if (running.size > 0) {`. Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/work-gate.test.ts`. Expected: FAIL — «waits for work tracked while it already waits».
8. `apps/standalone/src/app/App.tsx` (защита задачи 4): удалить строку `    state.pendingRejection === null &&`. Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t "refuses the key"`. Expected: FAIL — «keeps the operator in the shift when the host refuses the key, and refuses the device once they leave» (связь не остановилась).

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-app.test.tsx apps/standalone/test/work-gate.test.ts apps/standalone/test/app.test.tsx`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `grep -rn "FloorOperatorScreen\|operatorStillAllowed\|floor.operator.stub" apps/standalone/src apps/standalone/test`; `git diff --check`; verbose-прогон и стенд с задержкой `setImmediate` для трёх файлов.
Expected: чисто; второй `grep` пуст; verbose без `stderr`; под стендом — те же 119.

- [ ] **Step 7: Commit**

Удаления двух файлов уже в индексе (`git rm` шагов 1 и 3); `git status --short` показывает их как `D`.

```bash
git add apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/floor/work-gate.ts apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/floor/idle-lock.ts apps/standalone/src/floor/sign-in.ts apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-app.test.tsx apps/standalone/test/work-gate.test.ts apps/standalone/test/app.test.tsx
git commit -m "feat(standalone): the floor after a sign-in is a machine of shifts, and leaving a shift waits for its work" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Строка состояния, «забывание» с неотправленным, защита копий организации и линий

- `FloorStatusBar` (§5.7.9): имя устройства (`DeviceStatus.deviceName`; нет — не показывается), номер смены, в которой работает оператор (из копий по `floorWork.shiftId`; после выхода — не показывается, и прочитанный раньше номер другой смены не остаётся), предупреждение `deviceNotSaved` в своей вежливой живой области, которая есть на экране до предупреждения (иначе его не услышат). `HostStatusLine` — по-прежнему внутри строки.
- Экраны отказа устройства, другого хоста и повреждённой настройки (`src/app/screens.tsx`): отказ «забывания» `unsent_facts` (план 2a4) больше не тупик. `App` считает неотправленные записи (`countUnsentRecords`, `src/local/outbox.ts`: этого подключения или, при нечитаемом `device.json`, всех — как оболочка) и показывает «На этом компьютере не отправлено на хост записей смен: N. …» с кнопкой «Сбросить всё равно» (`forget({ keepUnsent: true })`, вопрос В7, выход Б). Не прочитанное число — та же фраза без числа.
- `src/local/reference-sync.ts`: `org_profile` и `lines` тоже не вставляют запись, чья более новая ревизия ждёт в карантине (`notQuarantinedNewer`): цех называет их и читает пояс и шаблон по умолчанию организации (перенесённое из 1f2, §12). Версия набора сущностей не меняется.

**Files:**

- Create: `apps/standalone/src/local/outbox.ts`
- Modify: `apps/standalone/src/floor/FloorStatusBar.tsx`, `apps/standalone/src/app/screens.tsx`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/local/reference-sync.ts`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`
- Test: `apps/standalone/test/floor-status-bar.test.tsx`, `apps/standalone/test/app.test.tsx`, `apps/standalone/test/reference-sync.test.ts` (Modify); `apps/standalone/test/outbox.test.ts` (Create)

**Interfaces:**

- Consumes: `readShiftCopy` (задача 3); `ShellState.floorWork`, `deviceNotSaved` (задача 4); `DeviceApi.forget(options?: { keepUnsent?: boolean })`, `DeviceError` `unsent_facts` (план 2a4); `outbox` (задача 1).
- Produces:
  - `src/local/outbox.ts`: `countUnsentRecords(local, pairing: Pairing | null): Promise<number | null>`;
  - `FloorStatusBarProps.deviceName: string | null`, `shiftId: string | null`, `deviceNotSaved: boolean`;
  - `src/app/screens.tsx`: `interface UnsentRecords { records: number | null }`; свойства `unsent: UnsentRecords | null` и `onConfirm: () => void` у `ConfigErrorScreen`, `DeviceRejectedScreen`, `OtherHostScreen`;
  - ключи `floor.status.device`, `floor.status.shift`, `floor.status.deviceNotSaved`, `shell.unsent.*`; класс `floor-status__health`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/outbox.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import type { LocalExecutor } from "../src/local/executor.js";
import { countUnsentRecords } from "../src/local/outbox.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";

function record(id: string, deviceId: string, acked: boolean) {
  return {
    sql:
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, " +
      "outcome, acked_at) VALUES (?, ?, ?, 'scan', 'shift-1', '{}', ?, ?, ?)",
    values: [
      id,
      HOST_ID,
      deviceId,
      "2026-10-09T08:00:00.000Z",
      acked ? "accepted" : null,
      acked ? "2026-10-09T08:00:01.000Z" : null,
    ],
  };
}

describe("the unsent records of the outbox", () => {
  it("are counted for the pairing, or for every pairing when it is unknown", async () => {
    const { executor } = openLocalDb();
    expect(await countUnsentRecords(executor, PAIRING)).toBe(0);
    await executor.transaction([
      record("a", DEVICE_ID, false),
      record("b", DEVICE_ID, false),
      record("c", DEVICE_ID, true),
      record("d", OTHER_DEVICE, false),
    ]);
    expect(await countUnsentRecords(executor, PAIRING)).toBe(2);
    expect(await countUnsentRecords(executor, null)).toBe(3);
  });

  it("are unknown when the database cannot be read", async () => {
    const failing: LocalExecutor = {
      query: () => Promise.reject(new Error("disk")),
      transaction: () => Promise.reject(new Error("disk")),
    };
    expect(await countUnsentRecords(failing, PAIRING)).toBeNull();
  });
});
```

Правка `apps/standalone/test/floor-status-bar.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

```

заменить на:

<!-- prettier-ignore -->
```tsx
import { readFileSync } from "node:fs";

import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
import { readFloorPlace } from "../src/floor/floor-status.js";
import { FloorStatusBar, type FloorStatusBarProps } from "../src/floor/FloorStatusBar.js";
import type { ChangeItem, HostStatus } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { readFloorPlace } from "../src/floor/floor-status.js";
import { FloorStatusBar, type FloorStatusBarProps } from "../src/floor/FloorStatusBar.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import { enteredShiftSchema, type ChangeItem, type HostStatus } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
import { openLocalDb } from "./support/local-db.js";

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const OTHER_DEVICE = "1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
const ENTERED = enteredShiftSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/device-shift-entered.json", testModuleUrl), "utf8"),
  ),
);
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const OTHER_DEVICE = "1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6";
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
        link={null}
        sync={SYNCED}
        {...props}
      />
```

заменить на:

<!-- prettier-ignore -->
```tsx
        link={null}
        sync={SYNCED}
        deviceName={null}
        shiftId={null}
        deviceNotSaved={false}
        {...props}
      />
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
    expect(screen.queryByText("Линия фасовки 1")).toBeNull();
  });
});
```

заменить на:

<!-- prettier-ignore -->
```tsx
    expect(screen.queryByText("Линия фасовки 1")).toBeNull();
  });

  it("names the device, and the shift the operator works in while they work in it", async () => {
    const local = await synced([ORG, line("Линия розлива 2")]);
    await keepEnteredShift(local, PAIRING, ENTERED, "2026-10-09T06:00:00.000Z", 1_790_000_000_000);
    const view = render(bar({ local, deviceName: "Станция у окна", shiftId: ENTERED.id }));
    const region = screen.getByRole("region", { name: "Строка состояния цеха" });
    expect(within(region).getByText("Станция у окна")).toBeTruthy();
    expect(await within(region).findByText("OCT26-004")).toBeTruthy();
    view.rerender(bar({ local, deviceName: "Станция у окна", shiftId: null }));
    expect(within(region).queryByText("OCT26-004")).toBeNull();
    expect(within(region).queryByText("Смена")).toBeNull();
  });

  it("names no device for a pairing file that has no name", async () => {
    render(bar({ local: await synced([ORG]) }));
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
    expect(screen.queryByText("Устройство")).toBeNull();
  });

  it("warns while a change the office made to the device was not saved here", async () => {
    const local = await synced([ORG]);
    const view = render(bar({ local, deviceNotSaved: true }));
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
    expect(
      screen.getByText(
        "Офис изменил это устройство, но изменение не удалось сохранить на этом компьютере: станция работает по-прежнему. Освободите место на диске или обратитесь к администратору.",
      ),
    ).toBeTruthy();
    view.rerender(bar({ local, deviceNotSaved: false }));
    expect(screen.queryByText(/не удалось сохранить на этом компьютере/)).toBeNull();
  });
});
```

Правка `apps/standalone/test/app.test.tsx`:

Фрагмент:

<!-- prettier-ignore -->
```tsx
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget).toHaveBeenCalledTimes(1);
    expect(device.pairLocally).toHaveBeenCalledTimes(1);
  });

  it("shows a repair failure on the config-error screen and keeps it visible", async () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget).toHaveBeenCalledTimes(1);
    expect(device.pairLocally).toHaveBeenCalledTimes(1);
  });

  /** Outbox records without a receipt: two of this pairing's and one of another's. */
  function withUnsentRecords() {
    const { db, executor } = openLocalDb();
    const insert = db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
        "VALUES (?, ?, ?, 'scan', 'shift-1', '{}', '2026-10-09T08:00:00.000Z')",
    );
    insert.run("a", HOST_ID, DEVICE_ID);
    insert.run("b", HOST_ID, DEVICE_ID);
    insert.run("c", HOST_ID, OTHER_HOST_ID);
    return executor;
  }

  it("asks before it forgets a rejected device with records not yet sent, and keeps them", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    device.forget.mockRejectedValueOnce(new DeviceError("unsent_facts", "unsent"));
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      connection: link.connection,
      local: withUnsentRecords(),
    });
    await screen.findByText("Цех");
    await link.status({ ...ONLINE, lastError: "key_rejected", seq: 2 });
    fireEvent.click(await screen.findByRole("button", { name: "Подключить заново" }));
    expect(
      await screen.findByText(
        "На этом компьютере не отправлено на хост записей смен: 2. После сброса подключения они останутся на диске этого ПК, но отправить их на хост будет нельзя.",
      ),
    ).toBeTruthy();
    expect(device.forget.mock.calls).toEqual([[undefined]]);
    fireEvent.click(screen.getByRole("button", { name: "Сбросить всё равно" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget.mock.calls).toEqual([[undefined], [{ keepUnsent: true }]]);
  });

  it("counts the records of every pairing when the device config cannot be read", async () => {
    const device = fakeDevice(new DeviceError("config_unreadable", "broken"));
    device.forget.mockRejectedValueOnce(new DeviceError("unsent_facts", "unsent"));
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      local: withUnsentRecords(),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Сбросить подключение" }));
    expect(await screen.findByText(/не отправлено на хост записей смен: 3\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить всё равно" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
  });

  it("shows a repair failure on the config-error screen and keeps it visible", async () => {
```

Правка `apps/standalone/test/reference-sync.test.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
  });

  it("applies a revision larger than a page's 1 MiB, a template's tombstone and 5000 products, in one batch", async () => {
    const { db, executor } = openLocalDb();
```

заменить на:

<!-- prettier-ignore -->
```ts
  });

  it("keeps an older organization or line out while its newer revision waits in quarantine, even from a stale run of a forgotten pairing with the same host", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(20, [{ ...ORG, rev: 20 }, line(LINE_1, 20, "Линия 1")]) }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    // The next sync's fetch stays in flight across `device_forget`.
    let resolve: ((value: ChangesResponse) => void) | undefined;
    const held = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolveFetch) => {
          resolve = resolveFetch;
        }),
    );
    const stale = syncReferences({
      changes: held,
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    await vi.waitFor(() => expect(held).toHaveBeenCalledWith(20));
    // `device_forget` clears every table; the device pairs again with the
    // same host, whose first sync quarantines the newer revisions.
    for (const table of COPY_TABLES) db.prepare(`DELETE FROM ${table}`).run();
    await expect(
      syncReferences({
        changes: feed({
          0: page(40, [
            { ...ORG, rev: 35, data: { ...(ORG.data as object), timeZone: 3 } },
            brokenLine(LINE_1, 36),
          ]),
        }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 40, quarantined: 2 });
    // The forgotten pairing's page lands last: the quarantine keeps the older
    // organization and line out, as it does for people and the catalog.
    resolve?.(page(30, [{ ...ORG, rev: 25 }, line(LINE_1, 25, "Линия старая")]));
    await expect(stale).resolves.toEqual({ kind: "synced", rev: 30, quarantined: 2 });
    expect(tables(db).org).toEqual([]);
    expect(tables(db).lines).toEqual([]);
  });

  it("applies a revision larger than a page's 1 MiB, a template's tombstone and 5000 products, in one batch", async () => {
    const { db, executor } = openLocalDb();
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx test/outbox.test.ts test/app.test.tsx test/reference-sync.test.ts`
Expected: FAIL — `Tests  5 failed | 174 passed (179)` и упавший файл `test/outbox.test.ts` (`Failed to resolve import "../src/local/outbox.js"`): «names the device, and the shift the operator works in while they work in it», «warns while a change the office made to the device was not saved here», «asks before it forgets a rejected device with records not yet sent, and keeps them», «counts the records of every pairing when the device config cannot be read», «keeps an older organization or line out while its newer revision waits in quarantine, …» (`expected [ { id: '1', …(6) } ] to deeply equal []`).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/local/outbox.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import type { LocalExecutor } from "./executor.js";
import type { Pairing } from "./reference-sync.js";

const countRow = z.object({ n: z.number().int().nonnegative() });

/**
 * How many outbox records have no receipt (`acked_at IS NULL`, migration
 * `0006`): the pairing's, or with `null` (the pairing file is unreadable)
 * every pairing's, as the shell counts them before a forget (`device_forget`,
 * `unsent_facts`). `null` when the database cannot be read.
 */
export async function countUnsentRecords(
  local: LocalExecutor,
  pairing: Pairing | null,
): Promise<number | null> {
  try {
    const [row] =
      pairing === null
        ? await local.query("SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL", [], countRow)
        : await local.query(
            "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL AND host_id = ? AND device_id = ?",
            [pairing.hostId, pairing.deviceId],
            countRow,
          );
    return row?.n ?? 0;
  } catch {
    return null;
  }
}
```

Правка `apps/standalone/src/local/reference-sync.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
 * their badges carry it, since an older record would bring back access, and
 * the catalog's copies too (products, templates, category defaults), since an
 * older layout or default must not take the place the delete emptied. Not
 * `org_profile`, `site` and `lines` (plan 2a): `site`'s salt never changes
 * after the wizard.
 */
function notQuarantinedNewer(entity: string): string {
```

заменить на:

<!-- prettier-ignore -->
```ts
 * their badges carry it, since an older record would bring back access, and
 * the catalog's copies too (products, templates, category defaults), since an
 * older layout or default must not take the place the delete emptied, and
 * the organization and the lines since plan 2a5, whose floor names them and
 * reads the organization's zone and default template. Not `site`: its salt
 * never changes after the wizard.
 */
function notQuarantinedNewer(entity: string): string {
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
        "default_box_template_id, default_pallet_template_id, default_duplicate_template_id, " +
        "rev) " +
        "SELECT value ->> 'id', value ->> 'name', value ->> 'inn', value ->> 'gln', " +
        "value ->> 'gs1Prefixes', value ->> 'timeZone', value ->> 'defaultBoxTemplateId', " +
        "value ->> 'defaultPalletTemplateId', value ->> 'defaultDuplicateTemplateId', " +
        "value ->> 'rev' " +
        "FROM json_each(?) WHERE true " +
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, inn = excluded.inn, " +
        "gln = excluded.gln, gs1_prefixes = excluded.gs1_prefixes, " +
```

заменить на:

<!-- prettier-ignore -->
```ts
        "default_box_template_id, default_pallet_template_id, default_duplicate_template_id, " +
        "rev) " +
        "SELECT r.value ->> 'id', r.value ->> 'name', r.value ->> 'inn', r.value ->> 'gln', " +
        "r.value ->> 'gs1Prefixes', r.value ->> 'timeZone', r.value ->> 'defaultBoxTemplateId', " +
        "r.value ->> 'defaultPalletTemplateId', r.value ->> 'defaultDuplicateTemplateId', " +
        "r.value ->> 'rev' " +
        "FROM json_each(?) AS r " +
        notQuarantinedNewer("org_profile") +
        " " +
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, inn = excluded.inn, " +
        "gln = excluded.gln, gs1_prefixes = excluded.gs1_prefixes, " +
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
      upsert:
        "INSERT INTO ref_lines (id, name, archived, rev) " +
        "SELECT value ->> 'id', value ->> 'name', value ->> 'archived', value ->> 'rev' " +
        "FROM json_each(?) WHERE true " +
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, archived = excluded.archived, " +
        "rev = excluded.rev " +
```

заменить на:

<!-- prettier-ignore -->
```ts
      upsert:
        "INSERT INTO ref_lines (id, name, archived, rev) " +
        "SELECT r.value ->> 'id', r.value ->> 'name', r.value ->> 'archived', r.value ->> 'rev' " +
        "FROM json_each(?) AS r " +
        notQuarantinedNewer("lines") +
        " " +
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, archived = excluded.archived, " +
        "rev = excluded.rev " +
```

Правка `apps/standalone/src/floor/FloorStatusBar.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { HostStatusLine } from "../app/HostStatusLine.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert } from "@markiro/ui";

import { HostStatusLine } from "../app/HostStatusLine.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
import type { Pairing } from "../local/reference-sync.js";
import { readFloorPlace, type FloorPlace } from "./floor-status.js";
import type { FloorOperator } from "./sign-in.js";

```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { Pairing } from "../local/reference-sync.js";
import { readFloorPlace, type FloorPlace } from "./floor-status.js";
import { readShiftCopy } from "./shifts/shift-copies.js";
import type { FloorOperator } from "./sign-in.js";

```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  link: HostStatus | null;
  sync: SyncState;
}

```

заменить на:

<!-- prettier-ignore -->
```tsx
  link: HostStatus | null;
  sync: SyncState;
  /** This device's name as the host has it (`DeviceStatus.deviceName`); `null` for an older pairing file. */
  deviceName: string | null;
  /** The shift the operator works in (`ShellState.floorWork`), or `null`. */
  shiftId: string | null;
  /** The office's change of this device was not saved on this computer (`ShellState.deviceNotSaved`). */
  deviceNotSaved: boolean;
}

```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
 * organization and the line from the local copies, the operator, and the
 * link to the host with the health of the copies (`HostStatusLine`). It sits
 * above the sign-in screen and the stub alike, as a labelled region (the app's
 * `main` holds it, so a `header` would not be a landmark), and holds nothing
 * to press.
 * The device's own name is not here: the shell does not keep it
 * (`DeviceStatus` has none). A failed read of the copies leaves the names
 * out; the floor works on.
 */
export function FloorStatusBar({
```

заменить на:

<!-- prettier-ignore -->
```tsx
 * organization and the line from the local copies, the operator, and the
 * link to the host with the health of the copies (`HostStatusLine`). It sits
 * above the sign-in screen and the shifts alike, as a labelled region (the
 * app's `main` holds it, so a `header` would not be a landmark), and holds
 * nothing to press. Plan 2a5 adds the device's own name, the number of the
 * shift the operator works in, and a warning while a change the office made
 * to this device (its line, its name) could not be saved on this computer,
 * so the station still works by the old one. A failed read of the copies
 * leaves the names out; the floor works on.
 */
export function FloorStatusBar({
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
  link,
  sync,
}: FloorStatusBarProps) {
  const { t } = useTranslation();
  const [place, setPlace] = useState<FloorPlace>({ organization: null, line: null });
  const { hostId, deviceId } = pairing;

  useEffect(() => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  link,
  sync,
  deviceName,
  shiftId,
  deviceNotSaved,
}: FloorStatusBarProps) {
  const { t } = useTranslation();
  const [place, setPlace] = useState<FloorPlace>({ organization: null, line: null });
  const [shift, setShift] = useState<{ id: string; number: string } | null>(null);
  const { hostId, deviceId } = pairing;

  useEffect(() => {
    if (shiftId === null) return;
    let cancelled = false;
    readShiftCopy(local, { hostId, deviceId }, shiftId).then(
      (copy) => {
        if (!cancelled) setShift(copy === null ? null : { id: copy.id, number: copy.number });
      },
      () => {
        if (!cancelled) setShift(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, shiftId]);
  // Only the number of the shift on screen: none after it is left.
  const shiftNumber = shift !== null && shift.id === shiftId ? shift.number : null;

  useEffect(() => {
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
    <section className="floor-status" aria-label={t("floor.status.label")}>
      <dl className="floor-status__identity">
        {place.organization !== null && (
          <div className="floor-status__item">
```

заменить на:

<!-- prettier-ignore -->
```tsx
    <section className="floor-status" aria-label={t("floor.status.label")}>
      <dl className="floor-status__identity">
        {deviceName !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.device")}</dt>
            <dd>{deviceName}</dd>
          </div>
        )}
        {place.organization !== null && (
          <div className="floor-status__item">
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
          </dd>
        </div>
      </dl>
      <HostStatusLine status={link} sync={sync} />
    </section>
  );
```

заменить на:

<!-- prettier-ignore -->
```tsx
          </dd>
        </div>
        {shiftNumber !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.shift")}</dt>
            <dd>{shiftNumber}</dd>
          </div>
        )}
      </dl>
      <div className="floor-status__health">
        <HostStatusLine status={link} sync={sync} />
        {/* Its own polite region, there before the warning, so it is heard once. */}
        <div aria-live="polite">
          {deviceNotSaved && <Alert tone="warn">{t("floor.status.deviceNotSaved")}</Alert>}
        </div>
      </div>
    </section>
  );
```

Правка `apps/standalone/src/app/screens.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
}

export function ConfigErrorScreen({
  busy,
  error,
  onReset,
}: {
  busy: boolean;
  error: DeviceErrorCode | null;
  onReset: () => void;
}) {
  const { t } = useTranslation();
```

заменить на:

<!-- prettier-ignore -->
```tsx
}

/** A forget the shell refused for records not yet sent (`unsent_facts`), and how many. */
export interface UnsentRecords {
  records: number | null;
}

/**
 * The forget the shell refused while this device holds shift records the
 * host has not acknowledged (question В7): it says how many and lets a person
 * go ahead; the records stay on this PC's disk (`keepUnsent`). A rejected
 * device can send nothing more, so waiting for them would trap it here.
 */
function UnsentNotice({
  unsent,
  busy,
  onConfirm,
}: {
  unsent: UnsentRecords | null;
  busy: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (unsent === null) return null;
  return (
    <>
      <Alert tone="warn">
        {unsent.records === null
          ? t("shell.unsent.bodyUnknown")
          : t("shell.unsent.body", { records: unsent.records })}
      </Alert>
      <Button variant="destructive" onClick={onConfirm} loading={busy}>
        {t("shell.unsent.confirm")}
      </Button>
    </>
  );
}

export function ConfigErrorScreen({
  busy,
  error,
  unsent,
  onReset,
  onConfirm,
}: {
  busy: boolean;
  error: DeviceErrorCode | null;
  unsent: UnsentRecords | null;
  onReset: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
      <p>{t("shell.configError.body")}</p>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <Button onClick={onReset} loading={busy}>
        {t("shell.configError.reset")}
```

заменить на:

<!-- prettier-ignore -->
```tsx
      <p>{t("shell.configError.body")}</p>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <UnsentNotice unsent={unsent} busy={busy} onConfirm={onConfirm} />
      <Button onClick={onReset} loading={busy}>
        {t("shell.configError.reset")}
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  busy,
  error,
  onRepair,
}: {
  reason: RejectionReason;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  busy,
  error,
  unsent,
  onRepair,
  onConfirm,
}: {
  reason: RejectionReason;
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  remoteAddress: string | null;
  busy: boolean;
  error: DeviceErrorCode | null;
  onRepair: () => void;
}) {
  const { t } = useTranslation();
  let explanation = t("shell.deviceRejected.keyRejected");
```

заменить на:

<!-- prettier-ignore -->
```tsx
  remoteAddress: string | null;
  busy: boolean;
  error: DeviceErrorCode | null;
  unsent: UnsentRecords | null;
  onRepair: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  let explanation = t("shell.deviceRejected.keyRejected");
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
      <Alert tone="warn">{explanation}</Alert>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <Button onClick={onRepair} loading={busy}>
        {t("shell.deviceRejected.repair")}
```

заменить на:

<!-- prettier-ignore -->
```tsx
      <Alert tone="warn">{explanation}</Alert>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <UnsentNotice unsent={unsent} busy={busy} onConfirm={onConfirm} />
      <Button onClick={onRepair} loading={busy}>
        {t("shell.deviceRejected.repair")}
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
  busy,
  error,
  onRepair,
}: {
  hostAddress: string;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  busy,
  error,
  unsent,
  onRepair,
  onConfirm,
}: {
  hostAddress: string;
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
  busy: boolean;
  error: DeviceErrorCode | null;
  onRepair: () => void;
}) {
  const { t } = useTranslation();
```

заменить на:

<!-- prettier-ignore -->
```tsx
  busy: boolean;
  error: DeviceErrorCode | null;
  unsent: UnsentRecords | null;
  onRepair: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
```

Фрагмент 8:

<!-- prettier-ignore -->
```tsx
      <Alert tone="warn">{t("shell.otherHost.body", { address: hostAddress })}</Alert>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <Button onClick={onRepair} loading={busy}>
        {t("shell.otherHost.repair")}
```

заменить на:

<!-- prettier-ignore -->
```tsx
      <Alert tone="warn">{t("shell.otherHost.body", { address: hostAddress })}</Alert>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <UnsentNotice unsent={unsent} busy={busy} onConfirm={onConfirm} />
      <Button onClick={onRepair} loading={busy}>
        {t("shell.otherHost.repair")}
```

Правка `apps/standalone/src/app/App.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
} from "../host/protocol.js";
import { createTauriLocalExecutor, type LocalExecutor } from "../local/executor.js";
import { Office } from "../office/Office.js";
import { OfficeLogin } from "../office/OfficeLogin.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
} from "../host/protocol.js";
import { createTauriLocalExecutor, type LocalExecutor } from "../local/executor.js";
import { countUnsentRecords } from "../local/outbox.js";
import { Office } from "../office/Office.js";
import { OfficeLogin } from "../office/OfficeLogin.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [repairState, setRepairState] = useState<"idle" | "busy" | DeviceErrorCode>("idle");
  const view = nextShellView(state, address);
  const localName = t("device.localName");
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [repairState, setRepairState] = useState<"idle" | "busy" | DeviceErrorCode>("idle");
  // A forget the shell refused for records not yet sent, and how many there are.
  const [unsent, setUnsent] = useState<{ records: number | null } | null>(null);
  const view = nextShellView(state, address);
  const localName = t("device.localName");
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  }, []);

  const repair = useCallback(() => {
    setRepairState("busy");
    deviceApi.forget().then(
      () => {
        setRepairState("idle");
        dispatch({ type: "forgotten" });
        retryProbe();
      },
      (error: unknown) => {
        // The config could not be removed; this screen stays and offers the
        // same action again, now explaining why it did not work.
        setRepairState(error instanceof DeviceError ? error.code : "unreachable");
      },
    );
  }, [deviceApi, retryProbe]);

  const unpaired = state.device.kind === "ready" && state.device.status === null;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }, []);

  const forgetHostId = pairedStatus?.hostId ?? null;
  const forgetDeviceId = pairedStatus?.deviceId ?? null;
  const forget = useCallback(
    (keepUnsent: boolean) => {
      setRepairState("busy");
      deviceApi.forget(keepUnsent ? { keepUnsent: true } : undefined).then(
        () => {
          setRepairState("idle");
          setUnsent(null);
          dispatch({ type: "forgotten" });
          retryProbe();
        },
        (error: unknown) => {
          if (error instanceof DeviceError && error.code === "unsent_facts") {
            // A rejected device can send nothing more, so a person decides,
            // knowing how many (question В7): the records stay on this PC. The
            // pairing's own, or every pairing's when the file is unreadable,
            // as the shell counts them.
            const pairing =
              forgetHostId === null || forgetDeviceId === null
                ? null
                : { hostId: forgetHostId, deviceId: forgetDeviceId };
            void countUnsentRecords(localDb, pairing).then((records) => {
              setUnsent({ records });
              setRepairState("idle");
            });
            return;
          }
          // The config could not be removed; this screen stays and offers the
          // same action again, now explaining why it did not work.
          setRepairState(error instanceof DeviceError ? error.code : "unreachable");
        },
      );
    },
    [deviceApi, retryProbe, localDb, forgetHostId, forgetDeviceId],
  );
  const repair = useCallback(() => forget(false), [forget]);
  const confirmRepair = useCallback(() => forget(true), [forget]);

  const unpaired = state.device.kind === "ready" && state.device.status === null;
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
      {view.kind === "loading" && <WaitScreen messageKey="shell.loading" />}
      {view.kind === "config_error" && (
        <ConfigErrorScreen busy={repairBusy} error={repairError} onReset={repair} />
      )}
      {view.kind === "host_missing" && (
```

заменить на:

<!-- prettier-ignore -->
```tsx
      {view.kind === "loading" && <WaitScreen messageKey="shell.loading" />}
      {view.kind === "config_error" && (
        <ConfigErrorScreen
          busy={repairBusy}
          error={repairError}
          unsent={unsent}
          onReset={repair}
          onConfirm={confirmRepair}
        />
      )}
      {view.kind === "host_missing" && (
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
          remoteAddress={remoteAddress}
          busy={repairBusy}
          error={repairError}
          onRepair={repair}
        />
      )}
      {view.kind === "other_host" && (
```

заменить на:

<!-- prettier-ignore -->
```tsx
          remoteAddress={remoteAddress}
          busy={repairBusy}
          error={repairError}
          unsent={unsent}
          onRepair={repair}
          onConfirm={confirmRepair}
        />
      )}
      {view.kind === "other_host" && (
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
          busy={repairBusy}
          error={repairError}
          onRepair={repair}
        />
      )}
```

заменить на:

<!-- prettier-ignore -->
```tsx
          busy={repairBusy}
          error={repairError}
          unsent={unsent}
          onRepair={repair}
          onConfirm={confirmRepair}
        />
      )}
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
            link={state.link}
            sync={state.sync}
          />
          {view.kind === "floor" ? (
```

заменить на:

<!-- prettier-ignore -->
```tsx
            link={state.link}
            sync={state.sync}
            deviceName={pairedStatus.deviceName}
            shiftId={state.floorWork?.shiftId ?? null}
            deviceNotSaved={state.deviceNotSaved}
          />
          {view.kind === "floor" ? (
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
      "retry": "Повторить"
    },
    "deviceRejected": {
      "title": "Хост не принимает это устройство",
```

заменить на:

<!-- prettier-ignore -->
```json
      "retry": "Повторить"
    },
    "unsent": {
      "body": "На этом компьютере не отправлено на хост записей смен: {{records}}. После сброса подключения они останутся на диске этого ПК, но отправить их на хост будет нельзя.",
      "bodyUnknown": "На этом компьютере есть записи смен, не отправленные на хост. После сброса подключения они останутся на диске этого ПК, но отправить их на хост будет нельзя.",
      "confirm": "Сбросить всё равно"
    },
    "deviceRejected": {
      "title": "Хост не принимает это устройство",
```

Фрагмент 2:

<!-- prettier-ignore -->
```json
      "operator": "Оператор",
      "nobody": "Никто не вошёл",
      "operatorValue": "{{name}}, табельный номер {{login}}"
    },
    "operator": {
```

заменить на:

<!-- prettier-ignore -->
```json
      "operator": "Оператор",
      "nobody": "Никто не вошёл",
      "operatorValue": "{{name}}, табельный номер {{login}}",
      "device": "Устройство",
      "shift": "Смена",
      "deviceNotSaved": "Офис изменил это устройство, но изменение не удалось сохранить на этом компьютере: станция работает по-прежнему. Освободите место на диске или обратитесь к администратору."
    },
    "operator": {
```

Правка `apps/standalone/src/app/shell.css`:

Фрагмент:

<!-- prettier-ignore -->
```text
  margin: 0;
  font: var(--floor-body-strong);
}

```

заменить на:

<!-- prettier-ignore -->
```text
  margin: 0;
  font: var(--floor-body-strong);
}

.floor-status__health {
  display: grid;
  gap: 8px;
}

```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx test/outbox.test.ts test/app.test.tsx test/reference-sync.test.ts`
Expected: PASS — `Test Files  4 passed (4)`, `Tests  181 passed (181)`.

- [ ] **Step 5: Мутации**

1. `apps/standalone/src/app/App.tsx`: `      deviceApi.forget(keepUnsent ? { keepUnsent: true } : undefined).then(` → `      deviceApi.forget(undefined).then(`. Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t records`. Expected: FAIL — «asks before it forgets a rejected device with records not yet sent, and keeps them».
2. `apps/standalone/src/floor/FloorStatusBar.tsx`: `  const shiftNumber = shift !== null && shift.id === shiftId ? shift.number : null;` → `  const shiftNumber = shift !== null ? shift.number : null;`. Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx`. Expected: FAIL — «names the device, and the shift the operator works in while they work in it».
3. `apps/standalone/src/local/outbox.ts`: `            "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL AND host_id = ? AND device_id = ?",` → `            "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL AND ? IS NOT NULL AND ? IS NOT NULL",`. Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/outbox.test.ts test/app.test.tsx -t records`. Expected: FAIL — «are counted for the pairing, or for every pairing when it is unknown» и «asks before it forgets a rejected device …».
4. `apps/standalone/src/local/reference-sync.ts`: `        notQuarantinedNewer("lines") +` → `        "WHERE true" +`. Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts`. Expected: FAIL — «keeps an older organization or line out while its newer revision waits in quarantine, …».
5. Там же: `        notQuarantinedNewer("org_profile") +` → `        "WHERE true" +`. Тот же Run. Expected: FAIL — тот же тест.

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src apps/standalone/test`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`; verbose-прогон и стенд с задержкой `setImmediate` для четырёх файлов.
Expected: чисто; verbose без `stderr`; под стендом — те же 181.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/local/outbox.ts apps/standalone/src/local/reference-sync.ts apps/standalone/src/floor/FloorStatusBar.tsx apps/standalone/src/app/screens.tsx apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/floor-status-bar.test.tsx apps/standalone/test/outbox.test.ts apps/standalone/test/app.test.tsx apps/standalone/test/reference-sync.test.ts
git commit -m "feat(standalone): the floor's status names the device and the shift, a rejected station with unsent records forgets on a confirmation, and the copies keep an older organization or line out" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Документы — `AGENTS.md` и уточнения спецификации

`apps/standalone/AGENTS.md`: «Local database» — данные устройства миграции `0006` и их правила, внешних ключей нет (тест проверяет), экраны отказа с подтверждением при неотправленном; «Reference sync» — защита `org_profile` и `lines`; «Operators and badges» — номер сеанса и обновление имени; «App shell» — `FloorApp`, чтение смен в `useHostLink`, `deviceNotSaved`, строка состояния; «Shifts» — сторона станции (список, вход, новая смена, выход из смены, ждущие отказ и смена линии); «Verification» — ручной список цеха. Спецификация этапа получает раздел «Уточнения плана 2a5» (номер — следующий свободный после разделов планов 2a2–2a4).

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`

**Interfaces:**

- Consumes: всё, что сделали задачи 1–8.
- Produces: тексты документов; кода нет.

- [ ] **Step 1: Правки документов**

Правка `apps/standalone/AGENTS.md`:

Фрагмент 1:

<!-- prettier-ignore -->
```markdown
counts; those screens are not reachable from a working floor (they come only
when the host refused the device or its config is unreadable), and kiosk mode
(plan 1f2, see "App shell") leaves them reachable on purpose.

The webview reaches it only through `LocalExecutor` (`src/local/executor.ts`);
```

заменить на:

<!-- prettier-ignore -->
```markdown
counts; those screens are not reachable from a working floor (they come only
when the host refused the device or its config is unreadable), and kiosk mode
(plan 1f2, see "App shell") leaves them reachable on purpose. While this
device holds shift records the host has not acknowledged, the shell refuses
that forget (`unsent_facts`); since plan 2a5 those screens then say how many
records there are (`countUnsentRecords`, `src/local/outbox.ts`: the
pairing's, or every pairing's when the pairing file is unreadable) and offer
«Сбросить всё равно», which forgets with `keepUnsent: true` (question В7,
exit Б): a rejected device can send nothing more, so waiting would trap it.

The webview reaches it only through `LocalExecutor` (`src/local/executor.ts`);
```

Фрагмент 2:

<!-- prettier-ignore -->
```markdown
settings (plan 2a7), which outlive any pairing. `tests/local_db.rs` fails on
a table without a class and on a class that names no table, so a plan that
adds a table classes it in the same change. No table has a foreign key, and
none may get one across classes: a forget would then fail at its commit.
`LocalDb::clear_copies` deletes the rows of the disposable tables only, in
one writer transaction, and in that same transaction first counts the outbox
```

заменить на:

<!-- prettier-ignore -->
```markdown
settings (plan 2a7), which outlive any pairing. `tests/local_db.rs` fails on
a table without a class and on a class that names no table, so a plan that
adds a table classes it in the same change. No table has a foreign key (the
same test checks): one would make a forget fail at its delete or, with
`ON DELETE CASCADE` or `SET NULL`, silently change rows a forget keeps.
`LocalDb::clear_copies` deletes the rows of the disposable tables only, in
one writer transaction, and in that same transaction first counts the outbox
```

Фрагмент 3:

<!-- prettier-ignore -->
```markdown
no test pins that half. If clearing or moving fails, the command fails with
`storage` and the pairing stays for another try.

## Writes
```

заменить на:

<!-- prettier-ignore -->
```markdown
no test pins that half. If clearing or moving fails, the command fails with
`storage` and the pairing stays for another try.

This device's own records (`src-tauri/migrations/0006_floor_production.sql`,
plan 2a5; all `DeviceData`): `floor_shifts`, `floor_sscc_blocks`,
`floor_block_requests`, `floor_boxes`, `floor_codes`, `floor_scans`,
`floor_exceptions` and `outbox`. Every row carries the pairing it was written
under (`host_id`, `device_id`), and the floor reads only the current
pairing's rows, so records a forget kept stay on disk for support without
reaching another pairing's screens (`floor_shifts` and `floor_codes` are
keyed by pairing too: a re-pair to the same host sees the same shift ids).
The schema holds what the facts protocol (plan 2a2) needs: an `invalid` scan
keeps no text, only its length and what it looked like (a `CHECK`, decision
15); a box is open without an SSCC or closed with its SSCC, block and serial;
one open box per shift and pairing; an SSCC on one box under any pairing (a
second box with a printed number is a duplicate label); a block's cursor
(`next_serial`) stays within the block and moves only by a compare-and-set
in the transaction that closes a box; an exception carries the fields of its
kind; an outbox record has its receipt and its time together. `outbox.kind`
has no `CHECK`, since the pilot's pallets add kinds and a SQLite `CHECK`
changes only by rebuilding the table; `seq` is a rowid alias, not
`AUTOINCREMENT`, which would add the unclassified `sqlite_sequence`.
`test/floor-schema.test.ts` pins these rules on node:sqlite.

## Writes
```

Фрагмент 4:

<!-- prettier-ignore -->
```markdown
  scanner deaf; `toStage` only drops the pending keys.
- The signed-in operator lives only in the shell's memory
  (`ShellState.operator`): identity, never a hash. The reducer stores a fresh
  object per sign-in, and the sign-out callbacks (the idle timer, the check
  after a sync, «Сменить оператора») are bound to that stored object, so a
  late timer of an earlier session of the same operator cannot end the next
  one. The session ends when the office opens (any way in,
  the bootstrap wizard's too), on a new pairing, a forget, a rejected device,
  another host, a change of the station's line, and on any host probe
```

заменить на:

<!-- prettier-ignore -->
```markdown
  scanner deaf; `toStage` only drops the pending keys.
- The signed-in operator lives only in the shell's memory
  (`ShellState.operator`): identity, never a hash, and the number of the
  session (`sessionId`, plan 2a5, decision 26): the reducer gives every
  sign-in the next number (`lastSessionId + 1`), and the sign-out callbacks
  (the idle timer, the check after a sync, «Сменить оператора») name the
  session they belong to, so a late timer of an earlier session of the same
  operator ends nothing (`operator_signed_out` compares the number). The
  check after a sync also brings a new name or role from the copies
  (`operator_refreshed`, the same session), so the screens show what the
  office changed without a new session. The session ends when the office opens (any way in,
  the bootstrap wizard's too), on a new pairing, a forget, a rejected device,
  another host, a change of the station's line, and on any host probe
```

Фрагмент 5:

<!-- prettier-ignore -->
```markdown
  refuses it when the device or the line differs, the view is not a floor, an
  operator is signed in already, the device is rejected or on another host
  or the office is open, so a late answer signs nobody in. What an operator
  may do on the line is plan 2a's; stage 1 shows a stub, which shows the name
  and role as of sign-in (a later sync that changes them is not reflected;
  plan 2a refreshes them together with an explicit session counter).

The precondition plan 1d4 named holds: the sync's guard is scoped to the
```

заменить на:

<!-- prettier-ignore -->
```markdown
  refuses it when the device or the line differs, the view is not a floor, an
  operator is signed in already, the device is rejected or on another host
  or the office is open, so a late answer signs nobody in. Any operator
  signed in may enter and create shifts (question В10, «Shifts»).

The precondition plan 1d4 named holds: the sync's guard is scoped to the
```

Фрагмент 6:

<!-- prettier-ignore -->
```markdown
bring back what the quarantine's fail-closed delete took away, an access
for a person or an older layout or default for the catalog. The
`org_profile`, `site` and `lines` upserts have no such guard (plan 2a).
The feed never sends an older revision after a newer one; a stale run's
page could (one fetched before `device_forget` that lands after a new
```

заменить на:

<!-- prettier-ignore -->
```markdown
bring back what the quarantine's fail-closed delete took away, an access
for a person or an older layout or default for the catalog. The
`org_profile` and `lines` upserts carry the same guard since plan 2a5 (the
floor names them and reads the organization's zone and default template);
`site` has none: its salt never changes after the wizard.
The feed never sends an older revision after a newer one; a stale run's
page could (one fetched before `device_forget` that lands after a new
```

Фрагмент 7:

<!-- prettier-ignore -->
```markdown
host, the local host's version and identity, then the office or the floor.
The floor is the operator sign-in (`floor`), or, with an operator signed in,
stage 1's stub (`floor_operator`, `src/floor/FloorOperatorScreen.tsx`); see
«Operators and badges» for both.
While a host is paired, `useHostLink` (`src/app/host-link.ts`) follows the
shell's link and syncs reference data at start and after every revision
```

заменить на:

<!-- prettier-ignore -->
```markdown
host, the local host's version and identity, then the office or the floor.
The floor is the operator sign-in (`floor`), or, with an operator signed in,
the operator's shifts (`floor_operator`, `src/floor/FloorApp.tsx`, plan 2a5);
see «Operators and badges» and «Shifts».
While a host is paired, `useHostLink` (`src/app/host-link.ts`) follows the
shell's link and syncs reference data at start and after every revision
```

Фрагмент 8:

<!-- prettier-ignore -->
```markdown
requests and offer a retry.

The floor's status bar (`src/floor/FloorStatusBar.tsx`, plan 1f2) sits above
the sign-in screen and the stub, inside one `.floor-frame`, as a labelled
region (`section` with an `aria-label`: inside the app's `main` a `header`
would not be a landmark). It shows the organization and the station's line by
```

заменить на:

<!-- prettier-ignore -->
```markdown
requests and offer a retry.

`useHostLink` also reads the station's shifts (`HostApi.getDeviceShifts`, plan
2a5) at the moments it reads the device: once it has subscribed, after every
revision event and on request, one read at a time, retried like the device's
read with a failure count of its own; the answer replaces this pairing's
copies (`replaceShiftCopies`), and `shifts_read` counts the reads that landed
(`ShellState.shiftReads`), so the list reads its copies again after each. A
refused key ends the link as everywhere; any other failure keeps the copies.
A read of the device that could not keep the host's answer in `device.json`
(`storage`) sets `deviceNotSaved`, which the next read that lands clears: the
station works on with the line it has, and the status bar says so.

The floor's status bar (`src/floor/FloorStatusBar.tsx`, plan 1f2) sits above
the sign-in screen and the shifts, inside one `.floor-frame`, as a labelled
region (`section` with an `aria-label`: inside the app's `main` a `header`
would not be a landmark). It shows the organization and the station's line by
```

Фрагмент 9:

<!-- prettier-ignore -->
```markdown
signed in or «Никто не вошёл», and `HostStatusLine`, which the floor screens
no longer show themselves. It holds nothing to press, so the 64 px rule has
nothing to apply to. The device's own name is not in it: `DeviceStatus` has
none, and adding one is a shell change (`device.rs`, the `device.json` format)
outside plan 1f2.

Kiosk mode (plan 1f2). `src-tauri/src/lockdown.rs` ports the cloud station's
```

заменить на:

<!-- prettier-ignore -->
```markdown
signed in or «Никто не вошёл», and `HostStatusLine`, which the floor screens
no longer show themselves. It holds nothing to press, so the 64 px rule has
nothing to apply to. Since plan 2a5 it also names the device
(`DeviceStatus.deviceName`, left out for an older pairing file), the number of
the shift the operator works in (from the copies, by `ShellState.floorWork`)
and, in a polite region of its own, a warning while `deviceNotSaved`.

Kiosk mode (plan 1f2). `src-tauri/src/lockdown.rs` ports the cloud station's
```

Фрагмент 10:

<!-- prettier-ignore -->
```markdown
2a2; revoking blocks and showing them per device with plan 2b.

## Marking rules

```

заменить на:

<!-- prettier-ignore -->
```markdown
2a2; revoking blocks and showing them per device with plan 2b.

The station's side (plan 2a5). After a sign-in the floor is `FloorApp`, a small
machine of its own like the cloud station's: the line's shifts
(`src/floor/shifts/ShiftList.tsx`), a new shift (`NewShift.tsx`) and the work
screen of the shift entered (`src/floor/work/WorkScreen.tsx`, a placeholder
plan 2a6 fills). `App` keys it by the session, so nothing of one operator's
screen outlives their sign-out. The list shows this pairing's copies of the
line's planned and active shifts and one this station is closing
(`readShiftCopies`), never a closed one, so it stays on screen with the host
away. Opening a planned shift and creating one need the host: it freezes the
snapshot and numbers the shift. «Открыть» and «Новая смена» are therefore
disabled without the link, with the reason on screen; «Продолжить» enters an
active shift of this station from its stored snapshot without the host, and
with it re-enters through the host and keeps the answer. An entry checks the
snapshot (`checkShiftSnapshot`: the domain's `labelTemplateSpecSchema`, a
GTIN-14, the nine digits of the issuer prefix) and neither keeps nor works one
this build does not read; a request that finds no host although the link was
online falls back to the stored snapshot; the host's refusals (`shift_busy`,
`shift_status`, `shift_line`, `product_inactive`, `template_not_fit`,
`not_found`) are said in words, and a refused key goes to the shell. A station
on a PC away from the host (the pilot spec's variant А) enters its planned
shifts while the link is up and works them later without it. A new shift
takes its product from a scan (a GTIN or a code of marking, `classifyScan`;
two products in use with one GTIN are not guessed between) or a search by
name among the products in use, its box template by the rule of decision 7
(`suggestBoxTemplate`, with a choice only when the rule leaves several), the
production date as today in the organization's zone (moved by whole days,
never typed), an optional plan and the product's capacity; one `requestId` per
form, kept through retries, so a lost answer makes no second shift, and the
station enters the created shift at once. One entry and one request run at a
time, «Сменить оператора» and «Назад» are never held by them, and an answer
that lands after its screen is gone is dropped.

Leaving the shift — back to the list, a sign-out (the operator's own, idle,
removed), the office's close of the shift (seen in the copies after a read:
«Смену … закрыли в офисе»), another line — waits for the work the screen
tracks (`createWorkGate`, `src/floor/work-gate.ts`: a failed piece of work
does not hold it, work tracked while it waits does), then tells the shell
(`work_left`). While the operator works in a shift (`ShellState.floorWork`,
set by `work_entered`), a refusal of this device (`key_rejected`,
`certificate_mismatch`, from the link or a call) waits in `pendingRejection`
(question В8) and another line in `pendingDevice` (question В9): the link
stops at once (`App` treats a waiting refusal as a refusal for the link), the
line finishes its box, and the refusal or the move takes the floor at
`work_left` (a refusal first). The floor leaves the shift by itself for
another line; for a refusal it waits for the operator. The idle wait runs for
the whole session, and `touch` restarts it for a scan that presses no key (a
COM scanner, plan 2a6). Another host found by the sync still ends the session
at once (carried to plan 2b).

## Marking rules

```

Фрагмент 11:

<!-- prettier-ignore -->
```markdown
  one into a second test file.
- `pnpm --filter @markiro/standalone test`, `typecheck`, `lint`, `build`.
- The Windows service and DPAPI run only in the `standalone-windows-build`
  job: it compiles the service and the Tauri app for Windows, and its cargo
```

заменить на:

<!-- prettier-ignore -->
```markdown
  one into a second test file.
- `pnpm --filter @markiro/standalone test`, `typecheck`, `lint`, `build`.
- The floor's shifts (plan 2a5) by hand, on Windows 10 and 11: the list, the
  new shift and the work screen on the real screen and touch panel (64 px
  controls, a long product name on a card); a product scanned on the new
  shift with the keyboard wedge (its code of marking with a GS) under the RU
  and EN layouts; the Windows on-screen keyboard over the name search in kiosk
  mode; with the host on another PC over Wi-Fi, a planned shift entered while
  the link is up, then the access point switched off, «Продолжить» from the
  stored snapshot, and the shift's work and leave; the office moving the
  station to another line and revoking it while the operator is in a shift.
- The Windows service and DPAPI run only in the `standalone-windows-build`
  job: it compiles the service and the Tauri app for Windows, and its cargo
```

Правка `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`:

Фрагмент:

<!-- prettier-ignore -->
```markdown
  крейтом-пробником под `x86_64-pc-windows-msvc`, сама оболочка — только в
  `standalone-windows-build`.
```

заменить на:

<!-- prettier-ignore -->
```markdown
  крейтом-пробником под `x86_64-pc-windows-msvc`, сама оболочка — только в
  `standalone-windows-build`.

## 17. Уточнения плана 2a5

План `docs/superpowers/plans/2026-10-09-standalone-2a5-floor-shifts.md` (цех: копии смен, вход,
новая смена, сеанс) уточняет разделы 5.1, 5.3, 5.4, 5.7.1, 5.7.2 и 5.7.9 так; допущения по
вопросам раздела 11 — рекомендованные варианты (если номер раздела занят планами 2a2–2a4, этот
раздел получает следующий свободный).

- Миграция `0006` несёт все производственные таблицы раздела 5.3 (`floor_shifts`,
  `floor_sscc_blocks`, `floor_block_requests`, `floor_boxes`, `floor_codes`, `floor_scans`,
  `floor_exceptions`, `outbox`), все — класса «данные устройства». `floor_shifts` и `floor_codes`
  ключуются подключением (`host_id`, `device_id` и идентификатор): повторное подключение к тому же
  хосту видит те же смены. `floor_scans` и `floor_exceptions` несут `shift_id`. У `outbox.kind` нет
  `CHECK` (паллеты пилота добавят виды), `seq` — псевдоним rowid без `AUTOINCREMENT`.
  `payload` — запись `FactRecord` целиком, как она уходит на хост.
- Копии смен: ответ `GET /v1/device/shifts` заменяет строки подключения одной транзакцией; уходят
  только смены, в которые станция не входила; смена, в которую она входила, остаётся со снимком
  при любом списке и никогда не возвращается в `planned` (список, прочитанный до входа). Список на
  экране — запланированные и активные смены линии и закрываемая станцией, без закрытых.
- Снимок проверяется при входе и при чтении сохранённого: схема `shiftSnapshotSchema`, GTIN-14,
  девять цифр префикса выпуска, `labelTemplateSpecSchema`. Нечитаемый снимок не сохраняется и не
  открывает работу. Хранится снимок, разобранный этой сборкой (поле, добавленное новым хостом,
  приходит со следующим входом через хост).
- Вход без связи — только в активную смену этой станции с сохранённым снимком; «Открыть» и
  «Новая смена» без связи выключены с объяснением; запрос, не нашедший хоста при связи `online`,
  откатывается к сохранённому снимку.
- Новая смена: дата производства меняется кнопками «На день раньше» / «На день позже», не вводом;
  контрагента станция не выбирает (`counterpartyId: null`, копий контрагентов нет); один
  `requestId` на форму, и повтор после потерянного ответа отдаёт первую смену, даже если поля с тех
  пор менялись; созданная смена сразу открывается, отказ во входе показывается словами со ссылкой
  на номер.
- Сеанс оператора — `{ sessionId, id, login, name, role }`, номер даёт редьюсер
  (`lastSessionId + 1`); `operator_refreshed` меняет имя и роль того же сеанса. Работа смены —
  `floorWork` (`work_entered` / `work_left`); отказ устройства и смена линии во время работы ждут в
  `pendingRejection` и `pendingDevice`; связь при ждущем отказе останавливается сразу. Цех сам
  выходит из смены при ждущей смене линии, при отказе ждёт оператора; другой хост (`other_host`)
  снимает цех сразу (перенесено в 2b).
- Выход из смены ждёт работу, которую отдал рабочий экран (`createWorkGate`); упавшая работа его не
  держит, работа, отданная во время ожидания, — держит.
- Строка состояния: имя устройства, номер смены, в которой работает оператор, и предупреждение
  `deviceNotSaved` (сбой записи `device.json` при `device_refresh`).
- Экраны отказа устройства, другого хоста и повреждённой настройки при отказе `unsent_facts`
  называют число неотправленных записей и предлагают «Сбросить всё равно» (`keepUnsent: true`).
- Защита `notQuarantinedNewer` — и у `org_profile`, и у `lines`; версия набора сущностей не
  меняется.
```

- [ ] **Step 2: Сверка с кодом**

Каждое утверждение новых абзацев сверить с кодом задач 1–8 (имена функций, таблиц, действий, ключей, отказов); расхождение — правка текста, не кода. Заголовок раздела спецификации — `## <N>. Уточнения плана 2a5`, где `N` — следующий свободный номер.

- [ ] **Step 3: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`; `git diff --check`
Expected: чисто.

- [ ] **Step 4: Commit**

```bash
git add apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md
git commit -m "docs(standalone): the station's shifts, its production tables, the operator's session and what waits for the shift's work" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

1. Полный набор пакета: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — PASS; Vitest на копии плана — `Test Files  82 passed (82)`, `Tests  2050 passed (2050)` (на настоящем дереве больше на тесты задач 5–9 плана 2a3 и плана 2a2). Падение старого теста офиса тайм-аутом под нагрузкой записывается и разбирается (заметки), а не лечится повтором.
2. Rust: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone` вне песочницы — на копии плана библиотека 76, `claim` 5, `connection` 6, `device` 15, `host_probe` 2, `host_probe_proxy` 1, `host_request_timeout` 5, `ipc` 18, `line` 16, `local_db` 16, `lockdown` 4, `printer` 4 — все PASS, без предупреждений. План 2a5 меняет только `local_db.rs` и тесты `local_db`, `ipc`; хост и `proto` не трогает, их `cargo test --workspace` — гейт веток 2a1/2a2.
3. Стенд с задержкой `setImmediate` и verbose-прогон для всех новых и изменённых тестовых файлов плана (`floor-schema`, `local-executor`, `protocol`, `api`, `shift-copies`, `shell`, `host-link-shifts`, `app`, `floor-shift-list`, `floor-new-shift`, `floor-shift-text`, `floor-app`, `work-gate`, `floor-status-bar`, `outbox`, `reference-sync`) — PASS, `stderr` пуст.
4. Каждая мутация задач 1–8 — FAIL названного теста, файл восстановлен (`cmp`, тот же `shasum`), `git status --short` после всех — пуст.
5. `grep -rnF '\u04' apps/standalone/src apps/standalone/test` — только `src/host/pairing-code.ts:66`; `grep -rn "FloorOperatorScreen\|operatorStillAllowed" apps/standalone` — только упоминания в истории планов, не в `src`, `test`, `AGENTS.md`.
6. `git diff --check` от основы плана; `git log --format=%B` каждого коммита — ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; изменены только пути раздела «Файлы».
7. Сверка с разделом «Контракт для 2a6–2a8»: таблицы, `WorkScreenProps`, поля и действия `ShellState`, функции копий и проверки снимка названы в коде так, как в контракте.

**Что нельзя проверить без Windows, оборудования и живого хоста** (отчёт называет отдельно от автоматических проверок): раскладка списка, новой смены и рабочего экрана на мониторе и сенсорной панели заказчика (64 px, длинное название товара на карточке); экранная клавиатура Windows над полем поиска товара в киоск-режиме; скан товара клавиатурным сканером (код маркировки с GS через Ctrl+] в WebView2) в раскладках RU и EN; вход в смену с хостом на другом ПК через Wi-Fi: заранее при связи, потом точка доступа выключена — «Продолжить» по снимку, работа и выход из смены; перевод станции на другую линию и отзыв ключа в офисе, пока оператор в смене; живой хост 2a1 с настоящими шаблонами (снимок с макетом из редактора офиса через `labelTemplateSpecSchema`).

## Перенесено

- **В12 — случайные сканы на экране входа.** Рекомендованный вариант «не хешировать и не считать сканы, похожие на GTIN или SSCC» небезопасен вместе с переносом облачных бейджей хешами (план ИМП, спецификация пилота §8.3): числовой облачный бейдж с верной контрольной цифрой EAN перестал бы входить. Решить с владельцем вместе с ИМП (например, хешировать такой скан, но не считать неудачей).
- **П17 — скан «Бланка смены» на станции.** Появится, когда офис начнёт печатать бланк (план О-Ф).
- **`protocol_unsupported` на вызове устройства → экран «хост старше приложения»** (§5.1 спецификации): сейчас список смен показывает отказ словами `errors.*`, а проба хоста на этом ПК — экран версии. Для пилота версии ставятся вместе; полноценный экран — с планом 5 (политика версий протокола).
- **Другой хост (`other_host`) и проба хоста при старте (`host_probed`) посреди смены** снимают цех сразу, без ворот работы: окно «сброс при записи в полёте» закрывает задача ворот плана 2a6 (удержать их за воротами, как `pendingRejection`, либо заставить сброс ждать `drain`); замена хоста по тому же адресу во время смены — план 2b.
- **`requestId` новой смены после перезапуска приложения** не сохраняется: повтор создаст вторую запланированную смену `/S`, которую офис удаляет. Сохранять незавершённое создание (как `floor_block_requests`) — если пилот покажет такие смены.
- **Много смен на линии:** список — карточки одна под другой без страниц (облако показывает по две на странице 1280 × 800); страницы — если у клиента на линии больше трёх-четырёх смен сразу.
- **Удаление копий закрытых смен, в которые станция входила,** — срок хранения плана 2a8 (решение 31).
- **Подсказка шаблона на станции** использует только правило решения 7 и не показывает предпросмотр этикетки; предпросмотр на станции — вместе с печатью (план 2a7), если понадобится.
- **Среда агентов:** `/usr/bin/git` и `cc` на ПК владельца сейчас требуют принять лицензию Xcode (`sudo xcodebuild -license`); до этого git работает как `/Library/Developer/CommandLineTools/usr/bin/git`, а Cargo — с `DEVELOPER_DIR=/Library/Developer/CommandLineTools`.

## Отклонения при исполнении

Записано по итогам исполнения 2026-10-09 — 2026-10-10 и итогового ревью части. Ветка `claude/2a5-floor` отрезана от `claude/integration` на `16fdf718a` (2a3 + 2a4); часть 2a5 — 13 коммитов `e7943ab49…afe157e28` и 5 коммитов итоговой волны (`681313933`, `c8341ad7e`, `3a4391c2d`, `a70e9731e`, `baceddf49`). На 2026-10-11 ветка влита в `claude/integration`. Итоговое ревью ошибочно взяло за основу `ce6511b3b` (55 коммитов); настоящая основа — `16fdf718a`, запись в журнале исправлена.

**Поправки плана по ходу исполнения**

- Задача 1. Однополевые текстовые ключи — `TEXT NOT NULL PRIMARY KEY` (SQLite принимает NULL в простом `TEXT PRIMARY KEY`). Фрагмент 2 не применён: отдельный тест внешних ключей уже был. `outbox_exists` оставлен для подсчёта в неоткрывшейся базе (старая сборка без `outbox`). По ревью добавлены четыре индекса повторяющихся чтений 2a6 (`outbox_settled` — частичный, `floor_codes_box`, `floor_codes_shift`, `floor_boxes_shift`), проверки `json_type(...) = 'object'` у `snapshot`, `payload`, `outcome_details` и тест оболочки `the_floors_repeating_reads_search_an_index` (планы чтений на SQLite 3.46 оболочки).
- Задача 2 отдельного ревью не имела (решение контроллера); её проверило итоговое ревью части по маршрутам хоста интеграционной ветки, пять мутантов ревью убиты. `requestId` создаётся `crypto.randomUUID()`.
- Задача 3. Статус копии только вперёд (`BEHIND`): список или ответ, прочитанный раньше сохранённого, не возвращает смену назад; запоздалый ответ входа после закрытия в офисе не берёт поля хоста, но сохраняет снимок и время входа; `keepEnteredShift` отказывает непроверенному снимку; `readStoredWork` — одно чтение. Неизменяемость снимка, введённая исполнителем, снята ревью: повторный вход перезаписывает снимок (путь починки поля, которое сборка отбросила), `entered_at` остаётся первым.
- Задача 5. Офлайн-вход и откат к снимку отказывают копии не `active` или с `localState` (`closed`); тест `not_paired` читателя смен — отдельным коммитом `44bfec4ad`.
- Задача 6 (по ревью). Форма новой смены замораживается после ответа хоста; возвращённая смена сверяется с запросом (`isShiftOfRequest`), смена других полей не открывается молча («уже была создана раньше», кнопка открывает её); `validation_failed` на `productId` — `product_inactive`, на `lineId` — `no_line`; отказ шаблона открывает выбор подходящих шаблонов.
- Задача 7. `FloorApp`: ждёт один выход (`standing`), выход из сеанса главнее ждущего; выход «на другую линию» кончается списком, если перевод отменён; ворота `entered` — копия не `active` или с `localState` возвращает на список (с «Смену N закрыли в офисе.»), без `work_entered`; `ShiftList` перемонтируется после возврата (`key`); `touch` у блокировки бездействия; живая область рабочего экрана смонтирована всегда.
- Задача 8. Метка ждущего отказа в строке состояния (`refusalHeld`, пункт 8 очереди), строка связи и стоящий отказ списка вместе в одной области (12), `role="presentation"` у предупреждений внутри вежливых областей (14), обязательства рабочего экрана в JSDoc и `aria-disabled` у «Выйти из смены» (17), фокус на подсказке списка (19).
- Задача 9. Раздел спецификации — §18 (следующий свободный в ветке); в `claude/integration` §18 занят планом 2a6 (§19 — 2a2), при слиянии раздел 2a5 перенумерован в §20 (§18 остаётся за планом 2a6).

**Итоговая волна правок** (после итогового ревью: Critical 0, Important 1, Minor 16)

- Тесты (`681313933`, `a70e9731e`): вход — смена сертификата не берёт снимок, не-`HostError` — `failed`, сбой записи, снимок, которого нет или который не читается после записи, — `local`, прежний отказ уходит со следующей попыткой (пункт 11); двойное нажатие «Выйти из смены» — один `work_left` (18); отрицательные утверждения ждут чтения и записи, о которых говорят, а не фиксированное время (23, 24, N5).
- Код (`3a4391c2d`): закрытие смены в офисе повышает ждущий простой выход на список или на другую линию, ждущий выход из сеанса не трогает (15); ворота — `useState(createWorkGate)` (16; тест на это не мог упасть, коммит говорит об этом прямо); пока отказ удержан, строка состояния отдаёт `HostStatusLine` связь как `offline` (22); число неотправленных записей хранится вместе с экраном, на котором его спросили (21, без эффекта); сообщения области входа не `alert` (`role="presentation"`, 25). Шесть тестов из `c8341ad7e` падали до этого коммита (в тексте коммита названо пять).
- Документы (`baceddf49`): AGENTS.md — экран «другой хост» и сброс во время смены (I-1: прежняя фраза «эти экраны никогда не заменяют рабочий» была неверна для `other_host`), примеры отказа из вызова (N1), ограничение `deviceNotSaved` (N8), предложения про пункты 15 и 22; раздел спецификации; «Перенесено» этого плана.
- Заголовок миграции `0006` («срока хранения нет совсем») не правился: оболочка применяет миграции через `sqlx::migrate!`, а он хранит контрольную сумму файла и откажет любой базе, уже применившей `0006`. Исправление записано в AGENTS.md («Local database») и в спецификации. N7 (регистр `requestId`) отброшен: единственный источник — `crypto.randomUUID()`, строчные буквы.

**Перенесено**

- Окно «сброс при записи в полёте» (`other_host`) и проба хоста при старте (`host_probed`) посреди смены: ворота работы — обязательная часть задачи ворот плана 2a6; вместе с пунктами 1–3, 5 и 27 очереди они записаны в `2a6-addenda-from-2a5.md`. В 2a6 сделано всё, кроме пункта 27: счёт неотправленного вызывается один раз за сброс, его текст описан в документах.
- Замена хоста по тому же адресу посреди смены — план 2b.
- План 2a7: таблицы `0007` с `TEXT NOT NULL PRIMARY KEY` и, по желанию, `json_type = 'object'`; предложение AGENTS.md «из 19 таблиц 11 — Disposable, 8 таблиц `0006` — DeviceData» обновляется первой же таблицей `Workstation`.
- План 2a8: «Завершить» (вход в закрытую в офисе смену по снимку) намеренно ослабляет ворота `entered`, правило `storedWork` и `status <> 'closed'` в `readShiftCopies` — все три введены этим планом и в тексте плана 2a8 их нет.
- План ПЛ-Ц: `0008` предполагает существование `0007`; колонки паллет в `floor_shifts` требуют `HOST_FIELDS`, `UPSERT` и `KEEP_ENTERED` в `shift-copies.ts`; `palletTemplate` в снимке старая сборка отбросит (`shiftSnapshotSchema` срезает неизвестные ключи), его вернёт повторный вход.
- Остаётся открытым (не блокирует): `requestId` новой смены не переживает перезапуск; список смен без страниц; подсказка шаблона без предпросмотра; `protocol_unsupported` на вызове устройства — экран «хост старше приложения» в плане 5.

**Не проверено**

- Весь цех не прогонялся на живом хосте 2a1/2a2: вход, повторный вход и снимок настоящего шаблона редактора через `labelTemplateSpecSchema`; офлайн «Продолжить» при выключенной точке доступа; перенос линии и отзыв устройства посреди смены. Все тесты идут по поддельному `HostApi`.
- Windows и WebView2: `crypto.randomUUID` в источнике приложения (нужен защищённый контекст), фокус при `aria-disabled`, чтение экранным диктором `role="presentation"` внутри живых областей, раскладка 64 px на сенсорной панели клиента.
- Железо: сканирование КМ с GS клавиатурным клином при русской и английской раскладке, экранная клавиатура над поиском товара в киоск-режиме.
- Планы запросов SQLite 3.46 проверены только `cargo test --test local_db` на macOS; сборка под Windows не запускалась. CI не запускался.

**Счёт.** Vitest на настоящем дереве после задачи 8 — 87 файлов, 2518 тестов (на копии плана — 82 / 2050), после итоговой волны — 87 файлов, 2533 теста одним прогоном с `--testTimeout=60000 --hookTimeout=60000`. Оболочка: `local_db` 27 тестов (в плане 16), `ipc` 26 (в плане 18; запускался вне песочницы). Итоговая волна Rust не меняла; `typecheck`, `lint` и `build` чисто.
