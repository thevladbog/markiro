# План ПЛ-Ц: цех — паллеты-лайт (паллета копится из коробов, закрывается сама при заполнении или досрочно, этикетка паллеты, перепечатка и расформирование, закрытие смены с открытой паллетой, новая смена «С паллетами») — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Станция автономного продукта работает смену с коробами **и** паллетами так же, как облачная станция, к которой привык клиент пилота: каждый закрытый короб сам встаёт на открытую паллету смены той же транзакцией, что его закрытие; короб, доводящий паллету до вместимости смены, закрывает её номером блока паллет (расширение 1) и печатает её этикетку после своей; оператор закрывает паллету досрочно, проверяет, пропускает и печатает снова её этикетку, перепечатывает и расформировывает закрытую паллету с причиной; смена с открытой паллетой закрывается вопросом «На паллете N из M коробов — закрыть?» и кнопкой «Закрыть паллету и смену»; новая смена на станции создаётся «С паллетами» с шаблоном паллеты. Станция пишет факты протокола 3 плана ПЛ-Х (`box_closed.palletId`, `pallet_closed`, `pallet_label`, `pallet_exception`), без номеров паллет не останавливает линию, а сквозной сценарий 2a8 становится сменой с паллетами и проверяется маршрутизатором хоста. Последний план цеха перед испытаниями — критический путь пилота у текущего клиента.

**Architecture:**

- Протокол 3 на станции (задача 1): Zod станции по фикстурам ПЛ-Х (`DeviceShift` и снимок с паллетами, `DeviceShiftCreate`, три вида записей паллет, четыре кода квитанций), строители записей паллет, проверка макета паллеты в снимке.
- База (задача 2, `src-tauri/migrations/0008_floor_pallets.sql`): столбцы паллет копии смены, `floor_boxes.pallet_id`, `floor_pallets`, `floor_pallet_exceptions` (`DeviceData`, без внешних ключей, оба в `RETAINED_TABLES`); `floor_print_jobs` не пересобирается — назначение `pallet` есть с плана 2a7.
- Модель паллеты (задача 3, `src/floor/pallets/pallets.ts`): `palletStep` — шаг `CloseStep` закрытия короба (присоединение, открытие, закрытие при заполнении той же транзакцией), `closeOpenPallet`, `closePalletIfFull`, `openPalletGuard` — проверка закрытия смены точкой `guards` плана 2a8; блоки паллет — `createBlockSupply` с `extension: 1`.
- Этикетка и исключения паллеты (задача 4): решения плана 2a7 пишут `pallet_label` и исключение паллеты; `src/floor/exceptions/pallet-exceptions.ts` — `reprintPallet`, `disassemblePallet`, `readClosedPallets`.
- Рабочий экран (задачи 5–7): «Паллета — N из M коробов», «Закрыть паллету досрочно», этикетки по очереди (короба, потом паллеты), сообщение о полной паллете без номеров, «Закрыть паллету и смену» в сводке закрытия, паллетные действия в экране исключений.
- Новая смена (задача 8): «С паллетами» / «Без паллет», шаблон паллеты по решению 7 (`suggestPalletTemplate`).
- Сквозной сценарий (задача 9): смена с паллетами в общей фикстуре `proto/fixtures/floor-scenario.json`, проверка хостом паллет и `closedPallets`.
- Документы (задача 10). Не меняются: исходники хоста и `proto`, `apps/station`, `packages/*`, `package.json`, `pnpm-lock.yaml`, `Cargo.toml`, `Cargo.lock`. Из Rust меняются только `src-tauri/src/local_db.rs` (`TABLE_CLASSES`), `src-tauri/tests/local_db.rs` и `host/tests/floor_scenario.rs`.

**Tech Stack:** React 19.2, TypeScript 6 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4.4.3, i18next, `@markiro/ui` (`Card`, `Button size="floor"`, `Input size="floor"`, `Alert`), `@markiro/domain` (`buildSscc`, `palletLabelFields`, `parseScannedSscc`, `formatSsccHri`), Vitest 4 с jsdom и `node:sqlite` за `LocalExecutor`; Rust — sqlx 0.8.6 (миграция и `TABLE_CLASSES` оболочки), тест хоста на `axum` (`TestApp`, без сокета).

**Спецификации:**

- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` (спецификация пилота): §4.1 строка 10, §6.1 (как в облаке), §6.2 «Цех (план ПЛ-Ц)», §9.1 (запас паллет без хоста), §12 (ПЛ-Ц на критическом пути), §13 (п. 1, 3, 6 — не урезаны), §14 (П1, П2), §18 «Уточнения плана ПЛ-Х».
- `.superpowers/sdd/cloud-pallet-flow-notes.md` — поведение облака: автозакрытие при заполнении, досрочное закрытие, отказ пустой паллете до списания номера, без номеров паллета остаётся открытой и держит закрытие смены, «На паллете N из M коробов — закрыть?» / «Закрыть паллету и смену», выгрузки считают короба открытой паллеты свободными, поля этикетки паллеты.
- `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` (этап 2a): решения 7, 9, 10, 17, 19, 21, 31, 36; §5.3, §5.7.3–5.7.7; уточнения планов 2a5–2a8 (разделы 17–20).
- Планы, на которых стоит этот: ПЛ-Х (`…-pl-h-pallets-host.md`, «Контракт для ПЛ-Ц, О-Х и ЧЗ» — формы на проводе, коды квитанций, порядок фактов), 2a5 (миграция `0006`, копии смен, новая смена), 2a6 (`CloseStep`/`CloseAddition` закрытия короба, `createBlockSupply`, `outboxStatement`, транзакция квитанций), 2a7 (`prepareLabelJob` с `purpose`, `sendLabelJob`, решения по этикетке, `readOpenJob`, `OPEN_JOB_SQL`), 2a8 («Контракт для ПЛ-Ц и ОЧ»: `closeShift(context, reason, guards)`, `CloseBlocker`, `RETAINED_TABLES`, `ExceptionFlow`, `Stop`, сквозной сценарий).
- Облачная станция — поведенческий образец, не архитектура: `apps/station/src/lib/close-box.ts`, `close-pallet.ts`, `pages/WorkScreen.tsx` (`confirmShiftClosePallet`, `performClose`), `packages/domain/src/labels/pallet-label.ts`.
- `apps/standalone/AGENTS.md` — «Local database», «Writes», «Shifts», «Facts», «Floor work», «Floor printing», «Floor exceptions and close», «Verification».

## Допущения по вопросам владельцу

Владелец подтвердил главное: у клиента на пилоте короба **и** паллеты, паллета копится сама из закрываемых коробов (расширение SSCC 1, блоки по 200, вместимость паллеты — из смены, `palletsEnabled` — признак смены). На остальное он не ответил (недоступен, срок пилота поджимает); план исполняет рекомендованные варианты и называет, что поменять, если ответ будет другим.

- **П2 — вариант А, подтверждено:** паллета копится сама, закрывается при заполнении или досрочно, перепечатка и расформирование, закрытие смены с открытой паллетой. Сокращение 6 раздела 13 (без расформирования паллеты) не применяется: задачи уложились в десять.
- **П1 — хост на ПК станции (вариант Б).** План верен для обоих вариантов: паллета закрывается локально; без связи кончаются только номера паллет, а их запас — блок 200 по правилу «половина».
- **Причины исключений паллеты — списки коробов** (`REPRINT_REASONS`, `DISASSEMBLE_REASONS`), как решил ПЛ-Х; свой список — правка двух констант и фикстуры `exception-reasons.json` (ПЛ-Х, «Перенесено»).
- **Вопросы этого плана (новые; рекомендованы варианты, по которым он написан):**
  - **ВЦ1 — «С паллетами» новой смены на станции включено по умолчанию**, когда у товара есть вместимость паллеты и есть подходящий ему шаблон паллеты; иначе переключателя нет. Б) выключено по умолчанию. **Рекомендация — А:** клиент работает с паллетами, вместимость паллеты у товара — его признак. Вместимость — товара, на станции не меняется (офис меняет её при планировании, план О-Ф).
  - **ВЦ2 — полная паллета без номеров паллет не останавливает линию:** сообщение «Паллета заполнена, но не закрыта», следующие короба встают на неё (как в облаке), паллета закрывается сама, когда номера придут. Досрочное закрытие без номеров — остановка с причиной и «Повторить».
  - **ВЦ3 — «Закрыть паллету и смену» — одна кнопка сводки**, причина расхождения выбирается до неё; ждущая этикетка паллеты решается в своей панели, и смена закрывается сама после решения (как облачное `confirmShiftClosePallet`); без номеров паллет смена остаётся открытой, а намерение закрыть не хранится (облако хранит его до прихода номеров) — оператор нажимает снова.
  - **ВЦ4 — этикетка короба уходит раньше этикетки паллеты того же закрытия;** ждущая этикетка паллеты держит следующий короб, как ждущая этикетка короба (одна ждущая этикетка за раз, решение 19).
  - **ВЦ5 — строка состояния не показывает запас номеров паллет** (это план ОЧ: `remainingSerials(local, pairing, prefix, 1)`); экран говорит, когда их нет.
  - **ВЦ6 — паллета сверх вместимости показывается как есть:** «2 из 1 коробов» — честнее, чем прятать короба, вставшие на полную паллету без номеров.

## Global Constraints

**Решения спецификации пилота** (§6.1–6.2, дословные значения)

- «Паллета открывается сама, когда закрывается первый короб»; «на станцию и смену — одна открытая паллета»; «короб получает `pallet_id` тем же оператором, который его закрывает»; «число коробов на паллете вычисляется, а не хранится».
- «Паллета закрывается сама, когда `boxCount + 1 >= palletBoxCapacity`, либо досрочно кнопкой «Закрыть паллету досрочно»»; «номер списывается из блока расширения 1: `buildSscc(1, prefix, serial)`»; «пустую паллету закрыть нельзя. Если номеров нет, паллета остаётся открытой сверх вместимости, а следующие короба присоединяются к ней».
- «Перепечатка с причиной печатает с исходным `closedAt`. При расформировании `disassembled_at` ставится у паллеты, короба не трогаются. Расформированный короб выпадает из счёта паллеты».
- «Станция спрашивает «На паллете N из M коробов — закрыть?» и предлагает «Закрыть паллету и смену». Пустая открытая паллета закрытию не мешает и номера не тратит».
- «Этикетка паллеты печатается из шаблона назначения `pallet`; поля даёт `palletLabelFields`»; «принтер назначается по назначению `pallet`»; «Ярлык паллеты» и «Состав паллеты» станция не печатает.
- Цех (план ПЛ-Ц): «Закрытие короба присоединяет его к открытой паллете или открывает новую одной `local_transaction` с фактом. Заполненная паллета закрывается в той же цепочке. Номер списывается так же, как у короба: курсор блока сравнивается с прочитанным значением»; «Блок паллет дозаказывается по правилу «половина», как у коробов»; «Новая смена на станции получает переключатель «С паллетами», доступный только при вместимости паллеты у товара, и выбор шаблона паллеты».

**Контракт плана ПЛ-Х** (формы на проводе — фикстуры `proto/fixtures`)

- `DeviceShift` смены с паллетами: `palletsEnabled: true`, `palletBoxCapacity` (1–10 000), `palletTemplateId`; у смены без паллет обоих полей **нет**. Снимок входа — `palletTemplate { id, name, rev, spec }`, макет проверяется `labelTemplateSpecSchema`.
- `box_closed.data.palletId`; `pallet_closed { palletId, sscc, blockId, serial, openedAt, closedAt, boxCount ≥ 1 }`; `pallet_label { palletId, outcome: "verified" | "skipped", at }`; `pallet_exception { exception: "reprint" | "disassemble", palletId, reasonCode, reasonText, occurredAt }` — `reasonCode` обязателен, `reasonText` только при `other`. Все моменты — `Date.toISOString`.
- Порядок в очереди: короба паллеты раньше её `pallet_closed` (автозакрытие — той же транзакцией после короба). Хост не следит за «одной открытой паллетой»: это правило станции.
- Коды квитанций: `no_pallets`, `pallet_unknown`, `pallet_already_closed`, `pallet_state`. Отказ хранится навсегда; «Отправить снова» — план ОЧ.
- Блок паллет: `POST /v1/device/sscc/blocks { requestId, issuerPrefix, extension: 1 }`, размер `site.pallet_block_size` (200).

**Контракт плана 2a8** (точки расширения)

- `closeShift(context, reasonCode, guards)` берёт проверку открытой паллеты той же транзакцией; `CloseBlocker` дописывается открытой паллетой; `RETAINED_TABLES` — `floor_pallets` и `floor_pallet_exceptions`; паллетные исключения — свой модуль по образцу `box-exceptions.ts` со словами `reasonWords`; перепечатка паллеты — `prepareLabelJob` с `purpose: "pallet"` и исключение одной транзакцией, затем `sendLabelJob`; паллетные остановки — в тот же `Stop`; сценарий перестраивается с паллетой. Транзакция квитанций своих операторов от ПЛ-Ц не получает.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!` в исходниках (`as const` — не приведение); именованные экспорты, `import type`.
- Экраны цеха: только `@markiro/ui`, каждая кнопка — `size="floor"` (64 px), состояние — словами; ни одна кнопка ухода не держится запросом, который может не ответить.
- Тексты — ключи `src/i18n/ru.json`, кириллица буквами; переменные текстов — именованные, не `count`.
- Тесты конкурентности детерминированы: удерживаемая запись (`holdingWrites`); ожидание ограничено числом шагов, а не временем.
- Журнал процесса не видит ни кодов, ни SSCC: в новых модулях цеха нет `console.*`.
- Rust: `cargo fmt` чистый, сборка без предупреждений; `Cargo.toml`, `Cargo.lock` не меняются; применённые миграции `0001`–`0007` оболочки не меняются.
- Не меняются: `apps/station`, `packages/*`, исходники `apps/standalone/host` и `apps/standalone/proto` (кроме `host/tests/floor_scenario.rs` и фикстуры сценария), `package.json`, `pnpm-lock.yaml`.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Решения планировщика

- **Паллета — шаг закрытия короба, а не своя транзакция после него.** `palletStep` — `CloseStep` плана 2a6: его операторы идут в транзакцию закрытия короба после записи `box_closed`, а поле `palletId` — в саму запись (`CloseAddition.data`). Короб и его паллета пишутся вместе или не пишутся вовсе: номер паллеты, занятый между чтением и записью, откатывает и закрытие короба (`stale`, короб закрывается снова). Так `pallet_closed` всегда идёт в очереди после последнего короба паллеты — порядок, который ПЛ-Х называет нормальным.
- **Открытая паллета охраняется сравнением, а не только очередью работы.** Короб, встающий на открытую паллету, проверяет её открытость тем же `UPDATE … WHERE closed_at IS NULL` (`expectedChanges: 1`); закрытие паллеты — `closed_at IS NULL` и число живых коробов, равное прочитанному. Расформированный короб уменьшает счёт, поэтому сравнение ловит и его. Индекс `floor_pallets_open` держит одну открытую паллету на смену и подключение.
- **Без номеров паллет линия не стоит.** Полная паллета остаётся открытой, короба встают на неё (облако), экран говорит «Паллета заполнена, но не закрыта»; `settlePallet` закрывает её на входе, после каждого короба и когда приходит блок паллет. Останавливает работу только досрочное закрытие без номеров — оператор сам его просил.
- **Этикетки идут по очереди.** Закрытие короба, заполнившее паллету, пишет два задания одного момента; `readOpenJob` читает их по назначению (`ORDER BY created_at, purpose, id`: короб раньше паллеты), а `settleLabel` отправляет записанные и не отправленные, пока очередное не остановится (проверка, сбой, неизвестный исход). Следующий короб не закроется, пока ждёт любая этикетка (решение 19) — и этикетка паллеты тоже.
- **Проверка закрытия смены — `guards` плана 2a8.** `readCloseSummary` называет блокировку `open_pallet` (после открытого короба и ждущей этикетки: короб, закрываясь, сам встаёт на паллету); `openPalletGuard` повторяет условие в транзакции закрытия (`UPDATE floor_shifts SET local_state = local_state WHERE … AND NOT EXISTS (открытая паллета с живым коробом)`, `expectedChanges: 1`). Пустая открытая паллета не держит смену и не удаляется: её строка уходит со сроком хранения.
- **«Закрыть паллету и смену» — общий путь закрытия.** Закрытие смены вынесено в `finishClose` (и «Подтвердить закрытие», и продолжение после паллеты); `afterLabel` — что делать, когда этикетка решена: закрыть смену, если она ждала этикетку паллеты, иначе закрыть полный короб и полную паллету.
- **Исключения паллеты — свой модуль по образцу коробов.** `palletExceptionStatements` (строка `floor_pallet_exceptions` и запись `pallet_exception`) пишет и перепечатка экрана исключений, и «Напечатать снова» этикетки, которая может уже быть на паллете (`printAgain` плана 2a7): оба — с причиной, той же транзакцией, что новое задание или `sending`. Слова — `reasonWords`, коды — `reasonFields` (экспортирован).
- **Снимок смены с паллетами без макета паллеты не работает.** Станция до ПЛ-Ц, вошедшая в смену с паллетами, сохранила снимок без `palletTemplate` (схема отбрасывала поле); `checkShiftSnapshot(raw, palletsEnabled)` отказывает такому снимку (`layout`), и вход с хостом приносит снимок заново.
- **Сквозной сценарий — смена с паллетами вместо смены коробов.** Отдельный сценарий удвоил бы фикстуру и тест хоста; смена с паллетами проводит через маршрутизатор хоста все записи прежнего сценария и все паллетные виды (`box_closed.palletId`, `pallet_closed` при заполнении и досрочно, `pallet_label`, `pallet_exception` обоих видов).

## Контракт для ОЧ, О-Х, О-Ф и испытаний

- **ОЧ (очередь и запас):** записи паллет — обычные записи очереди (`kind` — `pallet_closed`, `pallet_label`, `pallet_exception`); отказ (`no_pallets`, `pallet_unknown`, `pallet_already_closed`, `pallet_state`, `sscc_not_issued`, `sscc_taken`) остаётся в очереди с кодом. «Отправить снова» для них — то же правило ОЧ (новые `id`, `data` байт в байт, прежний порядок `seq`); короб, досланный так, присоединяется на хосте и к закрытой паллете. Запас номеров паллет — `remainingSerials(local, pairing, issuerPrefix, PALLET_EXTENSION)`.
- **О-Ф (офис):** `suggestPalletTemplate(product, templates, defaults)` (`src/lib/box-template-choice.ts`) — правило решения 7 для назначения `pallet`, им же пользуется форма офиса; строитель станции `deviceShiftCreate({ …, pallets: { boxCapacity, templateId } })`.
- **О-Х (данные отчётов):** станция присылает `boxCount` паллеты как число её нерасформированных коробов в момент закрытия; паллета, закрытая досрочно и расформированная, остаётся закрытой (`disassembled_at`) с SSCC; короба расформированной паллеты сохраняют `palletId`.
- **Испытания:** ручной список Windows — «Verification» в `apps/standalone/AGENTS.md`.

## Заметки для исполнения

**Основа плана**

- ПЛ-Ц стоит на коде планов 2a5–2a8 и ПЛ-Х (протокол 3, фикстуры паллет, `pallet_facts` хоста, опоры `open_pallet_floor` и `issue_pallet_block` в `host/tests/support/app.rs`). Перед задачей 1 убедиться, что `git log --oneline` содержит их коммиты, а `apps/standalone/src/floor/close/shift-close.ts` (с `guards`), `apps/standalone/src/local/retention.ts` (`RETAINED_TABLES`), `apps/standalone/src/floor/exceptions/ExceptionFlow.tsx`, `apps/standalone/proto/fixtures/facts-request-pallets.json`, `apps/standalone/host/src/facts/pallet_closed.rs` и `apps/standalone/host/tests/floor_scenario.rs` есть; если чего-то нет — остановиться и назвать это в отчёте.
- Фрагменты построены на копии репозитория (`/tmp/claude/p-plc-scratch`, ветка `p-plc-scratch`): основа плана — `p2a8-scratch` (`09ac40ce5`, копия планировщика 2a8: `claude/integration` на `16fdf718a`, исполненный 2a2, планы 2a5–2a8, применённые по тексту) плюс ПЛ-Х по копии его планировщика (`ppl-scratch`, разница `917c8cbb6..a6dcae1e5`, `git apply -3`; конфликты — только в `AGENTS.md` и тестах хоста `facts.rs`, `no_secrets_in_logs.rs`, решены сохранением обеих сторон) и правка `AGENTS.md`, вернувшая абзац итогов ПЛ-Х на место. Задача за задачей план применён к этой копии, и каждая команда ниже запущена на ней. Настоящее дерево будет другим (исполненные 2a5–2a8 и ПЛ-Х): фрагмент, который из-за этого не находится, применяется к тому же месту по смыслу, а расхождение записывается в «Отклонения при исполнении». Номер раздела спецификации задачи 10 — следующий свободный.
- На копии прогнано: все Vitest задач (RED до реализации, GREEN после, полный прогон пакета после задачи 9 — 118 файлов, 2714 тестов, падают только старые тесты `template-editor` тайм-аутом под загрузкой ~120), `typecheck`, `lint`, `build`, `cargo fmt`, `cargo test -p markiro-standalone --test local_db` (RED и GREEN задачи 2), `cargo test -p markiro-host --test floor_scenario`, каждая мутация. **Не прогонялось на копии:** гейт `cargo test --workspace` и полные наборы `-p markiro-standalone` и `-p markiro-host` (исходники хоста и `proto` план не меняет, оболочки — только `TABLE_CLASSES`); Windows, принтеры, сканеры и сенсорная панель — ручной список задачи 10. Код планов 2a5–2a8 и ПЛ-Х на копии — применённый текст их планов, а не исполненный код: на настоящем дереве фрагменты применяются по смыслу (выше).
- На копии ПЛ-Х, влитый поверх 2a6, роняет тест 2a6 `test/protocol.test.ts` «know every receipt code of the host»: фикстура `fact-receipt-codes.json` знает четыре кода паллет, а `FACT_RECEIPT_CODES` станции — нет (у планировщика ПЛ-Х не было 2a6). Задача 1 его чинит; если на настоящем дереве исполнитель ПЛ-Х уже дописал коды, фрагмент задачи 1 с ними применяется по смыслу.

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, с отступами; на свою очередь он встречается в файле ровно один раз. Фрагменты одной правки идут сверху вниз по файлу и применяются по порядку. Шаг 1 (тесты) применяется раньше шага 3 (реализация).
- «Создать» — новый файл, ровно как в блоке.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках отформатирован prettier и `cargo fmt`: расхождение при проверке значит опечатку.
- Русский текст в коде и в `ru.json` — буквами. Каждая задача с вебвью кончается `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное совпадение — `src/host/pairing-code.ts:66`. Разделитель групп GS1 в тестах пишется `\u001d`, в фикстуре JSON — так же.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие защиты. Мутация применяется к файлу, каким его оставила своя задача. Для каждой: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из шага; команда — ожидаемый FAIL с названным тестом; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить. Мутации миграции `0008` меняют только файл: тестовая база собирается заново в каждом тесте. Мутация фикстуры задачи 9 проверяется и Vitest, и `cargo test`.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON, CSS и MD; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `run lint`; Rust (задачи 2 и 9) — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`.

**pnpm, git, Cargo и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. Команды — из корня репозитория, без `cd`. Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата; если обёртка `rtk` урезала вывод, `rtk proxy <команда>`.
- В свежем worktree сначала: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`.
- Cargo — с `--offline --locked`. Оболочка встраивает сборку вебвью (`tauri::generate_context!` читает `apps/standalone/dist`): перед `-p markiro-standalone` в свежем worktree — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`. `--test local_db` оболочки и `--test floor_scenario` хоста сокета не открывают и идут в песочнице.
- React 19.2 запускает пассивные эффекты задачей планировщика (`setImmediate`), а `waitFor` после успеха ждёт `setTimeout(0)`: тесты рабочего экрана сканируют и нажимают внутри одного асинхронного `act`, который дожидается ворот работы (`scan`, `press` из `test/support/work-screen.tsx`), ждут подписки сканера (`listening()`), а итог действия, которое кончается после ворот, ждут через `findBy*`. Новые и изменённые тестовые файлы с React (задачи 5–8) один раз запускаются с `--reporter=verbose` (в выводе нет `stderr |`) и один раз под стендом с задержкой `setImmediate` на 3 мс — два временных файла внутри пакета, удалить сразу после прогона, до `lint`:

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

- Под сильной нагрузкой машины полный прогон Vitest роняет тайм-аутом 5 с старые тесты офиса, которых план не трогает: на копии плана при средней загрузке 120–140 до плана падали тайм-аутом 108 тестов офиса (`template-editor`, `shift-dialog`, `shifts-page`, `shift-edit`, `templates-page`, `product-dialog` и др.), после плана — от одного до трёх тестов `template-editor` (два полных прогона). Это не дефект плана; падение в полном прогоне записывается и разбирается (отдельный прогон файла), а не лечится повтором.

**Счёт тестов** (измерено на копии плана; на настоящем дереве числа сдвигаются на тесты, которых на копии нет)

- До плана: Vitest — 112 файлов, 2654 теста.
- После задач: 1 — 112, 2666; 2 — 113, 2673; 3 — 114, 2685; 4 — 115, 2695; 5 — 116, 2700; 6 — 117, 2704; 7 — 118, 2707; 8 — 118, 2714; 9, 10 — без изменений. Cargo: число тестов не меняется (задача 2 правит `tests/local_db.rs` оболочки — 16 тестов, задача 9 — `--test floor_scenario` хоста, 2 теста).
- После: Vitest — 118 файлов, 2714 тестов.

## Файлы

Задачи выполняются по порядку: 1–2 — протокол и база, 3–4 — модель паллеты, её этикетка и исключения, 5–8 — экраны (рабочий экран, закрытие смены, исключения, новая смена), 9 — сквозной сценарий, 10 — документы.

<!-- prettier-ignore -->
```text
apps/standalone/src/floor/facts.ts
apps/standalone/src/floor/shifts/shift-copies.ts
apps/standalone/src/floor/shifts/shift-entry.ts
apps/standalone/src/floor/shifts/shift-snapshot.ts
apps/standalone/src/host/protocol.ts
apps/standalone/src/host/requests.ts
apps/standalone/src/i18n/ru.json
apps/standalone/test/floor-facts.test.ts
apps/standalone/test/floor-shift-list.test.tsx
apps/standalone/test/protocol.test.ts
apps/standalone/test/shift-copies.test.ts   задача 1
apps/standalone/src-tauri/migrations/0008_floor_pallets.sql (новый)
apps/standalone/src-tauri/src/local_db.rs
apps/standalone/src-tauri/tests/local_db.rs
apps/standalone/src/floor/shifts/new-shift.ts
apps/standalone/src/floor/shifts/shift-copies.ts
apps/standalone/src/local/retention.ts
apps/standalone/test/floor-pallet-schema.test.ts (новый)
apps/standalone/test/floor-schema.test.ts
apps/standalone/test/local-executor.test.ts
apps/standalone/test/retention.test.ts
apps/standalone/test/shift-copies.test.ts   задача 2
apps/standalone/src/floor/close/shift-close.ts
apps/standalone/src/floor/pallets/pallets.ts (новый)
apps/standalone/src/floor/print/label-render.ts
apps/standalone/src/floor/print/print-jobs.ts
apps/standalone/src/floor/work/block-supply.ts
apps/standalone/test/floor-block-supply.test.ts
apps/standalone/test/floor-pallets.test.ts (новый)
apps/standalone/test/support/pallets.ts (новый)   задача 3
apps/standalone/src/floor/exceptions/box-exceptions.ts
apps/standalone/src/floor/exceptions/pallet-exceptions.ts (новый)
apps/standalone/src/floor/print/print-resolution.ts
apps/standalone/test/floor-pallet-exceptions.test.ts (новый)
apps/standalone/test/retention.test.ts   задача 4
apps/standalone/src/floor/print/LabelPanel.tsx
apps/standalone/src/floor/work/WorkScreen.tsx
apps/standalone/src/i18n/ru.json
apps/standalone/test/floor-work-pallets.test.tsx (новый)
apps/standalone/test/support/pallets.ts   задача 5
apps/standalone/src/floor/close/ShiftClosePanel.tsx
apps/standalone/src/floor/work/WorkScreen.tsx
apps/standalone/src/i18n/ru.json
apps/standalone/test/floor-work-close-pallets.test.tsx (новый)   задача 6
apps/standalone/src/floor/exceptions/ExceptionFlow.tsx
apps/standalone/src/floor/work/WorkScreen.tsx
apps/standalone/src/i18n/ru.json
apps/standalone/test/floor-work-pallet-exceptions.test.tsx (новый)   задача 7
apps/standalone/src/floor/shifts/NewShift.tsx
apps/standalone/src/floor/shifts/new-shift.ts
apps/standalone/src/i18n/ru.json
apps/standalone/src/lib/box-template-choice.ts
apps/standalone/test/box-template-choice.test.ts
apps/standalone/test/floor-new-shift.test.tsx   задача 8
apps/standalone/host/tests/floor_scenario.rs
apps/standalone/proto/fixtures/floor-scenario.json
apps/standalone/test/floor-scenario.test.ts   задача 9
apps/standalone/AGENTS.md
docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md   задача 10
```

---

### Task 1: Протокол 3 на станции — паллеты смены, макет паллеты в снимке, записи паллет, коды квитанций

Zod станции по фикстурам плана ПЛ-Х (`src/host/protocol.ts`): `DeviceShift` — необязательные `palletBoxCapacity`, `palletTemplateId` (у смены без паллет полей нет, не `null`); снимок — необязательный `palletTemplate`; `DeviceShiftCreate` — `palletsEnabled`, `palletBoxCapacity`, `palletTemplateId`; `box_closed.data.palletId`; три вида записей `pallet_closed`, `pallet_label`, `pallet_exception` (поле вида — `exception`, код причины обязателен) и четыре кода квитанций (`no_pallets`, `pallet_unknown`, `pallet_already_closed`, `pallet_state`). Строители записей паллет (`src/floor/facts.ts`), строитель создания смены с паллетами (`deviceShiftCreate`), проверка снимка: макет паллеты читается доменом, как макет короба, а смена с паллетами без него не работает (`checkShiftSnapshot(raw, palletsEnabled)`). Отказ входа `pallet_template_not_fit` получает свои слова. После ПЛ-Х, влитого поверх 2a6, тест 2a6 «know every receipt code of the host» падает, пока `FACT_RECEIPT_CODES` не знает кодов паллет: эта задача его чинит.

**Files:**

- Modify: `apps/standalone/src/floor/facts.ts`, `apps/standalone/src/floor/shifts/shift-copies.ts`, `apps/standalone/src/floor/shifts/shift-entry.ts`, `apps/standalone/src/floor/shifts/shift-snapshot.ts`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/requests.ts`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-facts.test.ts` (Modify), `apps/standalone/test/floor-shift-list.test.tsx` (Modify), `apps/standalone/test/protocol.test.ts` (Modify), `apps/standalone/test/shift-copies.test.ts` (Modify)

**Interfaces:**

- Consumes: фикстуры ПЛ-Х `device-shift-entered-pallets.json`, `device-shift-create-pallets.json`, `facts-request-pallets.json`, `fact-receipt-codes.json`; `factRecordSchema`, `outboxStatement` (план 2a6); `checkShiftSnapshot`, `readStoredWork`, `enterShift` (план 2a5).
- Produces:
  - `palletClosedFactSchema`, `palletLabelFactSchema`, `palletExceptionFactSchema` и их типы; `factRecordSchema` с тремя видами паллет; `FACT_RECEIPT_CODES` с кодами паллет;
  - `palletClosedRecord`, `palletLabelRecord`, `palletExceptionRecord` (`src/floor/facts.ts`);
  - `DeviceShiftInput.pallets?: { boxCapacity; templateId }` (`src/host/requests.ts`);
  - `CheckedSnapshot.palletTemplate: SnapshotTemplate | null`, `SnapshotTemplate`, `checkShiftSnapshot(raw, palletsEnabled = false)`; `EntryRefusal` += `pallet_template_not_fit`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/floor-facts.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  outboxStatement,
  RecordTooLargeError,
```

заменить на:

<!-- prettier-ignore -->
```ts
  outboxStatement,
  palletClosedRecord,
  palletExceptionRecord,
  palletLabelRecord,
  RecordTooLargeError,
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  MAX_FACT_BATCH,
  scanFactSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
  MAX_FACT_BATCH,
  palletClosedFactSchema,
  palletExceptionFactSchema,
  palletLabelFactSchema,
  scanFactSchema,
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
      record(5),
    );
  });

  it("carry a code as the domain read it: the hash without the tail, the canonical text with it", () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
      record(5),
    );
  });

  it("build every record of facts-request-pallets.json exactly (plan ПЛ-Ц)", () => {
    const pallets = factBatchSchema.parse(fixture("facts-request-pallets.json")).records;
    const [box, closed, label, exception] = pallets;
    if (box === undefined || closed === undefined || label === undefined) throw new Error("short");
    if (exception === undefined) throw new Error("short");
    expect(boxClosedRecord(head(box), boxClosedFactSchema.parse(box.data))).toEqual(box);
    expect(palletClosedRecord(head(closed), palletClosedFactSchema.parse(closed.data))).toEqual(
      closed,
    );
    expect(palletLabelRecord(head(label), palletLabelFactSchema.parse(label.data))).toEqual(label);
    expect(
      palletExceptionRecord(head(exception), palletExceptionFactSchema.parse(exception.data)),
    ).toEqual(exception);
  });

  it("carry a code as the domain read it: the hash without the tail, the canonical text with it", () => {
```

Правка `apps/standalone/test/floor-shift-list.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
      "Шаблон этикетки смены выключен или не подходит товару: смену не открыть. Обратитесь в офис.",
    ],
```

заменить на:

<!-- prettier-ignore -->
```tsx
      "Шаблон этикетки смены выключен или не подходит товару: смену не открыть. Обратитесь в офис.",
    ],
    [
      "pallet_template_not_fit",
      "Шаблон этикетки паллеты выключен или не подходит товару: смену не открыть. Обратитесь в офис.",
    ],
```

Правка `apps/standalone/test/protocol.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  ["device-shift-entered.json", enteredShiftSchema],
  ["sscc-block.json", ssccBlockSchema],
```

заменить на:

<!-- prettier-ignore -->
```ts
  ["device-shift-entered.json", enteredShiftSchema],
  ["device-shift-entered-pallets.json", enteredShiftSchema],
  ["sscc-block.json", ssccBlockSchema],
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  ["device-shift-create.json", deviceShiftCreateSchema],
  ["sscc-block-request.json", ssccBlockRequestSchema],
  ["facts-request.json", factBatchSchema],
] as const;
```

заменить на:

<!-- prettier-ignore -->
```ts
  ["device-shift-create.json", deviceShiftCreateSchema],
  ["device-shift-create-pallets.json", deviceShiftCreateSchema],
  ["sscc-block-request.json", ssccBlockRequestSchema],
  ["facts-request.json", factBatchSchema],
  ["facts-request-pallets.json", factBatchSchema],
] as const;
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
      plannedQty: 1200,
    });
  });

  it("a shift planned with no plan and no counterparty names both as null and still names the mode and pallets", () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
      plannedQty: 1200,
    });
  });

  it("a station's new shift with pallets names them, their capacity and their template (plan ПЛ-Ц)", () => {
    const shift = deviceShiftCreateSchema.parse(fixture("device-shift-create-pallets.json"));
    const plain = {
      requestId: shift.requestId,
      productId: shift.productId,
      boxTemplateId: shift.boxTemplateId,
      productionDate: shift.productionDate,
      boxCapacity: 12,
      plannedQty: null,
    };
    const pallets = { boxCapacity: 40, templateId: "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f" };
    expect(deviceShiftCreate({ ...plain, pallets })).toStrictEqual(
      fixture("device-shift-create-pallets.json"),
    );
    // Without pallets, none of their fields: the host's rule for a shift without them.
    const body = deviceShiftCreate(plain);
    for (const field of ["palletsEnabled", "palletBoxCapacity", "palletTemplateId"]) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it("a shift planned with no plan and no counterparty names both as null and still names the mode and pallets", () => {
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
describe("shift shapes", () => {
  it("read a planned shift without a plan, a counterparty, an owner or times, and a closed one", () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
describe("shift shapes", () => {
  it("read a station's shift with pallets: their capacity, their template and its frozen layout (plan ПЛ-Ц)", () => {
    const entered = enteredShiftSchema.parse(fixture("device-shift-entered-pallets.json"));
    expect(entered).toMatchObject({
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f",
      snapshot: { palletTemplate: { rev: 63, spec: { widthMm: 100 } } },
    });
    // A shift without pallets names neither field (protocol 3 keeps
    // `device-shifts.json` as it was), and its snapshot has no pallet template.
    const [listed] = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts;
    expect(listed).not.toHaveProperty("palletBoxCapacity");
    expect(listed).not.toHaveProperty("palletTemplateId");
    for (const palletBoxCapacity of [0, 1.5, "40"]) {
      expect(enteredShiftSchema.safeParse({ ...entered, palletBoxCapacity }).success).toBe(false);
    }
    expect(enteredShiftSchema.safeParse({ ...entered, palletTemplateId: "42" }).success).toBe(
      false,
    );
  });

  it("read a planned shift without a plan, a counterparty, an owner or times, and a closed one", () => {
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
  });

  it("take a receipt code a newer host adds, and refuse a taken code without its owner", () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
  });

  it("read the pallets' records of protocol 3 and refuse what the host refuses (plan ПЛ-Ц)", () => {
    const [box, closed, label, exception] = factBatchSchema.parse(
      fixture("facts-request-pallets.json"),
    ).records;
    expect(box).toMatchObject({
      kind: "box_closed",
      data: { palletId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" },
    });
    expect(closed).toMatchObject({ kind: "pallet_closed", data: { boxCount: 40, serial: 40 } });
    const data = (record: unknown, change: Record<string, unknown>) => ({
      ...(record as Record<string, unknown>),
      data: { ...(record as { data: Record<string, unknown> }).data, ...change },
    });
    expect(factRecordSchema.safeParse(data(box, { palletId: "pallet-1" })).success).toBe(false);
    expect(factRecordSchema.safeParse(data(closed, { boxCount: 0 })).success).toBe(false);
    expect(factRecordSchema.safeParse(data(label, { outcome: "printed" })).success).toBe(false);
    expect(factRecordSchema.safeParse(data(exception, { exception: "undo" })).success).toBe(false);
    expect(factRecordSchema.safeParse(data(exception, { reasonCode: null })).success).toBe(false);
    // A pallet's record is read by its kind only: not as a box's.
    expect(factRecordSchema.safeParse({ ...(closed as object), kind: "box_closed" }).success).toBe(
      false,
    );
  });

  it("take a receipt code a newer host adds, and refuse a taken code without its owner", () => {
```

Правка `apps/standalone/test/shift-copies.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  });

  it("refuses a layout, a GTIN and a prefix the station cannot print from", () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
  });

  it("reads a shift's pallet layout and refuses a pallets shift without one it can print (plan ПЛ-Ц)", () => {
    const pallets = enteredShiftSchema.parse(fixture("device-shift-entered-pallets.json")).snapshot;
    expect(checkShiftSnapshot(pallets, true)).toMatchObject({
      ok: true,
      snapshot: { palletTemplate: { rev: 63, spec: { widthMm: 100, language: "zpl" } } },
    });
    // Without pallets the pallet layout is not needed and a box's snapshot reads as before.
    expect(checkShiftSnapshot(snapshot)).toMatchObject({
      ok: true,
      snapshot: { palletTemplate: null },
    });
    expect(checkShiftSnapshot(snapshot, true)).toEqual({ ok: false, reason: "layout" });
    const broken = {
      ...pallets,
      palletTemplate: { ...pallets.palletTemplate, spec: { widthMm: 5 } },
    };
    expect(checkShiftSnapshot(broken, true)).toEqual({ ok: false, reason: "layout" });
  });

  it("refuses a layout, a GTIN and a prefix the station cannot print from", () => {
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-facts.test.ts test/floor-shift-list.test.tsx test/protocol.test.ts test/shift-copies.test.ts`
Expected: FAIL — `test/protocol.test.ts`: 7 из 244 — «parses without losing a field» трёх новых фикстур (схема станции отбрасывает поля паллет `device-shift-entered-pallets.json` и не знает полей `device-shift-create-pallets.json`, `facts-request-pallets.json`), «a station's new shift with pallets names them, their capacity and their template (plan ПЛ-Ц)», «read a station's shift with pallets: their capacity, their template and its frozen layout (plan ПЛ-Ц)», «know every receipt code of the host», «read the pallets' records of protocol 3 and refuse what the host refuses (plan ПЛ-Ц)»; `test/floor-facts.test.ts` — «build every record of facts-request-pallets.json exactly (plan ПЛ-Ц)» (`Unrecognized key: "palletId"`); `test/shift-copies.test.ts` — «reads a shift's pallet layout and refuses a pallets shift without one it can print (plan ПЛ-Ц)»; `test/floor-shift-list.test.tsx` — «says why the host refused the entry (pallet_template_not_fit) and keeps the list».

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/floor/facts.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  type FactRecord,
  type ScanFact,
```

заменить на:

<!-- prettier-ignore -->
```ts
  type FactRecord,
  type PalletClosedFact,
  type PalletExceptionFact,
  type PalletLabelFact,
  type ScanFact,
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  return { ...head, kind: "shift_closed", data };
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  return { ...head, kind: "shift_closed", data };
}

/** A `pallet_closed` record: a pallet closed with the SSCC of one of this station's pallet blocks (plan ПЛ-Ц). */
export function palletClosedRecord(head: RecordHead, data: PalletClosedFact): FactRecord {
  return { ...head, kind: "pallet_closed", data };
}

/** A `pallet_label` record: the check of a closed pallet's label (plan ПЛ-Ц). */
export function palletLabelRecord(head: RecordHead, data: PalletLabelFact): FactRecord {
  return { ...head, kind: "pallet_label", data };
}

/** A `pallet_exception` record: a pallet's reprint or disassembly (plan ПЛ-Ц). */
export function palletExceptionRecord(head: RecordHead, data: PalletExceptionFact): FactRecord {
  return { ...head, kind: "pallet_exception", data };
}
```

Правка `apps/standalone/src/floor/shifts/shift-copies.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  }
  const checked = checkShiftSnapshot(raw);
  return checked.ok
```

заменить на:

<!-- prettier-ignore -->
```ts
  }
  const checked = checkShiftSnapshot(raw, copy.palletsEnabled);
  return checked.ok
```

Правка `apps/standalone/src/floor/shifts/shift-entry.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
 * (`busy`: another station opened it, `closed`, `other_line`, `not_found`:
 * deleted, `product_inactive`, `template_not_fit`); its layout is one this
 * build does not read (`unreadable`); this computer could not keep it
```

заменить на:

<!-- prettier-ignore -->
```ts
 * (`busy`: another station opened it, `closed`, `other_line`, `not_found`:
 * deleted, `product_inactive`, `template_not_fit`, `pallet_template_not_fit`:
 * the pallet template, plan ПЛ-Х); its layout is one this
 * build does not read (`unreadable`); this computer could not keep it
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  | "template_not_fit"
  | "unreadable"
```

заменить на:

<!-- prettier-ignore -->
```ts
  | "template_not_fit"
  | "pallet_template_not_fit"
  | "unreadable"
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  template_not_fit: "template_not_fit",
};
```

заменить на:

<!-- prettier-ignore -->
```ts
  template_not_fit: "template_not_fit",
  pallet_template_not_fit: "pallet_template_not_fit",
};
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  }
  if (!checkShiftSnapshot(answer.snapshot).ok) return { kind: "refused", reason: "unreadable" };
  try {
```

заменить на:

<!-- prettier-ignore -->
```ts
  }
  if (!checkShiftSnapshot(answer.snapshot, answer.palletsEnabled).ok) {
    return { kind: "refused", reason: "unreadable" };
  }
  try {
```

Правка `apps/standalone/src/floor/shifts/shift-snapshot.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  product: ShiftSnapshot["product"];
  boxTemplate: { id: string; name: string; rev: number; spec: LabelTemplateSpec };
  issuerPrefix: string;
  counterpartyName: string | null;
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  product: ShiftSnapshot["product"];
  boxTemplate: SnapshotTemplate;
  issuerPrefix: string;
  counterpartyName: string | null;
  /** The pallet layout of a shift with pallets (plan ПЛ-Ц); `null` — a shift without. */
  palletTemplate: SnapshotTemplate | null;
}

/** A template as the snapshot froze it, with the layout the domain read. */
export interface SnapshotTemplate {
  id: string;
  name: string;
  rev: number;
  spec: LabelTemplateSpec;
}
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
const ISSUER_PREFIX = /^[0-9]{9}$/;

/**
 * Checks a shift's snapshot before the station works the shift: once when it
 * enters (the host never checks a layout, stage 2a spec §4.2) and again when
 * a stored one is read back. A snapshot that fails keeps the operator out of
 * the shift; nothing is printed from a layout the domain does not read.
 */
export function checkShiftSnapshot(raw: unknown): SnapshotCheck {
  const parsed = shiftSnapshotSchema.safeParse(raw);
```

заменить на:

<!-- prettier-ignore -->
```ts
const ISSUER_PREFIX = /^[0-9]{9}$/;

/** A frozen template whose layout the domain reads, or `null`. */
function readTemplate(template: {
  id: string;
  name: string;
  rev: number;
  spec: unknown;
}): SnapshotTemplate | null {
  const spec = labelTemplateSpecSchema.safeParse(template.spec);
  return spec.success
    ? { id: template.id, name: template.name, rev: template.rev, spec: spec.data }
    : null;
}

/**
 * Checks a shift's snapshot before the station works the shift: once when it
 * enters (the host never checks a layout, stage 2a spec §4.2) and again when
 * a stored one is read back. A snapshot that fails keeps the operator out of
 * the shift; nothing is printed from a layout the domain does not read. A
 * shift with pallets (`palletsEnabled`, plan ПЛ-Ц) needs its pallet layout as
 * well: a snapshot kept by a build before pallets has none, and the next
 * entry with the host brings it.
 */
export function checkShiftSnapshot(raw: unknown, palletsEnabled = false): SnapshotCheck {
  const parsed = shiftSnapshotSchema.safeParse(raw);
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
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
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (!ISSUER_PREFIX.test(issuerPrefix)) return { ok: false, reason: "prefix" };
  const box = readTemplate(boxTemplate);
  if (box === null) return { ok: false, reason: "layout" };
  const pallet =
    parsed.data.palletTemplate === undefined ? null : readTemplate(parsed.data.palletTemplate);
  if (palletsEnabled && pallet === null) return { ok: false, reason: "layout" };
  return {
    ok: true,
    snapshot: {
      product,
      boxTemplate: box,
      issuerPrefix,
      counterpartyName,
      palletTemplate: palletsEnabled ? pallet : null,
    },
```

Правка `apps/standalone/src/host/protocol.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
 * the station prints and reprints from this alone. A response type, so a
 * field a newer host adds is tolerated (and dropped).
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
 * the station prints and reprints from this alone. A response type, so a
 * field a newer host adds is tolerated (and dropped). A shift with pallets
 * freezes its pallet template too (protocol 3); one without has none.
 */
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  counterpartyName: z.string().nullable(),
});
```

заменить на:

<!-- prettier-ignore -->
```ts
  counterpartyName: z.string().nullable(),
  palletTemplate: shiftSnapshotTemplateSchema.optional(),
});
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
 * records before; `ownerDeviceId` is the station that opened it, and another
 * station's id means the shift is busy.
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
 * records before; `ownerDeviceId` is the station that opened it, and another
 * station's id means the shift is busy. A shift with pallets names their
 * capacity and template (protocol 3, plan ПЛ-Х); one without names neither —
 * the fields are absent, not `null`.
 */
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  boxTemplateId: z.uuid(),
  ownerDeviceId: z.uuid().nullable(),
```

заменить на:

<!-- prettier-ignore -->
```ts
  boxTemplateId: z.uuid(),
  palletBoxCapacity: z.number().int().positive().optional(),
  palletTemplateId: z.uuid().optional(),
  ownerDeviceId: z.uuid().nullable(),
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
  "sscc_taken",
] as const;
```

заменить на:

<!-- prettier-ignore -->
```ts
  "sscc_taken",
  "no_pallets",
  "pallet_unknown",
  "pallet_already_closed",
  "pallet_state",
] as const;
```

Фрагмент 6:

<!-- prettier-ignore -->
```ts
 * planned shift on its own line. `requestId`, a UUID the station made up,
 * makes it repeatable: the same request answers the shift it created.
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
 * planned shift on its own line. `requestId`, a UUID the station made up,
 * makes it repeatable: the same request answers the shift it created. A
 * shift with pallets names its pallet template and may name its pallet
 * capacity (the product's when left out); one without sends none of the
 * three (protocol 3, `device-shift-create-pallets.json`).
 */
```

Фрагмент 7:

<!-- prettier-ignore -->
```ts
    counterpartyId: z.uuid().nullable().optional(),
  })
```

заменить на:

<!-- prettier-ignore -->
```ts
    counterpartyId: z.uuid().nullable().optional(),
    palletsEnabled: z.boolean().optional(),
    palletBoxCapacity: z.number().int().positive().optional(),
    palletTemplateId: z.uuid().optional(),
  })
```

Фрагмент 8:

<!-- prettier-ignore -->
```ts
 * `POST /v1/device/sscc/blocks` (`markiro_proto::SsccBlockRequest`): a block
 * of the shift's issuer prefix and an extension (0, a box). The station keeps
 * the request (`floor_block_requests`) and repeats it whole until it has the
```

заменить на:

<!-- prettier-ignore -->
```ts
 * `POST /v1/device/sscc/blocks` (`markiro_proto::SsccBlockRequest`): a block
 * of the shift's issuer prefix and an extension (0, a box; 1, a pallet). The station keeps
 * the request (`floor_block_requests`) and repeats it whole until it has the
```

Фрагмент 9:

<!-- prettier-ignore -->
```ts
export type ScanFact = z.infer<typeof scanFactSchema>;

/** `data` of a `box_closed` fact (`markiro_proto::BoxClosedFact`). */
export const boxClosedFactSchema = z
```

заменить на:

<!-- prettier-ignore -->
```ts
export type ScanFact = z.infer<typeof scanFactSchema>;

/**
 * `data` of a `box_closed` fact (`markiro_proto::BoxClosedFact`); `palletId`
 * is the pallet the box joined as it closed (protocol 3, plan ПЛ-Х), absent
 * in a shift without pallets.
 */
export const boxClosedFactSchema = z
```

Фрагмент 10:

<!-- prettier-ignore -->
```ts
    membershipDigest: z.string(),
  })
```

заменить на:

<!-- prettier-ignore -->
```ts
    membershipDigest: z.string(),
    palletId: z.uuid().optional(),
  })
```

Фрагмент 11:

<!-- prettier-ignore -->
```ts
export type ShiftClosedFact = z.infer<typeof shiftClosedFactSchema>;

/** The envelope of every record: its own id, the shift and the operator signed in, or `null`. */
```

заменить на:

<!-- prettier-ignore -->
```ts
export type ShiftClosedFact = z.infer<typeof shiftClosedFactSchema>;

/**
 * `data` of a `pallet_closed` fact (`markiro_proto::PalletClosedFact`): the
 * pallet closed with the SSCC of one of this station's blocks of extension 1;
 * `openedAt` is when its first box closed, `boxCount` the boxes on it that
 * are not taken apart, as this station counts them.
 */
export const palletClosedFactSchema = z
  .object({
    palletId: z.uuid(),
    sscc: z.string(),
    blockId: z.uuid(),
    serial: z.number().int().nonnegative(),
    openedAt: z.string(),
    closedAt: z.string(),
    boxCount: z.number().int().positive(),
  })
  .strict();
export type PalletClosedFact = z.infer<typeof palletClosedFactSchema>;

/** `data` of a `pallet_label` fact (`markiro_proto::PalletLabelFact`): the check of a closed pallet's label. */
export const palletLabelFactSchema = z
  .object({ palletId: z.uuid(), outcome: z.enum(["verified", "skipped"]), at: z.string() })
  .strict();
export type PalletLabelFact = z.infer<typeof palletLabelFactSchema>;

/**
 * `data` of a `pallet_exception` fact (`markiro_proto::PalletExceptionFact`):
 * a reprint or a disassembly of a closed pallet, always with a reason code,
 * and words only with `other`.
 */
export const palletExceptionFactSchema = z
  .object({
    exception: z.enum(["reprint", "disassemble"]),
    palletId: z.uuid(),
    reasonCode: z.string(),
    reasonText: z.string().nullable(),
    occurredAt: z.string(),
  })
  .strict();
export type PalletExceptionFact = z.infer<typeof palletExceptionFactSchema>;

/** The envelope of every record: its own id, the shift and the operator signed in, or `null`. */
```

Фрагмент 12:

<!-- prettier-ignore -->
```ts
  z.object({ ...factHead, kind: z.literal("shift_closed"), data: shiftClosedFactSchema }).strict(),
]);
```

заменить на:

<!-- prettier-ignore -->
```ts
  z.object({ ...factHead, kind: z.literal("shift_closed"), data: shiftClosedFactSchema }).strict(),
  z
    .object({ ...factHead, kind: z.literal("pallet_closed"), data: palletClosedFactSchema })
    .strict(),
  z.object({ ...factHead, kind: z.literal("pallet_label"), data: palletLabelFactSchema }).strict(),
  z
    .object({ ...factHead, kind: z.literal("pallet_exception"), data: palletExceptionFactSchema })
    .strict(),
]);
```

Правка `apps/standalone/src/host/requests.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  plannedQty: number | null;
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  plannedQty: number | null;
  /** «С паллетами» (plan ПЛ-Ц): boxes per pallet and the pallet template; absent — none. */
  pallets?: { boxCapacity: number; templateId: string };
}
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
 * for no plan, and no counterparty, of which the station keeps no copy. The
 * line is the station's own and no field.
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
 * for no plan, and no counterparty, of which the station keeps no copy. The
 * line is the station's own and no field. A shift with pallets adds their
 * three fields (`device-shift-create-pallets.json`); one without sends none.
 */
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
    counterpartyId: null,
  };
```

заменить на:

<!-- prettier-ignore -->
```ts
    counterpartyId: null,
    ...(shift.pallets === undefined
      ? {}
      : {
          palletsEnabled: true,
          palletBoxCapacity: shift.pallets.boxCapacity,
          palletTemplateId: shift.pallets.templateId,
        }),
  };
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
        "template_not_fit": "Шаблон этикетки смены выключен или не подходит товару: смену не открыть. Обратитесь в офис.",
        "unreadable": "Этикетку этой смены приложение прочитать не может. Обновите приложение или попросите офис закрыть смену.",
```

заменить на:

<!-- prettier-ignore -->
```json
        "template_not_fit": "Шаблон этикетки смены выключен или не подходит товару: смену не открыть. Обратитесь в офис.",
        "pallet_template_not_fit": "Шаблон этикетки паллеты выключен или не подходит товару: смену не открыть. Обратитесь в офис.",
        "unreadable": "Этикетку этой смены приложение прочитать не может. Обновите приложение или попросите офис закрыть смену.",
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-facts.test.ts test/floor-shift-list.test.tsx test/protocol.test.ts test/shift-copies.test.ts`
Expected: PASS — `Test Files  4 passed (4)`, `Tests  288 passed (288)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  112 passed (112)`, `Tests  2666 passed (2666)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — `palletId` записи `box_closed` — любая строка, а не UUID.
В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
    membershipDigest: z.string(),
    palletId: z.uuid().optional(),
```

заменить на:

<!-- prettier-ignore -->
```ts
    membershipDigest: z.string(),
    palletId: z.string().optional(),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: FAIL — «read the pallets' records of protocol 3 and refuse what the host refuses (plan ПЛ-Ц)».

М2 — паллета закрывается с нулём коробов.
В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
    closedAt: z.string(),
    boxCount: z.number().int().positive(),
```

заменить на:

<!-- prettier-ignore -->
```ts
    closedAt: z.string(),
    boxCount: z.number().int().nonnegative(),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: FAIL — «read the pallets' records of protocol 3 and refuse what the host refuses (plan ПЛ-Ц)».

М3 — смена с паллетами работает по снимку без макета паллеты.
В `apps/standalone/src/floor/shifts/shift-snapshot.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (palletsEnabled && pallet === null) return { ok: false, reason: "layout" };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-copies.test.ts`
Expected: FAIL — «reads a shift's pallet layout and refuses a pallets shift without one it can print (plan ПЛ-Ц)».

М4 — отказ входа `pallet_template_not_fit` не узнаётся.
В `apps/standalone/src/floor/shifts/shift-entry.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  pallet_template_not_fit: "pallet_template_not_fit",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-list.test.tsx`
Expected: FAIL — «says why the host refused the entry (pallet_template_not_fit) and keeps the list».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/facts.ts apps/standalone/src/floor/shifts/shift-copies.ts apps/standalone/src/floor/shifts/shift-entry.ts apps/standalone/src/floor/shifts/shift-snapshot.ts apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/src/i18n/ru.json apps/standalone/test/floor-facts.test.ts apps/standalone/test/floor-shift-list.test.tsx apps/standalone/test/protocol.test.ts apps/standalone/test/shift-copies.test.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/facts.ts apps/standalone/src/floor/shifts/shift-copies.ts apps/standalone/src/floor/shifts/shift-entry.ts apps/standalone/src/floor/shifts/shift-snapshot.ts apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/src/i18n/ru.json apps/standalone/test/floor-facts.test.ts apps/standalone/test/floor-shift-list.test.tsx apps/standalone/test/protocol.test.ts apps/standalone/test/shift-copies.test.ts
git commit -m "feat(standalone): protocol 3 on the station — a shift's pallets, its pallet layout, the pallets' records and receipt codes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Миграция `0008` — паллеты в базе станции, паллеты в копиях смен, таблицы срока хранения

Локальная миграция `src-tauri/migrations/0008_floor_pallets.sql` (спецификация пилота §6.2 «Цех»): столбцы `floor_shifts.pallet_box_capacity` и `pallet_template_id`, `floor_boxes.pallet_id` (только у закрытого короба), таблицы `floor_pallets` (открыта без SSCC или закрыта целиком; SSCC — 18 цифр с расширением 1; одна открытая паллета на смену и подключение; SSCC — на одной паллете при любом подключении) и `floor_pallet_exceptions` (`reprint` или `disassemble`, код причины всегда, слова только при `other`). Без внешних ключей, класс `DeviceData` (`TABLE_CLASSES` оболочки и её тест). `floor_print_jobs` не пересобирается: назначение `pallet` есть с плана 2a7. Копии смен хранят поля паллет хоста; `RETAINED_TABLES` получает две таблицы (тест 2a8 «names every table» падает без них).

**Files:**

- Create: `apps/standalone/src-tauri/migrations/0008_floor_pallets.sql`
- Modify: `apps/standalone/src-tauri/src/local_db.rs`, `apps/standalone/src/floor/shifts/new-shift.ts`, `apps/standalone/src/floor/shifts/shift-copies.ts`, `apps/standalone/src/local/retention.ts`
- Test: `apps/standalone/test/floor-pallet-schema.test.ts` (Create), `apps/standalone/src-tauri/tests/local_db.rs` (Modify), `apps/standalone/test/floor-schema.test.ts` (Modify), `apps/standalone/test/local-executor.test.ts` (Modify), `apps/standalone/test/retention.test.ts` (Modify), `apps/standalone/test/shift-copies.test.ts` (Modify)

**Interfaces:**

- Consumes: задача 1 (`DeviceShift` с полями паллет, `checkShiftSnapshot`); `replaceShiftCopies`, `readShiftCopy`, `readStoredWork` (план 2a5), `RETAINED_TABLES` (план 2a8), `TABLE_CLASSES` (план 2a4).
- Produces:
  - таблицы `floor_pallets`, `floor_pallet_exceptions`, столбцы `floor_shifts.pallet_box_capacity`, `pallet_template_id`, `floor_boxes.pallet_id`, индексы `floor_pallets_sscc`, `floor_pallets_open`, `floor_boxes_pallet`;
  - `ShiftCopy.palletBoxCapacity: number | null`, `ShiftCopy.palletTemplateId: string | null`; `RETAINED_TABLES` += `floor_pallet_exceptions`, `floor_pallets`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/src-tauri/tests/local_db.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
            "floor_block_requests",
            "floor_boxes",
            "floor_codes",
            "floor_exceptions",
            "floor_print_jobs",
            "floor_scans",
            "floor_shifts",
            "floor_sign_in_failures",
```

заменить на:

<!-- prettier-ignore -->
```rust
            "floor_block_requests",
            "floor_boxes",
            "floor_codes",
            "floor_exceptions",
            "floor_pallet_exceptions",
            "floor_pallets",
            "floor_print_jobs",
            "floor_scans",
            "floor_shifts",
            "floor_sign_in_failures",
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
    );
    // This device's own records are the production tables of `0006` and the
    // print jobs of `0007`; the sign-in lockouts stay with the copies (an
    // open owner question); the workstation's settings belong to the PC.
    let device_data: Vec<&str> = TABLE_CLASSES
```

заменить на:

<!-- prettier-ignore -->
```rust
    );
    // This device's own records are the production tables of `0006`, the
    // print jobs of `0007` and the pallets of `0008`; the sign-in lockouts
    // stay with the copies (an open owner question); the workstation's
    // settings belong to the PC.
    let device_data: Vec<&str> = TABLE_CLASSES
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
            "floor_exceptions",
            "floor_print_jobs",
```

заменить на:

<!-- prettier-ignore -->
```rust
            "floor_exceptions",
            "floor_pallet_exceptions",
            "floor_pallets",
            "floor_print_jobs",
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
    .unwrap();
    // One record in each table of this device's own (`0006`, `0007`) and
    // one setting of the workstation (`0007`).
```

заменить на:

<!-- prettier-ignore -->
```rust
    .unwrap();
    // One record in each table of this device's own (`0006`–`0008`) and
    // one setting of the workstation (`0007`).
```

Фрагмент 5:

<!-- prettier-ignore -->
```rust
}

/// One row in each table of this device's own records (migration `0006`),
/// each of the pairing `(HOST, DEVICE)`, as the floor's writers will write
/// them through `local_transaction`.
fn device_records() -> Vec<LocalStatement> {
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// One row in each table of this device's own records (migrations
/// `0006`–`0008`), each of the pairing `(HOST, DEVICE)`, as the floor's
/// writers will write them through `local_transaction`.
fn device_records() -> Vec<LocalStatement> {
```

Фрагмент 6:

<!-- prettier-ignore -->
```rust
             '2026-10-08T06:04:00.000Z', '2026-10-08T06:04:00.000Z')",
            json!([HOST, DEVICE]),
```

заменить на:

<!-- prettier-ignore -->
```rust
             '2026-10-08T06:04:00.000Z', '2026-10-08T06:04:00.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_pallets (id, host_id, device_id, shift_id, opened_at) \
             VALUES ('pallet-1', ?, ?, 'shift-1', '2026-10-08T06:04:00.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_pallet_exceptions (id, host_id, device_id, shift_id, kind, \
             pallet_id, reason_code, occurred_at) VALUES ('pallet-exception-1', ?, ?, \
             'shift-1', 'reprint', 'pallet-1', 'printer_jam', '2026-10-08T06:05:00.000Z')",
            json!([HOST, DEVICE]),
```

Создать `apps/standalone/test/floor-pallet-schema.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import type { LocalExecutor, LocalStatement } from "../src/local/executor.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const AT = "2026-10-09T08:00:00.000Z";
const PALLET_SSCC = "146006820000000409";

function insert(table: string, row: Record<string, unknown>): LocalStatement {
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

function pallet(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  return insert("floor_pallets", {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: "shift-1",
    opened_at: AT,
    ...overrides,
  });
}

function closedPallet(id: string, sscc: string, overrides: Record<string, unknown> = {}) {
  return pallet(id, { closed_at: AT, sscc, block_id: "block-1", serial: 40, ...overrides });
}

function palletException(id: string, overrides: Record<string, unknown>): LocalStatement {
  return insert("floor_pallet_exceptions", {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: "shift-1",
    pallet_id: "pallet-1",
    occurred_at: AT,
    ...overrides,
  });
}

function shift(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  return insert("floor_shifts", {
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    id,
    number: "OCT26-004",
    status: "planned",
    mode: "aggregation",
    pallets_enabled: 1,
    created_from: "office",
    line_id: LINE_ID,
    product_id: "product-1",
    product_name: "Молоко",
    product_gtin14: "04600682000013",
    production_date: "2026-10-09",
    box_capacity: 12,
    box_template_id: "template-1",
    pallet_box_capacity: 40,
    pallet_template_id: "pallet-template-1",
    seen_at: 1_790_000_000_000,
    ...overrides,
  });
}

function box(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  return insert("floor_boxes", {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: "shift-1",
    opened_at: AT,
    ...overrides,
  });
}

async function refused(local: LocalExecutor, statement: LocalStatement): Promise<void> {
  await expect(local.transaction([statement])).rejects.toMatchObject({ code: "statement_failed" });
}

async function accepted(local: LocalExecutor, statement: LocalStatement): Promise<void> {
  await expect(local.transaction([statement])).resolves.toEqual([1]);
}

describe("the station's pallets (migration 0008)", () => {
  it("keep a shift's boxes per pallet, a whole number above zero, and its pallet template", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, shift("pallets"));
    await accepted(
      executor,
      shift("boxes", { pallets_enabled: 0, pallet_box_capacity: null, pallet_template_id: null }),
    );
    await refused(executor, shift("none", { pallet_box_capacity: 0 }));
  });

  it("put only a closed box on a pallet", async () => {
    const { executor } = openLocalDb();
    await refused(executor, box("open", { pallet_id: "pallet-1" }));
    await accepted(executor, box("loose"));
    const closed = { closed_at: AT, block_id: "block-1", serial: 1, sscc: "046006820000000017" };
    await accepted(executor, box("on-pallet", { ...closed, pallet_id: "pallet-1" }));
  });

  it("close a pallet whole, with its SSCC of extension 1, block and serial, or keep it open without them", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, pallet("open"));
    await accepted(executor, closedPallet("closed", PALLET_SSCC));
    await refused(executor, pallet("half", { closed_at: AT }));
    await refused(executor, pallet("numbered", { sscc: "146006820000000416" }));
    await refused(executor, pallet("apart", { disassembled_at: AT, shift_id: "shift-2" }));
    // A box's SSCC (extension 0) or anything but 18 digits is no pallet's.
    for (const sscc of ["046006820000000417", "14600682000000041", "14600682000000041x"]) {
      await refused(executor, closedPallet(`bad-${sscc}`, sscc, { shift_id: "shift-3" }));
    }
    await accepted(
      executor,
      closedPallet("taken-apart", "146006820000000423", { disassembled_at: AT }),
    );
  });

  it("hold one open pallet per shift and pairing, and an SSCC on one pallet under any pairing", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, pallet("open-1"));
    await refused(executor, pallet("open-2"));
    await accepted(executor, pallet("open-3", { device_id: OTHER_DEVICE }));
    await accepted(executor, pallet("open-4", { shift_id: "shift-2" }));
    await accepted(executor, closedPallet("closed-1", PALLET_SSCC));
    await accepted(executor, closedPallet("closed-2", "146006820000000416"));
    await refused(executor, closedPallet("closed-3", PALLET_SSCC, { device_id: OTHER_DEVICE }));
  });

  it("take a pallet's exception of its two kinds, always with a reason, words only with `other`", async () => {
    const { executor } = openLocalDb();
    await accepted(
      executor,
      palletException("reprint", { kind: "reprint", reason_code: "printer_jam" }),
    );
    await accepted(
      executor,
      palletException("disassemble", {
        kind: "disassemble",
        reason_code: "other",
        reason_text: "Не тот заказ",
      }),
    );
    await refused(executor, palletException("undo", { kind: "undo", reason_code: "other" }));
    await refused(executor, palletException("bare", { kind: "reprint", reason_code: null }));
    await refused(
      executor,
      palletException("words", {
        kind: "disassemble",
        reason_code: "wrong_product",
        reason_text: "Не тот товар",
      }),
    );
  });
});
```

Правка `apps/standalone/test/floor-schema.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
const AT = "2026-10-09T08:00:00.000Z";

/** The tables of this device's own records (migrations `0006`, `0007`; `TableClass::DeviceData`). */
const DEVICE_TABLES = [
```

заменить на:

<!-- prettier-ignore -->
```ts
const AT = "2026-10-09T08:00:00.000Z";

/** The tables of this device's own records (migrations `0006`–`0008`; `TableClass::DeviceData`). */
const DEVICE_TABLES = [
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  "floor_exceptions",
  "floor_print_jobs",
```

заменить на:

<!-- prettier-ignore -->
```ts
  "floor_exceptions",
  "floor_pallet_exceptions",
  "floor_pallets",
  "floor_print_jobs",
```

Правка `apps/standalone/test/local-executor.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
      "floor_exceptions",
      "floor_print_jobs",
```

заменить на:

<!-- prettier-ignore -->
```ts
      "floor_exceptions",
      "floor_pallet_exceptions",
      "floor_pallets",
      "floor_print_jobs",
```

Правка `apps/standalone/test/retention.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  floor_exceptions: 0,
  floor_codes: 0,
  floor_print_jobs: 0,
  floor_boxes: 0,
  outbox: 0,
```

заменить на:

<!-- prettier-ignore -->
```ts
  floor_exceptions: 0,
  floor_pallet_exceptions: 0,
  floor_codes: 0,
  floor_print_jobs: 0,
  floor_boxes: 0,
  floor_pallets: 0,
  outbox: 0,
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  floor_exceptions: 1,
  floor_codes: 1,
  floor_print_jobs: 1,
  floor_boxes: 1,
  outbox: 5,
```

заменить на:

<!-- prettier-ignore -->
```ts
  floor_exceptions: 1,
  floor_pallet_exceptions: 0,
  floor_codes: 1,
  floor_print_jobs: 1,
  floor_boxes: 1,
  floor_pallets: 0,
  outbox: 5,
```

Правка `apps/standalone/test/shift-copies.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import {
  deviceShiftsSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
import {
  deviceShiftSchema,
  deviceShiftsSchema,
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
      boxTemplateId: ACTIVE.boxTemplateId,
      ownerDeviceId: ACTIVE.ownerDeviceId,
```

заменить на:

<!-- prettier-ignore -->
```ts
      boxTemplateId: ACTIVE.boxTemplateId,
      palletBoxCapacity: null,
      palletTemplateId: null,
      ownerDeviceId: ACTIVE.ownerDeviceId,
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
});

describe("a stored shift to work", () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
});

describe("the copies of a shift with pallets (plan ПЛ-Ц)", () => {
  const PALLETS: EnteredShift = enteredShiftSchema.parse(
    fixture("device-shift-entered-pallets.json"),
  );

  it("keep its boxes per pallet and pallet template, and neither for a shift without pallets", async () => {
    // The list names a shift without its snapshot.
    const listed = deviceShiftSchema.parse(PALLETS);
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [listed, PLANNED], SEEN);
    expect(await readShiftCopy(executor, PAIRING, PALLETS.id)).toMatchObject({
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f",
    });
    expect(await readShiftCopy(executor, PAIRING, PLANNED.id)).toMatchObject({
      palletsEnabled: false,
      palletBoxCapacity: null,
      palletTemplateId: null,
    });
  });

  it("work the shift from its stored snapshot with the pallet layout, and refuse one kept without it", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, PALLETS, AT, SEEN);
    const work = await readStoredWork(executor, PAIRING, PALLETS.id);
    if (work.kind !== "ready") throw new Error(`not ready: ${work.kind}`);
    expect(work.shift.copy).toMatchObject({ palletsEnabled: true, palletBoxCapacity: 40 });
    expect(work.shift.snapshot.palletTemplate).toMatchObject({
      id: "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f",
      rev: 63,
      spec: { widthMm: 100, heightMm: 150 },
    });
    // A snapshot an older build kept dropped the pallet template: not worked from.
    const older = { ...PALLETS.snapshot, palletTemplate: undefined };
    db.prepare("UPDATE floor_shifts SET snapshot = ?").run(JSON.stringify(older));
    expect(await readStoredWork(executor, PAIRING, PALLETS.id)).toEqual({
      kind: "unreadable",
      reason: "layout",
    });
  });
});

describe("a stored shift to work", () => {
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallet-schema.test.ts test/floor-schema.test.ts test/local-executor.test.ts test/retention.test.ts test/shift-copies.test.ts`
Expected: FAIL — `test/floor-pallet-schema.test.ts`: 5 из 5 (`table floor_shifts has no column named pallet_box_capacity`, таблиц паллет нет); `test/floor-schema.test.ts` — «tag every row with its pairing and have no foreign key»; `test/local-executor.test.ts` — «has exactly the shell's tables»; `test/retention.test.ts` — 5 из 8 (счёт таблиц `RETAINED_TABLES` без паллетных); `test/shift-copies.test.ts` — 3 из 16 («take the host's list as this pairing's, and show the line's open shifts by date» и оба новых теста копий смены с паллетами).

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db` (в свежем worktree сначала `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`)
Expected: FAIL — `every_table_has_a_forget_class` (`left` без `floor_pallet_exceptions`, `floor_pallets`), `clearing_the_copies_empties_the_disposable_tables_and_nothing_else`, `opening_creates_the_reference_tables_in_wal_mode_and_keeps_data`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src-tauri/migrations/0008_floor_pallets.sql`:

<!-- prettier-ignore -->
```sql
-- The station's pallets (pilot spec §6.2, plan ПЛ-Ц): a shift with pallets
-- fills its open pallet with the boxes it closes, closes it with the serial of
-- one of this station's pallet blocks (extension 1) when it holds the shift's
-- boxes per pallet or when the operator closes it early, and keeps the
-- pallet's exceptions — a reprint, a disassembly — as `pallet_exception`
-- facts. Like `0006` and `0007` these are this device's data
-- (`TableClass::DeviceData`): every row carries the pairing it was written
-- under, a forget keeps them, and there is no foreign key (see `0006`).
--
-- The print jobs of a pallet's label are rows of `floor_print_jobs` with
-- `purpose = 'pallet'` (`0007` already allows it). The SSCC blocks of pallets
-- are rows of `floor_sscc_blocks` and `floor_block_requests` with
-- `extension = 1`. Times are UTC RFC 3339 text as `Date.toISOString` writes
-- it.

-- What the host's list says of a shift with pallets (protocol 3,
-- `DeviceShift`): boxes per pallet and the pallet template; both NULL for a
-- shift without pallets. `pallets_enabled` is in `0006` already.
ALTER TABLE floor_shifts ADD COLUMN pallet_box_capacity INTEGER
  CHECK (pallet_box_capacity IS NULL OR pallet_box_capacity > 0);
ALTER TABLE floor_shifts ADD COLUMN pallet_template_id TEXT;

-- The pallet a closed box joined as it closed, in the transaction of its
-- close (the `palletId` of its `box_closed` record); NULL in a shift without
-- pallets. Only a closed box is on a pallet.
ALTER TABLE floor_boxes ADD COLUMN pallet_id TEXT
  CHECK (pallet_id IS NULL OR closed_at IS NOT NULL);

CREATE INDEX floor_boxes_pallet ON floor_boxes (pallet_id) WHERE pallet_id IS NOT NULL;

-- A pallet of a shift: open from the close of its first box (`opened_at` is
-- that box's `closed_at`) until it closes with the serial of one of this
-- station's pallet blocks. How many boxes it holds is never stored: it is
-- counted, as the closed boxes with its `pallet_id` that are not taken apart.
-- A pallet's SSCC starts with the extension digit 1 and is never on two
-- pallets, under any pairing.
CREATE TABLE floor_pallets (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  sscc TEXT CHECK (sscc IS NULL OR (length(sscc) = 18 AND sscc NOT GLOB '*[^0-9]*'
    AND substr(sscc, 1, 1) = '1')),
  block_id TEXT,
  serial INTEGER,
  closed_by TEXT,
  disassembled_at TEXT,
  CHECK (CASE WHEN closed_at IS NULL
    THEN sscc IS NULL AND block_id IS NULL AND serial IS NULL AND disassembled_at IS NULL
    ELSE sscc IS NOT NULL AND block_id IS NOT NULL AND serial IS NOT NULL END)
);

CREATE UNIQUE INDEX floor_pallets_sscc ON floor_pallets (sscc) WHERE sscc IS NOT NULL;

-- One open pallet per shift and pairing: the station's rule, not the host's
-- (plan ПЛ-Х).
CREATE UNIQUE INDEX floor_pallets_open
  ON floor_pallets (host_id, device_id, shift_id) WHERE closed_at IS NULL;

-- A pallet's exception (a `pallet_exception` fact): a reprint or a
-- disassembly, always with a reason code of its kind's list, and words only
-- with the reason `other`.
CREATE TABLE floor_pallet_exceptions (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reprint', 'disassemble')),
  pallet_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_text TEXT,
  occurred_at TEXT NOT NULL,
  operator_id TEXT,
  CHECK (reason_text IS NULL OR reason_code = 'other')
);
```

Правка `apps/standalone/src-tauri/src/local_db.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
    Disposable,
    /// What this device recorded itself — shifts, boxes, scans, the outbox
    /// (plans 2a5–2a8): the forget keeps them, each row tagged with the
    /// pairing that wrote it.
    DeviceData,
```

заменить на:

<!-- prettier-ignore -->
```rust
    Disposable,
    /// What this device recorded itself — shifts, boxes, pallets, scans, the
    /// outbox (plans 2a5–2a8, ПЛ-Ц): the forget keeps them, each row tagged
    /// with the pairing that wrote it.
    DeviceData,
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
    ("floor_exceptions", TableClass::DeviceData),
    ("floor_print_jobs", TableClass::DeviceData),
```

заменить на:

<!-- prettier-ignore -->
```rust
    ("floor_exceptions", TableClass::DeviceData),
    ("floor_pallet_exceptions", TableClass::DeviceData),
    ("floor_pallets", TableClass::DeviceData),
    ("floor_print_jobs", TableClass::DeviceData),
```

Правка `apps/standalone/src/floor/shifts/new-shift.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
export function createdCopy(shift: DeviceShift): ShiftCopy {
  return { ...shift, localState: null, entered: false };
}
```

заменить на:

<!-- prettier-ignore -->
```ts
export function createdCopy(shift: DeviceShift): ShiftCopy {
  return {
    ...shift,
    palletBoxCapacity: shift.palletBoxCapacity ?? null,
    palletTemplateId: shift.palletTemplateId ?? null,
    localState: null,
    entered: false,
  };
}
```

Правка `apps/standalone/src/floor/shifts/shift-copies.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  boxTemplateId: string;
  ownerDeviceId: string | null;
```

заменить на:

<!-- prettier-ignore -->
```ts
  boxTemplateId: string;
  /** Boxes per pallet of a shift with pallets (plan ПЛ-Ц); `null` without pallets. */
  palletBoxCapacity: number | null;
  /** The pallet template of a shift with pallets; `null` without pallets. */
  palletTemplateId: string | null;
  ownerDeviceId: string | null;
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  ["box_template_id", "boxTemplateId"],
  ["owner_device_id", "ownerDeviceId"],
```

заменить на:

<!-- prettier-ignore -->
```ts
  ["box_template_id", "boxTemplateId"],
  // Absent for a shift without pallets (protocol 3): `->>` yields NULL.
  ["pallet_box_capacity", "palletBoxCapacity"],
  ["pallet_template_id", "palletTemplateId"],
  ["owner_device_id", "ownerDeviceId"],
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  box_template_id: z.string(),
  owner_device_id: z.string().nullable(),
```

заменить на:

<!-- prettier-ignore -->
```ts
  box_template_id: z.string(),
  pallet_box_capacity: z.number().nullable(),
  pallet_template_id: z.string().nullable(),
  owner_device_id: z.string().nullable(),
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  "product_name, product_gtin14, counterparty_name, production_date, planned_qty, " +
  "box_capacity, box_template_id, owner_device_id, opened_at, closed_at, " +
  "entered_at IS NOT NULL AS entered";
```

заменить на:

<!-- prettier-ignore -->
```ts
  "product_name, product_gtin14, counterparty_name, production_date, planned_qty, " +
  "box_capacity, box_template_id, pallet_box_capacity, pallet_template_id, owner_device_id, " +
  "opened_at, closed_at, " +
  "entered_at IS NOT NULL AS entered";
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
    boxTemplateId: row.box_template_id,
    ownerDeviceId: row.owner_device_id,
```

заменить на:

<!-- prettier-ignore -->
```ts
    boxTemplateId: row.box_template_id,
    palletBoxCapacity: row.pallet_box_capacity,
    palletTemplateId: row.pallet_template_id,
    ownerDeviceId: row.owner_device_id,
```

Правка `apps/standalone/src/local/retention.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
 * retention deletes their rows with the shift's copy. A later plan's table
 * of a shift's records (the pallets' plan: `floor_pallets`,
 * `floor_pallet_exceptions`) joins this list, or a test that reads every
 * table of the database fails.
 */
export const RETAINED_TABLES = [
  "floor_scans",
  "floor_exceptions",
  "floor_codes",
  "floor_print_jobs",
  "floor_boxes",
  "outbox",
```

заменить на:

<!-- prettier-ignore -->
```ts
 * retention deletes their rows with the shift's copy. A later plan's table
 * of a shift's records joins this list, or a test that reads every table of
 * the database fails; the pallets' plan (ПЛ-Ц) added `floor_pallets` and
 * `floor_pallet_exceptions`.
 */
export const RETAINED_TABLES = [
  "floor_scans",
  "floor_exceptions",
  "floor_pallet_exceptions",
  "floor_codes",
  "floor_print_jobs",
  "floor_boxes",
  "floor_pallets",
  "outbox",
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallet-schema.test.ts test/floor-schema.test.ts test/local-executor.test.ts test/retention.test.ts test/shift-copies.test.ts`
Expected: PASS — `Test Files  5 passed (5)`, `Tests  93 passed (93)`.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`
Expected: PASS — `test result: ok. 16 passed; 0 failed`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  113 passed (113)`, `Tests  2673 passed (2673)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — SSCC паллеты не обязан начинаться с расширения 1.
В `apps/standalone/src-tauri/migrations/0008_floor_pallets.sql` фрагмент

<!-- prettier-ignore -->
```sql
  sscc TEXT CHECK (sscc IS NULL OR (length(sscc) = 18 AND sscc NOT GLOB '*[^0-9]*'
    AND substr(sscc, 1, 1) = '1')),
```

заменить на:

<!-- prettier-ignore -->
```sql
  sscc TEXT CHECK (sscc IS NULL OR (length(sscc) = 18 AND sscc NOT GLOB '*[^0-9]*')),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallet-schema.test.ts`
Expected: FAIL — «close a pallet whole, with its SSCC of extension 1, block and serial, or keep it open without them».

М2 — у смены может быть две открытые паллеты.
В `apps/standalone/src-tauri/migrations/0008_floor_pallets.sql` удалить фрагмент

<!-- prettier-ignore -->
```sql
CREATE UNIQUE INDEX floor_pallets_open
  ON floor_pallets (host_id, device_id, shift_id) WHERE closed_at IS NULL;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallet-schema.test.ts`
Expected: FAIL — «hold one open pallet per shift and pairing, and an SSCC on one pallet under any pairing».

М3 — `floor_pallets` нет в списке таблиц срока хранения.
В `apps/standalone/src/local/retention.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  "floor_pallets",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/retention.test.ts`
Expected: FAIL — «deletes a shift 30 days after the host took its close, and keeps one taken later», «keeps a shift whose close the host refused, or has not answered», «keeps a shift with a record not yet answered or a label that waits», «leaves another pairing's rows alone, the same shift ids included», «keeps a shift that took a record between its reading and its delete», «names every table of a shift's records: a table with a `shift_id` and no retention fails here».

М4 — копия смены теряет вместимость паллеты.
В `apps/standalone/src/floor/shifts/shift-copies.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  ["pallet_box_capacity", "palletBoxCapacity"],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-copies.test.ts`
Expected: FAIL — «keep its boxes per pallet and pallet template, and neither for a shift without pallets», «work the shift from its stored snapshot with the pallet layout, and refuse one kept without it».

М5 — у `floor_pallets` нет класса (забывание устройства не знает, что с ней делать). В `apps/standalone/src-tauri/src/local_db.rs` удалить фрагмент

<!-- prettier-ignore -->
```rust
    ("floor_pallets", TableClass::DeviceData),
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`
Expected: FAIL — `every_table_has_a_forget_class`.

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/shifts/new-shift.ts apps/standalone/src/floor/shifts/shift-copies.ts apps/standalone/src/local/retention.ts apps/standalone/test/floor-pallet-schema.test.ts apps/standalone/test/floor-schema.test.ts apps/standalone/test/local-executor.test.ts apps/standalone/test/retention.test.ts apps/standalone/test/shift-copies.test.ts`; `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src-tauri/migrations/0008_floor_pallets.sql apps/standalone/src-tauri/src/local_db.rs apps/standalone/src-tauri/tests/local_db.rs apps/standalone/src/floor/shifts/new-shift.ts apps/standalone/src/floor/shifts/shift-copies.ts apps/standalone/src/local/retention.ts apps/standalone/test/floor-pallet-schema.test.ts apps/standalone/test/floor-schema.test.ts apps/standalone/test/local-executor.test.ts apps/standalone/test/retention.test.ts apps/standalone/test/shift-copies.test.ts
git commit -m "feat(standalone): the station's pallets in its database (migration 0008), its shift copies and its retention" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Модель паллеты — короб на паллете, закрытие при заполнении и досрочно, этикетка, проверка закрытия смены, блоки паллет

Модель (`src/floor/pallets/pallets.ts`): `palletStep` — шаг закрытия короба (`CloseStep` плана 2a6) присоединяет короб к открытой паллете или открывает новую той же транзакцией, `box_closed` называет `palletId`; короб, доводящий паллету до вместимости смены (облачное `boxCount + 1 >= palletBoxCapacity`), закрывает её той же транзакцией после своей записи: номер блока паллет (расширение 1) сравнением курсора, `buildSscc(1, …)`, паллета закрывается, только пока держит посчитанные короба, запись `pallet_closed`, задание этикетки (`prepareLabelJob` с `purpose: "pallet"`, макет паллеты снимка, `palletLabelFields` домена через `palletLabelData`). Без номеров паллет полная паллета остаётся открытой, следующие короба встают на неё (`closePalletIfFull` закроет её, когда номера придут). `closeOpenPallet` — досрочное закрытие, пустая паллета отказывается до списания номера. `readOpenJob` читает задания одного момента по назначению: этикетка короба раньше этикетки паллеты. `readCloseSummary` получает блокировку `open_pallet`, `openPalletGuard` — проверка той же транзакцией закрытия смены (точка `guards` плана 2a8). Блоки паллет — `createBlockSupply` с `extension: 1` (правило «половина»).

**Files:**

- Create: `apps/standalone/src/floor/pallets/pallets.ts`
- Modify: `apps/standalone/src/floor/close/shift-close.ts`, `apps/standalone/src/floor/print/label-render.ts`, `apps/standalone/src/floor/print/print-jobs.ts`, `apps/standalone/src/floor/work/block-supply.ts`
- Test: `apps/standalone/test/floor-pallets.test.ts` (Create), `apps/standalone/test/support/pallets.ts` (Create), `apps/standalone/test/floor-block-supply.test.ts` (Modify)

**Interfaces:**

- Consumes: задачи 1–2; `closeOpenBox`, `CloseStep`, `ClosingBox`, `BoxContext` (план 2a6); `prepareLabelJob`, `readOpenJob`, `RenderLabel`, `readWorkstationSettings` (план 2a7); `readCloseSummary`, `closeShift` (план 2a8); `createBlockSupply`, `remainingSerials` (план 2a6); домен `buildSscc`, `palletLabelFields`.
- Produces:
  - `PALLET_EXTENSION = 1`, `ShiftPallets { capacity; template }`, `shiftPallets(shift): ShiftPallets | null`, `OpenPallet { id; openedAt; boxCount; itemCount }`, `readOpenPallet(local, pairing, shiftId)`;
  - `PalletContext = BoxContext & { operatorName; render? }`, `ClosingPallet`, `PalletCloseResult` (`closed` | `empty` | `no_serials` | `invalid_serial` | `stale`);
  - `palletStep(context, pallets): CloseStep`, `closeOpenPallet(context, pallets)`, `closePalletIfFull(context, pallets)`, `openPalletGuard(pairing, shiftId): LocalStatement`;
  - `palletLabelData(shift, pallet, operatorName)` (`label-render.ts`); `CloseBlocker` += `{ kind: "open_pallet"; boxes }`; `BlockContext.extension?: number`;
  - опора тестов `test/support/pallets.ts` (`PALLETS_ENTERED`, `PALLET_BLOCK`, `palletStation`, `palletContext`, `closeBoxOnPallet`).

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/floor-block-supply.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
    await expect(remainingSerials(executor, PAIRING, PREFIX)).resolves.toBe(2000);
  });
```

заменить на:

<!-- prettier-ignore -->
```ts
    await expect(remainingSerials(executor, PAIRING, PREFIX)).resolves.toBe(2000);
  });

  it("asks for a pallet block of extension 1 by the half rule of the pallet blocks alone (plan ПЛ-Ц)", async () => {
    const { db, executor } = openLocalDb();
    // A box block with serials to spare does not count for the pallets.
    seedBlock(db, { blockId: "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b", from: 1, to: 2000, next: 1 });
    const pallets = (fromSerial: number) => (request: SsccBlockRequest) => ({
      ...blockFor(request, fromSerial),
      toSerial: fromSerial + 199,
    });
    const requestBlock = vi.fn(async (request: SsccBlockRequest) => pallets(0)(request));
    const supply = createBlockSupply(supplyContext(executor, { extension: 1, requestBlock }));
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    expect(requestBlock.mock.calls).toEqual([
      [{ requestId: FIRST_REQUEST, issuerPrefix: PREFIX, extension: 1 }],
    ]);
    await expect(remainingSerials(executor, PAIRING, PREFIX, 1)).resolves.toBe(200);
    await expect(remainingSerials(executor, PAIRING, PREFIX)).resolves.toBe(2000);
    // Half of the 200 left: enough; one serial less than half: the next block.
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 100 WHERE block_id = ?").run(BLOCK_ID);
    await expect(supply.topUp()).resolves.toEqual({ kind: "enough" });
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 101 WHERE block_id = ?").run(BLOCK_ID);
    requestBlock.mockImplementation(async (request) => ({
      ...pallets(200)(request),
      id: "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
    }));
    await expect(supply.topUp()).resolves.toEqual({
      kind: "stored",
      blockId: "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
    });
    expect(requestBlock).toHaveBeenLastCalledWith({
      requestId: SECOND_REQUEST,
      issuerPrefix: PREFIX,
      extension: 1,
    });
    // A box block answered to a pallet request is never filed.
    db.prepare(
      "UPDATE floor_sscc_blocks SET next_serial = to_serial + 1 WHERE extension = 1",
    ).run();
    requestBlock.mockImplementation(async (request) => ({ ...blockFor(request), extension: 0 }));
    await expect(supply.topUp()).resolves.toEqual({ kind: "failed" });
    await expect(remainingSerials(executor, PAIRING, PREFIX, 1)).resolves.toBe(0);
  });
```

Создать `apps/standalone/test/floor-pallets.test.ts`:

<!-- prettier-ignore -->
```ts
import { buildSscc } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import { closeShift, readCloseSummary } from "../src/floor/close/shift-close.js";
import {
  closeOpenPallet,
  closePalletIfFull,
  openPalletGuard,
  PALLET_EXTENSION,
  readOpenPallet,
} from "../src/floor/pallets/pallets.js";
import { readOpenJob } from "../src/floor/print/print-jobs.js";
import { remainingSerials } from "../src/floor/work/block-supply.js";
import { processScan } from "../src/floor/work/scan-pipeline.js";
import { PAIRING, PREFIX, holdingWrites, km, rows, seedBlock } from "./support/floor-work.js";
import {
  closeBoxOnPallet,
  PALLET_BLOCK,
  palletContext,
  palletStation,
  type PalletStation,
} from "./support/pallets.js";
import { renderedBase64, ZEBRA } from "./support/printing.js";

function pallets(at: PalletStation) {
  return rows(
    at.db,
    "SELECT id, opened_at, closed_at, sscc, block_id, serial, disassembled_at FROM floor_pallets " +
      "ORDER BY opened_at, id",
  );
}

function outbox(at: PalletStation) {
  return rows(at.db, "SELECT kind, payload FROM outbox ORDER BY seq").map((row) => ({
    kind: row["kind"],
    data: (JSON.parse(String(row["payload"])) as { data: Record<string, unknown> }).data,
  }));
}

function boxesOn(at: PalletStation, palletId: unknown) {
  return rows(
    at.db,
    "SELECT id FROM floor_boxes WHERE pallet_id = ? ORDER BY closed_at",
    String(palletId),
  );
}

/** Closes `count` boxes of one code each, the codes `<prefix>1`, `<prefix>2`, …. */
async function closeBoxes(at: PalletStation, prefix: string, count: number) {
  for (let index = 1; index <= count; index += 1) {
    const closed = await closeBoxOnPallet(at, [`${prefix}${index}`]);
    if (closed.kind !== "closed") throw new Error(`box ${index}: ${closed.kind}`);
  }
}

describe("a box joins the shift's open pallet as it closes (plan ПЛ-Ц)", () => {
  it("opens a pallet with the first box, in the box's own transaction, and names it in the box's record", async () => {
    const at = await palletStation();
    const closed = await closeBoxOnPallet(at, ["A1", "A2"]);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    const [pallet] = pallets(at);
    expect(pallet).toMatchObject({ opened_at: closed.box.closedAt, closed_at: null, sscc: null });
    expect(boxesOn(at, pallet?.["id"])).toEqual([{ id: closed.box.boxId }]);
    const records = outbox(at);
    expect(records.map((record) => record.kind)).toEqual(["scan", "scan", "box_closed"]);
    expect(records[2]?.data).toMatchObject({ boxId: closed.box.boxId, palletId: pallet?.["id"] });
    await expect(readOpenPallet(at.local, PAIRING, at.shift.copy.id)).resolves.toEqual({
      id: pallet?.["id"],
      openedAt: closed.box.closedAt,
      boxCount: 1,
      itemCount: 2,
    });
  });

  it("closes the pallet with the box that fills it, in that box's transaction: the pallet serial, the record after the box's, the label", async () => {
    const at = await palletStation({ capacity: 3 });
    await closeBoxOnPallet(at, ["A1"]);
    await closeBoxOnPallet(at, ["B1", "B2"]);
    const third = await closeBoxOnPallet(at, ["C1", "C2", "C3"]);
    if (third.kind !== "closed") throw new Error(third.kind);
    const sscc = buildSscc(PALLET_EXTENSION, PREFIX, 0);
    const [pallet] = pallets(at);
    expect(pallet).toMatchObject({
      closed_at: third.box.closedAt,
      sscc,
      block_id: PALLET_BLOCK,
      serial: 0,
    });
    expect(boxesOn(at, pallet?.["id"])).toHaveLength(3);
    const kinds = outbox(at).map((record) => record.kind);
    expect(kinds.slice(-2)).toEqual(["box_closed", "pallet_closed"]);
    expect(outbox(at).at(-1)?.data).toEqual({
      palletId: pallet?.["id"],
      sscc,
      blockId: PALLET_BLOCK,
      serial: 0,
      openedAt: pallet?.["opened_at"],
      closedAt: third.box.closedAt,
      boxCount: 3,
    });
    await expect(remainingSerials(at.local, PAIRING, PREFIX, PALLET_EXTENSION)).resolves.toBe(199);
    // The pallet's label: its own job, from the snapshot's pallet layout, on the
    // printer of the purpose «Паллета»; the box's label goes first.
    const jobs = rows(
      at.db,
      "SELECT id, purpose, subject_id, sscc, state, template_id, template_rev, bytes_base64, " +
        "fields FROM floor_print_jobs WHERE purpose = 'pallet'",
    );
    expect(jobs).toEqual([
      expect.objectContaining({
        subject_id: pallet?.["id"],
        sscc,
        state: "prepared",
        template_id: at.pallets.template.id,
        template_rev: 63,
        bytes_base64: renderedBase64(ZEBRA, sscc, "100x150"),
      }),
    ]);
    expect(JSON.parse(String(jobs[0]?.["fields"]))).toMatchObject({
      sscc,
      "qty.boxes": "3",
      qty: "6",
      operator: "Анна Кузнецова",
    });
    // Of the two jobs of one moment the box's is read first, whatever their ids.
    at.db
      .prepare(
        "UPDATE floor_print_jobs SET state = 'sent' WHERE subject_id <> ? AND purpose = 'box'",
      )
      .run(third.box.boxId);
    at.db
      .prepare("UPDATE floor_print_jobs SET id = ? WHERE purpose = ?")
      .run("00000000-0000-4000-8000-000000000001", "pallet");
    at.db
      .prepare("UPDATE floor_print_jobs SET id = ? WHERE subject_id = ?")
      .run("ffffffff-ffff-4fff-8fff-ffffffffffff", third.box.boxId);
    const first = await readOpenJob(at.local, PAIRING, at.shift.copy.id);
    expect(first).toMatchObject({ purpose: "box", subjectId: third.box.boxId });
    // The next box opens the next pallet.
    const fourth = await closeBoxOnPallet(at, ["D1"]);
    if (fourth.kind !== "closed") throw new Error(fourth.kind);
    expect(rows(at.db, "SELECT opened_at FROM floor_pallets WHERE closed_at IS NULL")).toEqual([
      { opened_at: fourth.box.closedAt },
    ]);
  });

  it("never closes a box without its pallet: a pallet serial taken meanwhile leaves both as they were", async () => {
    const at = await palletStation({ capacity: 1 });
    const held = holdingWrites(at.local);
    const context = palletContext({ ...at, local: held.executor });
    const station = { ...at, local: held.executor };
    // The codes go in first; the box's close is the transaction held.
    for (const serial of ["A1", "A2"]) await processScan(context, km(serial));
    held.holdNext();
    const closing = closeBoxOnPallet(station, [], context);
    await held.reached();
    at.db
      .prepare("UPDATE floor_sscc_blocks SET next_serial = 1 WHERE block_id = ?")
      .run(PALLET_BLOCK);
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(pallets(at)).toEqual([]);
    expect(rows(at.db, "SELECT closed_at, pallet_id FROM floor_boxes")).toEqual([
      { closed_at: null, pallet_id: null },
    ]);
    expect(outbox(at).map((record) => record.kind)).toEqual(["scan", "scan"]);
  });
});

describe("a full pallet without pallet serials (plan ПЛ-Ц)", () => {
  it("stays open, takes the next boxes, and closes once a pallet block comes", async () => {
    const at = await palletStation({ capacity: 2, palletBlock: false });
    await closeBoxes(at, "A", 3);
    const context = palletContext(at);
    await expect(readOpenPallet(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      boxCount: 3,
    });
    expect(outbox(at).map((record) => record.kind)).not.toContain("pallet_closed");
    await expect(closePalletIfFull(context, at.pallets)).resolves.toEqual({ kind: "no_serials" });
    seedBlock(at.db, { blockId: PALLET_BLOCK, from: 0, to: 199, extension: 1 });
    const closed = await closePalletIfFull(context, at.pallets);
    expect(closed).toMatchObject({ kind: "closed", pallet: { boxCount: 3, serial: 0 } });
    await expect(closePalletIfFull(context, at.pallets)).resolves.toBeNull();
  });

  it("keeps a pallet with room open", async () => {
    const at = await palletStation({ capacity: 3 });
    await closeBoxes(at, "A", 2);
    await expect(closePalletIfFull(palletContext(at), at.pallets)).resolves.toBeNull();
  });
});

describe("«Закрыть паллету досрочно» (plan ПЛ-Ц)", () => {
  it("closes the open pallet with the boxes it holds", async () => {
    const at = await palletStation({ capacity: 40 });
    await closeBoxes(at, "A", 2);
    const result = await closeOpenPallet(palletContext(at), at.pallets);
    if (result.kind !== "closed") throw new Error(result.kind);
    expect(result.pallet).toMatchObject({ boxCount: 2, itemCount: 2, serial: 0 });
    expect(outbox(at).at(-1)).toMatchObject({ kind: "pallet_closed", data: { boxCount: 2 } });
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs WHERE purpose = 'pallet'"),
    ).toEqual([{ n: 1 }]);
  });

  it("refuses an empty pallet, or one whose boxes were all taken apart, before spending a serial", async () => {
    const at = await palletStation({ capacity: 40 });
    const context = palletContext(at);
    await expect(closeOpenPallet(context, at.pallets)).resolves.toEqual({ kind: "empty" });
    await closeBoxes(at, "A", 1);
    at.db.prepare("UPDATE floor_boxes SET disassembled_at = closed_at").run();
    await expect(closeOpenPallet(context, at.pallets)).resolves.toEqual({ kind: "empty" });
    await expect(remainingSerials(at.local, PAIRING, PREFIX, PALLET_EXTENSION)).resolves.toBe(200);
  });

  it("writes nothing when a box joins between its read and its write", async () => {
    const at = await palletStation({ capacity: 40 });
    await closeBoxes(at, "A", 2);
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeOpenPallet(palletContext({ ...at, local: held.executor }), at.pallets);
    await held.reached();
    // A box taken apart meanwhile: the pallet no longer holds what was counted.
    at.db
      .prepare(
        "UPDATE floor_boxes SET disassembled_at = closed_at WHERE rowid = (SELECT min(rowid) FROM floor_boxes)",
      )
      .run();
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(pallets(at)).toEqual([expect.objectContaining({ closed_at: null })]);
    await expect(remainingSerials(at.local, PAIRING, PREFIX, PALLET_EXTENSION)).resolves.toBe(200);
  });

  it("spends a serial past the prefix's range and keeps the pallet open", async () => {
    const at = await palletStation({ capacity: 40, palletBlock: false });
    seedBlock(at.db, { blockId: PALLET_BLOCK, from: 10_000_000, to: 10_000_009, extension: 1 });
    await closeBoxes(at, "A", 1);
    await expect(closeOpenPallet(palletContext(at), at.pallets)).resolves.toEqual({
      kind: "invalid_serial",
    });
    expect(rows(at.db, "SELECT next_serial FROM floor_sscc_blocks WHERE extension = 1")).toEqual([
      { next_serial: 10_000_001 },
    ]);
    expect(pallets(at)).toEqual([expect.objectContaining({ closed_at: null })]);
  });
});

describe("the shift's close and its open pallet (plan ПЛ-Ц)", () => {
  it("is kept open by a pallet with boxes, and not by an empty one", async () => {
    const at = await palletStation({ capacity: 40 });
    await closeBoxes(at, "A", 2);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sent'").run();
    await expect(readCloseSummary(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      blocker: { kind: "open_pallet", boxes: 2 },
    });
    at.db.prepare("UPDATE floor_boxes SET disassembled_at = closed_at").run();
    await expect(readCloseSummary(at.local, PAIRING, at.shift.copy.id)).resolves.toMatchObject({
      blocker: null,
    });
  });

  it("checks in its own transaction that no open pallet holds a box", async () => {
    const at = await palletStation({ capacity: 40 });
    await closeBoxes(at, "A", 1);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sent'").run();
    // The box is loose and the open pallet empty: the summary lets the shift close…
    const [pallet] = pallets(at);
    at.db.prepare("UPDATE floor_boxes SET pallet_id = NULL").run();
    const held = holdingWrites(at.local);
    held.holdNext();
    const context = palletContext({ ...at, local: held.executor });
    const closing = closeShift(context, "production_defect", [
      openPalletGuard(PAIRING, at.shift.copy.id),
    ]);
    await held.reached();
    // …and the box joins the pallet before the close writes.
    at.db.prepare("UPDATE floor_boxes SET pallet_id = ?").run(String(pallet?.["id"]));
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(rows(at.db, "SELECT local_state FROM floor_shifts")).toEqual([{ local_state: null }]);
    at.db.prepare("UPDATE floor_boxes SET pallet_id = NULL").run();
    await expect(
      closeShift(palletContext(at), "production_defect", [
        openPalletGuard(PAIRING, at.shift.copy.id),
      ]),
    ).resolves.toMatchObject({ kind: "closed" });
  });
});
```

Создать `apps/standalone/test/support/pallets.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import type { WorkstationSettings } from "../../src/floor/setup/workstation-settings.js";
import {
  palletStep,
  shiftPallets,
  type PalletContext,
  type ShiftPallets,
} from "../../src/floor/pallets/pallets.js";
import { boxLabelStep } from "../../src/floor/print/print-jobs.js";
import type { WorkShift } from "../../src/floor/shifts/shift-copies.js";
import { closeOpenBox, type CloseResult } from "../../src/floor/work/box-close.js";
import { processScan, type ScanContext } from "../../src/floor/work/scan-pipeline.js";
import { enteredShiftSchema, type EnteredShift } from "../../src/host/protocol.js";
import type { LocalExecutor } from "../../src/local/executor.js";
import { enteredShift, km, PAIRING, scanContext, seedBlock } from "./floor-work.js";
import { openLocalDb } from "./local-db.js";
import { fakeRender, PRINT_BLOCK, setUpPrinting } from "./printing.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const supportModuleUrl = import.meta.url;

/**
 * The active shift of milk with pallets this station entered
 * (`device-shift-entered-pallets.json`): 12 to a box, 40 boxes to a pallet,
 * the pallet template «Паллета 100×150» of revision 63.
 */
export const PALLETS_ENTERED: EnteredShift = enteredShiftSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../../proto/fixtures/device-shift-entered-pallets.json", supportModuleUrl),
      "utf8",
    ),
  ),
);

/** The pallet block of the pallet tests: serials 0–199 of extension 1. */
export const PALLET_BLOCK = "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b";

export interface PalletStation {
  db: ReturnType<typeof openLocalDb>["db"];
  local: LocalExecutor;
  shift: WorkShift;
  pallets: ShiftPallets;
  settings: WorkstationSettings;
}

/**
 * A station with the shift with pallets entered — `capacity` boxes to a
 * pallet — a box block from 1500, a pallet block of serials 0–199 unless
 * `palletBlock` is `false`, and the Zebra for boxes and pallets.
 */
export async function palletStation(
  options: {
    capacity?: number;
    palletBlock?: boolean;
    settings?: Partial<WorkstationSettings>;
  } = {},
): Promise<PalletStation> {
  const { db, executor } = openLocalDb();
  const shift = await enteredShift(executor, {
    ...PALLETS_ENTERED,
    palletBoxCapacity: options.capacity ?? 3,
  });
  const pallets = shiftPallets(shift);
  if (pallets === null) throw new Error("the shift has no pallets");
  seedBlock(db, { blockId: PRINT_BLOCK, from: 1500, to: 3499 });
  if (options.palletBlock !== false) {
    seedBlock(db, { blockId: PALLET_BLOCK, from: 0, to: 199, extension: 1 });
  }
  const settings = await setUpPrinting(executor, {
    assignments: { box: "zebra", pallet: "zebra", duplicate: null },
    ...options.settings,
  });
  return { db, local: executor, shift, pallets, settings };
}

/** A scan's and a pallet close's context over the station: offline, a stepping clock, random ids, the fake render. */
export function palletContext(
  at: Pick<PalletStation, "local" | "shift">,
  overrides: Partial<ScanContext & PalletContext> = {},
): ScanContext & PalletContext {
  return {
    ...scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() }),
    operatorName: "Анна Кузнецова",
    render: fakeRender,
    ...overrides,
  };
}

/**
 * Accepts the codes `serials` into the open box and closes it as the work
 * screen of a shift with pallets does: its label and its pallet in the box's
 * transaction. Answers how the close went.
 */
export async function closeBoxOnPallet(
  at: PalletStation,
  serials: readonly string[],
  context: ScanContext & PalletContext = palletContext(at),
): Promise<CloseResult> {
  for (const serial of serials) await processScan(context, km(serial));
  return closeOpenBox(context, [
    boxLabelStep({
      local: at.local,
      pairing: PAIRING,
      shift: at.shift,
      operatorName: context.operatorName,
      newId: () => crypto.randomUUID(),
      render: fakeRender,
    }),
    palletStep(context, at.pallets),
  ]);
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts test/floor-pallets.test.ts`
Expected: FAIL — `test/floor-pallets.test.ts` не загружается (`Failed to resolve import "../src/floor/pallets/pallets.js"`); `test/floor-block-supply.test.ts` — «asks for a pallet block of extension 1 by the half rule of the pallet blocks alone (plan ПЛ-Ц)» (`expected { kind: 'enough' } to deeply equal { kind: 'stored', … }`: блок коробов засчитан паллетам).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/floor/close/shift-close.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
 * `shiftLabelsSettled`: a label decided after the close would reach the host
 * after `shift_closed` and mark the station's own shift late); or this
 * station has closed it already. The pallets' plan (ПЛ-Ц) adds an open
 * pallet with boxes.
 */
export type CloseBlocker =
  { kind: "open_box"; items: number } | { kind: "label" } | { kind: "closed" };

/** The summary of the close (the cloud's close summary), from this station's own records. */
```

заменить на:

<!-- prettier-ignore -->
```ts
 * `shiftLabelsSettled`: a label decided after the close would reach the host
 * after `shift_closed` and mark the station's own shift late); an open
 * pallet with boxes (plan ПЛ-Ц), which «Закрыть паллету и смену» closes
 * first; or this station has closed it already.
 */
export type CloseBlocker =
  | { kind: "open_box"; items: number }
  | { kind: "label" }
  | { kind: "open_pallet"; boxes: number }
  | { kind: "closed" };

/** The summary of the close (the cloud's close summary), from this station's own records. */
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  waiting: z.number().int().nonnegative(),
});
```

заменить на:

<!-- prettier-ignore -->
```ts
  waiting: z.number().int().nonnegative(),
  pallet_boxes: z.number().int().nonnegative(),
});
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
 * what keeps it from closing. Every label is counted, not read: a waiting
 * job this build cannot read still keeps the shift open.
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
 * what keeps it from closing. Every label is counted, not read: a waiting
 * job this build cannot read still keeps the shift open. An open pallet keeps
 * it open only while it holds a box not taken apart (plan ПЛ-Ц).
 */
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
      "(SELECT count(*) FROM floor_print_jobs j WHERE j.host_id = s.host_id " +
      `AND j.device_id = s.device_id AND j.shift_id = s.id AND ${OPEN_JOB_SQL}) AS waiting ` +
      "FROM floor_shifts s WHERE s.host_id = ? AND s.device_id = ? AND s.id = ?",
```

заменить на:

<!-- prettier-ignore -->
```ts
      "(SELECT count(*) FROM floor_print_jobs j WHERE j.host_id = s.host_id " +
      `AND j.device_id = s.device_id AND j.shift_id = s.id AND ${OPEN_JOB_SQL}) AS waiting, ` +
      "(SELECT count(*) FROM floor_pallets p JOIN floor_boxes b ON b.host_id = p.host_id " +
      "AND b.device_id = p.device_id AND b.pallet_id = p.id AND b.disassembled_at IS NULL " +
      "WHERE p.host_id = s.host_id AND p.device_id = s.device_id AND p.shift_id = s.id " +
      "AND p.closed_at IS NULL) AS pallet_boxes " +
      "FROM floor_shifts s WHERE s.host_id = ? AND s.device_id = ? AND s.id = ?",
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
          ? { kind: "label" }
          : null;
  return {
```

заменить на:

<!-- prettier-ignore -->
```ts
          ? { kind: "label" }
          : row.pallet_boxes > 0
            ? { kind: "open_pallet", boxes: row.pallet_boxes }
            : null;
  return {
```

Создать `apps/standalone/src/floor/pallets/pallets.ts`:

<!-- prettier-ignore -->
```ts
import { buildSscc, DomainError } from "@markiro/domain";
import { z } from "zod";

import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { outboxStatement, palletClosedRecord } from "../facts.js";
import { palletLabelData } from "../print/label-render.js";
import { prepareLabelJob, type RenderLabel } from "../print/print-jobs.js";
import { readWorkstationSettings } from "../setup/workstation-settings.js";
import type { WorkShift } from "../shifts/shift-copies.js";
import type { SnapshotTemplate } from "../shifts/shift-snapshot.js";
import type { BoxContext, CloseStep, ClosingBox } from "../work/box-close.js";

/** The extension digit of a pallet's SSCC (decision 9; a box's is 0). */
export const PALLET_EXTENSION = 1;

/** What a shift with pallets has of them: boxes per pallet and the snapshot's pallet layout. */
export interface ShiftPallets {
  capacity: number;
  template: SnapshotTemplate;
}

/**
 * The pallets of a shift the station works with pallets (plan ПЛ-Ц): its
 * copy's boxes per pallet and its snapshot's pallet layout; `null` for a
 * shift without pallets.
 */
export function shiftPallets(shift: WorkShift): ShiftPallets | null {
  const capacity = shift.copy.palletBoxCapacity;
  const template = shift.snapshot.palletTemplate;
  if (!shift.copy.palletsEnabled || capacity === null || template === null) return null;
  return { capacity, template };
}

/** The open pallet of a shift (one at most): the boxes that close join it. */
export interface OpenPallet {
  id: string;
  openedAt: string;
  /** Its boxes not taken apart: what it holds now. */
  boxCount: number;
  /** The units in those boxes: the `qty` of its label. */
  itemCount: number;
}

/**
 * The boxes of the pallet `p` that are not taken apart, and their units, as
 * SQL: never stored, always counted (the cloud's derived count).
 */
const LIVE_BOXES =
  "FROM floor_boxes b WHERE b.host_id = p.host_id AND b.device_id = p.device_id " +
  "AND b.pallet_id = p.id AND b.disassembled_at IS NULL";

const openRow = z.object({
  id: z.string(),
  opened_at: z.string(),
  boxes: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
});

/** This pairing's open pallet of the shift with what it holds, or `null`. */
export async function readOpenPallet(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<OpenPallet | null> {
  const [row] = await local.query(
    `SELECT p.id, p.opened_at, (SELECT count(*) ${LIVE_BOXES}) AS boxes, ` +
      `(SELECT coalesce(sum(b.item_count), 0) ${LIVE_BOXES}) AS items FROM floor_pallets p ` +
      "WHERE p.host_id = ? AND p.device_id = ? AND p.shift_id = ? AND p.closed_at IS NULL",
    [pairing.hostId, pairing.deviceId, shiftId],
    openRow,
  );
  return row === undefined
    ? null
    : { id: row.id, openedAt: row.opened_at, boxCount: row.boxes, itemCount: row.items };
}

/** What a pallet's close needs: a box's context, the operator's name for the label, a render. */
export type PalletContext = BoxContext & {
  operatorName: string | null;
  /** How the label is rendered; the app's rasterizer by default. */
  render?: RenderLabel;
};

/** A pallet on its way to close: everything its `pallet_closed` record and its label say. */
export interface ClosingPallet {
  palletId: string;
  shiftId: string;
  sscc: string;
  blockId: string;
  serial: number;
  openedAt: string;
  closedAt: string;
  boxCount: number;
  itemCount: number;
  operatorId: string;
}

/**
 * How a pallet's close went: `closed`; `empty` — no open pallet, or one
 * without a box, and no serial spent; `no_serials` — no pallet block of the
 * snapshot's prefix has a serial left, and the pallet stays open; an SSCC
 * past the prefix's range (`invalid_serial`) — that serial is spent and the
 * pallet stays open; `stale` — the pallet or the block changed between the
 * read and the write, nothing was written.
 */
export type PalletCloseResult =
  | { kind: "closed"; pallet: ClosingPallet }
  | { kind: "empty" }
  | { kind: "no_serials" }
  | { kind: "invalid_serial" }
  | { kind: "stale" };

const blockRow = z.object({ block_id: z.string(), next_serial: z.number().int().nonnegative() });

/** The next serial of the earliest pallet block of the prefix that has one, or `null`. */
async function nextPalletSerial(
  context: BoxContext,
): Promise<{ blockId: string; serial: number } | null> {
  const { local, pairing, shift } = context;
  const [block] = await local.query(
    "SELECT block_id, next_serial FROM floor_sscc_blocks WHERE host_id = ? AND device_id = ? " +
      "AND issuer_prefix = ? AND extension = ? AND next_serial <= to_serial " +
      "ORDER BY from_serial, block_id LIMIT 1",
    [pairing.hostId, pairing.deviceId, shift.snapshot.issuerPrefix, PALLET_EXTENSION],
    blockRow,
  );
  return block === undefined ? null : { blockId: block.block_id, serial: block.next_serial };
}

function spendSerial(blockId: string, serial: number): LocalStatement {
  return {
    sql:
      "UPDATE floor_sscc_blocks SET next_serial = next_serial + 1 " +
      "WHERE block_id = ? AND next_serial = ?",
    values: [blockId, serial],
    expectedChanges: 1,
  };
}

/** The pallet's SSCC by the domain's `buildSscc`; `null` past the prefix's range. */
function palletSscc(issuerPrefix: string, serial: number): string | null {
  try {
    return buildSscc(PALLET_EXTENSION, issuerPrefix, serial);
  } catch (error) {
    if (error instanceof DomainError && error.code === "SSCC_RANGE") return null;
    throw error;
  }
}

/**
 * The statements that close `pallet`, for the transaction that writes them
 * (pilot spec §6.2): the serial spent by comparing the block's cursor with
 * the value read; the pallet closed only while it is open and holds the
 * boxes counted (a box that joined or was taken apart meanwhile makes the
 * whole transaction `stale`); its `pallet_closed` record; and its print job,
 * rendered from the snapshot's pallet layout for the printer of the purpose
 * «Паллета» — no printer, or no render, keeps the job `failed`, and the
 * pallet closes all the same.
 */
async function closeStatements(
  context: PalletContext,
  pallets: ShiftPallets,
  pallet: ClosingPallet,
): Promise<LocalStatement[]> {
  const { pairing, shift } = context;
  const record = palletClosedRecord(
    { id: context.newId(), shiftId: pallet.shiftId, operatorId: pallet.operatorId },
    {
      palletId: pallet.palletId,
      sscc: pallet.sscc,
      blockId: pallet.blockId,
      serial: pallet.serial,
      openedAt: pallet.openedAt,
      closedAt: pallet.closedAt,
      boxCount: pallet.boxCount,
    },
  );
  const settings = await readWorkstationSettings(context.local);
  const job = await prepareLabelJob(
    {
      id: context.newId(),
      shiftId: pallet.shiftId,
      purpose: "pallet",
      subjectId: pallet.palletId,
      sscc: pallet.sscc,
      fields: palletLabelData(shift, pallet, context.operatorName),
      template: pallets.template,
      operatorId: pallet.operatorId,
      createdAt: pallet.closedAt,
    },
    settings,
    pairing,
    context.render,
  );
  return [
    spendSerial(pallet.blockId, pallet.serial),
    {
      sql:
        "UPDATE floor_pallets AS p SET closed_at = ?, sscc = ?, block_id = ?, serial = ?, " +
        "closed_by = ? WHERE p.id = ? AND p.host_id = ? AND p.device_id = ? " +
        `AND p.closed_at IS NULL AND (SELECT count(*) ${LIVE_BOXES}) = ?`,
      values: [
        pallet.closedAt,
        pallet.sscc,
        pallet.blockId,
        pallet.serial,
        pallet.operatorId,
        pallet.palletId,
        pairing.hostId,
        pairing.deviceId,
        pallet.boxCount,
      ],
      expectedChanges: 1,
    },
    outboxStatement(record, pairing, pallet.closedAt),
    job,
  ];
}

/** Runs the write; a guard that no longer holds is `stale`, anything else rejects. */
async function commit(
  local: LocalExecutor,
  statements: readonly LocalStatement[],
): Promise<"done" | "stale"> {
  try {
    await local.transaction(statements);
    return "done";
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") return "stale";
    throw error;
  }
}

/**
 * Closes the shift's open pallet (pilot spec §6.1–6.2, the cloud's
 * `closeCurrentPallet`): «Закрыть паллету досрочно», «Закрыть паллету и
 * смену», or a full pallet that waited for serials. Never an empty one: an
 * open pallet with no box left is refused before a serial is spent. The next
 * serial of the earliest pallet block of the snapshot's prefix, the SSCC by
 * the domain's `buildSscc(1, …)`, then ONE transaction — the serial, the
 * pallet with the boxes counted, its record and its label's job. No serial —
 * the pallet stays open (the next boxes join it) and the shift's close waits.
 */
export async function closeOpenPallet(
  context: PalletContext,
  pallets: ShiftPallets,
): Promise<PalletCloseResult> {
  const { local, pairing, shift } = context;
  const open = await readOpenPallet(local, pairing, shift.copy.id);
  if (open === null || open.boxCount === 0) return { kind: "empty" };
  const next = await nextPalletSerial(context);
  if (next === null) return { kind: "no_serials" };
  const sscc = palletSscc(shift.snapshot.issuerPrefix, next.serial);
  if (sscc === null) {
    // As for a box: the serial is lost, the pallet stays open, and the next
    // close takes the next serial instead of failing on this one forever.
    const spent = await commit(local, [spendSerial(next.blockId, next.serial)]);
    return spent === "stale" ? { kind: "stale" } : { kind: "invalid_serial" };
  }
  const pallet: ClosingPallet = {
    palletId: open.id,
    shiftId: shift.copy.id,
    sscc,
    blockId: next.blockId,
    serial: next.serial,
    openedAt: open.openedAt,
    closedAt: context.now().toISOString(),
    boxCount: open.boxCount,
    itemCount: open.itemCount,
    operatorId: context.operatorId,
  };
  const written = await commit(local, await closeStatements(context, pallets, pallet));
  return written === "stale" ? { kind: "stale" } : { kind: "closed", pallet };
}

/**
 * Closes the open pallet once it holds the shift's boxes per pallet: when the
 * work screen opens and when pallet serials arrive — a pallet that filled
 * while the station had no pallet serials closes then. `null` while it has
 * room (or there is none).
 */
export async function closePalletIfFull(
  context: PalletContext,
  pallets: ShiftPallets,
): Promise<PalletCloseResult | null> {
  const open = await readOpenPallet(context.local, context.pairing, context.shift.copy.id);
  if (open === null || open.boxCount < pallets.capacity) return null;
  return closeOpenPallet(context, pallets);
}

/**
 * The box close's step of plan ПЛ-Ц (`CloseStep`, plan 2a6): the closing box
 * joins the shift's open pallet — or opens one, whose `opened_at` is the
 * box's close — in the box's own transaction, and its `box_closed` record
 * names the pallet (`palletId`). The box that fills the pallet (the boxes on
 * it reach the shift's boxes per pallet, the cloud's `boxCount + 1 >=
 * palletBoxCapacity`) closes it in the same transaction, after the box's
 * record, with the box's moment: the box never closes without its pallet,
 * and the pallet's `pallet_closed` follows its last box in the outbox. With
 * no pallet serial left the full pallet stays open, the next boxes join it,
 * and it closes when serials come (`closePalletIfFull`).
 */
export function palletStep(context: PalletContext, pallets: ShiftPallets): CloseStep {
  return async (box: ClosingBox) => {
    const { local, pairing, shift } = context;
    const open = await readOpenPallet(local, pairing, shift.copy.id);
    const palletId = open?.id ?? context.newId();
    const statements: LocalStatement[] = [
      open === null
        ? {
            sql:
              "INSERT INTO floor_pallets (id, host_id, device_id, shift_id, opened_at) " +
              "VALUES (?, ?, ?, ?, ?)",
            values: [palletId, pairing.hostId, pairing.deviceId, box.shiftId, box.closedAt],
            expectedChanges: 1,
          }
        : {
            // Still open when the box joins: a close that landed meanwhile makes it stale.
            sql:
              "UPDATE floor_pallets SET id = id WHERE id = ? AND host_id = ? AND device_id = ? " +
              "AND closed_at IS NULL",
            values: [palletId, pairing.hostId, pairing.deviceId],
            expectedChanges: 1,
          },
      {
        sql:
          "UPDATE floor_boxes SET pallet_id = ? WHERE id = ? AND host_id = ? AND device_id = ? " +
          "AND closed_at IS NOT NULL AND pallet_id IS NULL",
        values: [palletId, box.boxId, pairing.hostId, pairing.deviceId],
        expectedChanges: 1,
      },
    ];
    const boxCount = (open?.boxCount ?? 0) + 1;
    if (boxCount >= pallets.capacity) {
      const next = await nextPalletSerial(context);
      const sscc = next === null ? null : palletSscc(shift.snapshot.issuerPrefix, next.serial);
      if (next !== null && sscc !== null) {
        statements.push(
          ...(await closeStatements(context, pallets, {
            palletId,
            shiftId: box.shiftId,
            sscc,
            blockId: next.blockId,
            serial: next.serial,
            openedAt: open?.openedAt ?? box.closedAt,
            closedAt: box.closedAt,
            boxCount,
            itemCount: (open?.itemCount ?? 0) + box.itemCount,
            operatorId: box.operatorId,
          })),
        );
      }
    }
    return { statements, data: { palletId } };
  };
}

/**
 * The shift's close's own check of plan ПЛ-Ц (`closeShift`'s `guards`, plan
 * 2a8): in the close's transaction, no open pallet of the shift holds a box
 * that is not taken apart — such a pallet is closed first («Закрыть паллету
 * и смену»), so its boxes are on a printed pallet. An open pallet with no box
 * left does not keep the shift open and spends no serial.
 */
export function openPalletGuard(pairing: Pairing, shiftId: string): LocalStatement {
  return {
    sql:
      "UPDATE floor_shifts AS s SET local_state = local_state WHERE s.host_id = ? " +
      "AND s.device_id = ? AND s.id = ? AND NOT EXISTS (SELECT 1 FROM floor_pallets p " +
      "WHERE p.host_id = s.host_id AND p.device_id = s.device_id AND p.shift_id = s.id " +
      `AND p.closed_at IS NULL AND EXISTS (SELECT 1 ${LIVE_BOXES}))`,
    values: [pairing.hostId, pairing.deviceId, shiftId],
    expectedChanges: 1,
  };
}
```

Правка `apps/standalone/src/floor/print/label-render.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  boxLabelFields,
  withPrinterDpi,
```

заменить на:

<!-- prettier-ignore -->
```ts
  boxLabelFields,
  palletLabelFields,
  withPrinterDpi,
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
/**
 * A label's bytes for one printer (the cloud station's `renderLabelBytes`):
```

заменить на:

<!-- prettier-ignore -->
```ts
/**
 * The fields of a pallet's label (pilot spec §6.1, the domain's
 * `palletLabelFields`) from the shift's snapshot, like a box's: the pallet's
 * SSCC, its boxes (`qty.boxes`) and their units (`qty`), the time it closed —
 * kept with the pallet, so a reprint stamps the same dates — and the
 * operator who closed it.
 */
export function palletLabelData(
  shift: WorkShift,
  pallet: { sscc: string; boxCount: number; itemCount: number; closedAt: string },
  operatorName: string | null,
): LabelFields {
  const { product, counterpartyName } = shift.snapshot;
  return palletLabelFields({
    sscc: pallet.sscc,
    boxCount: pallet.boxCount,
    itemCount: pallet.itemCount,
    productName: product.name,
    productPrintName: product.printName,
    gtin14: product.gtin14,
    egaisCode: null,
    shelfLifeDays: product.shelfLifeDays,
    operatorName,
    counterpartyName,
    closedAt: pallet.closedAt,
    productionDate: shift.copy.productionDate,
    shiftNumber: shift.copy.number,
  });
}

/**
 * A label's bytes for one printer (the cloud station's `renderLabelBytes`):
```

Правка `apps/standalone/src/floor/print/print-jobs.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
}

/** The oldest job of the shift that waits for the printer or the operator, or `null`. */
export async function readOpenJob(
```

заменить на:

<!-- prettier-ignore -->
```ts
}

/**
 * The oldest job of the shift that waits for the printer or the operator, or
 * `null`. A box's job before a pallet's of the same moment (`purpose`): the
 * box that fills a pallet writes both in its close (plan ПЛ-Ц), and the box's
 * label goes first.
 */
export async function readOpenJob(
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
    `SELECT ${COLUMNS} FROM floor_print_jobs WHERE host_id = ? AND device_id = ? ` +
      `AND shift_id = ? AND ${OPEN_JOB_SQL} ORDER BY created_at, id LIMIT 1`,
    [pairing.hostId, pairing.deviceId, shiftId],
```

заменить на:

<!-- prettier-ignore -->
```ts
    `SELECT ${COLUMNS} FROM floor_print_jobs WHERE host_id = ? AND device_id = ? ` +
      `AND shift_id = ? AND ${OPEN_JOB_SQL} ORDER BY created_at, purpose, id LIMIT 1`,
    [pairing.hostId, pairing.deviceId, shiftId],
```

Правка `apps/standalone/src/floor/work/block-supply.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  issuerPrefix: string;
  /** The link is `online` right now: only then is the host asked. */
```

заменить на:

<!-- prettier-ignore -->
```ts
  issuerPrefix: string;
  /** The extension the blocks are of: 0, a box's (the default); 1, a pallet's (plan ПЛ-Ц). */
  extension?: number;
  /** The link is `online` right now: only then is the host asked. */
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
      "ORDER BY from_serial DESC LIMIT 1",
    [pairing.hostId, pairing.deviceId, issuerPrefix, BOX_EXTENSION],
    newestRow,
```

заменить на:

<!-- prettier-ignore -->
```ts
      "ORDER BY from_serial DESC LIMIT 1",
    [pairing.hostId, pairing.deviceId, issuerPrefix, extensionOf(context)],
    newestRow,
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
}

/** The request this pairing keeps for the prefix and has no answer to, oldest first. */
async function waitingRequest(context: BlockContext): Promise<SsccBlockRequest | null> {
```

заменить на:

<!-- prettier-ignore -->
```ts
}

/** The extension of the context's blocks: a box's unless it names a pallet's. */
function extensionOf(context: BlockContext): number {
  return context.extension ?? BOX_EXTENSION;
}

/** The request this pairing keeps for the prefix and the extension and has no answer to, oldest first. */
async function waitingRequest(context: BlockContext): Promise<SsccBlockRequest | null> {
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
      "ORDER BY requested_at, request_id LIMIT 1",
    [pairing.hostId, pairing.deviceId, issuerPrefix, BOX_EXTENSION],
    requestRow,
```

заменить на:

<!-- prettier-ignore -->
```ts
      "ORDER BY requested_at, request_id LIMIT 1",
    [pairing.hostId, pairing.deviceId, issuerPrefix, extensionOf(context)],
    requestRow,
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
    issuerPrefix: context.issuerPrefix,
    extension: BOX_EXTENSION,
  };
```

заменить на:

<!-- prettier-ignore -->
```ts
    issuerPrefix: context.issuerPrefix,
    extension: extensionOf(context),
  };
```

Фрагмент 6:

<!-- prettier-ignore -->
```ts
/**
 * The supply of SSCC serials for a shift's boxes (stage 2a spec §5.7.4): when
 * the work screen opens, after every close and when the link comes back, a
```

заменить на:

<!-- prettier-ignore -->
```ts
/**
 * The supply of SSCC serials for a shift's boxes (stage 2a spec §5.7.4), or
 * for its pallets with `extension` 1 (plan ПЛ-Ц; pilot spec §6.2: stricter
 * than the cloud, which brings a pallet block only with the shift): when
 * the work screen opens, after every close and when the link comes back, a
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts test/floor-pallets.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  23 passed (23)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  114 passed (114)`, `Tests  2685 passed (2685)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — паллета, дошедшая до вместимости, не закрывается своим последним коробом.
В `apps/standalone/src/floor/pallets/pallets.ts` фрагмент

<!-- prettier-ignore -->
```ts
    if (boxCount >= pallets.capacity) {
```

заменить на:

<!-- prettier-ignore -->
```ts
    if (boxCount > pallets.capacity) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallets.test.ts`
Expected: FAIL — «closes the pallet with the box that fills it, in that box's transaction: the pallet serial, the record after the box's, the label», «never closes a box without its pallet: a pallet serial taken meanwhile leaves both as they were».

М2 — закрытие паллеты не сверяет число коробов с прочитанным.
В `apps/standalone/src/floor/pallets/pallets.ts` фрагмент

<!-- prettier-ignore -->
```ts
        `AND p.closed_at IS NULL AND (SELECT count(*) ${LIVE_BOXES}) = ?`,
```

заменить на:

<!-- prettier-ignore -->
```ts
        `AND p.closed_at IS NULL AND (SELECT count(*) ${LIVE_BOXES}) >= 0 AND ? IS NOT NULL`,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallets.test.ts`
Expected: FAIL — «writes nothing when a box joins between its read and its write».

М3 — досрочно закрывается паллета без коробов.
В `apps/standalone/src/floor/pallets/pallets.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (open === null || open.boxCount === 0) return { kind: "empty" };
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (open === null) return { kind: "empty" };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallets.test.ts`
Expected: FAIL — «refuses an empty pallet, or one whose boxes were all taken apart, before spending a serial».

М4 — проверка открытой паллеты в транзакции закрытия смены ничего не проверяет.
В `apps/standalone/src/floor/pallets/pallets.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "AND s.device_id = ? AND s.id = ? AND NOT EXISTS (SELECT 1 FROM floor_pallets p " +
```

заменить на:

<!-- prettier-ignore -->
```ts
      "AND s.device_id = ? AND s.id = ? AND 1 = 1 OR EXISTS (SELECT 1 FROM floor_pallets p " +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallets.test.ts`
Expected: FAIL — «checks in its own transaction that no open pallet holds a box».

М5 — задания одного момента читаются не по назначению: этикетка паллеты может уйти раньше этикетки короба.
В `apps/standalone/src/floor/print/print-jobs.ts` фрагмент

<!-- prettier-ignore -->
```ts
      `AND shift_id = ? AND ${OPEN_JOB_SQL} ORDER BY created_at, purpose, id LIMIT 1`,
```

заменить на:

<!-- prettier-ignore -->
```ts
      `AND shift_id = ? AND ${OPEN_JOB_SQL} ORDER BY created_at, id LIMIT 1`,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallets.test.ts`
Expected: FAIL — «closes the pallet with the box that fills it, in that box's transaction: the pallet serial, the record after the box's, the label».

М6 — открытая паллета с коробами не держит закрытие смены.
В `apps/standalone/src/floor/close/shift-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
          : row.pallet_boxes > 0
            ? { kind: "open_pallet", boxes: row.pallet_boxes }
            : null;
```

заменить на:

<!-- prettier-ignore -->
```ts
          : null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallets.test.ts`
Expected: FAIL — «is kept open by a pallet with boxes, and not by an empty one».

М7 — запрос блока паллет уходит с расширением короба.
В `apps/standalone/src/floor/work/block-supply.ts` фрагмент

<!-- prettier-ignore -->
```ts
    issuerPrefix: context.issuerPrefix,
    extension: extensionOf(context),
```

заменить на:

<!-- prettier-ignore -->
```ts
    issuerPrefix: context.issuerPrefix,
    extension: BOX_EXTENSION,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts`
Expected: FAIL — «asks for a pallet block of extension 1 by the half rule of the pallet blocks alone (plan ПЛ-Ц)».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/close/shift-close.ts apps/standalone/src/floor/pallets/pallets.ts apps/standalone/src/floor/print/label-render.ts apps/standalone/src/floor/print/print-jobs.ts apps/standalone/src/floor/work/block-supply.ts apps/standalone/test/floor-block-supply.test.ts apps/standalone/test/floor-pallets.test.ts apps/standalone/test/support/pallets.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/close/shift-close.ts apps/standalone/src/floor/pallets/pallets.ts apps/standalone/src/floor/print/label-render.ts apps/standalone/src/floor/print/print-jobs.ts apps/standalone/src/floor/work/block-supply.ts apps/standalone/test/floor-block-supply.test.ts apps/standalone/test/floor-pallets.test.ts apps/standalone/test/support/pallets.ts
git commit -m "feat(standalone): a box joins the open pallet as it closes; a full pallet closes with it, early on demand, with pallet serials of its own" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Этикетка паллеты и исключения паллеты — проверка, пропуск, печать снова, перепечатка, расформирование

Решения по этикетке (план 2a7, `print-resolution.ts`) для паллеты: проверка сканом и пропуск пишут `pallet_label`; «Напечатать снова» этикетки, которая может уже быть на паллете, пишет исключение паллеты `reprint` той же транзакцией, что `sending`. Модуль исключений паллеты (`src/floor/exceptions/pallet-exceptions.ts`, по образцу `box-exceptions.ts`, контракт 2a8): `reprintPallet` — только паллета с решённой этикеткой: новое задание с SSCC и полями последнего задания паллеты, макетом паллеты снимка и принтером «Паллета» сейчас, вместе с исключением и записью — одна транзакция, затем одна отправка; `disassemblePallet` — `disassembled_at` при сравнении, короба не трогаются; причины — списки коробов, слова — `reasonWords` (функция `reasonFields` экспортируется). Срок хранения удаляет паллеты смены вместе с ней.

**Files:**

- Create: `apps/standalone/src/floor/exceptions/pallet-exceptions.ts`
- Modify: `apps/standalone/src/floor/exceptions/box-exceptions.ts`, `apps/standalone/src/floor/print/print-resolution.ts`
- Test: `apps/standalone/test/floor-pallet-exceptions.test.ts` (Create), `apps/standalone/test/retention.test.ts` (Modify)

**Interfaces:**

- Consumes: задачи 1–3; `checkLabel`, `skipLabel`, `printAgain` (план 2a7); `reasonWords`, `LabelWaitingError`, `ReprintContext`, `ExceptionReason` (план 2a8); `purgeAcknowledged` (план 2a8).
- Produces:
  - `palletExceptionStatements(context, shiftId, data)`, `readClosedPallets(local, pairing, shiftId): Promise<ClosedPallet[]>` (`{ id; sscc; boxCount; closedAt }`), `disassemblePallet(context, palletId, reason)`, `reprintPallet(context, pallets, palletId, reason, settings, render?)`, `PalletUnavailableError`;
  - `reasonFields` экспортирован из `box-exceptions.ts`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-pallet-exceptions.test.ts`:

<!-- prettier-ignore -->
```ts
import { buildSscc } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import { LabelWaitingError, InvalidReasonError } from "../src/floor/exceptions/box-exceptions.js";
import {
  disassemblePallet,
  PalletUnavailableError,
  readClosedPallets,
  reprintPallet,
} from "../src/floor/exceptions/pallet-exceptions.js";
import { PALLET_EXTENSION } from "../src/floor/pallets/pallets.js";
import { readPrintJob, sendLabelJob, type PrintJob } from "../src/floor/print/print-jobs.js";
import { checkLabel, printAgain, skipLabel } from "../src/floor/print/print-resolution.js";
import { PAIRING, PREFIX, holdingWrites, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import {
  closeBoxOnPallet,
  palletContext,
  palletStation,
  type PalletStation,
} from "./support/pallets.js";
import {
  fakeRender,
  manualRuntime,
  renderedText,
  resolveContext,
  ZEBRA,
} from "./support/printing.js";

const PALLET_SSCC = buildSscc(PALLET_EXTENSION, PREFIX, 0);

function resolving(at: PalletStation, shell = fakeHardware()) {
  return resolveContext(at.local, manualRuntime(shell.hardware).runtime);
}

/** The station's pallet records for the host, in their order. */
function palletRecords(at: PalletStation) {
  return rows(
    at.db,
    "SELECT kind, payload FROM outbox WHERE kind IN ('pallet_label', 'pallet_exception') ORDER BY seq",
  ).map((row) => ({
    kind: row["kind"],
    data: (JSON.parse(String(row["payload"])) as { data: Record<string, unknown> }).data,
  }));
}

/** Two boxes close a pallet of two; its label is sent once, as the work screen sends it. */
async function closedPallet(
  options: Parameters<typeof palletStation>[0] = {},
): Promise<{ at: PalletStation; palletId: string; job: PrintJob }> {
  const at = await palletStation({ capacity: 2, ...options });
  await closeBoxOnPallet(at, ["A1", "A2"]);
  await closeBoxOnPallet(at, ["B1"]);
  const [row] = rows(at.db, "SELECT id FROM floor_print_jobs WHERE purpose = 'pallet'");
  const prepared = await readPrintJob(at.local, PAIRING, String(row?.["id"]));
  if (prepared === null) throw new Error("the pallet closed without its job");
  const job = await sendLabelJob(resolving(at), prepared);
  return { at, palletId: prepared.subjectId, job };
}

describe("the label of a pallet (plan ПЛ-Ц)", () => {
  it("is checked by the scan of its SSCC, with a `pallet_label` record", async () => {
    const { at, palletId, job } = await closedPallet({ settings: { verifyPrintedLabel: true } });
    expect(job).toMatchObject({ state: "sent", verify: true, purpose: "pallet" });
    const result = await checkLabel(resolving(at), job, `(00)${PALLET_SSCC}`);
    expect(result).toMatchObject({ kind: "verified", job: { state: "verified" } });
    expect(palletRecords(at)).toEqual([
      { kind: "pallet_label", data: { palletId, outcome: "verified", at: expect.any(String) } },
    ]);
  });

  it("is skipped with a `pallet_label` record `skipped`", async () => {
    const { at, palletId, job } = await closedPallet({ settings: { verifyPrintedLabel: true } });
    await skipLabel(resolving(at), job);
    expect(palletRecords(at)).toEqual([
      { kind: "pallet_label", data: { palletId, outcome: "skipped", at: expect.any(String) } },
    ]);
  });

  it("printed again where it may exist writes the pallet's reprint with its reason as it sends", async () => {
    const at = await palletStation({ capacity: 1 });
    await closeBoxOnPallet(at, ["A1"]);
    const [row] = rows(at.db, "SELECT id FROM floor_print_jobs WHERE purpose = 'pallet'");
    const prepared = await readPrintJob(at.local, PAIRING, String(row?.["id"]));
    if (prepared === null) throw new Error("no job");
    const unknown = await sendLabelJob(
      resolving(
        at,
        fakeHardware(async () => ({ sent: false, code: "outcome_unknown" })),
      ),
      prepared,
    );
    expect(unknown).toMatchObject({ state: "unknown" });
    const shell = fakeHardware();
    const again = await printAgain(
      resolving(at, shell),
      unknown,
      { reason: "printer_jam", printer: null },
      at.settings,
      at.pallets.template,
    );
    expect(again).toMatchObject({ state: "sent", attempts: 2 });
    expect(shell.sends.map((send) => send.text)).toEqual([
      renderedText(ZEBRA, PALLET_SSCC, "100x150"),
    ]);
    expect(palletRecords(at)).toEqual([
      {
        kind: "pallet_exception",
        data: {
          exception: "reprint",
          palletId: prepared.subjectId,
          reasonCode: "printer_jam",
          reasonText: null,
          occurredAt: expect.any(String),
        },
      },
    ]);
    expect(rows(at.db, "SELECT kind, pallet_id, reason_code FROM floor_pallet_exceptions")).toEqual(
      [{ kind: "reprint", pallet_id: prepared.subjectId, reason_code: "printer_jam" }],
    );
  });
});

describe("the closed pallets of a shift (plan ПЛ-Ц)", () => {
  it("are the closed ones not taken apart, the last first, with the boxes they hold", async () => {
    const { at, palletId } = await closedPallet();
    await closeBoxOnPallet(at, ["C1"]);
    await closeBoxOnPallet(at, ["D1"]);
    const listed = await readClosedPallets(at.local, PAIRING, at.shift.copy.id);
    expect(listed.map((pallet) => pallet.boxCount)).toEqual([2, 2]);
    expect(listed[1]).toMatchObject({ id: palletId, sscc: PALLET_SSCC });
    expect(listed[0]?.sscc).toBe(buildSscc(PALLET_EXTENSION, PREFIX, 1));
    // An open pallet is no closed one.
    await closeBoxOnPallet(at, ["E1"]);
    await expect(readClosedPallets(at.local, PAIRING, at.shift.copy.id)).resolves.toHaveLength(2);
  });
});

describe("«Расформировать паллету» (plan ПЛ-Ц)", () => {
  it("takes the pallet apart with its reason; its boxes stay closed, with their codes and their pallet", async () => {
    const { at, palletId } = await closedPallet();
    const context = palletContext(at);
    await expect(
      disassemblePallet(context, palletId, { code: "other", text: "  Не тот заказ " }),
    ).resolves.toEqual({ kind: "done", boxes: 2 });
    expect(rows(at.db, "SELECT disassembled_at IS NOT NULL AS apart FROM floor_pallets")).toEqual([
      { apart: 1 },
    ]);
    expect(
      rows(at.db, "SELECT pallet_id, disassembled_at FROM floor_boxes ORDER BY closed_at"),
    ).toEqual([
      { pallet_id: palletId, disassembled_at: null },
      { pallet_id: palletId, disassembled_at: null },
    ]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 3 }]);
    expect(palletRecords(at)).toEqual([
      {
        kind: "pallet_exception",
        data: {
          exception: "disassemble",
          palletId,
          reasonCode: "other",
          reasonText: "Не тот заказ",
          occurredAt: expect.any(String),
        },
      },
    ]);
    await expect(readClosedPallets(at.local, PAIRING, at.shift.copy.id)).resolves.toEqual([]);
    // Taken apart once: a second time is no closed pallet any more.
    await expect(
      disassemblePallet(context, palletId, { code: "wrong_product", text: null }),
    ).rejects.toBeInstanceOf(PalletUnavailableError);
  });

  it("refuses an open pallet, and words with any reason but «Другая причина», writing nothing", async () => {
    const { at, palletId } = await closedPallet();
    await closeBoxOnPallet(at, ["C1"]);
    const [open] = rows(at.db, "SELECT id FROM floor_pallets WHERE closed_at IS NULL");
    const context = palletContext(at);
    await expect(
      disassemblePallet(context, String(open?.["id"]), { code: "wrong_product", text: null }),
    ).rejects.toBeInstanceOf(PalletUnavailableError);
    await expect(
      disassemblePallet(context, palletId, { code: "wrong_product", text: "Не тот товар" }),
    ).rejects.toBeInstanceOf(InvalidReasonError);
    expect(palletRecords(at)).toEqual([]);
  });

  it("takes a pallet apart once when two disassemblies of it race", async () => {
    const { at, palletId } = await closedPallet();
    const held = holdingWrites(at.local);
    held.holdNext();
    const first = disassemblePallet(palletContext({ ...at, local: held.executor }), palletId, {
      code: "wrong_quantity",
      text: null,
    });
    await held.reached();
    await disassemblePallet(palletContext(at), palletId, { code: "wrong_product", text: null });
    held.release();
    await expect(first).resolves.toEqual({ kind: "stale" });
    expect(palletRecords(at).map((record) => record.data["reasonCode"])).toEqual(["wrong_product"]);
  });
});

describe("«Перепечатать этикетку паллеты» (plan ПЛ-Ц)", () => {
  it("prints the same label again with the reason, the dates of the pallet's own close, once", async () => {
    const { at, palletId, job } = await closedPallet();
    const shell = fakeHardware();
    const reprinted = await reprintPallet(
      { ...resolving(at, shell), shift: at.shift },
      at.pallets,
      palletId,
      { code: "damaged_label", text: null },
      at.settings,
      fakeRender,
    );
    expect(reprinted).toMatchObject({
      purpose: "pallet",
      subjectId: palletId,
      sscc: PALLET_SSCC,
      state: "sent",
      attempts: 1,
      fields: job.fields,
      templateId: at.pallets.template.id,
      templateRev: 63,
    });
    expect(reprinted.id).not.toBe(job.id);
    expect(shell.sends).toHaveLength(1);
    expect(palletRecords(at)).toEqual([
      {
        kind: "pallet_exception",
        data: {
          exception: "reprint",
          palletId,
          reasonCode: "damaged_label",
          reasonText: null,
          occurredAt: expect.any(String),
        },
      },
    ]);
  });

  it("leaves a label that still waits to its panel, and refuses a pallet taken apart", async () => {
    const { at, palletId } = await closedPallet({ settings: { verifyPrintedLabel: true } });
    const context = { ...resolving(at), shift: at.shift };
    await expect(
      reprintPallet(
        context,
        at.pallets,
        palletId,
        { code: "printer_jam", text: null },
        at.settings,
      ),
    ).rejects.toBeInstanceOf(LabelWaitingError);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'skipped' WHERE purpose = 'pallet'").run();
    await disassemblePallet(palletContext(at), palletId, { code: "wrong_product", text: null });
    await expect(
      reprintPallet(
        context,
        at.pallets,
        palletId,
        { code: "printer_jam", text: null },
        at.settings,
      ),
    ).rejects.toBeInstanceOf(PalletUnavailableError);
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs WHERE purpose = 'pallet'"),
    ).toEqual([{ n: 1 }]);
  });
});
```

Правка `apps/standalone/test/retention.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { undoLastCode } from "../src/floor/exceptions/box-exceptions.js";
import { boxLabelStep, readPrintJob, sendLabelJob } from "../src/floor/print/print-jobs.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { undoLastCode } from "../src/floor/exceptions/box-exceptions.js";
import { disassemblePallet } from "../src/floor/exceptions/pallet-exceptions.js";
import { openPalletGuard } from "../src/floor/pallets/pallets.js";
import { boxLabelStep, readPrintJob, sendLabelJob } from "../src/floor/print/print-jobs.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
import { fakeHardware } from "./support/hardware.js";
import { fakeRender, manualRuntime, printStation, resolveContext } from "./support/printing.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { fakeHardware } from "./support/hardware.js";
import { closeBoxOnPallet, palletContext, palletStation } from "./support/pallets.js";
import { fakeRender, manualRuntime, printStation, resolveContext } from "./support/printing.js";
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  });

  it("names every table of a shift's records: a table with a `shift_id` and no retention fails here", async () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
  });

  it("deletes a shift's pallets and their exceptions with it (plan ПЛ-Ц)", async () => {
    const at = await palletStation({ capacity: 1 });
    const closed = await closeBoxOnPallet(at, ["A1"]);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sent'").run();
    const [pallet] = rows(at.db, "SELECT id FROM floor_pallets");
    const context = palletContext(at);
    await disassemblePallet(context, String(pallet?.["id"]), { code: "wrong_product", text: null });
    const result = await closeShift(context, "production_defect", [
      openPalletGuard(PAIRING, at.shift.copy.id),
    ]);
    if (result.kind !== "closed") throw new Error(result.kind);
    at.db.prepare("UPDATE outbox SET outcome = 'accepted', acked_at = ?").run(CUTOFF);
    at.db.prepare("UPDATE floor_shifts SET local_state = 'closed'").run();
    expect(kept(at, at.shift.copy.id)).toMatchObject({
      floor_pallets: 1,
      floor_pallet_exceptions: 1,
    });
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(1);
    expect(kept(at, at.shift.copy.id)).toEqual(NONE);
  });

  it("names every table of a shift's records: a table with a `shift_id` and no retention fails here", async () => {
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallet-exceptions.test.ts test/retention.test.ts`
Expected: FAIL — `test/floor-pallet-exceptions.test.ts` и `test/retention.test.ts` не загружаются (`Failed to resolve import "../src/floor/exceptions/pallet-exceptions.js"`).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/floor/exceptions/box-exceptions.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
}

/** The checked reason fields of a record: the code, and its words or `null`. */
function reasonFields(
  reasons: readonly string[],
```

заменить на:

<!-- prettier-ignore -->
```ts
}

/**
 * The checked reason fields of a record: the code of its kind's list, and
 * its words or `null`; a pallet's exceptions (plan ПЛ-Ц) take the same.
 */
export function reasonFields(
  reasons: readonly string[],
```

Создать `apps/standalone/src/floor/exceptions/pallet-exceptions.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import type { PalletExceptionFact } from "../../host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import {
  DISASSEMBLE_REASONS,
  REPRINT_REASONS,
  type DisassembleReason,
  type ReprintReason,
} from "../exception-reasons.js";
import { outboxStatement, palletExceptionRecord } from "../facts.js";
import type { ShiftPallets } from "../pallets/pallets.js";
import {
  isOpenJob,
  prepareLabelJob,
  readPrintJob,
  sendLabelJob,
  type PrintJob,
  type RenderLabel,
} from "../print/print-jobs.js";
import type { WorkstationSettings } from "../setup/workstation-settings.js";
import type { BoxContext } from "../work/box-close.js";
import {
  LabelWaitingError,
  reasonFields,
  type ExceptionReason,
  type ReprintContext,
} from "./box-exceptions.js";

/**
 * The station's `floor_pallet_exceptions` row and the `pallet_exception`
 * record of a pallet's exception (plan ПЛ-Х's form: `exception`, a reason
 * code always, words only with `other`), for the transaction that applies
 * its consequences — or, for a reprint of a label that may exist, the
 * transaction that sends it again (`printAgain`).
 */
export function palletExceptionStatements(
  context: Pick<BoxContext, "pairing" | "operatorId" | "newId">,
  shiftId: string,
  data: PalletExceptionFact,
): LocalStatement[] {
  const { pairing, operatorId } = context;
  const record = palletExceptionRecord({ id: context.newId(), shiftId, operatorId }, data);
  return [
    {
      sql:
        "INSERT INTO floor_pallet_exceptions (id, host_id, device_id, shift_id, kind, pallet_id, " +
        "reason_code, reason_text, occurred_at, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      values: [
        context.newId(),
        pairing.hostId,
        pairing.deviceId,
        shiftId,
        data.exception,
        data.palletId,
        data.reasonCode,
        data.reasonText,
        data.occurredAt,
        operatorId,
      ],
      expectedChanges: 1,
    },
    outboxStatement(record, pairing, data.occurredAt),
  ];
}

/** A closed pallet of the shift, as the exceptions list it. */
export interface ClosedPallet {
  id: string;
  sscc: string;
  /** Its boxes not taken apart. */
  boxCount: number;
  closedAt: string;
}

const closedPalletRow = z.object({
  id: z.string(),
  sscc: z.string(),
  boxes: z.number().int().nonnegative(),
  closed_at: z.string(),
});

/**
 * The shift's closed pallets not taken apart, the pallet closed last first:
 * what a pallet's reprint or disassembly can be done to.
 */
export async function readClosedPallets(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<ClosedPallet[]> {
  const rows = await local.query(
    "SELECT p.id, p.sscc, p.closed_at, (SELECT count(*) FROM floor_boxes b " +
      "WHERE b.host_id = p.host_id AND b.device_id = p.device_id AND b.pallet_id = p.id " +
      "AND b.disassembled_at IS NULL) AS boxes FROM floor_pallets p WHERE p.host_id = ? " +
      "AND p.device_id = ? AND p.shift_id = ? AND p.closed_at IS NOT NULL " +
      "AND p.disassembled_at IS NULL ORDER BY p.closed_at DESC, p.serial DESC",
    [pairing.hostId, pairing.deviceId, shiftId],
    closedPalletRow,
  );
  return rows.map((row) => ({
    id: row.id,
    sscc: row.sscc,
    boxCount: row.boxes,
    closedAt: row.closed_at,
  }));
}

/** The pallet is no closed pallet of this shift that is not taken apart: nothing was written. */
export class PalletUnavailableError extends Error {
  constructor(palletId: string) {
    super(`pallet ${palletId} is not a closed pallet of the shift`);
    this.name = "PalletUnavailableError";
  }
}

const palletStateRow = z.object({
  closed_at: z.string().nullable(),
  disassembled_at: z.string().nullable(),
});

/** Whether `palletId` is a closed pallet of the shift not taken apart. */
async function isClosedPallet(context: BoxContext, palletId: string): Promise<boolean> {
  const { local, pairing, shift } = context;
  const [row] = await local.query(
    "SELECT closed_at, disassembled_at FROM floor_pallets WHERE id = ? AND host_id = ? " +
      "AND device_id = ? AND shift_id = ?",
    [palletId, pairing.hostId, pairing.deviceId, shift.copy.id],
    palletStateRow,
  );
  return row !== undefined && row.closed_at !== null && row.disassembled_at === null;
}

/**
 * «Расформировать паллету» (pilot spec §6.1): a closed pallet of the shift
 * is taken apart in ONE transaction — `disassembled_at` (only while it is
 * closed and not taken apart), the station's exception and the
 * `disassemble` record with its reason. Its boxes are untouched and keep
 * their pallet, as in the cloud: for the exports they are boxes without a
 * pallet (plan ПЛ-Х), and they stay closed, with their codes. The pallet
 * keeps its SSCC: the number is spent. `stale` — the pallet changed
 * meanwhile, nothing written; one that is open, taken apart or another
 * shift's — `PalletUnavailableError`.
 */
export async function disassemblePallet(
  context: BoxContext,
  palletId: string,
  reason: ExceptionReason<DisassembleReason>,
): Promise<{ kind: "done"; boxes: number } | { kind: "stale" }> {
  const fields = reasonFields(DISASSEMBLE_REASONS, reason);
  if (!(await isClosedPallet(context, palletId))) throw new PalletUnavailableError(palletId);
  const { local, pairing, shift } = context;
  const [counted] = await readClosedPallets(local, pairing, shift.copy.id).then((pallets) =>
    pallets.filter((pallet) => pallet.id === palletId),
  );
  const at = context.now().toISOString();
  try {
    await local.transaction([
      {
        sql:
          "UPDATE floor_pallets SET disassembled_at = ? WHERE id = ? AND host_id = ? " +
          "AND device_id = ? AND closed_at IS NOT NULL AND disassembled_at IS NULL",
        values: [at, palletId, pairing.hostId, pairing.deviceId],
        expectedChanges: 1,
      },
      ...palletExceptionStatements(context, shift.copy.id, {
        exception: "disassemble",
        palletId,
        reasonCode: fields.reasonCode,
        reasonText: fields.reasonText,
        occurredAt: at,
      }),
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      return { kind: "stale" };
    }
    throw error;
  }
  return { kind: "done", boxes: counted?.boxCount ?? 0 };
}

const lastJobRow = z.object({ id: z.string() });

/**
 * «Перепечатать этикетку паллеты» of a closed pallet whose label is done with
 * (pilot spec §6.1; plan 2a8's contract): a new print job of the same label —
 * the SSCC and the fields of the pallet's last job, so the dates are those of
 * its own close, the snapshot's pallet template of the job's revision, the
 * printer of the purpose «Паллета» now — written in ONE transaction with the
 * station's exception and the `reprint` record and its reason; then the job
 * goes to the printer once, as a first send. A pallet whose label still
 * waits is decided at the label's panel (`LabelWaitingError`); one open,
 * taken apart or another shift's — `PalletUnavailableError`. No printer or no
 * render: the job is kept `failed`, and the label's panel takes it from there.
 * Answers the new job.
 */
export async function reprintPallet(
  context: ReprintContext,
  pallets: ShiftPallets,
  palletId: string,
  reason: ExceptionReason<ReprintReason>,
  settings: Pick<WorkstationSettings, "printers" | "assignments" | "verifyPrintedLabel">,
  render?: RenderLabel,
): Promise<PrintJob> {
  const fields = reasonFields(REPRINT_REASONS, reason);
  const { local, pairing, shift } = context;
  if (!(await isClosedPallet(context, palletId))) throw new PalletUnavailableError(palletId);
  const [row] = await local.query(
    "SELECT id FROM floor_print_jobs WHERE host_id = ? AND device_id = ? AND purpose = 'pallet' " +
      "AND subject_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    [pairing.hostId, pairing.deviceId, palletId],
    lastJobRow,
  );
  const last = row === undefined ? null : await readPrintJob(local, pairing, row.id);
  if (last === null) throw new PalletUnavailableError(palletId);
  if (isOpenJob(last)) throw new LabelWaitingError(palletId);
  const { template } = pallets;
  if (template.id !== last.templateId || template.rev !== last.templateRev) {
    throw new PalletUnavailableError(palletId);
  }
  const at = context.now().toISOString();
  const jobId = context.newId();
  const job = await prepareLabelJob(
    {
      id: jobId,
      shiftId: shift.copy.id,
      purpose: "pallet",
      subjectId: palletId,
      sscc: last.sscc,
      fields: last.fields,
      template,
      operatorId: context.operatorId,
      createdAt: at,
    },
    settings,
    pairing,
    render,
  );
  await local.transaction([
    job,
    ...palletExceptionStatements(context, shift.copy.id, {
      exception: "reprint",
      palletId,
      reasonCode: fields.reasonCode,
      reasonText: fields.reasonText,
      occurredAt: at,
    }),
  ]);
  const kept = await readPrintJob(local, pairing, jobId);
  if (kept === null) throw new PalletUnavailableError(palletId);
  return kept.state === "prepared" ? sendLabelJob(context, kept) : kept;
}
```

Правка `apps/standalone/src/floor/print/print-resolution.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import type { ReprintReason } from "../exception-reasons.js";
import { boxExceptionRecord, boxLabelRecord, outboxStatement } from "../facts.js";
import {
```

заменить на:

<!-- prettier-ignore -->
```ts
import type { ReprintReason } from "../exception-reasons.js";
import { palletExceptionStatements } from "../exceptions/pallet-exceptions.js";
import {
  boxExceptionRecord,
  boxLabelRecord,
  outboxStatement,
  palletLabelRecord,
} from "../facts.js";
import {
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
/**
 * The record of a label's check for the host: `box_label` for a box. A
 * pallet's (`pallet_label`) is the pallets' plan's to add (ПЛ-Ц).
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
/**
 * The record of a label's check for the host: `box_label` for a box,
 * `pallet_label` for a pallet (plan ПЛ-Ц).
 */
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
    case "pallet":
      throw new UnresolvableJobError(job.id, job.state);
  }
```

заменить на:

<!-- prettier-ignore -->
```ts
    case "pallet":
      return palletLabelRecord(head, { palletId: job.subjectId, outcome, at });
  }
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
 * row and the `box_exception` record of kind `reprint` with its reason, no
 * words (the work screen offers the codes only). A pallet's reprint is the
 * pallets' plan's.
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
 * row and the `box_exception` record of kind `reprint` with its reason, no
 * words (the work screen offers the codes only); for a pallet, its
 * `floor_pallet_exceptions` row and `pallet_exception` record (plan ПЛ-Ц).
 */
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
): LocalStatement[] {
  if (job.purpose !== "box") throw new UnresolvableJobError(job.id, job.state);
  const exceptionId = context.newId();
```

заменить на:

<!-- prettier-ignore -->
```ts
): LocalStatement[] {
  if (job.purpose === "pallet") {
    return palletExceptionStatements(context, job.shiftId, {
      exception: "reprint",
      palletId: job.subjectId,
      reasonCode: reason,
      reasonText: null,
      occurredAt: at,
    });
  }
  const exceptionId = context.newId();
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallet-exceptions.test.ts test/retention.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  18 passed (18)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  115 passed (115)`, `Tests  2695 passed (2695)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — решение по этикетке паллеты не пишет запись `pallet_label`.
В `apps/standalone/src/floor/print/print-resolution.ts` фрагмент

<!-- prettier-ignore -->
```ts
      return palletLabelRecord(head, { palletId: job.subjectId, outcome, at });
```

заменить на:

<!-- prettier-ignore -->
```ts
      throw new UnresolvableJobError(job.id, job.state);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallet-exceptions.test.ts`
Expected: FAIL — «is checked by the scan of its SSCC, with a `pallet_label` record», «is skipped with a `pallet_label` record `skipped`».

М2 — расформирование паллеты не проверяет, что она ещё не расформирована.
В `apps/standalone/src/floor/exceptions/pallet-exceptions.ts` фрагмент

<!-- prettier-ignore -->
```ts
          "AND device_id = ? AND closed_at IS NOT NULL AND disassembled_at IS NULL",
```

заменить на:

<!-- prettier-ignore -->
```ts
          "AND device_id = ? AND closed_at IS NOT NULL",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallet-exceptions.test.ts`
Expected: FAIL — «takes a pallet apart once when two disassemblies of it race».

М3 — перепечатка паллеты, чья этикетка ещё ждёт.
В `apps/standalone/src/floor/exceptions/pallet-exceptions.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (isOpenJob(last)) throw new LabelWaitingError(palletId);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallet-exceptions.test.ts`
Expected: FAIL — «leaves a label that still waits to its panel, and refuses a pallet taken apart».

М4 — печать снова этикетки паллеты с причиной пишет исключение короба.
В `apps/standalone/src/floor/print/print-resolution.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (job.purpose === "pallet") {
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (job.purpose !== job.purpose) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-pallet-exceptions.test.ts`
Expected: FAIL — «printed again where it may exist writes the pallet's reprint with its reason as it sends».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/exceptions/box-exceptions.ts apps/standalone/src/floor/exceptions/pallet-exceptions.ts apps/standalone/src/floor/print/print-resolution.ts apps/standalone/test/floor-pallet-exceptions.test.ts apps/standalone/test/retention.test.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/exceptions/box-exceptions.ts apps/standalone/src/floor/exceptions/pallet-exceptions.ts apps/standalone/src/floor/print/print-resolution.ts apps/standalone/test/floor-pallet-exceptions.test.ts apps/standalone/test/retention.test.ts
git commit -m "feat(standalone): a pallet's label is checked, skipped and printed again; a pallet's reprint and disassembly" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Рабочий экран смены с паллетами — «Паллета: N из M», досрочное закрытие, этикетка паллеты после короба, номера паллет

Рабочий экран (`WorkScreen.tsx`): строка «Паллета — N из M коробов»; закрытие короба идёт с `palletStep`; `settleLabel` отправляет все записанные и не отправленные этикетки по очереди (короба, затем паллеты) и останавливается на первой ждущей; полная паллета без номеров — сообщение «Паллета заполнена, но не закрыта» без остановки линии, а с приходом блока паллет (половина, вход, после закрытия, возвращение связи) — закрытие (`settlePallet`); «Закрыть паллету досрочно» — подтверждение («На паллете N из M коробов»), затем работа очереди; нет номеров — остановка `pallet_no_serials` с «Повторить», номер вне диапазона — `pallet_failed`. Панель этикетки говорит о паллете («SSCC паллеты», «Этикетка паллеты не напечатана», «Принтер для паллет не назначен»), печать снова этикетки паллеты рендерит макет паллеты снимка.

**Files:**

- Modify: `apps/standalone/src/floor/print/LabelPanel.tsx`, `apps/standalone/src/floor/work/WorkScreen.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-work-pallets.test.tsx` (Create), `apps/standalone/test/support/pallets.ts` (Modify)

**Interfaces:**

- Consumes: задачи 3–4; `WorkScreen`, `LabelPanel`, `closeSettled`, `createBlockSupply` (планы 2a6–2a8); опора `renderWork` (план 2a8).
- Produces:
  - `Stop` += `confirm_pallet`, `pallet_no_serials { reason }`, `pallet_failed`; `closePallet()` рабочего экрана (`"closed" | "empty" | "stopped"`), `settlePallet()`;
  - ключи `floor.work.pallet*`, `floor.work.confirmPallet`, `floor.work.keepPallet`, `floor.work.closePallet*`, `floor.print.pallet.*`; опора `palletStation({ boxCapacity })`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-work-pallets.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { buildSscc } from "@markiro/domain";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PALLET_EXTENSION } from "../src/floor/pallets/pallets.js";
import type { SsccBlockRequest } from "../src/host/protocol.js";
import { km, PREFIX, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { palletStation, type PalletStation } from "./support/pallets.js";
import { renderedText, ZEBRA } from "./support/printing.js";
import { renderWork } from "./support/work-screen.js";

const PALLET_SSCC = buildSscc(PALLET_EXTENSION, PREFIX, 0);
const BOX_SSCC = (serial: number) => buildSscc(0, PREFIX, serial);

function kinds(at: PalletStation): unknown[] {
  return rows(at.db, "SELECT kind FROM outbox WHERE kind <> 'scan' ORDER BY seq").map(
    (row) => row["kind"],
  );
}

/** The pallet's fact: its line in the work screen's numbers. */
function palletLine(): string | null {
  const term = screen.getByText("Паллета", { selector: "dt" });
  return term.nextElementSibling?.textContent ?? null;
}

describe("the work screen of a shift with pallets (plan ПЛ-Ц)", () => {
  it("counts the boxes on the open pallet; the box that fills it closes it, and both labels print, the box's first", async () => {
    const at = await palletStation({ capacity: 2, boxCapacity: 1 });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    expect(palletLine()).toBe("0 из 2 коробов");
    await work.scan(km("A1"));
    expect(palletLine()).toBe("1 из 2 коробов");
    await work.scan(km("A2"));
    expect(palletLine()).toBe("0 из 2 коробов");
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed"]);
    expect(work.shell.sends.map((send) => send.text)).toEqual([
      renderedText(ZEBRA, BOX_SSCC(1500)),
      renderedText(ZEBRA, BOX_SSCC(1501)),
      renderedText(ZEBRA, PALLET_SSCC, "100x150"),
    ]);
  });

  it("closes the pallet early after a confirmation, and never an empty one", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    const early = () => screen.getByRole("button", { name: "Закрыть паллету досрочно" });
    expect(early()).toHaveProperty("disabled", true);
    await work.scan(km("A1"));
    await work.scan(km("A2"));
    expect(early()).toHaveProperty("disabled", false);
    await work.press("Закрыть паллету досрочно");
    expect(screen.getByText("Закрыть паллету досрочно? На паллете 2 из 40 коробов.")).toBeTruthy();
    await work.press("Не закрывать");
    expect(kinds(at)).not.toContain("pallet_closed");
    await work.press("Закрыть паллету досрочно");
    await work.press("Закрыть паллету");
    expect(kinds(at).at(-1)).toBe("pallet_closed");
    expect(work.shell.sends.at(-1)?.text).toBe(renderedText(ZEBRA, PALLET_SSCC, "100x150"));
    expect(palletLine()).toBe("0 из 40 коробов");
    expect(early()).toHaveProperty("disabled", true);
  });

  it("says a full pallet waits for pallet serials, takes the next boxes on it, and closes it once the link brings a block", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1, palletBlock: false });
    const requestBlock = vi.fn(async (request: SsccBlockRequest) => ({
      id:
        request.extension === PALLET_EXTENSION
          ? "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d"
          : "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      issuerPrefix: request.issuerPrefix,
      extension: request.extension,
      fromSerial: request.extension === PALLET_EXTENSION ? 0 : 1500,
      toSerial: request.extension === PALLET_EXTENSION ? 199 : 3499,
    }));
    const work = renderWork(at, { overrides: { requestBlock } });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(screen.getByText("Паллета заполнена, но не закрыта")).toBeTruthy();
    await work.scan(km("A2"));
    expect(palletLine()).toBe("2 из 1 коробов");
    expect(kinds(at)).toEqual(["box_closed", "box_closed"]);
    work.rerender({ online: true });
    await work.settled();
    await work.settled();
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed"]);
    expect(screen.queryByText("Паллета заполнена, но не закрыта")).toBeNull();
    expect(palletLine()).toBe("0 из 1 коробов");
    expect(requestBlock).toHaveBeenCalledWith(
      expect.objectContaining({ extension: PALLET_EXTENSION }),
    );
  });

  it("checks the box's label first and then the pallet's, each by its own SSCC, in the pallet's words", async () => {
    const at = await palletStation({
      capacity: 1,
      boxCapacity: 1,
      settings: { verifyPrintedLabel: true },
    });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(screen.getByText("Отсканируйте SSCC на этикетке короба.")).toBeTruthy();
    // The pallet's SSCC is no answer to the box's check.
    await work.scan(`(00)${PALLET_SSCC}`);
    expect(screen.getByText(/Это этикетка другого короба/)).toBeTruthy();
    await work.scan(`(00)${BOX_SSCC(1500)}`);
    expect(screen.getByText("Отсканируйте SSCC на этикетке паллеты.")).toBeTruthy();
    expect(screen.getByText(/SSCC паллеты:/)).toBeTruthy();
    await work.scan(`(00)${PALLET_SSCC}`);
    expect(screen.queryByText("Отсканируйте SSCC на этикетке паллеты.")).toBeNull();
    expect(kinds(at)).toEqual(["box_closed", "pallet_closed", "box_label", "pallet_label"]);
  });

  it("stops on a pallet's label that did not print, says why in the pallet's words, and goes on without it", async () => {
    const at = await palletStation({
      capacity: 1,
      boxCapacity: 1,
      settings: { assignments: { box: "zebra", pallet: null, duplicate: null } },
    });
    const work = renderWork(at, { shell: fakeHardware() });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(screen.getByText("Этикетка паллеты не напечатана")).toBeTruthy();
    expect(
      screen.getByText("Принтер для паллет не назначен. Назначьте его в настройке рабочего места."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Закрыть паллету досрочно" })).toHaveProperty(
      "disabled",
      true,
    );
    await work.press("Продолжить без этикетки");
    expect(screen.getByText(/Паллета уже закрыта/)).toBeTruthy();
    await work.press("Продолжить без этикетки");
    expect(kinds(at)).toEqual(["box_closed", "pallet_closed", "pallet_label"]);
    await work.scan(km("A2"));
    expect(kinds(at).at(-1)).toBe("pallet_closed");
  });
});
```

Правка `apps/standalone/test/support/pallets.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
 * A station with the shift with pallets entered — `capacity` boxes to a
 * pallet — a box block from 1500, a pallet block of serials 0–199 unless
 * `palletBlock` is `false`, and the Zebra for boxes and pallets.
 */
export async function palletStation(
  options: {
    capacity?: number;
    palletBlock?: boolean;
```

заменить на:

<!-- prettier-ignore -->
```ts
 * A station with the shift with pallets entered — `capacity` boxes to a
 * pallet, `boxCapacity` codes to a box (12) — a box block from 1500, a pallet
 * block of serials 0–199 unless `palletBlock` is `false`, and the Zebra for
 * boxes and pallets.
 */
export async function palletStation(
  options: {
    capacity?: number;
    boxCapacity?: number;
    palletBlock?: boolean;
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
    ...PALLETS_ENTERED,
    palletBoxCapacity: options.capacity ?? 3,
```

заменить на:

<!-- prettier-ignore -->
```ts
    ...PALLETS_ENTERED,
    boxCapacity: options.boxCapacity ?? PALLETS_ENTERED.boxCapacity,
    palletBoxCapacity: options.capacity ?? 3,
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallets.test.tsx`
Expected: FAIL — `test/floor-work-pallets.test.tsx`: 5 из 5 (первый — «counts the boxes on the open pallet; the box that fills it closes it, and both labels print, the box's first»: `Unable to find an element with the text: Паллета, which matches selector 'dt'`).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/floor/print/LabelPanel.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  | { kind: "skip" };

function noteText(note: LabelNote, t: ReturnType<typeof useTranslation>["t"]): string {
  switch (note.kind) {
    case "mismatch":
      return t("floor.print.check.mismatch", { sscc: formatSsccHri(note.sscc) });
    case "not_sscc":
      return t("floor.print.check.notSscc");
    case "no_printer":
```

заменить на:

<!-- prettier-ignore -->
```tsx
  | { kind: "skip" };

function noteText(
  note: LabelNote,
  t: ReturnType<typeof useTranslation>["t"],
  pallet: boolean,
): string {
  switch (note.kind) {
    case "mismatch":
      return t(pallet ? "floor.print.pallet.mismatch" : "floor.print.check.mismatch", {
        sscc: formatSsccHri(note.sscc),
      });
    case "not_sscc":
      return t(pallet ? "floor.print.pallet.notSscc" : "floor.print.check.notSscc");
    case "no_printer":
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
/**
 * The label of the box the work stopped for (stage 2a spec §5.7.5): its
 * check — scan the SSCC, or skip it — or its recovery when it failed or its
 * outcome is unknown. Only the operator sends a label again: a label that
 * may already exist only with a reason, which the panel asks before the
```

заменить на:

<!-- prettier-ignore -->
```tsx
/**
 * The label of the box — or of the pallet (plan ПЛ-Ц), said so — the work
 * stopped for (stage 2a spec §5.7.5): its check — scan the SSCC, or skip
 * it — or its recovery when it failed or its outcome is unknown. Only the operator sends a label again: a label that
 * may already exist only with a reason, which the panel asks before the
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  const mayExist = checking || job.state === "unknown";
  const sscc = t("floor.print.sscc", { sscc: formatSsccHri(job.sscc) });

  const again = (printer: PrinterProfile | null) => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const mayExist = checking || job.state === "unknown";
  const pallet = job.purpose === "pallet";
  const sscc = t(pallet ? "floor.print.pallet.sscc" : "floor.print.sscc", {
    sscc: formatSsccHri(job.sscc),
  });

  const again = (printer: PrinterProfile | null) => {
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
      <Alert tone="warn" title={t("floor.print.skipConfirm.title")} className="work-screen__label">
        <p>{t("floor.print.skipConfirm.body")}</p>
        <p>{sscc}</p>
```

заменить на:

<!-- prettier-ignore -->
```tsx
      <Alert tone="warn" title={t("floor.print.skipConfirm.title")} className="work-screen__label">
        <p>{t(pallet ? "floor.print.pallet.skipBody" : "floor.print.skipConfirm.body")}</p>
        <p>{sscc}</p>
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
      <Alert tone="info" title={t("floor.print.check.title")} className="work-screen__label">
        <p>{t("floor.print.check.body")}</p>
        <p>{sscc}</p>
        {note !== null && <p role="alert">{noteText(note, t)}</p>}
        <div className="standalone-form__actions">
```

заменить на:

<!-- prettier-ignore -->
```tsx
      <Alert tone="info" title={t("floor.print.check.title")} className="work-screen__label">
        <p>{t(pallet ? "floor.print.pallet.checkBody" : "floor.print.check.body")}</p>
        <p>{sscc}</p>
        {note !== null && <p role="alert">{noteText(note, t, pallet)}</p>}
        <div className="standalone-form__actions">
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
      tone="error"
      title={t(job.state === "unknown" ? "floor.print.unknownTitle" : "floor.print.failedTitle")}
      className="work-screen__label"
    >
      {job.errorCode !== null && <p>{t(`floor.print.codes.${job.errorCode}`)}</p>}
      <p>{sscc}</p>
      {note !== null && <p role="alert">{noteText(note, t)}</p>}
      <div className="standalone-form__actions">
```

заменить на:

<!-- prettier-ignore -->
```tsx
      tone="error"
      title={t(
        job.state === "unknown"
          ? "floor.print.unknownTitle"
          : pallet
            ? "floor.print.pallet.failedTitle"
            : "floor.print.failedTitle",
      )}
      className="work-screen__label"
    >
      {job.errorCode !== null && (
        <p>
          {pallet && job.errorCode === "printer_unconfigured"
            ? t("floor.print.pallet.printerUnconfigured")
            : t(`floor.print.codes.${job.errorCode}`)}
        </p>
      )}
      <p>{sscc}</p>
      {note !== null && <p role="alert">{noteText(note, t, pallet)}</p>}
      <div className="standalone-form__actions">
```

Правка `apps/standalone/src/floor/work/WorkScreen.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { ExceptionFlow, type ExceptionOutcome } from "../exceptions/ExceptionFlow.js";
import { LabelPanel, type LabelNote } from "../print/LabelPanel.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { ExceptionFlow, type ExceptionOutcome } from "../exceptions/ExceptionFlow.js";
import {
  closeOpenPallet,
  closePalletIfFull,
  PALLET_EXTENSION,
  palletStep,
  readOpenPallet,
  shiftPallets,
  type OpenPallet,
  type PalletContext,
} from "../pallets/pallets.js";
import { LabelPanel, type LabelNote } from "../print/LabelPanel.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
import { createBlockSupply, type SupplyResult } from "./block-supply.js";
import { closeIfFull, closeOpenBox, type CloseResult } from "./box-close.js";
import { processScan, type ScanContext, type ScanOutcome } from "./scan-pipeline.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { createBlockSupply, type SupplyResult } from "./block-supply.js";
import { closeIfFull, closeOpenBox } from "./box-close.js";
import { processScan, type ScanContext, type ScanOutcome } from "./scan-pipeline.js";
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
 * of the shift's close, and the shift closed — which never lets a scan in
 * again.
 */
```

заменить на:

<!-- prettier-ignore -->
```tsx
 * of the shift's close, and the shift closed — which never lets a scan in
 * again; plan ПЛ-Ц the early close of the open pallet to confirm, and a
 * pallet's close that found no pallet serial or a serial out of range.
 */
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  | { kind: "close_failed"; full: boolean }
  | { kind: "label"; job: PrintJob }
```

заменить на:

<!-- prettier-ignore -->
```tsx
  | { kind: "close_failed"; full: boolean }
  | { kind: "confirm_pallet" }
  | { kind: "pallet_no_serials"; reason: "offline" | "exhausted" | "failed" }
  | { kind: "pallet_failed" }
  | { kind: "label"; job: PrintJob }
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
export const SIGNAL_MS = 700;

/** A close again on `stale` (nothing was written: the box or the block changed meanwhile). */
async function closeSettled(close: () => Promise<CloseResult | null>): Promise<CloseResult | null> {
  let result = await close();
```

заменить на:

<!-- prettier-ignore -->
```tsx
export const SIGNAL_MS = 700;

/** A close again on `stale` (nothing was written: the box, the pallet or the block changed meanwhile). */
async function closeSettled<Result extends { kind: string }>(
  close: () => Promise<Result | null>,
): Promise<Result | null> {
  let result = await close();
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
  const [closing, setClosing] = useState(false);
  const capacity = shift.copy.boxCapacity;
  const plannedQty = shift.copy.plannedQty;

  // What a queued job reads when it runs, later than the render that queued it.
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const [closing, setClosing] = useState(false);
  // The shift's open pallet and what it holds (plan ПЛ-Ц).
  const [pallet, setPallet] = useState<OpenPallet | null>(null);
  // The open pallet is full but no pallet serial is here: it closes when they come.
  const [palletWaits, setPalletWaits] = useState(false);
  const capacity = shift.copy.boxCapacity;
  const plannedQty = shift.copy.plannedQty;
  const pallets = useMemo(() => shiftPallets(shift), [shift]);

  // What a queued job reads when it runs, later than the render that queued it.
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
    [local, where, shift, operator.name, render],
  );

  /** The label stop for `job` when it still waits, and the work goes on when it does not. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
    [local, where, shift, operator.name, render],
  );
  const palletContext = useMemo<PalletContext>(
    () => ({
      ...context,
      operatorName: operator.name,
      ...(render === undefined ? {} : { render }),
    }),
    [context, operator.name, render],
  );
  // A box of a shift with pallets joins the open pallet in its own close.
  const closeSteps = useMemo(
    () => (pallets === null ? [labelStep] : [labelStep, palletStep(palletContext, pallets)]),
    [labelStep, palletContext, pallets],
  );
  const palletSupply = useMemo(
    () =>
      createBlockSupply({
        local,
        pairing: where,
        issuerPrefix: shift.snapshot.issuerPrefix,
        extension: PALLET_EXTENSION,
        online: () => live.current.online,
        requestBlock,
        onHostError: (error) => live.current.onHostError(error),
        now: () => new Date(),
        newId: () => crypto.randomUUID(),
      }),
    [local, where, shift.snapshot.issuerPrefix, requestBlock],
  );

  /** The label stop for `job` when it still waits, and the work goes on when it does not. */
```

Фрагмент 8:

<!-- prettier-ignore -->
```tsx
  /**
   * What the shift's waiting label needs (stage 2a spec §5.7.5), on entry
   * and after every close: a job left `sending` by a stop of the app is
   * `unknown`; a `prepared` one — written with its box, never sent — goes
   * now (a first send, not a repeat); one that failed, is unknown or waits
   * for its check stops the work. Nothing here sends a label a second time.
   */
  const settleLabel = useCallback(async (): Promise<void> => {
    await recoverInterruptedJobs(printContext);
    let job = await readOpenJob(local, where, shift.copy.id);
    if (job?.state === "prepared") {
      if (alive.current) setSending(true);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  /**
   * What the shift's waiting labels need (stage 2a spec §5.7.5), on entry
   * and after every close: a job left `sending` by a stop of the app is
   * `unknown`; a `prepared` one — written with its box or pallet, never
   * sent — goes now (a first send, not a repeat), the box's before the
   * pallet's that its close filled (plan ПЛ-Ц); one that failed, is unknown
   * or waits for its check stops the work, and the next waits behind it.
   * Nothing here sends a label a second time.
   */
  const settleLabel = useCallback(async (): Promise<void> => {
    await recoverInterruptedJobs(printContext);
    let job = await readOpenJob(local, where, shift.copy.id);
    while (job?.state === "prepared") {
      if (alive.current) setSending(true);
```

Фрагмент 9:

<!-- prettier-ignore -->
```tsx
      live.current.onRecorded();
    }
```

заменить на:

<!-- prettier-ignore -->
```tsx
      live.current.onRecorded();
      if (isOpenJob(job)) break;
      job = await readOpenJob(local, where, shift.copy.id);
    }
```

Фрагмент 10:

<!-- prettier-ignore -->
```tsx
    const next = await readWorkTotals(local, where, shift.copy.id);
    if (alive.current) setTotals(next);
    return next;
  }, [local, where, shift.copy.id]);

  const show = useCallback((tone: SignalTone, title: string) => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
    const next = await readWorkTotals(local, where, shift.copy.id);
    const open = pallets === null ? null : await readOpenPallet(local, where, shift.copy.id);
    if (alive.current) {
      setTotals(next);
      setPallet(open);
    }
    return next;
  }, [local, where, shift.copy.id, pallets]);

  /**
   * A full pallet that waited for pallet serials closes once they are here
   * (plan ПЛ-Ц): after a box's close, on entry and when serials arrive, while
   * no label waits. Without them the screen says the pallet waits, and the
   * next boxes join it.
   */
  const settlePallet = useCallback(async (): Promise<void> => {
    if (pallets === null) return;
    let result = await closePalletIfFull(palletContext, pallets);
    if (result?.kind === "no_serials") {
      const supplied = await palletSupply.topUp();
      if (supplied.kind === "stored") {
        live.current.onRecorded();
        result = await closePalletIfFull(palletContext, pallets);
      }
    }
    if (alive.current) setPalletWaits(result?.kind === "no_serials");
    if (result?.kind === "closed") {
      live.current.onRecorded();
      await settleLabel();
    }
  }, [pallets, palletContext, palletSupply, settleLabel]);

  const show = useCallback((tone: SignalTone, title: string) => {
```

Фрагмент 11:

<!-- prettier-ignore -->
```tsx
      }
      const steps = [labelStep];
      const close = () => (full ? closeIfFull(context, steps) : closeOpenBox(context, steps));
```

заменить на:

<!-- prettier-ignore -->
```tsx
      }
      const steps = closeSteps;
      const close = () => (full ? closeIfFull(context, steps) : closeOpenBox(context, steps));
```

Фрагмент 12:

<!-- prettier-ignore -->
```tsx
        await settleLabel();
        // The half rule after every close: work of its own, not the line's.
        void live.current.track(supply.topUp()).then(
          (topped) => {
            if (topped.kind === "stored") live.current.onRecorded();
          },
          () => undefined,
        );
        return;
```

заменить на:

<!-- prettier-ignore -->
```tsx
        await settleLabel();
        if (stopRef.current === null) await settlePallet();
        // The half rule after every close: work of its own, not the line's.
        for (const blocks of pallets === null ? [supply] : [supply, palletSupply]) {
          void live.current.track(blocks.topUp()).then(
            (topped) => {
              if (topped.kind === "stored") live.current.onRecorded();
            },
            () => undefined,
          );
        }
        return;
```

Фрагмент 13:

<!-- prettier-ignore -->
```tsx
    },
    [local, where, shift.copy.id, settleLabel, labelStep, context, supply, setStop],
  );

  const settle = useCallback(
```

заменить на:

<!-- prettier-ignore -->
```tsx
    },
    [
      local,
      where,
      shift.copy.id,
      settleLabel,
      settlePallet,
      closeSteps,
      context,
      supply,
      palletSupply,
      pallets,
      setStop,
    ],
  );

  /**
   * «Закрыть паллету досрочно» (plan ПЛ-Ц): the open pallet closes with the
   * boxes it holds, after a label that waits; when the pallet serials ran
   * out the host is asked for a block and the close tried once more. What
   * is left stops the work with its reason. Answers whether it closed.
   */
  const closePallet = useCallback(async (): Promise<"closed" | "empty" | "stopped"> => {
    if (pallets === null) return "empty";
    if ((await readOpenJob(local, where, shift.copy.id)) !== null) {
      await settleLabel();
      return "stopped";
    }
    const close = () => closeOpenPallet(palletContext, pallets);
    let result = await closeSettled(close);
    let supplied: SupplyResult | null = null;
    if (result?.kind === "no_serials") {
      supplied = await palletSupply.topUp();
      if (supplied.kind === "stored") {
        live.current.onRecorded();
        result = await closeSettled(close);
      }
    }
    if (result === null || result.kind === "empty") return "empty";
    if (result.kind === "closed") {
      live.current.onRecorded();
      if (alive.current) setPalletWaits(false);
      await settleLabel();
      return "closed";
    }
    if (result.kind === "no_serials") {
      const reason =
        supplied === null || supplied.kind === "stored" || supplied.kind === "enough"
          ? "failed"
          : supplied.kind;
      setStop({ kind: "pallet_no_serials", reason });
      return "stopped";
    }
    setStop({ kind: "pallet_failed" });
    return "stopped";
  }, [pallets, local, where, shift.copy.id, settleLabel, palletContext, palletSupply, setStop]);

  const settle = useCallback(
```

Фрагмент 14:

<!-- prettier-ignore -->
```tsx
        showLabel(result.job);
        // A box a stop of the station left full closes now, with its label.
        if (stopRef.current === null) await closeBox(true);
        await refresh();
```

заменить на:

<!-- prettier-ignore -->
```tsx
        showLabel(result.job);
        // A box a stop of the station left full closes now, with its label;
        // so does a full pallet that waited.
        if (stopRef.current === null) await closeBox(true);
        if (stopRef.current === null) await settlePallet();
        await refresh();
```

Фрагмент 15:

<!-- prettier-ignore -->
```tsx
    },
    [printContext, settleLabel, show, showLabel, closeBox, refresh],
  );
```

заменить на:

<!-- prettier-ignore -->
```tsx
    },
    [printContext, settleLabel, show, showLabel, closeBox, settlePallet, refresh],
  );
```

Фрагмент 16:

<!-- prettier-ignore -->
```tsx
          if (stopRef.current === null) await closeBox(true);
        } catch (error) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
          if (stopRef.current === null) await closeBox(true);
          if (stopRef.current === null) await settlePallet();
        } catch (error) {
```

Фрагмент 17:

<!-- prettier-ignore -->
```tsx
    decide(async (job) => {
      const { boxTemplate } = shift.snapshot;
      const settings = await readWorkstationSettings(local);
      return printAgain(printContext, job, request, settings, boxTemplate, render);
    });
```

заменить на:

<!-- prettier-ignore -->
```tsx
    decide(async (job) => {
      // A pallet's label is rendered again from the snapshot's pallet layout (plan ПЛ-Ц).
      const template =
        job.purpose === "pallet" && pallets !== null
          ? pallets.template
          : shift.snapshot.boxTemplate;
      const settings = await readWorkstationSettings(local);
      return printAgain(printContext, job, request, settings, template, render);
    });
```

Фрагмент 18:

<!-- prettier-ignore -->
```tsx
        if (stopRef.current === null) await closeBox(true);
        await refresh();
```

заменить на:

<!-- prettier-ignore -->
```tsx
        if (stopRef.current === null) await closeBox(true);
        if (stopRef.current === null) await settlePallet();
        await refresh();
```

Фрагмент 19:

<!-- prettier-ignore -->
```tsx
  // On entry: the numbers, the label a stop of the station left waiting, and
  // a box it left full closes first.
  useEffect(() => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  // On entry: the numbers, the label a stop of the station left waiting, and
  // a box it left full closes first; then a pallet it left full.
  useEffect(() => {
```

Фрагмент 20:

<!-- prettier-ignore -->
```tsx
        await closeBox(true);
        await refresh();
      }),
    ).catch(() => setStop({ kind: "system_error" }));
  }, [track, queue, refresh, settleLabel, closeBox, setStop]);

  // On entry and whenever the link is back: serials by the half rule; a
```

заменить на:

<!-- prettier-ignore -->
```tsx
        await closeBox(true);
        if (stopRef.current === null) await settlePallet();
        await refresh();
      }),
    ).catch(() => setStop({ kind: "system_error" }));
  }, [track, queue, refresh, settleLabel, closeBox, settlePallet, setStop]);

  // On entry and whenever the link is back: serials by the half rule; a
```

Фрагмент 21:

<!-- prettier-ignore -->
```tsx
  }, [online, track, supply, queue, closeBox, refresh, setStop]);

  /** Runs a close as the line's next piece of work. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }, [online, track, supply, queue, closeBox, refresh, setStop]);

  // Pallet serials by the half rule on entry and when the link is back (plan
  // ПЛ-Ц); a pallet that waited for them closes, and a close that stopped for
  // them goes again.
  useEffect(() => {
    if (!online || pallets === null) return;
    void track(
      palletSupply.topUp().then(async (topped) => {
        if (topped.kind !== "stored") return;
        live.current.onRecorded();
        await live.current.track(
          queue.run(async () => {
            const waiting = stopRef.current;
            if (waiting?.kind === "pallet_no_serials") {
              setStop(null);
              await closePallet();
            } else if (waiting === null) {
              await settlePallet();
            }
            await refresh();
          }),
        );
      }),
    ).catch(() => setStop({ kind: "system_error" }));
  }, [online, pallets, track, palletSupply, queue, closePallet, settlePallet, refresh, setStop]);

  /** Runs a close as the line's next piece of work. */
```

Фрагмент 22:

<!-- prettier-ignore -->
```tsx
  };

  const openBox = totals?.openBox ?? null;
  const items = openBox?.itemCount ?? 0;
  const canClose = items > 0 && stop === null && !leaving;

  return (
```

заменить на:

<!-- prettier-ignore -->
```tsx
  };

  /** «Закрыть паллету» confirmed: the early close as the line's next piece of work. */
  const closePalletNow = () => {
    setStop(null);
    void track(
      queue.run(async () => {
        await closePallet();
        await refresh();
      }),
    ).catch(() => setStop({ kind: "system_error" }));
  };

  const openBox = totals?.openBox ?? null;
  const items = openBox?.itemCount ?? 0;
  const canClose = items > 0 && stop === null && !leaving;
  const palletBoxes = pallet?.boxCount ?? 0;

  return (
```

Фрагмент 23:

<!-- prettier-ignore -->
```tsx
          </div>
          {totals !== null && totals.lastSscc !== null && (
```

заменить на:

<!-- prettier-ignore -->
```tsx
          </div>
          {pallets !== null && (
            <div>
              <dt>{t("floor.work.pallet")}</dt>
              <dd>
                {t("floor.work.palletBoxes", {
                  quantity: formatQuantity(palletBoxes),
                  capacity: formatQuantity(pallets.capacity),
                })}
              </dd>
            </div>
          )}
          {totals !== null && totals.lastSscc !== null && (
```

Фрагмент 24:

<!-- prettier-ignore -->
```tsx
        </dl>
        <p className="work-screen__last" aria-live="polite">
```

заменить на:

<!-- prettier-ignore -->
```tsx
        </dl>
        {palletWaits && (
          <Alert tone="warn" title={t("floor.work.palletWaits.title")}>
            {t("floor.work.palletWaits.body")}
          </Alert>
        )}
        <p className="work-screen__last" aria-live="polite">
```

Фрагмент 25:

<!-- prettier-ignore -->
```tsx
            {t("floor.work.closeFailed.body")}
          </Alert>
```

заменить на:

<!-- prettier-ignore -->
```tsx
            {t("floor.work.closeFailed.body")}
          </Alert>
        )}
        {stop?.kind === "pallet_no_serials" && (
          <Alert
            tone="warn"
            title={t("floor.work.palletNoSerials.title")}
            action={
              <Button size="floor" variant="secondary" onClick={closePalletNow}>
                {t("floor.work.retry")}
              </Button>
            }
          >
            {t(`floor.work.palletNoSerials.${stop.reason}`)}
          </Alert>
        )}
        {stop?.kind === "pallet_failed" && (
          <Alert
            tone="error"
            title={t("floor.work.palletFailed.title")}
            action={
              <Button size="floor" variant="secondary" onClick={closePalletNow}>
                {t("floor.work.retry")}
              </Button>
            }
          >
            {t("floor.work.palletFailed.body")}
          </Alert>
```

Фрагмент 26:

<!-- prettier-ignore -->
```tsx
        )}
        {stop?.kind === "confirm_close" ? (
          <div className="work-screen__confirm">
```

заменить на:

<!-- prettier-ignore -->
```tsx
        )}
        {stop?.kind === "confirm_pallet" ? (
          <div className="work-screen__confirm">
            <p>
              {t("floor.work.confirmPallet", {
                quantity: formatQuantity(palletBoxes),
                capacity: formatQuantity(pallets?.capacity ?? 0),
              })}
            </p>
            <div className="standalone-form__actions">
              <Button size="floor" variant="secondary" onClick={() => setStop(null)}>
                {t("floor.work.keepPallet")}
              </Button>
              <Button size="floor" onClick={closePalletNow}>
                {t("floor.work.closePallet")}
              </Button>
            </div>
          </div>
        ) : stop?.kind === "confirm_close" ? (
          <div className="work-screen__confirm">
```

Фрагмент 27:

<!-- prettier-ignore -->
```tsx
              {t("floor.work.closeBox")}
            </Button>
            <Button
              size="floor"
```

заменить на:

<!-- prettier-ignore -->
```tsx
              {t("floor.work.closeBox")}
            </Button>
            {pallets !== null && (
              <Button
                size="floor"
                variant="secondary"
                disabled={palletBoxes === 0 || stop !== null || leaving}
                onClick={() => setStop({ kind: "confirm_pallet" })}
              >
                {t("floor.work.closePalletEarly")}
              </Button>
            )}
            <Button
              size="floor"
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
      "lastSscc": "Последний короб",
      "waiting": "Отсканируйте код маркировки.",
```

заменить на:

<!-- prettier-ignore -->
```json
      "lastSscc": "Последний короб",
      "pallet": "Паллета",
      "palletBoxes": "{{quantity}} из {{capacity}} коробов",
      "palletWaits": {
        "title": "Паллета заполнена, но не закрыта",
        "body": "Нет номеров SSCC паллет: паллета закроется, как только они придут от хоста. Следующие короба встают на неё."
      },
      "palletNoSerials": {
        "title": "Нет номеров SSCC паллет: паллета не закрыта",
        "offline": "Номера выдаёт хост, а связи с ним нет. Паллета закроется, как только номера придут.",
        "exhausted": "Номера SSCC паллет префикса организации закончились. Обратитесь к администратору.",
        "failed": "Хост не выдал номера паллет. Повторите или обратитесь к администратору."
      },
      "palletFailed": {
        "title": "Паллета не закрыта",
        "body": "Номер SSCC паллеты из блока станции вне диапазона префикса и пропущен. Повторите закрытие."
      },
      "confirmPallet": "Закрыть паллету досрочно? На паллете {{quantity}} из {{capacity}} коробов.",
      "keepPallet": "Не закрывать",
      "closePallet": "Закрыть паллету",
      "closePalletEarly": "Закрыть паллету досрочно",
      "waiting": "Отсканируйте код маркировки.",
```

Фрагмент 2:

<!-- prettier-ignore -->
```json
      "sscc": "SSCC короба: {{sscc}}",
      "sending": "Этикетка отправлена на принтер…",
```

заменить на:

<!-- prettier-ignore -->
```json
      "sscc": "SSCC короба: {{sscc}}",
      "pallet": {
        "sscc": "SSCC паллеты: {{sscc}}",
        "failedTitle": "Этикетка паллеты не напечатана",
        "printerUnconfigured": "Принтер для паллет не назначен. Назначьте его в настройке рабочего места.",
        "checkBody": "Отсканируйте SSCC на этикетке паллеты.",
        "mismatch": "Это этикетка другой паллеты или короба: {{sscc}}.",
        "notSscc": "Это не код SSCC. Отсканируйте этикетку паллеты.",
        "skipBody": "Паллета уже закрыта. Её нужно будет промаркировать позже: этикетку можно перепечатать в «Исключениях»."
      },
      "sending": "Этикетка отправлена на принтер…",
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallets.test.tsx`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  5 passed (5)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  116 passed (116)`, `Tests  2700 passed (2700)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — после закрытия короба уходит только одна этикетка из двух.
В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      if (isOpenJob(job)) break;
      job = await readOpenJob(local, where, shift.copy.id);
```

заменить на:

<!-- prettier-ignore -->
```tsx
      break;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallets.test.tsx`
Expected: FAIL — «counts the boxes on the open pallet; the box that fills it closes it, and both labels print, the box's first», «stops on a pallet's label that did not print, says why in the pallet's words, and goes on without it».

М2 — «Закрыть паллету досрочно» доступна у пустой паллеты.
В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
                disabled={palletBoxes === 0 || stop !== null || leaving}
```

заменить на:

<!-- prettier-ignore -->
```tsx
                disabled={stop !== null || leaving}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallets.test.tsx`
Expected: FAIL — «closes the pallet early after a confirmation, and never an empty one».

М3 — закрытие короба на рабочем экране не присоединяет его к паллете.
В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    () => (pallets === null ? [labelStep] : [labelStep, palletStep(palletContext, pallets)]),
```

заменить на:

<!-- prettier-ignore -->
```tsx
    () => (pallets === null ? [labelStep] : [labelStep]),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallets.test.tsx`
Expected: FAIL — «counts the boxes on the open pallet; the box that fills it closes it, and both labels print, the box's first», «closes the pallet early after a confirmation, and never an empty one», «says a full pallet waits for pallet serials, takes the next boxes on it, and closes it once the link brings a block», «checks the box's label first and then the pallet's, each by its own SSCC, in the pallet's words», «stops on a pallet's label that did not print, says why in the pallet's words, and goes on without it».

М4 — панель этикетки паллеты говорит о коробе.
В `apps/standalone/src/floor/print/LabelPanel.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        <p>{t(pallet ? "floor.print.pallet.checkBody" : "floor.print.check.body")}</p>
```

заменить на:

<!-- prettier-ignore -->
```tsx
        <p>{t("floor.print.check.body")}</p>
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallets.test.tsx`
Expected: FAIL — «checks the box's label first and then the pallet's, each by its own SSCC, in the pallet's words».

М5 — при возвращении связи блок паллет не запрашивается.
В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    void track(
      palletSupply.topUp().then(async (topped) => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
    void track(
      supply.topUp().then(async (topped) => {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallets.test.tsx`
Expected: FAIL — «says a full pallet waits for pallet serials, takes the next boxes on it, and closes it once the link brings a block».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/print/LabelPanel.tsx apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-work-pallets.test.tsx apps/standalone/test/support/pallets.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-work-pallets.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/floor-work-pallets.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/print/LabelPanel.tsx apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-work-pallets.test.tsx apps/standalone/test/support/pallets.ts
git commit -m "feat(standalone): the work screen of a shift with pallets — the pallet's boxes, its early close, its label after the box's" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Закрытие смены с открытой паллетой — «На паллете N из M коробов — закрыть?», «Закрыть паллету и смену»

Сводка закрытия (`ShiftClosePanel`): при блокировке `open_pallet` сводка показывается целиком, с вопросом «На паллете N из M коробов — закрыть?», а кнопка становится «Закрыть паллету и смену». На рабочем экране это одна работа очереди: паллета закрывается (`closePallet`), её этикетка уходит, затем смена закрывается с выбранной причиной (`finishClose` — общий путь с «Подтвердить закрытие», с `openPalletGuard` в транзакции). Если этикетка паллеты ждёт проверки или решения, смена закрывается сама после её решения (`pendingClose`, как облачное `confirmShiftClosePallet`); нет номеров паллет — остановка с причиной, смена открыта. Пустая открытая паллета не мешает и номера не тратит.

**Files:**

- Modify: `apps/standalone/src/floor/close/ShiftClosePanel.tsx`, `apps/standalone/src/floor/work/WorkScreen.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-work-close-pallets.test.tsx` (Create)

**Interfaces:**

- Consumes: задачи 3 и 5 (`CloseBlocker.open_pallet`, `openPalletGuard`, `closePallet`); `ShiftClosePanel`, `closeShift` (план 2a8).
- Produces:
  - `ShiftClosePanelProps.palletCapacity?`, `onClosePallet?`; `finishClose(reason)`, `afterLabel()` рабочего экрана; ключи `floor.close.palletOpen`, `floor.close.confirmPallet`, `floor.close.blocked.open_pallet`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-work-close-pallets.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { buildSscc } from "@markiro/domain";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PALLET_EXTENSION } from "../src/floor/pallets/pallets.js";
import { saveWorkstationSettings } from "../src/floor/setup/workstation-settings.js";
import { km, PREFIX, rows } from "./support/floor-work.js";
import { palletStation, type PalletStation } from "./support/pallets.js";
import { printingSettings } from "./support/printing.js";
import { renderWork, type WorkHarness } from "./support/work-screen.js";

const PALLET_SSCC = buildSscc(PALLET_EXTENSION, PREFIX, 0);
const QUESTION = "На паллете 2 из 40 коробов — закрыть?";

function kinds(at: PalletStation): unknown[] {
  return rows(at.db, "SELECT kind FROM outbox WHERE kind <> 'scan' ORDER BY seq").map(
    (row) => row["kind"],
  );
}

function localState(at: PalletStation): unknown {
  return rows(at.db, "SELECT local_state FROM floor_shifts")[0]?.["local_state"];
}

/** Two boxes of one code each on the open pallet of 40; the close's summary open, its reason chosen. */
async function twoBoxesThenClose(at: PalletStation): Promise<WorkHarness> {
  const work = renderWork(at);
  await work.scanner.listening();
  await work.settled();
  await work.scan(km("A1"));
  await work.scan(km("A2"));
  await work.press("Закрыть смену");
  expect(await screen.findByText(QUESTION)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Производственный брак" }));
  return work;
}

describe("the close of a shift with an open pallet (plan ПЛ-Ц)", () => {
  it("asks «На паллете N из M коробов — закрыть?» and closes the pallet and then the shift with one press", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = await twoBoxesThenClose(at);
    expect(screen.queryByRole("button", { name: "Подтвердить закрытие" })).toBeNull();
    await work.press("Закрыть паллету и смену");
    expect(await screen.findByText("Смена OCT26-004 закрыта")).toBeTruthy();
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed", "shift_closed"]);
    expect(work.shell.sends.at(-1)?.text).toContain(PALLET_SSCC);
    expect(localState(at)).toBe("closing");
    const [closed] = rows(at.db, "SELECT payload FROM outbox WHERE kind = 'shift_closed'");
    expect(JSON.parse(String(closed?.["payload"]))).toMatchObject({
      data: { reasonCode: "production_defect", closedBoxCount: 2, actualQty: 2 },
    });
  });

  it("waits for the pallet's label to be checked, then closes the shift with the reason chosen", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.scan(km("A2"));
    // The pallet's label is to be checked: the setting is on by the time it prints.
    await saveWorkstationSettings(
      at.local,
      printingSettings({
        assignments: { box: "zebra", pallet: "zebra", duplicate: null },
        verifyPrintedLabel: true,
      }),
    );
    await work.press("Закрыть смену");
    expect(await screen.findByText(QUESTION)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Производственный брак" }));
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText("Отсканируйте SSCC на этикетке паллеты.")).toBeTruthy();
    expect(localState(at)).toBeNull();
    await work.scan(`(00)${PALLET_SSCC}`);
    expect(await screen.findByText("Смена OCT26-004 закрыта")).toBeTruthy();
    expect(kinds(at).slice(-3)).toEqual(["pallet_closed", "pallet_label", "shift_closed"]);
  });

  it("lets an open pallet with no box left not hold the close, and spends no serial on it", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    at.db.prepare("UPDATE floor_boxes SET disassembled_at = closed_at").run();
    at.db.prepare("DELETE FROM floor_codes").run();
    await work.press("Закрыть смену");
    expect(await screen.findByRole("button", { name: "Подтвердить закрытие" })).toBeTruthy();
    expect(screen.queryByText(/На паллете/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Производственный брак" }));
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText("Смена OCT26-004 закрыта")).toBeTruthy();
    expect(kinds(at)).toEqual(["box_closed", "shift_closed"]);
  });

  it("keeps the shift open and says why when no pallet serial is left", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, palletBlock: false });
    const work = await twoBoxesThenClose(at);
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText("Нет номеров SSCC паллет: паллета не закрыта")).toBeTruthy();
    expect(kinds(at)).toEqual(["box_closed", "box_closed"]);
    expect(localState(at)).toBeNull();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-close-pallets.test.tsx`
Expected: FAIL — `test/floor-work-close-pallets.test.tsx`: 3 из 4 (`Missing i18n key: translation:floor.close.blocked.open_pallet`); «lets an open pallet with no box left not hold the close, and spends no serial on it» проходит и до реализации — он охраняет то, что пустая паллета не мешает закрытию.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/floor/close/ShiftClosePanel.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  onBack: () => void;
}
```

заменить на:

<!-- prettier-ignore -->
```tsx
  onBack: () => void;
  /** Boxes per pallet of a shift with pallets (plan ПЛ-Ц); `null` — none. */
  palletCapacity?: number | null;
  /** «Закрыть паллету и смену»: the open pallet first, then the shift with this reason. */
  onClosePallet?: (reason: ShiftCloseReasonCode | null) => void;
}
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
 * back to the work, where both are resolved. When the plan is given and not
 * met, one of the domain's six reasons is chosen before «Закрыть смену».
 */
```

заменить на:

<!-- prettier-ignore -->
```tsx
 * back to the work, where both are resolved. When the plan is given and not
 * met, one of the domain's six reasons is chosen before «Закрыть смену». An
 * open pallet with boxes (plan ПЛ-Ц) asks «На паллете N из M коробов —
 * закрыть?» under the summary, and the close becomes «Закрыть паллету и
 * смену», as at the cloud station.
 */
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  onBack,
}: ShiftClosePanelProps) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  onBack,
  palletCapacity = null,
  onClosePallet,
}: ShiftClosePanelProps) {
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
    if (summary === null) return <p>{t("floor.close.loading")}</p>;
    if (summary.blocker !== null) {
      const { blocker } = summary;
```

заменить на:

<!-- prettier-ignore -->
```tsx
    if (summary === null) return <p>{t("floor.close.loading")}</p>;
    const openPallet = summary.blocker?.kind === "open_pallet" ? summary.blocker : null;
    if (summary.blocker !== null && (openPallet === null || onClosePallet === undefined)) {
      const { blocker } = summary;
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
              ? t("floor.close.blocked.open_box", { quantity: formatQuantity(blocker.items) })
              : t(`floor.close.blocked.${blocker.kind}`)}
          </p>
```

заменить на:

<!-- prettier-ignore -->
```tsx
              ? t("floor.close.blocked.open_box", { quantity: formatQuantity(blocker.items) })
              : blocker.kind === "open_pallet"
                ? t("floor.close.blocked.open_pallet", { quantity: formatQuantity(blocker.boxes) })
                : t(`floor.close.blocked.${blocker.kind}`)}
          </p>
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
        )}
        <div className="standalone-form__actions">
```

заменить на:

<!-- prettier-ignore -->
```tsx
        )}
        {openPallet !== null && (
          <p role="status">
            {t("floor.close.palletOpen", {
              quantity: formatQuantity(openPallet.boxes),
              capacity: formatQuantity(palletCapacity ?? 0),
            })}
          </p>
        )}
        <div className="standalone-form__actions">
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
            disabled={busy || (summary.reasonRequired && chosen === null)}
            onClick={() => onClose(chosen)}
          >
            {t("floor.close.confirm")}
          </Button>
```

заменить на:

<!-- prettier-ignore -->
```tsx
            disabled={busy || (summary.reasonRequired && chosen === null)}
            onClick={() =>
              openPallet !== null && onClosePallet !== undefined
                ? onClosePallet(chosen)
                : onClose(chosen)
            }
          >
            {t(openPallet === null ? "floor.close.confirm" : "floor.close.confirmPallet")}
          </Button>
```

Правка `apps/standalone/src/floor/work/WorkScreen.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  closePalletIfFull,
  PALLET_EXTENSION,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  closePalletIfFull,
  openPalletGuard,
  PALLET_EXTENSION,
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  const stopRef = useRef<Stop | null>(null);
  const setStop = useCallback((next: Stop | null) => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const stopRef = useRef<Stop | null>(null);
  // «Закрыть паллету и смену» waits for the pallet's label: the shift's
  // close goes, with this reason, once the label is decided (plan ПЛ-Ц).
  const pendingClose = useRef<{ reason: ShiftCloseReasonCode | null } | null>(null);
  const setStop = useCallback((next: Stop | null) => {
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  }, [pallets, local, where, shift.copy.id, settleLabel, palletContext, palletSupply, setStop]);

  const settle = useCallback(
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }, [pallets, local, where, shift.copy.id, settleLabel, palletContext, palletSupply, setStop]);

  /**
   * The shift's close itself (stage 2a spec §5.7.7): a local write that
   * needs no host, with the open pallet's check of plan ПЛ-Ц in its
   * transaction. A shift that changed since the summary shows the summary
   * again with why.
   */
  const finishClose = useCallback(
    async (reason: ShiftCloseReasonCode | null): Promise<void> => {
      const guards = pallets === null ? [] : [openPalletGuard(where, shift.copy.id)];
      const result = await closeShift(context, reason, guards);
      if (result.kind === "closed") {
        live.current.onRecorded();
        setStop({ kind: "closed", record: result.record });
        return;
      }
      const summary = await readCloseSummary(local, where, shift.copy.id);
      setStop({
        kind: "close",
        summary,
        note:
          result.kind === "reason_required" ? "reason" : result.kind === "stale" ? "stale" : null,
      });
    },
    [pallets, where, shift.copy.id, context, local, setStop],
  );

  /**
   * After a label is decided and nothing stops the work: a shift's close that
   * waited for its pallet's label goes now (plan ПЛ-Ц); otherwise a box a
   * stop of the station left full closes, then a full pallet that waited.
   */
  const afterLabel = useCallback(async (): Promise<void> => {
    if (stopRef.current !== null) return;
    const pending = pendingClose.current;
    if (pending !== null) {
      pendingClose.current = null;
      await finishClose(pending.reason);
      return;
    }
    await closeBox(true);
    if (stopRef.current === null) await settlePallet();
  }, [finishClose, closeBox, settlePallet]);

  const settle = useCallback(
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
        // A box a stop of the station left full closes now, with its label;
        // so does a full pallet that waited.
        if (stopRef.current === null) await closeBox(true);
        if (stopRef.current === null) await settlePallet();
        await refresh();
```

заменить на:

<!-- prettier-ignore -->
```tsx
        // A box a stop of the station left full closes now, with its label;
        // so does a full pallet that waited, or a shift's close that did.
        await afterLabel();
        await refresh();
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
    },
    [printContext, settleLabel, show, showLabel, closeBox, settlePallet, refresh],
  );
```

заменить на:

<!-- prettier-ignore -->
```tsx
    },
    [printContext, settleLabel, show, showLabel, afterLabel, refresh],
  );
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
          showLabel(job);
          if (stopRef.current === null) await closeBox(true);
          if (stopRef.current === null) await settlePallet();
        } catch (error) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
          showLabel(job);
          await afterLabel();
        } catch (error) {
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
   * The close itself, as the line's next piece of work, so no scan or box
   * of the queue is left behind it: a local write that needs no host. A
   * shift that changed since the summary, or a write that failed, shows the
   * summary again with why.
   */
```

заменить на:

<!-- prettier-ignore -->
```tsx
   * The close itself, as the line's next piece of work, so no scan or box
   * of the queue is left behind it (`finishClose`). A write that failed shows
   * the summary again with why.
   */
```

Фрагмент 8:

<!-- prettier-ignore -->
```tsx
        try {
          const result = await closeShift(context, reason);
          if (result.kind === "closed") {
            live.current.onRecorded();
            setStop({ kind: "closed", record: result.record });
            return;
          }
          const summary = await readCloseSummary(local, where, shift.copy.id);
          setStop({
            kind: "close",
            summary,
            note:
              result.kind === "reason_required"
                ? "reason"
                : result.kind === "stale"
                  ? "stale"
                  : null,
          });
        } catch {
```

заменить на:

<!-- prettier-ignore -->
```tsx
        try {
          await finishClose(reason);
        } catch {
          setStop({ ...before, note: "failed" });
        } finally {
          if (alive.current) setClosing(false);
        }
      }),
    ).catch(() => setStop({ kind: "system_error" }));
  };

  /**
   * «Закрыть паллету и смену» (plan ПЛ-Ц; the cloud station's
   * `confirmShiftClosePallet`), as the line's next piece of work: the open
   * pallet closes and its label goes, then the shift closes with the reason
   * chosen. A pallet label that waits — its check, a printer that failed —
   * stops the work first, and the shift's close follows once it is decided.
   * No pallet serial, or a serial out of range, stops the work with its
   * reason, and the shift stays open.
   */
  const confirmPalletClose = (reason: ShiftCloseReasonCode | null) => {
    const before = stopRef.current;
    if (before?.kind !== "close") return;
    setClosing(true);
    void track(
      queue.run(async () => {
        try {
          const closed = await closePallet();
          if (closed === "stopped") return;
          if (stopRef.current?.kind === "label") {
            pendingClose.current = { reason };
            return;
          }
          await finishClose(reason);
        } catch {
```

Фрагмент 9:

<!-- prettier-ignore -->
```tsx
            onClose={confirmClose}
            onBack={() => setStop(null)}
          />
        )}
```

заменить на:

<!-- prettier-ignore -->
```tsx
            onClose={confirmClose}
            onBack={() => setStop(null)}
            palletCapacity={pallets?.capacity ?? null}
            onClosePallet={confirmPalletClose}
          />
        )}
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
      "confirm": "Подтвердить закрытие",
      "back": "Назад к работе",
```

заменить на:

<!-- prettier-ignore -->
```json
      "confirm": "Подтвердить закрытие",
      "palletOpen": "На паллете {{quantity}} из {{capacity}} коробов — закрыть?",
      "confirmPallet": "Закрыть паллету и смену",
      "back": "Назад к работе",
```

Фрагмент 2:

<!-- prettier-ignore -->
```json
        "label": "Этикетка короба ещё ждёт решения. Решите её на рабочем экране, затем закройте смену.",
        "closed": "Смена уже закрыта на этой станции."
```

заменить на:

<!-- prettier-ignore -->
```json
        "label": "Этикетка короба ещё ждёт решения. Решите её на рабочем экране, затем закройте смену.",
        "open_pallet": "На открытой паллете {{quantity}} коробов. Сначала закройте её.",
        "closed": "Смена уже закрыта на этой станции."
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-close-pallets.test.tsx`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  4 passed (4)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  117 passed (117)`, `Tests  2704 passed (2704)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — «Закрыть паллету и смену» не закрывает смену после решения этикетки паллеты.
В `apps/standalone/src/floor/work/WorkScreen.tsx` удалить фрагмент

<!-- prettier-ignore -->
```tsx
            pendingClose.current = { reason };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-close-pallets.test.tsx`
Expected: FAIL — «waits for the pallet's label to be checked, then closes the shift with the reason chosen».

М2 — кнопка сводки при открытой паллете закрывает только смену.
В `apps/standalone/src/floor/close/ShiftClosePanel.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
              openPallet !== null && onClosePallet !== undefined
                ? onClosePallet(chosen)
                : onClose(chosen)
```

заменить на:

<!-- prettier-ignore -->
```tsx
              onClose(chosen)
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-close-pallets.test.tsx`
Expected: FAIL — «asks «На паллете N из M коробов — закрыть?» and closes the pallet and then the shift with one press», «waits for the pallet's label to be checked, then closes the shift with the reason chosen», «keeps the shift open and says why when no pallet serial is left».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/close/ShiftClosePanel.tsx apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-work-close-pallets.test.tsx`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-work-close-pallets.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/floor-work-close-pallets.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/close/ShiftClosePanel.tsx apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-work-close-pallets.test.tsx
git commit -m "feat(standalone): the close of a shift with an open pallet — «Закрыть паллету и смену»" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Исключения паллеты на рабочем экране — сканом этикетки или последними цифрами, с причиной

Экран исключений (`ExceptionFlow.tsx`, контракт 2a8): действия `pallet_reprint` и `pallet_disassemble` тем же механизмом выбора (скан этикетки через `registerScan`, последние цифры SSCC, `boxesByTail` — теперь обобщённый по `{ sscc }`), причины — те же списки, слова — то же поле; кнопки только у смены с паллетами (`pallets` не передан — их нет). Рабочий экран читает закрытые паллеты вместе с коробами (`Stop.exceptions.pallets`), отказ `PalletUnavailableError` — «паллеты больше нет», новая этикетка перепечатки, которая ждёт, сразу показывает свою панель.

**Files:**

- Modify: `apps/standalone/src/floor/exceptions/ExceptionFlow.tsx`, `apps/standalone/src/floor/work/WorkScreen.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-work-pallet-exceptions.test.tsx` (Create)

**Interfaces:**

- Consumes: задача 4 (`readClosedPallets`, `reprintPallet`, `disassemblePallet`, `PalletUnavailableError`); `ExceptionFlow`, `ExceptionOutcome` (план 2a8).
- Produces:
  - `ExceptionAction` += `pallet_reprint`, `pallet_disassemble`; `ExceptionFlowProps.pallets?`, `onPalletReprint?`, `onPalletDisassemble?`; `boxesByTail<Item extends { sscc }>`; ключи `floor.exceptions.*.pallet*`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-work-pallet-exceptions.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { buildSscc, formatSsccHri } from "@markiro/domain";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PALLET_EXTENSION } from "../src/floor/pallets/pallets.js";
import { km, PREFIX, rows } from "./support/floor-work.js";
import { palletStation, type PalletStation } from "./support/pallets.js";
import { printStation, renderedText, ZEBRA } from "./support/printing.js";
import { renderWork } from "./support/work-screen.js";

const FIRST_PALLET = buildSscc(PALLET_EXTENSION, PREFIX, 0);
const SECOND_PALLET = buildSscc(PALLET_EXTENSION, PREFIX, 1);
const FIRST_BOX = buildSscc(0, PREFIX, 1500);

function palletExceptions(at: PalletStation) {
  return rows(
    at.db,
    "SELECT kind, reason_code, reason_text FROM floor_pallet_exceptions ORDER BY occurred_at",
  );
}

/** A shift of one code to a box and one box to a pallet: each scan closes a box and its pallet. */
async function twoPallets(at: PalletStation) {
  const work = renderWork(at);
  await work.scanner.listening();
  await work.settled();
  await work.scan(km("A1"));
  await work.scan(km("A2"));
  await work.press("Исключения");
  await screen.findByRole("button", { name: "Расформировать паллету" });
  return work;
}

describe("the exceptions of a pallet on the work screen (plan ПЛ-Ц)", () => {
  it("takes apart a pallet chosen by a scan of its label, with a reason; its boxes stay closed", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await twoPallets(at);
    await work.press("Расформировать паллету");
    expect(screen.getByText("Какую паллету расформировать?")).toBeTruthy();
    await work.scan(km("A9"));
    expect(screen.getByText("Это не код SSCC. Отсканируйте этикетку паллеты.")).toBeTruthy();
    await work.scan(`]C100${FIRST_BOX}`);
    expect(screen.getByText("Паллеты с этим SSCC нет среди закрытых паллет смены.")).toBeTruthy();
    await work.scan(`]C100${FIRST_PALLET}`);
    expect(screen.getByText(`Паллета ${formatSsccHri(FIRST_PALLET)}`)).toBeTruthy();
    await work.press("Не тот товар");
    expect(screen.getByText("Расформировать паллету?")).toBeTruthy();
    await work.press("Расформировать");
    expect(
      await screen.findByText("Паллета расформирована, её короба остались закрытыми."),
    ).toBeTruthy();
    expect(palletExceptions(at)).toEqual([
      { kind: "disassemble", reason_code: "wrong_product", reason_text: null },
    ]);
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE disassembled_at IS NULL"),
    ).toEqual([{ n: 2 }]);
    // The scans of the choice were never journalled.
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 2 }]);
  });

  it("prints a pallet's label again, chosen by the last digits of its SSCC", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await twoPallets(at);
    await work.press("Перепечатать этикетку паллеты");
    const option = (sscc: string) => `${formatSsccHri(sscc)} · коробов: 1`;
    expect(screen.getByRole("button", { name: option(SECOND_PALLET) })).toBeTruthy();
    const pad = within(screen.getByRole("group", { name: "Последние цифры SSCC" }));
    for (const digit of FIRST_PALLET.slice(-2)) {
      fireEvent.click(pad.getByRole("button", { name: digit }));
    }
    expect(screen.queryByRole("button", { name: option(SECOND_PALLET) })).toBeNull();
    await work.press(option(FIRST_PALLET));
    await work.press("Замятие в принтере");
    expect(screen.getByText("Перепечатать этикетку паллеты?")).toBeTruthy();
    await work.press("Перепечатать");
    expect(await screen.findByText("Этикетка паллеты отправлена на принтер.")).toBeTruthy();
    expect(work.shell.sends.at(-1)).toEqual({
      target: ZEBRA.target,
      text: renderedText(ZEBRA, FIRST_PALLET, "100x150"),
    });
    expect(palletExceptions(at)).toEqual([
      { kind: "reprint", reason_code: "printer_jam", reason_text: null },
    ]);
  });

  it("offers no pallet's exception in a shift without pallets", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать короб" });
    expect(screen.queryByRole("button", { name: "Перепечатать этикетку паллеты" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Расформировать паллету" })).toBeNull();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallet-exceptions.test.tsx`
Expected: FAIL — `test/floor-work-pallet-exceptions.test.tsx`: 2 из 3 (`Unable to find role="button" and name "Расформировать паллету"`); «offers no pallet's exception in a shift without pallets» проходит и до реализации — охрана смены без паллет.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/floor/exceptions/ExceptionFlow.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
} from "./box-exceptions.js";

/** The four exceptions of a box (stage 2a spec §5.7.6). */
export type ExceptionAction = "undo" | "clear" | "reprint" | "disassemble";

/**
```

заменить на:

<!-- prettier-ignore -->
```tsx
} from "./box-exceptions.js";
import type { ClosedPallet } from "./pallet-exceptions.js";

/** The four exceptions of a box (stage 2a spec §5.7.6) and the two of a pallet (plan ПЛ-Ц). */
export type ExceptionAction =
  "undo" | "clear" | "reprint" | "disassemble" | "pallet_reprint" | "pallet_disassemble";

/**
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  | { kind: "failed" };

/** A reason of its action's list. */
type Reasoned =
  | { action: "reprint"; reason: ExceptionReason<ReprintReason> }
  | { action: "disassemble"; reason: ExceptionReason<DisassembleReason> };

type BoxAction = Reasoned["action"];

type Stage =
```

заменить на:

<!-- prettier-ignore -->
```tsx
  | { kind: "failed" };

/** A reason of its action's list: a pallet's lists are a box's (plan ПЛ-Х). */
type Reasoned =
  | { action: "reprint" | "pallet_reprint"; reason: ExceptionReason<ReprintReason> }
  | { action: "disassemble" | "pallet_disassemble"; reason: ExceptionReason<DisassembleReason> };

type BoxAction = Reasoned["action"];

/** What a reprint or a disassembly is done to: a closed box and its codes, or a closed pallet and its boxes. */
interface Subject {
  id: string;
  sscc: string;
  quantity: number;
}

/** An action on a closed pallet (plan ПЛ-Ц). */
function onPallet(action: BoxAction): boolean {
  return action === "pallet_reprint" || action === "pallet_disassemble";
}

/** The list of reasons, and of their words, an action takes. */
function reasonKind(action: BoxAction): "reprint" | "disassemble" {
  return action === "reprint" || action === "pallet_reprint" ? "reprint" : "disassemble";
}

type Stage =
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  | { kind: "target"; action: BoxAction; tail: string; note: "not_sscc" | "not_found" | null }
  | { kind: "reason"; action: BoxAction; box: ClosedBox }
  | { kind: "words"; action: BoxAction; box: ClosedBox; text: string; invalid: boolean }
  | { kind: "confirm"; box: ClosedBox; reasoned: Reasoned }
  | { kind: "applying" }
  | { kind: "result"; outcome: ExceptionOutcome };

/** The most boxes the list shows at once: more are found by the last digits of their SSCC. */
export const MAX_LISTED_BOXES = 12;

/** The boxes whose SSCC ends with `tail`, the first `MAX_LISTED_BOXES` of them, and how many more. */
export function boxesByTail(
  boxes: readonly ClosedBox[],
  tail: string,
): { shown: ClosedBox[]; hidden: number } {
  const matching = boxes.filter((box) => box.sscc.endsWith(tail));
```

заменить на:

<!-- prettier-ignore -->
```tsx
  | { kind: "target"; action: BoxAction; tail: string; note: "not_sscc" | "not_found" | null }
  | { kind: "reason"; action: BoxAction; box: Subject }
  | { kind: "words"; action: BoxAction; box: Subject; text: string; invalid: boolean }
  | { kind: "confirm"; box: Subject; reasoned: Reasoned }
  | { kind: "applying"; pallet: boolean }
  | { kind: "result"; outcome: ExceptionOutcome; pallet: boolean };

/** The most boxes the list shows at once: more are found by the last digits of their SSCC. */
export const MAX_LISTED_BOXES = 12;

/**
 * The boxes — or the pallets (plan ПЛ-Ц) — whose SSCC ends with `tail`, the
 * first `MAX_LISTED_BOXES` of them, and how many more.
 */
export function boxesByTail<Item extends { sscc: string }>(
  boxes: readonly Item[],
  tail: string,
): { shown: Item[]; hidden: number } {
  const matching = boxes.filter((box) => box.sscc.endsWith(tail));
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
    boxId: string,
    reason: ExceptionReason<DisassembleReason>,
```

заменить на:

<!-- prettier-ignore -->
```tsx
    boxId: string,
    reason: ExceptionReason<DisassembleReason>,
  ) => Promise<ExceptionOutcome>;
  /**
   * The shift's closed pallets not taken apart, the last first (plan ПЛ-Ц);
   * `null` while they are read; absent for a shift without pallets, which
   * offers no pallet's exception.
   */
  pallets?: readonly ClosedPallet[] | null;
  onPalletReprint?: (
    palletId: string,
    reason: ExceptionReason<ReprintReason>,
  ) => Promise<ExceptionOutcome>;
  onPalletDisassemble?: (
    palletId: string,
    reason: ExceptionReason<DisassembleReason>,
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
 * action runs as the line's next piece of work and says how it went. «Назад»
 * is there at every step but while an action writes.
 */
```

заменить на:

<!-- prettier-ignore -->
```tsx
 * action runs as the line's next piece of work and says how it went. «Назад»
 * is there at every step but while an action writes. A shift with pallets
 * (plan ПЛ-Ц) prints a closed pallet's label again and takes a closed pallet
 * apart the same way: chosen by a scan of its label or the last digits of
 * its SSCC, with a reason of the same lists.
 */
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
  onDisassemble,
  registerScan,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  onDisassemble,
  pallets,
  onPalletReprint,
  onPalletDisassemble,
  registerScan,
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
  }, []);
  // What a scan of the box choice reads when it lands.
  const current = useRef({ stage, boxes });
  useLayoutEffect(() => {
    current.current = { stage, boxes };
  });
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }, []);
  /** The closed boxes, or for a pallet's action the closed pallets, as subjects; `null` while read. */
  const subjects = (action: BoxAction): Subject[] | null => {
    if (onPallet(action)) {
      return pallets === undefined || pallets === null
        ? null
        : pallets.map((pallet) => ({
            id: pallet.id,
            sscc: pallet.sscc,
            quantity: pallet.boxCount,
          }));
    }
    return boxes === null
      ? null
      : boxes.map((box) => ({ id: box.id, sscc: box.sscc, quantity: box.itemCount }));
  };
  // What a scan of the box choice reads when it lands.
  const current = useRef({ stage, subjects });
  useLayoutEffect(() => {
    current.current = { stage, subjects };
  });
```

Фрагмент 8:

<!-- prettier-ignore -->
```tsx
      }
      const box = current.current.boxes?.find((candidate) => candidate.sscc === sscc);
      setStage(
```

заменить на:

<!-- prettier-ignore -->
```tsx
      }
      const box = current.current
        .subjects(now.action)
        ?.find((candidate) => candidate.sscc === sscc);
      setStage(
```

Фрагмент 9:

<!-- prettier-ignore -->
```tsx
  useEffect(() => () => onTextEntry(false), [onTextEntry]);

  const run = (work: () => Promise<ExceptionOutcome>) => {
    setStage({ kind: "applying" });
    work().then(
      (outcome) => {
        if (alive.current) setStage({ kind: "result", outcome });
      },
      () => {
        if (alive.current) setStage({ kind: "result", outcome: { kind: "failed" } });
      },
    );
  };

  const apply = (box: ClosedBox, reasoned: Reasoned) => {
    run(() =>
      reasoned.action === "reprint"
        ? onReprint(box.id, reasoned.reason)
        : onDisassemble(box.id, reasoned.reason),
    );
  };

  const pick = (action: BoxAction, box: ClosedBox, code: string, text: string | null) => {
    if (action === "reprint") {
      const reason = REPRINT_REASONS.find((candidate) => candidate === code);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  useEffect(() => () => onTextEntry(false), [onTextEntry]);

  const run = (work: () => Promise<ExceptionOutcome>, pallet = false) => {
    setStage({ kind: "applying", pallet });
    work().then(
      (outcome) => {
        if (alive.current) setStage({ kind: "result", outcome, pallet });
      },
      () => {
        if (alive.current) setStage({ kind: "result", outcome: { kind: "failed" }, pallet });
      },
    );
  };

  const apply = (box: Subject, reasoned: Reasoned) => {
    const missing = (): Promise<ExceptionOutcome> => Promise.resolve({ kind: "unavailable" });
    run(() => {
      switch (reasoned.action) {
        case "reprint":
          return onReprint(box.id, reasoned.reason);
        case "disassemble":
          return onDisassemble(box.id, reasoned.reason);
        case "pallet_reprint":
          return onPalletReprint?.(box.id, reasoned.reason) ?? missing();
        case "pallet_disassemble":
          return onPalletDisassemble?.(box.id, reasoned.reason) ?? missing();
      }
    }, onPallet(reasoned.action));
  };

  const pick = (action: BoxAction, box: Subject, code: string, text: string | null) => {
    if (action === "reprint" || action === "pallet_reprint") {
      const reason = REPRINT_REASONS.find((candidate) => candidate === code);
```

Фрагмент 10:

<!-- prettier-ignore -->
```tsx
        const closed = boxes ?? [];
        const nothing = openItems === 0 && boxes !== null && closed.length === 0;
        return (
```

заменить на:

<!-- prettier-ignore -->
```tsx
        const closed = boxes ?? [];
        const closedPallets = pallets ?? [];
        const nothing =
          openItems === 0 &&
          boxes !== null &&
          closed.length === 0 &&
          pallets !== null &&
          closedPallets.length === 0;
        return (
```

Фрагмент 11:

<!-- prettier-ignore -->
```tsx
                {t("floor.exceptions.actions.disassemble")}
              </Button>
            </div>
            <div className="standalone-form__actions">{back(null)}</div>
```

заменить на:

<!-- prettier-ignore -->
```tsx
                {t("floor.exceptions.actions.disassemble")}
              </Button>
              {pallets !== undefined && (
                <>
                  <Button
                    size="floor"
                    variant="secondary"
                    disabled={closedPallets.length === 0}
                    onClick={() =>
                      setStage({ kind: "target", action: "pallet_reprint", tail: "", note: null })
                    }
                  >
                    {t("floor.exceptions.actions.pallet_reprint")}
                  </Button>
                  <Button
                    size="floor"
                    variant="secondary"
                    disabled={closedPallets.length === 0}
                    onClick={() =>
                      setStage({
                        kind: "target",
                        action: "pallet_disassemble",
                        tail: "",
                        note: null,
                      })
                    }
                  >
                    {t("floor.exceptions.actions.pallet_disassemble")}
                  </Button>
                </>
              )}
            </div>
            <div className="standalone-form__actions">{back(null)}</div>
```

Фрагмент 12:

<!-- prettier-ignore -->
```tsx
      case "target": {
        const { shown, hidden } = boxesByTail(boxes ?? [], stage.tail);
        const type = (tail: string) => setStage({ ...stage, tail, note: null });
        return (
          <>
            <h4>{t(`floor.exceptions.target.title.${stage.action}`)}</h4>
            <p>{t("floor.exceptions.target.hint")}</p>
            {stage.note !== null && (
              <p role="alert">{t(`floor.exceptions.target.${stage.note}`)}</p>
            )}
            <p aria-live="polite">
```

заменить на:

<!-- prettier-ignore -->
```tsx
      case "target": {
        const listed = subjects(stage.action);
        const { shown, hidden } = boxesByTail(listed ?? [], stage.tail);
        const type = (tail: string) => setStage({ ...stage, tail, note: null });
        // A pallet's words: `floor.exceptions.target.pallet.*` (plan ПЛ-Ц).
        const words = onPallet(stage.action)
          ? "floor.exceptions.target.pallet"
          : "floor.exceptions.target";
        return (
          <>
            <h4>{t(`floor.exceptions.target.title.${stage.action}`)}</h4>
            <p>{t(`${words}.hint`)}</p>
            {stage.note !== null && <p role="alert">{t(`${words}.${stage.note}`)}</p>}
            <p aria-live="polite">
```

Фрагмент 13:

<!-- prettier-ignore -->
```tsx
            </div>
            {boxes === null ? (
              <p>{t("floor.exceptions.target.loading")}</p>
            ) : shown.length === 0 ? (
              <p>{t("floor.exceptions.target.nothing")}</p>
            ) : (
```

заменить на:

<!-- prettier-ignore -->
```tsx
            </div>
            {listed === null ? (
              <p>{t(`${words}.loading`)}</p>
            ) : shown.length === 0 ? (
              <p>{t(`${words}.nothing`)}</p>
            ) : (
```

Фрагмент 14:

<!-- prettier-ignore -->
```tsx
                  >
                    {t("floor.exceptions.target.box", {
                      sscc: formatSsccHri(box.sscc),
                      quantity: formatQuantity(box.itemCount),
                    })}
```

заменить на:

<!-- prettier-ignore -->
```tsx
                  >
                    {t(`${words}.box`, {
                      sscc: formatSsccHri(box.sscc),
                      quantity: formatQuantity(box.quantity),
                    })}
```

Фрагмент 15:

<!-- prettier-ignore -->
```tsx
            )}
            {hidden > 0 && (
              <p>{t("floor.exceptions.target.more", { number: formatQuantity(hidden) })}</p>
            )}
            <div className="standalone-form__actions">{back({ kind: "actions" })}</div>
```

заменить на:

<!-- prettier-ignore -->
```tsx
            )}
            {hidden > 0 && <p>{t(`${words}.more`, { number: formatQuantity(hidden) })}</p>}
            <div className="standalone-form__actions">{back({ kind: "actions" })}</div>
```

Фрагмент 16:

<!-- prettier-ignore -->
```tsx
      case "reason": {
        const reasons = stage.action === "reprint" ? REPRINT_REASONS : DISASSEMBLE_REASONS;
        return (
          <>
            <h4>{t("floor.exceptions.reason.title")}</h4>
            <p>{t("floor.exceptions.reason.box", { sscc: formatSsccHri(stage.box.sscc) })}</p>
            <div className="standalone-form__actions work-screen__reasons">
```

заменить на:

<!-- prettier-ignore -->
```tsx
      case "reason": {
        const kind = reasonKind(stage.action);
        const reasons = kind === "reprint" ? REPRINT_REASONS : DISASSEMBLE_REASONS;
        return (
          <>
            <h4>{t("floor.exceptions.reason.title")}</h4>
            <p>
              {t(
                onPallet(stage.action)
                  ? "floor.exceptions.reason.pallet"
                  : "floor.exceptions.reason.box",
                {
                  sscc: formatSsccHri(stage.box.sscc),
                },
              )}
            </p>
            <div className="standalone-form__actions work-screen__reasons">
```

Фрагмент 17:

<!-- prettier-ignore -->
```tsx
                >
                  {t(`floor.exceptions.reasons.${stage.action}.${code}`)}
                </Button>
```

заменить на:

<!-- prettier-ignore -->
```tsx
                >
                  {t(`floor.exceptions.reasons.${kind}.${code}`)}
                </Button>
```

Фрагмент 18:

<!-- prettier-ignore -->
```tsx
          <>
            <h4>{t(`floor.exceptions.reasons.${stage.action}.other`)}</h4>
            <Input
```

заменить на:

<!-- prettier-ignore -->
```tsx
          <>
            <h4>{t(`floor.exceptions.reasons.${reasonKind(stage.action)}.other`)}</h4>
            <Input
```

Фрагмент 19:

<!-- prettier-ignore -->
```tsx
        const { box, reasoned } = stage;
        const reasonText =
          reasoned.reason.text ??
          t(`floor.exceptions.reasons.${reasoned.action}.${reasoned.reason.code}`);
        return (
          <Alert
            tone={reasoned.action === "disassemble" ? "error" : "warn"}
            title={t(`floor.exceptions.confirm.${reasoned.action}.title`)}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        const { box, reasoned } = stage;
        const kind = reasonKind(reasoned.action);
        const reasonText =
          reasoned.reason.text ?? t(`floor.exceptions.reasons.${kind}.${reasoned.reason.code}`);
        return (
          <Alert
            tone={kind === "disassemble" ? "error" : "warn"}
            title={t(`floor.exceptions.confirm.${reasoned.action}.title`)}
```

Фрагмент 20:

<!-- prettier-ignore -->
```tsx
                sscc: formatSsccHri(box.sscc),
                quantity: formatQuantity(box.itemCount),
              })}
```

заменить на:

<!-- prettier-ignore -->
```tsx
                sscc: formatSsccHri(box.sscc),
                quantity: formatQuantity(box.quantity),
              })}
```

Фрагмент 21:

<!-- prettier-ignore -->
```tsx
                size="floor"
                variant={reasoned.action === "disassemble" ? "destructive" : "primary"}
                onClick={() => apply(box, reasoned)}
```

заменить на:

<!-- prettier-ignore -->
```tsx
                size="floor"
                variant={kind === "disassemble" ? "destructive" : "primary"}
                onClick={() => apply(box, reasoned)}
```

Фрагмент 22:

<!-- prettier-ignore -->
```tsx
        const done = outcome.kind === "done" || outcome.kind === "label";
        return (
```

заменить на:

<!-- prettier-ignore -->
```tsx
        const done = outcome.kind === "done" || outcome.kind === "label";
        // What a pallet's action could not do is said of the pallet (plan ПЛ-Ц).
        const palletWords =
          stage.pallet &&
          (outcome.kind === "stale" ||
            outcome.kind === "unavailable" ||
            outcome.kind === "label_waiting");
        return (
```

Фрагмент 23:

<!-- prettier-ignore -->
```tsx
                ? `floor.exceptions.result.done.${outcome.action}`
                : `floor.exceptions.result.${outcome.kind}`,
            )}
```

заменить на:

<!-- prettier-ignore -->
```tsx
                ? `floor.exceptions.result.done.${outcome.action}`
                : palletWords
                  ? `floor.exceptions.result.pallet.${outcome.kind}`
                  : `floor.exceptions.result.${outcome.kind}`,
            )}
```

Правка `apps/standalone/src/floor/work/WorkScreen.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { ExceptionFlow, type ExceptionOutcome } from "../exceptions/ExceptionFlow.js";
import {
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { ExceptionFlow, type ExceptionOutcome } from "../exceptions/ExceptionFlow.js";
import {
  disassemblePallet,
  PalletUnavailableError,
  readClosedPallets,
  reprintPallet,
  type ClosedPallet,
} from "../exceptions/pallet-exceptions.js";
import {
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  | { kind: "label"; job: PrintJob }
  | { kind: "exceptions"; boxes: readonly ClosedBox[] | null }
  | { kind: "close"; summary: CloseSummary | null; note: CloseNote | null }
```

заменить на:

<!-- prettier-ignore -->
```tsx
  | { kind: "label"; job: PrintJob }
  | {
      kind: "exceptions";
      boxes: readonly ClosedBox[] | null;
      /** The closed pallets of a shift with pallets (plan ПЛ-Ц); `null` while read or without. */
      pallets: readonly ClosedPallet[] | null;
    }
  | { kind: "close"; summary: CloseSummary | null; note: CloseNote | null }
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
function outcomeOf(error: unknown): ExceptionOutcome {
  if (error instanceof BoxUnavailableError) return { kind: "unavailable" };
  if (error instanceof LabelWaitingError) return { kind: "label_waiting" };
```

заменить на:

<!-- prettier-ignore -->
```tsx
function outcomeOf(error: unknown): ExceptionOutcome {
  if (error instanceof BoxUnavailableError || error instanceof PalletUnavailableError) {
    return { kind: "unavailable" };
  }
  if (error instanceof LabelWaitingError) return { kind: "label_waiting" };
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
    });

  /**
   * The exceptions, opened while nothing stops the work: the shift's closed
   * boxes are read as the line's next piece of work.
   */
  const openExceptions = () => {
    setStop({ kind: "exceptions", boxes: null });
    void track(
      queue.run(async () => {
        const boxes = await readClosedBoxes(local, where, shift.copy.id);
        if (stopRef.current?.kind === "exceptions") setStop({ kind: "exceptions", boxes });
      }),
```

заменить на:

<!-- prettier-ignore -->
```tsx
    });

  /** The shift's closed boxes and, with pallets, its closed pallets, as the exceptions list them. */
  const readClosed = async () => ({
    boxes: await readClosedBoxes(local, where, shift.copy.id),
    pallets: pallets === null ? null : await readClosedPallets(local, where, shift.copy.id),
  });

  /**
   * The exceptions, opened while nothing stops the work: the shift's closed
   * boxes (and pallets) are read as the line's next piece of work.
   */
  const openExceptions = () => {
    setStop({ kind: "exceptions", boxes: null, pallets: null });
    void track(
      queue.run(async () => {
        const closed = await readClosed();
        if (stopRef.current?.kind === "exceptions") setStop({ kind: "exceptions", ...closed });
      }),
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
        try {
          const boxes = await readClosedBoxes(local, where, shift.copy.id);
          if (stopRef.current?.kind === "exceptions") setStop({ kind: "exceptions", boxes });
          await refresh();
```

заменить на:

<!-- prettier-ignore -->
```tsx
        try {
          const closed = await readClosed();
          if (stopRef.current?.kind === "exceptions") setStop({ kind: "exceptions", ...closed });
          await refresh();
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
      return { kind: "done", action: "reprint" };
    });
```

заменить на:

<!-- prettier-ignore -->
```tsx
      return { kind: "done", action: "reprint" };
    });

  /** A closed pallet's label again with a reason (plan ПЛ-Ц): a new label that waits is decided at once. */
  const reprintThePallet = (palletId: string, reason: Parameters<typeof reprintPallet>[3]) =>
    exception(async () => {
      if (pallets === null) return { kind: "unavailable" };
      const settings = await readWorkstationSettings(local);
      const job = await reprintPallet(
        { ...printContext, shift },
        pallets,
        palletId,
        reason,
        settings,
        render,
      );
      if (isOpenJob(job)) {
        showLabel(job);
        return { kind: "label" };
      }
      return { kind: "done", action: "pallet_reprint" };
    });
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
            }
            registerScan={registerScan}
```

заменить на:

<!-- prettier-ignore -->
```tsx
            }
            {...(pallets === null
              ? {}
              : {
                  pallets: stop.pallets,
                  onPalletReprint: reprintThePallet,
                  onPalletDisassemble: (palletId, reason) =>
                    exception(async () => {
                      const result = await disassemblePallet(context, palletId, reason);
                      return result.kind === "done"
                        ? { kind: "done", action: "pallet_disassemble" }
                        : result;
                    }),
                })}
            registerScan={registerScan}
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
        "reprint": "Перепечатать этикетку",
        "disassemble": "Расформировать короб"
      },
      "target": {
        "title": {
          "reprint": "Какой короб перепечатать?",
          "disassemble": "Какой короб расформировать?"
        },
```

заменить на:

<!-- prettier-ignore -->
```json
        "reprint": "Перепечатать этикетку",
        "disassemble": "Расформировать короб",
        "pallet_reprint": "Перепечатать этикетку паллеты",
        "pallet_disassemble": "Расформировать паллету"
      },
      "target": {
        "title": {
          "reprint": "Какой короб перепечатать?",
          "disassemble": "Какой короб расформировать?",
          "pallet_reprint": "Какую паллету перепечатать?",
          "pallet_disassemble": "Какую паллету расформировать?"
        },
        "pallet": {
          "hint": "Отсканируйте этикетку паллеты или наберите последние цифры её SSCC.",
          "loading": "Читаем закрытые паллеты…",
          "nothing": "Нет закрытых паллет с такими цифрами.",
          "box": "{{sscc}} · коробов: {{quantity}}",
          "more": "Ещё паллет: {{number}}. Наберите больше цифр.",
          "not_sscc": "Это не код SSCC. Отсканируйте этикетку паллеты.",
          "not_found": "Паллеты с этим SSCC нет среди закрытых паллет смены."
        },
```

Фрагмент 2:

<!-- prettier-ignore -->
```json
        "title": "Укажите причину",
        "box": "Короб {{sscc}}"
      },
```

заменить на:

<!-- prettier-ignore -->
```json
        "title": "Укажите причину",
        "box": "Короб {{sscc}}",
        "pallet": "Паллета {{sscc}}"
      },
```

Фрагмент 3:

<!-- prettier-ignore -->
```json
          "action": "Расформировать"
        }
```

заменить на:

<!-- prettier-ignore -->
```json
          "action": "Расформировать"
        },
        "pallet_reprint": {
          "title": "Перепечатать этикетку паллеты?",
          "body": "Новая этикетка будет с тем же SSCC {{sscc}}: на паллете должна остаться одна.",
          "action": "Перепечатать"
        },
        "pallet_disassemble": {
          "title": "Расформировать паллету?",
          "body": "SSCC {{sscc}} больше не будет использован. Короба паллеты ({{quantity}}) останутся закрытыми, со своими кодами.",
          "action": "Расформировать"
        }
```

Фрагмент 4:

<!-- prettier-ignore -->
```json
          "reprint": "Этикетка отправлена на принтер.",
          "disassemble": "Короб расформирован, его коды свободны."
        },
```

заменить на:

<!-- prettier-ignore -->
```json
          "reprint": "Этикетка отправлена на принтер.",
          "disassemble": "Короб расформирован, его коды свободны.",
          "pallet_reprint": "Этикетка паллеты отправлена на принтер.",
          "pallet_disassemble": "Паллета расформирована, её короба остались закрытыми."
        },
        "pallet": {
          "stale": "Пока вы выбирали, паллета изменилась. Ничего не сделано — повторите.",
          "unavailable": "Этой паллеты больше нет среди закрытых паллет смены. Ничего не сделано.",
          "label_waiting": "Этикетка этой паллеты ещё ждёт решения на рабочем экране. Ничего не сделано."
        },
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallet-exceptions.test.tsx`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  3 passed (3)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  118 passed (118)`, `Tests  2707 passed (2707)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — скан на шаге выбора паллеты ищет среди коробов.
В `apps/standalone/src/floor/exceptions/ExceptionFlow.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        .subjects(now.action)
```

заменить на:

<!-- prettier-ignore -->
```tsx
        .subjects("reprint")
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallet-exceptions.test.tsx`
Expected: FAIL — «takes apart a pallet chosen by a scan of its label, with a reason; its boxes stay closed».

М2 — паллетные исключения предлагаются смене без паллет.
В `apps/standalone/src/floor/exceptions/ExceptionFlow.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
              {pallets !== undefined && (
```

заменить на:

<!-- prettier-ignore -->
```tsx
              {pallets !== null && (
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallet-exceptions.test.tsx`
Expected: FAIL — «offers no pallet's exception in a shift without pallets».

М3 — «Расформировать паллету» расформировывает короб.
В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
                      const result = await disassemblePallet(context, palletId, reason);
```

заменить на:

<!-- prettier-ignore -->
```tsx
                      const result = await disassembleBox(context, palletId, reason);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallet-exceptions.test.tsx`
Expected: FAIL — «takes apart a pallet chosen by a scan of its label, with a reason; its boxes stay closed».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/exceptions/ExceptionFlow.tsx apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-work-pallet-exceptions.test.tsx`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-work-pallet-exceptions.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/floor-work-pallet-exceptions.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/exceptions/ExceptionFlow.tsx apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-work-pallet-exceptions.test.tsx
git commit -m "feat(standalone): a pallet's exceptions on the work screen — by its label or the last digits, with a reason" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Новая смена на станции — «С паллетами» и шаблон паллеты

Новая смена (`NewShift.tsx`, `new-shift.ts`, спецификация пилота §6.2): для товара с вместимостью паллеты и хотя бы одним подходящим шаблоном паллеты — «С паллетами» / «Без паллет» (включено по умолчанию, допущение ВЦ1), «Коробов на паллете: N» (вместимость товара), шаблон паллеты по правилу решения 7 для назначения `pallet` (`suggestPalletTemplate`, `lib/box-template-choice.ts`) или выбором, когда правило оставляет несколько; «Создать и открыть» без выбранного шаблона паллеты недоступна. Отказ хоста `validation_failed` на `palletTemplateId` — свои слова.

**Files:**

- Modify: `apps/standalone/src/floor/shifts/NewShift.tsx`, `apps/standalone/src/floor/shifts/new-shift.ts`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/lib/box-template-choice.ts`
- Test: `apps/standalone/test/box-template-choice.test.ts` (Modify), `apps/standalone/test/floor-new-shift.test.tsx` (Modify)

**Interfaces:**

- Consumes: задача 1 (`deviceShiftCreate` с `pallets`); `readNewShiftChoices`, `createStationShift`, `NewShift` (план 2a5); `templateFitsSlot`.
- Produces:
  - `ShiftProduct.palletBoxCapacity`, `defaultPalletTemplateId`; `NewShiftChoices.palletTemplates`, `defaults.defaultPalletTemplateId`; `fittingPalletTemplates(product, templates)`; `CreateRefusal` += `pallet_template`;
  - `suggestPalletTemplate(product, templates, defaults)`, `PalletTemplateProduct`, `PalletTemplateDefaults` (`src/lib/box-template-choice.ts`; план О-Ф берёт его для офиса).

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/box-template-choice.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  suggestBoxTemplate,
  type BoxTemplateCandidate,
```

заменить на:

<!-- prettier-ignore -->
```ts
  suggestBoxTemplate,
  suggestPalletTemplate,
  type BoxTemplateCandidate,
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  });
});
```

заменить на:

<!-- prettier-ignore -->
```ts
  });
});

describe("the pallet template a new shift with pallets starts with (plan ПЛ-Ц)", () => {
  const pallet = (id: string, scope: Partial<BoxTemplateCandidate> = {}): BoxTemplateCandidate =>
    box(id, { purpose: "pallet", ...scope });
  const PALLETS = [
    pallet(PREFERRED),
    pallet(CATEGORY, { chzProductGroupCodes: [8] }),
    pallet(ORGANIZATION),
    box(OTHER),
  ];
  const PALLET_DEFAULTS = {
    defaultPalletTemplateId: ORGANIZATION,
    categories: [
      { chzProductGroupCode: 8, purpose: "box", templateId: OTHER },
      { chzProductGroupCode: 8, purpose: "pallet", templateId: CATEGORY },
    ],
  };

  it("takes the product's pallet preference, then its category's pallet default, then the organization's", () => {
    const milk = { chzProductGroupCode: 8, defaultPalletTemplateId: PREFERRED };
    expect(suggestPalletTemplate(milk, PALLETS, PALLET_DEFAULTS)).toBe(PREFERRED);
    expect(
      suggestPalletTemplate({ ...milk, defaultPalletTemplateId: null }, PALLETS, PALLET_DEFAULTS),
    ).toBe(CATEGORY);
    expect(
      suggestPalletTemplate(
        { chzProductGroupCode: 13, defaultPalletTemplateId: null },
        PALLETS,
        PALLET_DEFAULTS,
      ),
    ).toBe(ORGANIZATION);
  });

  it("never takes a box template, and leaves the choice when none fits", () => {
    const milk = { chzProductGroupCode: 8, defaultPalletTemplateId: OTHER };
    expect(
      suggestPalletTemplate(milk, [box(OTHER)], { defaultPalletTemplateId: OTHER, categories: [] }),
    ).toBeNull();
  });
});
```

Правка `apps/standalone/test/floor-new-shift.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
};

describe("a new shift on the station", () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
};

/** Two pallet templates for the milk's group (8) and one for another group (plan ПЛ-Ц). */
const PALLET_TEMPLATE = "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f";
const OTHER_PALLET_TEMPLATE = "d5e6f7a8-b9c0-4d1e-8f2a-3b4c5d6e7f8a";
function palletTemplate(id: string, name: string, codes: number[]): ChangeItem {
  return item("label_templates", id, 102, {
    name,
    purpose: "pallet",
    enabled: true,
    chzProductGroupCodes: codes,
    stock: false,
    spec: {
      widthMm: 100,
      heightMm: 150,
      dpi: 203,
      language: "zpl",
      elements: [
        { kind: "field", id: "boxes", xMm: 5, yMm: 5, field: "qty.boxes", fontSizePt: 24 },
      ],
    },
  });
}
const PALLET_COPIES = [
  ...CATALOG,
  palletTemplate(PALLET_TEMPLATE, "Паллета 100×150", [8]),
  palletTemplate("e6f7a8b9-c0d1-4e2f-9a3b-4c5d6e7f8a9b", "Паллета для воды", [13]),
];

describe("a new shift with pallets on the station (plan ПЛ-Ц)", () => {
  it("offers pallets for a product with boxes per pallet and a pallet template that fits, on, and sends them", async () => {
    const { handlers } = renderNew(await copiesOf(PALLET_COPIES));
    await chooseMilk();
    expect(screen.getByRole("button", { name: "С паллетами" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByText("Коробов на паллете: 40")).toBeTruthy();
    // One pallet template fits the milk's group: the rule leaves nothing to choose.
    expect(screen.getByText("Шаблон этикетки паллеты: Паллета 100×150")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toEqual({
      ...CREATED_BODY,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: PALLET_TEMPLATE,
    });
  });

  it("creates a shift without pallets once the operator turns them off", async () => {
    const { handlers } = renderNew(await copiesOf(PALLET_COPIES));
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Без паллет" }));
    expect(screen.queryByText("Коробов на паллете: 40")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toEqual(CREATED_BODY);
  });

  it("asks for the pallet template when several fit, and creates nothing until one is chosen", async () => {
    const { handlers } = renderNew(
      await copiesOf([
        ...PALLET_COPIES,
        palletTemplate(OTHER_PALLET_TEMPLATE, "Паллета 120×80", [8]),
      ]),
    );
    await chooseMilk();
    expect(screen.getByText("Выберите шаблон этикетки паллеты.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Создать и открыть" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Паллета 120×80" }));
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toMatchObject({
      palletTemplateId: OTHER_PALLET_TEMPLATE,
    });
  });

  it("offers no pallets for a product without boxes per pallet, or without a pallet template that fits", async () => {
    const local = await copiesOf(CATALOG);
    const first = renderNew(local);
    await chooseMilk();
    expect(screen.queryByRole("button", { name: "С паллетами" })).toBeNull();
    first.view.unmount();
    const noCapacity = item("products", MILK, 103, {
      gtin14: "04600682000013",
      name: "Молоко 3,2% 0,9 л",
      printName: "Молоко 3,2%",
      chzProductGroupCode: 8,
      boxCapacity: 12,
      palletBoxCapacity: null,
      shelfLifeDays: 10,
      defaultBoxTemplateId: MILK_TEMPLATE,
      defaultPalletTemplateId: null,
      archived: false,
      status: "active",
    });
    const { handlers } = renderNew(await copiesOf([...PALLET_COPIES, noCapacity]));
    await chooseMilk();
    expect(screen.queryByRole("button", { name: "С паллетами" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toEqual(CREATED_BODY);
  });

  it("says the host refused the pallet template", async () => {
    const refused = new HostError({
      kind: "api",
      code: "validation_failed",
      status: 400,
      message: "no",
      details: { field: "palletTemplateId" },
    });
    renderNew(await copiesOf(PALLET_COPIES), { create: async () => Promise.reject(refused) });
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    expect(
      await screen.findByText(
        "Шаблон этикетки паллеты больше не подходит товару. Выберите другой шаблон или обратитесь в офис.",
      ),
    ).toBeTruthy();
  });
});

describe("a new shift on the station", () => {
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/box-template-choice.test.ts test/floor-new-shift.test.tsx`
Expected: FAIL — `test/box-template-choice.test.ts`: 2 из 8 (`suggestPalletTemplate is not a function`); `test/floor-new-shift.test.tsx`: 4 из 25 (`Unable to find an accessible element with the role "button" and name "С паллетами"`); «offers no pallets for a product without boxes per pallet, or without a pallet template that fits» проходит и до реализации — охрана товара без паллет.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/floor/shifts/NewShift.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import type { DeviceShift, DeviceShiftCreate, EnteredShift } from "../../host/protocol.js";
import { suggestBoxTemplate } from "../../lib/box-template-choice.js";
import { civilToday, isKnownTimeZone } from "../../lib/civil-date.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { DeviceShift, DeviceShiftCreate, EnteredShift } from "../../host/protocol.js";
import { suggestBoxTemplate, suggestPalletTemplate } from "../../lib/box-template-choice.js";
import { civilToday, isKnownTimeZone } from "../../lib/civil-date.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  findScannedProduct,
  fittingTemplates,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  findScannedProduct,
  fittingPalletTemplates,
  fittingTemplates,
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
import { enterShift, type EntryRefusal } from "./shift-entry.js";
import { addCivilDays, formatCivilDate } from "./shift-text.js";

/** At most this many products answer a search by name. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { enterShift, type EntryRefusal } from "./shift-entry.js";
import { addCivilDays, formatCivilDate, formatQuantity } from "./shift-text.js";

/** At most this many products answer a search by name. */
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  boxCapacity: string;
}
```

заменить на:

<!-- prettier-ignore -->
```tsx
  boxCapacity: string;
  /** «С паллетами» (plan ПЛ-Ц): on by default when the product has boxes per pallet and a pallet template fits. */
  pallets: boolean;
  palletTemplateId: string | null;
  /** The rule chose the pallet template, or only one fits. */
  palletTemplateFixed: boolean;
}
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
 * rule leaves several; the production date, today in the organization's
 * zone; the plan, optional; the capacity from the product. It needs the host:
 * the host numbers the shift, then the station enters it at once. One
```

заменить на:

<!-- prettier-ignore -->
```tsx
 * rule leaves several; the production date, today in the organization's
 * zone; the plan, optional; the capacity from the product; and, for a product
 * with boxes per pallet and a pallet template that fits, «С паллетами» with
 * the pallet template by the same rule (plan ПЛ-Ц). It needs the host:
 * the host numbers the shift, then the station enters it at once. One
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
      const fixed = suggested ?? (fitting.length === 1 && only !== undefined ? only.id : null);
      setProblem(null);
```

заменить на:

<!-- prettier-ignore -->
```tsx
      const fixed = suggested ?? (fitting.length === 1 && only !== undefined ? only.id : null);
      const palletFitting = fittingPalletTemplates(product, ready.palletTemplates);
      const [onlyPallet] = palletFitting;
      const palletFixed =
        suggestPalletTemplate(product, ready.palletTemplates, ready.defaults) ??
        (palletFitting.length === 1 && onlyPallet !== undefined ? onlyPallet.id : null);
      setProblem(null);
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
          boxCapacity: product.boxCapacity === null ? "" : String(product.boxCapacity),
        },
```

заменить на:

<!-- prettier-ignore -->
```tsx
          boxCapacity: product.boxCapacity === null ? "" : String(product.boxCapacity),
          pallets: product.palletBoxCapacity !== null && palletFitting.length > 0,
          palletTemplateId: palletFixed,
          palletTemplateFixed: palletFixed !== null,
        },
```

Фрагмент 8:

<!-- prettier-ignore -->
```tsx
    if (running.current || form.templateId === null) return;
    const plan = plannedQtyRule.safeParse(form.plannedQty);
```

заменить на:

<!-- prettier-ignore -->
```tsx
    if (running.current || form.templateId === null) return;
    const palletCapacity = form.product.palletBoxCapacity;
    const palletTemplateId = form.palletTemplateId;
    if (form.pallets && (palletCapacity === null || palletTemplateId === null)) return;
    const plan = plannedQtyRule.safeParse(form.plannedQty);
```

Фрагмент 9:

<!-- prettier-ignore -->
```tsx
          plannedQty: toCount(plan.data),
        },
```

заменить на:

<!-- prettier-ignore -->
```tsx
          plannedQty: toCount(plan.data),
          ...(form.pallets && palletCapacity !== null && palletTemplateId !== null
            ? { pallets: { boxCapacity: palletCapacity, templateId: palletTemplateId } }
            : {}),
        },
```

Фрагмент 10:

<!-- prettier-ignore -->
```tsx
    const zoneKnown = from.timeZone !== null && isKnownTimeZone(from.timeZone);
    return (
```

заменить на:

<!-- prettier-ignore -->
```tsx
    const zoneKnown = from.timeZone !== null && isKnownTimeZone(from.timeZone);
    const palletFitting = fittingPalletTemplates(form.product, from.palletTemplates);
    const palletChosen =
      palletFitting.find((template) => template.id === form.palletTemplateId) ?? null;
    const palletCapacity = form.product.palletBoxCapacity;
    return (
```

Фрагмент 11:

<!-- prettier-ignore -->
```tsx
          </div>
        )}
```

заменить на:

<!-- prettier-ignore -->
```tsx
          </div>
        )}
        {palletCapacity !== null && palletFitting.length > 0 && (
          <div className="new-shift__choice" role="group" aria-label={t("floor.newShift.pallets")}>
            <Button
              size="floor"
              variant={form.pallets ? "secondary" : "primary"}
              aria-pressed={!form.pallets}
              disabled={busy !== null}
              onClick={() => update({ pallets: false })}
            >
              {t("floor.newShift.withoutPallets")}
            </Button>
            <Button
              size="floor"
              variant={form.pallets ? "primary" : "secondary"}
              aria-pressed={form.pallets}
              disabled={busy !== null}
              onClick={() => update({ pallets: true })}
            >
              {t("floor.newShift.withPallets")}
            </Button>
          </div>
        )}
        {form.pallets && palletCapacity !== null && (
          <>
            <p>
              {t("floor.newShift.palletCapacity", { quantity: formatQuantity(palletCapacity) })}
            </p>
            {form.palletTemplateFixed && palletChosen !== null ? (
              <p>{t("floor.newShift.palletTemplateChosen", { name: palletChosen.name })}</p>
            ) : (
              <div
                className="new-shift__choice"
                role="group"
                aria-label={t("floor.newShift.palletTemplate")}
              >
                {palletChosen === null && <p>{t("floor.newShift.palletTemplateChoose")}</p>}
                {palletFitting.map((template) => (
                  <Button
                    key={template.id}
                    size="floor"
                    variant={template.id === form.palletTemplateId ? "primary" : "secondary"}
                    aria-pressed={template.id === form.palletTemplateId}
                    disabled={busy !== null}
                    onClick={() => update({ palletTemplateId: template.id })}
                  >
                    {template.name}
                  </Button>
                ))}
              </div>
            )}
          </>
        )}
```

Фрагмент 12:

<!-- prettier-ignore -->
```tsx
            loading={busy !== null}
            disabled={!online || form.templateId === null}
            onClick={() => void submit(form)}
```

заменить на:

<!-- prettier-ignore -->
```tsx
            loading={busy !== null}
            disabled={
              !online ||
              form.templateId === null ||
              (form.pallets && form.palletTemplateId === null)
            }
            onClick={() => void submit(form)}
```

Правка `apps/standalone/src/floor/shifts/new-shift.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { deviceShiftCreate, type DeviceShiftInput } from "../../host/requests.js";
import type { BoxTemplateCandidate, BoxTemplateDefaults } from "../../lib/box-template-choice.js";
import { templateFitsSlot } from "../../lib/template-eligibility.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { deviceShiftCreate, type DeviceShiftInput } from "../../host/requests.js";
import type {
  BoxTemplateCandidate,
  BoxTemplateDefaults,
  PalletTemplateDefaults,
} from "../../lib/box-template-choice.js";
import { templateFitsSlot } from "../../lib/template-eligibility.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  defaultBoxTemplateId: string | null;
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  defaultBoxTemplateId: string | null;
  /** Boxes per pallet: a product without them offers no shift with pallets (plan ПЛ-Ц). */
  palletBoxCapacity: number | null;
  defaultPalletTemplateId: string | null;
}
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  templates: ShiftTemplate[];
  defaults: BoxTemplateDefaults;
  timeZone: string | null;
```

заменить на:

<!-- prettier-ignore -->
```ts
  templates: ShiftTemplate[];
  /** The pallet templates of the copies (plan ПЛ-Ц). */
  palletTemplates: ShiftTemplate[];
  defaults: BoxTemplateDefaults & PalletTemplateDefaults;
  timeZone: string | null;
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  box_capacity: z.number().nullable(),
  default_box_template_id: z.string().nullable(),
});
const templateRow = z.object({
```

заменить на:

<!-- prettier-ignore -->
```ts
  box_capacity: z.number().nullable(),
  default_box_template_id: z.string().nullable(),
  pallet_box_capacity: z.number().nullable(),
  default_pallet_template_id: z.string().nullable(),
});
const templateRow = z.object({
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
  default_box_template_id: z.string().nullable(),
});
```

заменить на:

<!-- prettier-ignore -->
```ts
  default_box_template_id: z.string().nullable(),
  default_pallet_template_id: z.string().nullable(),
});
```

Фрагмент 6:

<!-- prettier-ignore -->
```ts
 * has begun to fill them (`copiesReady`); `null` before that. Products in use
 * and not archived only, by name; box templates only (the rule of decision 7
 * reads them, `suggestBoxTemplate`), by name.
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
 * has begun to fill them (`copiesReady`); `null` before that. Products in use
 * and not archived only, by name; box templates (the rule of decision 7
 * reads them, `suggestBoxTemplate`) and pallet templates (plan ПЛ-Ц,
 * `suggestPalletTemplate`), by name.
 */
```

Фрагмент 7:

<!-- prettier-ignore -->
```ts
  const products = await local.query(
    "SELECT id, gtin14, name, chz_group_code, box_capacity, default_box_template_id " +
      "FROM ref_products WHERE status = 'active' AND archived = 0 ORDER BY name, id",
```

заменить на:

<!-- prettier-ignore -->
```ts
  const products = await local.query(
    "SELECT id, gtin14, name, chz_group_code, box_capacity, default_box_template_id, " +
      "pallet_box_capacity, default_pallet_template_id " +
      "FROM ref_products WHERE status = 'active' AND archived = 0 ORDER BY name, id",
```

Фрагмент 8:

<!-- prettier-ignore -->
```ts
    "SELECT id, name, purpose, enabled, category_codes FROM ref_templates " +
      "WHERE purpose = 'box' ORDER BY name, id",
    [],
```

заменить на:

<!-- prettier-ignore -->
```ts
    "SELECT id, name, purpose, enabled, category_codes FROM ref_templates " +
      "WHERE purpose IN ('box', 'pallet') ORDER BY name, id",
    [],
```

Фрагмент 9:

<!-- prettier-ignore -->
```ts
  const [org] = await local.query(
    "SELECT time_zone, default_box_template_id FROM ref_org",
    [],
```

заменить на:

<!-- prettier-ignore -->
```ts
  const [org] = await local.query(
    "SELECT time_zone, default_box_template_id, default_pallet_template_id FROM ref_org",
    [],
```

Фрагмент 10:

<!-- prettier-ignore -->
```ts
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
```

заменить на:

<!-- prettier-ignore -->
```ts
      defaultBoxTemplateId: row.default_box_template_id,
      palletBoxCapacity: row.pallet_box_capacity,
      defaultPalletTemplateId: row.default_pallet_template_id,
    })),
    templates: templates.filter((row) => row.purpose === "box").map(toTemplate),
    palletTemplates: templates.filter((row) => row.purpose === "pallet").map(toTemplate),
    defaults: {
      defaultBoxTemplateId: org?.default_box_template_id ?? null,
      defaultPalletTemplateId: org?.default_pallet_template_id ?? null,
      categories: categories.map((row) => ({
```

Фрагмент 11:

<!-- prettier-ignore -->
```ts
    timeZone: org?.time_zone ?? null,
  };
```

заменить на:

<!-- prettier-ignore -->
```ts
    timeZone: org?.time_zone ?? null,
  };
}

/** A template of the copies, with what decides whether it fits. */
function toTemplate(row: z.infer<typeof templateRow>): ShiftTemplate {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    enabled: row.enabled === 1,
    chzProductGroupCodes:
      row.category_codes === null ? null : codesSchema.parse(JSON.parse(row.category_codes)),
  };
```

Фрагмент 12:

<!-- prettier-ignore -->
```ts
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
```

заменить на:

<!-- prettier-ignore -->
```ts
}

/** The pallet templates that fit `product`'s group (`templates::fits`), in the copies' order (plan ПЛ-Ц). */
export function fittingPalletTemplates(
  product: ShiftProduct,
  templates: readonly ShiftTemplate[],
): ShiftTemplate[] {
  return templates.filter((template) =>
    templateFitsSlot(template, {
      purpose: "pallet",
      chzProductGroupCode: product.chzProductGroupCode,
    }),
  );
}

/**
 * Why the host did not create the shift: no answer (`no_link`), the product
 * was turned off or archived since the copies (`product_inactive`), the
 * template no longer fits it (`template`), nor the pallet template
 * (`pallet_template`, plan ПЛ-Ц), another field it refused (`invalid`), the
 * station has no line (`no_line`), or anything else (`failed`).
 */
export type CreateRefusal =
  | "no_link"
  | "product_inactive"
  | "template"
  | "pallet_template"
  | "invalid"
  | "no_line"
  | "failed";

export type CreateResult =
```

Фрагмент 13:

<!-- prettier-ignore -->
```ts
    if (error.code === "validation_failed") {
      return { kind: "refused", reason: error.field === "boxTemplateId" ? "template" : "invalid" };
    }
```

заменить на:

<!-- prettier-ignore -->
```ts
    if (error.code === "validation_failed") {
      if (error.field === "boxTemplateId") return { kind: "refused", reason: "template" };
      if (error.field === "palletTemplateId") return { kind: "refused", reason: "pallet_template" };
      return { kind: "refused", reason: "invalid" };
    }
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
      "noTemplate": "Для этого товара нет подходящего шаблона этикетки короба. Шаблоны настраивают в офисе.",
      "productionDate": "Дата производства",
```

заменить на:

<!-- prettier-ignore -->
```json
      "noTemplate": "Для этого товара нет подходящего шаблона этикетки короба. Шаблоны настраивают в офисе.",
      "pallets": "Паллеты",
      "withoutPallets": "Без паллет",
      "withPallets": "С паллетами",
      "palletCapacity": "Коробов на паллете: {{quantity}}",
      "palletTemplate": "Шаблон этикетки паллеты",
      "palletTemplateChosen": "Шаблон этикетки паллеты: {{name}}",
      "palletTemplateChoose": "Выберите шаблон этикетки паллеты.",
      "productionDate": "Дата производства",
```

Фрагмент 2:

<!-- prettier-ignore -->
```json
        "template": "Шаблон этикетки больше не подходит товару. Выберите другой шаблон или обратитесь в офис.",
        "invalid": "Хост не принял поля смены. Проверьте план и вместимость короба.",
```

заменить на:

<!-- prettier-ignore -->
```json
        "template": "Шаблон этикетки больше не подходит товару. Выберите другой шаблон или обратитесь в офис.",
        "pallet_template": "Шаблон этикетки паллеты больше не подходит товару. Выберите другой шаблон или обратитесь в офис.",
        "invalid": "Хост не принял поля смены. Проверьте план и вместимость короба.",
```

Правка `apps/standalone/src/lib/box-template-choice.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  return null;
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  return null;
}

/** What the pallet choice reads of a product: its group and its pallet template preference. */
export interface PalletTemplateProduct {
  chzProductGroupCode: number | null;
  defaultPalletTemplateId: string | null;
}

/** The defaults the pallet choice falls back on: the organization's pallet default and the categories'. */
export interface PalletTemplateDefaults {
  defaultPalletTemplateId: string | null;
  categories: readonly { chzProductGroupCode: number; purpose: string; templateId: string }[];
}

/**
 * The pallet template a new shift with pallets starts with (stage 2a spec,
 * decision 7, for the purpose `pallet`; pilot spec §6.2, plan ПЛ-Ц): the
 * product's pallet preference, then its category's pallet default, then the
 * organization's, the first that fits the product's group and is in
 * `templates`. `null` when none does: the person chooses.
 */
export function suggestPalletTemplate(
  product: PalletTemplateProduct,
  templates: readonly BoxTemplateCandidate[],
  defaults: PalletTemplateDefaults,
): string | null {
  const group = product.chzProductGroupCode;
  const categoryDefault =
    group === null
      ? undefined
      : defaults.categories.find(
          (entry) => entry.purpose === "pallet" && entry.chzProductGroupCode === group,
        )?.templateId;
  const candidates = [
    product.defaultPalletTemplateId,
    categoryDefault ?? null,
    defaults.defaultPalletTemplateId,
  ];
  for (const id of candidates) {
    if (id === null) continue;
    const template = templates.find((each) => each.id === id);
    if (
      template !== undefined &&
      templateFitsSlot(template, { purpose: "pallet", chzProductGroupCode: group })
    ) {
      return id;
    }
  }
  return null;
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/box-template-choice.test.ts test/floor-new-shift.test.tsx`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  33 passed (33)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  118 passed (118)`, `Tests  2714 passed (2714)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — «С паллетами» выключено по умолчанию.
В `apps/standalone/src/floor/shifts/NewShift.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
          pallets: product.palletBoxCapacity !== null && palletFitting.length > 0,
```

заменить на:

<!-- prettier-ignore -->
```tsx
          pallets: false,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-new-shift.test.tsx`
Expected: FAIL — «offers pallets for a product with boxes per pallet and a pallet template that fits, on, and sends them», «asks for the pallet template when several fit, and creates nothing until one is chosen».

М2 — умолчание категории для паллеты берётся и от шаблона короба.
В `apps/standalone/src/lib/box-template-choice.ts` фрагмент

<!-- prettier-ignore -->
```ts
          (entry) => entry.purpose === "pallet" && entry.chzProductGroupCode === group,
```

заменить на:

<!-- prettier-ignore -->
```ts
          (entry) => entry.chzProductGroupCode === group,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/box-template-choice.test.ts`
Expected: FAIL — «takes the product's pallet preference, then its category's pallet default, then the organization's».

М3 — отказ хоста в шаблоне паллеты не называется.
В `apps/standalone/src/floor/shifts/new-shift.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
      if (error.field === "palletTemplateId") return { kind: "refused", reason: "pallet_template" };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-new-shift.test.tsx`
Expected: FAIL — «says the host refused the pallet template».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/shifts/NewShift.tsx apps/standalone/src/floor/shifts/new-shift.ts apps/standalone/src/i18n/ru.json apps/standalone/src/lib/box-template-choice.ts apps/standalone/test/box-template-choice.test.ts apps/standalone/test/floor-new-shift.test.tsx`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-new-shift.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/floor-new-shift.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/shifts/NewShift.tsx apps/standalone/src/floor/shifts/new-shift.ts apps/standalone/src/i18n/ru.json apps/standalone/src/lib/box-template-choice.ts apps/standalone/test/box-template-choice.test.ts apps/standalone/test/floor-new-shift.test.tsx
git commit -m "feat(standalone): a new shift on the station with pallets and its pallet template" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Сквозной сценарий со сменой с паллетами — фикстура заново, сверка хостом паллет

Сквозной сценарий плана 2a8 становится сменой с паллетами по две коробки (контракт 2a8): короба встают на паллету, второй короб закрывает её той же транзакцией, обе этикетки печатаются и проверяются; перепечатка этикетки паллеты с причиной; третий короб открывает вторую паллету, «Закрыть паллету и смену» закрывает её досрочно с этикеткой, затем она расформировывается, и смена закрывается с проверкой открытой паллеты. Фикстура `proto/fixtures/floor-scenario.json` перестраивается тем же сценарием (временная запись вместо сравнения, не коммитится); `station` получает `palletBlockId` и `closedPallets`. `host/tests/floor_scenario.rs` открывает смену с паллетами, получает и блок паллет (40–239), подставляет его `id` и сверяет итоги `closedPallets`/`openPallets` и паллеты хоста (серия, `box_count_reported`, короба, расформирование).

**Files:**

- Test: `apps/standalone/host/tests/floor_scenario.rs` (Modify), `apps/standalone/proto/fixtures/floor-scenario.json` (Modify), `apps/standalone/test/floor-scenario.test.ts` (Modify)

**Interfaces:**

- Consumes: всё задач 1–8; опоры хоста ПЛ-Х `open_pallet_floor`, `issue_pallet_block` (`host/tests/support/app.rs`).
- Produces:
  - фикстура `proto/fixtures/floor-scenario.json` со сменой с паллетами (`station { shiftId, blockId, palletBlockId, acceptedUnits, closedBoxes, closedPallets }`).

- [ ] **Step 1: Сценарий со сменой с паллетами и тест хоста**

Правка `apps/standalone/test/floor-scenario.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
} from "../src/floor/exceptions/box-exceptions.js";
import {
```

заменить на:

<!-- prettier-ignore -->
```ts
} from "../src/floor/exceptions/box-exceptions.js";
import { disassemblePallet, reprintPallet } from "../src/floor/exceptions/pallet-exceptions.js";
import {
  closeOpenPallet,
  openPalletGuard,
  palletStep,
  shiftPallets,
  type PalletContext,
} from "../src/floor/pallets/pallets.js";
import {
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  countingIds,
  ENTERED,
  enteredShift,
```

заменить на:

<!-- prettier-ignore -->
```ts
  countingIds,
  enteredShift,
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
import { openLocalDb } from "./support/local-db.js";
import { fakeRender, manualRuntime, setUpPrinting } from "./support/printing.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { openLocalDb } from "./support/local-db.js";
import { PALLET_BLOCK, PALLETS_ENTERED } from "./support/pallets.js";
import { fakeRender, manualRuntime, setUpPrinting } from "./support/printing.js";
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
const BLOCK = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";

/** How a send of the outbox ended: the host's receipts, no host at all, or an answer lost on its way back. */
```

заменить на:

<!-- prettier-ignore -->
```ts
const BLOCK = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
/** The pallet block it holds (plan ПЛ-Ц): the host's first pallet block of a new site, 40–239. */
const PALLET_FROM = 40;
const PALLET_TO = 239;

/** How a send of the outbox ended: the host's receipts, no host at all, or an answer lost on its way back. */
```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
 * the same batches to the host's router and checks that it takes every
 * record and ends with the same numbers.
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
 * the same batches to the host's router and checks that it takes every
 * record and ends with the same numbers. The shift has pallets (plan ПЛ-Ц):
 * the station's pallet block and its closed pallets are named too.
 */
```

Фрагмент 6:

<!-- prettier-ignore -->
```ts
    blockId: z.string(),
    acceptedUnits: z.number(),
    closedBoxes: z.number(),
  }),
```

заменить на:

<!-- prettier-ignore -->
```ts
    blockId: z.string(),
    palletBlockId: z.string(),
    acceptedUnits: z.number(),
    closedBoxes: z.number(),
    closedPallets: z.number(),
  }),
```

Фрагмент 7:

<!-- prettier-ignore -->
```ts
/**
 * One shift on one PC, with a stepping clock and counting ids so that it
 * writes the same records every time: three codes fill a box, whose label
 * is printed and checked, and the outbox goes to the host. Then the host is
 * away: two codes, the last one taken out and scanned again, the box
 * cleared; three more codes fill it, its label printed and checked; the
 * first box taken apart; the second box's label printed again with a
 * reason, and checked; two of the freed codes in a third box, closed
 * incomplete with its label; the shift closed with a reason — all on this
 * station alone. The host comes back: a send that finds no host, one whose
 * answer is lost, and one that is answered.
 */
async function runScenario() {
  const { db, executor: local } = openLocalDb();
  const shift = await enteredShift(local, { ...ENTERED, boxCapacity: 3 });
  seedBlock(db, { blockId: BLOCK, from: 1500, to: 3499 });
  const settings = await setUpPrinting(local, { verifyPrintedLabel: true });
  const now = steppingClock();
  const newId = countingIds();
  const context = scanContext(local, shift, { now, newId });
  const { runtime } = manualRuntime(fakeHardware().hardware);
```

заменить на:

<!-- prettier-ignore -->
```ts
/**
 * One shift with pallets of two boxes on one PC, with a stepping clock and
 * counting ids so that it writes the same records every time: three codes
 * fill a box, which opens a pallet, whose label is printed and checked, and
 * the outbox goes to the host. Then the host is away: two codes, the last
 * one taken out and scanned again, the box cleared; three more codes fill
 * it, it fills the pallet, which closes with it, and both labels are printed
 * and checked; the first box taken apart; the second box's label printed
 * again with a reason, and checked; the pallet's label printed again with a
 * reason, and checked; two of the freed codes in a third box, closed
 * incomplete with its label, on a second pallet; «Закрыть паллету и смену»:
 * the second pallet closed early with its label, then taken apart, and the
 * shift closed with a reason — all on this station alone. The host comes
 * back: a send that finds no host, one whose answer is lost, and one that
 * is answered.
 */
async function runScenario() {
  const { db, executor: local } = openLocalDb();
  const shift = await enteredShift(local, {
    ...PALLETS_ENTERED,
    boxCapacity: 3,
    palletBoxCapacity: 2,
  });
  const pallets = shiftPallets(shift);
  if (pallets === null) throw new Error("the shift has no pallets");
  seedBlock(db, { blockId: BLOCK, from: 1500, to: 3499 });
  seedBlock(db, { blockId: PALLET_BLOCK, from: PALLET_FROM, to: PALLET_TO, extension: 1 });
  const settings = await setUpPrinting(local, {
    verifyPrintedLabel: true,
    assignments: { box: "zebra", pallet: "zebra", duplicate: null },
  });
  const now = steppingClock();
  const newId = countingIds();
  const context = scanContext(local, shift, { now, newId });
  const palletContext: PalletContext = {
    ...context,
    operatorName: "Анна Кузнецова",
    render: fakeRender,
  };
  const { runtime } = manualRuntime(fakeHardware().hardware);
```

Фрагмент 8:

<!-- prettier-ignore -->
```ts
  };
  const label = boxLabelStep({
    local,
    pairing: PAIRING,
    shift,
    operatorName: "Анна Кузнецова",
    newId,
    render: fakeRender,
  });
  const host = scenarioHost();
```

заменить на:

<!-- prettier-ignore -->
```ts
  };
  const steps = [
    boxLabelStep({
      local,
      pairing: PAIRING,
      shift,
      operatorName: "Анна Кузнецова",
      newId,
      render: fakeRender,
    }),
    palletStep(palletContext, pallets),
  ];
  const host = scenarioHost();
```

Фрагмент 9:

<!-- prettier-ignore -->
```ts
  };
  const scan = async (serial: string) => {
    const outcome = await processScan(context, km(serial));
    if (outcome.kind !== "accepted") throw new Error(`${serial}: ${outcome.kind}`);
    const closed = await closeIfFull(context, [label]);
    if (closed !== null) {
      if (closed.kind !== "closed") throw new Error(closed.kind);
      await printAndCheck(null);
    }
```

заменить на:

<!-- prettier-ignore -->
```ts
  };
  /** Every label that waits, the box's before its pallet's. */
  const printAndCheckAll = async () => {
    while ((await readOpenJob(local, PAIRING, shift.copy.id)) !== null) await printAndCheck(null);
  };
  const scan = async (serial: string) => {
    const outcome = await processScan(context, km(serial));
    if (outcome.kind !== "accepted") throw new Error(`${serial}: ${outcome.kind}`);
    const closed = await closeIfFull(context, steps);
    if (closed !== null) {
      if (closed.kind !== "closed") throw new Error(closed.kind);
      await printAndCheckAll();
    }
```

Фрагмент 10:

<!-- prettier-ignore -->
```ts
  await printAndCheck(reprinted);
  for (const serial of ["A1", "A2"]) await scan(serial);
  const third = await closeOpenBox(context, [label]);
  if (third.kind !== "closed") throw new Error(third.kind);
  await printAndCheck(null);
  expect(await closeShift(context, "production_order_changed")).toMatchObject({ kind: "closed" });

  host.answerNext("unreachable");
```

заменить на:

<!-- prettier-ignore -->
```ts
  await printAndCheck(reprinted);
  const [firstPallet] = rows(db, "SELECT id FROM floor_pallets WHERE serial = ?", PALLET_FROM);
  const reprintedPallet = await reprintPallet(
    print,
    pallets,
    String(firstPallet?.["id"]),
    { code: "unreadable_label", text: null },
    settings,
    fakeRender,
  );
  await printAndCheck(reprintedPallet);
  for (const serial of ["A1", "A2"]) await scan(serial);
  const third = await closeOpenBox(context, steps);
  if (third.kind !== "closed") throw new Error(third.kind);
  await printAndCheckAll();
  // «Закрыть паллету и смену»: the second pallet first, with its label.
  const secondPallet = await closeOpenPallet(palletContext, pallets);
  if (secondPallet.kind !== "closed") throw new Error(secondPallet.kind);
  await printAndCheckAll();
  expect(
    await disassemblePallet(context, secondPallet.pallet.palletId, {
      code: "other",
      text: "Собрана не на тот заказ",
    }),
  ).toMatchObject({ kind: "done" });
  expect(
    await closeShift(context, "production_order_changed", [
      openPalletGuard(PAIRING, shift.copy.id),
    ]),
  ).toMatchObject({ kind: "closed" });

  host.answerNext("unreachable");
```

Фрагмент 11:

<!-- prettier-ignore -->
```ts
  const totals = await readWorkTotals(local, PAIRING, shift.copy.id);
  const scenario: Scenario = {
    station: {
      shiftId: shift.copy.id,
      blockId: BLOCK,
      acceptedUnits: totals.accepted,
      closedBoxes: totals.closedBoxes,
    },
```

заменить на:

<!-- prettier-ignore -->
```ts
  const totals = await readWorkTotals(local, PAIRING, shift.copy.id);
  const [closedPallets] = rows(
    db,
    "SELECT count(*) AS n FROM floor_pallets WHERE closed_at IS NOT NULL AND disassembled_at IS NULL",
  );
  const scenario: Scenario = {
    station: {
      shiftId: shift.copy.id,
      blockId: BLOCK,
      palletBlockId: PALLET_BLOCK,
      acceptedUnits: totals.accepted,
      closedBoxes: totals.closedBoxes,
      closedPallets: Number(closedPallets?.["n"]),
    },
```

Фрагмент 12:

<!-- prettier-ignore -->
```ts
}

describe("one shift on one PC, from the first code to the close, with the host away", () => {
  it("writes the records of the shared scenario, sends them in its batches, and ends closed", async () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
}

describe("one shift with pallets on one PC, from the first code to the close, with the host away", () => {
  it("writes the records of the shared scenario, sends them in its batches, and ends closed", async () => {
```

Фрагмент 13:

<!-- prettier-ignore -->
```ts
      "box_closed",
      "box_label",
      "box_exception",
      "box_exception",
      "box_label",
      "scan",
      "scan",
      "box_closed",
      "box_label",
      "shift_closed",
```

заменить на:

<!-- prettier-ignore -->
```ts
      "box_closed",
      "pallet_closed",
      "box_label",
      "pallet_label",
      "box_exception",
      "box_exception",
      "box_label",
      "pallet_exception",
      "pallet_label",
      "scan",
      "scan",
      "box_closed",
      "box_label",
      "pallet_closed",
      "pallet_label",
      "pallet_exception",
      "shift_closed",
```

Правка `apps/standalone/host/tests/floor_scenario.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
//! with the station's numbers, the shift closed by the station and not late.

mod support;
```

заменить на:

<!-- prettier-ignore -->
```rust
//! with the station's numbers, the shift closed by the station and not late.
//! The shift has pallets (plan ПЛ-Ц): its boxes join pallets, a full pallet
//! closes with its last box, the second closes early and is taken apart.

mod support;
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
use support::app::{
    admin, close_from_office, fact_rows, issue_block, open_floor, send_facts, shift_setup, Admin,
    Floor,
};

/// The scenario, with the station's ids of the shift and of the block
/// replaced by the host's: the fixture was written by a station whose
/// shift and block the host never issued.
fn scenario(shift: &str, block: &str) -> Value {
    let path = format!(
```

заменить на:

<!-- prettier-ignore -->
```rust
use support::app::{
    admin, close_from_office, fact_rows, issue_block, issue_pallet_block, open_pallet_floor,
    send_facts, shift_setup, Admin, Floor,
};

/// The scenario, with the station's ids of the shift, of the block and of
/// the pallet block replaced by the host's: the fixture was written by a
/// station whose shift and blocks the host never issued.
fn scenario(shift: &str, block: &str, pallet_block: &str) -> Value {
    let path = format!(
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
    let station_block = raw["station"]["blockId"].as_str().unwrap().to_owned();
    serde_json::from_str(
        &text
            .replace(&station_shift, shift)
            .replace(&station_block, block),
    )
    .unwrap()
}

/// A station inside its open shift with the site's first block (1500–3499,
/// the serials of the scenario's boxes), and the scenario under the host's
/// ids.
async fn station() -> (Admin, Floor, Value) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(
```

заменить на:

<!-- prettier-ignore -->
```rust
    let station_block = raw["station"]["blockId"].as_str().unwrap().to_owned();
    let station_pallet_block = raw["station"]["palletBlockId"].as_str().unwrap().to_owned();
    serde_json::from_str(
        &text
            .replace(&station_shift, shift)
            .replace(&station_block, block)
            .replace(&station_pallet_block, pallet_block),
    )
    .unwrap()
}

/// A station inside its open shift with pallets, with the site's first
/// block (1500–3499, the serials of the scenario's boxes) and its first
/// pallet block (40–239, the serials of its pallets), and the scenario
/// under the host's ids.
async fn station() -> (Admin, Floor, Value) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
    );
    let scenario = scenario(&floor.shift, block["id"].as_str().unwrap());
    (admin, floor, scenario)
```

заменить на:

<!-- prettier-ignore -->
```rust
    );
    let pallets = issue_pallet_block(
        &admin.app,
        &floor.key,
        "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c",
    )
    .await;
    assert_eq!(
        (pallets["fromSerial"].clone(), pallets["toSerial"].clone()),
        (json!(40), json!(239))
    );
    let scenario = scenario(
        &floor.shift,
        block["id"].as_str().unwrap(),
        pallets["id"].as_str().unwrap(),
    );
    (admin, floor, scenario)
```

Фрагмент 5:

<!-- prettier-ignore -->
```rust
}

#[tokio::test]
async fn the_host_takes_every_record_of_the_stations_shift_once_and_ends_with_its_numbers() {
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// The pallets as the host keeps them: the serial, the boxes the station
/// counted at the close, how many of its boxes the host holds, and whether
/// it was taken apart.
async fn pallets(admin: &Admin) -> Vec<(i64, Option<i64>, i64, bool)> {
    let rows: Vec<(i64, Option<i64>, i64, Option<String>)> = sqlx::query_as(
        "SELECT p.serial, p.box_count_reported, \
         (SELECT count(*) FROM boxes b WHERE b.pallet_id = p.id), p.disassembled_at \
         FROM pallets p ORDER BY p.serial",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|(serial, reported, boxes, disassembled)| {
            (serial, reported, boxes, disassembled.is_some())
        })
        .collect()
}

#[tokio::test]
async fn the_host_takes_every_record_of_the_stations_shift_once_and_ends_with_its_numbers() {
```

Фрагмент 6:

<!-- prettier-ignore -->
```rust
            shift["totals"]["openBoxes"].clone(),
        ),
        (
            station["acceptedUnits"].clone(),
            station["closedBoxes"].clone(),
            json!(0)
```

заменить на:

<!-- prettier-ignore -->
```rust
            shift["totals"]["openBoxes"].clone(),
            shift["totals"]["closedPallets"].clone(),
            shift["totals"]["openPallets"].clone(),
        ),
        (
            station["acceptedUnits"].clone(),
            station["closedBoxes"].clone(),
            json!(0),
            station["closedPallets"].clone(),
            json!(0)
```

Фрагмент 7:

<!-- prettier-ignore -->
```rust
        ]
    );
```

заменить на:

<!-- prettier-ignore -->
```rust
        ]
    );
    // The first pallet closed with its second box and holds both (the first
    // box taken apart since); the second closed early with one box and was
    // taken apart (plan ПЛ-Ц).
    assert_eq!(
        pallets(&admin).await,
        vec![(40, Some(2), 2, false), (41, Some(1), 1, true)]
    );
```

- [ ] **Step 2: Фикстура заново — тем же сценарием**

Фикстура пишется модулями цеха, а не руками (контракт 2a8). Временно (не коммитить) в начале теста «writes the records of the shared scenario, sends them in its batches, and ends closed» файла `apps/standalone/test/floor-scenario.test.ts`, сразу после строки `const { db, scenario } = await runScenario();`, вставить:

<!-- prettier-ignore -->
```ts
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      new URL("../proto/fixtures/floor-scenario.json", testModuleUrl),
      JSON.stringify(scenario, null, 2) + "\n",
    );
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scenario.test.ts`; затем удалить вставку (`git diff apps/standalone/test/floor-scenario.test.ts` показывает только правки шага 1) и `node_modules/.bin/prettier --write apps/standalone/proto/fixtures/floor-scenario.json`
Expected: файл перезаписан; `shasum -a 256 apps/standalone/proto/fixtures/floor-scenario.json` — `7057d80658da2f2c7e865098509c593e3275ff472a30874c845515b0dc4ead08` (на копии плана). Ниже — те же правки фрагментами, для сверки: если хеш другой, расхождение с фрагментами — отклонение исполнения, разбирается до коммита.

Правка `apps/standalone/proto/fixtures/floor-scenario.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
    "blockId": "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
    "acceptedUnits": 5,
    "closedBoxes": 2
  },
```

заменить на:

<!-- prettier-ignore -->
```json
    "blockId": "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
    "palletBlockId": "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b",
    "acceptedUnits": 5,
    "closedBoxes": 2,
    "closedPallets": 1
  },
```

Фрагмент 2:

<!-- prettier-ignore -->
```json
    {
      "id": "00000000-0000-4000-8000-000000000006",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

заменить на:

<!-- prettier-ignore -->
```json
    {
      "id": "00000000-0000-4000-8000-000000000007",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

Фрагмент 3:

<!-- prettier-ignore -->
```json
        "itemCount": 3,
        "membershipDigest": "a8ac289180d9807b954190fd8f4a65f2c1609fad1589a284ce2d185b6ca5441a"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000007",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

заменить на:

<!-- prettier-ignore -->
```json
        "itemCount": 3,
        "membershipDigest": "a8ac289180d9807b954190fd8f4a65f2c1609fad1589a284ce2d185b6ca5441a",
        "palletId": "00000000-0000-4000-8000-000000000006"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000008",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

Фрагмент 4:

<!-- prettier-ignore -->
```json
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000008",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
```

заменить на:

<!-- prettier-ignore -->
```json
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000009",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
```

Фрагмент 5:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000009"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000010",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

заменить на:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000010"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000011",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

Фрагмент 6:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000009"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000011",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

заменить на:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000010"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000012",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

Фрагмент 7:

<!-- prettier-ignore -->
```json
        "exception": "undo",
        "boxId": "00000000-0000-4000-8000-000000000009",
        "codeHash": "59626d6dcb61bc482b987f7613a91607ca2cf4b9ba43763a45990107b76701d1",
```

заменить на:

<!-- prettier-ignore -->
```json
        "exception": "undo",
        "boxId": "00000000-0000-4000-8000-000000000010",
        "codeHash": "59626d6dcb61bc482b987f7613a91607ca2cf4b9ba43763a45990107b76701d1",
```

Фрагмент 8:

<!-- prettier-ignore -->
```json
    {
      "id": "00000000-0000-4000-8000-000000000013",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

заменить на:

<!-- prettier-ignore -->
```json
    {
      "id": "00000000-0000-4000-8000-000000000014",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

Фрагмент 9:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000009"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000014",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

заменить на:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000010"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000015",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

Фрагмент 10:

<!-- prettier-ignore -->
```json
        "exception": "clear",
        "boxId": "00000000-0000-4000-8000-000000000009",
        "codeHash": null,
```

заменить на:

<!-- prettier-ignore -->
```json
        "exception": "clear",
        "boxId": "00000000-0000-4000-8000-000000000010",
        "codeHash": null,
```

Фрагмент 11:

<!-- prettier-ignore -->
```json
    {
      "id": "00000000-0000-4000-8000-000000000016",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

заменить на:

<!-- prettier-ignore -->
```json
    {
      "id": "00000000-0000-4000-8000-000000000017",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

Фрагмент 12:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000009"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000017",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

заменить на:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000010"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000018",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

Фрагмент 13:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000009"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000018",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

заменить на:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000010"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000019",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

Фрагмент 14:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000009"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000020",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_closed",
      "data": {
        "boxId": "00000000-0000-4000-8000-000000000009",
        "sscc": "046006820000015017",
```

заменить на:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000010"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000023",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_closed",
      "data": {
        "boxId": "00000000-0000-4000-8000-000000000010",
        "sscc": "046006820000015017",
```

Фрагмент 15:

<!-- prettier-ignore -->
```json
        "itemCount": 3,
        "membershipDigest": "334a2cae4baf8c969aae3f80d30651f6179041c2479517f1b440442661f92d9a"
      }
```

заменить на:

<!-- prettier-ignore -->
```json
        "itemCount": 3,
        "membershipDigest": "334a2cae4baf8c969aae3f80d30651f6179041c2479517f1b440442661f92d9a",
        "palletId": "00000000-0000-4000-8000-000000000006"
      }
```

Фрагмент 16:

<!-- prettier-ignore -->
```json
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_label",
      "data": {
        "boxId": "00000000-0000-4000-8000-000000000009",
        "outcome": "verified",
        "at": "2026-10-08T06:15:20.000Z"
```

заменить на:

<!-- prettier-ignore -->
```json
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "pallet_closed",
      "data": {
        "palletId": "00000000-0000-4000-8000-000000000006",
        "sscc": "146006820000000409",
        "blockId": "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b",
        "serial": 40,
        "openedAt": "2026-10-08T06:15:03.000Z",
        "closedAt": "2026-10-08T06:15:17.000Z",
        "boxCount": 2
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000024",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_label",
      "data": {
        "boxId": "00000000-0000-4000-8000-000000000010",
        "outcome": "verified",
        "at": "2026-10-08T06:15:20.000Z"
```

Фрагмент 17:

<!-- prettier-ignore -->
```json
    {
      "id": "00000000-0000-4000-8000-000000000022",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

заменить на:

<!-- prettier-ignore -->
```json
    {
      "id": "00000000-0000-4000-8000-000000000025",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "pallet_label",
      "data": {
        "palletId": "00000000-0000-4000-8000-000000000006",
        "outcome": "verified",
        "at": "2026-10-08T06:15:23.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000026",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

Фрагмент 18:

<!-- prettier-ignore -->
```json
        "reasonText": null,
        "occurredAt": "2026-10-08T06:15:21.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000025",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

заменить на:

<!-- prettier-ignore -->
```json
        "reasonText": null,
        "occurredAt": "2026-10-08T06:15:24.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000029",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

Фрагмент 19:

<!-- prettier-ignore -->
```json
        "exception": "reprint",
        "boxId": "00000000-0000-4000-8000-000000000009",
        "codeHash": null,
        "targetScannedAt": null,
        "reasonCode": "damaged_label",
        "reasonText": null,
        "occurredAt": "2026-10-08T06:15:22.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000027",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_label",
      "data": {
        "boxId": "00000000-0000-4000-8000-000000000009",
        "outcome": "verified",
        "at": "2026-10-08T06:15:25.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000028",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
      "data": {
        "scannedAt": "2026-10-08T06:15:26.000Z",
        "verdict": "ok",
```

заменить на:

<!-- prettier-ignore -->
```json
        "exception": "reprint",
        "boxId": "00000000-0000-4000-8000-000000000010",
        "codeHash": null,
        "targetScannedAt": null,
        "reasonCode": "damaged_label",
        "reasonText": null,
        "occurredAt": "2026-10-08T06:15:25.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000031",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_label",
      "data": {
        "boxId": "00000000-0000-4000-8000-000000000010",
        "outcome": "verified",
        "at": "2026-10-08T06:15:28.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000033",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "pallet_exception",
      "data": {
        "exception": "reprint",
        "palletId": "00000000-0000-4000-8000-000000000006",
        "reasonCode": "unreadable_label",
        "reasonText": null,
        "occurredAt": "2026-10-08T06:15:29.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000035",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "pallet_label",
      "data": {
        "palletId": "00000000-0000-4000-8000-000000000006",
        "outcome": "verified",
        "at": "2026-10-08T06:15:32.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000036",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
      "data": {
        "scannedAt": "2026-10-08T06:15:33.000Z",
        "verdict": "ok",
```

Фрагмент 20:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000029"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000030",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
      "data": {
        "scannedAt": "2026-10-08T06:15:27.000Z",
        "verdict": "ok",
```

заменить на:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000037"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000038",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
      "data": {
        "scannedAt": "2026-10-08T06:15:34.000Z",
        "verdict": "ok",
```

Фрагмент 21:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000029"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000032",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_closed",
      "data": {
        "boxId": "00000000-0000-4000-8000-000000000029",
        "sscc": "046006820000015024",
        "blockId": "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
        "serial": 1502,
        "openedAt": "2026-10-08T06:15:26.000Z",
        "closedAt": "2026-10-08T06:15:28.000Z",
        "itemCount": 2,
        "membershipDigest": "ac427eae7f4f163914ad643791e99c98f575c405b6ab113e3e7a90e6f3308b7e"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000033",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_label",
      "data": {
        "boxId": "00000000-0000-4000-8000-000000000029",
        "outcome": "verified",
        "at": "2026-10-08T06:15:31.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000034",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

заменить на:

<!-- prettier-ignore -->
```json
        },
        "boxId": "00000000-0000-4000-8000-000000000037"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000041",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_closed",
      "data": {
        "boxId": "00000000-0000-4000-8000-000000000037",
        "sscc": "046006820000015024",
        "blockId": "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
        "serial": 1502,
        "openedAt": "2026-10-08T06:15:33.000Z",
        "closedAt": "2026-10-08T06:15:35.000Z",
        "itemCount": 2,
        "membershipDigest": "ac427eae7f4f163914ad643791e99c98f575c405b6ab113e3e7a90e6f3308b7e",
        "palletId": "00000000-0000-4000-8000-000000000040"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000042",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_label",
      "data": {
        "boxId": "00000000-0000-4000-8000-000000000037",
        "outcome": "verified",
        "at": "2026-10-08T06:15:38.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000043",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "pallet_closed",
      "data": {
        "palletId": "00000000-0000-4000-8000-000000000040",
        "sscc": "146006820000000416",
        "blockId": "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b",
        "serial": 41,
        "openedAt": "2026-10-08T06:15:35.000Z",
        "closedAt": "2026-10-08T06:15:39.000Z",
        "boxCount": 1
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000045",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "pallet_label",
      "data": {
        "palletId": "00000000-0000-4000-8000-000000000040",
        "outcome": "verified",
        "at": "2026-10-08T06:15:42.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000046",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "pallet_exception",
      "data": {
        "exception": "disassemble",
        "palletId": "00000000-0000-4000-8000-000000000040",
        "reasonCode": "other",
        "reasonText": "Собрана не на тот заказ",
        "occurredAt": "2026-10-08T06:15:43.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000048",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
```

Фрагмент 22:

<!-- prettier-ignore -->
```json
        "reasonCode": "production_order_changed",
        "closedAt": "2026-10-08T06:15:32.000Z"
      }
```

заменить на:

<!-- prettier-ignore -->
```json
        "reasonCode": "production_order_changed",
        "closedAt": "2026-10-08T06:15:44.000Z"
      }
```

Фрагмент 23:

<!-- prettier-ignore -->
```json
        "00000000-0000-4000-8000-000000000004",
        "00000000-0000-4000-8000-000000000006",
        "00000000-0000-4000-8000-000000000007"
      ],
```

заменить на:

<!-- prettier-ignore -->
```json
        "00000000-0000-4000-8000-000000000004",
        "00000000-0000-4000-8000-000000000007",
        "00000000-0000-4000-8000-000000000008"
      ],
```

Фрагмент 24:

<!-- prettier-ignore -->
```json
    {
      "ids": [
        "00000000-0000-4000-8000-000000000008",
        "00000000-0000-4000-8000-000000000010",
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000013",
        "00000000-0000-4000-8000-000000000014",
        "00000000-0000-4000-8000-000000000016",
        "00000000-0000-4000-8000-000000000017",
        "00000000-0000-4000-8000-000000000018",
        "00000000-0000-4000-8000-000000000020",
        "00000000-0000-4000-8000-000000000021",
        "00000000-0000-4000-8000-000000000022",
        "00000000-0000-4000-8000-000000000025",
        "00000000-0000-4000-8000-000000000027",
        "00000000-0000-4000-8000-000000000028",
        "00000000-0000-4000-8000-000000000030",
        "00000000-0000-4000-8000-000000000032",
        "00000000-0000-4000-8000-000000000033",
        "00000000-0000-4000-8000-000000000034"
      ],
      "answer": "unreachable"
```

заменить на:

<!-- prettier-ignore -->
```json
    {
      "ids": [
        "00000000-0000-4000-8000-000000000009",
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
        "00000000-0000-4000-8000-000000000014",
        "00000000-0000-4000-8000-000000000015",
        "00000000-0000-4000-8000-000000000017",
        "00000000-0000-4000-8000-000000000018",
        "00000000-0000-4000-8000-000000000019",
        "00000000-0000-4000-8000-000000000023",
        "00000000-0000-4000-8000-000000000021",
        "00000000-0000-4000-8000-000000000024",
        "00000000-0000-4000-8000-000000000025",
        "00000000-0000-4000-8000-000000000026",
        "00000000-0000-4000-8000-000000000029",
        "00000000-0000-4000-8000-000000000031",
        "00000000-0000-4000-8000-000000000033",
        "00000000-0000-4000-8000-000000000035",
        "00000000-0000-4000-8000-000000000036",
        "00000000-0000-4000-8000-000000000038",
        "00000000-0000-4000-8000-000000000041",
        "00000000-0000-4000-8000-000000000042",
        "00000000-0000-4000-8000-000000000043",
        "00000000-0000-4000-8000-000000000045",
        "00000000-0000-4000-8000-000000000046",
        "00000000-0000-4000-8000-000000000048"
      ],
      "answer": "unreachable"
```

Фрагмент 25:

<!-- prettier-ignore -->
```json
    {
      "ids": [
        "00000000-0000-4000-8000-000000000008",
        "00000000-0000-4000-8000-000000000010",
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000013",
        "00000000-0000-4000-8000-000000000014",
        "00000000-0000-4000-8000-000000000016",
        "00000000-0000-4000-8000-000000000017",
        "00000000-0000-4000-8000-000000000018",
        "00000000-0000-4000-8000-000000000020",
        "00000000-0000-4000-8000-000000000021",
        "00000000-0000-4000-8000-000000000022",
        "00000000-0000-4000-8000-000000000025",
        "00000000-0000-4000-8000-000000000027",
        "00000000-0000-4000-8000-000000000028",
        "00000000-0000-4000-8000-000000000030",
        "00000000-0000-4000-8000-000000000032",
        "00000000-0000-4000-8000-000000000033",
        "00000000-0000-4000-8000-000000000034"
      ],
      "answer": "lost"
```

заменить на:

<!-- prettier-ignore -->
```json
    {
      "ids": [
        "00000000-0000-4000-8000-000000000009",
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
        "00000000-0000-4000-8000-000000000014",
        "00000000-0000-4000-8000-000000000015",
        "00000000-0000-4000-8000-000000000017",
        "00000000-0000-4000-8000-000000000018",
        "00000000-0000-4000-8000-000000000019",
        "00000000-0000-4000-8000-000000000023",
        "00000000-0000-4000-8000-000000000021",
        "00000000-0000-4000-8000-000000000024",
        "00000000-0000-4000-8000-000000000025",
        "00000000-0000-4000-8000-000000000026",
        "00000000-0000-4000-8000-000000000029",
        "00000000-0000-4000-8000-000000000031",
        "00000000-0000-4000-8000-000000000033",
        "00000000-0000-4000-8000-000000000035",
        "00000000-0000-4000-8000-000000000036",
        "00000000-0000-4000-8000-000000000038",
        "00000000-0000-4000-8000-000000000041",
        "00000000-0000-4000-8000-000000000042",
        "00000000-0000-4000-8000-000000000043",
        "00000000-0000-4000-8000-000000000045",
        "00000000-0000-4000-8000-000000000046",
        "00000000-0000-4000-8000-000000000048"
      ],
      "answer": "lost"
```

Фрагмент 26:

<!-- prettier-ignore -->
```json
      "ids": [
        "00000000-0000-4000-8000-000000000008",
        "00000000-0000-4000-8000-000000000010",
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000013",
        "00000000-0000-4000-8000-000000000014",
        "00000000-0000-4000-8000-000000000016",
        "00000000-0000-4000-8000-000000000017",
        "00000000-0000-4000-8000-000000000018",
        "00000000-0000-4000-8000-000000000020",
        "00000000-0000-4000-8000-000000000021",
        "00000000-0000-4000-8000-000000000022",
        "00000000-0000-4000-8000-000000000025",
        "00000000-0000-4000-8000-000000000027",
        "00000000-0000-4000-8000-000000000028",
        "00000000-0000-4000-8000-000000000030",
        "00000000-0000-4000-8000-000000000032",
        "00000000-0000-4000-8000-000000000033",
        "00000000-0000-4000-8000-000000000034"
      ],
```

заменить на:

<!-- prettier-ignore -->
```json
      "ids": [
        "00000000-0000-4000-8000-000000000009",
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
        "00000000-0000-4000-8000-000000000014",
        "00000000-0000-4000-8000-000000000015",
        "00000000-0000-4000-8000-000000000017",
        "00000000-0000-4000-8000-000000000018",
        "00000000-0000-4000-8000-000000000019",
        "00000000-0000-4000-8000-000000000023",
        "00000000-0000-4000-8000-000000000021",
        "00000000-0000-4000-8000-000000000024",
        "00000000-0000-4000-8000-000000000025",
        "00000000-0000-4000-8000-000000000026",
        "00000000-0000-4000-8000-000000000029",
        "00000000-0000-4000-8000-000000000031",
        "00000000-0000-4000-8000-000000000033",
        "00000000-0000-4000-8000-000000000035",
        "00000000-0000-4000-8000-000000000036",
        "00000000-0000-4000-8000-000000000038",
        "00000000-0000-4000-8000-000000000041",
        "00000000-0000-4000-8000-000000000042",
        "00000000-0000-4000-8000-000000000043",
        "00000000-0000-4000-8000-000000000045",
        "00000000-0000-4000-8000-000000000046",
        "00000000-0000-4000-8000-000000000048"
      ],
```

- [ ] **Step 3: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scenario.test.ts`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  2 passed (2)`: тест проверяет собранное задачами 1–8; что он ловит, показывают мутации шага 4.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test floor_scenario`
Expected: PASS — `test result: ok. 2 passed; 0 failed`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  118 passed (118)`, `Tests  2714 passed (2714)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 4: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — запись `pallet_closed` первой паллеты в фикстуре называет не то число коробов (так написала бы станция, посчитавшая расформированный короб). В `apps/standalone/proto/fixtures/floor-scenario.json` фрагмент

<!-- prettier-ignore -->
```json
        "boxCount": 2
```

заменить на:

<!-- prettier-ignore -->
```json
        "boxCount": 3
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test floor_scenario`
Expected: FAIL — `the_host_takes_every_record_of_the_stations_shift_once_and_ends_with_its_numbers` (`left: [(40, Some(3), 2, false), (41, Some(1), 1, true)]`: хост хранит число коробов станции как свидетельство, `box_count_reported`).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scenario.test.ts`
Expected: FAIL — «writes the records of the shared scenario, sends them in its batches, and ends closed» (записи станции больше не совпадают с фикстурой).

- [ ] **Step 5: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/floor-scenario.json apps/standalone/test/floor-scenario.test.ts`; `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`; сборка тестов хоста — без предупреждений.

- [ ] **Step 6: Commit**

```bash
git add apps/standalone/host/tests/floor_scenario.rs apps/standalone/proto/fixtures/floor-scenario.json apps/standalone/test/floor-scenario.test.ts
git commit -m "test(standalone): the shared scenario is a shift with pallets, replayed through the host's router" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Документы — `AGENTS.md` и уточнения спецификации пилота

Раздел «Floor pallets», абзац миграции `0008` в «Local database», строка о назначениях принтеров, ручной список Windows в `apps/standalone/AGENTS.md`; раздел «Уточнения плана ПЛ-Ц» в спецификации пилота (номер — следующий свободный: 19, если ПЛ-Х взял 18).

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`

**Interfaces:**

- Consumes: всё задач 1–9.
- Produces:
  - документы: `apps/standalone/AGENTS.md` («Local database», «Floor printing», «Floor pallets», «Verification»), спецификация пилота (раздел «Уточнения плана ПЛ-Ц»).

- [ ] **Step 1: Документы**

Правка `apps/standalone/AGENTS.md`:

Фрагмент 1:

<!-- prettier-ignore -->
````markdown
`test/floor-print-schema.test.ts` pins its rules.

## Writes
````

заменить на:

<!-- prettier-ignore -->
````markdown
`test/floor-print-schema.test.ts` pins its rules.

Migration `0008_floor_pallets.sql` (plan ПЛ-Ц, «Floor pallets») adds
`floor_shifts.pallet_box_capacity` and `pallet_template_id` (the host's list
of a shift with pallets), `floor_boxes.pallet_id` (only on a closed box),
`floor_pallets` and `floor_pallet_exceptions` (`DeviceData`, both in
`RETAINED_TABLES`): a pallet is open without an SSCC or closed with its
SSCC (18 digits starting with the extension `1`), block and serial; one open
pallet per shift and pairing (`floor_pallets_open`); an SSCC on one pallet
under any pairing; a pallet's exception is a `reprint` or a `disassemble`,
always with a reason code, words only with `other`. A pallet's box count is
never stored. `test/floor-pallet-schema.test.ts` pins these rules.

## Writes
````

Фрагмент 2:

<!-- prettier-ignore -->
````markdown
language, dpi }`, one per address) and the printer of each purpose — `box`,
`pallet`, `duplicate`; only `box` prints in stage 2a — the COM scanners
(given to the shell on save and when the app starts,
````

заменить на:

<!-- prettier-ignore -->
````markdown
language, dpi }`, one per address) and the printer of each purpose — `box`,
`pallet`, `duplicate`; `box` prints, and `pallet` in a shift with pallets
(plan ПЛ-Ц) — the COM scanners
(given to the shell on save and when the app starts,
````

Фрагмент 3:

<!-- prettier-ignore -->
````markdown
changes the fixture, and both tests read it.

## Marking rules
````

заменить на:

<!-- prettier-ignore -->
````markdown
changes the fixture, and both tests read it.

## Floor pallets

Pilot, plan ПЛ-Ц (`src/floor/pallets/pallets.ts`,
`src/floor/exceptions/pallet-exceptions.ts`; migration
`0008_floor_pallets.sql`). A shift with pallets — `palletsEnabled`, the
copy's `palletBoxCapacity` and `palletTemplateId`, the snapshot's
`palletTemplate`, whose layout `checkShiftSnapshot` reads like the box's (a
stored snapshot of a shift with pallets without one is refused, and the next
entry with the host brings it) — fills its open pallet by itself, as the
cloud station does; there is no scan of a box onto a pallet (that is the
handheld's, outside the pilot).

- A box's close joins the shift's open pallet, or opens one whose
  `opened_at` is the box's close, in the box's own transaction
  (`palletStep`, a `CloseStep`), and its `box_closed` names the pallet
  (`palletId`). The box that brings the pallet to the shift's boxes per
  pallet closes it in that same transaction, after the box's record: the
  next serial of the earliest pallet block (extension 1) spent by
  compare-and-set, the SSCC by `buildSscc(1, …)`, the pallet closed only
  while it holds the boxes counted, its `pallet_closed` (`openedAt`,
  `boxCount` — its boxes not taken apart, counted, never stored) and its
  label's print job (`purpose = 'pallet'`, the snapshot's pallet layout, the
  printer of «Паллета», the domain's `palletLabelFields`). A pallet's close
  never happens without its box, nor a box's without its pallet.
- No pallet serial left: the full pallet stays open, the next boxes join it,
  the work screen says «Паллета заполнена, но не закрыта», and it closes as
  soon as serials come (`closePalletIfFull`: on entry, after a box, when a
  pallet block arrives). Pallet blocks are asked for by the half rule like
  box blocks (`createBlockSupply` with `extension: 1`): on entry, after
  every close and when the link is back.
- «Закрыть паллету досрочно» (`closeOpenPallet`), after a confirmation,
  closes the open pallet with the boxes it holds; an empty one — no box, or
  every box taken apart — is refused before a serial is spent. No serial
  stops the work with its reason; a serial past the prefix's range is spent.
- Labels: `settleLabel` sends every label written and not sent, the box's
  before its pallet's (`readOpenJob` orders jobs of one moment by purpose);
  one that waits stops the work, and the next waits behind it. A pallet's
  label is checked by a scan of its SSCC, skipped, or printed again by the
  same decisions as a box's (plan 2a7), its panel says «паллеты», and its
  records are `pallet_label`; printing again a label that may exist writes
  the `pallet_exception` `reprint` in the transaction that sends it.
- Exceptions: «Перепечатать этикетку паллеты» (`reprintPallet`, a pallet
  whose label is done with: a new job with its last job's SSCC and fields,
  the exception and its record in ONE transaction, then one send) and
  «Расформировать паллету» (`disassemblePallet`: `disassembled_at`, the boxes
  untouched — they keep their pallet, stay closed with their codes, and are
  boxes without a pallet for the exports). A pallet is chosen by a scan of
  its label or the last digits of its SSCC; the reasons are the box's lists,
  words only for «Другая причина» (`reasonWords`).
- The shift's close: an open pallet with a box not taken apart keeps it open
  (`readCloseSummary`'s blocker `open_pallet`, after an open box and a
  waiting label); an empty open pallet does not, and costs no serial. The
  summary asks «На паллете N из M коробов — закрыть?», and «Закрыть паллету и
  смену» closes the pallet, sends its label and then closes the shift with
  the reason chosen — after the label is decided when it waits. `closeShift`
  takes `openPalletGuard` in its transaction (plan 2a8's `guards`).
- A new shift on the station offers «С паллетами» / «Без паллет» for a product
  with boxes per pallet and a pallet template that fits it, on by default;
  the pallet template by decision 7 for the purpose `pallet`
  (`suggestPalletTemplate`), the capacity the product's.
- Receipts take no new statement: a refused pallet record stays in the
  outbox with its code (plan ОЧ). The shared scenario
  (`proto/fixtures/floor-scenario.json`) is a shift with pallets: two
  pallets, one closed by its second box, one closed early and taken apart,
  a pallet's label printed again; `host/tests/floor_scenario.rs` also checks
  the host's pallets and `closedPallets`.

## Marking rules
````

Фрагмент 4:

<!-- prettier-ignore -->
````markdown
    removed, its status, and the scanners again after a restart.
- The floor's exceptions and close (plan 2a8) by hand, on Windows 10 and 11.
````

заменить на:

<!-- prettier-ignore -->
````markdown
    removed, its status, and the scanners again after a restart.
- The floor's pallets (plan ПЛ-Ц) by hand, on Windows 10 and 11, with the
  client's printers. None of it has been run; check at least:
  - the pallet label on the client's pallet printer (its language and
    resolution, 100 × 150 or the client's size), printed right after the
    box's label of the box that filled the pallet, and checked by a scan;
  - a full pallet with the host's PC switched off and no pallet serials
    left: the message, the next boxes on it, its close once the link is
    back;
  - «Закрыть паллету и смену» with the label check on, and a pallet's
    reprint and disassembly chosen by a scan of its label;
  - a new shift with pallets on the touch panel, and the office's totals
    of its pallets.
- The floor's exceptions and close (plan 2a8) by hand, on Windows 10 and 11.
````

Правка `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`:

Фрагмент 1:

<!-- prettier-ignore -->
````markdown
  2a читают прежние фикстуры без изменений.
````

заменить на:

<!-- prettier-ignore -->
````markdown
  2a читают прежние фикстуры без изменений.

## 19. Уточнения плана ПЛ-Ц

План `docs/superpowers/plans/2026-10-10-standalone-pl-c-pallets-floor.md` (паллеты-лайт, цех)
уточняет раздел 6.2 «Цех» так; на вопросы раздела 14 действуют рекомендованные ответы (если номер
раздела занят, этот раздел получает следующий свободный).

- **Миграция.** Одна — `0008_floor_pallets.sql`: столбцы паллет копии смены, `floor_boxes.pallet_id`,
  `floor_pallets`, `floor_pallet_exceptions`. Пересборка `floor_print_jobs` не нужна: назначение
  `pallet` разрешено с плана 2a7.
- **Сборка.** Короб присоединяется к открытой паллете или открывает её в транзакции своего закрытия;
  короб, доводящий паллету до вместимости, закрывает её той же транзакцией после своей записи —
  номер блока паллет, `pallet_closed`, задание этикетки паллеты. Без номеров паллет полная паллета
  остаётся открытой, следующие короба встают на неё, экран говорит об этом, и паллета закрывается,
  когда номера придут.
- **Досрочное закрытие** — с подтверждением; пустая паллета отказывается до списания номера.
- **Этикетки.** Этикетка короба уходит раньше этикетки паллеты того же момента; этикетка паллеты
  проверяется, пропускается и печатается снова теми же решениями, что этикетка короба.
- **Исключения паллеты** — перепечатка и расформирование с причинами из списков коробов;
  расформирование не трогает короба.
- **Закрытие смены.** Открытая паллета с коробом держит смену; сводка спрашивает «На паллете N из M
  коробов — закрыть?», «Закрыть паллету и смену» закрывает паллету, решает её этикетку и закрывает
  смену с выбранной причиной. Проверка открытой паллеты — в транзакции закрытия.
- **Новая смена на станции.** «С паллетами» — для товара с вместимостью паллеты и подходящим шаблоном
  паллеты, включено по умолчанию; шаблон — по решению 7 для назначения `pallet`; вместимость —
  товара.
- **Сквозной сценарий** — смена с паллетами (две паллеты, досрочное закрытие, перепечатка и
  расформирование паллеты); тест хоста сверяет паллеты и `closedPallets`.
- Не проверено: Windows, принтер паллет клиента, сенсорная панель, сканеры клиента.
````

- [ ] **Step 2: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`; `git diff --check`
Expected: чисто.

- [ ] **Step 3: Commit**

```bash
git add apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md
git commit -m "docs(standalone): the floor's pallets in AGENTS.md, pilot spec section 19" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Итоговая проверка плана

1. Полный набор пакета: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — PASS; Vitest на копии плана — 118 файлов, 2714 тестов (на настоящем дереве числа сдвигаются на тесты, которых на копии нет). Падение старого теста офиса тайм-аутом под нагрузкой записывается и разбирается (заметки), а не лечится повтором.
2. Rust: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db` — `16 passed`; `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test floor_scenario` — `2 passed`; гейт `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace --no-fail-fast` вне песочницы (его `ipc` и `hello` открывают сокет) — PASS. Исходники хоста и `proto` план не меняет: `git diff --stat <основа плана> -- apps/standalone/host/src apps/standalone/proto/src` пуст, а `-- apps/standalone/host apps/standalone/proto` называет только `host/tests/floor_scenario.rs` и `proto/fixtures/floor-scenario.json`; `-- apps/standalone/src-tauri` — только `migrations/0008_floor_pallets.sql`, `src/local_db.rs` и `tests/local_db.rs`.
3. Стенд с задержкой `setImmediate` и verbose-прогон для всех новых и изменённых тестовых файлов с React (`floor-work-pallets`, `floor-work-close-pallets`, `floor-work-pallet-exceptions`, `floor-new-shift`) — PASS, в выводе нет `stderr |`.
4. Каждая мутация задач 1–9 — FAIL названного теста, файл восстановлен (`cmp`, тот же `shasum`), `git status --short` после всех — пуст. На копии плана: 33 мутации Vitest, мутация `TABLE_CLASSES` (cargo) и мутация фикстуры (cargo и Vitest) — все пойманы.
5. Классы целостности закрыты тестами, каждый с мутацией: короб и его паллета пишутся вместе или не пишутся («never closes a box without its pallet: a pallet serial taken meanwhile leaves both as they were»); паллета закрывается своим последним коробом той же транзакцией, после его записи (М1 задачи 3); SSCC паллеты — только расширения 1, одна открытая паллета на смену и подключение (М1, М2 задачи 2); закрытие паллеты сверяет прочитанное (М2 задачи 3); пустая паллета номера не тратит (М3 задачи 3); смена не закрывается с открытой паллетой с коробами — ни сводкой, ни транзакцией (М4, М6 задачи 3); этикетка паллеты не уходит раньше этикетки короба и не теряется (М5 задачи 3, М1 задачи 5); исключения паллеты — одной транзакцией с записью, расформирование однократно (задача 4); линия не стоит без номеров паллет, а паллета закрывается, когда они приходят (М5 задачи 5). Тесты конкурентности держат запись (`holdingWrites`), их ожидание ограничено числом шагов.
6. `grep -rnF '\u04' apps/standalone/src apps/standalone/test` — только `src/host/pairing-code.ts:66`; `grep -rn "console\." apps/standalone/src/floor/pallets apps/standalone/src/floor/exceptions/pallet-exceptions.ts` — ничего (журнал процесса не видит ни SSCC, ни кодов).
7. `git diff --check` от основы плана; `git log --format=%B` каждого коммита — ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; изменены только пути раздела «Файлы».
8. Сверка с контрактами: факты станции — формы `facts-request-pallets.json` плана ПЛ-Х (тест строителей `floor-facts.test.ts` и сценарий через маршрутизатор хоста); точки 2a8 — `closeShift(…, guards)` с `openPalletGuard`, `CloseBlocker.open_pallet`, `RETAINED_TABLES` с паллетными таблицами, `ExceptionFlow` с паллетными действиями, `Stop` с паллетными остановками; имена раздела «Контракт для ОЧ, О-Х, О-Ф и испытаний» (`remainingSerials(…, PALLET_EXTENSION)`, `suggestPalletTemplate`, `deviceShiftCreate` с `pallets`) — в коде так, как в контракте.

**Что нельзя проверить без Windows, оборудования и данных клиента** (отчёт называет отдельно от автоматических проверок): этикетка паллеты на принтере паллет клиента (язык, разрешение, размер 100 × 150 или свой), печать сразу после этикетки короба, заполнившего паллету, и её проверка сканером клиента (SSCC с `]C1` и без); полная паллета при выключенном ПК хоста (вариант А) или исчерпанном блоке паллет — сообщение, короба на ней, закрытие после прихода номеров; «Закрыть паллету и смену» с проверкой этикетки; перепечатка и расформирование паллеты сканом её этикетки на сенсорной панели; новая смена «С паллетами» на сенсорной панели; итоги паллет смены в офисе; выгрузки и формы паллет (планы О-Х, О-Ф, ЧЗ).

## Перенесено

- **Запас номеров паллет в строке состояния и предупреждение о нём** — план ОЧ (`remainingSerials(local, pairing, issuerPrefix, PALLET_EXTENSION)`), вместе с экраном очереди и «Отправить снова» для записей паллет.
- **Хранить намерение «Закрыть паллету и смену» до прихода номеров паллет** (облачное `pendingShiftCloseReasonRef` при `no-serials`): сейчас оператор нажимает снова — по просьбе владельца.
- **Своя вместимость паллеты новой смены на станции** — офисная форма (план О-Ф) её меняет; на станции — по просьбе владельца.
- **Паллеты нескольких станций на одной смене, отзыв блоков паллет** — этап 2b (ПЛ-Х, «Перенесено»).
- **Складские паллеты, «скан короба в паллету», снятие короба с паллеты** — только ТСД, вне пилота (облако тоже делает их только на ТСД).
- **«Ярлык паллеты» и «Состав паллеты»** — формы кабинета, план О-Ф; станция их не печатает (как облачная).
- **Вопрос владельцу ВЦ1–ВЦ6** (раздел «Допущения»): ответ, отличный от рекомендованного, — правка задачи 8 (ВЦ1), задачи 5 (ВЦ2, ВЦ4–ВЦ6) или задачи 6 (ВЦ3).

## Отклонения при исполнении

- **Задача 1.**
  - Четыре кода квитанций паллет уже были в `FACT_RECEIPT_CODES`, а тест «know every receipt code of the host» уже проходил. Поэтому фрагмент 5 `protocol.ts` пропущен.
  - Готовыми оказались также `shiftSnapshotTemplateSchema` и поля паллет `officeShiftSchema`.
  - Сверх плана: `keepEnteredShift` тоже передаёт `palletsEnabled` в `checkShiftSnapshot`. Иначе ответ с паллетами без макета паллеты мог сохраниться.
  - Строгость трёх записей паллет и чтение флага в `readStoredWork` и `enterShift` покрыты тестами.
- **Задача 2.**
  - Сверх плана добавлен индекс `floor_pallets_shift (host_id, device_id, shift_id)`: без него удаление паллет при очистке и чтение закрытых паллет смены идут полным просмотром.
  - У `floor_pallet_exceptions` индекса по смене нет намеренно: её просмотр закреплён в обоих списках планов.
  - `id TEXT NOT NULL PRIMARY KEY` у обеих таблиц, как в `0006`/`0007`.
  - По смыслу обновлены закрепления столбцов, индексов и планов в `test/floor-schema.test.ts`, а также `test/floor-new-shift.test.tsx` (`createdCopy`).
  - Фрагмент 3 Rust-теста встретился трижды и применён ко всем трём местам.
  - Добавлены тесты миграции `0008` поверх базы `0007` на SQLite Node и на `Migrator` оболочки.
- **Задача 3.**
  - Подзапрос `pallet_boxes` сводки переписан на коррелированную сумму по `floor_pallets_open` + `floor_boxes_pallet`: соединение из плана обходило все короба подключения. Значение то же.
  - Тексты SQL вынесены в константы ради закреплений.
  - `test/floor-work-close.test.tsx` сравнивает `readOpenJob` с `OPEN_JOB_READ_SQL`.
  - Исправление `d7a91fb56`: номер паллеты, чей SSCC держит другая паллета (бывшее подключение после переустановки хоста), теряется один, как у короба (`freePalletSscc`), а не останавливает навсегда каждое закрытие короба.
- **Задача 4.**
  - `palletExceptionStatements` живёт в `facts.ts` рядом с `exceptionStatements` (иначе цикл импорта).
  - Один `PALLET_STATE_SQL` вместо `isClosedPallet` и отдельного счёта.
  - Перепечатка паллеты несёт в транзакции две проверки: паллета закрыта и не расформирована, а последнее задание — прочитанное. Проверка живой паллеты стоит и перед записью `pallet_exception` в «Напечатать снова».
  - `PalletTemplateChangedError` — подкласс `PalletUnavailableError`.
  - Тест 2a7 «этикетка паллеты здесь не решается» заменён двумя.
- **Задача 5.**
  - Шаг паллеты добавляется в `attemptClose`: в исполненном `WorkScreen` нет мемо `closeSteps`.
  - `blockContextOf(live, extension)`, два снабжения блоками.
  - Дополнительная остановка `pallets_missing`.
  - `settlePallet` пробует до трёх потерянных номеров (`PALLET_SERIAL_TRIES`).
  - `decide` и проверка этикетки зовут `settleLabel`, чтобы этикетка паллеты ушла после решения по коробу.
  - Исправление `789986485`: сообщение «Паллета заполнена, но не закрыта» выводится из прочитанной паллеты (`palletWaitsNow`).
- **Задача 6.**
  - Тесты брифа приведены к исполненным заголовкам и `work.press`.
  - `finishClose` — единый путь, передаёт `openPalletGuard` всегда.
  - Повторное чтение после сбоя идёт через `closeFailed`.
  - `sameSummary` сравнивает короба открытой паллеты.
  - Исправление `22d65cb09`: намерение закрыть смену привязано к номеру задания этикетки паллеты. Любая другая остановка или изменившаяся сводка его снимает.
- **Задача 7.**
  - Принтер перепечатки определяется по назначению (короб или паллета).
  - Пустое «Сейчас исключений нет» учитывает закрытые паллеты.
  - Последняя строка подтверждения выбирается по действию.
  - Тест задачи 5 о снятии короба с ждущей паллеты переведён на настоящий поток «Расформировать короб».
  - Оставшиеся пункты итогового ревью (M1–M5) закрыты волной исправлений итогового ревью.
- **Задача 8.**
  - Сверх плана: `palletCapacityOffered` (вместимость от 1 до 10 000 и подходящий шаблон паллеты, как требует хост) и `palletsOf` (форма с паллетами, которую нельзя создать, не отправляется как смена без паллет).
  - `isShiftOfRequest` сравнивает паллеты; первый тест брифа отвечает `MADE_PALLETS`.
- **Задача 9.**
  - sha256 фикстуры — `70464d38…2f32` вместо `7057d806…ad08` плана. Разница — шесть идентификаторов записей исключений, сдвинутых на один, как в задаче 8 плана 2a8. Обратная замена воспроизводит хеш плана точно (проверено итоговым ревью).
  - Сверх плана добавлены три теста хоста и выгрузка `pallet_state()`.
  - Мутация T4 (закрытие без `openPalletGuard`) в сценарии выживает по замыслу и закреплена тестами задачи 6.
- **Задача 10.**
  - Якоря `AGENTS.md` и спецификации не нашлись; текст вставлен по смыслу, §19 — в конец спецификации.
  - Исправлены устаревшие места о `closeSteps`, об индексах очистки и о сценарии.
  - Предложение о 21 таблице (`AGENTS.md:192-194`) пропущено и исправлено волной итогового ревью.
- **Счёт тестов.** Числа плана — числа его копии. На настоящем дереве: Vitest 122 файла, 3777 тестов (после задачи 9); `cargo test --workspace` — 819.
- **Итоговое ревью.**
  - Критических и важных замечаний нет.
  - Волна из четырёх коммитов:
    - запрет расформирования паллеты в транзакции, пока открыто задание её этикетки;
    - нейтральные слова выбора паллеты и правка слов остановок паллеты;
    - закрепления точного SSCC, причины «Напечатать снова» паллеты, кнопок, порядка после перезапуска;
    - устаревшие тексты.
  - Перенесены владельцу или в ОЧ:
    - ожидание номеров паллет внутри очереди работы;
    - досрочное закрытие без серии попыток.
