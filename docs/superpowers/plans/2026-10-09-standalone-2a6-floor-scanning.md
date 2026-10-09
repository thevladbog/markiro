# План 2a6: цех — источники сканов, конвейер сканов, короба и номера SSCC, дозаказ блоков, доставка фактов, рабочий экран — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Оператор в рабочем экране смены сканирует коды маркировки клавиатурным или COM-сканером; станция разбирает каждый код функциями `@markiro/domain`, отсекает чужой товар и дубли — по своей базе и, пока связь `online`, вопросом к хосту не дольше 300 мс — и принимает код в открытый короб одной локальной транзакцией вместе со строкой журнала и записью исходящей очереди; полный короб закрывается сам, неполный — после подтверждения, номером SSCC из блока, выданного хостом этой станции, со списанием номера сравнением курсора; блоки дозаказываются по правилу «половина»; очередь уходит на хост пачками с квитанцией на каждую запись и досылается после обрыва связи; строка состояния называет неотправленное, отклонённое, конфликты, остаток номеров и сбой доставки. Это ядро агрегации и критический путь пилота у текущего клиента; печать этикетки — план 2a7, исключения и закрытие смены — план 2a8.

**Architecture:**

- Протокол цеха в вебвью (задача 1): Zod записей фактов пяти видов, квитанций, проверки кода и блока SSCC в `src/host/protocol.ts`; построители записей и строки `outbox` с пределом размера записи (`src/floor/facts.ts`); методы `HostApi.requestSsccBlock`, `checkCode` (300 мс) и `sendFacts`.
- Источник сканов (задача 2): COM-сканеры оболочки как `ScanSource` (`createComScanSource`) и клавиатура вместе с ними (`mergeScanSources`) — источник цеха по умолчанию в `App`.
- Конвейер одного скана (задача 3, `src/floor/work/scan-pipeline.ts`), очередь работы по одному (`work-queue.ts`) и чтения рабочего экрана (`work-reads.ts`).
- Закрытие короба (задача 4, `box-close.ts`): номер из самого раннего блока с местом, одна транзакция с проверкой курсора, точка расширения `CloseStep` для печати (2a7) и паллет (ПЛ-Ц); полный короб закрывается после скана и при входе в экран.
- Дозаказ блоков (задача 5, `block-supply.ts`): правило «половина», запрос хранится до ответа и повторяется целиком.
- Доставка фактов (задача 6, `src/local/facts-sender.ts`) — ещё один планировщик в `useHostLink`; квитанции одной транзакцией через `json_each`; `outboxVersion` и `factsFailure` в оболочке.
- Строка состояния (задача 7): неотправленные, отклонённые и конфликты, остаток номеров SSCC смены, сбой доставки на стороне хоста или этого компьютера.
- Рабочий экран (задача 8): тело `src/floor/work/WorkScreen.tsx` (заглушка плана 2a5) заменяется; звуки; проводка `FloorApp` и `App`.
- Задача 9: сквозной тест приложения «хост пропал — линия работает — всё досылается по порядку» и документы.
- Хост, `proto`, оболочка (Rust), миграции, `apps/station`, `packages/*`, `package.json`, `pnpm-lock.yaml`, `Cargo.toml` и `Cargo.lock` не меняются: новых таблиц нет, все нужные дала миграция `0006` плана 2a5.

**Tech Stack:** React 19.2, TypeScript 6 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4.4.3, i18next, `@markiro/ui` (`Card`, `Button size="floor"`, `Alert`, `SignalOverlay`), `@markiro/domain` (`classifyScan`, `canonicalizeKm`, `kmHash`, `buildSscc`, `boxMembershipDigestV1`, `formatSsccHri`), Vitest 4 с jsdom и `node:sqlite` за `LocalExecutor`, WebAudio (тоны генерируются, файлов звука нет).

**Спецификации:**

- `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` (черновик этапа 2a): решения 9–16, 21, 25, §5.5 (очередь и доставка), §5.7.3 (рабочий экран и цикл сканирования), §5.7.4 (короба и SSCC), §5.7.9 (строка состояния), строка 2a6 раздела 8, §11 (вопросы), уточнения планов 2a1–2a5 (разделы 15–19 по мере слияния).
- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`: §3 (хост на ПК станции), §4.1 (срез пилота, строка 6), §6 (паллеты-лайт — точка расширения закрытия короба), §9 (обрывы Wi-Fi: что можно без хоста, экран очереди ОЧ), §12.5 (критический путь), §14 (П1, П2, П10).
- `.superpowers/sdd/cloud-pallet-flow-notes.md`: короб присоединяется к открытой паллете станции при закрытии — точка расширения `CloseStep` задачи 4.
- Планы, на которых стоит этот: 2a2 (`docs/superpowers/plans/2026-10-09-standalone-2a2-host-facts.md`, «Контракт для 2a3 и 2a6», правила хоста из ревью его задачи 2), 2a4 (`…-2a4-shell.md`, «Контракт для 2a5–2a7»: `HardwareApi.onScan`, `timeoutMs`), 2a5 (`…-2a5-floor-shifts.md`, «Контракт для 2a6–2a8»: таблицы `0006`, `WorkScreenProps`, `ShellState`).
- `apps/standalone/AGENTS.md` — «Local database», «Writes», «Facts», «Shifts», «App shell», «Hardware», «Logs», «Verification».
- Облачная станция (переносится своими модулями, не импортом): `apps/station/src/lib/scan-queue.ts`, `scan-source.ts`, `hardware.ts` (`createHardwareScanSource`), `close-box.ts`, `box-serial-top-up.ts`, `signal-sound.ts`, `pages/WorkScreen.tsx` (вердикты, `ordinaryScanBlockedRef`, `planReachedPrompt`), тексты `ru.json` (`work.*`, `box.*`, `signal.*`).

## Допущения по вопросам владельцу

Владелец не ответил ни на вопросы раздела 11 спецификации 2a, ни на вопросы раздела 14 спецификации пилота. План исполняет рекомендованные варианты; ниже — что принято и что поменять, если ответ будет другим.

- **П1 — хост на ПК станции (вариант Б), но план верен для обоих вариантов.** При Б проверка кода на хосте, дозаказ блоков и доставка идут на `localhost` и не зависят от Wi-Fi. При А (хост на ПК администратора) обрыв Wi-Fi посреди смены не останавливает линию: дубль внутри смены ловит локальный реестр станции (`floor_codes`), номера идут из блока, который станция уже держит (2 000 гарантированно и до 3 000 по правилу «половина»), записи копятся в очереди и досылаются сами, когда связь вернётся; строка состояния показывает, сколько не отправлено.
- **П10 — вопросы В1–В14 по рекомендации.** В1 А: работа без хоста и досылка входят в 2a, квитанция `conflict` уже есть, разбор конфликтов — 2b. В6: проверка кода — 300 мс, блок — 2 000 номеров, дозаказ — когда в самом новом блоке меньше половины. В7 А с выходом Б — экраны «забывания» планов 2a4 и 2a5 не меняются. В8 Б: пока отказ устройства ждёт выхода оператора из смены, связь, доставка и обращения рабочего экрана к хосту остановлены (`FloorApp` получает `rejectionPending`). В9 А, В10 А — как в плане 2a5.
- **В12 (случайные сканы на экране входа)** остаётся перенесённым с планом ИМП, как решил план 2a5. В рабочем экране отсканированный бейдж — нераспознанный скан: в журнале и очереди только его длина и класс, ни текста, ни хеша; неудачей входа он не считается — экрана входа здесь нет.
- **П2 (паллеты-лайт) — вне 2a6.** Закрытие короба оставляет точку расширения (`CloseStep`): план ПЛ-Ц той же транзакцией присоединит короб к открытой паллете станции и добавит `palletId` в запись `box_closed` (это новое поле факта — по ревью плана 2a2 оно поднимает `PROTOCOL_VERSION`, что спецификация пилота и планирует: протокол 3).
- **Экран очереди (план ОЧ пилота)** — вне 2a6: 2a6 хранит отклонённые записи с кодом квитанции и показывает их число в строке состояния; список, «Отправить снова» и предупреждения о запасе номеров — план ОЧ.
- **Правила хоста из ревью задачи 2 плана 2a2** (переданы координатором) приняты как требования: отклонённая запись под тем же `id` больше не отправляется; любой сбой отправки (транспорт, 500, 413) оставляет записи и шлёт ту же пачку с теми же `id`; неподтверждённые записи не удаляются; «ошибка хоста» показывается отдельно от «нет связи»; размер записи ограничен; квитанции идут в порядке записей, нечитаемая запись — `id: null`; время устройства — ровно `Date.toISOString`.

## Global Constraints

**Из спецификации этапа** (дословные значения)

- Решение 11: одна исходящая очередь `outbox` на устройстве; факт и его запись очереди — одна `local_transaction`. На хост — `POST /v1/device/facts`, до 100 записей; идемпотентность по паре «устройство + `id` записи»; квитанция на каждую запись (`accepted`, `conflict`, `rejected`); транспортные сбои — не квитанции, станция повторяет с нарастающей паузой.
- Решение 13: хост не разбирает КМ: `codeHash`, `gtin14`, `serial` и канонический код приходят от устройства (их считает `@markiro/domain`).
- Решение 15: скан с вердиктом `invalid` не хранит и не отправляет сырой текст — только длину и класс (`classifyScan`: `unknown`, `gtin`, `sscc`).
- Решение 16: `GET /v1/device/codes/{codeHash}`, только когда связь `online`; запрос ограничен 300 мс (`timeoutMs`, транспортный код `timeout`). Нет ответа — скан принимается локально, дубль проявится квитанцией `conflict`.
- Решение 9 и §5.7.4: станция просит блок, когда у неё нет блока для префикса смены или в самом новом блоке осталось меньше половины, и связь `online`; `requestId` записывается в `floor_block_requests` до запроса и удаляется в транзакции, которая сохраняет полученный блок, поэтому повтор после сбоя или перезапуска просит тот же блок.
- Решение 10 и §5.7.4: номер списывается при закрытии короба, после проверки, что короб не пуст: курсор самого раннего блока с местом для префикса снимка и расширения 0 (`local_query`) → `buildSscc(0, issuerPrefix, serial)` (ошибка `SSCC_RANGE` — номер потерян, короб открыт) → одна `local_transaction`: `UPDATE floor_sscc_blocks SET next_serial = next_serial + 1 WHERE block_id = ? AND next_serial = ?` (`expectedChanges: 1`), закрытие короба (`WHERE closed_at IS NULL`, `expectedChanges: 1`), запись `outbox` (`box_closed` с `membershipDigest` — `boxMembershipDigestV1` от кодов короба). Задание печати в этой транзакции — план 2a7.
- §5.7.3: конвейер строго по одному: `classifyScan` → GTIN ≠ снимку — `wrong_gtin` → локальный дубль (`floor_codes`) — `duplicate`/`local` с временем первого скана → связь `online` — проверка на хосте с `timeoutMs: 300`, `taken` — `duplicate`/`host` с номером смены владельца; `timeout`, сбой или связь не `online` — шаг пропускается → принятый код одной транзакцией (короб, `floor_codes`, `floor_scans`, `outbox`, счётчик короба); отказ записи — «Системная ошибка», скан не принят, следующий не обрабатывается, пока оператор не закроет сообщение → короб заполнен — закрытие → план достигнут — один раз предложение. Непринятые сканы тоже пишутся в журнал и очередь. Сканы не принимаются, пока открыты проверка печати, восстановление, исключения, сводка закрытия, подтверждение очистки или нет номеров SSCC.
- §5.7.4: открытие короба — при первом принятом коде; закрытие полного — само, неполного — кнопкой с подтверждением; номеров нет — состояние «Нет номеров SSCC»: сканирование остановлено, короб не закрывается, экран называет причину (нет связи — «Нужна связь с хостом»).
- §5.5: пачка — до 100 записей текущего подключения с `acked_at IS NULL`, по `seq`; запуск — после каждой локальной записи, при связи `online`, по повтору 2, 4, 8, 16, 32 с, затем 60 с; одна отправка за раз; квитанции применяются одной `local_transaction` через `json_each`; `conflict` у скана ставит `floor_scans.conflict` и `floor_boxes.needs_fix`; `rejected` остаётся видимым списком; отказ устройства и смена сертификата — путь отказа оболочки.
- §5.7.9: строка состояния получает неотправленных записей, отклонённых и конфликтов, остаток номеров SSCC для префикса текущей смены. Бездействие — 10 минут; COM-скан трогает таймер.

**Из контракта плана 2a2 и правил хоста**

- `FactRecord = { id (канонический UUID), kind, shiftId, operatorId | null, data }`; данные пяти видов — как в фикстуре `proto/fixtures/facts-request.json`; моменты устройства — `new Date().toISOString()`.
- Квитанции — в порядке записей; запись без читаемого `id` получает `id: null` и сопоставляется по месту в пачке.
- Отклонённая запись получает квитанцию навсегда: под тем же `id` её не отправлять никогда; «Отправить снова» (план ОЧ) пишет её и её отклонённые зависимые заново с новыми `id`, в прежнем порядке `seq`.
- Любой ответ, кроме 200 (500, 413, транспорт), — «не доставлено»: та же пачка с теми же `id` уходит снова; неподтверждённые записи не удаляются; «ошибка хоста» показывается отдельно от «нет связи»; размер одной записи ограничен (тело больше 2 МиБ — 413).
- Повтор `requestId` блока с другим префиксом — `validation_failed` на `requestId`: станция хранит префикс рядом с запросом, повторяет запрос целиком и кладёт блок под префиксом запроса.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!` в исходниках (`as const` — не приведение); именованные экспорты, `import type`; члены интерфейсов, которые передаются несвязанными, — свойства-функции (`@typescript-eslint/unbound-method`).
- Правила маркировки — только `@markiro/domain`; в вебвью нет своего разбора КМ, GTIN или SSCC.
- Экраны цеха: только `@markiro/ui` (ESLint запрещает нативные поля), каждая кнопка — `size="floor"` (64 px), вердикт — словами, вспышкой и звуком, не только цветом; ни одна кнопка ухода не держится запросом, который может не ответить.
- Тексты — ключи `src/i18n/ru.json`, кириллица буквами; числа — через `formatQuantity` (разделитель разрядов — неразрывный пробел, в ожидаемых строках тестов он пишется `\u00a0`); переменные текстов — именованные (`quantity`, `capacity`, `number`, `gtin`, `time`, `planned`), не `count`.
- Журнал процесса вебвью не пишет ни кодов маркировки, ни SSCC, ни сырого текста скана — вебвью вообще ничего не пишет в консоль в этих модулях.
- Тесты не зависят от гонки эффектов: перед действием, которому нужен сработавший эффект, тест ждёт этого явно (`listening()`, `settled()`); утверждение о числах, которые экран читает после работы, начатой эффектом, — через `waitFor`; новые и изменённые тестовые файлы проходят стенд с задержкой `setImmediate` и verbose-прогон без `stderr`.
- Тесты конкурентности детерминированы: запись удерживается (`holdingWrites`), никаких надежд на время.
- Не меняются: `apps/station`, `packages/*`, `apps/standalone/host`, `apps/standalone/proto`, `apps/standalone/src-tauri`, `package.json`, `pnpm-lock.yaml`.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Решения планировщика

- **Источник сканов — клавиатура и COM сразу** (`mergeScanSources`), а не один по настройке (решение 25 спецификации): настройка рабочего места — план 2a7, и без неё станция с COM-сканером не сканировала бы вовсе; сканер-клавиатура рядом с COM-сканером тоже работает. Подписка на `standalone://scan` асинхронна: источник, остановленный до её ответа, снимает её, как только она ответит; неудачная подписка (вне оболочки) оставляет клавиатуру. Пока поле ввода берёт текст (`setManualTextEntryActive(true)`), COM-сканы отбрасываются, как клавиатурные.
- **Чтение скана** (`readScan`) — `classifyScan` домена; SSCC в рабочем экране 2a6 — нераспознанный скан (`invalid`/`sscc`, «Это код короба»): проверку этикетки план 2a7 ставит перед конвейером. Код, чья серия длиннее предела хоста (`MAX_SERIAL_BYTES = 64` в `host/src/facts/scan.rs`), читается как `unknown`: иначе станция приняла бы код, который хост отклонит, и короб с ним разошёлся бы с хостом. Это предел транспорта хоста, а не правило маркировки.
- **Ответ хоста `taken` о скане этой же станции** (`sameDevice`) дубля не даёт: свой реестр станции новее хоста (снятие кода исключением могло ещё не дойти).
- **Один код — один короб подключения** держит ключ `floor_codes (host_id, device_id, code_hash)`: вставка — `ON CONFLICT DO NOTHING` с `expectedChanges: 1`, и второе принятие, которое проверка пропустила, падает целиком (`changes_mismatch`), ничего не записав. Счётчик открытого короба растёт с условием `closed_at IS NULL` и `expectedChanges: 1`: скан не попадёт в короб, закрытый, пока скан был в пути.
- **Отказ записи** — исключение из `processScan`; экран показывает «Скан не записан» и не берёт следующих сканов, пока оператор не закроет сообщение. Скан, пришедший, пока работу останавливает сообщение или идёт выход из смены, не принимается и не пишется в журнал, а экран и звук говорят «не принят»: ни один скан не теряется молча.
- **Закрытие короба** берёт номер самого раннего блока с местом (`ORDER BY from_serial`), строит SSCC доменом и пишет одной транзакцией: проверка курсора, закрытие при неизменном счётчике (`item_count = ?`, дайджест посчитан по прочитанным кодам), запись `box_closed`, добавки поздних планов (`CloseStep`). Несошедшаяся проверка — `stale`: ничего не записано, закрытие повторяется (до трёх раз). Номер вне ёмкости префикса списывается одной транзакцией и теряется, короб остаётся открытым (`invalid_serial`), экран предлагает «Повторить».
- **Полный короб при входе в экран** закрывается первым (`closeIfFull`): станция, остановленная между сканом, заполнившим короб, и его закрытием, иначе застряла бы с переполненным коробом.
- **Дозаказ блока**: «самый новый» — с наибольшим `from_serial` (хост выдаёт блоки по возрастающему счётчику); ждущий запрос повторяется, даже если блок уже не нужен (хост мог его выдать); новый запрос создаётся только при связи; блок другого префикса или расширения, чем в запросе, не сохраняется, а запрос выбрасывается; `validation_failed` на `requestId` — новый запрос, один раз; любой `validation_failed` и `sscc_exhausted` выбрасывают запрос. Дозаказ идёт по одному (`createBlockSupply` делит идущий между вызовами).
- **Доставка** — планировщик в `useHostLink` рядом с чтением смен: живёт, пока живёт связь; запуск — после подписки, после каждого события ревизии, по просьбе экрана после локальной записи (`requestFacts`), сразу после полной пачки, по повтору после сбоя, пока связь `online`, и сразу при возвращении связи. Каждая отправка считается в `attempts`. Квитанции сверяются с записями по числу и месту (`ReceiptMismatchError` иначе) и применяются одной транзакцией. Причина последнего сбоя — `ShellState.factsFailure` (`offline` — транспорт, `host` — ответ хоста с ошибкой, нечитаемый или не отвечающий записям, `local` — база этого компьютера).
- **Предел записи** — 16 КиБ JSON (`MAX_RECORD_BYTES`): сто записей не превысят 2 МиБ тела хоста, а запись скана — около 1,3 КБ (канонический код не длиннее 1024 байт).
- **`protocol_unsupported`** на отправке — обычный сбой с повтором; экран «обновите хост» — в «Перенесено» (хост и станция пилота ставятся одним установщиком).
- **`WorkScreenProps`** расширяются обязательными свойствами (`source`, `checkCode`, `requestBlock`, `onHostError`, `onRecorded`) и необязательным `signal`: рабочему экрану нужны сканер, вызовы хоста и доставка, а `FloorApp` их держит. `onRecorded` — `outbox_changed` в оболочку и `requestFacts()`.
- **Строка состояния**: «Не отправлено» — всегда (в том числе 0); «Отклонено хостом» и «Конфликтов» — только больше нуля; «Номеров SSCC» — в смене, для префикса её снимка; сбой хоста или этого компьютера — предупреждение словами; сбой связи показывает строка связи (`HostStatusLine`).
- **Уведомление «План выполнен»** — один раз за вход в рабочий экран, не останавливает сканирование; закрытие смены — план 2a8.

## Контракт для 2a7–2a8

**Протокол (`src/host/protocol.ts`, `src/host/api.ts`).** Схемы `scanFactSchema`, `boxClosedFactSchema`, `boxLabelFactSchema`, `boxExceptionFactSchema`, `shiftClosedFactSchema`, `factRecordSchema` (строгие), `factReceiptSchema`, `codeCheckSchema`, `ssccBlockSchema`, `ssccBlockRequestSchema`, `FACT_RECEIPT_CODES`, `MAX_FACT_BATCH = 100`; `HostApi.requestSsccBlock`, `checkCode` (`CODE_CHECK_TIMEOUT_MS = 300`), `sendFacts(records: readonly unknown[])`.

**Записи (`src/floor/facts.ts`).** `scanRecord`, `boxClosedRecord`, `boxLabelRecord` (2a7: проверка этикетки), `boxExceptionRecord`, `shiftClosedRecord` (2a8) — `(head: RecordHead, data) => FactRecord`; `outboxStatement(record, pairing, createdAt): LocalStatement` — строка `outbox` для транзакции самого факта (проверка схемой и `MAX_RECORD_BYTES`, `expectedChanges: 1`); `scannedCode(km)`. Каждая запись факта — в той же `local_transaction`, что и её последствия.

**Закрытие короба (`src/floor/work/box-close.ts`).**

```ts
type CloseStep = (box: ClosingBox) => Promise<CloseAddition>;
interface CloseAddition { statements: readonly LocalStatement[]; data?: Readonly<Record<string, unknown>> }
interface ClosingBox { boxId; shiftId; sscc; blockId; serial; openedAt; closedAt; itemCount; codeHashes; operatorId }
closeOpenBox(context: BoxContext, steps?: readonly CloseStep[]): Promise<CloseResult>
closeIfFull(context: BoxContext, steps?: readonly CloseStep[]): Promise<CloseResult | null>
type CloseResult = { kind: "closed"; box: ClosingBox } | { kind: "empty" } | { kind: "no_serials" } | { kind: "invalid_serial" } | { kind: "stale" }
```

План 2a7 передаёт шаг, который строит байты этикетки из снимка и `ClosingBox` (`closedAt` — сохранённое время закрытия) и добавляет `INSERT INTO floor_print_jobs … 'prepared'` — задание печати ложится той же транзакцией, что закрытие; отправку на принтер он начинает после результата `closed`. План ПЛ-Ц передаёт шаг, который читает открытую паллету станции и добавляет присоединение короба (и `data: { palletId }` после своей правки `boxClosedFactSchema` и `PROTOCOL_VERSION`). Поля самой записи `box_closed` добавка не перекрывает; поле, которого нет в схеме, роняет закрытие целиком.

**Рабочий экран (`src/floor/work/WorkScreen.tsx`).** Все закрытия идут через одну функцию `closeBox(full)` компонента (полный короб после скана, при входе, неполный после подтверждения, повтор): план 2a7 передаёт в неё свои `CloseStep` и после `closed` начинает печать. Вся работа, которая пишет базу, идёт в очереди `queue.run(…)` и отдаётся `track`. Остановки работы — объединение `Stop` (`system_error`, `confirm_close`, `no_serials`, `close_failed`): план 2a7 добавляет восстановление печати и ожидание проверки этикетки, план 2a8 — исключения и сводку закрытия; пока `stopRef.current !== null`, обычный скан не принимается. Скан SSCC при ждущей проверке этикетки план 2a7 перехватывает в `scan` до `processScan`. После каждой локальной записи — `onRecorded()`.

**Конвейер (`src/floor/work/scan-pipeline.ts`).** `processScan(context: ScanContext, raw): Promise<ScanOutcome>`, `readScan(raw)`, `ScanContext { local; pairing; shift; operatorId; online(); checkCode; onHostError; now; newId }`. Счётчик короба и `floor_codes` держит конвейер; исключения 2a8 (`undo`, `clear`, `disassemble`) удаляют строки `floor_codes`, уменьшают `item_count` и пишут `box_exception` одной транзакцией.

**Доставка (`src/local/facts-sender.ts`, `src/app/host-link.ts`).** `sendFactBatch(local, pairing, send, now)`; транзакция квитанций — три `UPDATE … json_each`: план 2a8 добавляет в неё четвёртый — `local_state = 'closed'` у смены, чья запись `shift_closed` получила `accepted` (в том числе `details.alreadyClosed`). `useHostLink` возвращает `{ requestSync, requestFacts }`. Отклонённая запись не отправляется снова под тем же `id`.

**Оболочка (`src/app/shell.ts`).** `ShellState.outboxVersion` (действие `outbox_changed` — любая запись цеха, применённые квитанции, сохранённый блок) и `ShellState.factsFailure: "offline" | "host" | "local" | null` (действия `facts_failed`, `facts_sent`). `FloorApp` получает `checkCode`, `requestBlock`, `requestFacts`, `rejectionPending`.

**Чтения (`src/floor/work/work-reads.ts`, `src/floor/outbox-status.ts`, `block-supply.ts`).** `readOpenBox`, `readWorkTotals` (`accepted` — коды смены в `floor_codes`: факт для сводки закрытия 2a8; `closedBoxes` — закрытые без `disassembled_at`), `readOutboxStatus`, `readSerialsLeft`, `remainingSerials`.

**Тексты.** Ключи `floor.work.*` (без `floor.work.stub`), `floor.status.serials`, `unsent`, `rejected`, `conflicts`, `factsHost`, `factsLocal`.

## Заметки для исполнения

**Основа плана**

- 2a6 стоит на коде планов 2a1–2a5 в ветке (2a2 — хост фактов и фикстуры `proto`, 2a3 — офис, 2a4 — оболочка и `src/hardware/hardware.ts`, 2a5 — миграция `0006`, копии смен, `FloorApp`, заглушка `WorkScreen`). Перед задачей 1 убедиться, что `git log --oneline` содержит их коммиты, а `apps/standalone/proto/fixtures/facts-request.json`, `src-tauri/migrations/0006_floor_production.sql` и `src/floor/work/WorkScreen.tsx` есть; если чего-то нет — остановиться и назвать это в отчёте.
- Фрагменты построены сценарием на копии репозитория: ветка `p2a5-scratch` (`883e4f1ad` — копия планировщика 2a5: `claude/2a4-shell` на `939a2c8dc`, влитые `bf4235cc8` и `claude/2a3-office` на `1756f5664`, задачи 5–9 плана 2a4 и задачи 1–9 плана 2a5, применённые по тексту планов), затем влиты `c875f9ded` (дерево, из которого сгенерирован план 2a2) и голова `claude/2a3-office` (`105ad8bca`), и сделан один слиятельный коммит: обязательное `totals` в `officeShiftSchema` и в `ACTIVE` из `test/support/shifts.ts` (это делает ветка, которая сливается второй, — §16 плана 2a3). Задача за задачей план применён к этой копии, и каждая команда ниже запущена на ней; затем текст плана разобран сценарием и применён к чистой копии той же основы — деревья совпали побайтно. Настоящее дерево будет другим (исполненные 2a2–2a5): фрагмент, который из-за этого не находится, применяется к тому же месту по смыслу, а расхождение записывается в «Отклонения при исполнении». Номер раздела спецификации задачи 9 — следующий свободный.

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, с отступами; на свою очередь он встречается в файле ровно один раз. Фрагменты одной правки идут сверху вниз по файлу и применяются по порядку. Шаг 1 (тесты) применяется раньше шага 3 (реализация).
- «Создать» — новый файл, ровно как в блоке. «Заменить целиком» — файл получает содержимое блока.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках отформатирован prettier: расхождение при проверке значит опечатку.
- Русский текст в коде и в `ru.json` — буквами. Каждая задача с вебвью кончается `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное совпадение — `src/host/pairing-code.ts:66`. Разделитель групп GS1 в тестах пишется `\u001d`, неразрывный пробел — `\u00a0`.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие защиты. Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из шага; команда — ожидаемый FAIL с названным тестом; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить. «FAIL — прогон с необработанной ошибкой» значит: тесты зелёные, но Vitest завершается с кодом 1 из-за `Unhandled Rejection`.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON, CSS, MD; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `run lint`; `git diff --check`.

**pnpm, git и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. Команды — из корня репозитория, без `cd`. Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата; если обёртка `rtk` урезала вывод, `rtk proxy <команда>`.
- В свежем worktree сначала: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`. Cargo плану не нужен: Rust не меняется.
- React 19.2 запускает пассивные эффекты задачей планировщика (`setImmediate`), а `waitFor` после успеха ждёт `setTimeout(0)`: утверждение сразу после ожидания, которое зависит от следующего эффекта или рендера, — скрытый флейк. Поэтому тесты рабочего экрана сканируют и нажимают внутри одного асинхронного `act`, который дожидается ворот работы (`scan`, `press`), ждут подписки сканера (`listening()`), а числа, которые экран читает после работы, начатой эффектом, проверяют через `waitFor`. Новые и изменённые тестовые файлы с React (задачи 2, 6–9) один раз запускаются с `--reporter=verbose` (stderr пуст) и один раз под стендом с задержкой `setImmediate` на 3 мс — два временных файла внутри пакета, удалить сразу после прогона, до `lint`:

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
- Под сильной нагрузкой машины полный прогон Vitest роняет тайм-аутом 5 с старые тесты офиса, которых план не трогает (`shifts-page`, `shift-dialog`, `shift-edit`, `shift-delete-close`, `template-editor`, `templates-page`, `template-defaults-page`, `products-page`): на копии плана при средней загрузке около 25 таких было 11, и отдельным прогоном они проходили; при загрузке 45–70 они падали и отдельным прогоном, и на основе плана без его изменений. Это не дефект плана; падение в полном прогоне записывается и разбирается (сверка с основой, отдельный прогон), а не лечится повтором.

**Счёт тестов** (измерено `vitest list` на копии плана; на настоящем дереве числа сдвигаются на тесты, которых на копии нет)

- До плана: Vitest — 87 файлов, 2217 тестов.
- После задач: 1 — 88, 2240; 2 — 89, 2248; 3 — 90, 2263; 4 — 91, 2273; 5 — 92, 2284; 6 — 94, 2301; 7 — 94, 2305; 8 — 96, 2322; 9 — 96, 2323.
- После: Vitest — 96 файлов, 2323 теста; Cargo не меняется.

## Файлы

Задачи выполняются по порядку: 1 — протокол, 2 — источник сканов, 3–5 — данные цеха (скан, короб, блоки), 6–7 — доставка и строка состояния, 8 — рабочий экран, который всё собирает, 9 — сквозной тест и документы.

<!-- prettier-ignore -->
```text
apps/standalone/src/host/{protocol,api}.ts, src/floor/facts.ts (новый)          задача 1
apps/standalone/test/{protocol,api}.test.ts, test/floor-facts.test.ts (новый),
apps/standalone/test/support/office.tsx                                          задача 1
apps/standalone/src/floor/scan-source.ts, src/app/App.tsx                       задачи 2, 6–8
apps/standalone/test/floor-scan-source.test.ts (новый), test/app.test.tsx        задачи 2, 6, 9
apps/standalone/src/floor/work/{scan-pipeline,work-queue,work-reads}.ts (новые),
apps/standalone/test/floor-scan-pipeline.test.ts, test/support/floor-work.ts (новые)  задача 3
apps/standalone/src/floor/work/box-close.ts, test/floor-box-close.test.ts (новые)   задача 4
apps/standalone/test/support/floor-work.ts                                       задачи 4, 6
apps/standalone/src/floor/work/block-supply.ts, test/floor-block-supply.test.ts (новые)  задача 5
apps/standalone/src/local/facts-sender.ts (новый), src/app/{host-link,shell}.ts,
apps/standalone/test/{facts-sender,host-link-facts}.test.ts (новые),
apps/standalone/test/{host-link-shifts,shell}.test.ts                            задача 6
apps/standalone/src/floor/{outbox-status.ts (новый),FloorStatusBar.tsx},
apps/standalone/test/floor-status-bar.test.tsx                                   задача 7
apps/standalone/src/i18n/ru.json                                                 задачи 7, 8
apps/standalone/src/floor/work/{WorkScreen.tsx,signal-sound.ts (новый)}, src/floor/FloorApp.tsx,
apps/standalone/src/app/shell.css, test/floor-work-screen.test.tsx (новый),
apps/standalone/test/{signal-sound.test.ts (новый),floor-app.test.tsx}            задача 8
apps/standalone/AGENTS.md, спецификация этапа (раздел «Уточнения плана 2a6»)        задача 9
```

---

### Task 1: Протокол цеха — схемы фактов, квитанций, проверки кода и блока; построители записей; `HostApi`

Zod по фикстурам плана 2a2: записи пяти видов (`factRecordSchema` — строгий конверт `{ id, kind, shiftId, operatorId, data }` с данными по виду, как `FactRecord` хоста с `deny_unknown_fields`), пачка 1–100 записей, квитанция (ответ: код квитанции — текст, чтобы код нового хоста не ронял пачку), проверка кода, блок SSCC и его запрос. Список кодов квитанций сверяется с `fact-receipt-codes.json`. Построители записей (`src/floor/facts.ts`) и строка `outbox` для транзакции самого факта: запись проверяется схемой и размером (`MAX_RECORD_BYTES`, 16 КиБ: сто записей не превысят 2 МиБ тела хоста, после которых хост отвечает 413 и пачка встала бы навсегда) и хранится целиком как payload, который уходит на хост. `scannedCode` переводит прочитанный доменом КМ в поля факта: хеш без криптохвоста (`kmHash`), канонический текст — с разделителями и хвостом. Методы `HostApi` идут с ключом устройства; проверка кода — с `timeoutMs: 300`.

**Files:**

- Create: `apps/standalone/src/floor/facts.ts`
- Modify: `apps/standalone/src/host/api.ts`, `apps/standalone/src/host/protocol.ts`
- Test: `apps/standalone/test/floor-facts.test.ts` (Create), `apps/standalone/test/api.test.ts` (Modify), `apps/standalone/test/protocol.test.ts` (Modify), `apps/standalone/test/support/office.tsx` (Modify)

**Interfaces:**

- Consumes: фикстуры плана 2a2 `proto/fixtures/{facts-request,facts-response,fact-receipt-codes,code-check-free,code-check-taken}.json` и плана 2a1 `sscc-block.json`, `sscc-block-request.json`; `HostRequestOptions.timeoutMs` (план 2a4, `src/host/client.ts`); `kmHash`, `ParsedKm` (`@markiro/domain`); `LocalStatement` (`src/local/executor.ts`), `Pairing` (`src/local/reference-sync.ts`).
- Produces:
  - `src/host/protocol.ts`: `codeOwnerSchema`, `type CodeOwner`, `codeCheckSchema`, `type CodeCheck`, `ssccBlockSchema`, `type SsccBlock`, `FACT_OUTCOMES`, `type FactOutcome`, `FACT_RECEIPT_CODES`, `factReceiptSchema`, `type FactReceipt`, `factReceiptsSchema`, `ssccBlockRequestSchema`, `type SsccBlockRequest`, `SCAN_VERDICTS`, `type ScanVerdict`, `SCAN_RAW_KINDS`, `type ScanRawKind`, `scannedCodeSchema`, `type ScannedCode`, `scanFactSchema`, `type ScanFact`, `boxClosedFactSchema`, `type BoxClosedFact`, `boxLabelFactSchema`, `type BoxLabelFact`, `boxExceptionFactSchema`, `type BoxExceptionFact`, `shiftClosedFactSchema`, `type ShiftClosedFact`, `factRecordSchema`, `type FactRecord`, `type FactKind`, `MAX_FACT_BATCH = 100`, `factBatchSchema`;
  - `src/floor/facts.ts`: `interface RecordHead { id; shiftId; operatorId: string | null }`, `scanRecord`, `boxClosedRecord`, `boxLabelRecord`, `boxExceptionRecord`, `shiftClosedRecord` — `(head, data) => FactRecord`; `scannedCode(km: ParsedKm): ScannedCode`; `MAX_RECORD_BYTES = 16 * 1024`; `class RecordTooLargeError`; `outboxStatement(record: FactRecord, pairing: Pairing, createdAt: string): LocalStatement`;
  - `src/host/api.ts`: `HostApi.requestSsccBlock(request) → Promise<SsccBlock>`, `checkCode(codeHash) → Promise<CodeCheck>`, `sendFacts(records: readonly unknown[]) → Promise<FactReceipt[]>`; `CODE_CHECK_TIMEOUT_MS = 300`;
  - `test/support/office.tsx`: `fakeHostApi` отвечает на три новых метода отказом («unexpected»), пока тест их не задал.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/api.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import { createHostApi, type HostApi } from "../src/host/api.js";
import type { HostClient, HttpMethod } from "../src/host/client.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import { CODE_CHECK_TIMEOUT_MS, createHostApi, type HostApi } from "../src/host/api.js";
import type { HostClient, HttpMethod } from "../src/host/client.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  deviceUpdateSchema,
  labelTemplateSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
  deviceUpdateSchema,
  factBatchSchema,
  labelTemplateSchema,
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  shiftUpdateSchema,
  templateCreateSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
  shiftUpdateSchema,
  ssccBlockRequestSchema,
  templateCreateSchema,
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  officeToken: string | undefined;
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  officeToken: string | undefined;
  /** Only the code check limits its request. */
  timeoutMs?: number;
}
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
    request: async (method, path, options) => {
      sent.push({ method, path, body: options.body, officeToken: options.officeToken });
      return options.schema.parse(answer);
```

заменить на:

<!-- prettier-ignore -->
```ts
    request: async (method, path, options) => {
      sent.push({
        method,
        path,
        body: options.body,
        officeToken: options.officeToken,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      return options.schema.parse(answer);
```

Фрагмент 6:

<!-- prettier-ignore -->
```ts
    });
  });
});
```

заменить на:

<!-- prettier-ignore -->
```ts
    });
  });
});

describe("HostApi floor work", () => {
  const BLOCK_REQUEST = ssccBlockRequestSchema.parse(fixture("sscc-block-request.json"));
  const RECORDS = factBatchSchema.parse(fixture("facts-request.json")).records;
  const CODE_HASH = "3f6c0f1e2d8b4a5c9e7f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f";

  it("asks for a block, checks a code within 300 ms and sends facts, with the device key only", async () => {
    const block = recording(fixture("sscc-block.json"));
    await expect(block.api.requestSsccBlock(BLOCK_REQUEST)).resolves.toEqual(
      fixture("sscc-block.json"),
    );
    const check = recording(fixture("code-check-taken.json"));
    await expect(check.api.checkCode(CODE_HASH)).resolves.toEqual(fixture("code-check-taken.json"));
    const facts = recording(fixture("facts-response.json"));
    await expect(facts.api.sendFacts(RECORDS)).resolves.toEqual(
      (fixture("facts-response.json") as { receipts: unknown[] }).receipts,
    );
    expect(CODE_CHECK_TIMEOUT_MS).toBe(300);
    expect([...block.sent, ...check.sent, ...facts.sent]).toEqual([
      {
        method: "POST",
        path: "/v1/device/sscc/blocks",
        body: BLOCK_REQUEST,
        officeToken: undefined,
      },
      {
        method: "GET",
        path: `/v1/device/codes/${CODE_HASH}`,
        body: undefined,
        officeToken: undefined,
        timeoutMs: 300,
      },
      {
        method: "POST",
        path: "/v1/device/facts",
        body: { records: RECORDS },
        officeToken: undefined,
      },
    ]);
  });

  it("rejects a block, a check or receipts in another shape", async () => {
    await expect(recording({ id: "x" }).api.requestSsccBlock(BLOCK_REQUEST)).rejects.toThrow();
    await expect(recording({ status: "maybe" }).api.checkCode(CODE_HASH)).rejects.toThrow();
    await expect(recording({ receipts: [{ id: null }] }).api.sendFacts(RECORDS)).rejects.toThrow();
  });
});
```

Создать `apps/standalone/test/floor-facts.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { canonicalizeKm, kmHash } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  boxClosedRecord,
  boxExceptionRecord,
  boxLabelRecord,
  MAX_RECORD_BYTES,
  outboxStatement,
  RecordTooLargeError,
  scanRecord,
  scannedCode,
  shiftClosedRecord,
  type RecordHead,
} from "../src/floor/facts.js";
import {
  boxClosedFactSchema,
  boxExceptionFactSchema,
  boxLabelFactSchema,
  factBatchSchema,
  MAX_FACT_BATCH,
  scanFactSchema,
  shiftClosedFactSchema,
  type FactRecord,
} from "../src/host/protocol.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const RECORDS = factBatchSchema.parse(fixture("facts-request.json")).records;
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };

/** The fixture's record `index`, asserted to exist rather than cast away. */
function record(index: number): FactRecord {
  const found = RECORDS[index];
  if (found === undefined) throw new Error(`facts-request.json has no record ${index}`);
  return found;
}

/** The code of a fixture's scan record. */
function code(of: FactRecord) {
  const data = scanFactSchema.parse(of.data);
  if (data.code === null) throw new Error("the record carries no code");
  return data.code;
}

function head(of: FactRecord): RecordHead {
  return { id: of.id, shiftId: of.shiftId, operatorId: of.operatorId };
}

// A product code as a scanner hands it over: the AIM prefix `]d2`, the GTIN,
// the serial, then the group separator and the crypto tail.
const SERIAL = "5Yq'Ct;";
const RAW = `]d2010460068200001321${SERIAL}\u001d93dGVz`;

describe("the builders of the outbox's records", () => {
  it("build every record of facts-request.json exactly", () => {
    expect(scanRecord(head(record(0)), scanFactSchema.parse(record(0).data))).toEqual(record(0));
    expect(scanRecord(head(record(1)), scanFactSchema.parse(record(1).data))).toEqual(record(1));
    expect(boxClosedRecord(head(record(2)), boxClosedFactSchema.parse(record(2).data))).toEqual(
      record(2),
    );
    expect(boxLabelRecord(head(record(3)), boxLabelFactSchema.parse(record(3).data))).toEqual(
      record(3),
    );
    expect(
      boxExceptionRecord(head(record(4)), boxExceptionFactSchema.parse(record(4).data)),
    ).toEqual(record(4));
    expect(shiftClosedRecord(head(record(5)), shiftClosedFactSchema.parse(record(5).data))).toEqual(
      record(5),
    );
  });

  it("carry a code as the domain read it: the hash without the tail, the canonical text with it", () => {
    const km = canonicalizeKm(RAW);
    expect(scannedCode(km)).toEqual({
      codeHash: kmHash(km),
      gtin14: "04600682000013",
      serial: SERIAL,
      canonical: `010460068200001321${SERIAL}\u001d93dGVz`,
    });
    // The same code without the AIM prefix, or with another tail, is the same code.
    const bare = scannedCode(canonicalizeKm(`010460068200001321${SERIAL}\u001d93dGVz`));
    const otherTail = scannedCode(canonicalizeKm(`010460068200001321${SERIAL}\u001d93xxxx`));
    expect(bare.codeHash).toBe(scannedCode(km).codeHash);
    expect(otherTail.codeHash).toBe(scannedCode(km).codeHash);
    expect(otherTail.canonical).not.toBe(bare.canonical);
    expect(scannedCode(km).codeHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the outbox row of a record", () => {
  it("keeps the whole record as its payload, under the pairing, in one row", async () => {
    const { db, executor } = openLocalDb();
    const statement = outboxStatement(record(0), PAIRING, "2026-10-08T06:15:02.418Z");
    expect(statement.expectedChanges).toBe(1);
    await executor.transaction([statement]);
    const rows = db
      .prepare(
        "SELECT id, host_id, device_id, kind, shift_id, payload, created_at, attempts, acked_at FROM outbox",
      )
      .all();
    expect(rows).toEqual([
      {
        id: record(0).id,
        host_id: HOST_ID,
        device_id: DEVICE_ID,
        kind: "scan",
        shift_id: record(0).shiftId,
        payload: JSON.stringify(record(0)),
        created_at: "2026-10-08T06:15:02.418Z",
        attempts: 0,
        acked_at: null,
      },
    ]);
    const payload = z.string().parse(rows[0]?.["payload"]);
    expect(JSON.parse(payload)).toEqual(record(0));
  });

  it("refuses a record this build cannot form, and writes nothing", () => {
    const bad = { ...record(2), operatorId: "0042" };
    expect(() => outboxStatement(bad, PAIRING, "2026-10-08T06:15:02.418Z")).toThrow();
    const notMine = { ...record(0), kind: "box_closed" } as FactRecord;
    expect(() => outboxStatement(notMine, PAIRING, "2026-10-08T06:15:02.418Z")).toThrow();
  });

  it("keeps no record larger than a batch of 100 can carry under the host's 2 MiB", () => {
    expect(MAX_RECORD_BYTES * MAX_FACT_BATCH).toBeLessThan(2 * 1024 * 1024);
    const scan = record(0);
    const sized = (canonical: string): FactRecord =>
      scanRecord(head(scan), {
        ...scanFactSchema.parse(scan.data),
        code: { ...code(scan), canonical },
      });
    const base = JSON.stringify(sized("")).length;
    // Cyrillic letters are two bytes each: the limit is in bytes, not characters.
    const fits = sized("ж".repeat((MAX_RECORD_BYTES - base) / 2));
    expect(new TextEncoder().encode(JSON.stringify(fits)).length).toBe(MAX_RECORD_BYTES);
    expect(() => outboxStatement(fits, PAIRING, "2026-10-08T06:15:02.418Z")).not.toThrow();
    const over = sized(`${"ж".repeat((MAX_RECORD_BYTES - base) / 2)}x`);
    expect(() => outboxStatement(over, PAIRING, "2026-10-08T06:15:02.418Z")).toThrow(
      RecordTooLargeError,
    );
  });
});
```

Правка `apps/standalone/test/protocol.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  changesResponseSchema,
  counterpartyCreateSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
  changesResponseSchema,
  codeCheckSchema,
  counterpartyCreateSchema,
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  errorBodySchema,
  helloSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
  errorBodySchema,
  FACT_RECEIPT_CODES,
  factBatchSchema,
  factReceiptsSchema,
  factRecordSchema,
  helloSchema,
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  siteRecordSchema,
  ssccCounterUpdateSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
  siteRecordSchema,
  ssccBlockRequestSchema,
  ssccBlockSchema,
  ssccCounterUpdateSchema,
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  ["device-shift-entered.json", enteredShiftSchema],
] as const;
```

заменить на:

<!-- prettier-ignore -->
```ts
  ["device-shift-entered.json", enteredShiftSchema],
  ["sscc-block.json", ssccBlockSchema],
  ["code-check-free.json", codeCheckSchema],
  ["code-check-taken.json", codeCheckSchema],
  ["facts-response.json", factReceiptsSchema],
] as const;
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
  ["device-shift-create.json", deviceShiftCreateSchema],
] as const;
```

заменить на:

<!-- prettier-ignore -->
```ts
  ["device-shift-create.json", deviceShiftCreateSchema],
  ["sscc-block-request.json", ssccBlockRequestSchema],
  ["facts-request.json", factBatchSchema],
] as const;
```

Фрагмент 6:

<!-- prettier-ignore -->
```ts
    expect(credentialSchema.parse(body.error.details?.credential)).toBe("session");
  });
});
```

заменить на:

<!-- prettier-ignore -->
```ts
    expect(credentialSchema.parse(body.error.details?.credential)).toBe("session");
  });
});

describe("facts of the floor", () => {
  const RECORDS = factBatchSchema.parse(fixture("facts-request.json")).records;

  it("know every receipt code of the host", () => {
    expect(fixture("fact-receipt-codes.json")).toEqual({ codes: [...FACT_RECEIPT_CODES] });
  });

  it("send 1 to 100 records in a batch", () => {
    const [first] = RECORDS;
    expect(factBatchSchema.safeParse({ records: [] }).success).toBe(false);
    expect(factBatchSchema.safeParse({ records: Array(100).fill(first) }).success).toBe(true);
    expect(factBatchSchema.safeParse({ records: Array(101).fill(first) }).success).toBe(false);
  });

  it("read a record's data by its kind, and no other", () => {
    const [scan, , closed] = RECORDS;
    expect(factRecordSchema.safeParse({ ...scan, kind: "box_closed" }).success).toBe(false);
    expect(factRecordSchema.safeParse({ ...closed, kind: "scan" }).success).toBe(false);
    expect(factRecordSchema.safeParse({ ...scan, kind: "pallet_closed" }).success).toBe(false);
    expect(factRecordSchema.safeParse({ ...scan, operatorId: null }).success).toBe(true);
    expect(factRecordSchema.safeParse({ ...scan, operatorId: "0042" }).success).toBe(false);
  });

  it("take a receipt code a newer host adds, and refuse a taken code without its owner", () => {
    const later = { receipts: [{ id: null, outcome: "rejected", code: "added_later" }] };
    expect(factReceiptsSchema.parse(later)).toEqual(later);
    expect(
      factReceiptsSchema.safeParse({ receipts: [{ id: null, outcome: "lost" }] }).success,
    ).toBe(false);
    expect(codeCheckSchema.safeParse({ status: "taken" }).success).toBe(false);
  });
});
```

Правка `apps/standalone/test/support/office.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
    enterShift: vi.fn<HostApi["enterShift"]>(() => unexpected("enterShift")),
    ...overrides,
```

заменить на:

<!-- prettier-ignore -->
```tsx
    enterShift: vi.fn<HostApi["enterShift"]>(() => unexpected("enterShift")),
    requestSsccBlock: vi.fn<HostApi["requestSsccBlock"]>(() => unexpected("requestSsccBlock")),
    checkCode: vi.fn<HostApi["checkCode"]>(() => unexpected("checkCode")),
    sendFacts: vi.fn<HostApi["sendFacts"]>(() => unexpected("sendFacts")),
    ...overrides,
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/api.test.ts test/floor-facts.test.ts test/protocol.test.ts`
Expected: FAIL — `test/api.test.ts` и `test/protocol.test.ts` не загружаются (`Cannot read properties of undefined (reading 'parse')`: схем ещё нет), `test/floor-facts.test.ts` — `Failed to resolve import "../src/floor/facts.js"`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/floor/facts.ts`:

<!-- prettier-ignore -->
```ts
import { kmHash, type ParsedKm } from "@markiro/domain";

import {
  factRecordSchema,
  type BoxClosedFact,
  type BoxExceptionFact,
  type BoxLabelFact,
  type FactRecord,
  type ScanFact,
  type ScannedCode,
  type ShiftClosedFact,
} from "../host/protocol.js";
import type { LocalStatement } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";

/**
 * The envelope of a record: its own id (a UUID this station made up, which
 * keys the host's receipt), the shift, and the operator signed in.
 */
export interface RecordHead {
  id: string;
  shiftId: string;
  operatorId: string | null;
}

/** A `scan` record: every scan of the work screen, accepted or not. */
export function scanRecord(head: RecordHead, data: ScanFact): FactRecord {
  return { ...head, kind: "scan", data };
}

/** A `box_closed` record: a box closed with the SSCC of one of this station's blocks. */
export function boxClosedRecord(head: RecordHead, data: BoxClosedFact): FactRecord {
  return { ...head, kind: "box_closed", data };
}

/** A `box_label` record: the check of a closed box's label (plan 2a7). */
export function boxLabelRecord(head: RecordHead, data: BoxLabelFact): FactRecord {
  return { ...head, kind: "box_label", data };
}

/** A `box_exception` record (plan 2a8). */
export function boxExceptionRecord(head: RecordHead, data: BoxExceptionFact): FactRecord {
  return { ...head, kind: "box_exception", data };
}

/** A `shift_closed` record: this station closed its shift (plan 2a8). */
export function shiftClosedRecord(head: RecordHead, data: ShiftClosedFact): FactRecord {
  return { ...head, kind: "shift_closed", data };
}

/**
 * A code of marking as a fact carries it, from what the domain's
 * `canonicalizeKm` read: the hash that identifies the code (`kmHash`, without
 * its crypto tail), its GTIN and serial, and the canonical text with its
 * group separators and tail, which the exports of stage 4 need.
 */
export function scannedCode(km: ParsedKm): ScannedCode {
  return { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial, canonical: km.raw };
}

/**
 * The largest record the outbox keeps, in bytes of its JSON. A scan's record
 * is about 1.3 KB at most (a canonical code of 1024 bytes), so this only
 * keeps out a record no fact makes; and a batch of 100 such records stays
 * under the host's 2 MiB body limit, past which the host answers 413 and
 * the same batch would be refused for good.
 */
export const MAX_RECORD_BYTES = 16 * 1024;

/** A record larger than `MAX_RECORD_BYTES`: never kept, so it can never block the outbox. */
export class RecordTooLargeError extends Error {
  constructor(bytes: number) {
    super(`a record of ${bytes} bytes`);
    this.name = "RecordTooLargeError";
  }
}

/**
 * The outbox row of a record, for the transaction that writes the fact
 * itself (stage 2a spec, decision 11): the record is checked against its
 * schema and its size first, so a record this build cannot form, or one too
 * large to send, is never kept, and it is kept whole as the payload it is
 * sent as.
 */
export function outboxStatement(
  record: FactRecord,
  pairing: Pairing,
  createdAt: string,
): LocalStatement {
  const checked = factRecordSchema.parse(record);
  const payload = JSON.stringify(checked);
  const bytes = new TextEncoder().encode(payload).length;
  if (bytes > MAX_RECORD_BYTES) throw new RecordTooLargeError(bytes);
  return {
    sql:
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
    values: [
      checked.id,
      pairing.hostId,
      pairing.deviceId,
      checked.kind,
      checked.shiftId,
      payload,
      createdAt,
    ],
    expectedChanges: 1,
  };
}
```

Правка `apps/standalone/src/host/api.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  changesResponseSchema,
  counterpartyRecordSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
  changesResponseSchema,
  codeCheckSchema,
  counterpartyRecordSchema,
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  enteredShiftSchema,
  labelTemplateSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
  enteredShiftSchema,
  factReceiptsSchema,
  labelTemplateSchema,
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  officeShiftSchema,
  ssccCounterSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
  officeShiftSchema,
  ssccBlockSchema,
  ssccCounterSchema,
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  type ChangesResponse,
  type CounterpartyCreate,
```

заменить на:

<!-- prettier-ignore -->
```ts
  type ChangesResponse,
  type CodeCheck,
  type CounterpartyCreate,
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
  type EnteredShift,
  type LabelTemplate,
```

заменить на:

<!-- prettier-ignore -->
```ts
  type EnteredShift,
  type FactReceipt,
  type LabelTemplate,
```

Фрагмент 6:

<!-- prettier-ignore -->
```ts
  type ShiftUpdate,
  type SsccCounter,
```

заменить на:

<!-- prettier-ignore -->
```ts
  type ShiftUpdate,
  type SsccBlock,
  type SsccBlockRequest,
  type SsccCounter,
```

Фрагмент 7:

<!-- prettier-ignore -->
```ts
  enterShift: (id: string) => Promise<EnteredShift>;
}

/** A 204 answer parses as `null`. */
```

заменить на:

<!-- prettier-ignore -->
```ts
  enterShift: (id: string) => Promise<EnteredShift>;
  /**
   * A block of SSCC serials for this station; the same `requestId` answers the
   * same block, and the same id with another prefix is `validation_failed` on
   * `requestId`. Stations only.
   */
  requestSsccBlock: (request: SsccBlockRequest) => Promise<SsccBlock>;
  /**
   * Whether an accepted scan on the host owns the code (`kmHash`), within
   * `CODE_CHECK_TIMEOUT_MS`: past it the call fails with the transport code
   * `timeout`, and the station decides on its own copy.
   */
  checkCode: (codeHash: string) => Promise<CodeCheck>;
  /**
   * The outbox's records as kept (1–100, `FactRecord` each); a receipt per
   * record, in their order. A failed call is no receipt: the batch is sent
   * again.
   */
  sendFacts: (records: readonly unknown[]) => Promise<FactReceipt[]>;
}

/** How long the scan pipeline waits for the host's code check (stage 2a spec, decision 16). */
export const CODE_CHECK_TIMEOUT_MS = 300;

/** A 204 answer parses as `null`. */
```

Фрагмент 8:

<!-- prettier-ignore -->
```ts
      client.request("POST", `/v1/device/shifts/${id}/enter`, { schema: enteredShiftSchema }),
    closeShift: (token, id, close) =>
```

заменить на:

<!-- prettier-ignore -->
```ts
      client.request("POST", `/v1/device/shifts/${id}/enter`, { schema: enteredShiftSchema }),
    requestSsccBlock: (request) =>
      client.request("POST", "/v1/device/sscc/blocks", { body: request, schema: ssccBlockSchema }),
    checkCode: (codeHash) =>
      client.request("GET", `/v1/device/codes/${encodeURIComponent(codeHash)}`, {
        timeoutMs: CODE_CHECK_TIMEOUT_MS,
        schema: codeCheckSchema,
      }),
    sendFacts: async (records) =>
      (
        await client.request("POST", "/v1/device/facts", {
          body: { records },
          schema: factReceiptsSchema,
        })
      ).receipts,
    closeShift: (token, id, close) =>
```

Правка `apps/standalone/src/host/protocol.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
export type EnteredShift = z.infer<typeof enteredShiftSchema>;

// --- Request bodies (strict) ---
```

заменить на:

<!-- prettier-ignore -->
```ts
export type EnteredShift = z.infer<typeof enteredShiftSchema>;

/**
 * The scan that owns a code on the host (`markiro_proto::CodeOwner`): the
 * earliest accepted scan of it. `sameDevice` says the scan is this
 * station's own. A `conflict` receipt names its winner in this shape too.
 */
export const codeOwnerSchema = z.object({
  shiftId: z.uuid(),
  shiftNumber: z.string(),
  deviceId: z.uuid(),
  scannedAt: z.string(),
  sameDevice: z.boolean(),
});
export type CodeOwner = z.infer<typeof codeOwnerSchema>;

/** `GET /v1/device/codes/{codeHash}` (`markiro_proto::CodeCheck`): whether an accepted scan owns the code. */
export const codeCheckSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("free") }),
  z.object({ status: z.literal("taken"), owner: codeOwnerSchema }),
]);
export type CodeCheck = z.infer<typeof codeCheckSchema>;

/**
 * The answer of `POST /v1/device/sscc/blocks` (`markiro_proto::SsccBlock`):
 * the serials `fromSerial`–`toSerial`, both ends included, of one issuer
 * prefix and extension, issued to this station.
 */
export const ssccBlockSchema = z.object({
  id: z.uuid(),
  issuerPrefix: z.string(),
  extension: z.number().int().min(0).max(9),
  fromSerial: z.number().int().nonnegative(),
  toSerial: z.number().int().nonnegative(),
});
export type SsccBlock = z.infer<typeof ssccBlockSchema>;

/** How the host answered a fact (`markiro_proto::FactOutcome`). */
export const FACT_OUTCOMES = ["accepted", "conflict", "rejected"] as const;
export type FactOutcome = (typeof FACT_OUTCOMES)[number];

/**
 * The codes of a `rejected` receipt (`markiro_proto::receipt_codes`,
 * `proto/fixtures/fact-receipt-codes.json`). A receipt carries its code as
 * text: a code a newer host adds does not fail the batch.
 */
export const FACT_RECEIPT_CODES = [
  "invalid_record",
  "payload_mismatch",
  "unknown_shift",
  "not_entered",
  "gtin_mismatch",
  "box_unknown",
  "box_closed",
  "box_already_closed",
  "box_state",
  "sscc_not_issued",
  "sscc_taken",
] as const;

/**
 * The host's answer to one record (`markiro_proto::FactReceipt`): `id` is the
 * record's, or `null` when the host could not read it (the receipt then
 * matches its record by its place in the batch); a `rejected` one names its
 * code; `details` carries the field of an `invalid_record`, the winner of a
 * `conflict` and `alreadyClosed` of a shift's close.
 */
export const factReceiptSchema = z.object({
  id: z.string().nullable(),
  outcome: z.enum(FACT_OUTCOMES),
  code: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type FactReceipt = z.infer<typeof factReceiptSchema>;

/** The answer of `POST /v1/device/facts`: a receipt per record, in the records' order. */
export const factReceiptsSchema = z.object({ receipts: z.array(factReceiptSchema) });

// --- Request bodies (strict) ---
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
export type DeviceShiftCreate = z.infer<typeof deviceShiftCreateSchema>;
```

заменить на:

<!-- prettier-ignore -->
```ts
export type DeviceShiftCreate = z.infer<typeof deviceShiftCreateSchema>;

/**
 * `POST /v1/device/sscc/blocks` (`markiro_proto::SsccBlockRequest`): a block
 * of the shift's issuer prefix and an extension (0, a box). The station keeps
 * the request (`floor_block_requests`) and repeats it whole until it has the
 * block: the same `requestId` answers the same block.
 */
export const ssccBlockRequestSchema = z
  .object({
    requestId: z.uuid(),
    issuerPrefix: z.string(),
    extension: z.number().int().min(0).max(9),
  })
  .strict();
export type SsccBlockRequest = z.infer<typeof ssccBlockRequestSchema>;

/** The verdict of a scan (`markiro_proto::ScanVerdict`). */
export const SCAN_VERDICTS = ["ok", "duplicate", "wrong_gtin", "invalid"] as const;
export type ScanVerdict = (typeof SCAN_VERDICTS)[number];

/** What the domain's `classifyScan` read a scan as (`markiro_proto::ScanRawKind`). */
export const SCAN_RAW_KINDS = ["km", "gtin", "sscc", "unknown"] as const;
export type ScanRawKind = (typeof SCAN_RAW_KINDS)[number];

/**
 * A code of marking as the domain read it (`markiro_proto::ScannedCode`):
 * `codeHash` is `kmHash`, `canonical` the text `canonicalizeKm` kept, its
 * group separators and crypto tail included.
 */
export const scannedCodeSchema = z
  .object({ codeHash: z.string(), gtin14: z.string(), serial: z.string(), canonical: z.string() })
  .strict();
export type ScannedCode = z.infer<typeof scannedCodeSchema>;

/**
 * `data` of a `scan` fact (`markiro_proto::ScanFact`). Every instant of a fact
 * is exactly what `Date.toISOString` writes (`device-instants.json`); the
 * host refuses any other form.
 */
export const scanFactSchema = z
  .object({
    scannedAt: z.string(),
    verdict: z.enum(SCAN_VERDICTS),
    duplicateSource: z.enum(["local", "host"]).nullable(),
    rawKind: z.enum(SCAN_RAW_KINDS),
    rawLength: z.number().int().nonnegative(),
    code: scannedCodeSchema.nullable(),
    boxId: z.uuid().nullable(),
  })
  .strict();
export type ScanFact = z.infer<typeof scanFactSchema>;

/** `data` of a `box_closed` fact (`markiro_proto::BoxClosedFact`). */
export const boxClosedFactSchema = z
  .object({
    boxId: z.uuid(),
    sscc: z.string(),
    blockId: z.uuid(),
    serial: z.number().int().nonnegative(),
    openedAt: z.string(),
    closedAt: z.string(),
    itemCount: z.number().int().positive(),
    membershipDigest: z.string(),
  })
  .strict();
export type BoxClosedFact = z.infer<typeof boxClosedFactSchema>;

/** `data` of a `box_label` fact (`markiro_proto::BoxLabelFact`). */
export const boxLabelFactSchema = z
  .object({ boxId: z.uuid(), outcome: z.enum(["verified", "skipped"]), at: z.string() })
  .strict();
export type BoxLabelFact = z.infer<typeof boxLabelFactSchema>;

/** `data` of a `box_exception` fact (`markiro_proto::BoxExceptionFact`); the fields of each kind are the host's rule. */
export const boxExceptionFactSchema = z
  .object({
    exception: z.enum(["undo", "clear", "reprint", "disassemble"]),
    boxId: z.uuid(),
    codeHash: z.string().nullable(),
    targetScannedAt: z.string().nullable(),
    reasonCode: z.string().nullable(),
    reasonText: z.string().nullable(),
    occurredAt: z.string(),
  })
  .strict();
export type BoxExceptionFact = z.infer<typeof boxExceptionFactSchema>;

/** `data` of a `shift_closed` fact (`markiro_proto::ShiftClosedFact`). */
export const shiftClosedFactSchema = z
  .object({
    plannedQtySnapshot: z.number().int().positive().nullable(),
    actualQty: z.number().int().nonnegative(),
    closedBoxCount: z.number().int().nonnegative(),
    reasonCode: z.string().nullable(),
    closedAt: z.string(),
  })
  .strict();
export type ShiftClosedFact = z.infer<typeof shiftClosedFactSchema>;

/** The envelope of every record: its own id, the shift and the operator signed in, or `null`. */
const factHead = { id: z.uuid(), shiftId: z.uuid(), operatorId: z.uuid().nullable() };

/**
 * One record of the outbox (`markiro_proto::FactRecord`): the envelope and
 * `data` read by `kind`. The outbox keeps it whole as its `payload`, and it is
 * sent as kept.
 */
export const factRecordSchema = z.discriminatedUnion("kind", [
  z.object({ ...factHead, kind: z.literal("scan"), data: scanFactSchema }).strict(),
  z.object({ ...factHead, kind: z.literal("box_closed"), data: boxClosedFactSchema }).strict(),
  z.object({ ...factHead, kind: z.literal("box_label"), data: boxLabelFactSchema }).strict(),
  z
    .object({ ...factHead, kind: z.literal("box_exception"), data: boxExceptionFactSchema })
    .strict(),
  z.object({ ...factHead, kind: z.literal("shift_closed"), data: shiftClosedFactSchema }).strict(),
]);
export type FactRecord = z.infer<typeof factRecordSchema>;
export type FactKind = FactRecord["kind"];

/** `POST /v1/device/facts` (`markiro_proto::FactBatch`): 1–100 records, in the outbox's order. */
export const MAX_FACT_BATCH = 100;
export const factBatchSchema = z
  .object({ records: z.array(factRecordSchema).min(1).max(MAX_FACT_BATCH) })
  .strict();
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/api.test.ts test/floor-facts.test.ts test/protocol.test.ts`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  292 passed (292)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  88 passed (88)`, `Tests  2240 passed (2240)` (на настоящем дереве — больше на тесты, которых на копии нет).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — проверка кода без предела 300 мс. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
        timeoutMs: CODE_CHECK_TIMEOUT_MS,
        schema: codeCheckSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
        schema: codeCheckSchema,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/api.test.ts`
Expected: FAIL — «asks for a block, checks a code within 300 ms and sends facts, with the device key only».

М2 — в списке кодов квитанций нет `sscc_taken`. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
  "sscc_taken",
] as const;
```

заменить на:

<!-- prettier-ignore -->
```ts
] as const;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: FAIL — «know every receipt code of the host».

М3 — пачка допускает 101 запись. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
  .object({ records: z.array(factRecordSchema).min(1).max(MAX_FACT_BATCH) })
```

заменить на:

<!-- prettier-ignore -->
```ts
  .object({ records: z.array(factRecordSchema).min(1).max(MAX_FACT_BATCH + 1) })
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: FAIL — «send 1 to 100 records in a batch».

М4 — пачка допускает ни одной записи. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
  .object({ records: z.array(factRecordSchema).min(1).max(MAX_FACT_BATCH) })
```

заменить на:

<!-- prettier-ignore -->
```ts
  .object({ records: z.array(factRecordSchema).max(MAX_FACT_BATCH) })
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: FAIL — «send 1 to 100 records in a batch».

М5 — данные скана не проверяются по его виду. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
  z.object({ ...factHead, kind: z.literal("scan"), data: scanFactSchema }).strict(),
```

заменить на:

<!-- prettier-ignore -->
```ts
  z.object({ ...factHead, kind: z.literal("scan"), data: z.unknown() }).strict(),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: FAIL — «read a record's data by its kind, and no other».

М6 — строка `outbox` без проверки записи схемой. В `apps/standalone/src/floor/facts.ts` фрагмент

<!-- prettier-ignore -->
```ts
  const checked = factRecordSchema.parse(record);
```

заменить на:

<!-- prettier-ignore -->
```ts
  const checked = record;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-facts.test.ts`
Expected: FAIL — «refuses a record this build cannot form, and writes nothing».

М7 — хеш кода зависит от криптохвоста. В `apps/standalone/src/floor/facts.ts` фрагмент

<!-- prettier-ignore -->
```ts
  return { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial, canonical: km.raw };
```

заменить на:

<!-- prettier-ignore -->
```ts
  return { codeHash: kmHash({ ...km, serial: km.raw }), gtin14: km.gtin14, serial: km.serial, canonical: km.raw };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-facts.test.ts`
Expected: FAIL — «carry a code as the domain read it: the hash without the tail, the canonical text with it».

М8 — запись ровно в предел отвергается. В `apps/standalone/src/floor/facts.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (bytes > MAX_RECORD_BYTES) throw new RecordTooLargeError(bytes);
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (bytes >= MAX_RECORD_BYTES) throw new RecordTooLargeError(bytes);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-facts.test.ts`
Expected: FAIL — «keeps no record larger than a batch of 100 can carry under the host's 2 MiB».

М9 — размер записи считается в символах, а не в байтах. В `apps/standalone/src/floor/facts.ts` фрагмент

<!-- prettier-ignore -->
```ts
  const bytes = new TextEncoder().encode(payload).length;
```

заменить на:

<!-- prettier-ignore -->
```ts
  const bytes = payload.length;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-facts.test.ts`
Expected: FAIL — «keeps no record larger than a batch of 100 can carry under the host's 2 MiB».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/facts.ts apps/standalone/src/host/api.ts apps/standalone/src/host/protocol.ts apps/standalone/test/api.test.ts apps/standalone/test/floor-facts.test.ts apps/standalone/test/protocol.test.ts apps/standalone/test/support/office.tsx`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/facts.ts apps/standalone/src/host/api.ts apps/standalone/src/host/protocol.ts apps/standalone/test/api.test.ts apps/standalone/test/floor-facts.test.ts apps/standalone/test/protocol.test.ts apps/standalone/test/support/office.tsx
git commit -m "feat(standalone): the floor's facts in the webview: records, receipts, the code check and SSCC blocks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Источник сканов — COM-сканеры оболочки рядом с клавиатурой

`createComScanSource` превращает события `standalone://scan` (план 2a4, `HardwareApi.onScan`) в `ScanSource`: кадр — как прислал сканер, с GS и префиксом AIM (их снимает домен); пустой кадр не скан; подписка асинхронна, и источник, остановленный до её ответа, снимает её, как только она ответит; неудачная подписка (вне оболочки — в тестах и не в приложении) не бросает и оставляет клавиатуру; пока поле ввода берёт текст, COM-сканы отбрасываются, как клавиатурные. `mergeScanSources` отдаёт сканы нескольких источников одному слушателю и останавливает их вместе. `App` по умолчанию читает клавиатуру и COM сразу; свойство `hardware` подменяет оболочку в тестах. Решение 25 спецификации выбирало один источник по настройке рабочего места — её даст план 2a7, а без неё станция с COM-сканером не сканировала бы вовсе (раздел «Решения планировщика»).

**Files:**

- Modify: `apps/standalone/src/app/App.tsx`, `apps/standalone/src/floor/scan-source.ts`
- Test: `apps/standalone/test/floor-scan-source.test.ts` (Create), `apps/standalone/test/app.test.tsx` (Modify)

**Interfaces:**

- Consumes: `ScanSource`, `ScanListener`, `createKeyboardWedgeSource` (`src/floor/scan-source.ts`); `createTauriHardware`, `HardwareApi` (план 2a4, `src/hardware/hardware.ts`).
- Produces:
  - `src/floor/scan-source.ts`: `createComScanSource(subscribe: (listener: ScanListener) => Promise<() => void>): ScanSource`, `mergeScanSources(...sources: readonly ScanSource[]): ScanSource`;
  - `src/app/App.tsx`: `AppProps.hardware?: HardwareApi`; источник цеха по умолчанию — `mergeScanSources(createKeyboardWedgeSource(), createComScanSource(hardwareApi.onScan))`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/app.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import type { HostApi } from "../src/host/api.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import type { HardwareApi } from "../src/hardware/hardware.js";
import type { HostApi } from "../src/host/api.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  scanSource?: ScanSource;
  lockdown?: LockdownLifecycle;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  scanSource?: ScanSource;
  hardware?: HardwareApi;
  lockdown?: LockdownLifecycle;
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  });

  it("starts the wait again on a touch of the screen, not only on a key", async () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  });

  it("reads the shell's COM scanners next to the keyboard when given no scan source", async () => {
    let comListener: ScanListener | null = null;
    const hardware: HardwareApi = {
      printBytes: vi.fn<HardwareApi["printBytes"]>(),
      listUsbPrinters: vi.fn<HardwareApi["listUsbPrinters"]>(),
      listSerialPorts: vi.fn<HardwareApi["listSerialPorts"]>(),
      configureScanners: vi.fn<HardwareApi["configureScanners"]>(),
      closeScanners: vi.fn<HardwareApi["closeScanners"]>(),
      watchScanners: vi.fn<HardwareApi["watchScanners"]>(),
      onScan: vi.fn<HardwareApi["onScan"]>(async (listener) => {
        comListener = listener;
        return () => {
          comListener = null;
        };
      }),
      setSystemAwake: vi.fn<HardwareApi["setSystemAwake"]>(),
    };
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: fakeConnection().connection,
      hardware,
    });
    await screen.findByText(PROMPT);
    await waitFor(() => expect(comListener).not.toBeNull());
    act(() => {
      comListener?.("MRK-000742");
    });
    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
  });

  it("starts the wait again on a touch of the screen, not only on a key", async () => {
```

Создать `apps/standalone/test/floor-scan-source.test.ts`:

<!-- prettier-ignore -->
```ts
import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  createComScanSource,
  createKeyboardWedgeSource,
  mergeScanSources,
  type ScanListener,
} from "../src/floor/scan-source.js";

/** The shell's COM scan events as the test drives them; `answer` settles the subscription. */
function comEvents() {
  let listener: ScanListener | null = null;
  const unsubscribe = vi.fn(() => {
    listener = null;
  });
  let settle: { resolve: () => void; reject: (error: unknown) => void } = {
    resolve: () => undefined,
    reject: () => undefined,
  };
  const subscribe = vi.fn(
    (next: ScanListener) =>
      new Promise<() => void>((resolve, reject) => {
        listener = next;
        settle = { resolve: () => resolve(unsubscribe), reject };
      }),
  );
  return {
    subscribe,
    unsubscribe,
    /** The shell answers the subscription. */
    answer: async () => {
      settle.resolve();
      await Promise.resolve();
    },
    /** The shell has no event channel: nothing is subscribed. */
    fail: async () => {
      listener = null;
      settle.reject(new Error("no event channel"));
      await Promise.resolve();
    },
    /** A frame of a COM scanner, as the shell emits it. */
    emit: (raw: string) => listener?.(raw),
  };
}

/** A product's code with the AIM prefix, the group separator and the crypto tail. */
const KM = "]d2010460068200001321MRK-1\u001d93dGVz";

describe("the COM scanners as a scan source", () => {
  it("hands over each frame exactly as the scanner sent it, and skips empty ones", async () => {
    const events = comEvents();
    const scans: string[] = [];
    createComScanSource(events.subscribe).start((raw) => scans.push(raw));
    await events.answer();
    events.emit(KM);
    events.emit("");
    events.emit("]C100046006820000015000");
    expect(scans).toEqual([KM, "]C100046006820000015000"]);
  });

  it("drops the subscription that answers after the source stopped, and delivers nothing", async () => {
    const events = comEvents();
    const scans: string[] = [];
    const stop = createComScanSource(events.subscribe).start((raw) => scans.push(raw));
    stop();
    events.emit(KM);
    await events.answer();
    expect(events.unsubscribe).toHaveBeenCalledTimes(1);
    expect(scans).toEqual([]);
  });

  it("stops listening when stopped after the subscription answered", async () => {
    const events = comEvents();
    const scans: string[] = [];
    const stop = createComScanSource(events.subscribe).start((raw) => scans.push(raw));
    await events.answer();
    stop();
    events.emit(KM);
    expect(events.unsubscribe).toHaveBeenCalledTimes(1);
    expect(scans).toEqual([]);
  });

  it("stays silent, and throws nothing, when the shell has no event channel", async () => {
    const events = comEvents();
    const scans: string[] = [];
    const stop = createComScanSource(events.subscribe).start((raw) => scans.push(raw));
    await events.fail();
    events.emit(KM);
    expect(scans).toEqual([]);
    expect(() => stop()).not.toThrow();
  });

  it("drops scans while a text field takes typing, and delivers again after it", async () => {
    const events = comEvents();
    const scans: string[] = [];
    const source = createComScanSource(events.subscribe);
    source.start((raw) => scans.push(raw));
    await events.answer();
    source.setManualTextEntryActive(true);
    events.emit("MRK-000742");
    source.setManualTextEntryActive(false);
    events.emit(KM);
    expect(scans).toEqual([KM]);
  });
});

describe("the keyboard and the COM scanners together", () => {
  it("reach one listener, and stop together", async () => {
    const events = comEvents();
    const scans: string[] = [];
    const stop = mergeScanSources(
      createKeyboardWedgeSource(window),
      createComScanSource(events.subscribe),
    ).start((raw) => scans.push(raw));
    await events.answer();
    for (const key of "MRK-000742") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });
    events.emit(KM);
    stop();
    for (const key of "0042") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });
    events.emit(KM);
    expect(scans).toEqual(["MRK-000742", KM]);
    expect(events.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("pass a text field's typing on to both", async () => {
    const events = comEvents();
    const scans: string[] = [];
    const source = mergeScanSources(
      createKeyboardWedgeSource(window),
      createComScanSource(events.subscribe),
    );
    source.start((raw) => scans.push(raw));
    await events.answer();
    source.setManualTextEntryActive(true);
    for (const key of "Анна") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });
    events.emit(KM);
    source.setManualTextEntryActive(false);
    for (const key of "12") fireEvent.keyDown(window, { key });
    source.clearPendingInput();
    for (const key of "34") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(scans).toEqual(["34"]);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/floor-scan-source.test.ts`
Expected: FAIL — 8 тестов: 7 в `floor-scan-source.test.ts` (`createComScanSource` и `mergeScanSources` ещё не экспортированы) и `reads the shell's COM scanners next to the keyboard when given no scan source` в `app.test.tsx`.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/app/App.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { OperatorSignIn } from "../floor/OperatorSignIn.js";
import { createKeyboardWedgeSource, type ScanSource } from "../floor/scan-source.js";
import type { FloorOperator } from "../floor/sign-in.js";

import { createHostApi, type HostApi } from "../host/api.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { OperatorSignIn } from "../floor/OperatorSignIn.js";
import {
  createComScanSource,
  createKeyboardWedgeSource,
  mergeScanSources,
  type ScanSource,
} from "../floor/scan-source.js";
import type { FloorOperator } from "../floor/sign-in.js";
import { createTauriHardware, type HardwareApi } from "../hardware/hardware.js";

import { createHostApi, type HostApi } from "../host/api.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  address?: string;
  /** Where the floor's badge scans come from; the keyboard wedge on this window by default. */
  scanSource?: ScanSource;
  /** How long a signed-in operator may leave the station untouched; tests shorten it. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
  address?: string;
  /**
   * Where the floor's scans come from; by default the keyboard wedge on this
   * window and the shell's COM scanners, both at once.
   */
  scanSource?: ScanSource;
  /** The shell's printers, COM scanners and power request; tests give their own. */
  hardware?: HardwareApi;
  /** How long a signed-in operator may leave the station untouched; tests shorten it. */
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  scanSource,
  idleTimeoutMs,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  scanSource,
  hardware,
  idleTimeoutMs,
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  const localDb = useMemo(() => local ?? createTauriLocalExecutor(), [local]);
  const scanner = useMemo(() => scanSource ?? createKeyboardWedgeSource(), [scanSource]);
  const kiosk = useMemo(
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const localDb = useMemo(() => local ?? createTauriLocalExecutor(), [local]);
  const hardwareApi = useMemo(() => hardware ?? createTauriHardware(), [hardware]);
  const scanner = useMemo(
    () =>
      scanSource ??
      mergeScanSources(createKeyboardWedgeSource(), createComScanSource(hardwareApi.onScan)),
    [scanSource, hardwareApi],
  );
  const kiosk = useMemo(
```

Правка `apps/standalone/src/floor/scan-source.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
/**
 * Where scans come from (stage 1 spec §5.6): a keyboard-wedge scanner today,
 * the COM scanners of plan 2a later. The sign-in screen does not care which.
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
/**
 * Where scans come from (stage 1 spec §5.6): a keyboard-wedge scanner and the
 * COM scanners of the shell (plan 2a4). The sign-in screen, a new shift and
 * the work screen do not care which.
 */
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  };
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  };
}

/**
 * The COM scanners the shell reads (`standalone://scan`, plan 2a4) as a scan
 * source: each frame as the scanner sent it, the group separator and the AIM
 * prefixes kept (the domain removes them). The subscription is the shell's
 * and asynchronous, so a source stopped before it answered drops it as soon
 * as it does. A failed subscription (no shell event channel, as outside the
 * application) leaves this source silent and the keyboard still scanning:
 * which COM ports read, and whether they are connected, the workstation's
 * setup shows (plan 2a7). While a text field takes typing, COM scans are
 * dropped as the keyboard's are.
 */
export function createComScanSource(
  subscribe: (listener: ScanListener) => Promise<() => void>,
): ScanSource {
  let manualTextEntry = false;
  return {
    start(listener) {
      let stopped = false;
      let unsubscribe: (() => void) | null = null;
      subscribe((raw) => {
        if (stopped || manualTextEntry || raw.length === 0) return;
        listener(raw);
      }).then(
        (stop) => {
          if (stopped) stop();
          else unsubscribe = stop;
        },
        () => undefined,
      );
      return () => {
        stopped = true;
        unsubscribe?.();
        unsubscribe = null;
      };
    },
    clearPendingInput() {
      // A COM frame arrives whole: nothing is pending between two scans.
    },
    setManualTextEntryActive(active) {
      manualTextEntry = active;
    },
  };
}

/**
 * Several sources as one: every scan of each reaches the one listener, and
 * stopping stops them all. The floor reads the keyboard and the COM scanners
 * at once (stage 2a spec, decision 25, chose one by the setup; plan 2a6 reads
 * both, so a station needs no setup to scan and a stray wedge scanner still
 * works next to a COM one).
 */
export function mergeScanSources(...sources: readonly ScanSource[]): ScanSource {
  return {
    start(listener) {
      const stops = sources.map((source) => source.start(listener));
      return () => {
        for (const stop of stops) stop();
      };
    },
    clearPendingInput() {
      for (const source of sources) source.clearPendingInput();
    },
    setManualTextEntryActive(active) {
      for (const source of sources) source.setManualTextEntryActive(active);
    },
  };
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/floor-scan-source.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  105 passed (105)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  89 passed (89)`, `Tests  2248 passed (2248)` (на настоящем дереве — больше на тесты, которых на копии нет).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — подписка, ответившая после остановки, остаётся. В `apps/standalone/src/floor/scan-source.ts` фрагмент

<!-- prettier-ignore -->
```ts
          if (stopped) stop();
          else unsubscribe = stop;
```

заменить на:

<!-- prettier-ignore -->
```ts
          unsubscribe = stop;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-source.test.ts`
Expected: FAIL — «drops the subscription that answers after the source stopped, and delivers nothing».

М2 — COM-сканы принимаются, пока поле берёт ввод. В `apps/standalone/src/floor/scan-source.ts` фрагмент

<!-- prettier-ignore -->
```ts
        if (stopped || manualTextEntry || raw.length === 0) return;
```

заменить на:

<!-- prettier-ignore -->
```ts
        if (stopped || raw.length === 0) return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-source.test.ts`
Expected: FAIL — «drops scans while a text field takes typing, and delivers again after it».

М3 — пустой кадр COM передаётся как скан. В `apps/standalone/src/floor/scan-source.ts` фрагмент

<!-- prettier-ignore -->
```ts
        if (stopped || manualTextEntry || raw.length === 0) return;
```

заменить на:

<!-- prettier-ignore -->
```ts
        if (stopped || manualTextEntry) return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-source.test.ts`
Expected: FAIL — «hands over each frame exactly as the scanner sent it, and skips empty ones».

М4 — объединённый источник останавливает только первый. В `apps/standalone/src/floor/scan-source.ts` фрагмент

<!-- prettier-ignore -->
```ts
        for (const stop of stops) stop();
```

заменить на:

<!-- prettier-ignore -->
```ts
        stops[0]?.();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-source.test.ts`
Expected: FAIL — «reach one listener, and stop together».

М5 — ввод в поле передаётся только первому источнику. В `apps/standalone/src/floor/scan-source.ts` фрагмент

<!-- prettier-ignore -->
```ts
      for (const source of sources) source.setManualTextEntryActive(active);
```

заменить на:

<!-- prettier-ignore -->
```ts
      sources[0]?.setManualTextEntryActive(active);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-source.test.ts`
Expected: FAIL — «pass a text field's typing on to both».

М6 — отказ подписки не перехвачен. В `apps/standalone/src/floor/scan-source.ts` фрагмент

<!-- prettier-ignore -->
```ts
          else unsubscribe = stop;
        },
        () => undefined,
      );
```

заменить на:

<!-- prettier-ignore -->
```ts
          else unsubscribe = stop;
        },
      );
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-source.test.ts`
Expected: FAIL — прогон с необработанной ошибкой (`Unhandled Rejection`), тесты при этом зелёные.

М7 — приложение по умолчанию читает только клавиатуру. В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      mergeScanSources(createKeyboardWedgeSource(), createComScanSource(hardwareApi.onScan)),
```

заменить на:

<!-- prettier-ignore -->
```tsx
      mergeScanSources(createKeyboardWedgeSource()),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx`
Expected: FAIL — «reads the shell's COM scanners next to the keyboard when given no scan source».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/app/App.tsx apps/standalone/src/floor/scan-source.ts apps/standalone/test/app.test.tsx apps/standalone/test/floor-scan-source.test.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/app.test.tsx test/floor-scan-source.test.ts`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/app.test.tsx test/floor-scan-source.test.ts`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/app/App.tsx apps/standalone/src/floor/scan-source.ts apps/standalone/test/app.test.tsx apps/standalone/test/floor-scan-source.test.ts
git commit -m "feat(standalone): the floor reads the COM scanners next to the keyboard" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Конвейер скана — чтение доменом, вердикты, проверка на хосте, одна транзакция; очередь по одному

`processScan` (§5.7.3): `readScan` — `classifyScan` домена; GTIN, SSCC и прочее — `invalid` с длиной и классом, без текста (решение 15); серия длиннее предела хоста — `unknown`. Чужой GTIN — `wrong_gtin`. Код, который держит это подключение (`floor_codes`), — локальный дубль с временем первого скана, без вопроса хосту. Пока связь `online` — вопрос хосту (`checkCode`, 300 мс): `taken` скана другого устройства — дубль хоста с номером смены; нет ответа, сбой (отказ ключа — в оболочку), `free` или скан этой же станции — скан проходит. Принятый код ложится в открытый короб смены (он открывается с ним) одной `local_transaction`: короб (вставка или рост счётчика с условием «открыт»), `floor_codes` (ключ подключения и хеша: код — в одном коробе, второе принятие падает целиком `changes_mismatch`), `floor_scans`, запись `outbox`. Непринятые сканы — строка журнала и запись очереди той же транзакцией. Отказ записи — исключение: скан не принят. `createWorkQueue` выполняет работу экрана строго по одному (порт облачного `scan-queue.ts`). `readOpenBox` и `readWorkTotals` читают то, что показывает рабочий экран. Общий стенд тестов цеха — `test/support/floor-work.ts`: смена из фикстуры, сохранённая как при входе, коды с префиксом AIM, GS и хвостом, шагающие часы, исполнитель, удерживающий запись (`holdingWrites`), и падающий (`failingWrites`).

**Files:**

- Create: `apps/standalone/src/floor/work/scan-pipeline.ts`, `apps/standalone/src/floor/work/work-queue.ts`, `apps/standalone/src/floor/work/work-reads.ts`
- Test: `apps/standalone/test/floor-scan-pipeline.test.ts` (Create), `apps/standalone/test/support/floor-work.ts` (Create)

**Interfaces:**

- Consumes: `classifyScan`, `ParsedKm` (`@markiro/domain`); `outboxStatement`, `scanRecord`, `scannedCode` (задача 1); `CodeCheck`, `CodeOwner`, `ScanFact`, `ScanRawKind` (задача 1); `WorkShift` (план 2a5, `src/floor/shifts/shift-copies.ts`); таблицы `floor_boxes`, `floor_codes`, `floor_scans`, `outbox` (миграция `0006`).
- Produces:
  - `src/floor/work/scan-pipeline.ts`: `HOST_MAX_SERIAL_BYTES = 64`, `type ScanReading`, `readScan(raw): ScanReading`, `interface ScanContext { local; pairing; shift; operatorId; online: () => boolean; checkCode; onHostError; now: () => Date; newId: () => string }`, `type ScanOutcome` (`accepted { boxId, itemCount }`, `duplicate` `local { firstScannedAt }` / `host { firstScannedAt, shiftNumber }`, `wrong_gtin { gtin14 }`, `invalid { rawKind }`), `processScan(context, raw): Promise<ScanOutcome>`;
  - `src/floor/work/work-queue.ts`: `interface WorkQueue { run: <T>(job: () => Promise<T>) => Promise<T>; pending: () => number }`, `createWorkQueue()`;
  - `src/floor/work/work-reads.ts`: `interface OpenBox { id; openedAt; itemCount }`, `readOpenBox(local, pairing, shiftId)`, `interface WorkTotals { openBox; accepted; closedBoxes; lastSscc }`, `readWorkTotals(local, pairing, shiftId)`;
  - `test/support/floor-work.ts`: `PAIRING`, `ENTERED`, `SHIFT_ID`, `GTIN`, `PREFIX`, `OTHER_GTIN`, `OPERATOR_ID`, `km(serial, options?)`, `enteredShift(local, shift?)`, `steppingClock()`, `countingIds()`, `scanContext(local, shift, overrides?)`, `rows(db, sql, ...params)`, `holdingWrites(local)`, `failingWrites(local)`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-scan-pipeline.test.ts`:

<!-- prettier-ignore -->
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSscc, canonicalizeKm, kmHash } from "@markiro/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { scanRecord } from "../src/floor/facts.js";
import { HOST_MAX_SERIAL_BYTES, processScan, readScan } from "../src/floor/work/scan-pipeline.js";
import { createWorkQueue } from "../src/floor/work/work-queue.js";
import { HostError } from "../src/host/client.js";
import type { CodeCheck } from "../src/host/protocol.js";
import { LocalDbError } from "../src/local/executor.js";
import {
  failingWrites,
  GTIN,
  holdingWrites,
  km,
  OPERATOR_ID,
  OTHER_GTIN,
  PAIRING,
  PREFIX,
  rows,
  scanContext,
  SHIFT_ID,
  enteredShift,
} from "./support/floor-work.js";
import { openLocalDb, openLocalDbFile } from "./support/local-db.js";

const OTHER_DEVICE = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const TAKEN: CodeCheck = {
  status: "taken",
  owner: {
    shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    shiftNumber: "OCT26-003",
    deviceId: OTHER_DEVICE,
    scannedAt: "2026-10-08T05:58:41.090Z",
    sameDevice: false,
  },
};

async function station() {
  const { db, executor } = openLocalDb();
  const shift = await enteredShift(executor);
  return { db, local: executor, shift };
}

function codeHashOf(raw: string): string {
  return kmHash(canonicalizeKm(raw));
}

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the reading of a raw scan", () => {
  const SSCC = buildSscc(0, PREFIX, 1500);

  it("reads a product's code with its AIM prefix, group separators and crypto tail", () => {
    const reading = readScan(km("5Yq'Ct;"));
    expect(reading).toMatchObject({
      kind: "km",
      km: { gtin14: GTIN, serial: "5Yq'Ct;", raw: `01${GTIN}215Yq'Ct;\u001d93dGVz` },
    });
    // Spaces and tabs around a keyboard scan are not the code's.
    expect(readScan(` ${km("5Yq'Ct;")}\t`)).toEqual(reading);
  });

  it("reads a GTIN, an SSCC and anything else as no code of marking", () => {
    expect(readScan(GTIN)).toEqual({ kind: "gtin" });
    expect(readScan(GTIN.slice(1))).toEqual({ kind: "gtin" });
    expect(readScan(`]C100${SSCC}`)).toEqual({ kind: "sscc" });
    expect(readScan(`(00)${SSCC}`)).toEqual({ kind: "sscc" });
    expect(readScan("MRK-000742")).toEqual({ kind: "unknown" });
    // A group separator with nothing after it, a character the COM decoding
    // replaced, and a serial longer than the host keeps.
    expect(readScan(`01${GTIN}215Yq'Ct;\u001d`)).toEqual({ kind: "unknown" });
    expect(readScan(`01${GTIN}215Yq'Ct�\u001d93dGVz`)).toEqual({ kind: "unknown" });
    expect(readScan(km("x".repeat(HOST_MAX_SERIAL_BYTES + 1)))).toEqual({ kind: "unknown" });
    expect(readScan(km("x".repeat(HOST_MAX_SERIAL_BYTES)))).toMatchObject({ kind: "km" });
    // The limit is in bytes: 32 Cyrillic letters are 64 bytes, 33 are 66.
    expect(readScan(km("ж".repeat(32)))).toMatchObject({ kind: "km" });
    expect(readScan(km("ж".repeat(33)))).toEqual({ kind: "unknown" });
  });
});

describe("a scan of the work screen", () => {
  it("accepts a code into a new box, with its journal row and outbox record in one write", async () => {
    const { db, local, shift } = await station();
    const raw = km("5Yq'Ct;");
    const context = scanContext(local, shift);
    const scanId = "00000000-0000-4000-8000-000000000001";
    const boxId = "00000000-0000-4000-8000-000000000002";
    await expect(processScan(context, raw)).resolves.toEqual({
      kind: "accepted",
      boxId,
      itemCount: 1,
    });
    const code = {
      codeHash: codeHashOf(raw),
      gtin14: GTIN,
      serial: "5Yq'Ct;",
      canonical: `01${GTIN}215Yq'Ct;\u001d93dGVz`,
    };
    expect(
      rows(db, "SELECT id, shift_id, opened_at, item_count, closed_at FROM floor_boxes"),
    ).toEqual([
      {
        id: boxId,
        shift_id: SHIFT_ID,
        opened_at: "2026-10-08T06:15:00.000Z",
        item_count: 1,
        closed_at: null,
      },
    ]);
    expect(
      rows(db, "SELECT code_hash, shift_id, box_id, scan_id, scanned_at FROM floor_codes"),
    ).toEqual([
      {
        code_hash: code.codeHash,
        shift_id: SHIFT_ID,
        box_id: boxId,
        scan_id: scanId,
        scanned_at: "2026-10-08T06:15:00.000Z",
      },
    ]);
    expect(
      rows(
        db,
        "SELECT id, box_id, verdict, duplicate_source, raw_kind, raw_length, code_hash, " +
          "canonical, operator_id, conflict FROM floor_scans",
      ),
    ).toEqual([
      {
        id: scanId,
        box_id: boxId,
        verdict: "ok",
        duplicate_source: null,
        raw_kind: "km",
        raw_length: raw.length,
        code_hash: code.codeHash,
        canonical: code.canonical,
        operator_id: OPERATOR_ID,
        conflict: 0,
      },
    ]);
    const [outbox] = rows(db, "SELECT id, kind, shift_id, payload, acked_at FROM outbox");
    expect(outbox).toMatchObject({ id: scanId, kind: "scan", shift_id: SHIFT_ID, acked_at: null });
    expect(JSON.parse(String(outbox?.["payload"]))).toEqual(
      scanRecord(
        { id: scanId, shiftId: SHIFT_ID, operatorId: OPERATOR_ID },
        {
          scannedAt: "2026-10-08T06:15:00.000Z",
          verdict: "ok",
          duplicateSource: null,
          rawKind: "km",
          rawLength: raw.length,
          code,
          boxId,
        },
      ),
    );
  });

  it("puts the next code into the same open box", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    const first = await processScan(context, km("A1"));
    await expect(processScan(context, km("A2"))).resolves.toEqual({
      kind: "accepted",
      boxId: first.kind === "accepted" ? first.boxId : "",
      itemCount: 2,
    });
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 2 }]);
  });

  it("journals what is no code of marking by its length and kind only, never its text", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await expect(processScan(context, "MRK-000742")).resolves.toEqual({
      kind: "invalid",
      rawKind: "unknown",
    });
    await expect(processScan(context, GTIN)).resolves.toEqual({ kind: "invalid", rawKind: "gtin" });
    expect(
      rows(
        db,
        "SELECT verdict, raw_kind, raw_length, code_hash, canonical, box_id FROM floor_scans",
      ),
    ).toEqual([
      {
        verdict: "invalid",
        raw_kind: "unknown",
        raw_length: 10,
        code_hash: null,
        canonical: null,
        box_id: null,
      },
      {
        verdict: "invalid",
        raw_kind: "gtin",
        raw_length: 14,
        code_hash: null,
        canonical: null,
        box_id: null,
      },
    ]);
    const payloads = rows(db, "SELECT payload FROM outbox").map((row) => String(row["payload"]));
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) expect(payload).not.toContain("MRK");
    expect(rows(db, "SELECT count(*) AS n FROM floor_boxes")).toEqual([{ n: 0 }]);
  });

  it("refuses a code of another product into no box", async () => {
    const { db, local, shift } = await station();
    await expect(
      processScan(scanContext(local, shift), km("B1", { gtin: OTHER_GTIN })),
    ).resolves.toEqual({
      kind: "wrong_gtin",
      gtin14: OTHER_GTIN,
    });
    expect(rows(db, "SELECT verdict, box_id, gtin14 FROM floor_scans")).toEqual([
      { verdict: "wrong_gtin", box_id: null, gtin14: OTHER_GTIN },
    ]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 0 }]);
  });

  it("finds a code it holds, under another AIM prefix or tail too, without asking the host", async () => {
    const { db, local, shift } = await station();
    const checkCode = vi.fn(async (): Promise<CodeCheck> => ({ status: "free" }));
    const context = scanContext(local, shift, { online: () => true, checkCode });
    await processScan(context, km("C1"));
    await expect(processScan(context, km("C1", { aim: false, tail: "xxxx" }))).resolves.toEqual({
      kind: "duplicate",
      source: "local",
      firstScannedAt: "2026-10-08T06:15:00.000Z",
    });
    expect(checkCode).toHaveBeenCalledTimes(1);
    expect(
      rows(db, "SELECT verdict, duplicate_source, box_id FROM floor_scans ORDER BY scanned_at"),
    ).toEqual([
      { verdict: "ok", duplicate_source: null, box_id: expect.any(String) },
      { verdict: "duplicate", duplicate_source: "local", box_id: null },
    ]);
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 1 }]);
  });

  it("asks the host while online, and takes a code another device's scan owns as its duplicate", async () => {
    const { db, local, shift } = await station();
    const checkCode = vi.fn(async (): Promise<CodeCheck> => TAKEN);
    const raw = km("D1");
    await expect(
      processScan(scanContext(local, shift, { online: () => true, checkCode }), raw),
    ).resolves.toEqual({
      kind: "duplicate",
      source: "host",
      firstScannedAt: "2026-10-08T05:58:41.090Z",
      shiftNumber: "OCT26-003",
    });
    expect(checkCode).toHaveBeenCalledWith(codeHashOf(raw));
    expect(rows(db, "SELECT verdict, duplicate_source FROM floor_scans")).toEqual([
      { verdict: "duplicate", duplicate_source: "host" },
    ]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 0 }]);
  });

  it("accepts without the host when offline, when the check fails or times out, and over its own scan", async () => {
    const { db, local, shift } = await station();
    const timeout = new HostError({ kind: "transport", code: "timeout", message: "300 ms" });
    const offline = vi.fn(async (): Promise<CodeCheck> => TAKEN);
    const onHostError = vi.fn();
    await processScan(scanContext(local, shift, { checkCode: offline }), km("E1"));
    expect(offline).not.toHaveBeenCalled();
    const failing = scanContext(local, shift, {
      online: () => true,
      checkCode: async () => {
        throw timeout;
      },
      onHostError,
      newId: () => crypto.randomUUID(),
    });
    await expect(processScan(failing, km("E2"))).resolves.toMatchObject({
      kind: "accepted",
      itemCount: 2,
    });
    expect(onHostError).toHaveBeenCalledWith(timeout);
    const own = scanContext(local, shift, {
      online: () => true,
      checkCode: async () => ({ ...TAKEN, owner: { ...TAKEN.owner, sameDevice: true } }),
      newId: () => crypto.randomUUID(),
    });
    await expect(processScan(own, km("E3"))).resolves.toMatchObject({
      kind: "accepted",
      itemCount: 3,
    });
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 3 }]);
  });

  it("holds a code in one box at most: a second accept the check missed writes nothing", async () => {
    const { db, local, shift } = await station();
    const held = holdingWrites(local);
    const context = scanContext(held.executor, shift, { newId: () => crypto.randomUUID() });
    await processScan(context, km("F0"));
    // The first scan of F1 holds its write; the second, which the queue would
    // have kept behind it, reads meanwhile, finds the code free and writes.
    held.holdNext();
    const first = processScan(context, km("F1"));
    await held.reached();
    await expect(processScan(context, km("F1"))).resolves.toMatchObject({
      kind: "accepted",
      itemCount: 2,
    });
    held.release();
    await expect(first).rejects.toMatchObject({ code: "changes_mismatch" });
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 2 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 2 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 2 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 2 }]);
  });

  it("never puts a code into a box that closed while the scan was on its way", async () => {
    const { db, local, shift } = await station();
    const held = holdingWrites(local);
    const context = scanContext(held.executor, shift, { newId: () => crypto.randomUUID() });
    await processScan(context, km("K0"));
    held.holdNext();
    const late = processScan(context, km("K1"));
    await held.reached();
    db.prepare(
      "UPDATE floor_boxes SET closed_at = '2026-10-08T06:20:00.000Z', sscc = ?, " +
        "block_id = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a', serial = 1500",
    ).run(buildSscc(0, PREFIX, 1500));
    held.release();
    await expect(late).rejects.toMatchObject({ code: "changes_mismatch" });
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 1 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 1 }]);
  });

  it("writes the journal row, the code, the box and the outbox record together or not at all", async () => {
    const { db, local, shift } = await station();
    // The outbox already has a record with the id the scan gets: its insert
    // fails, and so must the rest of the scan.
    const taken = "00000000-0000-4000-8000-000000000001";
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
        "VALUES (?, ?, ?, 'scan', ?, '{}', '2026-10-08T06:00:00.000Z')",
    ).run(taken, PAIRING.hostId, PAIRING.deviceId, SHIFT_ID);
    await expect(processScan(scanContext(local, shift), km("G1"))).rejects.toBeInstanceOf(
      LocalDbError,
    );
    expect(rows(db, "SELECT count(*) AS n FROM floor_boxes")).toEqual([{ n: 0 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 0 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 0 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 1 }]);
  });

  it("rejects when this computer cannot write, and takes nothing", async () => {
    const { db, local, shift } = await station();
    await expect(
      processScan(scanContext(failingWrites(local), shift), km("H1")),
    ).rejects.toMatchObject({
      code: "statement_failed",
    });
    expect(rows(db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 0 }]);
  });

  it("keeps what it took across a restart: the same box, and the code still its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markiro-floor-"));
    temporary.push(dir);
    const path = join(dir, "station.db");
    const before = openLocalDbFile(path);
    const shift = await enteredShift(before.executor);
    const first = await processScan(scanContext(before.executor, shift), km("J1"));
    before.db.close();
    const after = openLocalDbFile(path);
    const context = scanContext(after.executor, shift, { newId: () => crypto.randomUUID() });
    await expect(processScan(context, km("J1"))).resolves.toMatchObject({
      kind: "duplicate",
      source: "local",
    });
    await expect(processScan(context, km("J2"))).resolves.toEqual({
      kind: "accepted",
      boxId: first.kind === "accepted" ? first.boxId : "",
      itemCount: 2,
    });
    expect(rows(after.db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")).toEqual([
      { n: 3 },
    ]);
    after.db.close();
  });
});

describe("the work queue", () => {
  it("runs one job at a time, in order, and goes on after a failed one", async () => {
    const queue = createWorkQueue();
    const log: string[] = [];
    let release: () => void = () => undefined;
    const first = queue.run(
      () =>
        new Promise<string>((resolve) => {
          log.push("first started");
          release = () => resolve("first");
        }),
    );
    const failed = queue.run(async () => {
      log.push("second started");
      throw new Error("disk");
    });
    const third = queue.run(async () => {
      log.push("third started");
      return "third";
    });
    await Promise.resolve();
    expect(log).toEqual(["first started"]);
    expect(queue.pending()).toBe(3);
    release();
    await expect(first).resolves.toBe("first");
    await expect(failed).rejects.toThrow("disk");
    await expect(third).resolves.toBe("third");
    expect(log).toEqual(["first started", "second started", "third started"]);
    expect(queue.pending()).toBe(0);
  });
});
```

Создать `apps/standalone/test/support/floor-work.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import type { DatabaseSync } from "node:sqlite";

import { vi } from "vitest";

import {
  keepEnteredShift,
  readStoredWork,
  type WorkShift,
} from "../../src/floor/shifts/shift-copies.js";
import type { ScanContext } from "../../src/floor/work/scan-pipeline.js";
import { enteredShiftSchema, type CodeCheck, type EnteredShift } from "../../src/host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../src/local/executor.js";
import { DEVICE_ID, HOST_ID } from "./fixtures.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const supportModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../proto/fixtures/${name}`, supportModuleUrl), "utf8"),
  );
}

export const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };

/** The active shift of milk this station entered (`device-shift-entered.json`): 12 to a box, 1 200 planned. */
export const ENTERED: EnteredShift = enteredShiftSchema.parse(fixture("device-shift-entered.json"));
export const SHIFT_ID = ENTERED.id;
/** The shift's GTIN and its issuer prefix. */
export const GTIN = "04600682000013";
export const PREFIX = "460068200";
/** A GTIN-14 of another product. */
export const OTHER_GTIN = "04607004650017";
/** Anna, the operator of the session. */
export const OPERATOR_ID = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";

/**
 * A product's code as a scanner hands it over: the AIM prefix `]d2`, AI 01
 * with the GTIN, AI 21 with the serial, the group separator and the crypto
 * tail (AI 93).
 */
export function km(serial: string, options: { gtin?: string; tail?: string; aim?: boolean } = {}) {
  const { gtin = GTIN, tail = "dGVz", aim = true } = options;
  return `${aim ? "]d2" : ""}01${gtin}21${serial}\u001d93${tail}`;
}

/** The shift entered and stored, read back as the work screen gets it. */
export async function enteredShift(
  local: LocalExecutor,
  shift: EnteredShift = ENTERED,
): Promise<WorkShift> {
  await keepEnteredShift(local, PAIRING, shift, "2026-10-08T06:02:00.000Z", 1_790_000_000_000);
  const stored = await readStoredWork(local, PAIRING, shift.id);
  if (stored.kind !== "ready") throw new Error(`the entered shift reads as ${stored.kind}`);
  return stored.shift;
}

/** A clock that moves on by one second per reading, from 06:15:00.000Z. */
export function steppingClock(start = Date.parse("2026-10-08T06:15:00.000Z")) {
  let next = start;
  return () => {
    const now = new Date(next);
    next += 1_000;
    return now;
  };
}

/** Ids `…0001`, `…0002`, … in order of asking. */
export function countingIds() {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}

/** The pipeline's context over `local`: offline, no host, a stepping clock and counting ids. */
export function scanContext(
  local: LocalExecutor,
  shift: WorkShift,
  overrides: Partial<ScanContext> = {},
): ScanContext {
  return {
    local,
    pairing: PAIRING,
    shift,
    operatorId: OPERATOR_ID,
    online: () => false,
    checkCode: vi.fn<(codeHash: string) => Promise<CodeCheck>>(async () => ({ status: "free" })),
    onHostError: vi.fn<(error: unknown) => void>(),
    now: steppingClock(),
    newId: countingIds(),
    ...overrides,
  };
}

/** Every row of `sql`, as node:sqlite reads it. */
export function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

/**
 * An executor whose next transaction waits for `release()`: the test holds
 * the write while another piece of work reads, so the race the queue rules
 * out is played deterministically.
 */
export function holdingWrites(local: LocalExecutor) {
  let hold: Promise<void> | null = null;
  let release: () => void = () => undefined;
  let waiting: () => void = () => undefined;
  let reached = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const executor: LocalExecutor = {
    query: (sql, params, row) => local.query(sql, params, row),
    transaction: async (statements: readonly LocalStatement[]) => {
      const held = hold;
      if (held !== null) {
        hold = null;
        waiting();
        await held;
      }
      return local.transaction(statements);
    },
  };
  return {
    executor,
    /** The next transaction waits until `release()`. */
    holdNext: () => {
      reached = new Promise<void>((resolve) => {
        waiting = resolve;
      });
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    /** Resolves once the held transaction is waiting. */
    reached: () => reached,
    release: () => release(),
  };
}

/** An executor whose every transaction fails as a full disk does. */
export function failingWrites(local: LocalExecutor): LocalExecutor {
  return {
    query: (sql, params, row) => local.query(sql, params, row),
    transaction: async () => {
      throw new LocalDbError("statement_failed", "database or disk is full");
    },
  };
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-pipeline.test.ts`
Expected: FAIL — `test/floor-scan-pipeline.test.ts` не загружается: `Failed to resolve import "../src/floor/work/scan-pipeline.js"`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/floor/work/scan-pipeline.ts`:

<!-- prettier-ignore -->
```ts
import { classifyScan, type ParsedKm } from "@markiro/domain";
import { z } from "zod";

import type { CodeCheck, CodeOwner, ScanFact, ScanRawKind } from "../../host/protocol.js";
import type { LocalExecutor, LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { outboxStatement, scanRecord, scannedCode, type RecordHead } from "../facts.js";
import type { WorkShift } from "../shifts/shift-copies.js";
import { readOpenBox } from "./work-reads.js";

/**
 * The longest serial the host keeps, in bytes of UTF-8 (`MAX_SERIAL_BYTES`,
 * `host/src/facts/scan.rs`). A GS1 serial has 20 characters at most, so a
 * longer one is no code of marking for the host: the station reads such a
 * scan as unknown rather than keep a code the host would refuse.
 */
export const HOST_MAX_SERIAL_BYTES = 64;

/** What the scan looked like: a code of marking the domain read, or what else it was. */
export type ScanReading = { kind: "km"; km: ParsedKm } | { kind: Exclude<ScanRawKind, "km"> };

/**
 * The one reading of a scan (stage 2a spec §5.7.3, step 1): the domain's
 * `classifyScan`, which strips the AIM prefixes and keeps the group
 * separators; an SSCC is no code of marking on the work screen (plan 2a7
 * reads a label's SSCC before the pipeline), nor a GTIN or anything else.
 */
export function readScan(raw: string): ScanReading {
  const scan = classifyScan(raw);
  if (scan.kind !== "km") return { kind: scan.kind };
  if (new TextEncoder().encode(scan.km.serial).length > HOST_MAX_SERIAL_BYTES) {
    return { kind: "unknown" };
  }
  return { kind: "km", km: scan.km };
}

export interface ScanContext {
  local: LocalExecutor;
  pairing: Pairing;
  shift: WorkShift;
  /** The operator of the session (`FloorSession.id`). */
  operatorId: string;
  /** The link is `online` right now: only then is the host asked. */
  online: () => boolean;
  /** `HostApi.checkCode` (300 ms). */
  checkCode: (codeHash: string) => Promise<CodeCheck>;
  /** A failed host call the shell may act on: a refused key, another certificate. */
  onHostError: (error: unknown) => void;
  now: () => Date;
  newId: () => string;
}

/** What became of a scan; every outcome is in `floor_scans` and the outbox. */
export type ScanOutcome =
  | { kind: "accepted"; boxId: string; itemCount: number }
  | { kind: "duplicate"; source: "local"; firstScannedAt: string }
  | { kind: "duplicate"; source: "host"; firstScannedAt: string; shiftNumber: string }
  | { kind: "wrong_gtin"; gtin14: string }
  | { kind: "invalid"; rawKind: Exclude<ScanRawKind, "km"> };

const localOwnerRow = z.object({ scanned_at: z.string() });

/** When this station accepted the code, if it holds it in a box of this pairing. */
async function readLocalOwner(
  context: ScanContext,
  codeHash: string,
): Promise<{ scannedAt: string } | null> {
  const [row] = await context.local.query(
    "SELECT scanned_at FROM floor_codes WHERE host_id = ? AND device_id = ? AND code_hash = ?",
    [context.pairing.hostId, context.pairing.deviceId, codeHash],
    localOwnerRow,
  );
  return row === undefined ? null : { scannedAt: row.scanned_at };
}

/**
 * Another device's scan the host knows owns the code (stage 2a spec §5.7.3,
 * step 4), asked only while the link is `online`. No answer in 300 ms, any
 * failure, `free`, and a scan of this very station (whose own registry is
 * newer than the host's: an undo it has not sent yet) all let the scan
 * through; a duplicate the host finds later is a `conflict` receipt.
 */
async function hostOwner(context: ScanContext, codeHash: string): Promise<CodeOwner | null> {
  if (!context.online()) return null;
  let check: CodeCheck;
  try {
    check = await context.checkCode(codeHash);
  } catch (error) {
    context.onHostError(error);
    return null;
  }
  if (check.status !== "taken" || check.owner.sameDevice) return null;
  return check.owner;
}

function scanRow(context: ScanContext, id: string, data: ScanFact): LocalStatement {
  const { pairing, shift, operatorId } = context;
  return {
    sql:
      "INSERT INTO floor_scans (id, host_id, device_id, shift_id, box_id, verdict, " +
      "duplicate_source, raw_kind, raw_length, code_hash, gtin14, serial, canonical, " +
      "scanned_at, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    values: [
      id,
      pairing.hostId,
      pairing.deviceId,
      shift.copy.id,
      data.boxId,
      data.verdict,
      data.duplicateSource,
      data.rawKind,
      data.rawLength,
      data.code?.codeHash ?? null,
      data.code?.gtin14 ?? null,
      data.code?.serial ?? null,
      data.code?.canonical ?? null,
      data.scannedAt,
      operatorId,
    ],
    expectedChanges: 1,
  };
}

/**
 * One scan of the work screen (stage 2a spec §5.7.3), run strictly one at a
 * time (`createWorkQueue`): read it; a code of another product is
 * `wrong_gtin`; a code this station holds is a local duplicate; a code
 * another device's scan owns on the host is a host duplicate; otherwise it
 * is accepted into the shift's open box, which opens with it. Every scan is
 * journalled with its outbox record in ONE transaction: the accepted one with
 * its box and its place in `floor_codes`, whose key keeps a code in one box
 * of the pairing at most — a second accept of a code the check missed fails
 * whole (`changes_mismatch`) and writes nothing. A scan that is no code
 * keeps its length and kind, never its text (decision 15: it may be a
 * badge). A failed write rejects: the scan is not taken, and the screen says
 * so.
 */
export async function processScan(context: ScanContext, raw: string): Promise<ScanOutcome> {
  const { local, pairing, shift } = context;
  const scannedAt = context.now().toISOString();
  const head: RecordHead = {
    id: context.newId(),
    shiftId: shift.copy.id,
    operatorId: context.operatorId,
  };
  const journal = async (data: ScanFact, more: readonly LocalStatement[] = []) => {
    await local.transaction([
      ...more,
      scanRow(context, head.id, data),
      outboxStatement(scanRecord(head, data), pairing, scannedAt),
    ]);
  };
  const reading = readScan(raw);
  const base = { scannedAt, rawLength: raw.length };
  if (reading.kind !== "km") {
    await journal({
      ...base,
      verdict: "invalid",
      duplicateSource: null,
      rawKind: reading.kind,
      code: null,
      boxId: null,
    });
    return { kind: "invalid", rawKind: reading.kind };
  }
  const code = scannedCode(reading.km);
  const refused = { ...base, rawKind: "km" as const, code, boxId: null };
  if (code.gtin14 !== shift.snapshot.product.gtin14) {
    await journal({ ...refused, verdict: "wrong_gtin", duplicateSource: null });
    return { kind: "wrong_gtin", gtin14: code.gtin14 };
  }
  const mine = await readLocalOwner(context, code.codeHash);
  if (mine !== null) {
    await journal({ ...refused, verdict: "duplicate", duplicateSource: "local" });
    return { kind: "duplicate", source: "local", firstScannedAt: mine.scannedAt };
  }
  const owner = await hostOwner(context, code.codeHash);
  if (owner !== null) {
    await journal({ ...refused, verdict: "duplicate", duplicateSource: "host" });
    return {
      kind: "duplicate",
      source: "host",
      firstScannedAt: owner.scannedAt,
      shiftNumber: owner.shiftNumber,
    };
  }
  const box = await readOpenBox(local, pairing, shift.copy.id);
  const boxId = box?.id ?? context.newId();
  const intoBox: LocalStatement =
    box === null
      ? {
          sql:
            "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, item_count) " +
            "VALUES (?, ?, ?, ?, ?, 1)",
          values: [boxId, pairing.hostId, pairing.deviceId, shift.copy.id, scannedAt],
          expectedChanges: 1,
        }
      : {
          sql:
            "UPDATE floor_boxes SET item_count = item_count + 1 " +
            "WHERE id = ? AND host_id = ? AND device_id = ? AND closed_at IS NULL",
          values: [boxId, pairing.hostId, pairing.deviceId],
          expectedChanges: 1,
        };
  const claim: LocalStatement = {
    sql:
      "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, " +
      "scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    values: [
      pairing.hostId,
      pairing.deviceId,
      code.codeHash,
      shift.copy.id,
      boxId,
      head.id,
      scannedAt,
    ],
    expectedChanges: 1,
  };
  await journal({ ...refused, verdict: "ok", duplicateSource: null, boxId }, [intoBox, claim]);
  return { kind: "accepted", boxId, itemCount: (box?.itemCount ?? 0) + 1 };
}
```

Создать `apps/standalone/src/floor/work/work-queue.ts`:

<!-- prettier-ignore -->
```ts
/**
 * The work of a shift's screen in strict order, one job at a time (a port of
 * the cloud station's `scan-queue.ts`): two scans of one code never both pass
 * the check before either is written, a box closes between the scan that
 * filled it and the next one, and outcomes come in the order of the scans. A
 * scan that arrives meanwhile waits its turn; it is never dropped. A job that
 * fails does not stop the next.
 */
export interface WorkQueue {
  /** Runs `job` after every job queued before it; resolves or rejects as it does. */
  run: <T>(job: () => Promise<T>) => Promise<T>;
  /** Jobs queued or running. */
  pending: () => number;
}

export function createWorkQueue(): WorkQueue {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    run: <T>(job: () => Promise<T>) => {
      pending += 1;
      const result = tail.then(job);
      const settled = () => {
        pending -= 1;
      };
      tail = result.then(settled, settled);
      return result;
    },
    pending: () => pending,
  };
}
```

Создать `apps/standalone/src/floor/work/work-reads.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";

/** The open box of a shift (`floor_boxes`, one at most): the scans go into it. */
export interface OpenBox {
  id: string;
  openedAt: string;
  itemCount: number;
}

const openBoxRow = z.object({
  id: z.string(),
  opened_at: z.string(),
  item_count: z.number().int().nonnegative(),
});

/** This pairing's open box of the shift, or `null`. */
export async function readOpenBox(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<OpenBox | null> {
  const [row] = await local.query(
    "SELECT id, opened_at, item_count FROM floor_boxes " +
      "WHERE host_id = ? AND device_id = ? AND shift_id = ? AND closed_at IS NULL",
    [pairing.hostId, pairing.deviceId, shiftId],
    openBoxRow,
  );
  return row === undefined
    ? null
    : { id: row.id, openedAt: row.opened_at, itemCount: row.item_count };
}

/** What the work screen shows of the shift, from this station's own records. */
export interface WorkTotals {
  openBox: OpenBox | null;
  /** Codes this station holds in the shift's boxes: the shift's actual quantity. */
  accepted: number;
  /** Boxes of the shift closed and not taken apart. */
  closedBoxes: number;
  /** The SSCC of the box closed last, or `null`. */
  lastSscc: string | null;
}

const countRow = z.object({ n: z.number().int().nonnegative() });
const ssccRow = z.object({ sscc: z.string() });

export async function readWorkTotals(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<WorkTotals> {
  const scope = [pairing.hostId, pairing.deviceId, shiftId];
  const [openBox, accepted, closed, last] = await Promise.all([
    readOpenBox(local, pairing, shiftId),
    local.query(
      "SELECT count(*) AS n FROM floor_codes WHERE host_id = ? AND device_id = ? AND shift_id = ?",
      scope,
      countRow,
    ),
    local.query(
      "SELECT count(*) AS n FROM floor_boxes WHERE host_id = ? AND device_id = ? " +
        "AND shift_id = ? AND closed_at IS NOT NULL AND disassembled_at IS NULL",
      scope,
      countRow,
    ),
    local.query(
      "SELECT sscc FROM floor_boxes WHERE host_id = ? AND device_id = ? AND shift_id = ? " +
        "AND closed_at IS NOT NULL ORDER BY closed_at DESC, serial DESC LIMIT 1",
      scope,
      ssccRow,
    ),
  ]);
  return {
    openBox,
    accepted: accepted[0]?.n ?? 0,
    closedBoxes: closed[0]?.n ?? 0,
    lastSscc: last[0]?.sscc ?? null,
  };
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-pipeline.test.ts`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  15 passed (15)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  90 passed (90)`, `Tests  2263 passed (2263)` (на настоящем дереве — больше на тесты, которых на копии нет).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — вставка в `floor_codes` без `expectedChanges: 1`. В `apps/standalone/src/floor/work/scan-pipeline.ts` фрагмент

<!-- prettier-ignore -->
```ts
      scannedAt,
    ],
    expectedChanges: 1,
  };
  await journal({ ...refused, verdict: "ok", duplicateSource: null, boxId }, [intoBox, claim]);
```

заменить на:

<!-- prettier-ignore -->
```ts
      scannedAt,
    ],
  };
  await journal({ ...refused, verdict: "ok", duplicateSource: null, boxId }, [intoBox, claim]);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-pipeline.test.ts`
Expected: FAIL — «holds a code in one box at most: a second accept the check missed writes nothing».

М2 — короб и код пишутся отдельной транзакцией от журнала и очереди. В `apps/standalone/src/floor/work/scan-pipeline.ts` фрагмент

<!-- prettier-ignore -->
```ts
    await local.transaction([
      ...more,
      scanRow(context, head.id, data),
```

заменить на:

<!-- prettier-ignore -->
```ts
    if (more.length > 0) await local.transaction([...more]);
    await local.transaction([
      scanRow(context, head.id, data),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-pipeline.test.ts`
Expected: FAIL — «writes the journal row, the code, the box and the outbox record together or not at all».

М3 — ответ хоста о скане этой же станции даёт дубль. В `apps/standalone/src/floor/work/scan-pipeline.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (check.status !== "taken" || check.owner.sameDevice) return null;
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (check.status !== "taken") return null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-pipeline.test.ts`
Expected: FAIL — «accepts without the host when offline, when the check fails or times out, and over its own scan».

М4 — хост спрашивается и без связи. В `apps/standalone/src/floor/work/scan-pipeline.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (!context.online()) return null;
  let check: CodeCheck;
```

заменить на:

<!-- prettier-ignore -->
```ts
  let check: CodeCheck;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-pipeline.test.ts`
Expected: FAIL — «accepts without the host when offline, when the check fails or times out, and over its own scan».

М5 — предел серии исключает сами 64 байта. В `apps/standalone/src/floor/work/scan-pipeline.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (new TextEncoder().encode(scan.km.serial).length > HOST_MAX_SERIAL_BYTES) {
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (new TextEncoder().encode(scan.km.serial).length >= HOST_MAX_SERIAL_BYTES) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-pipeline.test.ts`
Expected: FAIL — «reads a GTIN, an SSCC and anything else as no code of marking».

М6 — предел серии считается в символах. В `apps/standalone/src/floor/work/scan-pipeline.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (new TextEncoder().encode(scan.km.serial).length > HOST_MAX_SERIAL_BYTES) {
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (scan.km.serial.length > HOST_MAX_SERIAL_BYTES) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-pipeline.test.ts`
Expected: FAIL — «reads a GTIN, an SSCC and anything else as no code of marking».

М7 — локальный дубль не проверяется. В `apps/standalone/src/floor/work/scan-pipeline.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (mine !== null) {
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (mine !== null && false) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-pipeline.test.ts`
Expected: FAIL — «finds a code it holds, under another AIM prefix or tail too, without asking the host», «keeps what it took across a restart: the same box, and the code still its own».

М8 — чужой GTIN не проверяется. В `apps/standalone/src/floor/work/scan-pipeline.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (code.gtin14 !== shift.snapshot.product.gtin14) {
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (code.gtin14 === "x") {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-pipeline.test.ts`
Expected: FAIL — «refuses a code of another product into no box».

М9 — рост счётчика короба без `expectedChanges: 1`. В `apps/standalone/src/floor/work/scan-pipeline.ts` фрагмент

<!-- prettier-ignore -->
```ts
            "WHERE id = ? AND host_id = ? AND device_id = ? AND closed_at IS NULL",
          values: [boxId, pairing.hostId, pairing.deviceId],
          expectedChanges: 1,
```

заменить на:

<!-- prettier-ignore -->
```ts
            "WHERE id = ? AND host_id = ? AND device_id = ? AND closed_at IS NULL",
          values: [boxId, pairing.hostId, pairing.deviceId],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-pipeline.test.ts`
Expected: FAIL — «never puts a code into a box that closed while the scan was on its way».

М10 — очередь запускает работу сразу, не дожидаясь предыдущей. В `apps/standalone/src/floor/work/work-queue.ts` фрагмент

<!-- prettier-ignore -->
```ts
      const result = tail.then(job);
```

заменить на:

<!-- prettier-ignore -->
```ts
      const result = job();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scan-pipeline.test.ts`
Expected: FAIL — «runs one job at a time, in order, and goes on after a failed one».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/work/scan-pipeline.ts apps/standalone/src/floor/work/work-queue.ts apps/standalone/src/floor/work/work-reads.ts apps/standalone/test/floor-scan-pipeline.test.ts apps/standalone/test/support/floor-work.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/work/scan-pipeline.ts apps/standalone/src/floor/work/work-queue.ts apps/standalone/src/floor/work/work-reads.ts apps/standalone/test/floor-scan-pipeline.test.ts apps/standalone/test/support/floor-work.ts
git commit -m "feat(standalone): a scan of the work screen, journalled with its outbox record in one write" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Закрытие короба — номер из блока со сравнением курсора, одна транзакция, точка расширения; полный короб

`closeOpenBox` (решение 10, §5.7.4): пустой короб номера не тратит; номер — следующий самого раннего блока префикса снимка с расширением 0, у которого он есть; SSCC — `buildSscc` домена; одна транзакция: списание номера сравнением курсора (`WHERE block_id = ? AND next_serial = ?`, `expectedChanges: 1`), закрытие при открытом коробе с прочитанным счётчиком, запись `box_closed` (`boxMembershipDigestV1` от кодов короба) и то, что добавляют шаги поздних планов (`CloseStep`: план 2a7 — задание печати, план ПЛ-Ц — присоединение к открытой паллете; поля записи шаг не перекрывает, а поле вне схемы роняет закрытие). Несошедшаяся проверка — `stale`, ничего не записано. Номер вне ёмкости префикса (`SSCC_RANGE`) списывается и теряется, короб открыт. `closeIfFull` закрывает короб, набравший вместимость смены, — после каждого принятого скана и при входе в экран.

**Files:**

- Create: `apps/standalone/src/floor/work/box-close.ts`
- Test: `apps/standalone/test/floor-box-close.test.ts` (Create), `apps/standalone/test/support/floor-work.ts` (Modify)

**Interfaces:**

- Consumes: `boxMembershipDigestV1`, `buildSscc`, `DomainError` (`@markiro/domain`); `boxClosedRecord`, `outboxStatement` (задача 1); `ScanContext`, `readOpenBox` (задача 3); `LocalDbError` (`src/local/executor.ts`); таблицы `floor_sscc_blocks`, `floor_boxes`, `floor_codes`, `outbox`.
- Produces:
  - `src/floor/work/box-close.ts`: `BOX_EXTENSION = 0`, `type BoxContext` (`local`, `pairing`, `shift`, `operatorId`, `now`, `newId` из `ScanContext`), `interface ClosingBox { boxId; shiftId; sscc; blockId; serial; openedAt; closedAt; itemCount; codeHashes; operatorId }`, `interface CloseAddition { statements; data? }`, `type CloseStep = (box: ClosingBox) => Promise<CloseAddition>`, `type CloseResult`, `closeOpenBox(context, steps?)`, `closeIfFull(context, steps?)`;
  - `test/support/floor-work.ts`: `SECOND` (вторая смена той же станции), `interface SeededBlock`, `seedBlock(db, block)`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-box-close.test.ts`:

<!-- prettier-ignore -->
```ts
import { boxMembershipDigestV1, buildSscc } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import { boxClosedRecord } from "../src/floor/facts.js";
import { closeIfFull, closeOpenBox, type CloseStep } from "../src/floor/work/box-close.js";
import { processScan, type ScanContext } from "../src/floor/work/scan-pipeline.js";
import type { LocalExecutor } from "../src/local/executor.js";
import {
  enteredShift,
  holdingWrites,
  km,
  OPERATOR_ID,
  PAIRING,
  PREFIX,
  rows,
  scanContext,
  SECOND,
  seedBlock,
  SHIFT_ID,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

const BLOCK_A = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const BLOCK_B = "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b";
const BLOCK_USED = "7f6e5d4c-3b2a-4f1e-8d9c-8b7a6f5e4d3c";

async function station() {
  const { db, executor } = openLocalDb();
  const shift = await enteredShift(executor);
  return { db, local: executor, shift };
}

/** Accepts `serials` into the shift's open box. */
async function fill(context: ScanContext, serials: readonly string[]): Promise<void> {
  for (const serial of serials) await processScan(context, km(serial));
}

function codeHashes(db: ReturnType<typeof openLocalDb>["db"]): string[] {
  return rows(db, "SELECT code_hash FROM floor_codes ORDER BY code_hash").map((row) =>
    String(row["code_hash"]),
  );
}

describe("the close of a box", () => {
  it("takes the next serial of the earliest block with room, with its record in the same write", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_USED, from: 1, to: 10, next: 11 });
    seedBlock(db, { blockId: BLOCK_B, from: 3500, to: 5499 });
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["A1", "A2", "A3"]);
    const sscc = buildSscc(0, PREFIX, 1500);
    const result = await closeOpenBox(context);
    expect(result).toMatchObject({
      kind: "closed",
      box: {
        sscc,
        blockId: BLOCK_A,
        serial: 1500,
        itemCount: 3,
        openedAt: "2026-10-08T06:15:00.000Z",
        closedAt: "2026-10-08T06:15:03.000Z",
      },
    });
    const box = rows(
      db,
      "SELECT id, closed_at, sscc, block_id, serial, closed_by, item_count FROM floor_boxes",
    );
    expect(box).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000002",
        closed_at: "2026-10-08T06:15:03.000Z",
        sscc,
        block_id: BLOCK_A,
        serial: 1500,
        closed_by: OPERATOR_ID,
        item_count: 3,
      },
    ]);
    expect(
      rows(db, "SELECT block_id, next_serial FROM floor_sscc_blocks ORDER BY from_serial"),
    ).toEqual([
      { block_id: BLOCK_USED, next_serial: 11 },
      { block_id: BLOCK_A, next_serial: 1501 },
      { block_id: BLOCK_B, next_serial: 3500 },
    ]);
    const [outbox] = rows(db, "SELECT id, kind, payload FROM outbox WHERE kind = 'box_closed'");
    expect(JSON.parse(String(outbox?.["payload"]))).toEqual(
      boxClosedRecord(
        { id: String(outbox?.["id"]), shiftId: SHIFT_ID, operatorId: OPERATOR_ID },
        {
          boxId: "00000000-0000-4000-8000-000000000002",
          sscc,
          blockId: BLOCK_A,
          serial: 1500,
          openedAt: "2026-10-08T06:15:00.000Z",
          closedAt: "2026-10-08T06:15:03.000Z",
          itemCount: 3,
          membershipDigest: boxMembershipDigestV1(codeHashes(db)),
        },
      ),
    );
  });

  it("spends no serial on a shift without an open box or with an empty one", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await expect(closeOpenBox(context)).resolves.toEqual({ kind: "empty" });
    db.prepare(
      "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, item_count) " +
        "VALUES ('9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d', ?, ?, ?, '2026-10-08T06:10:00.000Z', 0)",
    ).run(PAIRING.hostId, PAIRING.deviceId, SHIFT_ID);
    await expect(closeOpenBox(context)).resolves.toEqual({ kind: "empty" });
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1500 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 0 }]);
  });

  it("has no serials without a block of the snapshot's prefix and box extension, of this pairing, with room", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_USED, from: 1, to: 10, next: 11 });
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499, prefix: "460068201" });
    seedBlock(db, { blockId: BLOCK_B, from: 0, to: 199, extension: 1 });
    seedBlock(db, {
      blockId: "8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d",
      from: 4000,
      to: 5999,
      deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f",
    });
    const context = scanContext(local, shift);
    await fill(context, ["B1"]);
    await expect(closeOpenBox(context)).resolves.toEqual({ kind: "no_serials" });
    expect(rows(db, "SELECT closed_at, item_count FROM floor_boxes")).toEqual([
      { closed_at: null, item_count: 1 },
    ]);
    // The last serial of a block is still a serial.
    seedBlock(db, { blockId: "9c8d7e6f-5a4b-4c3d-9e2f-1a0b9c8d7e6f", from: 20, to: 20 });
    await expect(closeOpenBox(context)).resolves.toMatchObject({
      kind: "closed",
      box: { serial: 20 },
    });
  });

  it("loses a serial past the prefix's range, keeps the box open, and takes the next one after", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 9_999_999, to: 10_000_001, next: 10_000_000 });
    const context = scanContext(local, shift);
    await fill(context, ["C1"]);
    await expect(closeOpenBox(context)).resolves.toEqual({ kind: "invalid_serial" });
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([
      { next_serial: 10_000_001 },
    ]);
    expect(rows(db, "SELECT closed_at FROM floor_boxes")).toEqual([{ closed_at: null }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_closed'")).toEqual([
      { n: 0 },
    ]);
  });

  it("never gives one SSCC to two boxes: a close racing another for its serial writes nothing", async () => {
    const { db, local, shift } = await station();
    const second = await enteredShift(local, SECOND);
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const held = holdingWrites(local);
    const first = scanContext(held.executor, shift, { newId: () => crypto.randomUUID() });
    const other = scanContext(held.executor, second, { newId: () => crypto.randomUUID() });
    await fill(first, ["D1"]);
    await fill(other, ["D2"]);
    held.holdNext();
    const racing = closeOpenBox(first);
    await held.reached();
    await expect(closeOpenBox(other)).resolves.toMatchObject({
      kind: "closed",
      box: { serial: 1500 },
    });
    held.release();
    await expect(racing).resolves.toEqual({ kind: "stale" });
    expect(
      rows(db, "SELECT shift_id, closed_at FROM floor_boxes WHERE shift_id = ?", SHIFT_ID),
    ).toEqual([{ shift_id: SHIFT_ID, closed_at: null }]);
    await expect(closeOpenBox(first)).resolves.toMatchObject({
      kind: "closed",
      box: { serial: 1501 },
    });
    expect(rows(db, "SELECT serial FROM floor_boxes ORDER BY serial")).toEqual([
      { serial: 1500 },
      { serial: 1501 },
    ]);
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1502 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_closed'")).toEqual([
      { n: 2 },
    ]);
  });

  it("does not close a box that took another code while the close was on its way", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const held = holdingWrites(local);
    const context = scanContext(held.executor, shift, { newId: () => crypto.randomUUID() });
    await fill(context, ["E1"]);
    held.holdNext();
    const closing = closeOpenBox(context);
    await held.reached();
    db.prepare("UPDATE floor_boxes SET item_count = item_count + 1").run();
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(rows(db, "SELECT closed_at FROM floor_boxes")).toEqual([{ closed_at: null }]);
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1500 }]);
  });

  it("commits what a later plan adds with the close, or nothing at all", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["F1"]);
    const failing: CloseStep = async () => ({
      statements: [{ sql: "INSERT INTO floor_boxes (id) VALUES (NULL)" }],
    });
    await expect(closeOpenBox(context, [failing])).rejects.toMatchObject({
      code: "statement_failed",
    });
    expect(rows(db, "SELECT closed_at, needs_fix FROM floor_boxes")).toEqual([
      { closed_at: null, needs_fix: 0 },
    ]);
    expect(rows(db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([{ next_serial: 1500 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_closed'")).toEqual([
      { n: 0 },
    ]);
    const seen: string[] = [];
    const marking: CloseStep = async (box) => {
      seen.push(box.sscc);
      return {
        statements: [
          {
            sql: "UPDATE floor_boxes SET needs_fix = 1 WHERE id = ?",
            values: [box.boxId],
            expectedChanges: 1,
          },
        ],
        data: { itemCount: 99 },
      };
    };
    await expect(closeOpenBox(context, [marking])).resolves.toMatchObject({
      kind: "closed",
      box: { itemCount: 1 },
    });
    expect(seen).toEqual([buildSscc(0, PREFIX, 1500)]);
    expect(rows(db, "SELECT needs_fix FROM floor_boxes")).toEqual([{ needs_fix: 1 }]);
    const [outbox] = rows(db, "SELECT payload FROM outbox WHERE kind = 'box_closed'");
    expect(JSON.parse(String(outbox?.["payload"]))).toMatchObject({ data: { itemCount: 1 } });
  });

  it("refuses a field the record does not know, and writes nothing", async () => {
    const { db, local, shift } = await station();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = scanContext(local, shift);
    await fill(context, ["G1"]);
    const unknown: CloseStep = async () => ({ statements: [], data: { palletId: "x" } });
    await expect(closeOpenBox(context, [unknown])).rejects.toThrow();
    expect(rows(db, "SELECT closed_at FROM floor_boxes")).toEqual([{ closed_at: null }]);
  });
});

describe("a full box", () => {
  async function filled(local: LocalExecutor, count: number) {
    const shift = await enteredShift(local);
    const context = scanContext(local, shift);
    await fill(
      context,
      Array.from({ length: count }, (_, index) => `H${index}`),
    );
    return context;
  }

  it("closes once it holds the shift's box capacity, and not one code before", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    const context = await filled(executor, 11);
    expect(context.shift.copy.boxCapacity).toBe(12);
    await expect(closeIfFull(context)).resolves.toBeNull();
    await processScan(context, km("H11"));
    await expect(closeIfFull(context)).resolves.toMatchObject({
      kind: "closed",
      box: { itemCount: 12, serial: 1500 },
    });
    await expect(closeIfFull(context)).resolves.toBeNull();
  });

  it("found full when the work screen opens, closes first", async () => {
    const { db, executor } = openLocalDb();
    const context = await filled(executor, 12);
    await expect(closeIfFull(context)).resolves.toEqual({ kind: "no_serials" });
    seedBlock(db, { blockId: BLOCK_A, from: 1500, to: 3499 });
    await expect(closeIfFull(context)).resolves.toMatchObject({ kind: "closed" });
    expect(rows(db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { n: 0 },
    ]);
  });
});
```

Правка `apps/standalone/test/support/floor-work.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import type { DatabaseSync } from "node:sqlite";

import { vi } from "vitest";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { vi } from "vitest";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
}

/** Every row of `sql`, as node:sqlite reads it. */
export function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
```

заменить на:

<!-- prettier-ignore -->
```ts
}

/** Every row of `sql` with `params`, as node:sqlite reads it. */
export function rows(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): Record<string, unknown>[] {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row }));
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
    },
  };
}
```

заменить на:

<!-- prettier-ignore -->
```ts
    },
  };
}

/** A second active shift of the same product this station entered, for two boxes at once. */
export const SECOND: EnteredShift = {
  ...ENTERED,
  id: "4e7a1c9d-2b5f-4d8e-a3c6-9f0b1e2d3c4a",
  number: "OCT26-005/S",
};

export interface SeededBlock {
  blockId: string;
  from: number;
  to: number;
  next?: number;
  prefix?: string;
  extension?: number;
  hostId?: string;
  deviceId?: string;
  receivedAt?: string;
}

/** A block of SSCC serials this station holds, written as the block request keeps one. */
export function seedBlock(db: DatabaseSync, block: SeededBlock): void {
  db.prepare(
    "INSERT INTO floor_sscc_blocks (block_id, host_id, device_id, issuer_prefix, extension, " +
      "from_serial, to_serial, next_serial, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    block.blockId,
    block.hostId ?? PAIRING.hostId,
    block.deviceId ?? PAIRING.deviceId,
    block.prefix ?? PREFIX,
    block.extension ?? 0,
    block.from,
    block.to,
    block.next ?? block.from,
    block.receivedAt ?? "2026-10-08T06:00:00.000Z",
  );
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: FAIL — `test/floor-box-close.test.ts` не загружается: `Failed to resolve import "../src/floor/work/box-close.js"`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/floor/work/box-close.ts`:

<!-- prettier-ignore -->
```ts
import { boxMembershipDigestV1, buildSscc, DomainError } from "@markiro/domain";
import { z } from "zod";

import { LocalDbError, type LocalStatement } from "../../local/executor.js";
import { boxClosedRecord, outboxStatement } from "../facts.js";
import type { ScanContext } from "./scan-pipeline.js";
import { readOpenBox } from "./work-reads.js";

/** The extension digit of a box's SSCC (decision 9; a pallet's is 1, a later plan's). */
export const BOX_EXTENSION = 0;

/** What a box's close needs of the work: the scan pipeline's context without the host. */
export type BoxContext = Pick<
  ScanContext,
  "local" | "pairing" | "shift" | "operatorId" | "now" | "newId"
>;

/** A box on its way to close: everything its `box_closed` record says, before the write. */
export interface ClosingBox {
  boxId: string;
  shiftId: string;
  sscc: string;
  blockId: string;
  serial: number;
  openedAt: string;
  closedAt: string;
  itemCount: number;
  /** The box's codes (`kmHash`), in their order. */
  codeHashes: readonly string[];
  operatorId: string;
}

/**
 * What a later plan adds to a box's close, committed in the same transaction
 * after it: plan 2a7 the box's print job, the pallets' plan the box joining
 * the station's open pallet. `data` adds fields to the `box_closed` record
 * (the pallets' plan: `palletId`, which its own change of
 * `boxClosedFactSchema` admits); the record's own fields always win.
 */
export interface CloseAddition {
  statements: readonly LocalStatement[];
  data?: Readonly<Record<string, unknown>>;
}

/** A later plan's part of a close, read before the write (it may query the local database). */
export type CloseStep = (box: ClosingBox) => Promise<CloseAddition>;

/**
 * How a close went: `closed`; `empty` — no open box, or one without a code,
 * and no serial spent; `no_serials` — no block of the snapshot's prefix has a
 * serial left; `invalid_serial` — the block's next serial is past what the
 * prefix can number (the domain's `SSCC_RANGE`): that serial is spent and the
 * box stays open; `stale` — the box or the block changed between the read
 * and the write, nothing was written, and the close may simply be tried
 * again.
 */
export type CloseResult =
  | { kind: "closed"; box: ClosingBox }
  | { kind: "empty" }
  | { kind: "no_serials" }
  | { kind: "invalid_serial" }
  | { kind: "stale" };

const codeRow = z.object({ code_hash: z.string() });
const blockRow = z.object({ block_id: z.string(), next_serial: z.number().int().nonnegative() });

function spendSerial(blockId: string, serial: number): LocalStatement {
  return {
    sql:
      "UPDATE floor_sscc_blocks SET next_serial = next_serial + 1 " +
      "WHERE block_id = ? AND next_serial = ?",
    values: [blockId, serial],
    expectedChanges: 1,
  };
}

/** Runs the write; a guard that no longer holds is `stale`, anything else rejects. */
async function commit(
  context: BoxContext,
  statements: readonly LocalStatement[],
): Promise<"done" | "stale"> {
  try {
    await context.local.transaction(statements);
    return "done";
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") return "stale";
    throw error;
  }
}

/**
 * Closes the shift's open box (stage 2a spec §5.7.4, decision 10): not an
 * empty one; the next serial of the earliest block of the snapshot's prefix
 * that has one; the SSCC by the domain's `buildSscc`; then ONE transaction —
 * the serial spent by comparing the block's cursor with the value read, the
 * box closed only if it is still open with the same count, its `box_closed`
 * record, and what `steps` add. Either everything is written or nothing: a
 * serial is never spent without its box, and two closes can never take one
 * serial.
 */
export async function closeOpenBox(
  context: BoxContext,
  steps: readonly CloseStep[] = [],
): Promise<CloseResult> {
  const { local, pairing, shift } = context;
  const box = await readOpenBox(local, pairing, shift.copy.id);
  if (box === null || box.itemCount === 0) return { kind: "empty" };
  const codes = await local.query(
    "SELECT code_hash FROM floor_codes WHERE host_id = ? AND device_id = ? AND box_id = ? " +
      "ORDER BY code_hash",
    [pairing.hostId, pairing.deviceId, box.id],
    codeRow,
  );
  const [block] = await local.query(
    "SELECT block_id, next_serial FROM floor_sscc_blocks WHERE host_id = ? AND device_id = ? " +
      "AND issuer_prefix = ? AND extension = ? AND next_serial <= to_serial " +
      "ORDER BY from_serial, block_id LIMIT 1",
    [pairing.hostId, pairing.deviceId, shift.snapshot.issuerPrefix, BOX_EXTENSION],
    blockRow,
  );
  if (block === undefined) return { kind: "no_serials" };
  let sscc: string;
  try {
    sscc = buildSscc(BOX_EXTENSION, shift.snapshot.issuerPrefix, block.next_serial);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "SSCC_RANGE") throw error;
    // As in the cloud: the serial is lost, the box stays open, and the next
    // close takes the next serial instead of failing on this one forever.
    const spent = await commit(context, [spendSerial(block.block_id, block.next_serial)]);
    return spent === "stale" ? { kind: "stale" } : { kind: "invalid_serial" };
  }
  const closing: ClosingBox = {
    boxId: box.id,
    shiftId: shift.copy.id,
    sscc,
    blockId: block.block_id,
    serial: block.next_serial,
    openedAt: box.openedAt,
    closedAt: context.now().toISOString(),
    itemCount: box.itemCount,
    codeHashes: codes.map((row) => row.code_hash),
    operatorId: context.operatorId,
  };
  const additions: CloseAddition[] = [];
  for (const step of steps) additions.push(await step(closing));
  const added: Record<string, unknown> = {};
  for (const addition of additions) Object.assign(added, addition.data);
  const record = boxClosedRecord(
    { id: context.newId(), shiftId: closing.shiftId, operatorId: closing.operatorId },
    {
      ...added,
      boxId: closing.boxId,
      sscc: closing.sscc,
      blockId: closing.blockId,
      serial: closing.serial,
      openedAt: closing.openedAt,
      closedAt: closing.closedAt,
      itemCount: closing.itemCount,
      membershipDigest: boxMembershipDigestV1(closing.codeHashes),
    },
  );
  const written = await commit(context, [
    spendSerial(closing.blockId, closing.serial),
    {
      sql:
        "UPDATE floor_boxes SET closed_at = ?, sscc = ?, block_id = ?, serial = ?, closed_by = ? " +
        "WHERE id = ? AND host_id = ? AND device_id = ? AND closed_at IS NULL AND item_count = ?",
      values: [
        closing.closedAt,
        closing.sscc,
        closing.blockId,
        closing.serial,
        closing.operatorId,
        closing.boxId,
        pairing.hostId,
        pairing.deviceId,
        closing.itemCount,
      ],
      expectedChanges: 1,
    },
    outboxStatement(record, pairing, closing.closedAt),
    ...additions.flatMap((addition) => addition.statements),
  ]);
  return written === "stale" ? { kind: "stale" } : { kind: "closed", box: closing };
}

/**
 * Closes the open box once it holds the shift's box capacity (stage 2a spec
 * §5.7.3, step 6): after every accepted scan, and when the work screen opens —
 * a station stopped between the scan that filled a box and its close finds
 * the box full and closes it first. `null` while the box has room.
 */
export async function closeIfFull(
  context: BoxContext,
  steps: readonly CloseStep[] = [],
): Promise<CloseResult | null> {
  const box = await readOpenBox(context.local, context.pairing, context.shift.copy.id);
  if (box === null || box.itemCount < context.shift.copy.boxCapacity) return null;
  return closeOpenBox(context, steps);
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  10 passed (10)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  91 passed (91)`, `Tests  2273 passed (2273)` (на настоящем дереве — больше на тесты, которых на копии нет).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — списание номера без сравнения курсора. В `apps/standalone/src/floor/work/box-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "WHERE block_id = ? AND next_serial = ?",
    values: [blockId, serial],
```

заменить на:

<!-- prettier-ignore -->
```ts
      "WHERE block_id = ? AND ? IS NOT NULL",
    values: [blockId, serial],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: FAIL — «never gives one SSCC to two boxes: a close racing another for its serial writes nothing».

М2 — списание номера без `expectedChanges: 1`. В `apps/standalone/src/floor/work/box-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
    values: [blockId, serial],
    expectedChanges: 1,
```

заменить на:

<!-- prettier-ignore -->
```ts
    values: [blockId, serial],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: FAIL — «never gives one SSCC to two boxes: a close racing another for its serial writes nothing».

М3 — закрытие без проверки счётчика короба. В `apps/standalone/src/floor/work/box-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
        "WHERE id = ? AND host_id = ? AND device_id = ? AND closed_at IS NULL AND item_count = ?",
```

заменить на:

<!-- prettier-ignore -->
```ts
        "WHERE id = ? AND host_id = ? AND device_id = ? AND closed_at IS NULL AND ? IS NOT NULL",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: FAIL — «does not close a box that took another code while the close was on its way».

М4 — закрывается короб без кодов. В `apps/standalone/src/floor/work/box-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (box === null || box.itemCount === 0) return { kind: "empty" };
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (box === null) return { kind: "empty" };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: FAIL — «spends no serial on a shift without an open box or with an empty one».

М5 — последний номер блока не используется. В `apps/standalone/src/floor/work/box-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "AND issuer_prefix = ? AND extension = ? AND next_serial <= to_serial " +
```

заменить на:

<!-- prettier-ignore -->
```ts
      "AND issuer_prefix = ? AND extension = ? AND next_serial < to_serial " +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: FAIL — «has no serials without a block of the snapshot's prefix and box extension, of this pairing, with room».

М6 — берётся самый поздний блок. В `apps/standalone/src/floor/work/box-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "ORDER BY from_serial, block_id LIMIT 1",
```

заменить на:

<!-- prettier-ignore -->
```ts
      "ORDER BY from_serial DESC, block_id LIMIT 1",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: FAIL — «takes the next serial of the earliest block with room, with its record in the same write».

М7 — берётся блок любого префикса. В `apps/standalone/src/floor/work/box-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "AND issuer_prefix = ? AND extension = ? AND next_serial <= to_serial " +
```

заменить на:

<!-- prettier-ignore -->
```ts
      "AND issuer_prefix <> 'x' || ? AND extension = ? AND next_serial <= to_serial " +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: FAIL — «has no serials without a block of the snapshot's prefix and box extension, of this pairing, with room».

М8 — добавки поздних планов — отдельной транзакцией. В `apps/standalone/src/floor/work/box-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
    outboxStatement(record, pairing, closing.closedAt),
    ...additions.flatMap((addition) => addition.statements),
  ]);
```

заменить на:

<!-- prettier-ignore -->
```ts
    outboxStatement(record, pairing, closing.closedAt),
  ]);
  for (const addition of additions) if (addition.statements.length > 0) await context.local.transaction(addition.statements);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: FAIL — «commits what a later plan adds with the close, or nothing at all».

М9 — поля добавки не попадают в запись. В `apps/standalone/src/floor/work/box-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
    {
      ...added,
      boxId: closing.boxId,
```

заменить на:

<!-- prettier-ignore -->
```ts
    {
      boxId: closing.boxId,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: FAIL — «refuses a field the record does not know, and writes nothing».

М10 — короб закрывается только сверх вместимости. В `apps/standalone/src/floor/work/box-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (box === null || box.itemCount < context.shift.copy.boxCapacity) return null;
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (box === null || box.itemCount <= context.shift.copy.boxCapacity) return null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: FAIL — «closes once it holds the shift's box capacity, and not one code before».

М11 — короб закрывается на код раньше. В `apps/standalone/src/floor/work/box-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (box === null || box.itemCount < context.shift.copy.boxCapacity) return null;
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (box === null || box.itemCount < context.shift.copy.boxCapacity - 1) return null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: FAIL — «closes once it holds the shift's box capacity, and not one code before».

М12 — номер вне ёмкости префикса не списывается. В `apps/standalone/src/floor/work/box-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
    const spent = await commit(context, [spendSerial(block.block_id, block.next_serial)]);
    return spent === "stale" ? { kind: "stale" } : { kind: "invalid_serial" };
```

заменить на:

<!-- prettier-ignore -->
```ts
    const spent = "done";
    return spent === "stale" ? { kind: "stale" } : { kind: "invalid_serial" };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: FAIL — «loses a serial past the prefix's range, keeps the box open, and takes the next one after».

М13 — поля добавки перекрывают поля записи. В `apps/standalone/src/floor/work/box-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
      membershipDigest: boxMembershipDigestV1(closing.codeHashes),
    },
```

заменить на:

<!-- prettier-ignore -->
```ts
      membershipDigest: boxMembershipDigestV1(closing.codeHashes),
      ...added,
    },
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-close.test.ts`
Expected: FAIL — «commits what a later plan adds with the close, or nothing at all».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/work/box-close.ts apps/standalone/test/floor-box-close.test.ts apps/standalone/test/support/floor-work.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/work/box-close.ts apps/standalone/test/floor-box-close.test.ts apps/standalone/test/support/floor-work.ts
git commit -m "feat(standalone): a box closes with the next serial of its block, compared on the cursor" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Дозаказ блоков SSCC — правило «половина», запрос хранится до ответа

`createBlockSupply` (решение 9, §5.7.4): блок нужен, если у подключения нет блока префикса снимка или в самом новом (наибольший `from_serial`) осталось меньше половины; новый запрос создаётся только при связи и пишется в `floor_block_requests` до отправки; ждущий запрос повторяется целиком (тот же `requestId`, префикс и расширение), даже если блок уже не нужен; блок сохраняется той же транзакцией, что удаляет запрос, и только под префиксом и расширением запроса — иной ответ не сохраняется, а запрос выбрасывается. `validation_failed` на `requestId` (тот же `id` с другим префиксом, финальная волна 2a1) — запрос выбрасывается и уходит новый, один раз; любой `validation_failed` и `sscc_exhausted` выбрасывают запрос; отказ ключа — в оболочку. Дозаказы идут по одному: вызов во время идущего получает его результат. `remainingSerials` — остаток номеров подключения для префикса (строка состояния).

**Files:**

- Create: `apps/standalone/src/floor/work/block-supply.ts`
- Test: `apps/standalone/test/floor-block-supply.test.ts` (Create)

**Interfaces:**

- Consumes: `HostError` (`src/host/client.ts`); `SsccBlock`, `SsccBlockRequest` (задача 1); `BOX_EXTENSION` (задача 4); таблицы `floor_sscc_blocks`, `floor_block_requests`.
- Produces:
  - `src/floor/work/block-supply.ts`: `interface BlockContext { local; pairing; issuerPrefix; online; requestBlock; onHostError; now; newId }`, `type SupplyResult` (`enough`, `stored { blockId }`, `offline`, `exhausted`, `failed`), `remainingSerials(local, pairing, issuerPrefix, extension?)`, `createBlockSupply(context): { topUp: () => Promise<SupplyResult> }`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-block-supply.test.ts`:

<!-- prettier-ignore -->
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBlockSupply,
  remainingSerials,
  type BlockContext,
} from "../src/floor/work/block-supply.js";
import { HostError } from "../src/host/client.js";
import type { SsccBlock, SsccBlockRequest } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import {
  countingIds,
  PAIRING,
  PREFIX,
  rows,
  seedBlock,
  steppingClock,
} from "./support/floor-work.js";
import { openLocalDb, openLocalDbFile } from "./support/local-db.js";

const BLOCK_ID = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const FIRST_REQUEST = "00000000-0000-4000-8000-000000000001";
const SECOND_REQUEST = "00000000-0000-4000-8000-000000000002";

function blockFor(request: SsccBlockRequest, fromSerial = 3500): SsccBlock {
  return {
    id: BLOCK_ID,
    issuerPrefix: request.issuerPrefix,
    extension: request.extension,
    fromSerial,
    toSerial: fromSerial + 1999,
  };
}

function supplyContext(local: LocalExecutor, overrides: Partial<BlockContext> = {}): BlockContext {
  return {
    local,
    pairing: PAIRING,
    issuerPrefix: PREFIX,
    online: () => true,
    requestBlock: vi.fn(async (request: SsccBlockRequest) => blockFor(request)),
    onHostError: vi.fn(),
    now: steppingClock(),
    newId: countingIds(),
    ...overrides,
  };
}

function requests(db: DatabaseSync) {
  return rows(db, "SELECT request_id, issuer_prefix, extension FROM floor_block_requests");
}

function refusal(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 400, message: code, details });
}

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the supply of SSCC serials", () => {
  it("asks for a block when it has none, keeping the request before it asks and the block with its removal", async () => {
    const { db, executor } = openLocalDb();
    const kept: Record<string, unknown>[][] = [];
    const requestBlock = vi.fn(async (request: SsccBlockRequest) => {
      kept.push(requests(db));
      return blockFor(request);
    });
    const supply = createBlockSupply(supplyContext(executor, { requestBlock }));
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    expect(requestBlock.mock.calls).toEqual([
      [{ requestId: FIRST_REQUEST, issuerPrefix: PREFIX, extension: 0 }],
    ]);
    expect(kept).toEqual([[{ request_id: FIRST_REQUEST, issuer_prefix: PREFIX, extension: 0 }]]);
    expect(requests(db)).toEqual([]);
    expect(
      rows(
        db,
        "SELECT block_id, issuer_prefix, extension, from_serial, to_serial, next_serial FROM floor_sscc_blocks",
      ),
    ).toEqual([
      {
        block_id: BLOCK_ID,
        issuer_prefix: PREFIX,
        extension: 0,
        from_serial: 3500,
        to_serial: 5499,
        next_serial: 3500,
      },
    ]);
    await expect(remainingSerials(executor, PAIRING, PREFIX)).resolves.toBe(2000);
  });

  it("asks once the newest block has less than half left, and not at half", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b", from: 1, to: 2000, next: 1 });
    seedBlock(db, {
      blockId: "7f6e5d4c-3b2a-4f1e-8d9c-8b7a6f5e4d3c",
      from: 2001,
      to: 4000,
      next: 3001,
    });
    const context = supplyContext(executor);
    const supply = createBlockSupply(context);
    await expect(supply.topUp()).resolves.toEqual({ kind: "enough" });
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 3002 WHERE from_serial = 2001").run();
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    expect(context.requestBlock).toHaveBeenCalledTimes(1);
    await expect(remainingSerials(executor, PAIRING, PREFIX)).resolves.toBe(2000 + 999 + 2000);
  });

  it("counts the serials of this pairing's blocks of the prefix and extension only", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b", from: 1, to: 10, next: 4 });
    seedBlock(db, { blockId: "7f6e5d4c-3b2a-4f1e-8d9c-8b7a6f5e4d3c", from: 11, to: 20, next: 21 });
    seedBlock(db, {
      blockId: "8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d",
      from: 0,
      to: 99,
      extension: 1,
    });
    seedBlock(db, {
      blockId: "9b8c7d6e-5f4a-4b3c-9d2e-1f0a9b8c7d6e",
      from: 0,
      to: 99,
      prefix: "460068201",
    });
    seedBlock(db, {
      blockId: "0c9d8e7f-6a5b-4c4d-8e3f-2a1b0c9d8e7f",
      from: 0,
      to: 99,
      deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f",
    });
    await expect(remainingSerials(executor, PAIRING, PREFIX)).resolves.toBe(7);
  });

  it("asks nothing while offline, and keeps no request for it", async () => {
    const { db, executor } = openLocalDb();
    const context = supplyContext(executor, { online: () => false });
    await expect(createBlockSupply(context).topUp()).resolves.toEqual({ kind: "offline" });
    expect(context.requestBlock).not.toHaveBeenCalled();
    expect(requests(db)).toEqual([]);
  });

  it("repeats the same request after a failure, even when no block is wanted any more", async () => {
    const { db, executor } = openLocalDb();
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const requestBlock = vi
      .fn<(request: SsccBlockRequest) => Promise<SsccBlock>>()
      .mockRejectedValueOnce(down)
      .mockImplementation(async (request) => blockFor(request));
    const context = supplyContext(executor, { requestBlock });
    const supply = createBlockSupply(context);
    await expect(supply.topUp()).resolves.toEqual({ kind: "failed" });
    expect(context.onHostError).toHaveBeenCalledWith(down);
    expect(requests(db)).toEqual([
      { request_id: FIRST_REQUEST, issuer_prefix: PREFIX, extension: 0 },
    ]);
    seedBlock(db, { blockId: "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b", from: 1, to: 2000 });
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    expect(requestBlock.mock.calls.map(([request]) => request.requestId)).toEqual([
      FIRST_REQUEST,
      FIRST_REQUEST,
    ]);
    expect(requests(db)).toEqual([]);
  });

  it("repeats the same request after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markiro-supply-"));
    temporary.push(dir);
    const path = join(dir, "station.db");
    const before = openLocalDbFile(path);
    const lost = vi.fn(async (): Promise<SsccBlock> => {
      throw new HostError({ kind: "transport", code: "unreachable", message: "down" });
    });
    await createBlockSupply(supplyContext(before.executor, { requestBlock: lost })).topUp();
    before.db.close();
    const after = openLocalDbFile(path);
    const context = supplyContext(after.executor, { newId: () => crypto.randomUUID() });
    await expect(createBlockSupply(context).topUp()).resolves.toMatchObject({ kind: "stored" });
    expect(context.requestBlock).toHaveBeenCalledWith({
      requestId: FIRST_REQUEST,
      issuerPrefix: PREFIX,
      extension: 0,
    });
    after.db.close();
  });

  it("drops a request the host refuses as another prefix's and sends a new one, once", async () => {
    const { db, executor } = openLocalDb();
    const requestBlock = vi
      .fn<(request: SsccBlockRequest) => Promise<SsccBlock>>()
      .mockRejectedValueOnce(refusal("validation_failed", { field: "requestId" }))
      .mockImplementation(async (request) => blockFor(request));
    const supply = createBlockSupply(supplyContext(executor, { requestBlock }));
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    expect(requestBlock.mock.calls.map(([request]) => request.requestId)).toEqual([
      FIRST_REQUEST,
      SECOND_REQUEST,
    ]);
    expect(requests(db)).toEqual([]);
    // Refuses every request twice over, then answers: a top-up that asked
    // again and again would end with a block instead of hanging.
    const refusing = vi
      .fn<(request: SsccBlockRequest) => Promise<SsccBlock>>()
      .mockRejectedValueOnce(refusal("validation_failed", { field: "requestId" }))
      .mockRejectedValueOnce(refusal("validation_failed", { field: "requestId" }))
      .mockImplementation(async (request) => blockFor(request));
    db.prepare("DELETE FROM floor_sscc_blocks").run();
    await expect(
      createBlockSupply(supplyContext(executor, { requestBlock: refusing })).topUp(),
    ).resolves.toEqual({ kind: "failed" });
    expect(refusing).toHaveBeenCalledTimes(2);
    expect(requests(db)).toEqual([]);
  });

  it("drops the request when the host has no serials left for the prefix", async () => {
    const { db, executor } = openLocalDb();
    const requestBlock = vi.fn(async (): Promise<SsccBlock> => {
      throw new HostError({
        kind: "api",
        code: "sscc_exhausted",
        status: 409,
        message: "exhausted",
        details: { issuerPrefix: PREFIX, extension: 0 },
      });
    });
    await expect(
      createBlockSupply(supplyContext(executor, { requestBlock })).topUp(),
    ).resolves.toEqual({ kind: "exhausted" });
    expect(requests(db)).toEqual([]);
  });

  it("keeps no block of another prefix or extension than it asked for", async () => {
    const { db, executor } = openLocalDb();
    for (const other of [
      (request: SsccBlockRequest) => ({ ...blockFor(request), issuerPrefix: "460068201" }),
      (request: SsccBlockRequest) => ({ ...blockFor(request), extension: 1 }),
      (request: SsccBlockRequest) => ({ ...blockFor(request), toSerial: 3499 }),
    ]) {
      const supply = createBlockSupply(
        supplyContext(executor, {
          requestBlock: async (request) => other(request),
          newId: () => crypto.randomUUID(),
        }),
      );
      await expect(supply.topUp()).resolves.toEqual({ kind: "failed" });
    }
    expect(rows(db, "SELECT count(*) AS n FROM floor_sscc_blocks")).toEqual([{ n: 0 }]);
    expect(requests(db)).toEqual([]);
  });

  it("hands a refused key to the shell", async () => {
    const { executor } = openLocalDb();
    const refused = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    const context = supplyContext(executor, {
      requestBlock: async () => {
        throw refused;
      },
    });
    await expect(createBlockSupply(context).topUp()).resolves.toEqual({ kind: "failed" });
    expect(context.onHostError).toHaveBeenCalledWith(refused);
  });

  it("runs one top-up at a time: a second call while one runs shares it", async () => {
    const { db, executor } = openLocalDb();
    let answer: () => void = () => undefined;
    const requestBlock = vi.fn(
      (request: SsccBlockRequest) =>
        new Promise<SsccBlock>((resolve) => {
          answer = () => resolve(blockFor(request));
        }),
    );
    const supply = createBlockSupply(supplyContext(executor, { requestBlock }));
    const first = supply.topUp();
    const second = supply.topUp();
    await vi.waitFor(() => expect(requestBlock).toHaveBeenCalledTimes(1));
    answer();
    await expect(first).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    await expect(second).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    expect(requestBlock).toHaveBeenCalledTimes(1);
    expect(rows(db, "SELECT count(*) AS n FROM floor_sscc_blocks")).toEqual([{ n: 1 }]);
    await expect(supply.topUp()).resolves.toEqual({ kind: "enough" });
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: FAIL — `test/floor-block-supply.test.ts` не загружается: `Failed to resolve import "../src/floor/work/block-supply.js"`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/floor/work/block-supply.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import { HostError } from "../../host/client.js";
import type { SsccBlock, SsccBlockRequest } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { BOX_EXTENSION } from "./box-close.js";

export interface BlockContext {
  local: LocalExecutor;
  pairing: Pairing;
  /** The shift's snapshot's issuer prefix: the blocks of a box are of it. */
  issuerPrefix: string;
  /** The link is `online` right now: only then is the host asked. */
  online: () => boolean;
  /** `HostApi.requestSsccBlock`. */
  requestBlock: (request: SsccBlockRequest) => Promise<SsccBlock>;
  /** A failed host call the shell may act on: a refused key, another certificate. */
  onHostError: (error: unknown) => void;
  now: () => Date;
  newId: () => string;
}

/**
 * How a top-up went: `enough` — the newest block still has half its serials,
 * nothing asked; `stored` — a block arrived and is kept; `offline` — a block
 * is needed (or a request waits) and the link is not online; `exhausted` —
 * the host has no serials left for the prefix; `failed` — no answer, or one
 * this station does not keep: a request the host may have answered stays in
 * `floor_block_requests` and is repeated as it is, next time.
 */
export type SupplyResult =
  | { kind: "enough" }
  | { kind: "stored"; blockId: string }
  | { kind: "offline" }
  | { kind: "exhausted" }
  | { kind: "failed" };

const remainingRow = z.object({ n: z.number().int().nonnegative() });

/** The serials this pairing still has for the prefix and the extension, in all its blocks. */
export async function remainingSerials(
  local: LocalExecutor,
  pairing: Pairing,
  issuerPrefix: string,
  extension: number = BOX_EXTENSION,
): Promise<number> {
  const [row] = await local.query(
    "SELECT coalesce(sum(to_serial + 1 - next_serial), 0) AS n FROM floor_sscc_blocks " +
      "WHERE host_id = ? AND device_id = ? AND issuer_prefix = ? AND extension = ?",
    [pairing.hostId, pairing.deviceId, issuerPrefix, extension],
    remainingRow,
  );
  return row?.n ?? 0;
}

const newestRow = z.object({
  from_serial: z.number().int(),
  to_serial: z.number().int(),
  next_serial: z.number().int(),
});
const requestRow = z.object({
  request_id: z.string(),
  issuer_prefix: z.string(),
  extension: z.number().int(),
});

/**
 * The half rule (stage 2a spec §5.7.4, decision 9): a block is wanted when
 * the station has none for the prefix, or the newest has less than half of
 * its serials left.
 */
async function blockWanted(context: BlockContext): Promise<boolean> {
  const { local, pairing, issuerPrefix } = context;
  const [newest] = await local.query(
    "SELECT from_serial, to_serial, next_serial FROM floor_sscc_blocks " +
      "WHERE host_id = ? AND device_id = ? AND issuer_prefix = ? AND extension = ? " +
      "ORDER BY from_serial DESC LIMIT 1",
    [pairing.hostId, pairing.deviceId, issuerPrefix, BOX_EXTENSION],
    newestRow,
  );
  if (newest === undefined) return true;
  const size = newest.to_serial - newest.from_serial + 1;
  const left = newest.to_serial + 1 - newest.next_serial;
  return left * 2 < size;
}

/** The request this pairing keeps for the prefix and has no answer to, oldest first. */
async function waitingRequest(context: BlockContext): Promise<SsccBlockRequest | null> {
  const { local, pairing, issuerPrefix } = context;
  const [row] = await local.query(
    "SELECT request_id, issuer_prefix, extension FROM floor_block_requests " +
      "WHERE host_id = ? AND device_id = ? AND issuer_prefix = ? AND extension = ? " +
      "ORDER BY requested_at, request_id LIMIT 1",
    [pairing.hostId, pairing.deviceId, issuerPrefix, BOX_EXTENSION],
    requestRow,
  );
  return row === undefined
    ? null
    : { requestId: row.request_id, issuerPrefix: row.issuer_prefix, extension: row.extension };
}

/** A new request, kept before it is sent: a retry after a failure or a restart repeats it. */
async function keepRequest(context: BlockContext): Promise<SsccBlockRequest> {
  const request: SsccBlockRequest = {
    requestId: context.newId(),
    issuerPrefix: context.issuerPrefix,
    extension: BOX_EXTENSION,
  };
  await context.local.transaction([
    {
      sql:
        "INSERT INTO floor_block_requests (request_id, host_id, device_id, issuer_prefix, " +
        "extension, requested_at) VALUES (?, ?, ?, ?, ?, ?)",
      values: [
        request.requestId,
        context.pairing.hostId,
        context.pairing.deviceId,
        request.issuerPrefix,
        request.extension,
        context.now().toISOString(),
      ],
      expectedChanges: 1,
    },
  ]);
  return request;
}

async function dropRequest(context: BlockContext, requestId: string): Promise<void> {
  await context.local.transaction([
    { sql: "DELETE FROM floor_block_requests WHERE request_id = ?", values: [requestId] },
  ]);
}

/**
 * The block, kept in the transaction that removes its request: a request is
 * never gone without its block, and a block is filed only under the prefix
 * and extension the request named.
 */
async function storeBlock(
  context: BlockContext,
  request: SsccBlockRequest,
  block: SsccBlock,
): Promise<void> {
  await context.local.transaction([
    {
      sql:
        "INSERT INTO floor_sscc_blocks (block_id, host_id, device_id, issuer_prefix, extension, " +
        "from_serial, to_serial, next_serial, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (block_id) DO NOTHING",
      values: [
        block.id,
        context.pairing.hostId,
        context.pairing.deviceId,
        request.issuerPrefix,
        request.extension,
        block.fromSerial,
        block.toSerial,
        block.fromSerial,
        context.now().toISOString(),
      ],
    },
    {
      sql: "DELETE FROM floor_block_requests WHERE request_id = ?",
      values: [request.requestId],
      expectedChanges: 1,
    },
  ]);
}

/**
 * The supply of SSCC serials for a shift's boxes (stage 2a spec §5.7.4): when
 * the work screen opens, after every close and when the link comes back, a
 * block is asked for by the half rule, while the link is online. A request
 * is kept before it is sent and repeated whole until its block is kept, so
 * the host never issues a second block for one need. One top-up runs at a
 * time; a call while one runs shares it. A request the host refuses as
 * another prefix's (`validation_failed` on `requestId`, plan 2a1's final
 * wave) is dropped and a new one sent, once; `sscc_exhausted` drops it. A
 * failed write of this computer rejects.
 */
export function createBlockSupply(context: BlockContext): { topUp: () => Promise<SupplyResult> } {
  const attempt = async (fresh: boolean): Promise<SupplyResult> => {
    const waiting = await waitingRequest(context);
    if (waiting === null && !(await blockWanted(context))) return { kind: "enough" };
    if (!context.online()) return { kind: "offline" };
    const request = waiting ?? (await keepRequest(context));
    let block: SsccBlock;
    try {
      block = await context.requestBlock(request);
    } catch (error) {
      if (error instanceof HostError && error.kind === "api") {
        if (error.code === "sscc_exhausted") {
          await dropRequest(context, request.requestId);
          return { kind: "exhausted" };
        }
        if (error.code === "validation_failed") {
          // The host will never answer this request otherwise.
          await dropRequest(context, request.requestId);
          if (error.field === "requestId" && fresh) return attempt(false);
          return { kind: "failed" };
        }
      }
      context.onHostError(error);
      return { kind: "failed" };
    }
    if (
      block.issuerPrefix !== request.issuerPrefix ||
      block.extension !== request.extension ||
      block.toSerial < block.fromSerial
    ) {
      // Not the block asked for: never filed, and never asked for again.
      await dropRequest(context, request.requestId);
      return { kind: "failed" };
    }
    await storeBlock(context, request, block);
    return { kind: "stored", blockId: block.id };
  };
  let running: Promise<SupplyResult> | null = null;
  return {
    topUp: () => {
      if (running !== null) return running;
      const run = attempt(true).finally(() => {
        running = null;
      });
      running = run;
      return run;
    },
  };
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  11 passed (11)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  92 passed (92)`, `Tests  2284 passed (2284)` (на настоящем дереве — больше на тесты, которых на копии нет).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — ровно половина считается мало. В `apps/standalone/src/floor/work/block-supply.ts` фрагмент

<!-- prettier-ignore -->
```ts
  return left * 2 < size;
```

заменить на:

<!-- prettier-ignore -->
```ts
  return left * 2 <= size;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: FAIL — «asks once the newest block has less than half left, and not at half».

М2 — правило «половина» по самому старому блоку. В `apps/standalone/src/floor/work/block-supply.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "ORDER BY from_serial DESC LIMIT 1",
```

заменить на:

<!-- prettier-ignore -->
```ts
      "ORDER BY from_serial LIMIT 1",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: FAIL — «asks once the newest block has less than half left, and not at half».

М3 — запрос без связи. В `apps/standalone/src/floor/work/block-supply.ts` фрагмент

<!-- prettier-ignore -->
```ts
    if (!context.online()) return { kind: "offline" };
    const request = waiting ?? (await keepRequest(context));
```

заменить на:

<!-- prettier-ignore -->
```ts
    const request = waiting ?? (await keepRequest(context));
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: FAIL — «asks nothing while offline, and keeps no request for it».

М4 — новые запросы после отказа без предела. В `apps/standalone/src/floor/work/block-supply.ts` фрагмент

<!-- prettier-ignore -->
```ts
          if (error.field === "requestId" && fresh) return attempt(false);
```

заменить на:

<!-- prettier-ignore -->
```ts
          if (error.field === "requestId") return attempt(false);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: FAIL — «drops a request the host refuses as another prefix's and sends a new one, once».

М5 — нового запроса после отказа нет. В `apps/standalone/src/floor/work/block-supply.ts` фрагмент

<!-- prettier-ignore -->
```ts
          if (error.field === "requestId" && fresh) return attempt(false);
```

заменить на:

<!-- prettier-ignore -->
```ts
          if (error.field === "requestId" && fresh) return { kind: "failed" };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: FAIL — «drops a request the host refuses as another prefix's and sends a new one, once».

М6 — запрос не выбрасывается при `sscc_exhausted`. В `apps/standalone/src/floor/work/block-supply.ts` фрагмент

<!-- prettier-ignore -->
```ts
        if (error.code === "sscc_exhausted") {
          await dropRequest(context, request.requestId);
```

заменить на:

<!-- prettier-ignore -->
```ts
        if (error.code === "sscc_exhausted") {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: FAIL — «drops the request when the host has no serials left for the prefix».

М7 — блок чужого префикса сохраняется. В `apps/standalone/src/floor/work/block-supply.ts` фрагмент

<!-- prettier-ignore -->
```ts
      block.issuerPrefix !== request.issuerPrefix ||
      block.extension !== request.extension ||
```

заменить на:

<!-- prettier-ignore -->
```ts
      block.extension !== request.extension ||
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: FAIL — «keeps no block of another prefix or extension than it asked for».

М8 — блок чужого расширения сохраняется. В `apps/standalone/src/floor/work/block-supply.ts` фрагмент

<!-- prettier-ignore -->
```ts
      block.extension !== request.extension ||
      block.toSerial < block.fromSerial
```

заменить на:

<!-- prettier-ignore -->
```ts
      block.toSerial < block.fromSerial
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: FAIL — «keeps no block of another prefix or extension than it asked for».

М9 — два дозаказа идут одновременно. В `apps/standalone/src/floor/work/block-supply.ts` фрагмент

<!-- prettier-ignore -->
```ts
      if (running !== null) return running;
      const run = attempt(true).finally(() => {
```

заменить на:

<!-- prettier-ignore -->
```ts
      const run = attempt(true).finally(() => {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: FAIL — «runs one top-up at a time: a second call while one runs shares it».

М10 — ждущий запрос не повторяется. В `apps/standalone/src/floor/work/block-supply.ts` фрагмент

<!-- prettier-ignore -->
```ts
    const request = waiting ?? (await keepRequest(context));
```

заменить на:

<!-- prettier-ignore -->
```ts
    const request = await keepRequest(context);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: FAIL — «repeats the same request after a failure, even when no block is wanted any more», «repeats the same request after a restart».

М11 — запрос пишется после отправки. В `apps/standalone/src/floor/work/block-supply.ts` фрагмент

<!-- prettier-ignore -->
```ts
    const request = waiting ?? (await keepRequest(context));
    let block: SsccBlock;
    try {
      block = await context.requestBlock(request);
```

заменить на:

<!-- prettier-ignore -->
```ts
    const request = waiting ?? { requestId: context.newId(), issuerPrefix: context.issuerPrefix, extension: 0 };
    let block: SsccBlock;
    try {
      block = await context.requestBlock(request);
      if (waiting === null) await keepRequest(context);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: FAIL — «asks for a block when it has none, keeping the request before it asks and the block with its removal».

М12 — запрос не удаляется вместе с сохранением блока. В `apps/standalone/src/floor/work/block-supply.ts` фрагмент

<!-- prettier-ignore -->
```ts
      sql: "DELETE FROM floor_block_requests WHERE request_id = ?",
      values: [request.requestId],
      expectedChanges: 1,
```

заменить на:

<!-- prettier-ignore -->
```ts
      sql: "DELETE FROM floor_block_requests WHERE request_id = 'x' AND ? IS NOT NULL",
      values: [request.requestId],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: FAIL — «asks for a block when it has none, keeping the request before it asks and the block with its removal».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/work/block-supply.ts apps/standalone/test/floor-block-supply.test.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/work/block-supply.ts apps/standalone/test/floor-block-supply.test.ts
git commit -m "feat(standalone): SSCC blocks by the half rule, a request kept until its block" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Доставка фактов — пачки с квитанциями, планировщик в `useHostLink`, версия и сбой доставки в оболочке

`sendFactBatch` (§5.5): самые старые записи подключения без квитанции, до 100, по `seq`, как хранятся; каждая отправка считается в `attempts`; квитанции сверяются с записями по числу и месту (`id` записи или `null` — по месту), иначе `ReceiptMismatchError` и ничего не записано; применяются одной транзакцией через `json_each`: исход, код, подробности, время; `conflict` скана ставит `floor_scans.conflict` и `needs_fix` его короба; отклонённая запись остаётся с кодом и под тем же `id` больше не уходит. `useHostLink` получает `sendFacts` и ещё один планировщик: после подписки, после событий ревизии, по просьбе экрана (`requestFacts`), сразу после полной пачки, после сбоя — паузами синхронизации, пока связь `online`, и сразу при её возвращении; отказ ключа останавливает связь. Хук возвращает `{ requestSync, requestFacts }`. Оболочка: `outboxVersion` (действие `outbox_changed`) и `factsFailure` (`facts_failed` с причиной `offline`/`host`/`local`, `facts_sent`).

**Files:**

- Create: `apps/standalone/src/local/facts-sender.ts`
- Modify: `apps/standalone/src/app/App.tsx`, `apps/standalone/src/app/host-link.ts`, `apps/standalone/src/app/shell.ts`
- Test: `apps/standalone/test/facts-sender.test.ts` (Create), `apps/standalone/test/host-link-facts.test.ts` (Create), `apps/standalone/test/app.test.tsx` (Modify), `apps/standalone/test/host-link-shifts.test.ts` (Modify), `apps/standalone/test/shell.test.ts` (Modify), `apps/standalone/test/support/floor-work.ts` (Modify)

**Interfaces:**

- Consumes: `MAX_FACT_BATCH`, `FactReceipt` (задача 1); `createSyncScheduler`, `nextSyncRetryMs`, `shellActionFor` (`src/app/host-link.ts`, `src/local/reference-sync.ts`, `src/app/shell.ts`); `HostError`, `LocalDbError`; таблицы `outbox`, `floor_scans`, `floor_boxes`.
- Produces:
  - `src/local/facts-sender.ts`: `class ReceiptMismatchError`, `interface SendResult { sent; more }`, `sendFactBatch(local, pairing, send, now): Promise<SendResult>`;
  - `src/app/host-link.ts`: `HostLinkOptions.sendFacts`, `interface HostLinkControls { requestSync; requestFacts }` (возвращает `useHostLink`), `factsFailureOf(error): FactsFailure`;
  - `src/app/shell.ts`: `type FactsFailure = "offline" | "host" | "local"`, `ShellState.outboxVersion: number`, `ShellState.factsFailure: FactsFailure | null`, действия `outbox_changed`, `facts_sent`, `facts_failed`;
  - `src/app/App.tsx`: `useHostLink({ …, sendFacts: hostApi.sendFacts })`;
  - `test/support/floor-work.ts`: `unsentScans(local, count, pairing?, firstId?)`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/app.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
          deviceShifts: async () => [],
          dispatch,
```

заменить на:

<!-- prettier-ignore -->
```tsx
          deviceShifts: async () => [],
          sendFacts: async () => [],
          dispatch,
```

Создать `apps/standalone/test/facts-sender.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import { processScan } from "../src/floor/work/scan-pipeline.js";
import { HostError } from "../src/host/client.js";
import type { FactReceipt } from "../src/host/protocol.js";
import { ReceiptMismatchError, sendFactBatch } from "../src/local/facts-sender.js";
import {
  enteredShift,
  km,
  PAIRING,
  rows,
  scanContext,
  steppingClock,
  unsentScans,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

const OTHER_PAIRING = { ...PAIRING, deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f" };
const WINNER = {
  shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  shiftNumber: "OCT26-003",
  deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
  scannedAt: "2026-10-08T05:58:41.090Z",
  sameDevice: false,
};

/** Accepts every record it is sent. */
function acceptingAll() {
  return vi.fn(async (records: readonly unknown[]): Promise<FactReceipt[]> =>
    records.map((record) => ({
      id: (record as { id: string }).id,
      outcome: "accepted" as const,
    })),
  );
}

function sentIds(send: ReturnType<typeof acceptingAll>, call: number): string[] {
  return (send.mock.calls[call]?.[0] ?? []).map((record) => (record as { id: string }).id);
}

describe("a batch of the outbox", () => {
  it("is this pairing's oldest records without a receipt, up to 100, in their order, as kept", async () => {
    const { db, executor } = openLocalDb();
    const ids = await unsentScans(executor, 102);
    await unsentScans(executor, 3, OTHER_PAIRING, 500);
    db.prepare(
      "UPDATE outbox SET outcome = 'accepted', acked_at = '2026-10-08T06:16:00.000Z' WHERE id = ?",
    ).run(ids[0] ?? "");
    const send = acceptingAll();
    const now = steppingClock();
    await expect(sendFactBatch(executor, PAIRING, send, now)).resolves.toEqual({
      sent: 100,
      more: true,
    });
    expect(sentIds(send, 0)).toEqual(ids.slice(1, 101));
    const [kept] = rows(db, "SELECT payload FROM outbox WHERE id = ?", ids[1] ?? "");
    expect(send.mock.calls[0]?.[0][0]).toEqual(JSON.parse(String(kept?.["payload"])));
    await expect(sendFactBatch(executor, PAIRING, send, now)).resolves.toEqual({
      sent: 1,
      more: false,
    });
    expect(sentIds(send, 1)).toEqual(ids.slice(101));
    await expect(sendFactBatch(executor, PAIRING, send, now)).resolves.toEqual({
      sent: 0,
      more: false,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")).toEqual([{ n: 3 }]);
  });

  it("counts every attempt and keeps no receipt when the send fails", async () => {
    const { db, executor } = openLocalDb();
    const [id] = await unsentScans(executor, 1);
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const failing = vi.fn(async (): Promise<FactReceipt[]> => {
      throw down;
    });
    const now = steppingClock();
    await expect(sendFactBatch(executor, PAIRING, failing, now)).rejects.toBe(down);
    expect(rows(db, "SELECT attempts, sent_at, outcome, acked_at FROM outbox")).toEqual([
      { attempts: 1, sent_at: "2026-10-08T06:15:00.000Z", outcome: null, acked_at: null },
    ]);
    await sendFactBatch(executor, PAIRING, acceptingAll(), now);
    expect(rows(db, "SELECT id, attempts, outcome, acked_at FROM outbox")).toEqual([
      { id, attempts: 2, outcome: "accepted", acked_at: "2026-10-08T06:15:02.000Z" },
    ]);
  });

  it("applies each receipt to its record in one write, by its id or, without one, by its place", async () => {
    const { db, executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const context = scanContext(executor, shift);
    await processScan(context, km("A1"));
    await processScan(context, km("A2"));
    await processScan(context, "MRK-000742");
    const records = rows(db, "SELECT id, kind FROM outbox ORDER BY seq");
    const [first, second, third] = records.map((row) => String(row["id"]));
    const send = vi.fn(async (): Promise<FactReceipt[]> => [
      { id: first ?? "", outcome: "accepted" },
      { id: second ?? "", outcome: "conflict", details: { winner: WINNER } },
      { id: null, outcome: "rejected", code: "invalid_record" },
    ]);
    await expect(sendFactBatch(executor, PAIRING, send, steppingClock())).resolves.toEqual({
      sent: 3,
      more: false,
    });
    expect(
      rows(
        db,
        "SELECT id, outcome, outcome_code, outcome_details, acked_at FROM outbox ORDER BY seq",
      ),
    ).toEqual([
      {
        id: first,
        outcome: "accepted",
        outcome_code: null,
        outcome_details: null,
        acked_at: "2026-10-08T06:15:01.000Z",
      },
      {
        id: second,
        outcome: "conflict",
        outcome_code: null,
        outcome_details: JSON.stringify({ winner: WINNER }),
        acked_at: "2026-10-08T06:15:01.000Z",
      },
      {
        id: third,
        outcome: "rejected",
        outcome_code: "invalid_record",
        outcome_details: null,
        acked_at: "2026-10-08T06:15:01.000Z",
      },
    ]);
    expect(rows(db, "SELECT id, conflict FROM floor_scans ORDER BY scanned_at")).toEqual([
      { id: first, conflict: 0 },
      { id: second, conflict: 1 },
      { id: third, conflict: 0 },
    ]);
    expect(rows(db, "SELECT needs_fix FROM floor_boxes")).toEqual([{ needs_fix: 1 }]);
    // A refused record is never sent again under its id: the host keeps its
    // refusal for good, and only a person sends it again, under a new id.
    await expect(sendFactBatch(executor, PAIRING, send, steppingClock())).resolves.toEqual({
      sent: 0,
      more: false,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps nothing when the receipts do not answer the records sent", async () => {
    const { db, executor } = openLocalDb();
    const [first, second] = await unsentScans(executor, 2);
    for (const answer of [
      [{ id: first ?? "", outcome: "accepted" as const }],
      [
        { id: second ?? "", outcome: "accepted" as const },
        { id: first ?? "", outcome: "accepted" as const },
      ],
      [
        { id: first ?? "", outcome: "accepted" as const },
        { id: second ?? "", outcome: "accepted" as const },
        { id: null, outcome: "accepted" as const },
      ],
    ]) {
      await expect(
        sendFactBatch(executor, PAIRING, async () => answer, steppingClock()),
      ).rejects.toBeInstanceOf(ReceiptMismatchError);
    }
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")).toEqual([{ n: 2 }]);
  });
});
```

Создать `apps/standalone/test/host-link-facts.test.ts`:

<!-- prettier-ignore -->
```ts
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { factsFailureOf, useHostLink } from "../src/app/host-link.js";
import type { ShellAction } from "../src/app/shell.js";
import { HostError } from "../src/host/client.js";
import type { ConnectionApi, ConnectionHandlers } from "../src/host/connection.js";
import { LocalDbError } from "../src/local/executor.js";
import { ReceiptMismatchError } from "../src/local/facts-sender.js";
import type {
  ChangesResponse,
  DeviceStatus,
  FactReceipt,
  HostStatus,
} from "../src/host/protocol.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { rows, unsentScans } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

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
  };
}

type Send = (records: readonly unknown[]) => Promise<FactReceipt[]>;

/** Accepts every record it is sent. */
async function acceptAll(records: readonly unknown[]): Promise<FactReceipt[]> {
  return records.map((record) => ({ id: (record as { id: string }).id, outcome: "accepted" }));
}

/** The link over a fresh database holding `waiting` unsent records before it starts. */
async function link(sendFacts: Send, hostId: string | null = HOST_ID, waiting = 0) {
  const { db, executor } = openLocalDb();
  if (waiting > 0) await unsentScans(executor, waiting);
  const connection = fakeConnection();
  const dispatch = vi.fn<(action: ShellAction) => void>();
  const changes = vi.fn(async (): Promise<ChangesResponse> => ({
    hostId: HOST_ID,
    rev: 1,
    hasMore: false,
    items: [],
  }));
  const refresh = vi.fn(async (): Promise<DeviceStatus> => DEVICE_STATUS);
  const send = vi.fn(sendFacts);
  const hook = renderHook(
    ({ host }) =>
      useHostLink({
        hostId: host,
        deviceId: host === null ? null : DEVICE_ID,
        connection: connection.connection,
        local: executor,
        changes,
        refresh,
        deviceShifts: async () => [],
        sendFacts: send,
        dispatch,
      }),
    { initialProps: { host: hostId } },
  );
  const changed = () =>
    dispatch.mock.calls.filter(([action]) => action.type === "outbox_changed").length;
  const deliveries = () =>
    dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "facts_sent" || action.type === "facts_failed");
  const unsent = () =>
    rows(db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")[0]?.["n"];
  return { db, local: executor, connection, dispatch, send, hook, changed, unsent, deliveries };
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

describe("the outbox on the link", () => {
  it("goes once the link is watched, a full batch asking for the next at once", async () => {
    const station = await link(acceptAll, HOST_ID, 150);
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send.mock.calls.map(([records]) => records.length)).toEqual([100, 50]);
    expect(station.changed()).toBe(2);
    station.hook.unmount();
  });

  it("goes when a screen asks after a local write, and asks nothing when there is nothing", async () => {
    const station = await link(acceptAll);
    await settle();
    expect(station.send).not.toHaveBeenCalled();
    await unsentScans(station.local, 1);
    station.hook.result.current.requestFacts();
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(1);
    expect(station.changed()).toBe(1);
    station.hook.unmount();
  });

  it("is sent again after 2 s, then 4 s, while the link is online", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const station = await link(
      async () => {
        throw down;
      },
      HOST_ID,
      1,
    );
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    // The clock also runs with real time: every check keeps 800 ms from the
    // retry it must not reach yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(station.send).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(station.send).toHaveBeenCalledTimes(2);
    station.send.mockImplementation(acceptAll);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(3);
    station.hook.unmount();
  });

  it("waits while the link is down, and goes at once when it is back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const station = await link(
      async () => {
        throw down;
      },
      HOST_ID,
      1,
    );
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    await station.connection.status(OFFLINE);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(station.send).toHaveBeenCalledTimes(1);
    station.send.mockImplementation(acceptAll);
    await station.connection.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(2);
    station.hook.unmount();
  });

  it("stops the link on a refused key: nothing more is sent", async () => {
    const refused = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    const station = await link(async () => {
      throw refused;
    });
    await unsentScans(station.local, 1);
    station.hook.result.current.requestFacts();
    await waitFor(() =>
      expect(station.dispatch).toHaveBeenCalledWith({
        type: "device_rejected",
        reason: "key_rejected",
      }),
    );
    station.hook.result.current.requestFacts();
    await settle();
    expect(station.send).toHaveBeenCalledTimes(1);
    expect(station.unsent()).toBe(1);
    station.hook.unmount();
  });

  it("sends nothing while the link is stopped", async () => {
    const station = await link(acceptAll, null);
    await unsentScans(station.local, 1);
    station.hook.result.current.requestFacts();
    await settle();
    expect(station.send).not.toHaveBeenCalled();
    station.hook.rerender({ host: HOST_ID });
    await waitFor(() => expect(station.unsent()).toBe(0));
    station.hook.rerender({ host: null });
    await unsentScans(station.local, 1, undefined, 10);
    station.hook.result.current.requestFacts();
    await settle();
    expect(station.send).toHaveBeenCalledTimes(1);
    station.hook.unmount();
  });

  it("says whether a failed send was the link's, the host's or this computer's, until one goes through", async () => {
    const station = await link(
      async () => {
        throw new HostError({ kind: "api", code: "internal", status: 500, message: "boom" });
      },
      HOST_ID,
      1,
    );
    await waitFor(() =>
      expect(station.deliveries()).toEqual([{ type: "facts_failed", failure: "host" }]),
    );
    station.send.mockImplementation(acceptAll);
    station.hook.result.current.requestFacts();
    await waitFor(() => expect(station.deliveries().at(-1)).toEqual({ type: "facts_sent" }));
    station.hook.unmount();
  });
});

describe("why a send of the outbox failed", () => {
  it("is the link's when the host was not reached, and the host's when it answered wrong", () => {
    for (const code of ["unreachable", "timeout"]) {
      expect(factsFailureOf(new HostError({ kind: "transport", code, message: code }))).toBe(
        "offline",
      );
    }
    for (const error of [
      new HostError({ kind: "api", code: "internal", status: 500, message: "boom" }),
      new HostError({ kind: "api", code: "payload_too_large", status: 413, message: "big" }),
      new HostError({ kind: "transport", code: "invalid_response", message: "garbled" }),
      new ReceiptMismatchError("1 receipt for 2 records"),
    ]) {
      expect(factsFailureOf(error)).toBe("host");
    }
    expect(factsFailureOf(new LocalDbError("statement_failed", "disk full"))).toBe("local");
  });
});
```

Правка `apps/standalone/test/host-link-shifts.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
        deviceShifts,
        dispatch,
```

заменить на:

<!-- prettier-ignore -->
```ts
        deviceShifts,
        sendFacts: async () => [],
        dispatch,
```

Правка `apps/standalone/test/shell.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
    device_not_saved: [{ action: { type: "device_not_saved" }, survives: true }],
  };
```

заменить на:

<!-- prettier-ignore -->
```ts
    device_not_saved: [{ action: { type: "device_not_saved" }, survives: true }],
    outbox_changed: [{ action: { type: "outbox_changed" }, survives: true }],
    facts_sent: [{ action: { type: "facts_sent" }, survives: true }],
    facts_failed: [{ action: { type: "facts_failed", failure: "host" }, survives: true }],
  };
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
      failed: false,
    });
  });
});
```

заменить на:

<!-- prettier-ignore -->
```ts
      failed: false,
    });
  });
});

describe("the outbox's delivery", () => {
  it("keeps why the last send failed until a send goes through", () => {
    const host = shellReducer(initialShellState, { type: "facts_failed", failure: "host" });
    const offline = shellReducer(host, { type: "facts_failed", failure: "offline" });
    const sent = shellReducer(offline, { type: "facts_sent" });
    expect([initialShellState.factsFailure, host.factsFailure, offline.factsFailure]).toEqual([
      null,
      "host",
      "offline",
    ]);
    expect(sent.factsFailure).toBeNull();
    expect(shellReducer(sent, { type: "outbox_changed" }).factsFailure).toBeNull();
  });
});

describe("the outbox's changes", () => {
  it("count up with every change, whatever the floor shows", () => {
    const once = shellReducer(initialShellState, { type: "outbox_changed" });
    const twice = shellReducer(once, { type: "outbox_changed" });
    expect([initialShellState.outboxVersion, once.outboxVersion, twice.outboxVersion]).toEqual([
      0, 1, 2,
    ]);
  });
});
```

Правка `apps/standalone/test/support/floor-work.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { vi } from "vitest";

import {
```

заменить на:

<!-- prettier-ignore -->
```ts
import { vi } from "vitest";

import { outboxStatement, scanRecord } from "../../src/floor/facts.js";
import {
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
    block.receivedAt ?? "2026-10-08T06:00:00.000Z",
  );
}
```

заменить на:

<!-- prettier-ignore -->
```ts
    block.receivedAt ?? "2026-10-08T06:00:00.000Z",
  );
}

/**
 * `count` records of unreadable scans in the outbox of `pairing`, ids
 * `…000001`, `…000002`, … in order, written as the floor writes them.
 */
export async function unsentScans(
  local: LocalExecutor,
  count: number,
  pairing: { hostId: string; deviceId: string } = PAIRING,
  firstId = 1,
): Promise<string[]> {
  const ids: string[] = [];
  const statements: LocalStatement[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `00000000-0000-4000-8000-${String(firstId + index).padStart(12, "0")}`;
    ids.push(id);
    statements.push(
      outboxStatement(
        scanRecord(
          { id, shiftId: SHIFT_ID, operatorId: OPERATOR_ID },
          {
            scannedAt: "2026-10-08T06:15:00.000Z",
            verdict: "invalid",
            duplicateSource: null,
            rawKind: "unknown",
            rawLength: 10,
            code: null,
            boxId: null,
          },
        ),
        pairing,
        "2026-10-08T06:15:00.000Z",
      ),
    );
    if (statements.length === 32 || index === count - 1) {
      await local.transaction(statements.splice(0));
    }
  }
  return ids;
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/facts-sender.test.ts test/host-link-facts.test.ts test/host-link-shifts.test.ts test/shell.test.ts`
Expected: FAIL — `facts-sender.test.ts` и `host-link-facts.test.ts` не загружаются (`Failed to resolve import "../src/local/facts-sender.js"`); в `shell.test.ts` 5 тестов: строки таблицы действий `outbox_changed`, `facts_sent`, `facts_failed`, `keeps why the last send failed until a send goes through`, `count up with every change, whatever the floor shows`; `app.test.tsx` и `host-link-shifts.test.ts` проходят (лишнее свойство `sendFacts` им не мешает).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/app/App.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
      : null;
  const requestSync = useHostLink({
    hostId: linked?.hostId ?? null,
```

заменить на:

<!-- prettier-ignore -->
```tsx
      : null;
  const { requestSync } = useHostLink({
    hostId: linked?.hostId ?? null,
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
    deviceShifts: hostApi.getDeviceShifts,
    dispatch,
```

заменить на:

<!-- prettier-ignore -->
```tsx
    deviceShifts: hostApi.getDeviceShifts,
    sendFacts: hostApi.sendFacts,
    dispatch,
```

Правка `apps/standalone/src/app/host-link.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { useCallback, useEffect, useRef } from "react";

import { HostError } from "../host/client.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { useCallback, useEffect, useMemo, useRef } from "react";

import { HostError } from "../host/client.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
import { DeviceError } from "../host/device.js";
import type { ChangesResponse, DeviceShift, DeviceStatus } from "../host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../local/executor.js";
import {
```

заменить на:

<!-- prettier-ignore -->
```ts
import { DeviceError } from "../host/device.js";
import type { ChangesResponse, DeviceShift, DeviceStatus, FactReceipt } from "../host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../local/executor.js";
import { sendFactBatch } from "../local/facts-sender.js";
import {
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
} from "../local/reference-sync.js";
import { deviceRejection, shellActionFor, type ShellAction, type SyncFailure } from "./shell.js";

/** The waits before the first retries of a failed sync, in milliseconds. */
```

заменить на:

<!-- prettier-ignore -->
```ts
} from "../local/reference-sync.js";
import {
  deviceRejection,
  shellActionFor,
  type FactsFailure,
  type ShellAction,
  type SyncFailure,
} from "./shell.js";

/** The waits before the first retries of a failed sync, in milliseconds. */
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
}

export interface HostLinkOptions {
```

заменить на:

<!-- prettier-ignore -->
```ts
}

/**
 * Why a send of the outbox failed, for the status bar: the host not reached
 * (any transport failure but an answer this build cannot read) is the link's
 * own state; an error the host answered, an answer that does not fit and
 * receipts that do not answer the records are the host's; a failed write of
 * the receipts is this computer's.
 */
export function factsFailureOf(error: unknown): FactsFailure {
  if (error instanceof HostError) {
    return error.kind === "transport" && error.code !== "invalid_response" ? "offline" : "host";
  }
  return error instanceof LocalDbError ? "local" : "host";
}

export interface HostLinkOptions {
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
  deviceShifts: () => Promise<DeviceShift[]>;
  dispatch: (action: ShellAction) => void;
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  deviceShifts: () => Promise<DeviceShift[]>;
  /** `HostApi.sendFacts`: the outbox's records to the host, a receipt for each. */
  sendFacts: (records: readonly unknown[]) => Promise<FactReceipt[]>;
  dispatch: (action: ShellAction) => void;
}

/** What the link offers the screens: a sync and both reads now, and the outbox's delivery now. */
export interface HostLinkControls {
  requestSync: () => void;
  /** Sends the outbox now (after a local write); nothing goes while the link is stopped. */
  requestFacts: () => void;
}
```

Фрагмент 6:

<!-- prettier-ignore -->
```ts
 * (`replaceShiftCopies`), and a failed read keeps the copies the station has.
 * Returns a function that asks for a sync and both reads now.
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
 * (`replaceShiftCopies`), and a failed read keeps the copies the station has.
 * The outbox goes to the host at the same moments (stage 2a spec §5.5), a
 * batch at a time (`sendFactBatch`), and whenever a screen asks after a local
 * write; a batch of 100 asks for the next at once; a failed send is retried
 * after `nextSyncRetryMs` with a count of its own while the link is online,
 * and at once when the link is back; a refused key ends the link as
 * everywhere. It lives exactly as long as the link: a refusal waiting for the
 * operator to leave the shift stops the link (`App`), and the delivery with
 * it. Returns the requests for a sync and for the delivery.
 */
```

Фрагмент 7:

<!-- prettier-ignore -->
```ts
  deviceShifts,
  dispatch,
}: HostLinkOptions): () => void {
  const syncNow = useRef<() => void>(() => undefined);
  useEffect(() => {
```

заменить на:

<!-- prettier-ignore -->
```ts
  deviceShifts,
  sendFacts,
  dispatch,
}: HostLinkOptions): HostLinkControls {
  const syncNow = useRef<() => void>(() => undefined);
  const factsNow = useRef<() => void>(() => undefined);
  useEffect(() => {
```

Фрагмент 8:

<!-- prettier-ignore -->
```ts
    };
    // Nothing more should reach a host that refused this device's key or
```

заменить на:

<!-- prettier-ignore -->
```ts
    };
    // And for sending the outbox.
    let factFailures = 0;
    let factRetry: ReturnType<typeof setTimeout> | null = null;
    const cancelFactRetry = () => {
      if (factRetry === null) return;
      clearTimeout(factRetry);
      factRetry = null;
    };
    // Nothing more should reach a host that refused this device's key or
```

Фрагмент 9:

<!-- prettier-ignore -->
```ts
      shiftReader.stop();
      cancelRetry();
      cancelRefreshRetry();
      cancelShiftRetry();
    };
```

заменить на:

<!-- prettier-ignore -->
```ts
      shiftReader.stop();
      factSender.stop();
      cancelRetry();
      cancelRefreshRetry();
      cancelShiftRetry();
      cancelFactRetry();
    };
```

Фрагмент 10:

<!-- prettier-ignore -->
```ts
    });
    const everything = () => {
      scheduler.trigger();
      refresher.trigger();
      shiftReader.trigger();
    };
    syncNow.current = everything;
    let unwatch: (() => void) | null = null;
```

заменить на:

<!-- prettier-ignore -->
```ts
    });
    // One batch of the outbox at a time, retried like the reads above. A
    // full batch asks for the next one at once; a refused key ends the link.
    const factSender = createSyncScheduler(async () => {
      if (!active) return;
      cancelFactRetry();
      try {
        const { sent, more } = await sendFactBatch(
          local,
          { hostId, deviceId },
          sendFacts,
          () => new Date(),
        );
        if (!active) return;
        factFailures = 0;
        dispatch({ type: "facts_sent" });
        if (sent > 0) dispatch({ type: "outbox_changed" });
        if (more) factSender.trigger();
      } catch (error) {
        if (!active) return;
        const action = shellActionFor(error, null);
        if (action) {
          stopAll();
          dispatch(action);
          return;
        }
        if (error instanceof HostError && error.code === "not_paired") return;
        dispatch({ type: "facts_failed", failure: factsFailureOf(error) });
        factFailures += 1;
        if (online) {
          factRetry = setTimeout(() => {
            factRetry = null;
            factSender.trigger();
          }, nextSyncRetryMs(factFailures));
        }
      }
    });
    const everything = () => {
      scheduler.trigger();
      refresher.trigger();
      shiftReader.trigger();
      factSender.trigger();
    };
    syncNow.current = everything;
    factsNow.current = () => factSender.trigger();
    let unwatch: (() => void) | null = null;
```

Фрагмент 11:

<!-- prettier-ignore -->
```ts
            cancelShiftRetry();
            return;
```

заменить на:

<!-- prettier-ignore -->
```ts
            cancelShiftRetry();
            cancelFactRetry();
            return;
```

Фрагмент 12:

<!-- prettier-ignore -->
```ts
          if (shiftFailures > 0 && shiftRetry === null) shiftReader.trigger();
        },
```

заменить на:

<!-- prettier-ignore -->
```ts
          if (shiftFailures > 0 && shiftRetry === null) shiftReader.trigger();
          if (factFailures > 0 && factRetry === null) factSender.trigger();
        },
```

Фрагмент 13:

<!-- prettier-ignore -->
```ts
      syncNow.current = () => undefined;
      stopAll();
      unwatch?.();
    };
  }, [hostId, deviceId, connection, local, changes, refresh, deviceShifts, dispatch]);
  return useCallback(() => syncNow.current(), []);
}
```

заменить на:

<!-- prettier-ignore -->
```ts
      syncNow.current = () => undefined;
      factsNow.current = () => undefined;
      stopAll();
      unwatch?.();
    };
  }, [hostId, deviceId, connection, local, changes, refresh, deviceShifts, sendFacts, dispatch]);
  const requestSync = useCallback(() => syncNow.current(), []);
  const requestFacts = useCallback(() => factsNow.current(), []);
  return useMemo(() => ({ requestSync, requestFacts }), [requestSync, requestFacts]);
}
```

Правка `apps/standalone/src/app/shell.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
export type SyncFailure = "host" | "local" | "feed";

/**
```

заменить на:

<!-- prettier-ignore -->
```ts
export type SyncFailure = "host" | "local" | "feed";

/**
 * Why the last send of the outbox failed: the host could not be reached
 * (`offline`); it answered with an error or with receipts that do not fit
 * (`host`: a 500, a 413, an answer this build cannot read); or this computer
 * could not keep its receipts (`local`). Either way nothing was kept and the
 * same batch goes again; the status bar names a failure that is not the
 * link's.
 */
export type FactsFailure = "offline" | "host" | "local";

/**
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  deviceNotSaved: boolean;
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  deviceNotSaved: boolean;
  /**
   * Grows with every change of the outbox: a record written by the floor, a
   * batch of receipts applied, a block of SSCC serials kept. The status bar
   * reads its counts again when it changes.
   */
  outboxVersion: number;
  /** Why the last send of the outbox failed, until a send goes through. */
  factsFailure: FactsFailure | null;
}
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  // `device_refresh` could not keep the host's answer in `device.json`.
  | { type: "device_not_saved" };

const CLOSED_OFFICE: OfficeState = { kind: "closed" };
```

заменить на:

<!-- prettier-ignore -->
```ts
  // `device_refresh` could not keep the host's answer in `device.json`.
  | { type: "device_not_saved" }
  // The floor wrote a record, the link applied receipts, a block was kept.
  | { type: "outbox_changed" }
  // A send of the outbox went through, or failed and why.
  | { type: "facts_sent" }
  | { type: "facts_failed"; failure: FactsFailure };

const CLOSED_OFFICE: OfficeState = { kind: "closed" };
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  deviceNotSaved: false,
};
```

заменить на:

<!-- prettier-ignore -->
```ts
  deviceNotSaved: false,
  outboxVersion: 0,
  factsFailure: null,
};
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
      return state.deviceNotSaved ? state : { ...state, deviceNotSaved: true };
  }
```

заменить на:

<!-- prettier-ignore -->
```ts
      return state.deviceNotSaved ? state : { ...state, deviceNotSaved: true };
    case "outbox_changed":
      return { ...state, outboxVersion: state.outboxVersion + 1 };
    case "facts_sent":
      return state.factsFailure === null ? state : { ...state, factsFailure: null };
    case "facts_failed":
      return state.factsFailure === action.failure
        ? state
        : { ...state, factsFailure: action.failure };
  }
```

Создать `apps/standalone/src/local/facts-sender.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import { MAX_FACT_BATCH, type FactReceipt } from "../host/protocol.js";
import type { LocalExecutor } from "./executor.js";
import type { Pairing } from "./reference-sync.js";

/** The host's receipts do not answer the records sent: no receipt is kept, and the batch goes again. */
export class ReceiptMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptMismatchError";
  }
}

const unsentRow = z.object({ id: z.string(), kind: z.string(), payload: z.string() });

/** What one run of the sender did: how many records got receipts, and whether more wait. */
export interface SendResult {
  sent: number;
  more: boolean;
}

/**
 * One batch of the outbox to the host (stage 2a spec §5.5, decision 11): this
 * pairing's oldest records without a receipt, up to 100, in their order, sent
 * as kept. Each send counts in `attempts` first. The receipts are checked
 * against the records — as many, each with its record's id or none (a record
 * the host could not read, matched by its place) — and applied in ONE
 * transaction through `json_each`: the outcome, its code and details, and
 * the time on every record; a `conflict` of a scan marks the scan and its
 * box for review (`floor_scans.conflict`, `floor_boxes.needs_fix`); a
 * `rejected` record stays in the outbox with its code, for the queue screen.
 * A failed send or an answer that does not fit rejects and keeps nothing:
 * the same batch goes again, and the host answers it with the same receipts.
 */
export async function sendFactBatch(
  local: LocalExecutor,
  pairing: Pairing,
  send: (records: readonly unknown[]) => Promise<FactReceipt[]>,
  now: () => Date,
): Promise<SendResult> {
  const { hostId, deviceId } = pairing;
  const unsent = await local.query(
    "SELECT id, kind, payload FROM outbox WHERE host_id = ? AND device_id = ? " +
      "AND acked_at IS NULL ORDER BY seq LIMIT ?",
    [hostId, deviceId, MAX_FACT_BATCH],
    unsentRow,
  );
  if (unsent.length === 0) return { sent: 0, more: false };
  const ids = JSON.stringify(unsent.map((row) => row.id));
  await local.transaction([
    {
      sql:
        "UPDATE outbox SET attempts = attempts + 1, sent_at = ? " +
        "WHERE host_id = ? AND device_id = ? AND id IN (SELECT value FROM json_each(?))",
      values: [now().toISOString(), hostId, deviceId, ids],
    },
  ]);
  const receipts = await send(unsent.map((row): unknown => JSON.parse(row.payload)));
  if (receipts.length !== unsent.length) {
    throw new ReceiptMismatchError(`${receipts.length} receipts for ${unsent.length} records`);
  }
  const applied = unsent.map((row, index) => {
    const receipt = receipts[index];
    if (receipt === undefined || (receipt.id !== null && receipt.id !== row.id)) {
      throw new ReceiptMismatchError(`receipt ${index} names another record`);
    }
    return {
      id: row.id,
      kind: row.kind,
      outcome: receipt.outcome,
      ...(receipt.code === undefined ? {} : { code: receipt.code }),
      ...(receipt.details === undefined ? {} : { details: receipt.details }),
    };
  });
  const answers = JSON.stringify(applied);
  await local.transaction([
    {
      sql:
        "UPDATE outbox SET outcome = r.value ->> 'outcome', outcome_code = r.value ->> 'code', " +
        "outcome_details = r.value -> 'details', acked_at = ? FROM json_each(?) AS r " +
        "WHERE outbox.id = r.value ->> 'id' AND outbox.host_id = ? AND outbox.device_id = ? " +
        "AND outbox.acked_at IS NULL",
      values: [now().toISOString(), answers, hostId, deviceId],
    },
    {
      sql:
        "UPDATE floor_scans SET conflict = 1 WHERE host_id = ? AND device_id = ? AND id IN " +
        "(SELECT value ->> 'id' FROM json_each(?) " +
        "WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'conflict')",
      values: [hostId, deviceId, answers],
    },
    {
      sql:
        "UPDATE floor_boxes SET needs_fix = 1 WHERE host_id = ? AND device_id = ? AND id IN " +
        "(SELECT box_id FROM floor_scans WHERE host_id = ? AND device_id = ? " +
        "AND box_id IS NOT NULL AND id IN (SELECT value ->> 'id' FROM json_each(?) " +
        "WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'conflict'))",
      values: [hostId, deviceId, hostId, deviceId, answers],
    },
  ]);
  return { sent: unsent.length, more: unsent.length === MAX_FACT_BATCH };
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/facts-sender.test.ts test/host-link-facts.test.ts test/host-link-shifts.test.ts test/shell.test.ts`
Expected: PASS — `Test Files  5 passed (5)`, `Tests  251 passed (251)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  94 passed (94)`, `Tests  2301 passed (2301)` (на настоящем дереве — больше на тесты, которых на копии нет).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — пачка больше 100 записей. В `apps/standalone/src/local/facts-sender.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "AND acked_at IS NULL ORDER BY seq LIMIT ?",
    [hostId, deviceId, MAX_FACT_BATCH],
```

заменить на:

<!-- prettier-ignore -->
```ts
      "AND acked_at IS NULL ORDER BY seq LIMIT ?",
    [hostId, deviceId, MAX_FACT_BATCH + 1],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/facts-sender.test.ts`
Expected: FAIL — «is this pairing's oldest records without a receipt, up to 100, in their order, as kept».

М2 — пачка от новых записей к старым. В `apps/standalone/src/local/facts-sender.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "AND acked_at IS NULL ORDER BY seq LIMIT ?",
```

заменить на:

<!-- prettier-ignore -->
```ts
      "AND acked_at IS NULL ORDER BY seq DESC LIMIT ?",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/facts-sender.test.ts`
Expected: FAIL — «is this pairing's oldest records without a receipt, up to 100, in their order, as kept».

М3 — в пачку попадают записи чужого подключения. В `apps/standalone/src/local/facts-sender.ts` фрагмент

<!-- prettier-ignore -->
```ts
    "SELECT id, kind, payload FROM outbox WHERE host_id = ? AND device_id = ? " +
```

заменить на:

<!-- prettier-ignore -->
```ts
    "SELECT id, kind, payload FROM outbox WHERE host_id = ? AND device_id <> 'x' || ? " +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/facts-sender.test.ts`
Expected: FAIL — «is this pairing's oldest records without a receipt, up to 100, in their order, as kept».

М4 — в пачку попадают записи с квитанцией. В `apps/standalone/src/local/facts-sender.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "AND acked_at IS NULL ORDER BY seq LIMIT ?",
```

заменить на:

<!-- prettier-ignore -->
```ts
      "ORDER BY seq LIMIT ?",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/facts-sender.test.ts`
Expected: FAIL — «is this pairing's oldest records without a receipt, up to 100, in their order, as kept».

М5 — отправка не считается в `attempts`. В `apps/standalone/src/local/facts-sender.ts` фрагмент

<!-- prettier-ignore -->
```ts
        "UPDATE outbox SET attempts = attempts + 1, sent_at = ? " +
```

заменить на:

<!-- prettier-ignore -->
```ts
        "UPDATE outbox SET attempts = attempts, sent_at = ? " +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/facts-sender.test.ts`
Expected: FAIL — «counts every attempt and keeps no receipt when the send fails».

М6 — квитанция без `id` не сопоставляется по месту. В `apps/standalone/src/local/facts-sender.ts` фрагмент

<!-- prettier-ignore -->
```ts
    if (receipt === undefined || (receipt.id !== null && receipt.id !== row.id)) {
```

заменить на:

<!-- prettier-ignore -->
```ts
    if (receipt === undefined || receipt.id !== row.id) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/facts-sender.test.ts`
Expected: FAIL — «applies each receipt to its record in one write, by its id or, without one, by its place».

М7 — квитанция с чужим `id` принимается. В `apps/standalone/src/local/facts-sender.ts` фрагмент

<!-- prettier-ignore -->
```ts
    if (receipt === undefined || (receipt.id !== null && receipt.id !== row.id)) {
```

заменить на:

<!-- prettier-ignore -->
```ts
    if (receipt === undefined) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/facts-sender.test.ts`
Expected: FAIL — «keeps nothing when the receipts do not answer the records sent».

М8 — число квитанций не сверяется с числом записей. В `apps/standalone/src/local/facts-sender.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (receipts.length !== unsent.length) {
    throw new ReceiptMismatchError(`${receipts.length} receipts for ${unsent.length} records`);
  }
  const applied = unsent.map((row, index) => {
```

заменить на:

<!-- prettier-ignore -->
```ts
  const applied = unsent.map((row, index) => {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/facts-sender.test.ts`
Expected: FAIL — «keeps nothing when the receipts do not answer the records sent».

М9 — `conflict` не отмечает скан. В `apps/standalone/src/local/facts-sender.ts` фрагмент

<!-- prettier-ignore -->
```ts
        "UPDATE floor_scans SET conflict = 1 WHERE host_id = ? AND device_id = ? AND id IN " +
```

заменить на:

<!-- prettier-ignore -->
```ts
        "UPDATE floor_scans SET conflict = 0 WHERE host_id = ? AND device_id = ? AND id IN " +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/facts-sender.test.ts`
Expected: FAIL — «applies each receipt to its record in one write, by its id or, without one, by its place».

М10 — `conflict` не отмечает короб. В `apps/standalone/src/local/facts-sender.ts` фрагмент

<!-- prettier-ignore -->
```ts
        "UPDATE floor_boxes SET needs_fix = 1 WHERE host_id = ? AND device_id = ? AND id IN " +
```

заменить на:

<!-- prettier-ignore -->
```ts
        "UPDATE floor_boxes SET needs_fix = 0 WHERE host_id = ? AND device_id = ? AND id IN " +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/facts-sender.test.ts`
Expected: FAIL — «applies each receipt to its record in one write, by its id or, without one, by its place».

М11 — подробности квитанции теряются. В `apps/standalone/src/local/facts-sender.ts` фрагмент

<!-- prettier-ignore -->
```ts
        "outcome_details = r.value -> 'details', acked_at = ? FROM json_each(?) AS r " +
```

заменить на:

<!-- prettier-ignore -->
```ts
        "outcome_details = NULL, acked_at = ? FROM json_each(?) AS r " +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/facts-sender.test.ts`
Expected: FAIL — «applies each receipt to its record in one write, by its id or, without one, by its place».

М12 — следующая пачка не идёт сразу. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
        if (more) factSender.trigger();
      } catch (error) {
```

заменить на:

<!-- prettier-ignore -->
```ts
      } catch (error) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-link-facts.test.ts`
Expected: FAIL — «goes once the link is watched, a full batch asking for the next at once».

М13 — паузы повтора сдвинуты. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
          factRetry = setTimeout(() => {
            factRetry = null;
            factSender.trigger();
          }, nextSyncRetryMs(factFailures));
```

заменить на:

<!-- prettier-ignore -->
```ts
          factRetry = setTimeout(() => {
            factRetry = null;
            factSender.trigger();
          }, nextSyncRetryMs(factFailures + 1));
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-link-facts.test.ts`
Expected: FAIL — «is sent again after 2 s, then 4 s, while the link is online».

М14 — при возвращении связи отправка не идёт. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
          if (factFailures > 0 && factRetry === null) factSender.trigger();
        },
```

заменить на:

<!-- prettier-ignore -->
```ts
        },
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-link-facts.test.ts`
Expected: FAIL — «waits while the link is down, and goes at once when it is back».

М15 — отказ ключа не останавливает связь. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
          stopAll();
          dispatch(action);
          return;
        }
        if (error instanceof HostError && error.code === "not_paired") return;
        dispatch({ type: "facts_failed", failure: factsFailureOf(error) });
```

заменить на:

<!-- prettier-ignore -->
```ts
          dispatch(action);
          return;
        }
        if (error instanceof HostError && error.code === "not_paired") return;
        dispatch({ type: "facts_failed", failure: factsFailureOf(error) });
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-link-facts.test.ts`
Expected: FAIL — «stops the link on a refused key: nothing more is sent».

М16 — просьба экрана не запускает отправку. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
    factsNow.current = () => factSender.trigger();
    let unwatch: (() => void) | null = null;
```

заменить на:

<!-- prettier-ignore -->
```ts
    let unwatch: (() => void) | null = null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-link-facts.test.ts`
Expected: FAIL — «goes when a screen asks after a local write, and asks nothing when there is nothing».

М17 — квитанции не сообщаются строке состояния. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
        if (sent > 0) dispatch({ type: "outbox_changed" });
        if (more) factSender.trigger();
```

заменить на:

<!-- prettier-ignore -->
```ts
        if (more) factSender.trigger();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-link-facts.test.ts`
Expected: FAIL — «goes once the link is watched, a full batch asking for the next at once».

М18 — `outbox_changed` не меняет версию. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
      return { ...state, outboxVersion: state.outboxVersion + 1 };
```

заменить на:

<!-- prettier-ignore -->
```ts
      return state;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts`
Expected: FAIL — «count up with every change, whatever the floor shows».

М19 — нечитаемый ответ хоста считается сбоем связи. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
    return error.kind === "transport" && error.code !== "invalid_response" ? "offline" : "host";
```

заменить на:

<!-- prettier-ignore -->
```ts
    return error.kind === "transport" ? "offline" : "host";
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-link-facts.test.ts`
Expected: FAIL — «is the link's when the host was not reached, and the host's when it answered wrong».

М20 — сбой базы этого компьютера считается сбоем хоста. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
  return error instanceof LocalDbError ? "local" : "host";
```

заменить на:

<!-- prettier-ignore -->
```ts
  return "host";
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-link-facts.test.ts`
Expected: FAIL — «is the link's when the host was not reached, and the host's when it answered wrong».

М21 — сбой доставки не сообщается оболочке. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
        dispatch({ type: "facts_failed", failure: factsFailureOf(error) });
        factFailures += 1;
```

заменить на:

<!-- prettier-ignore -->
```ts
        factFailures += 1;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-link-facts.test.ts`
Expected: FAIL — «says whether a failed send was the link's, the host's or this computer's, until one goes through».

М22 — удачная отправка не сообщается оболочке. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
        dispatch({ type: "facts_sent" });
        if (sent > 0) dispatch({ type: "outbox_changed" });
```

заменить на:

<!-- prettier-ignore -->
```ts
        if (sent > 0) dispatch({ type: "outbox_changed" });
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-link-facts.test.ts`
Expected: FAIL — «says whether a failed send was the link's, the host's or this computer's, until one goes through».

М23 — `facts_sent` не снимает причину сбоя. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
      return state.factsFailure === null ? state : { ...state, factsFailure: null };
```

заменить на:

<!-- prettier-ignore -->
```ts
      return state;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts`
Expected: FAIL — «keeps why the last send failed until a send goes through».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/app/App.tsx apps/standalone/src/app/host-link.ts apps/standalone/src/app/shell.ts apps/standalone/src/local/facts-sender.ts apps/standalone/test/app.test.tsx apps/standalone/test/facts-sender.test.ts apps/standalone/test/host-link-facts.test.ts apps/standalone/test/host-link-shifts.test.ts apps/standalone/test/shell.test.ts apps/standalone/test/support/floor-work.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/app.test.tsx test/host-link-facts.test.ts test/host-link-shifts.test.ts`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/app.test.tsx test/host-link-facts.test.ts test/host-link-shifts.test.ts`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/app/App.tsx apps/standalone/src/app/host-link.ts apps/standalone/src/app/shell.ts apps/standalone/src/local/facts-sender.ts apps/standalone/test/app.test.tsx apps/standalone/test/facts-sender.test.ts apps/standalone/test/host-link-facts.test.ts apps/standalone/test/host-link-shifts.test.ts apps/standalone/test/shell.test.ts apps/standalone/test/support/floor-work.ts
git commit -m "feat(standalone): the outbox goes to the host in batches with a receipt per record" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Строка состояния — неотправленное, отклонённое, конфликты, остаток номеров, сбой доставки

`readOutboxStatus` считает записи подключения без квитанции, отклонённые и в конфликте; `readSerialsLeft` — остаток номеров для префикса снимка смены, в которой работает оператор. `FloorStatusBar` получает `outboxVersion` (перечитывает счёт при каждом изменении очереди) и `factsFailure`: сбой хоста или этого компьютера — предупреждение словами, сбой связи показывает строка связи. Числа — `formatQuantity`.

**Files:**

- Create: `apps/standalone/src/floor/outbox-status.ts`
- Modify: `apps/standalone/src/app/App.tsx`, `apps/standalone/src/floor/FloorStatusBar.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-status-bar.test.tsx` (Modify)

**Interfaces:**

- Consumes: `remainingSerials` (задача 5); `ShellState.outboxVersion`, `factsFailure`, `FactsFailure` (задача 6); `formatQuantity` (план 2a5, `src/floor/shifts/shift-text.ts`).
- Produces:
  - `src/floor/outbox-status.ts`: `interface OutboxStatus { unsent; rejected; conflicts }`, `readOutboxStatus(local, pairing)`, `readSerialsLeft(local, pairing, shiftId): Promise<number | null>`;
  - `FloorStatusBarProps.outboxVersion: number`, `FloorStatusBarProps.factsFailure: FactsFailure | null`; ключи `floor.status.serials`, `unsent`, `rejected`, `conflicts`, `factsHost`, `factsLocal`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/floor-status-bar.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { seedBlock, unsentScans } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
        deviceNotSaved={false}
        {...props}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        deviceNotSaved={false}
        outboxVersion={0}
        factsFailure={null}
        {...props}
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
    expect(screen.queryByText(/не удалось сохранить на этом компьютере/)).toBeNull();
  });
});
```

заменить на:

<!-- prettier-ignore -->
```tsx
    expect(screen.queryByText(/не удалось сохранить на этом компьютере/)).toBeNull();
  });
});

describe("the outbox and the serials on the floor's status bar", () => {
  /** The value the bar shows under `label`, or `null` when it shows no such item. */
  function shown(label: string): string | null {
    const term = screen.queryByText(label);
    return term === null ? null : (term.nextElementSibling?.textContent ?? null);
  }

  it("counts this pairing's records not sent, refused and in conflict, and reads them again on a change", async () => {
    const { db, executor } = openLocalDb();
    const ids = await unsentScans(executor, 5);
    await unsentScans(executor, 2, { hostId: HOST_ID, deviceId: OTHER_DEVICE }, 100);
    const answer = db.prepare(
      "UPDATE outbox SET outcome = ?, outcome_code = ?, acked_at = '2026-10-08T06:20:00.000Z' WHERE id = ?",
    );
    answer.run("accepted", null, ids[0] ?? "");
    answer.run("rejected", "invalid_record", ids[1] ?? "");
    const view = render(bar({ local: executor }));
    await waitFor(() => expect(shown("Не отправлено")).toBe("3"));
    expect(shown("Отклонено хостом")).toBe("1");
    expect(shown("Конфликтов")).toBeNull();
    answer.run("conflict", null, ids[2] ?? "");
    view.rerender(bar({ local: executor, outboxVersion: 1 }));
    await waitFor(() => expect(shown("Не отправлено")).toBe("2"));
    expect(shown("Конфликтов")).toBe("1");
  });

  it("shows the serials left for the boxes of the shift the operator works in, and none outside it", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    seedBlock(db, { blockId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", from: 1500, to: 3499 });
    const view = render(bar({ local: executor, shiftId: ENTERED.id }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("2\u00a0000"));
    // Nothing written yet: nothing to send, refused or in conflict.
    expect([shown("Не отправлено"), shown("Отклонено хостом"), shown("Конфликтов")]).toEqual([
      "0",
      null,
      null,
    ]);
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 1501").run();
    view.rerender(bar({ local: executor, shiftId: ENTERED.id, outboxVersion: 1 }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("1\u00a0999"));
    view.rerender(bar({ local: executor, shiftId: null, outboxVersion: 1 }));
    expect(shown("Номеров SSCC")).toBeNull();
  });

  it("leaves the counts out when this computer cannot read the outbox", async () => {
    const { executor } = openLocalDb();
    const failing: LocalExecutor = {
      query: (sql, params, row) =>
        sql.includes("FROM outbox")
          ? Promise.reject(new Error("disk"))
          : executor.query(sql, params, row),
      transaction: (statements) => executor.transaction(statements),
    };
    render(bar({ local: failing }));
    expect(await screen.findByText("Никто не вошёл")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(shown("Не отправлено")).toBeNull();
  });

  it("says when the host or this computer, not the link, fails the outbox's delivery", async () => {
    const { executor } = openLocalDb();
    const view = render(bar({ local: executor, factsFailure: "offline" }));
    expect(await screen.findByText("Никто не вошёл")).toBeTruthy();
    expect(screen.queryByText(/Хост не принимает записи смены/)).toBeNull();
    view.rerender(bar({ local: executor, factsFailure: "host" }));
    expect(
      screen.getByText(
        "Хост не принимает записи смены: на хосте ошибка. Станция повторяет отправку, записи хранятся на этом компьютере.",
      ),
    ).toBeTruthy();
    view.rerender(bar({ local: executor, factsFailure: "local" }));
    expect(
      screen.getByText(
        "Ответ хоста не удалось записать в базу этого компьютера. Станция повторяет отправку.",
      ),
    ).toBeTruthy();
    view.rerender(bar({ local: executor, factsFailure: null }));
    expect(screen.queryByText(/Станция повторяет отправку/)).toBeNull();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx`
Expected: FAIL — 3 теста `floor-status-bar.test.tsx`: `counts this pairing's records not sent, refused and in conflict, and reads them again on a change`, `shows the serials left for the boxes of the shift the operator works in, and none outside it`, `says when the host or this computer, not the link, fails the outbox's delivery`.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/app/App.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
            deviceNotSaved={state.deviceNotSaved}
          />
```

заменить на:

<!-- prettier-ignore -->
```tsx
            deviceNotSaved={state.deviceNotSaved}
            outboxVersion={state.outboxVersion}
            factsFailure={state.factsFailure}
          />
```

Правка `apps/standalone/src/floor/FloorStatusBar.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { HostStatusLine } from "../app/HostStatusLine.js";
import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { readFloorPlace, type FloorPlace } from "./floor-status.js";
import { readShiftCopy } from "./shifts/shift-copies.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { HostStatusLine } from "../app/HostStatusLine.js";
import type { FactsFailure, SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { readFloorPlace, type FloorPlace } from "./floor-status.js";
import { readOutboxStatus, readSerialsLeft, type OutboxStatus } from "./outbox-status.js";
import { formatQuantity } from "./shifts/shift-text.js";
import { readShiftCopy } from "./shifts/shift-copies.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  deviceNotSaved: boolean;
}
```

заменить на:

<!-- prettier-ignore -->
```tsx
  deviceNotSaved: boolean;
  /** `ShellState.outboxVersion`: the counts of the outbox are read again when it changes. */
  outboxVersion: number;
  /** `ShellState.factsFailure`: why the last send of the outbox failed. */
  factsFailure: FactsFailure | null;
}
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
 * to this device (its line, its name) could not be saved on this computer,
 * so the station still works by the old one. A failed read of the copies
 * leaves the names out; the floor works on.
 */
```

заменить на:

<!-- prettier-ignore -->
```tsx
 * to this device (its line, its name) could not be saved on this computer,
 * so the station still works by the old one. Plan 2a6 adds the outbox —
 * records not yet sent, refused by the host and in conflict — and, in a
 * shift, the SSCC serials left for its boxes, read again whenever the outbox
 * changes, and a send of the outbox that failed for the host or for this
 * computer (the link's own failure the link's line says). A failed read of
 * the copies leaves the names out, and of the outbox its counts; the floor
 * works on.
 */
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  deviceNotSaved,
}: FloorStatusBarProps) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  deviceNotSaved,
  outboxVersion,
  factsFailure,
}: FloorStatusBarProps) {
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
  const shiftNumber = shift !== null && shift.id === shiftId ? shift.number : null;

  useEffect(() => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const shiftNumber = shift !== null && shift.id === shiftId ? shift.number : null;

  const [outbox, setOutbox] = useState<OutboxStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    readOutboxStatus(local, { hostId, deviceId }).then(
      (next) => {
        if (!cancelled) setOutbox(next);
      },
      () => {
        if (!cancelled) setOutbox(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, outboxVersion]);

  const [serials, setSerials] = useState<{ shiftId: string; left: number | null } | null>(null);
  useEffect(() => {
    if (shiftId === null) return;
    let cancelled = false;
    readSerialsLeft(local, { hostId, deviceId }, shiftId).then(
      (left) => {
        if (!cancelled) setSerials({ shiftId, left });
      },
      () => {
        if (!cancelled) setSerials(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, shiftId, outboxVersion]);
  // Only the shift on screen's serials: none after it is left.
  const serialsLeft = serials !== null && serials.shiftId === shiftId ? serials.left : null;

  useEffect(() => {
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
        )}
      </dl>
```

заменить на:

<!-- prettier-ignore -->
```tsx
        )}
        {serialsLeft !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.serials")}</dt>
            <dd>{formatQuantity(serialsLeft)}</dd>
          </div>
        )}
        {outbox !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.unsent")}</dt>
            <dd>{formatQuantity(outbox.unsent)}</dd>
          </div>
        )}
        {outbox !== null && outbox.rejected > 0 && (
          <div className="floor-status__item">
            <dt>{t("floor.status.rejected")}</dt>
            <dd>{formatQuantity(outbox.rejected)}</dd>
          </div>
        )}
        {outbox !== null && outbox.conflicts > 0 && (
          <div className="floor-status__item">
            <dt>{t("floor.status.conflicts")}</dt>
            <dd>{formatQuantity(outbox.conflicts)}</dd>
          </div>
        )}
      </dl>
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
        </div>
      </div>
```

заменить на:

<!-- prettier-ignore -->
```tsx
        </div>
        <div aria-live="polite">
          {factsFailure === "host" && <Alert tone="warn">{t("floor.status.factsHost")}</Alert>}
          {factsFailure === "local" && <Alert tone="warn">{t("floor.status.factsLocal")}</Alert>}
        </div>
      </div>
```

Создать `apps/standalone/src/floor/outbox-status.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { remainingSerials } from "./work/block-supply.js";

/**
 * What the floor's status bar says of the outbox (stage 2a spec §5.5): this
 * pairing's records without a receipt, the ones the host refused, and the
 * scans the host found another device's scan owns.
 */
export interface OutboxStatus {
  unsent: number;
  rejected: number;
  conflicts: number;
}

const statusRow = z.object({
  unsent: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
});

export async function readOutboxStatus(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<OutboxStatus> {
  const [row] = await local.query(
    "SELECT count(*) FILTER (WHERE acked_at IS NULL) AS unsent, " +
      "count(*) FILTER (WHERE outcome = 'rejected') AS rejected, " +
      "count(*) FILTER (WHERE outcome = 'conflict') AS conflicts " +
      "FROM outbox WHERE host_id = ? AND device_id = ?",
    [pairing.hostId, pairing.deviceId],
    statusRow,
  );
  return row ?? { unsent: 0, rejected: 0, conflicts: 0 };
}

const prefixRow = z.object({ prefix: z.string().nullable() });

/**
 * The SSCC serials this pairing has left for the boxes of a shift it entered
 * (the snapshot's issuer prefix); `null` for a shift without a snapshot.
 */
export async function readSerialsLeft(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<number | null> {
  const [row] = await local.query(
    "SELECT snapshot ->> 'issuerPrefix' AS prefix FROM floor_shifts " +
      "WHERE host_id = ? AND device_id = ? AND id = ?",
    [pairing.hostId, pairing.deviceId, shiftId],
    prefixRow,
  );
  if (row === undefined || row.prefix === null) return null;
  return remainingSerials(local, pairing, row.prefix);
}
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
      "shift": "Смена",
      "deviceNotSaved": "Офис изменил это устройство, но изменение не удалось сохранить на этом компьютере: станция работает по-прежнему. Освободите место на диске или обратитесь к администратору."
```

заменить на:

<!-- prettier-ignore -->
```json
      "shift": "Смена",
      "serials": "Номеров SSCC",
      "unsent": "Не отправлено",
      "rejected": "Отклонено хостом",
      "conflicts": "Конфликтов",
      "factsHost": "Хост не принимает записи смены: на хосте ошибка. Станция повторяет отправку, записи хранятся на этом компьютере.",
      "factsLocal": "Ответ хоста не удалось записать в базу этого компьютера. Станция повторяет отправку.",
      "deviceNotSaved": "Офис изменил это устройство, но изменение не удалось сохранить на этом компьютере: станция работает по-прежнему. Освободите место на диске или обратитесь к администратору."
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  17 passed (17)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  94 passed (94)`, `Tests  2305 passed (2305)` (на настоящем дереве — больше на тесты, которых на копии нет).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — счёт очереди всех подключений. В `apps/standalone/src/floor/outbox-status.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "FROM outbox WHERE host_id = ? AND device_id = ?",
```

заменить на:

<!-- prettier-ignore -->
```ts
      "FROM outbox WHERE host_id = ? AND device_id <> 'x' || ?",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx`
Expected: FAIL — «counts this pairing's records not sent, refused and in conflict, and reads them again on a change».

М2 — счёт очереди не перечитывается по версии. В `apps/standalone/src/floor/FloorStatusBar.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  }, [local, hostId, deviceId, outboxVersion]);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }, [local, hostId, deviceId]);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx`
Expected: FAIL — «counts this pairing's records not sent, refused and in conflict, and reads them again on a change».

М3 — остаток номеров не перечитывается по версии. В `apps/standalone/src/floor/FloorStatusBar.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  }, [local, hostId, deviceId, shiftId, outboxVersion]);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }, [local, hostId, deviceId, shiftId]);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx`
Expected: FAIL — «shows the serials left for the boxes of the shift the operator works in, and none outside it».

М4 — остаток номеров прежней смены после выхода из неё. В `apps/standalone/src/floor/FloorStatusBar.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  const serialsLeft = serials !== null && serials.shiftId === shiftId ? serials.left : null;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const serialsLeft = serials !== null ? serials.left : null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx`
Expected: FAIL — «shows the serials left for the boxes of the shift the operator works in, and none outside it».

М5 — «Отклонено хостом» показано при нуле. В `apps/standalone/src/floor/FloorStatusBar.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        {outbox !== null && outbox.rejected > 0 && (
```

заменить на:

<!-- prettier-ignore -->
```tsx
        {outbox !== null && outbox.rejected >= 0 && (
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx`
Expected: FAIL — «shows the serials left for the boxes of the shift the operator works in, and none outside it».

М6 — «Конфликтов» показано при нуле. В `apps/standalone/src/floor/FloorStatusBar.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        {outbox !== null && outbox.conflicts > 0 && (
```

заменить на:

<!-- prettier-ignore -->
```tsx
        {outbox !== null && outbox.conflicts >= 0 && (
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx`
Expected: FAIL — «counts this pairing's records not sent, refused and in conflict, and reads them again on a change».

М7 — «Не отправлено» считает и подтверждённые. В `apps/standalone/src/floor/outbox-status.ts` фрагмент

<!-- prettier-ignore -->
```ts
    "SELECT count(*) FILTER (WHERE acked_at IS NULL) AS unsent, " +
```

заменить на:

<!-- prettier-ignore -->
```ts
    "SELECT count(*) AS unsent, " +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx`
Expected: FAIL — «counts this pairing's records not sent, refused and in conflict, and reads them again on a change».

М8 — остаток номеров чужого префикса. В `apps/standalone/src/floor/outbox-status.ts` фрагмент

<!-- prettier-ignore -->
```ts
  return remainingSerials(local, pairing, row.prefix);
```

заменить на:

<!-- prettier-ignore -->
```ts
  return remainingSerials(local, pairing, "460068201");
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx`
Expected: FAIL — «shows the serials left for the boxes of the shift the operator works in, and none outside it».

М9 — сбой хоста не показан. В `apps/standalone/src/floor/FloorStatusBar.tsx` удалить фрагмент

<!-- prettier-ignore -->
```tsx
          {factsFailure === "host" && <Alert tone="warn">{t("floor.status.factsHost")}</Alert>}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx`
Expected: FAIL — «says when the host or this computer, not the link, fails the outbox's delivery».

М10 — сбой связи показан как сбой хоста. В `apps/standalone/src/floor/FloorStatusBar.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
          {factsFailure === "host" && <Alert tone="warn">{t("floor.status.factsHost")}</Alert>}
```

заменить на:

<!-- prettier-ignore -->
```tsx
          {factsFailure !== null && factsFailure !== "local" && <Alert tone="warn">{t("floor.status.factsHost")}</Alert>}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx`
Expected: FAIL — «says when the host or this computer, not the link, fails the outbox's delivery».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/app/App.tsx apps/standalone/src/floor/FloorStatusBar.tsx apps/standalone/src/floor/outbox-status.ts apps/standalone/src/i18n/ru.json apps/standalone/test/floor-status-bar.test.tsx`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-status-bar.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/floor-status-bar.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/app/App.tsx apps/standalone/src/floor/FloorStatusBar.tsx apps/standalone/src/floor/outbox-status.ts apps/standalone/src/i18n/ru.json apps/standalone/test/floor-status-bar.test.tsx
git commit -m "feat(standalone): the status bar counts the outbox and the serials left" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Рабочий экран — сканирование в короба, остановки, вердикты словами, вспышкой и звуком; проводка цеха

Тело `WorkScreen` заменяется (свойства плана 2a5 сохраняются и дополняются: `source`, `checkCode`, `requestBlock`, `onHostError`, `onRecorded`, необязательный `signal`). Сканы источника идут в очередь (`createWorkQueue`), каждый отдаётся воротам работы (`track`) и трогает таймер бездействия (`touch`); во время выхода скан не принимается. Скан, пришедший, пока работу останавливает сообщение (сбой записи, нет номеров, сбой закрытия, подтверждение неполного короба), не принимается и не пишется в журнал; экран и звук говорят «не принят». Принятый код закрывает полный короб (`closeIfFull`); номеров нет — дозаказ и вторая попытка, затем остановка с причиной (нет связи, номера префикса кончились, хост не выдал); пришедший блок закрывает ждущий короб. При входе — числа и закрытие оставленного полным короба; при связи — дозаказ по правилу «половина»; после каждого закрытия — тоже. Неполный короб — «Закрыть короб» с подтверждением. Уведомление «План выполнен» — один раз. Вердикты — строкой под коробом, вспышкой `SignalOverlay` и тоном (`signal-sound.ts`, порт облачного: тоны генерируются, контекст звука один на страницу). `FloorApp` получает `checkCode`, `requestBlock`, `requestFacts`, `rejectionPending` (ждущий отказ отключает экран от хоста) и передаёт экрану источник, вызовы хоста и `onRecorded` (`outbox_changed` и `requestFacts()`); `App` подаёт их из `HostApi` и `useHostLink`. Тест плана 2a5 о названии смены переходит на новые тексты.

**Files:**

- Create: `apps/standalone/src/floor/work/signal-sound.ts`
- Modify: `apps/standalone/src/app/App.tsx`, `apps/standalone/src/app/shell.css`, `apps/standalone/src/floor/FloorApp.tsx`, `apps/standalone/src/floor/work/WorkScreen.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-work-screen.test.tsx` (Create), `apps/standalone/test/signal-sound.test.ts` (Create), `apps/standalone/test/floor-app.test.tsx` (Modify)

**Interfaces:**

- Consumes: всё задач 1–7; `createWorkGate` (план 2a5); `formatSsccHri` (`@markiro/domain`); `SignalOverlay`, `SignalTone`, `Alert`, `Button`, `Card` (`@markiro/ui`); `formatQuantity`.
- Produces:
  - `src/floor/work/WorkScreen.tsx`: `interface WorkScreenProps` (свойства плана 2a5 и `source`, `checkCode`, `requestBlock`, `onHostError`, `onRecorded`, `signal?`), `SIGNAL_MS = 700`, `scanTime(iso)`, `WorkScreen`;
  - `src/floor/work/signal-sound.ts`: `TONES`, `playSignalTone(tone, context?)`;
  - `src/floor/FloorApp.tsx`: `FloorAppProps.rejectionPending`, `checkCode`, `requestBlock`, `requestFacts`;
  - ключи `floor.work.*` (заглушка `floor.work.stub` уходит); стили `.work-screen*` в `src/app/shell.css`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/floor-app.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  type ChangeItem,
  type DeviceShift,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  type ChangeItem,
  type CodeCheck,
  type SsccBlock,
  type SsccBlockRequest,
  type DeviceShift,
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  lineChangePending?: boolean;
  idleTimeoutMs?: number;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  lineChangePending?: boolean;
  rejectionPending?: boolean;
  idleTimeoutMs?: number;
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
        lineChangePending={options.lineChangePending ?? false}
        enter={handlers.enter}
        create={handlers.create}
        source={SILENT_SOURCE}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        lineChangePending={options.lineChangePending ?? false}
        rejectionPending={options.rejectionPending ?? false}
        enter={handlers.enter}
        create={handlers.create}
        checkCode={handlers.checkCode}
        requestBlock={handlers.requestBlock}
        requestFacts={handlers.requestFacts}
        source={SILENT_SOURCE}
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
    create: vi.fn(async () => PLANNED),
    dispatch: vi.fn<(action: ShellAction) => void>(),
```

заменить на:

<!-- prettier-ignore -->
```tsx
    create: vi.fn(async () => PLANNED),
    checkCode: vi.fn(async (): Promise<CodeCheck> => ({ status: "free" })),
    requestBlock: vi.fn(async (request: SsccBlockRequest): Promise<SsccBlock> => ({
      id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      issuerPrefix: request.issuerPrefix,
      extension: request.extension,
      fromSerial: 1500,
      toSerial: 3499,
    })),
    requestFacts: vi.fn(),
    dispatch: vi.fn<(action: ShellAction) => void>(),
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
    expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
    expect(screen.getByText("Молоко 3,2% 0,9 л")).toBeTruthy();
    expect(
      screen.getByText(
        "Сканирование кодов и сборка коробов появятся в следующем обновлении приложения.",
      ),
    ).toBeTruthy();
  });
```

заменить на:

<!-- prettier-ignore -->
```tsx
    expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
    expect(screen.getByText("Молоко 3,2% 0,9 л · GTIN 04600682000013")).toBeTruthy();
    expect(screen.getByText("Отсканируйте код маркировки.")).toBeTruthy();
  });
});

describe("the work screen the floor mounts", () => {
  it("gets the scanner, the host's calls, and a link that a waiting refusal stops", async () => {
    const seen: WorkScreenProps[] = [];
    function Work(props: WorkScreenProps) {
      seen.push(props);
      return (
        <button type="button" onClick={props.onRecorded}>
          {`Работа ${props.shift.copy.number}`}
        </button>
      );
    }
    const handlers = handlersOf();
    const local = await floorCopies();
    const view = render(floorOf(local, handlers, { workScreen: Work }));
    await enterPlanned();
    fireEvent.click(await screen.findByRole("button", { name: "Работа OCT26-005/S" }));
    expect(handlers.requestFacts).toHaveBeenCalledTimes(1);
    expect(types(handlers)).toContain("outbox_changed");
    const props = seen.at(-1);
    expect(props?.online).toBe(true);
    expect(props?.source).toBe(SILENT_SOURCE);
    expect(props?.checkCode).toBe(handlers.checkCode);
    expect(props?.requestBlock).toBe(handlers.requestBlock);
    view.rerender(floorOf(local, handlers, { workScreen: Work, rejectionPending: true }));
    expect(seen.at(-1)?.online).toBe(false);
  });
```

Создать `apps/standalone/test/floor-work-screen.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { buildSscc } from "@markiro/domain";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, type SignalTone } from "@markiro/ui";

import type { FloorSession } from "../src/app/shell.js";
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import type { WorkShift } from "../src/floor/shifts/shift-copies.js";
import { createWorkGate } from "../src/floor/work-gate.js";
import { scanTime, WorkScreen, type WorkScreenProps } from "../src/floor/work/WorkScreen.js";
import { HostError } from "../src/host/client.js";
import type { CodeCheck, SsccBlock, SsccBlockRequest } from "../src/host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import {
  ENTERED,
  enteredShift,
  GTIN,
  holdingWrites,
  km,
  OPERATOR_ID,
  OTHER_GTIN,
  PAIRING,
  PREFIX,
  rows,
  seedBlock,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

const SESSION: FloorSession = {
  id: OPERATOR_ID,
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
  sessionId: 1,
};
const BLOCK_ID = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const TAKEN: CodeCheck = {
  status: "taken",
  owner: {
    shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    shiftNumber: "OCT26-003",
    deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    scannedAt: "2026-10-08T05:58:41.090Z",
    sameDevice: false,
  },
};

/** A scanner the test reads codes into, as the floor's source hands them over. */
function fakeSource() {
  let listener: ScanListener | null = null;
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    clearPendingInput: () => undefined,
    setManualTextEntryActive: () => undefined,
  };
  return {
    source,
    /** The screen listens: only then may the test scan. */
    listening: () =>
      waitFor(() => {
        if (listener === null) throw new Error("the work screen does not listen yet");
      }),
    /** Hands a scan over, as the scanner does, and returns at once. */
    read: (raw: string) =>
      act(() => {
        listener?.(raw);
      }),
    emit: (raw: string) => listener?.(raw),
  };
}

/** A block of 2 000 serials from `fromSerial`, of the prefix and extension asked for. */
function blockFor(request: SsccBlockRequest, fromSerial = 3500): SsccBlock {
  return {
    id: BLOCK_ID,
    issuerPrefix: request.issuerPrefix,
    extension: request.extension,
    fromSerial,
    toSerial: fromSerial + 1999,
  };
}

interface Station {
  db: ReturnType<typeof openLocalDb>["db"];
  local: LocalExecutor;
  shift: WorkShift;
}

async function station(shift = ENTERED): Promise<Station> {
  const { db, executor } = openLocalDb();
  return { db, local: executor, shift: await enteredShift(executor, shift) };
}

function work(at: Station, overrides: Partial<WorkScreenProps> = {}) {
  const gate = createWorkGate();
  const scanner = fakeSource();
  const props: WorkScreenProps = {
    shift: at.shift,
    operator: SESSION,
    pairing: PAIRING,
    local: at.local,
    online: false,
    track: gate.track,
    touch: vi.fn(),
    onLeave: vi.fn(),
    leaving: false,
    source: scanner.source,
    checkCode: vi.fn(async (): Promise<CodeCheck> => ({ status: "free" })),
    requestBlock: vi.fn(async (request: SsccBlockRequest) => blockFor(request)),
    onHostError: vi.fn(),
    onRecorded: vi.fn(),
    signal: vi.fn<(tone: SignalTone) => void>(),
    ...overrides,
  };
  const view = render(
    <ThemeProvider>
      <WorkScreen {...props} />
    </ThemeProvider>,
  );
  return {
    view,
    gate,
    props,
    scanner,
    rerender: (next: Partial<WorkScreenProps>) =>
      view.rerender(
        <ThemeProvider>
          <WorkScreen {...props} {...next} />
        </ThemeProvider>,
      ),
    /** Every piece of work the screen handed to the gate has settled. */
    settled: () =>
      act(async () => {
        await gate.drain();
      }),
    /** Scans `raw` and waits for its work, all inside one `act`. */
    scan: (raw: string) =>
      act(async () => {
        scanner.emit(raw);
        await gate.drain();
      }),
    /** Presses the button `name` and waits for the work it started. */
    press: (name: string) =>
      act(async () => {
        fireEvent.click(screen.getByRole("button", { name }));
        await gate.drain();
      }),
  };
}

/** The value the screen shows under `label`. */
function shown(label: string): string | null {
  return screen.getByText(label).nextElementSibling?.textContent ?? null;
}

function lastLine(): string | null {
  return document.querySelector(".work-screen__last")?.textContent ?? null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the work screen of a shift", () => {
  it("takes the scans into the open box, with their numbers, a tone and a touch each", async () => {
    const at = await station();
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.settled();
    expect(shown("Открытый короб")).toBe("Короб откроется с первым кодом");
    await screenWork.scan(km("A1"));
    await screenWork.scan(km("A2"));
    expect(shown("Открытый короб")).toBe("2 из 12");
    expect(shown("Принято в смене")).toBe("2");
    expect(shown("План")).toBe("1\u00a0200");
    expect(lastLine()).toBe("Принято: в коробе 2 из 12.");
    expect(screenWork.props.signal).toHaveBeenCalledTimes(2);
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("ok");
    expect(screenWork.props.touch).toHaveBeenCalledTimes(2);
    expect(screenWork.props.onRecorded).toHaveBeenCalledTimes(2);
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'scan'")).toEqual([{ n: 2 }]);
  });

  it("hands a scan on its way to the floor's gate, so a leave waits for it", async () => {
    const at = await station();
    const held = holdingWrites(at.local);
    const screenWork = work({ ...at, local: held.executor });
    await screenWork.scanner.listening();
    await screenWork.settled();
    held.holdNext();
    await screenWork.scanner.read(km("B1"));
    await held.reached();
    expect(screenWork.gate.pending()).toBe(1);
    held.release();
    await screenWork.settled();
    expect(screenWork.gate.pending()).toBe(0);
    expect(shown("Принято в смене")).toBe("1");
  });

  it("closes a full box by itself with the next SSCC, and begins the next box", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    const screenWork = work(at);
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`C${index}`));
    expect(shown("Последний короб")).toBe(`(00)${buildSscc(0, PREFIX, 1500)}`);
    expect(shown("Коробов закрыто")).toBe("1");
    expect(shown("Открытый короб")).toBe("Короб откроется с первым кодом");
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_closed'")).toEqual([
      { n: 1 },
    ]);
    await screenWork.scan(km("C12"));
    expect(shown("Открытый короб")).toBe("1 из 12");
  });

  it("says in words and by tone what each refused scan was", async () => {
    const at = await station();
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.scan(km("D1"));
    const [first] = rows(at.db, "SELECT scanned_at FROM floor_codes");
    await screenWork.scan(km("D1", { aim: false }));
    expect(lastLine()).toBe(
      `Дубль: этот код уже принят в ${scanTime(String(first?.["scanned_at"]))}.`,
    );
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("duplicate");
    await screenWork.scan(km("D2", { gtin: OTHER_GTIN }));
    expect(lastLine()).toBe(`Чужой товар: GTIN ${OTHER_GTIN}.`);
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("error");
    await screenWork.scan(GTIN);
    expect(lastLine()).toBe("Это GTIN товара, а не код маркировки.");
    await screenWork.scan(`]C100${buildSscc(0, PREFIX, 1500)}`);
    expect(lastLine()).toBe("Это код короба, а не код маркировки.");
    await screenWork.scan("MRK-000742");
    expect(lastLine()).toBe("Это не код маркировки.");
    expect(shown("Принято в смене")).toBe("1");
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 6 }]);
  });

  it("asks the host while online and names the shift that took the code first", async () => {
    const at = await station();
    const checkCode = vi.fn(async (): Promise<CodeCheck> => TAKEN);
    const screenWork = work(at, { online: true, checkCode });
    await screenWork.scanner.listening();
    await screenWork.scan(km("E1"));
    expect(lastLine()).toBe(
      `Дубль: код принят в смене OCT26-003 в ${scanTime(TAKEN.owner.scannedAt)}.`,
    );
    expect(checkCode).toHaveBeenCalledTimes(1);
  });

  it("hands a refused key of the code check to the shell, and takes the scan", async () => {
    const at = await station();
    const refused = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    const screenWork = work(at, {
      online: true,
      checkCode: async () => {
        throw refused;
      },
    });
    await screenWork.scanner.listening();
    await screenWork.scan(km("F1"));
    expect(screenWork.props.onHostError).toHaveBeenCalledWith(refused);
    expect(shown("Принято в смене")).toBe("1");
  });

  it("closes an incomplete box only once the operator confirms, and takes no scan meanwhile", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.settled();
    expect(screen.getByRole("button", { name: "Закрыть короб" }).hasAttribute("disabled")).toBe(
      true,
    );
    await screenWork.scan(km("G1"));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    expect(screen.getByText("Закрыть неполный короб? В коробе 1 из 12.")).toBeTruthy();
    await screenWork.scan(km("G2"));
    expect(lastLine()).toBe(
      "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.",
    );
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: "Продолжить сборку" }));
    expect(screen.queryByText("Закрыть неполный короб? В коробе 1 из 12.")).toBeNull();
    expect(rows(at.db, "SELECT closed_at FROM floor_boxes")).toEqual([{ closed_at: null }]);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    await screenWork.press("Закрыть короб");
    expect(shown("Коробов закрыто")).toBe("1");
    expect(rows(at.db, "SELECT sscc FROM floor_boxes")).toEqual([
      { sscc: buildSscc(0, PREFIX, 1500) },
    ]);
  });

  it("stops without serials, says why, and closes the box once the link brings a block", async () => {
    const at = await station();
    const requestBlock = vi.fn(async (request: SsccBlockRequest) => blockFor(request));
    const screenWork = work(at, { requestBlock });
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`H${index}`));
    expect(screen.getByText("Нет номеров SSCC: короб не закрыт")).toBeTruthy();
    expect(
      screen.getByText(
        "Номера выдаёт хост, а связи с ним нет. Короб закроется, как только номера придут.",
      ),
    ).toBeTruthy();
    await screenWork.scan(km("H12"));
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 12 }]);
    expect(requestBlock).not.toHaveBeenCalled();
    screenWork.rerender({ online: true });
    await waitFor(() => expect(screen.queryByText("Нет номеров SSCC: короб не закрыт")).toBeNull());
    await screenWork.settled();
    // The close ran from the effect of the link coming back, outside a
    // scan's `act`: its numbers render in a later turn.
    await waitFor(() => expect(shown("Коробов закрыто")).toBe("1"));
    await screenWork.scan(km("H12"));
    expect(shown("Открытый короб")).toBe("1 из 12");
  });

  it("says when the host has no serials left, and tries again on «Повторить»", async () => {
    const at = await station();
    const requestBlock = vi
      .fn<(request: SsccBlockRequest) => Promise<SsccBlock>>()
      .mockRejectedValueOnce(
        new HostError({ kind: "api", code: "sscc_exhausted", status: 409, message: "none" }),
      )
      .mockRejectedValueOnce(
        new HostError({ kind: "api", code: "sscc_exhausted", status: 409, message: "none" }),
      )
      .mockImplementation(async (request) => blockFor(request));
    const screenWork = work(at, { online: true, requestBlock });
    await screenWork.scanner.listening();
    await screenWork.settled();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`J${index}`));
    expect(
      screen.getByText(
        "Номера SSCC префикса организации закончились. Обратитесь к администратору.",
      ),
    ).toBeTruthy();
    await screenWork.press("Повторить");
    expect(screen.queryByText("Нет номеров SSCC: короб не закрыт")).toBeNull();
    expect(shown("Коробов закрыто")).toBe("1");
  });

  it("stops the line on a failed write until the operator closes the message", async () => {
    const at = await station();
    let broken = false;
    const local: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: (statements) =>
        broken
          ? Promise.reject(new LocalDbError("statement_failed", "disk full"))
          : at.local.transaction(statements),
    };
    const screenWork = work({ ...at, local });
    await screenWork.scanner.listening();
    await screenWork.settled();
    broken = true;
    await screenWork.scan(km("K1"));
    expect(screen.getByText("Скан не записан")).toBeTruthy();
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("error");
    broken = false;
    await screenWork.scan(km("K2"));
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 0 }]);
    await screenWork.press("Понятно");
    await screenWork.scan(km("K1"));
    expect(shown("Принято в смене")).toBe("1");
  });

  it("says once that the plan is reached", async () => {
    const at = await station({ ...ENTERED, plannedQty: 2 });
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.scan(km("L1"));
    expect(screen.queryByText(/План выполнен/)).toBeNull();
    await screenWork.scan(km("L2"));
    expect(screen.getByText("План выполнен: принято 2 из 2.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await screenWork.scan(km("L3"));
    expect(screen.queryByText(/План выполнен/)).toBeNull();
  });

  it("takes no scan while the operator leaves, and lets nobody press leave twice", async () => {
    const at = await station();
    const screenWork = work(at, { leaving: true });
    await screenWork.scanner.listening();
    await screenWork.scan(km("M1"));
    expect(lastLine()).toBe("Скан не принят: идёт выход из смены.");
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 0 }]);
    expect(screen.getByRole("button", { name: "Выйти из смены" }).hasAttribute("disabled")).toBe(
      true,
    );
    screenWork.rerender({ leaving: false });
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    expect(screenWork.props.onLeave).toHaveBeenCalledTimes(1);
  });

  it("closes first a box a stopped station left full, then asks for serials while online", async () => {
    const at = await station();
    // One serial: the close takes it, and the half rule then asks for more.
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 1500 });
    const filling = work(at);
    await filling.scanner.listening();
    for (let index = 0; index < 11; index += 1) await filling.scan(km(`N${index}`));
    filling.view.unmount();
    // The twelfth code, as a station that stopped right after the scan left it.
    at.db.prepare("UPDATE floor_boxes SET item_count = 12 WHERE closed_at IS NULL").run();
    at.db
      .prepare(
        "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, scanned_at) " +
          "SELECT host_id, device_id, ?, shift_id, id, 'n11', '2026-10-08T06:20:00.000Z' FROM floor_boxes WHERE closed_at IS NULL",
      )
      .run("ab".repeat(32));
    const requestBlock = vi.fn(async (request: SsccBlockRequest) => blockFor(request));
    const reopened = work(at, { online: true, requestBlock });
    await reopened.scanner.listening();
    await reopened.settled();
    // The entry's close ran from an effect, outside a scan's `act`: its
    // numbers render in a later turn.
    await waitFor(() => expect(shown("Коробов закрыто")).toBe("1"));
    expect(requestBlock).toHaveBeenCalledWith({
      requestId: expect.any(String),
      issuerPrefix: PREFIX,
      extension: 0,
    });
  });
});
```

Создать `apps/standalone/test/signal-sound.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import { playSignalTone, TONES } from "../src/floor/work/signal-sound.js";

/** Just enough of an `AudioContext` to see what tone was played. */
function fakeAudio(state: AudioContextState = "running") {
  const frequency = { setValueAtTime: vi.fn() };
  const oscillator = {
    type: "sine" as OscillatorType,
    frequency,
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const gain = {
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  };
  const audio = {
    state,
    currentTime: 10,
    destination: {},
    resume: vi.fn(async () => undefined),
    createOscillator: () => oscillator,
    createGain: () => gain,
  };
  return { audio, oscillator, frequency };
}

describe("the tone of a verdict", () => {
  it("plays each verdict at its own pitch and length", () => {
    for (const tone of ["ok", "duplicate", "error"] as const) {
      const { audio, oscillator, frequency } = fakeAudio();
      playSignalTone(tone, () => audio as unknown as AudioContext);
      expect(oscillator.type).toBe(TONES[tone].type);
      expect(frequency.setValueAtTime).toHaveBeenCalledWith(TONES[tone].hz, 10);
      expect(oscillator.stop).toHaveBeenCalledWith(10 + TONES[tone].seconds);
    }
    expect(new Set(Object.values(TONES).map((spec) => spec.hz)).size).toBe(3);
  });

  it("wakes a sleeping context and plays anyway", () => {
    const { audio, oscillator } = fakeAudio("suspended");
    playSignalTone("ok", () => audio as unknown as AudioContext);
    expect(audio.resume).toHaveBeenCalledTimes(1);
    expect(oscillator.start).toHaveBeenCalledTimes(1);
  });

  it("is silent, and throws nothing, without sound", () => {
    expect(() => playSignalTone("error", () => null)).not.toThrow();
    expect(() =>
      playSignalTone("error", () => {
        throw new Error("no audio device");
      }),
    ).not.toThrow();
    // jsdom has no `AudioContext` at all.
    expect(() => playSignalTone("ok")).not.toThrow();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx test/floor-work-screen.test.tsx test/signal-sound.test.ts`
Expected: FAIL — 13 тестов `floor-work-screen.test.tsx` (заглушка не слушает сканер), 2 теста `floor-app.test.tsx` (`names the shift and its product from the snapshot`, `gets the scanner, the host's calls, and a link that a waiting refusal stops`), `signal-sound.test.ts` не загружается (`Failed to resolve import "../src/floor/work/signal-sound.js"`).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/app/App.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
      : null;
  const { requestSync } = useHostLink({
    hostId: linked?.hostId ?? null,
```

заменить на:

<!-- prettier-ignore -->
```tsx
      : null;
  const { requestSync, requestFacts } = useHostLink({
    hostId: linked?.hostId ?? null,
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
              lineChangePending={state.pendingDevice !== null}
              enter={hostApi.enterShift}
              create={hostApi.createDeviceShift}
              source={scanner}
```

заменить на:

<!-- prettier-ignore -->
```tsx
              lineChangePending={state.pendingDevice !== null}
              rejectionPending={state.pendingRejection !== null}
              enter={hostApi.enterShift}
              create={hostApi.createDeviceShift}
              checkCode={hostApi.checkCode}
              requestBlock={hostApi.requestSsccBlock}
              requestFacts={requestFacts}
              source={scanner}
```

Правка `apps/standalone/src/app/shell.css`:

Фрагмент 1:

<!-- prettier-ignore -->
```css
.new-shift__date {
  display: grid;
  gap: 8px;
}
```

заменить на:

<!-- prettier-ignore -->
```css
.new-shift__date {
  display: grid;
  gap: 8px;
}

/* The work screen of a shift: the box and the shift in big numbers, the last
   scan in words, and the 64 px actions under them. */
.work-screen {
  width: min(880px, 100%);
}

.work-screen__facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 16px;
  margin: 0;
}

.work-screen__facts dt {
  color: var(--fg-2);
}

.work-screen__facts dd {
  margin: 0;
  font: var(--floor-lg);
}

.work-screen__last {
  min-height: 64px;
  font: var(--floor-body-strong);
}

.work-screen__confirm {
  display: grid;
  gap: 16px;
}
```

Правка `apps/standalone/src/floor/FloorApp.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import type {
  DeviceShift,
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type {
  CodeCheck,
  DeviceShift,
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  HostStatus,
} from "../host/protocol.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
  HostStatus,
  SsccBlock,
  SsccBlockRequest,
} from "../host/protocol.js";
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  lineChangePending: boolean;
  /** `HostApi.enterShift`. */
  enter: (shiftId: string) => Promise<EnteredShift>;
  /** `HostApi.createDeviceShift`. */
  create: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  /** The floor's scanner: a new shift's product is chosen by a scan. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
  lineChangePending: boolean;
  /**
   * The host refused this device while the operator works (`pendingRejection`,
   * question В8): the link is stopped, and the work screen asks the host nothing.
   */
  rejectionPending: boolean;
  /** `HostApi.enterShift`. */
  enter: (shiftId: string) => Promise<EnteredShift>;
  /** `HostApi.createDeviceShift`. */
  create: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  /** `HostApi.checkCode`: the work screen's check of a code on the host. */
  checkCode: (codeHash: string) => Promise<CodeCheck>;
  /** `HostApi.requestSsccBlock`: the work screen's serials for its boxes. */
  requestBlock: (request: SsccBlockRequest) => Promise<SsccBlock>;
  /** The link's delivery of the outbox, asked after every local write (`useHostLink`). */
  requestFacts: () => void;
  /** The floor's scanner: a new shift's product is chosen by a scan. */
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  lineChangePending,
  enter,
  create,
  source,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  lineChangePending,
  rejectionPending,
  enter,
  create,
  checkCode,
  requestBlock,
  requestFacts,
  source,
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
  const { sessionId } = operator;
  const online = link?.state === "online";
  const [view, setView] = useState<FloorView>({ kind: "list", notice: null });
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const { sessionId } = operator;
  // A refusal that waits for the operator stops the link: nothing more goes to that host.
  const online = link?.state === "online" && !rejectionPending;
  const [view, setView] = useState<FloorView>({ kind: "list", notice: null });
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
    if (action !== null) current.current.dispatch(action);
  }, []);

  if (view.kind === "work") {
```

заменить на:

<!-- prettier-ignore -->
```tsx
    if (action !== null) current.current.dispatch(action);
  }, []);
  // A record written: the status bar reads its counts again, and the outbox goes.
  const recorded = useCallback(() => {
    current.current.dispatch({ type: "outbox_changed" });
    requestFacts();
  }, [requestFacts]);

  if (view.kind === "work") {
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
        onLeave={() => leave({ kind: "list", notice: null })}
      />
```

заменить на:

<!-- prettier-ignore -->
```tsx
        onLeave={() => leave({ kind: "list", notice: null })}
        source={source}
        checkCode={checkCode}
        requestBlock={requestBlock}
        onHostError={hostError}
        onRecorded={recorded}
      />
```

Заменить целиком `apps/standalone/src/floor/work/WorkScreen.tsx`:

<!-- prettier-ignore -->
```tsx
import { formatSsccHri } from "@markiro/domain";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, SignalOverlay, type SignalTone } from "@markiro/ui";

import type { FloorSession } from "../../app/shell.js";
import type { CodeCheck, SsccBlock, SsccBlockRequest } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { ScanSource } from "../scan-source.js";
import type { WorkShift } from "../shifts/shift-copies.js";
import { formatQuantity } from "../shifts/shift-text.js";
import { createBlockSupply, type SupplyResult } from "./block-supply.js";
import { closeIfFull, closeOpenBox, type CloseResult } from "./box-close.js";
import { processScan, type ScanContext, type ScanOutcome } from "./scan-pipeline.js";
import { playSignalTone } from "./signal-sound.js";
import { createWorkQueue } from "./work-queue.js";
import { readWorkTotals, type WorkTotals } from "./work-reads.js";

/**
 * What the floor gives the work screen of a shift (the contract plans 2a6–2a8
 * build on): the shift with the snapshot this build read, the session, the
 * pairing whose rows it writes, the local database and the link; `track`
 * holds the leave until a piece of work settles; `touch` restarts the
 * operator's idle wait (a COM scanner presses no key); `onLeave` asks to go
 * back to the list, which the floor does once the tracked work has settled,
 * and `leaving` says it is waiting for that. Plan 2a6 adds the scanner, the
 * host's code check and blocks, the shell's handling of a refused key and
 * the outbox's delivery after a write.
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
  /** The floor's scanner: the keyboard and the COM scanners. */
  source: ScanSource;
  /** `HostApi.checkCode` (300 ms). */
  checkCode: (codeHash: string) => Promise<CodeCheck>;
  /** `HostApi.requestSsccBlock`. */
  requestBlock: (request: SsccBlockRequest) => Promise<SsccBlock>;
  /** A failed host call the shell may act on: a refused key, another certificate. */
  onHostError: (error: unknown) => void;
  /** A local write: the status bar reads its counts again, and the outbox goes. */
  onRecorded: () => void;
  /** The tone of a verdict; the generated tones by default. */
  signal?: (tone: SignalTone) => void;
}

/** What stops the scanning until the operator acts (stage 2a spec §5.7.3). */
type Stop =
  | { kind: "system_error" }
  | { kind: "confirm_close" }
  | { kind: "no_serials"; reason: "offline" | "exhausted" | "failed"; full: boolean }
  | { kind: "close_failed"; full: boolean };

/** The last scan, said in words under the box. */
type Last = ScanOutcome | { kind: "paused"; leaving: boolean };

/** How long the coloured flash of a verdict covers the screen. */
export const SIGNAL_MS = 700;

/** A close again on `stale` (nothing was written: the box or the block changed meanwhile). */
async function closeSettled(close: () => Promise<CloseResult | null>): Promise<CloseResult | null> {
  let result = await close();
  for (let attempt = 1; attempt < 3 && result?.kind === "stale"; attempt += 1) {
    result = await close();
  }
  return result;
}

const TIME = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** The time of a scan, on this computer's clock. */
export function scanTime(iso: string): string {
  return TIME.format(new Date(iso));
}

/** The last scan in words. */
function lastText(last: Last, t: TFunction, capacity: number): string {
  switch (last.kind) {
    case "accepted":
      return t("floor.work.last.accepted", {
        quantity: formatQuantity(last.itemCount),
        capacity: formatQuantity(capacity),
      });
    case "duplicate":
      return last.source === "local"
        ? t("floor.work.last.duplicateLocal", { time: scanTime(last.firstScannedAt) })
        : t("floor.work.last.duplicateHost", {
            number: last.shiftNumber,
            time: scanTime(last.firstScannedAt),
          });
    case "wrong_gtin":
      return t("floor.work.last.wrongGtin", { gtin: last.gtin14 });
    case "invalid":
      return t(`floor.work.last.invalid.${last.rawKind}`);
    case "paused":
      return t(last.leaving ? "floor.work.last.leaving" : "floor.work.last.paused");
  }
}

/**
 * The work screen of a shift (stage 2a spec §5.7.3–5.7.4): scans of the floor's
 * scanner go through the pipeline one at a time (`createWorkQueue`), each
 * handed to the floor's work gate (`track`), so leaving waits for it. A box
 * closes by itself when it holds the shift's capacity, and an incomplete one
 * after the operator confirms; a closed box asks the host for serials by the
 * half rule, as do the entry and the link coming back. While a message stops
 * the work — a failed write, no serials, a close to confirm — or the operator
 * leaves, a scan is not taken and the screen says so: nothing is dropped
 * silently. Every verdict shows in words, as a flash and as a tone.
 */
export function WorkScreen({
  shift,
  operator,
  pairing,
  local,
  online,
  track,
  touch,
  onLeave,
  leaving,
  source,
  checkCode,
  requestBlock,
  onHostError,
  onRecorded,
  signal = playSignalTone,
}: WorkScreenProps) {
  const { t } = useTranslation();
  // The floor gives a new pairing object with every render: the work keys on its ids.
  const { hostId, deviceId } = pairing;
  const where = useMemo(() => ({ hostId, deviceId }), [hostId, deviceId]);
  const [totals, setTotals] = useState<WorkTotals | null>(null);
  const [last, setLast] = useState<Last | null>(null);
  const [flash, setFlash] = useState<{ tone: SignalTone; title: string } | null>(null);
  const [stop, setStopState] = useState<Stop | null>(null);
  const [planReached, setPlanReached] = useState(false);
  const capacity = shift.copy.boxCapacity;
  const plannedQty = shift.copy.plannedQty;

  // What a queued job reads when it runs, later than the render that queued it.
  const live = useRef({ online, leaving, touch, track, onHostError, onRecorded, signal, t });
  useLayoutEffect(() => {
    live.current = { online, leaving, touch, track, onHostError, onRecorded, signal, t };
  });
  // Read by the job in its turn, before React renders the stop it set.
  const stopRef = useRef<Stop | null>(null);
  const setStop = useCallback((next: Stop | null) => {
    stopRef.current = next;
    setStopState(next);
  }, []);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const planShown = useRef(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  const queue = useMemo(() => createWorkQueue(), []);
  const context = useMemo<ScanContext>(
    () => ({
      local,
      pairing: where,
      shift,
      operatorId: operator.id,
      online: () => live.current.online,
      checkCode,
      onHostError: (error) => live.current.onHostError(error),
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
    }),
    [local, where, shift, operator.id, checkCode],
  );
  const supply = useMemo(
    () =>
      createBlockSupply({
        local,
        pairing: where,
        issuerPrefix: shift.snapshot.issuerPrefix,
        online: () => live.current.online,
        requestBlock,
        onHostError: (error) => live.current.onHostError(error),
        now: () => new Date(),
        newId: () => crypto.randomUUID(),
      }),
    [local, where, shift.snapshot.issuerPrefix, requestBlock],
  );

  const refresh = useCallback(async () => {
    const next = await readWorkTotals(local, where, shift.copy.id);
    if (alive.current) setTotals(next);
    return next;
  }, [local, where, shift.copy.id]);

  const show = useCallback((tone: SignalTone, title: string) => {
    live.current.signal(tone);
    if (!alive.current) return;
    setFlash({ tone, title });
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null;
      if (alive.current) setFlash(null);
    }, SIGNAL_MS);
  }, []);

  /**
   * Closes the box — the full one, or the open one the operator confirmed —
   * and when the serials ran out asks the host for a block and tries once
   * more. What is left stops the work with its reason.
   */
  const closeBox = useCallback(
    async (full: boolean): Promise<void> => {
      const close = () => (full ? closeIfFull(context) : closeOpenBox(context));
      let result = await closeSettled(close);
      let supplied: SupplyResult | null = null;
      if (result?.kind === "no_serials") {
        supplied = await supply.topUp();
        if (supplied.kind === "stored") {
          live.current.onRecorded();
          result = await closeSettled(close);
        }
      }
      if (result === null || result.kind === "empty") return;
      if (result.kind === "closed") {
        live.current.onRecorded();
        // The half rule after every close: work of its own, not the line's.
        void live.current.track(supply.topUp()).then(
          (topped) => {
            if (topped.kind === "stored") live.current.onRecorded();
          },
          () => undefined,
        );
        return;
      }
      if (result.kind === "no_serials") {
        const reason =
          supplied === null || supplied.kind === "stored" || supplied.kind === "enough"
            ? "failed"
            : supplied.kind;
        setStop({ kind: "no_serials", reason, full });
        return;
      }
      setStop({ kind: "close_failed", full });
    },
    [context, supply, setStop],
  );

  const settle = useCallback(
    async (outcome: ScanOutcome): Promise<void> => {
      const say = live.current.t;
      setLast(outcome);
      if (outcome.kind === "accepted") {
        show("ok", say("floor.work.signal.ok"));
        if (outcome.itemCount >= capacity) await closeBox(true);
        const next = await refresh();
        if (plannedQty !== null && !planShown.current && next.accepted >= plannedQty) {
          planShown.current = true;
          if (alive.current) setPlanReached(true);
        }
        return;
      }
      if (outcome.kind === "duplicate") {
        show("duplicate", say("floor.work.signal.duplicate"));
        return;
      }
      show(
        "error",
        say(
          outcome.kind === "wrong_gtin"
            ? "floor.work.signal.wrongGtin"
            : "floor.work.signal.invalid",
        ),
      );
    },
    [capacity, plannedQty, closeBox, refresh, show],
  );

  /** One scan, in its turn: taken only while nothing stops the work. */
  const scan = useCallback(
    async (raw: string): Promise<void> => {
      if (stopRef.current !== null) {
        setLast({ kind: "paused", leaving: false });
        show("error", live.current.t("floor.work.signal.paused"));
        return;
      }
      let outcome: ScanOutcome;
      try {
        outcome = await processScan(context, raw);
      } catch {
        setStop({ kind: "system_error" });
        show("error", live.current.t("floor.work.signal.systemError"));
        return;
      }
      live.current.onRecorded();
      await settle(outcome);
    },
    [context, settle, setStop, show],
  );

  const scanRef = useRef(scan);
  useLayoutEffect(() => {
    scanRef.current = scan;
  });
  useEffect(
    () =>
      source.start((raw) => {
        const current = live.current;
        current.touch();
        if (current.leaving) {
          setLast({ kind: "paused", leaving: true });
          show("error", current.t("floor.work.signal.paused"));
          return;
        }
        void current.track(queue.run(() => scanRef.current(raw))).catch(() => undefined);
      }),
    [source, queue, show],
  );

  // On entry: the numbers, and a box a stopped station left full closes first.
  useEffect(() => {
    void track(
      queue.run(async () => {
        await refresh();
        await closeBox(true);
        await refresh();
      }),
    ).catch(() => setStop({ kind: "system_error" }));
  }, [track, queue, refresh, closeBox, setStop]);

  // On entry and whenever the link is back: serials by the half rule; a
  // close that waited for them goes again.
  useEffect(() => {
    if (!online) return;
    void track(
      supply.topUp().then(async (topped) => {
        if (topped.kind !== "stored") return;
        live.current.onRecorded();
        const waiting = stopRef.current;
        if (waiting?.kind !== "no_serials") return;
        await live.current.track(
          queue.run(async () => {
            setStop(null);
            await closeBox(waiting.full);
            await refresh();
          }),
        );
      }),
    ).catch(() => setStop({ kind: "system_error" }));
  }, [online, track, supply, queue, closeBox, refresh, setStop]);

  /** Runs a close as the line's next piece of work. */
  const closeNow = (full: boolean) => {
    setStop(null);
    void track(
      queue.run(async () => {
        await closeBox(full);
        await refresh();
      }),
    ).catch(() => setStop({ kind: "system_error" }));
  };

  const openBox = totals?.openBox ?? null;
  const items = openBox?.itemCount ?? 0;
  const canClose = items > 0 && stop === null && !leaving;

  return (
    <Card
      className="standalone-card work-screen"
      title={t("floor.work.title", { number: shift.copy.number })}
      titleAs="h2"
    >
      <div className="standalone-form">
        <p className="shift-card__product">
          {t("floor.work.product", {
            name: shift.snapshot.product.name,
            gtin: shift.snapshot.product.gtin14,
          })}
        </p>
        <dl className="work-screen__facts">
          <div>
            <dt>{t("floor.work.box")}</dt>
            <dd>
              {items === 0
                ? t("floor.work.boxEmpty")
                : t("floor.work.boxItems", {
                    quantity: formatQuantity(items),
                    capacity: formatQuantity(capacity),
                  })}
            </dd>
          </div>
          <div>
            <dt>{t("floor.work.accepted")}</dt>
            <dd>{formatQuantity(totals?.accepted ?? 0)}</dd>
          </div>
          <div>
            <dt>{t("floor.work.closedBoxes")}</dt>
            <dd>{formatQuantity(totals?.closedBoxes ?? 0)}</dd>
          </div>
          <div>
            <dt>{t("floor.work.plan")}</dt>
            <dd>{plannedQty === null ? t("floor.work.noPlan") : formatQuantity(plannedQty)}</dd>
          </div>
          {totals !== null && totals.lastSscc !== null && (
            <div>
              <dt>{t("floor.work.lastSscc")}</dt>
              <dd>{formatSsccHri(totals.lastSscc)}</dd>
            </div>
          )}
        </dl>
        <p className="work-screen__last" aria-live="polite">
          {last === null ? t("floor.work.waiting") : lastText(last, t, capacity)}
        </p>
        {stop?.kind === "system_error" && (
          <Alert
            tone="error"
            title={t("floor.work.systemError.title")}
            action={
              <Button size="floor" variant="secondary" onClick={() => setStop(null)}>
                {t("floor.work.systemError.dismiss")}
              </Button>
            }
          >
            {t("floor.work.systemError.body")}
          </Alert>
        )}
        {stop?.kind === "no_serials" && (
          <Alert
            tone="warn"
            title={t("floor.work.noSerials.title")}
            action={
              <Button size="floor" variant="secondary" onClick={() => closeNow(stop.full)}>
                {t("floor.work.retry")}
              </Button>
            }
          >
            {t(`floor.work.noSerials.${stop.reason}`)}
          </Alert>
        )}
        {stop?.kind === "close_failed" && (
          <Alert
            tone="error"
            title={t("floor.work.closeFailed.title")}
            action={
              <Button size="floor" variant="secondary" onClick={() => closeNow(stop.full)}>
                {t("floor.work.retry")}
              </Button>
            }
          >
            {t("floor.work.closeFailed.body")}
          </Alert>
        )}
        {planReached && (
          <Alert
            tone="ok"
            title={t("floor.work.planReached", {
              quantity: formatQuantity(totals?.accepted ?? 0),
              planned: formatQuantity(plannedQty ?? 0),
            })}
            action={
              <Button size="floor" variant="secondary" onClick={() => setPlanReached(false)}>
                {t("floor.work.continue")}
              </Button>
            }
          />
        )}
        {stop?.kind === "confirm_close" ? (
          <div className="work-screen__confirm">
            <p>
              {t("floor.work.confirmClose", {
                quantity: formatQuantity(items),
                capacity: formatQuantity(capacity),
              })}
            </p>
            <div className="standalone-form__actions">
              <Button size="floor" variant="secondary" onClick={() => setStop(null)}>
                {t("floor.work.keepFilling")}
              </Button>
              <Button size="floor" onClick={() => closeNow(false)}>
                {t("floor.work.closeBox")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="standalone-form__actions">
            <Button
              size="floor"
              variant="secondary"
              disabled={!canClose}
              onClick={() => setStop({ kind: "confirm_close" })}
            >
              {t("floor.work.closeBox")}
            </Button>
            <Button size="floor" variant="secondary" disabled={leaving} onClick={onLeave}>
              {t("floor.work.leave")}
            </Button>
          </div>
        )}
        {leaving && <p aria-live="polite">{t("floor.work.leaving")}</p>}
      </div>
      {flash !== null && <SignalOverlay tone={flash.tone} title={flash.title} />}
    </Card>
  );
}
```

Создать `apps/standalone/src/floor/work/signal-sound.ts`:

<!-- prettier-ignore -->
```ts
import type { SignalTone } from "@markiro/ui";

/**
 * Pitch and length of each verdict's tone (the cloud station's
 * `signal-sound.ts`): generated, not loaded — the station has no audio
 * files and fetches nothing — and distinct enough that the sound alone tells
 * a duplicate from an error while the operator watches the line, not the
 * screen. The volume and muting of the workstation's setup are plan 2a7's.
 */
export const TONES: Record<SignalTone, { hz: number; seconds: number; type: OscillatorType }> = {
  ok: { hz: 880, seconds: 0.12, type: "sine" },
  error: { hz: 220, seconds: 0.45, type: "square" },
  duplicate: { hz: 440, seconds: 0.3, type: "triangle" },
};

/**
 * One context for the page's life: WebView2, like Chromium, caps the audio
 * contexts a page may hold, and a new one per scan would run out after a few
 * tones and fall silent.
 */
let cached: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (cached !== null) return cached;
  // jsdom, and a webview without sound, have no `AudioContext` at all.
  cached = typeof AudioContext === "undefined" ? null : new AudioContext();
  return cached;
}

/**
 * Plays a verdict's tone. Never throws: a station without working sound
 * keeps scanning, and the screen says the verdict in words and colour too.
 */
export function playSignalTone(
  tone: SignalTone,
  context: () => AudioContext | null = audioContext,
): void {
  try {
    const audio = context();
    if (audio === null) return;
    if (audio.state === "suspended") {
      // A kiosk's first touch may come after its first scan; resuming is
      // best effort, and the tone is tried anyway.
      audio.resume().catch(() => undefined);
    }
    const spec = TONES[tone];
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = spec.type;
    oscillator.frequency.setValueAtTime(spec.hz, audio.currentTime);
    gain.gain.setValueAtTime(1, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + spec.seconds);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + spec.seconds);
  } catch {
    // Sound is a second channel; the screen carries the verdict on its own.
  }
}
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
      "title": "Смена {{number}}",
      "stub": "Сканирование кодов и сборка коробов появятся в следующем обновлении приложения.",
      "leaving": "Дожидаемся окончания начатой работы…",
```

заменить на:

<!-- prettier-ignore -->
```json
      "title": "Смена {{number}}",
      "product": "{{name}} · GTIN {{gtin}}",
      "box": "Открытый короб",
      "boxEmpty": "Короб откроется с первым кодом",
      "boxItems": "{{quantity}} из {{capacity}}",
      "accepted": "Принято в смене",
      "closedBoxes": "Коробов закрыто",
      "plan": "План",
      "noPlan": "План не указан",
      "lastSscc": "Последний короб",
      "waiting": "Отсканируйте код маркировки.",
      "last": {
        "accepted": "Принято: в коробе {{quantity}} из {{capacity}}.",
        "duplicateLocal": "Дубль: этот код уже принят в {{time}}.",
        "duplicateHost": "Дубль: код принят в смене {{number}} в {{time}}.",
        "wrongGtin": "Чужой товар: GTIN {{gtin}}.",
        "invalid": {
          "gtin": "Это GTIN товара, а не код маркировки.",
          "sscc": "Это код короба, а не код маркировки.",
          "unknown": "Это не код маркировки."
        },
        "paused": "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.",
        "leaving": "Скан не принят: идёт выход из смены."
      },
      "signal": {
        "ok": "ПРИНЯТО",
        "duplicate": "ДУБЛЬ",
        "wrongGtin": "ЧУЖОЙ ТОВАР",
        "invalid": "НЕВЕРНЫЙ КОД",
        "paused": "НЕ ПРИНЯТО",
        "systemError": "ОШИБКА ЗАПИСИ"
      },
      "systemError": {
        "title": "Скан не записан",
        "body": "Не удалось записать скан в базу этого компьютера, и код не принят. Закройте сообщение и отсканируйте код снова. Если ошибка повторяется, обратитесь к администратору.",
        "dismiss": "Понятно"
      },
      "noSerials": {
        "title": "Нет номеров SSCC: короб не закрыт",
        "offline": "Номера выдаёт хост, а связи с ним нет. Короб закроется, как только номера придут.",
        "exhausted": "Номера SSCC префикса организации закончились. Обратитесь к администратору.",
        "failed": "Хост не выдал номера. Повторите или обратитесь к администратору."
      },
      "closeFailed": {
        "title": "Короб не закрыт",
        "body": "Номер SSCC из блока станции вне диапазона префикса и пропущен. Повторите закрытие."
      },
      "retry": "Повторить",
      "planReached": "План выполнен: принято {{quantity}} из {{planned}}.",
      "continue": "Продолжить",
      "confirmClose": "Закрыть неполный короб? В коробе {{quantity}} из {{capacity}}.",
      "keepFilling": "Продолжить сборку",
      "closeBox": "Закрыть короб",
      "leaving": "Дожидаемся окончания начатой работы…",
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx test/floor-work-screen.test.tsx test/signal-sound.test.ts`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  37 passed (37)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  96 passed (96)`, `Tests  2322 passed (2322)` (на настоящем дереве — больше на тесты, которых на копии нет).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — скан не отдаётся воротам работы. В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        void current.track(queue.run(() => scanRef.current(raw))).catch(() => undefined);
```

заменить на:

<!-- prettier-ignore -->
```tsx
        void queue.run(() => scanRef.current(raw)).catch(() => undefined);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-screen.test.tsx`
Expected: FAIL — «hands a scan on its way to the floor's gate, so a leave waits for it».

М2 — скан не трогает таймер бездействия. В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        current.touch();
        if (current.leaving) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
        if (current.leaving) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-screen.test.tsx`
Expected: FAIL — «takes the scans into the open box, with their numbers, a tone and a touch each».

М3 — скан во время выхода из смены принимается. В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        if (current.leaving) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
        if (current.leaving && false) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-screen.test.tsx`
Expected: FAIL — «takes no scan while the operator leaves, and lets nobody press leave twice».

М4 — скан при сообщении на экране принимается. В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      if (stopRef.current !== null) {
        setLast({ kind: "paused", leaving: false });
```

заменить на:

<!-- prettier-ignore -->
```tsx
      if (stopRef.current !== null && false) {
        setLast({ kind: "paused", leaving: false });
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-screen.test.tsx`
Expected: FAIL — «closes an incomplete box only once the operator confirms, and takes no scan meanwhile», «stops without serials, says why, and closes the box once the link brings a block», «stops the line on a failed write until the operator closes the message».

М5 — короб закрывается только сверх вместимости. В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        if (outcome.itemCount >= capacity) await closeBox(true);
```

заменить на:

<!-- prettier-ignore -->
```tsx
        if (outcome.itemCount > capacity) await closeBox(true);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-screen.test.tsx`
Expected: FAIL — «closes a full box by itself with the next SSCC, and begins the next box».

М6 — полный короб при входе не закрывается. В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        await refresh();
        await closeBox(true);
        await refresh();
      }),
    ).catch(() => setStop({ kind: "system_error" }));
  }, [track, queue, refresh, closeBox, setStop]);
```

заменить на:

<!-- prettier-ignore -->
```tsx
        await refresh();
      }),
    ).catch(() => setStop({ kind: "system_error" }));
  }, [track, queue, refresh, closeBox, setStop]);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-screen.test.tsx`
Expected: FAIL — «closes first a box a stopped station left full, then asks for serials while online».

М7 — пришедший блок не закрывает ждущий короб. В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        if (waiting?.kind !== "no_serials") return;
```

заменить на:

<!-- prettier-ignore -->
```tsx
        if (waiting?.kind !== "no_serials" || true) return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-screen.test.tsx`
Expected: FAIL — «stops without serials, says why, and closes the box once the link brings a block».

М8 — уведомление о плане каждый раз. В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        if (plannedQty !== null && !planShown.current && next.accepted >= plannedQty) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
        if (plannedQty !== null && next.accepted >= plannedQty) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-screen.test.tsx`
Expected: FAIL — «says once that the plan is reached».

М9 — уведомление о плане на код раньше. В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        if (plannedQty !== null && !planShown.current && next.accepted >= plannedQty) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
        if (plannedQty !== null && !planShown.current && next.accepted >= plannedQty - 1) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-screen.test.tsx`
Expected: FAIL — «says once that the plan is reached».

М10 — о записи скана оболочка не узнаёт. В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      live.current.onRecorded();
      await settle(outcome);
```

заменить на:

<!-- prettier-ignore -->
```tsx
      await settle(outcome);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-screen.test.tsx`
Expected: FAIL — «takes the scans into the open box, with their numbers, a tone and a touch each».

М11 — сбой записи не останавливает линию. В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      } catch {
        setStop({ kind: "system_error" });
```

заменить на:

<!-- prettier-ignore -->
```tsx
      } catch {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-screen.test.tsx`
Expected: FAIL — «stops the line on a failed write until the operator closes the message».

М12 — неполный короб закрывается без подтверждения. В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
              onClick={() => setStop({ kind: "confirm_close" })}
```

заменить на:

<!-- prettier-ignore -->
```tsx
              onClick={() => closeNow(false)}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-screen.test.tsx`
Expected: FAIL — «closes an incomplete box only once the operator confirms, and takes no scan meanwhile».

М13 — ждущий отказ не отключает экран от хоста. В `apps/standalone/src/floor/FloorApp.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  const online = link?.state === "online" && !rejectionPending;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const online = link?.state === "online";
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx`
Expected: FAIL — «gets the scanner, the host's calls, and a link that a waiting refusal stops».

М14 — запись не запускает доставку. В `apps/standalone/src/floor/FloorApp.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    requestFacts();
  }, [requestFacts]);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }, [requestFacts]);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx`
Expected: FAIL — «gets the scanner, the host's calls, and a link that a waiting refusal stops».

М15 — спящий контекст звука не будится. В `apps/standalone/src/floor/work/signal-sound.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
      audio.resume().catch(() => undefined);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/signal-sound.test.ts`
Expected: FAIL — «wakes a sleeping context and plays anyway».

М16 — дубль звучит как «принято». В `apps/standalone/src/floor/work/signal-sound.ts` фрагмент

<!-- prettier-ignore -->
```ts
  duplicate: { hz: 440, seconds: 0.3, type: "triangle" },
```

заменить на:

<!-- prettier-ignore -->
```ts
  duplicate: { hz: 880, seconds: 0.3, type: "triangle" },
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/signal-sound.test.ts`
Expected: FAIL — «plays each verdict at its own pitch and length».

М17 — сбой звука выходит наружу. В `apps/standalone/src/floor/work/signal-sound.ts` фрагмент

<!-- prettier-ignore -->
```ts
  } catch {
    // Sound is a second channel; the screen carries the verdict on its own.
  }
```

заменить на:

<!-- prettier-ignore -->
```ts
  } finally {
    // Sound is a second channel; the screen carries the verdict on its own.
  }
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/signal-sound.test.ts`
Expected: FAIL — «is silent, and throws nothing, without sound».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/app/App.tsx apps/standalone/src/app/shell.css apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/floor/work/signal-sound.ts apps/standalone/src/i18n/ru.json apps/standalone/test/floor-app.test.tsx apps/standalone/test/floor-work-screen.test.tsx apps/standalone/test/signal-sound.test.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-app.test.tsx test/floor-work-screen.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/floor-app.test.tsx test/floor-work-screen.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/app/App.tsx apps/standalone/src/app/shell.css apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/floor/work/signal-sound.ts apps/standalone/src/i18n/ru.json apps/standalone/test/floor-app.test.tsx apps/standalone/test/floor-work-screen.test.tsx apps/standalone/test/signal-sound.test.ts
git commit -m "feat(standalone): the work screen scans into boxes, with words, flashes and tones" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Сквозной тест «хост пропал — линия работает — всё досылается», документы

Тест приложения проводит оператора в смену, обрывает связь, сканирует три кода клавиатурным сканером (коды с префиксом AIM, GS и хвостом), видит на строке состояния «Не отправлено» 3, восстанавливает связь и проверяет, что последняя отправка несёт все три записи в порядке сканов, а «Не отправлено» стало 0. Тест проверяет то, что собрали задачи 1–8, поэтому проходит сразу; что он ловит поломку досылки, показывает мутация шага 5. Документы: раздел «Floor work» и ручной список в `AGENTS.md`, раздел «Уточнения плана 2a6» в спецификации этапа.

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`
- Test: `apps/standalone/test/app.test.tsx` (Modify)

**Interfaces:**

- Consumes: всё задач 1–8; `km` (задача 3).
- Produces:
  - документы: `apps/standalone/AGENTS.md` («App shell» — строка о рабочем экране, «Floor work», «Verification»), спецификация этапа (раздел «Уточнения плана 2a6»).

- [ ] **Step 1: Написать тест**

Правка `apps/standalone/test/app.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { fakeHostApi, ORG_PROFILE } from "./support/office.js";
import { completeWizard, EXPECTED_REQUEST } from "./support/wizard.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { fakeHostApi, ORG_PROFILE } from "./support/office.js";
import { km } from "./support/floor-work.js";
import { completeWizard, EXPECTED_REQUEST } from "./support/wizard.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
  });
});

/**
```

заменить на:

<!-- prettier-ignore -->
```tsx
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
  });
  it("keeps scanning while the host is away, and sends every record in order once it is back", async () => {
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    host.getDeviceShifts.mockResolvedValue([PLANNED]);
    host.enterShift.mockResolvedValue(OPENED);
    host.requestSsccBlock.mockImplementation(async (request) => ({
      id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      issuerPrefix: request.issuerPrefix,
      extension: request.extension,
      fromSerial: 1500,
      toSerial: 3499,
    }));
    host.sendFacts.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "host away" }),
    );
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
    });
    await screen.findByText(PROMPT);
    scan("MRK-000742");
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
    await link.status({ state: "offline", lastContactAt: 1, lastError: "unreachable", seq: 2 });
    const bar = screen.getByRole("region", { name: "Строка состояния цеха" });
    const unsent = () => within(bar).getByText("Не отправлено").nextElementSibling?.textContent;
    for (const serial of ["A1", "A2", "A3"]) {
      scan(km(serial));
      await screen.findByText(`Принято: в коробе ${serial.slice(1)} из 12.`);
    }
    await waitFor(() => expect(unsent()).toBe("3"));
    host.sendFacts.mockImplementation(async (records) =>
      records.map((record) => ({
        id: (record as { id: string }).id,
        outcome: "accepted" as const,
      })),
    );
    await link.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(unsent()).toBe("0"));
    const sent = host.sendFacts.mock.calls.at(-1)?.[0] ?? [];
    expect(
      sent.map((record) => {
        const { kind, data } = record as { kind: string; data: { code: { serial: string } } };
        return [kind, data.code.serial];
      }),
    ).toEqual([
      ["scan", "A1"],
      ["scan", "A2"],
      ["scan", "A3"],
    ]);
  });
});

/**
```

- [ ] **Step 2: Тест проходит сразу**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  99 passed (99)`: тест проверяет собранное задачами 1–8; что он ловит поломку досылки, показывает мутация шага 4.

- [ ] **Step 3: Документы**

Правка `apps/standalone/AGENTS.md`:

Фрагмент 1:

<!-- prettier-ignore -->
````markdown
(`src/floor/shifts/ShiftList.tsx`), a new shift (`NewShift.tsx`) and the work
screen of the shift entered (`src/floor/work/WorkScreen.tsx`, a placeholder
plan 2a6 fills). `App` keys it by the session, so nothing of one operator's
screen outlives their sign-out. The list shows this pairing's copies of the
````

заменить на:

<!-- prettier-ignore -->
````markdown
(`src/floor/shifts/ShiftList.tsx`), a new shift (`NewShift.tsx`) and the work
screen of the shift entered (`src/floor/work/WorkScreen.tsx`: scanning and
boxes, see "Floor work"). `App` keys it by the session, so nothing of one operator's
screen outlives their sign-out. The list shows this pairing's copies of the
````

Фрагмент 2:

<!-- prettier-ignore -->
````markdown
(`isExhausted`, `src/office/sscc/counter-kind.ts`).

## Marking rules
````

заменить на:

<!-- prettier-ignore -->
````markdown
(`isExhausted`, `src/office/sscc/counter-kind.ts`).

## Floor work

Stage 2a, plan 2a6 (`src/floor/work`). The work screen of a shift
(`WorkScreen.tsx`) reads the floor's scan source — the keyboard wedge and the
shell's COM scanners at once (`mergeScanSources`, `createComScanSource`; the
spec's decision 25 chose one by the setup, and reading both needs no setup) —
and hands every scan to a queue that runs one job at a time
(`work-queue.ts`, the cloud's `scan-queue.ts`), each job given to the floor's
work gate (`track`), so leaving the shift waits for it. Every COM scan
touches the idle wait (`touch`): a COM scanner presses no key.

A scan (`scan-pipeline.ts`, `processScan`) is read once by the domain
(`readScan` over `classifyScan`: the AIM prefixes go, the group separators
and the crypto tail stay). A GTIN, an SSCC or anything else is `invalid` and
keeps only its kind and length, never its text (a badge is a secret; plan
2a7 reads a label's SSCC before the pipeline); a code whose serial is longer
than the host keeps (64 bytes, `HOST_MAX_SERIAL_BYTES`) reads as unknown. A
code of another product is `wrong_gtin`. A code this pairing holds in any
box (`floor_codes`) is a local duplicate with the time of its first scan,
without asking the host. Otherwise, while the link is `online`, the host is
asked within 300 ms (`HostApi.checkCode`, `CODE_CHECK_TIMEOUT_MS`): another
device's scan that owns it is a host duplicate with that shift's number; no
answer, a failure, `free` or this station's own scan (its own registry is
newer: an undo not yet sent) let the scan through, and a refused key goes to
the shell. An accepted code goes into the shift's open box, which opens with
it, in ONE `local_transaction` with its place in `floor_codes`, its journal
row (`floor_scans`) and its `scan` record in the outbox (`outboxStatement`,
which checks the record against `factRecordSchema` and its size against
`MAX_RECORD_BYTES`, 16 KiB, so that 100 records never pass the host's 2 MiB
body limit, and keeps it whole as the payload it is sent as). The key of `floor_codes` keeps a code in one box of
the pairing at most: a second accept that the check missed fails whole with
`changes_mismatch`, and a box closed while the scan was on its way fails it
too. Refused scans are journalled with their record the same way. A failed
write is a system error: the scan is not taken, and the work stops until the
operator closes the message.

A box (`box-close.ts`, `closeOpenBox`) closes with the next serial of the
earliest block of the snapshot's issuer prefix and the box extension `0`
that has one, its SSCC by the domain's `buildSscc`, in ONE transaction: the
serial spent by comparing the block's cursor with the value read
(`UPDATE … WHERE block_id = ? AND next_serial = ?`, `expectedChanges: 1`),
the box closed only while it is open with the count read, its `box_closed`
record (`boxMembershipDigestV1` of its codes) and what later plans add
(`CloseStep` → `CloseAddition`: statements committed after the close, and
fields of the record, whose own fields win — plan 2a7's print job, the
pallets' plan's joining of the open pallet). A guard that no longer holds is
`stale`: nothing written, tried again. A serial past what the prefix can
number is spent and the box stays open (`invalid_serial`, as in the cloud).
An empty box spends nothing. A box closes by itself once it holds the
shift's capacity (`closeIfFull`, after every accepted scan and when the
screen opens: a station stopped between the scan that filled a box and its
close finds it full), and an incomplete one after the operator confirms.

Serials come by the half rule (`block-supply.ts`, `createBlockSupply`):
when the screen opens, after every close and when the link comes back, a
block is asked for while the link is online if the pairing has none for the
prefix or the newest has less than half left. The request is kept in
`floor_block_requests` before it is sent and repeated whole until its block
is kept, in the transaction that removes the request; a block of another
prefix or extension than asked is never filed. The host's refusal of a
request as another prefix's (`validation_failed` on `requestId`) drops it and
sends a new one, once; `sscc_exhausted` drops it. One top-up runs at a time.
Without serials the work stops and says why (no link, the prefix exhausted,
the host gave none); a block that arrives closes the box and the work goes
on.

The outbox goes to the host from `useHostLink` (`src/local/facts-sender.ts`,
`sendFactBatch`), a batch at a time: this pairing's oldest records without a
receipt, up to 100, sent as kept, each send counted in `attempts`. The
receipts must answer the records — as many, each with its record's id or
none (matched by its place) — or nothing is kept and the batch goes again.
They are applied in one transaction through `json_each`: the outcome, its
code, its details and the time; a scan's `conflict` sets
`floor_scans.conflict` and its box's `needs_fix`; a `rejected` record stays,
with its code, for the queue screen of the pilot. The host keeps a refusal
for good and answers the same record id with it again, so a refused record
is never sent again under its id: sending it again is a person's act (the
pilot's queue screen) that writes the refused record and its refused
dependents again under new ids, in their order. Any failed send — a
transport failure, a 500 or a 413 the host answers, receipts that do not
fit — keeps every record and sends the same batch, with the same ids,
again; an unacknowledged record is never purged. The shell keeps why the
last send failed (`ShellState.factsFailure`, `factsFailureOf`): the link's
own failure shows on the link's line, the host's and this computer's as
words of their own on the status bar. The link sends after it
subscribes, after every revision event, whenever a screen asks after a
local write (`requestFacts`), right away again after a full batch, and after
a failed send by the sync's waits (2, 4, 8, 16, 32 s, then 60 s) while online
or at once when the link is back; a refused key ends the link. It lives as
long as the link: a refusal that waits for the operator to leave the shift
stops the link and the delivery, and the work screen asks the host nothing
meanwhile (`FloorApp`'s `rejectionPending`). Every local write of the floor
and every batch of receipts dispatch `outbox_changed`
(`ShellState.outboxVersion`), and the status bar reads again the records not
sent, refused and in conflict, and in a shift the SSCC serials left for its
boxes (`src/floor/outbox-status.ts`).

Each verdict shows in words under the box, as a flash (`SignalOverlay`) and as
a generated tone (`signal-sound.ts`; no audio files). While a message stops
the work — a failed write, no serials, a failed close, a close to confirm —
or the operator leaves, a scan is not taken, and the screen says so: nothing
is dropped silently. Printing the box's label is plan 2a7; the exceptions and
the shift's close are plan 2a8.

## Marking rules
````

Фрагмент 3:

<!-- prettier-ignore -->
````markdown
  station to another line and revoking it while the operator is in a shift.
- The Windows service and DPAPI run only in the `standalone-windows-build`
````

заменить на:

<!-- prettier-ignore -->
````markdown
  station to another line and revoking it while the operator is in a shift.
- The floor's work (plan 2a6) by hand, on Windows 10 and 11. None of it has
  been run; check at least:
  - codes of marking with a GS and a crypto tail scanned on the work screen
    by a keyboard-wedge scanner (RU and EN layouts, Caps Lock) and by a COM
    scanner (`]d2` prefix on and off), both plugged in at once;
  - 3–5 scans a second on a factory PC, with the host on this PC and on
    another PC over Wi-Fi (the 300 ms check of a code at its worst);
  - the access point switched off in the middle of a box: the box closes on
    the block the station holds, the status bar counts the unsent records,
    and once the link is back every record reaches the host once (the
    office's totals equal the station's);
  - the PC switched off right after a scan: the code is still there, and a
    full box closes when the work screen opens again;
  - the 2 000th box of a block: a new block arrives before the first runs out
    (the half rule), and without a link the screen says «Нет номеров SSCC»;
  - the tones on the PC's speakers, and the work screen's layout at
    1024 × 768 and 1280 × 800 with the touch panel (64 px controls).
- The Windows service and DPAPI run only in the `standalone-windows-build`
````

Правка `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`:

Фрагмент 1:

<!-- prettier-ignore -->
````markdown
  список за ним перечитывается; лишнюю смену можно удалить, но её номер потрачен.
````

заменить на:

<!-- prettier-ignore -->
````markdown
  список за ним перечитывается; лишнюю смену можно удалить, но её номер потрачен.

## 18. Уточнения плана 2a6

План `docs/superpowers/plans/2026-10-09-standalone-2a6-floor-scanning.md` (цех: сканирование,
короба, номера SSCC, доставка фактов, рабочий экран) уточняет разделы 5.5, 5.7.3, 5.7.4 и 5.7.9
так; допущения по вопросам раздела 11 и спецификации пилота — рекомендованные варианты (если
номер раздела занят, этот раздел получает следующий свободный).

- Источник сканов — клавиатура и COM-сканеры сразу (`mergeScanSources`), а не один по настройке
  (решение 25): станции не нужна настройка, чтобы сканировать, а сканер-клавиатура рядом с
  COM-сканером тоже работает. COM-скан трогает таймер бездействия.
- SSCC в рабочем экране 2a6 — нераспознанный скан (`invalid`, `rawKind: sscc`); проверку этикетки
  план 2a7 ставит перед конвейером. КМ с серией длиннее 64 байт (предел хоста) — `unknown`.
- Ответ хоста `taken` о скане этой же станции (`sameDevice`) не делает дубля: свой реестр
  станции новее (снятие кода могло ещё не дойти до хоста).
- Скан, пришедший, пока работу останавливает сообщение (сбой записи, нет номеров, подтверждение
  неполного короба, сбой закрытия) или идёт выход из смены, не принимается и не пишется в журнал,
  а экран и звук говорят «не принят».
- Номер SSCC вне ёмкости префикса списывается и теряется, короб остаётся открытым; закрытие,
  у которого не сошлась проверка курсора или счётчика короба, ничего не пишет и повторяется.
- Закрытие короба — точка расширения `CloseStep`: план 2a7 добавляет задание печати, план паллет
  ПЛ-Ц — присоединение короба к открытой паллете станции и `palletId` в записи `box_closed`, той
  же транзакцией.
- Дозаказ блока: «самый новый» — с наибольшим `from_serial`; блок, чьи префикс или расширение не
  те, что в запросе, не сохраняется, а запрос выбрасывается; отказ `validation_failed` на
  `requestId` — новый запрос один раз; `sscc_exhausted` — запрос выбрасывается, экран называет
  причину.
- Доставка — планировщик в `useHostLink` (`sendFactBatch`); квитанции сверяются с записями по
  числу и месту, иначе ничего не применяется. После сбоя отправка повторяется паузами
  синхронизации, пока связь `online`, и сразу при возвращении связи; при ждущем отказе
  устройства связь, доставка и обращения рабочего экрана к хосту остановлены.
- Отклонённая запись (`rejected`) получает квитанцию навсегда и под тем же `id` больше не
  отправляется; «Отправить снова» — действие человека на экране очереди пилота (план ОЧ): запись
  и её отклонённые зависимые пишутся заново с новыми `id` в прежнем порядке. Любой сбой отправки
  (транспорт, 500, 413, квитанции, не отвечающие записям) оставляет все записи, и та же пачка с теми
  же `id` уходит снова; неподтверждённые записи не удаляются. Запись больше 16 КиБ не хранится
  (`MAX_RECORD_BYTES`): сто записей не превысят предел тела хоста 2 МиБ. Причина последнего сбоя
  отправки хранится в оболочке (`factsFailure`): сбой связи показывает строка связи, ошибку хоста и
  этого компьютера — отдельные слова строки состояния.
- `protocol_unsupported` на отправке — обычный сбой с повтором (экран «обновите хост» — в
  «Перенесено»): хост и станция пилота ставятся одним установщиком.
- Строка состояния: неотправленных записей, отклонённых и конфликтов — всегда для подключения;
  номеров SSCC — для префикса смены, в которой работает оператор. Числа — с разделителем
  разрядов.
- Предложение закрыть смену при достижении плана — уведомление «План выполнен» один раз за вход в
  рабочий экран; закрытие смены — план 2a8.
````

- [ ] **Step 4: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — при возвращении связи отправка не идёт. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
          if (factFailures > 0 && factRetry === null) factSender.trigger();
        },
```

заменить на:

<!-- prettier-ignore -->
```ts
        },
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx`
Expected: FAIL — «keeps scanning while the host is away, and sends every record in order once it is back».

- [ ] **Step 5: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/test/app.test.tsx docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/app.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/app.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 6: Commit**

```bash
git add apps/standalone/AGENTS.md apps/standalone/test/app.test.tsx docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md
git commit -m "test(standalone): a station scans while the host is away and sends every record once it is back; docs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

1. Полный набор пакета: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — PASS; Vitest на копии плана — 96 файлов, 2323 теста (на настоящем дереве числа сдвигаются на тесты, которых на копии нет). Падение старого теста офиса тайм-аутом под нагрузкой записывается и разбирается (заметки), а не лечится повтором.
2. Rust не меняется: `git diff --stat <основа плана> -- apps/standalone/src-tauri apps/standalone/host apps/standalone/proto` пуст, поэтому Cargo плану не нужен; гейт `cargo test --workspace` — у веток 2a1–2a5.
3. Стенд с задержкой `setImmediate` и verbose-прогон для всех новых и изменённых тестовых файлов с React (`floor-scan-source`, `app`, `host-link-facts`, `host-link-shifts`, `floor-status-bar`, `floor-work-screen`, `floor-app`) — PASS, `stderr` пуст.
4. Каждая мутация задач 1–9 — FAIL названного теста, файл восстановлен (`cmp`, тот же `shasum`), `git status --short` после всех — пуст.
5. `grep -rnF '\u04' apps/standalone/src apps/standalone/test` — только `src/host/pairing-code.ts:66`; `grep -rn "floor.work.stub" apps/standalone` — ничего; `grep -rn "console\." apps/standalone/src/floor/work apps/standalone/src/local/facts-sender.ts apps/standalone/src/floor/outbox-status.ts` — ничего (журнал процесса не видит кодов).
6. `git diff --check` от основы плана; `git log --format=%B` каждого коммита — ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; изменены только пути раздела «Файлы».
7. Сверка с разделом «Контракт для 2a7–2a8»: `CloseStep`, `CloseAddition`, `ClosingBox`, `closeOpenBox`, `closeIfFull`, `processScan`, `ScanContext`, `sendFactBatch`, `HostLinkControls`, `outboxVersion`, `factsFailure`, `WorkScreenProps` названы в коде так, как в контракте.

**Что нельзя проверить без Windows, оборудования и живого хоста** (отчёт называет отдельно от автоматических проверок): коды маркировки с GS и хвостом клавиатурным сканером (RU и EN, Caps Lock) и COM-сканером (`]d2` есть и нет), оба сразу; поток 3–5 сканов в секунду на заводском ПК при хосте на этом ПК и на другом ПК через Wi-Fi (300 мс проверки кода в худшем случае); точка доступа выключена посреди короба — короб закрывается на блоке станции, строка состояния считает неотправленное, после возвращения связи каждая запись доходит до хоста один раз (итоги офиса равны станционным); ПК выключен сразу после скана — код на месте, полный короб закрывается при входе в экран; 2 000-й короб блока — новый блок приходит раньше (правило «половина»), без связи — «Нет номеров SSCC»; тоны на колонках ПК; раскладка рабочего экрана при 1024 × 768 и 1280 × 800 с сенсорной панелью (64 px); живой хост 2a2 (квитанции, `conflict`, `sscc_not_issued`) вместо поддельного `HostApi` — его покажет сквозной сценарий плана 2a8.

## Перенесено

- **Экран очереди и «Отправить снова»** (план ОЧ пилота): список неотправленных и отклонённых записей с причиной словами; повторная отправка отклонённой записи и её отклонённых зависимых (`box_unknown` и подобных) — заново, с новыми `id`, в прежнем порядке `seq` (хост хранит отказ навсегда, правило ревью задачи 2 плана 2a2). 2a6 хранит отклонённые записи и показывает их число.
- **Предупреждения о запасе номеров SSCC без хоста** (25 % и 10 % блока, последний номер) — план ОЧ; строка состояния 2a6 показывает остаток числом.
- **Экран «обновите хост»** на `protocol_unsupported` при доставке и других вызовах устройства (§5.1 спецификации): сейчас — обычный сбой с повтором и причина `host` в строке состояния; хост и станция пилота ставятся одним установщиком; полноценный экран — с планом 5.
- **Выбор источника сканов по настройке** (решение 25), громкость и «без звука» — вместе с настройкой рабочего места (план 2a7), если владелец захочет вернуть выбор одного источника.
- **Разметка малого монитора** (медиазапросы облачного `station.css`: `max-width: 1100px`, `max-height: 767px`): рабочий экран 2a6 — сетка чисел, которая переносится сама; проверить на мониторе заказчика (ручной список), правка — с планом 2a7 или 2a8.
- **Проверка этикетки сканом SSCC и восстановление печати** — план 2a7 (перехват SSCC до конвейера, остановки `Stop`).
- **Исключения, сводка и закрытие смены, `local_state` по квитанции `shift_closed`** — план 2a8 (он дописывает транзакцию квитанций `sendFactBatch`).
- **Запросы блоков другого префикса** (снимок новой смены с новым GLN) остаются в `floor_block_requests` и не повторяются; удалить их — срок хранения плана 2a8.
- **Блок с номерами вне ёмкости префикса** теряет их по одному на попытку закрытия (`invalid_serial`, «Повторить»); хост таких блоков не выдаёт (2a1), разбор испорченного блока — план 2b.
- **Ошибка 500 хоста не называет запись** (мелочь ревью задачи 2 плана 2a2): станция повторяет ту же пачку, причина `host` видна в строке состояния; запись в журнал хоста с `id` записи — у плана хоста.
- **Восстановление хоста из копии** (план РК): пока сверка не закончена, хост отвечает на факты транспортной ошибкой — станция просто повторяет; повторная регистрация блоков станции — план РК.

## Отклонения при исполнении
