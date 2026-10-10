# План 2a8: цех — исключения коробов, закрытие смены, смена, закрытая офисом, срок хранения, сквозной сценарий — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Оператор в рабочем экране смены снимает последний принятый код, очищает открытый короб, перепечатывает этикетку закрытого короба и расформировывает закрытый короб — с причиной из кодов хоста и словами только при «Другой причине»; закрывает смену по сводке «план / факт / отклонение / коробов / в среднем в коробе» с одной из шести причин домена при невыполненном плане, одной локальной записью без хоста, после которой у смены нет ни одной записи и `shift_closed` уходит на хост последним; смену, которую закрыл офис, станция доводит до конца (короб, этикетка, закрытие) и не принимает в неё новых кодов; через 30 дней после квитанции на закрытие записи смены удаляются с устройства; весь путь «вход → сканы → короба → этикетки → исключения → закрытие → доставка» проверен одной фикстурой с обеих сторон протокола — модулями цеха и настоящим маршрутизатором хоста. Последняя часть цеха этапа 2a — на критическом пути пилота у текущего клиента.

**Architecture:**

- Исключения (задача 1, `src/floor/exceptions/box-exceptions.ts`): `undoLastCode`, `clearOpenBox`, `disassembleBox`, `reprintBox`, `readClosedBoxes`, `reasonWords`; каждое — одна транзакция со строкой `floor_exceptions`, записью `box_exception` и своими последствиями (`floor_codes`, счётчик короба, `disassembled_at`, новое задание печати), со сравнением прочитанного; запись `undo` несёт хеш кода и ровно `scanned_at` его строки `floor_codes`, `clear` — момент очистки (правила хоста плана 2a2).
- Экран исключений (задача 2, `ExceptionFlow.tsx`): остановка `exceptions` рабочего экрана; короб — сканом этикетки (не журналируется) или последними цифрами SSCC на клавиатуре из кнопок 64 px; причины кнопками, слова — полем ввода, пока сканер-клавиатура молчит.
- Закрытие смены (задача 3, `src/floor/close/shift-close.ts`): `readCloseSummary` и `closeShift(context, reason, guards?)` — одна транзакция со сверкой сводки; `outboxStatement` (план 2a6) больше не вставляет запись смены, у которой есть `local_state`, — `shift_closed` всегда последняя запись смены.
- Сводка закрытия (задача 4, `ShiftClosePanel.tsx`): остановки `close` и `closed` рабочего экрана; сводка читается в очереди работы; закрытая смена не принимает сканов, «К списку смен» и «Выйти из смены» не держатся.
- Квитанции и список (задача 5): четвёртый оператор транзакции квитанций `sendFactBatch` (`closing` → `closed`), отказ в закрытии виден в карточке, список перечитывается после каждой записи и квитанции (`outboxVersion`); сквозной тест приложения «закрыть смену без хоста».
- Смена, закрытая офисом (задача 6): рабочий экран остаётся (`officeClosed`), новых кодов не берёт; в списке — «Закрыта в офисе» и «Завершить» без хоста.
- Срок хранения (задача 7, `src/local/retention.ts`): `purgeAcknowledged`, `scheduleRetention`, `RETAINED_TABLES`; `App` запускает проход при старте и раз в час.
- Сквозной сценарий (задача 8): `test/floor-scenario.test.ts` строит записи и пачки модулями цеха и сверяет с `proto/fixtures/floor-scenario.json`; `host/tests/floor_scenario.rs` отправляет те же пачки в маршрутизатор хоста (`TestApp`, без сокета).
- Документы (задача 9). Не меняются: исходники хоста и `proto`, оболочка (`src-tauri`), миграции, `apps/station`, `packages/*`, `package.json`, `pnpm-lock.yaml`, `Cargo.toml`, `Cargo.lock`. Из Rust добавляется только тест `host/tests/floor_scenario.rs`.

**Tech Stack:** React 19.2, TypeScript 6 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4.4.3, i18next, `@markiro/ui` (`Card`, `Button size="floor"`, `Input size="floor"`, `Alert`), `@markiro/domain` (`SHIFT_CLOSE_REASON_CODES`, `shiftCloseReasonRequired`, `isShiftCloseReasonCode`, `parseScannedSscc`, `formatSsccHri`), Vitest 4 с jsdom и `node:sqlite` за `LocalExecutor`; Rust — тест хоста на `axum` (`tower::ServiceExt::oneshot` через `TestApp` из `host/tests/support/app.rs`), sqlx 0.8.6.

**Спецификации:**

- `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` (черновик этапа 2a): решения 17, 18, 31, 36, §5.4 (закрытая офисом смена), §5.5 (срок хранения), §5.7.6 (исключения), §5.7.7 (закрытие смены), §7 (сквозной сценарий), строка 2a8 раздела 8, §11 (вопросы), уточнения планов 2a1–2a7 (разделы 15–19).
- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`: §4.1 (строка 8 среза), §6 (паллеты-лайт: точки расширения), §9.1 (что можно без хоста), §11 (план РК: станция досылает факты, хранящиеся 30 дней), §12.5 (критический путь), §13 (пункты 5 и 7 не урезаны), §14 (П1, П2, П10), §15 (обрыв посреди смены).
- Планы, на которых стоит этот: 2a2 (`…-2a2-host-facts.md`, правила хоста из ревью его задач 5 и 6 и очереди мелочей, пункты 14–23: `undo` — точный `codeHash` и `targetScannedAt`, `clear` — позиции до `occurredAt`, отказ в квитанции навсегда, любой ответ не 200 — та же пачка с теми же `id`, закрывает только владелец, собственные факты станции после закрытия — поздние), 2a5 (`…-2a5-floor-shifts.md`, «Контракт для 2a6–2a8»: `floor_shifts.local_state`, `floor_exceptions`, `WorkScreenProps`, ворота работы), 2a6 (`…-2a6-floor-scanning.md`, «Контракт для 2a7–2a8»: `boxExceptionRecord`, `shiftClosedRecord`, `outboxStatement`, транзакция квитанций, `readWorkTotals`, `Stop`), 2a7 (`…-2a7-floor-printing.md`, «Контракт для 2a8 и ПЛ-Ц»: сводка закрытия недоступна, пока `shiftLabelsSettled` — `false`; тест «ни одной записи смены после `shift_closed`»; перепечатка — `prepareLabelJob` и исключение `reprint` одной транзакцией, затем `sendLabelJob`; причины — `src/floor/exception-reasons.ts`).
- Ревью: `.superpowers/sdd/2a2-task-5-review.md`, `2a2-task-6-review.md`, `2a2-minors.md` (пункты 14–23), итоговые ревью `1f2`, `2a1`, `2a4` — мутанты, переживавшие тесты плана, проглоченные отказы, застрявшие флаги, ловушки (оператор, который не может закрыть смену; экран, с которого не уйти; закрытие, теряющее неотправленное), тесты, которые висят вместо того, чтобы падать.
- `apps/standalone/AGENTS.md` — «Local database», «Writes», «Shifts», «Facts», «Floor work», «Floor printing», «Logs», «Verification».
- Облачная станция (переносится своими модулями, не импортом): `apps/station/src/pages/ExceptionFlow.tsx`, `ui/exceptions/*`, `lib/box-exceptions-mirror.ts`, `lib/shift-close.ts`, `pages/WorkScreen.tsx` (`performClose`, `planReachedPrompt`), тексты `ru.json` (`box.*`, `work.closeReasons`, `work.closeSummary*`).

## Допущения по вопросам владельцу

Владелец не ответил ни на вопросы раздела 11 спецификации 2a, ни на вопросы раздела 14 спецификации пилота. План исполняет рекомендованные варианты; ниже — что принято и что поменять, если ответ будет другим.

- **П1 — хост на ПК станции (вариант Б), но план верен для обоих вариантов.** Исключения, закрытие смены и срок хранения — локальные записи; хост нужен только доставке. При варианте А обрыв Wi-Fi не мешает ни исключениям, ни закрытию смены: запись `shift_closed` ждёт в очереди, текст после закрытия одинаков со связью и без.
- **П10 — В1–В14 по рекомендации.** В4 А: офис закрывает активную смену, а станция доводит такую смену до конца и закрывает её у себя (`alreadyClosed`). В6: срок хранения — 30 дней. В10 А: любой вошедший оператор делает исключения и закрывает смену. В7, В8, В9 — без изменений (планы 2a4, 2a5).
- **В14 (нарастание блокировок входа и факт блокировки на хосте) — направление принято, в 2a8 не входит.** Новый вид факта (`floor_lockout`) — это тип `proto`, Zod, фикстура, обработчик хоста и строка журнала действий (правило «Facts»): работа потока хоста, а не цеха. Его разумно добавить вместе с протоколом 3 плана ПЛ-Х или отдельным малым планом; в «Перенесено».
- **П2 (паллеты-лайт) — план ПЛ-Ц, точки расширения оставлены:** `closeShift(context, reason, guards)` берёт проверки ПЛ-Ц той же транзакцией; `CloseBlocker` дописывается открытой паллетой; `RETAINED_TABLES` — паллетными таблицами (тест падает на таблице с `shift_id`, которой нет в списке); экран исключений получает паллетные действия ПЛ-Ц («Контракт для ПЛ-Ц»).
- **Спецификация пилота §13, пункты 5 (срок хранения) и 7 («Очистить короб»), не урезаны:** девять задач уложились.
- **Вопросы этого плана (новые; рекомендованы варианты, по которым он написан):**
  - **ВП1 — смена, которую закрыл офис, остаётся в списке станции с «Завершить», пока станция её не закроет.** А) так: оператор доводит короб и этикетку и закрывает смену, срок хранения потом удаляет её записи; Б) убирать её из списка, если на станции нет открытого короба с кодами и ждущей этикетки: тогда станция не пришлёт `shift_closed`, и срок хранения её никогда не удалит. **Рекомендация — А.**
  - **ВП2 — «Отправить снова» отказанного закрытия — план ОЧ.** Карточка смены называет код отказа, смена остаётся «Закрывается», закрывает её офис; станция не пересылает отказанную запись под тем же `id` никогда (правило 2a2).
  - **ВП3 — «Снять последний код» без подтверждения** (как в облаке), «Очистить короб», «Перепечатать этикетку» и «Расформировать короб» — с подтверждением; подтверждения бригадира нет (В10 А).

## Global Constraints

**Из спецификации этапа** (дословные значения)

- Решение 17: «открытый непустой короб не даёт закрыть, пустой удаляется; факт — число принятых кодов в смене по своей базе; причина из `SHIFT_CLOSE_REASON_CODES` нужна, только если план задан и не равен факту; локальная запись — точка фиксации, закрытая локально смена больше не открывается ни обновлением, ни навигацией. Хост принимает закрытие от устройства, которое входило в смену; закрытую офисом — `accepted` с `alreadyClosed`».
- Решение 31: «N = 30 дней от квитанции `accepted` на закрытие смены; удаляются факты, задания печати и записи очереди этой смены, если все её записи очереди получили квитанции и нет нерешённых заданий печати».
- Решение 36: причины перепечатки — `damaged_label`, `unreadable_label`, `printer_jam`, `quality_request`, `other`; расформирования — `wrong_product`, `wrong_quantity`, `damaged_package`, `quality_rejected`, `other`; необязательный текст до 200 символов только при `other`.
- §5.7.6: «Снять последний код» (`undo`, открытый короб), «Очистить короб» (`clear`), «Перепечатать этикетку» (`reprint`, закрытый короб, причина), «Расформировать короб» (`disassemble`, закрытый, причина; коды снова свободны, SSCC остаётся использованным); короб выбирается сканом SSCC или по хвосту номера; локальные последствия и запись `outbox` — одной транзакцией.
- §5.7.7: сводка — товар, план, факт, отклонение, закрытых коробов и среднее на короб («—» без коробов); открытый непустой короб — сообщение и возврат к работе; при расхождении — шесть кодов сеткой, ровно один; одна `local_transaction`: удаление пустого открытого короба, `local_state = 'closing'`, запись `outbox` (`shift_closed`); квитанция `accepted` (в том числе `alreadyClosed`) — `local_state = 'closed'`; текст после закрытия одинаков со связью и без: «Смена закрыта. Данные будут отправлены автоматически».
- §5.5: срок хранения — отдельный проход при запуске и раз в час.
- §5.7.3: сканы не принимаются, пока открыты исключения, сводка закрытия или подтверждение очистки.

**Из контрактов планов 2a2, 2a6, 2a7 и правил хоста**

- `undo` несёт точные `codeHash` и `targetScannedAt` своей строки `floor_codes` (тот же текст, что `data.scannedAt` скана; не переформатировать, не брать `now()` снова); хост снимает живую позицию, только если её `added_at` равен ему. `clear` — `occurredAt` = момент очистки (`toISOString`); хост снимает позиции с `added_at <= occurredAt`.
- Отказ (`rejected`) хранится на хосте навсегда: запись под тем же `id` не отправляется снова никогда; «Отправить снова» (новые `id`, прежний порядок `seq`) — план ОЧ. Любой ответ, кроме 200, — та же пачка с теми же `id`.
- Закрывает смену только устройство-владелец; собственный факт станции после её `shift_closed` хост отмечает поздним (`late_data_at`) — у смены не должно быть записи после её закрытия.
- План 2a7: сводка закрытия недоступна, пока `shiftLabelsSettled` — `false`; перепечатка решённого короба — `prepareLabelJob` и исключение `reprint` одной транзакцией, затем `sendLabelJob`; коды причин — `src/floor/exception-reasons.ts`.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!` в исходниках (`as const` — не приведение); именованные экспорты, `import type`; члены интерфейсов, которые передаются несвязанными, — свойства-функции.
- Экраны цеха: только `@markiro/ui` (ESLint запрещает нативные `button`, `input`, `textarea`), каждая кнопка — `size="floor"` (64 px), состояние — словами; ни одна кнопка ухода («Выйти из смены», «Назад», «К списку смен») не держится запросом, который может не ответить (локальная запись ограничена, план 2a5).
- Тексты — ключи `src/i18n/ru.json`, кириллица буквами; переменные текстов — именованные, не `count`.
- Тесты конкурентности детерминированы: удерживаемая запись (`holdingWrites`), удерживаемая отправка (`fakeHardware().holdSends`); ожидание в тестах ограничено числом шагов, а не временем.
- Журнал процесса не видит ни кодов, ни SSCC: в новых модулях цеха нет `console.*`.
- Rust: `cargo fmt` чистый, сборка без предупреждений; `Cargo.toml`, `Cargo.lock` не меняются.
- Не меняются: `apps/station`, `packages/*`, исходники `apps/standalone/host` и `apps/standalone/proto`, `apps/standalone/src-tauri`, `package.json`, `pnpm-lock.yaml`.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Решения планировщика

- **«Снять последний код» — по порядку принятия, а не по часам:** последняя строка `floor_codes` по rowid (SQLite даёт новой строке rowid больше всех прежних). Часы, отступившие назад между сканами, не меняют, какой код снимется.
- **Каждое исключение сравнивает прочитанное:** открытый короб — открыт и держит прочитанное число кодов; расформируемый — закрыт и не расформирован. Скан, закрытие или другое исключение, успевшие между чтением и записью, дают `stale`: ничего не записано, оператор повторяет.
- **Перепечатка — только короба с решённой этикеткой** (`sent`, `verified`, `skipped`): новое задание тем же `prepareLabelJob` с SSCC и полями последнего задания короба, шаблоном снимка его ревизии и принтером назначения «Короб» сейчас; задание, исключение и запись `reprint` — одна транзакция до отправки, затем одна первая отправка. Ждущая этикетка решается в своей панели (2a7: `printAgain` с причиной); новая этикетка, ждущая проверки или не отправленная, сразу останавливает работу своей панелью.
- **Исключения открываются, только когда работу ничто не держит:** при ждущей этикетке кнопка выключена — сначала её решают. Пока исключения открыты, обычный скан не принимается и не журналируется; скан на шаге выбора короба выбирает короб по SSCC.
- **Выбор короба — скан или последние цифры SSCC кнопками 64 px**, не полем ввода: поле взяло бы нажатия сканера-клавиатуры. Список — не больше 12 последних закрытых коробов, остальные — по цифрам. Слова «Другой причины» — поле ввода `@markiro/ui`; пока оно в фокусе, источник сканов не принимает нажатий (`setManualTextEntryActive`).
- **Сводка и закрытие — остановки рабочего экрана** (`Stop` `close` и `closed`), как условился план 2a7, а не вид `FloorApp` (§5.1 спецификации): закрытие встаёт в ту же очередь работы, что сканы и короба, — ни один скан, принятый до нажатия, не окажется после закрытия, а сводка его учтёт.
- **Закрытие сверяет сводку в своей транзакции:** счётчики кодов и закрытых коробов (новый, снятый или освобождённый код меняет их, открытый короб с кодами — тоже) и отсутствие ждущей этикетки — одним `UPDATE … WHERE` с `expectedChanges: 1`; иначе `stale`, и сводка читается заново. Дополнительные проверки (`guards`) ПЛ-Ц идут той же транзакцией первыми.
- **«Нет записи после закрытия» держит одно место:** `outboxStatement` вставляет запись только пока у её смены нет `local_state` (`INSERT … SELECT … WHERE NOT EXISTS`, `expectedChanges: 1`); `shift_closed` пишется до отметки `closing` той же транзакцией. Повторная отправка отклонённой записи после закрытия (план ОЧ) поздняя по определению и пишется своим `INSERT` в обход этой проверки (ревью задачи 6 плана 2a2, Minor 4).
- **Закрытая смена — конечная остановка экрана:** сканы не принимаются, «К списку смен» и «Выйти из смены» уходят; «Назад к работе» и «Выйти из смены» не держатся и на сводке — кроме мгновения самой записи.
- **Квитанция закрытия** — четвёртый оператор транзакции квитанций (контракт 2a6): `closing` → `closed` у смены, чья запись `shift_closed` получила `accepted` (и с `alreadyClosed`). Отказ оставляет `closing`, карточка называет код отказа; список перечитывает копии после каждой записи и пачки квитанций (`outboxVersion`), поэтому принятая смена уходит из него сама.
- **Смена, закрытая офисом, не выводит оператора** (уточнение §5.4): выход сразу бросал открытый короб и его этикетку без способа их закончить, этикетка навсегда держала бы срок хранения, а коды открытого короба ломали бы выгрузку (`BOX_COVERAGE_INCOMPLETE`). Рабочий экран остаётся без новых кодов, остальное работает; в списке смена «Закрыта в офисе» с «Завершить» (вход по сохранённому снимку без хоста, который такую смену не открывает). Уведомление списка «Смену … закрыли в офисе» больше не выдаётся и удаляется вместе с типом `ShiftListNotice`.
- **Срок хранения — от квитанции `accepted` на `shift_closed`:** смена уходит целиком (`RETAINED_TABLES` по `shift_id` и копия), по смене на транзакцию; первый оператор удаляет копию только если смена всё ещё «готова к удалению» (`expectedChanges: 1`), иначе вся транзакция откатывается. Блоки SSCC и запросы блоков остаются: восстановленный хост просит у станции её блоки (план РК). Проход не бывает двойным; неудачный повторяется в следующий час.
- **Сквозной сценарий — общая фикстура и маршрутизатор хоста, без процесса `markiro-host run`** (§7 спецификации предлагал процесс и HTTP-клиент тестов): фикстура детерминирована (шагающие часы, счётные `id`), тест хоста не открывает сокета и идёт в задании `standalone-rust`, Vitest — в задании вебвью; расхождение формы записей с правилами хоста падает с обеих сторон. Хостовую часть пакета (пары, TLS) сценарий не проверяет — её проверяют тесты этапа 1.

## Контракт для ПЛ-Ц и ОЧ

**Исключения (`src/floor/exceptions/box-exceptions.ts`).**

```ts
undoLastCode(context: BoxContext): Promise<OpenBoxResult> // { kind: "done"; boxId; itemCount } | { kind: "empty" } | { kind: "stale" }
clearOpenBox(context: BoxContext): Promise<OpenBoxResult>
disassembleBox(context: BoxContext, boxId: string, reason: ExceptionReason<DisassembleReason>): Promise<{ kind: "done"; freed: number } | { kind: "stale" }>
reprintBox(context: ReprintContext, boxId: string, reason: ExceptionReason<ReprintReason>, settings, render?): Promise<PrintJob>
readClosedBoxes(local, pairing, shiftId): Promise<ClosedBox[]> // { id; sscc; itemCount; closedAt }
reasonWords(text: string | null): string | null // InvalidReasonError
```

- **ПЛ-Ц:** перепечатка и расформирование паллеты — свой модуль по тому же образцу: строка `floor_pallet_exceptions` и запись `pallet_exception` (форма плана ПЛ-Х) одной транзакцией с последствиями (`disassembled_at` паллеты; короба не трогаются), слова — тем же `reasonWords`; перепечатка — `prepareLabelJob` с `purpose: "pallet"`, полями последнего задания паллеты и шаблоном паллеты снимка, плюс исключение той же транзакцией, затем `sendLabelJob`. Расформирование короба на паллете паллету не меняет (хост пересчитывает живые короба паллеты, план ПЛ-Х).
- **Экран** (`ExceptionFlow.tsx`): действия — `ExceptionAction`; ПЛ-Ц добавляет паллетные действия и свой список закрытых паллет тем же механизмом выбора (скан этикетки через `registerScan`, последние цифры SSCC, `boxesByTail` — по `{ id, sscc, itemCount }`), результат — тот же `ExceptionOutcome`.

**Закрытие (`src/floor/close/shift-close.ts`, `ShiftClosePanel.tsx`).**

```ts
readCloseSummary(local, pairing, shiftId): Promise<CloseSummary> // { plannedQty; actualQty; closedBoxes; reasonRequired; blocker }
type CloseBlocker = { kind: "open_box"; items: number } | { kind: "label" } | { kind: "closed" }
closeShift(context: BoxContext, reasonCode: ShiftCloseReasonCode | null, guards?: readonly LocalStatement[]): Promise<CloseResult>
readRefusedCloses(local, pairing): Promise<Map<string, string | null>>
```

- **ПЛ-Ц:** открытая паллета с коробами — новый `CloseBlocker` (`{ kind: "open_pallet"; boxes }` по его выбору имени) и действие сводки «Закрыть паллету и смену»: паллета закрывается обычным путём (её этикетка решается, `shiftLabelsSettled` её считает — назначение `pallet` уже в `OPEN_JOB_SQL`), затем смена; проверка той же транзакцией — `guards` (`UPDATE floor_shifts SET local_state = local_state WHERE … AND NOT EXISTS (открытая паллета с коробами)`, `expectedChanges: 1`). Пустая открытая паллета закрытию не мешает. Записи паллет проходят проверку `outboxStatement` сами: после `shift_closed` их тоже нет.
- **ОЧ:** «Отправить снова» отклонённой записи после закрытия её смены — запись поздняя по определению: она пишется своим `INSERT` без проверки `local_state` (не через `outboxStatement`), под новым `id`, с `data` байт в байт, вместе с отклонёнными зависимыми в прежнем порядке `seq`; для отказанного закрытия (`readRefusedCloses`) — тот же путь, после чего квитанция `accepted` переводит смену в `closed`.

**Квитанции (`src/local/facts-sender.ts`).** Транзакция квитанций — четыре оператора: исходы записей, `conflict` скана, `needs_fix` короба, `closing` → `closed` по `accepted` записи `shift_closed`. ПЛ-Ц своих операторов сюда не добавляет.

**Рабочий экран (`src/floor/work/WorkScreen.tsx`).** `WorkScreenProps` += `officeClosed?: boolean`. `Stop` += `exceptions`, `close`, `closed` (`closed` — конечная). Перехват скана: выбор короба исключений, затем проверка этикетки, затем остановка, затем `officeClosed`, затем конвейер. ПЛ-Ц добавляет свои остановки (досрочное закрытие паллеты, «Закрыть паллету и смену») в тот же `Stop`.

**Список (`ShiftList`, `ShiftCard`, `readShiftCopies`).** Закрытая хостом смена, в которую станция входила и которую не закрыла, видна с «Завершить» (`CardAction` `finish`); `ShiftListProps.outboxVersion` — перечитать после записей и квитанций.

**Срок хранения (`src/local/retention.ts`).** `RETAINED_TABLES` — таблицы записей смены (с `shift_id`); ПЛ-Ц добавляет `floor_pallets` и `floor_pallet_exceptions` (тест `names every table of a shift's records` падает, пока их нет в списке). Блоки SSCC и запросы блоков не удаляются (план РК).

**Сквозной сценарий.** Фикстура `proto/fixtures/floor-scenario.json` описана в задаче 8. ПЛ-Ц, когда протокол 3 плана ПЛ-Х влит, добавляет в сценарий паллету (короба на паллете, `pallet_closed`, этикетка паллеты) и перестраивает фикстуру тем же сценарием, записав её временным тестом (`writeFileSync` вместо сравнения, файл не коммитится); хостовый тест читает новую фикстуру и сверяет `closedPallets`.

**Тексты.** Ключи `floor.exceptions.*`, `floor.close.*`, `floor.work.officeClosed.*`, `floor.work.last.officeClosed`, `floor.shifts.closeRefused`, `floor.shifts.finishHint`, `floor.shifts.status.office_closed`, `floor.shifts.action.finish`.

## Заметки для исполнения

**Основа плана**

- 2a8 стоит на коде планов 2a1–2a7 (2a2 — хост фактов с правилами `undo`/`clear`, `shift_closed` и опоры `host/tests/support/app.rs`; 2a5 — миграция `0006`, `FloorApp`, копии смен; 2a6 — `facts.ts`, `box-close.ts`, `facts-sender.ts`, `WorkScreen.tsx`, `test/support/floor-work.ts`; 2a7 — `print-jobs.ts` с `shiftLabelsSettled`, `print-resolution.ts`, `exception-reasons.ts`, `test/support/printing.ts`). Перед задачей 1 убедиться, что `git log --oneline` содержит их коммиты, а `apps/standalone/src/floor/print/print-jobs.ts` (с `shiftLabelsSettled`), `apps/standalone/src/floor/exception-reasons.ts`, `apps/standalone/host/src/facts/shift_closed.rs` и `apps/standalone/test/support/printing.ts` есть; если чего-то нет — остановиться и назвать это в отчёте.
- Фрагменты построены на копии репозитория: ветка `p2a8-base` (`02a953077`) — это `p2a7-scratch` (`4bd06f8b8`, копия планировщика 2a7: `claude/2a4-shell` на `ce6511b3b`, влитые основная ветка и `claude/2a3-office` на `105ad8bca`, то есть содержимое `claude/integration` на `16fdf718a`, плюс план 2a2 из дерева `c875f9ded` и планы 2a5, 2a6, 2a7, применённые по тексту), поверх которой наложена исполненная часть 2a2 — разница `c875f9ded..ceea2c126` ветки `claude/2a2-facts` (хост, тесты `proto`, `test/fact-rules.test.ts`, `AGENTS.md`; `git apply -3`, без конфликтов): после неё `git diff ceea2c126 p2a8-base -- apps/standalone/host apps/standalone/proto` пуст. План 2a5 исполняется на `claude/2a5-floor` (там пока задача 1), поэтому 2a5–2a7 — по тексту их планов. Задача за задачей план применён к этой копии, и каждая команда ниже запущена на ней; затем текст плана разобран сценарием и применён к чистой копии основы — деревья совпали побайтно. Настоящее дерево будет другим (исполненные 2a5–2a7): фрагмент, который из-за этого не находится, применяется к тому же месту по смыслу, а расхождение записывается в «Отклонения при исполнении». Номер раздела спецификации задачи 9 — следующий свободный.

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, с отступами; на свою очередь он встречается в файле ровно один раз. Фрагменты одной правки идут сверху вниз по файлу и применяются по порядку. Шаг 1 (тесты) применяется раньше шага 3 (реализация).
- «Создать» — новый файл, ровно как в блоке.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках отформатирован prettier и `cargo fmt`: расхождение при проверке значит опечатку.
- Русский текст в коде и в `ru.json` — буквами. Каждая задача с вебвью кончается `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное совпадение — `src/host/pairing-code.ts:66`. Разделитель групп GS1 в тестах пишется `\u001d`, в фикстуре JSON — так же.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие защиты. Мутация применяется к файлу, каким его оставила своя задача. Для каждой: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из шага (у мутации из нескольких фрагментов — все, по порядку); команда — ожидаемый FAIL с названным тестом; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить. Мутация фикстуры задачи 8 проверяется и Vitest, и `cargo test`.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON, CSS и MD; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `run lint`; Rust (задача 8) — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`.

**pnpm, git, Cargo и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. Команды — из корня репозитория, без `cd`. Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата; если обёртка `rtk` урезала вывод, `rtk proxy <команда>`.
- В свежем worktree сначала: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`.
- Cargo — с `--offline --locked`. Тест `host/tests/floor_scenario.rs` гоняет маршрутизатор в процессе (`TestApp`, `oneshot`), сокета не открывает и идёт в песочнице; первая сборка тестов хоста на загруженной машине — около полутора минут.
- React 19.2 запускает пассивные эффекты задачей планировщика (`setImmediate`), а `waitFor` после успеха ждёт `setTimeout(0)`: утверждение сразу после ожидания, которое зависит от следующего эффекта или рендера, — скрытый флейк. Поэтому тесты рабочего экрана сканируют и нажимают внутри одного асинхронного `act`, который дожидается ворот работы (`scan`, `press` из `test/support/work-screen.tsx`), ждут подписки сканера (`listening()`), а итог действия, которое кончается после ворот (результат исключения, сводка), ждут через `findBy*`. Порядок «скан до нажатия» проверяется удержанной записью и десятью оборотами `setImmediate` до её отпускания: без очереди сводка успела бы прочитаться раньше записи. Новые и изменённые тестовые файлы с React (задачи 2, 4–7) один раз запускаются с `--reporter=verbose` (в выводе нет `stderr |`) и один раз под стендом с задержкой `setImmediate` на 3 мс — два временных файла внутри пакета, удалить сразу после прогона, до `lint`:

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

- Под сильной нагрузкой машины полный прогон Vitest роняет тайм-аутом 5 с старые тесты офиса, которых план не трогает: на копии плана при средней загрузке около 110 падали `template-editor` (2 теста) ещё на основе плана, а после плана при загрузке 50–75 — `template-editor` (3) и `shifts-page` (2). Это не дефект плана; падение в полном прогоне записывается и разбирается (сверка с основой, отдельный прогон), а не лечится повтором.

**Счёт тестов** (измерено на копии плана; на настоящем дереве числа сдвигаются на тесты, которых на копии нет)

- До плана: Vitest — 106 файлов, 2580 тестов.
- После задач: 1 — 107, 2596; 2 — 108, 2606; 3 — 109, 2618; 4 — 110, 2625; 5 — 110, 2629; 6 — 110, 2632; 7 — 111, 2641; 8 — 112, 2643; 9 — без изменений. Хост: задача 8 добавляет `--test floor_scenario` — 2 теста.
- После: Vitest — 112 файлов, 2643 теста.

## Файлы

Задачи выполняются по порядку: 1–2 — исключения (модель, экран), 3–4 — закрытие смены (модель, сводка), 5 — квитанция и список, 6 — смена, закрытая офисом, 7 — срок хранения, 8 — сквозной сценарий, 9 — документы.

<!-- prettier-ignore -->
```text
apps/standalone/src/floor/exceptions/box-exceptions.ts (новый),
apps/standalone/test/floor-box-exceptions.test.ts (новый)                                задача 1
apps/standalone/src/floor/exceptions/ExceptionFlow.tsx (новый), src/floor/work/WorkScreen.tsx,
apps/standalone/src/app/shell.css, src/i18n/ru.json,
apps/standalone/test/{floor-work-exceptions.test.tsx,support/work-screen.tsx} (новые)    задача 2
apps/standalone/src/floor/close/shift-close.ts (новый), src/floor/facts.ts,
apps/standalone/src/floor/print/print-jobs.ts, test/floor-shift-close.test.ts (новый)    задача 3
apps/standalone/src/floor/close/ShiftClosePanel.tsx (новый), src/floor/work/WorkScreen.tsx,
apps/standalone/src/app/shell.css, src/i18n/ru.json, test/floor-work-close.test.tsx (новый)  задача 4
apps/standalone/src/local/facts-sender.ts, src/floor/close/shift-close.ts,
apps/standalone/src/floor/shifts/{ShiftList,ShiftCard}.tsx, src/floor/FloorApp.tsx, src/app/App.tsx,
apps/standalone/src/i18n/ru.json, test/{facts-sender.test.ts,floor-shift-list.test.tsx,app.test.tsx}  задача 5
apps/standalone/src/floor/{FloorApp.tsx,work/WorkScreen.tsx},
apps/standalone/src/floor/shifts/{shift-copies.ts,shift-entry.ts,ShiftCard.tsx,ShiftList.tsx},
apps/standalone/src/i18n/ru.json,
apps/standalone/test/{floor-app.test.tsx,floor-shift-list.test.tsx,floor-work-close.test.tsx,shift-copies.test.ts}  задача 6
apps/standalone/src/local/retention.ts (новый), src/app/App.tsx,
apps/standalone/test/retention.test.ts (новый), test/app.test.tsx                        задача 7
apps/standalone/proto/fixtures/floor-scenario.json, host/tests/floor_scenario.rs,
apps/standalone/test/floor-scenario.test.ts (новые)                                      задача 8
apps/standalone/AGENTS.md, спецификация этапа (раздел «Уточнения плана 2a8»)             задача 9
```

---

### Task 1: Исключения коробов — модель: снять последний код, очистить, перепечатать, расформировать

Модель исключений §5.7.6 (`src/floor/exceptions/box-exceptions.ts`): каждое — одна `local_transaction` со строкой `floor_exceptions`, записью `box_exception` (через `outboxStatement` плана 2a6) и своими последствиями, со сравнением прочитанного. «Снять последний код» берёт последнюю строку `floor_codes` открытого короба по rowid (порядок принятия, не часы) и пишет в запись её хеш и ровно её `scanned_at` — правило хоста плана 2a2 (снимается только позиция, добавленная в этот момент). «Очистить короб» — все коды короба, `occurredAt` — момент очистки. «Расформировать короб» — `disassembled_at`, коды свободны, SSCC израсходован. «Перепечатать этикетку» — новое задание тем же `prepareLabelJob` (контракт 2a7) с SSCC и полями последнего задания короба, вместе с исключением `reprint` до отправки; ждущая этикетка — `LabelWaitingError`. Слова причины проверяются до записи (`reasonWords`: обрезка, 200 кодовых точек, без управляющих — `validate::exception_reason_text` хоста).

**Files:**

- Create: `apps/standalone/src/floor/exceptions/box-exceptions.ts`
- Test: `apps/standalone/test/floor-box-exceptions.test.ts` (Create)

**Interfaces:**

- Consumes: `BoxContext`, `readOpenBox` (план 2a6), `boxExceptionRecord`, `outboxStatement` (`src/floor/facts.ts`), `prepareLabelJob`, `readPrintJob`, `sendLabelJob`, `isOpenJob`, `RenderLabel` (`src/floor/print/print-jobs.ts`), `ResolveContext` (`print-resolution.ts`), `REPRINT_REASONS`, `DISASSEMBLE_REASONS`, `OTHER_REASON`, `MAX_REASON_TEXT_CHARS` (`src/floor/exception-reasons.ts`, план 2a7); тестовые опоры `test/support/floor-work.ts`, `test/support/printing.ts`.
- Produces:
  - `undoLastCode(context: BoxContext): Promise<OpenBoxResult>`, `clearOpenBox(context): Promise<OpenBoxResult>` — `{ kind: "done"; boxId; itemCount } | { kind: "empty" } | { kind: "stale" }`;
  - `disassembleBox(context, boxId, reason: ExceptionReason<DisassembleReason>): Promise<{ kind: "done"; freed } | { kind: "stale" }>`;
  - `reprintBox(context: ReprintContext, boxId, reason: ExceptionReason<ReprintReason>, settings, render?): Promise<PrintJob>`, `ReprintContext = ResolveContext & Pick<BoxContext, "shift">`;
  - `readClosedBoxes(local, pairing, shiftId): Promise<ClosedBox[]>` (`{ id; sscc; itemCount; closedAt }`, последний закрытый первым);
  - `reasonWords(text: string | null): string | null`, `ExceptionReason<Code>`, ошибки `InvalidReasonError`, `BoxUnavailableError`, `LabelWaitingError`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-box-exceptions.test.ts`:

<!-- prettier-ignore -->
```ts
import { buildSscc } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import {
  BoxUnavailableError,
  clearOpenBox,
  disassembleBox,
  InvalidReasonError,
  LabelWaitingError,
  readClosedBoxes,
  reasonWords,
  reprintBox,
  undoLastCode,
} from "../src/floor/exceptions/box-exceptions.js";
import { readPrintJob, sendLabelJob } from "../src/floor/print/print-jobs.js";
import { closeOpenBox } from "../src/floor/work/box-close.js";
import { processScan, type ScanContext } from "../src/floor/work/scan-pipeline.js";
import { readWorkTotals } from "../src/floor/work/work-reads.js";
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
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import {
  closeBoxWithLabel,
  fakeRender,
  FIRST_SSCC,
  jobRows,
  manualRuntime,
  printStation,
  renderedText,
  resolveContext,
  ZEBRA,
} from "./support/printing.js";

const BLOCK = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";

async function station() {
  const { db, executor } = openLocalDb();
  const shift = await enteredShift(executor);
  seedBlock(db, { blockId: BLOCK, from: 1500, to: 3499 });
  return { db, local: executor, shift };
}

async function fill(context: ScanContext, serials: readonly string[]): Promise<void> {
  for (const serial of serials) await processScan(context, km(serial));
}

/** The outbox's `box_exception` records, oldest first, as they will be sent. */
function exceptionRecords(db: ReturnType<typeof openLocalDb>["db"]): unknown[] {
  return rows(db, "SELECT payload FROM outbox WHERE kind = 'box_exception' ORDER BY seq").map(
    (row) => JSON.parse(String(row["payload"])),
  );
}

function freeCodes(db: ReturnType<typeof openLocalDb>["db"]): string[] {
  return rows(db, "SELECT scan_id FROM floor_codes ORDER BY scanned_at").map((row) =>
    String(row["scan_id"]),
  );
}

describe("the words of a reason", () => {
  it("are trimmed, at most 200 code points, and never hold a control character", () => {
    expect(reasonWords(null)).toBeNull();
    expect(reasonWords("   ")).toBeNull();
    expect(reasonWords("  Смята  ")).toBe("Смята");
    expect(reasonWords("Я".repeat(200))).toBe("Я".repeat(200));
    expect(reasonWords(` ${"Я".repeat(200)} `)).toBe("Я".repeat(200));
    expect(() => reasonWords("Я".repeat(201))).toThrow(InvalidReasonError);
    expect(() => reasonWords("в две\nстроки")).toThrow(InvalidReasonError);
    expect(() => reasonWords("a\u0000b")).toThrow(InvalidReasonError);
    // Code points, not UTF-16 units: the host counts characters.
    expect(reasonWords("😀".repeat(200))).toBe("😀".repeat(200));
    expect(() => reasonWords("😀".repeat(201))).toThrow(InvalidReasonError);
  });
});

describe("«Снять последний код»", () => {
  it("takes out the code accepted last with the instant of its scan, in one write with its record", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1", "A2", "A3"]);
    const [scanOfA3] = rows(
      db,
      "SELECT id, scanned_at, code_hash FROM floor_scans WHERE serial = 'A3'",
    );
    const result = await undoLastCode(context);
    const box = rows(db, "SELECT id, item_count, closed_at FROM floor_boxes");
    expect(result).toEqual({ kind: "done", boxId: box[0]?.["id"], itemCount: 2 });
    expect(box).toEqual([{ id: box[0]?.["id"], item_count: 2, closed_at: null }]);
    expect(
      rows(
        db,
        "SELECT serial FROM floor_scans s JOIN floor_codes c ON c.scan_id = s.id ORDER BY serial",
      ),
    ).toEqual([{ serial: "A1" }, { serial: "A2" }]);
    expect(exceptionRecords(db)).toEqual([
      {
        id: expect.any(String),
        kind: "box_exception",
        shiftId: SHIFT_ID,
        operatorId: OPERATOR_ID,
        data: {
          exception: "undo",
          boxId: box[0]?.["id"],
          codeHash: scanOfA3?.["code_hash"],
          targetScannedAt: scanOfA3?.["scanned_at"],
          reasonCode: null,
          reasonText: null,
          occurredAt: "2026-10-08T06:15:03.000Z",
        },
      },
    ]);
    expect(
      rows(
        db,
        "SELECT shift_id, kind, box_id, code_hash, target_scanned_at, reason_code, reason_text, " +
          "occurred_at, operator_id FROM floor_exceptions",
      ),
    ).toEqual([
      {
        shift_id: SHIFT_ID,
        kind: "undo",
        box_id: box[0]?.["id"],
        code_hash: scanOfA3?.["code_hash"],
        target_scanned_at: scanOfA3?.["scanned_at"],
        reason_code: null,
        reason_text: null,
        occurred_at: "2026-10-08T06:15:03.000Z",
        operator_id: OPERATOR_ID,
      },
    ]);
  });

  it("takes out the code accepted last even when the clock went back between the scans", async () => {
    const { db, local, shift } = await station();
    const times = ["2026-10-08T06:20:00.000Z", "2026-10-08T06:10:00.000Z"];
    const context = scanContext(local, shift, {
      now: () => new Date(times.shift() ?? "2026-10-08T06:30:00.000Z"),
    });
    await fill(context, ["A1", "A2"]);
    await undoLastCode(context);
    expect(
      rows(db, "SELECT serial FROM floor_scans s JOIN floor_codes c ON c.scan_id = s.id"),
    ).toEqual([{ serial: "A1" }]);
  });

  it("frees the code: scanned again, it is accepted, not a duplicate", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1", "A2"]);
    await undoLastCode(context);
    expect(await processScan(context, km("A2"))).toMatchObject({ kind: "accepted", itemCount: 2 });
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 2 }]);
  });

  it("writes nothing for an empty box or none", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    expect(await undoLastCode(context)).toEqual({ kind: "empty" });
    await fill(context, ["A1"]);
    await undoLastCode(context);
    expect(await undoLastCode(context)).toEqual({ kind: "empty" });
    expect(exceptionRecords(db)).toHaveLength(1);
  });

  it("writes nothing when a scan lands between its read and its write", async () => {
    const { db, local, shift } = await station();
    const held = holdingWrites(local);
    await fill(scanContext(local, shift), ["A1", "A2"]);
    held.holdNext();
    const undo = undoLastCode(
      scanContext(held.executor, shift, { newId: () => crypto.randomUUID() }),
    );
    await held.reached();
    await processScan(scanContext(local, shift, { newId: () => crypto.randomUUID() }), km("A3"));
    held.release();
    expect(await undo).toEqual({ kind: "stale" });
    expect(exceptionRecords(db)).toEqual([]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 3 }]);
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 3 }]);
  });
});

describe("«Очистить короб»", () => {
  it("takes every code out of the open box, which stays open for the next one", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1", "A2", "A3"]);
    const result = await clearOpenBox(context);
    const [box] = rows(db, "SELECT id, item_count, closed_at FROM floor_boxes");
    expect(result).toEqual({ kind: "done", boxId: box?.["id"], itemCount: 0 });
    expect(box).toMatchObject({ item_count: 0, closed_at: null });
    expect(freeCodes(db)).toEqual([]);
    expect(exceptionRecords(db)).toEqual([
      expect.objectContaining({
        data: {
          exception: "clear",
          boxId: box?.["id"],
          codeHash: null,
          targetScannedAt: null,
          reasonCode: null,
          reasonText: null,
          occurredAt: "2026-10-08T06:15:03.000Z",
        },
      }),
    ]);
    expect(await processScan(context, km("A1"))).toEqual({
      kind: "accepted",
      boxId: box?.["id"],
      itemCount: 1,
    });
  });

  it("writes nothing when a scan lands between its read and its write", async () => {
    const { db, local, shift } = await station();
    const held = holdingWrites(local);
    await fill(scanContext(local, shift), ["A1", "A2"]);
    held.holdNext();
    const clear = clearOpenBox(
      scanContext(held.executor, shift, { newId: () => crypto.randomUUID() }),
    );
    await held.reached();
    await processScan(scanContext(local, shift, { newId: () => crypto.randomUUID() }), km("A3"));
    held.release();
    expect(await clear).toEqual({ kind: "stale" });
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 3 }]);
    expect(exceptionRecords(db)).toEqual([]);
  });
});

describe("«Расформировать короб»", () => {
  it("takes a closed box apart with its reason: its codes are free, its SSCC stays spent", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1", "A2"]);
    const closed = await closeOpenBox(context);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    const result = await disassembleBox(context, closed.box.boxId, {
      code: "wrong_quantity",
      text: null,
    });
    expect(result).toEqual({ kind: "done", freed: 2 });
    expect(rows(db, "SELECT sscc, disassembled_at FROM floor_boxes")).toEqual([
      { sscc: buildSscc(0, PREFIX, 1500), disassembled_at: "2026-10-08T06:15:03.000Z" },
    ]);
    expect(freeCodes(db)).toEqual([]);
    expect(exceptionRecords(db)).toEqual([
      expect.objectContaining({
        data: {
          exception: "disassemble",
          boxId: closed.box.boxId,
          codeHash: null,
          targetScannedAt: null,
          reasonCode: "wrong_quantity",
          reasonText: null,
          occurredAt: "2026-10-08T06:15:03.000Z",
        },
      }),
    ]);
    const totals = await readWorkTotals(local, PAIRING, SHIFT_ID);
    expect([totals.accepted, totals.closedBoxes]).toEqual([0, 0]);
    expect(await readClosedBoxes(local, PAIRING, SHIFT_ID)).toEqual([]);
    // The freed codes go into a new box, whose close takes the next serial.
    await fill(context, ["A1", "A2"]);
    const next = await closeOpenBox(context);
    expect(next).toMatchObject({ kind: "closed", box: { serial: 1501 } });
  });

  it("keeps the words of `other`, trimmed, and refuses words of any other reason or a code of the other list", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1"]);
    const closed = await closeOpenBox(context);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    await expect(
      disassembleBox(context, closed.box.boxId, { code: "wrong_product", text: "сам выбрал" }),
    ).rejects.toThrow(InvalidReasonError);
    await expect(
      disassembleBox(context, closed.box.boxId, {
        // A reprint's reason is no reason of a disassembly.
        code: "printer_jam" as "other",
        text: null,
      }),
    ).rejects.toThrow(InvalidReasonError);
    await expect(
      disassembleBox(context, closed.box.boxId, { code: "other", text: "Я".repeat(201) }),
    ).rejects.toThrow(InvalidReasonError);
    expect(exceptionRecords(db)).toEqual([]);
    await disassembleBox(context, closed.box.boxId, { code: "other", text: "  Смят угол  " });
    expect(exceptionRecords(db)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ reasonCode: "other", reasonText: "Смят угол" }),
      }),
    ]);
    expect(rows(db, "SELECT reason_code, reason_text FROM floor_exceptions")).toEqual([
      { reason_code: "other", reason_text: "Смят угол" },
    ]);
  });

  it("takes a box apart once when two disassemblies of it race", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await fill(context, ["A1"]);
    const closed = await closeOpenBox(context);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    const held = holdingWrites(local);
    const reason = { code: "damaged_package" as const, text: null };
    held.holdNext();
    const first = disassembleBox(
      scanContext(held.executor, shift, { newId: () => crypto.randomUUID() }),
      closed.box.boxId,
      reason,
    );
    await held.reached();
    await disassembleBox(
      scanContext(local, shift, { newId: () => crypto.randomUUID() }),
      closed.box.boxId,
      reason,
    );
    held.release();
    expect(await first).toEqual({ kind: "stale" });
    expect(exceptionRecords(db)).toHaveLength(1);
  });

  it("refuses an open box, a box taken apart and another shift's box, writing nothing", async () => {
    const { db, local, shift } = await station();
    const second = await enteredShift(local, SECOND);
    const context = scanContext(local, shift);
    await fill(context, ["A1"]);
    const closed = await closeOpenBox(context);
    if (closed.kind !== "closed") throw new Error(closed.kind);
    await fill(context, ["A2"]);
    const [open] = rows(db, "SELECT id FROM floor_boxes WHERE closed_at IS NULL");
    const reason = { code: "wrong_product" as const, text: null };
    await expect(disassembleBox(context, String(open?.["id"]), reason)).rejects.toThrow(
      BoxUnavailableError,
    );
    await expect(
      disassembleBox(scanContext(local, second), closed.box.boxId, reason),
    ).rejects.toThrow(BoxUnavailableError);
    await disassembleBox(context, closed.box.boxId, reason);
    await expect(disassembleBox(context, closed.box.boxId, reason)).rejects.toThrow(
      BoxUnavailableError,
    );
    expect(exceptionRecords(db)).toHaveLength(1);
  });
});

describe("«Перепечатать этикетку» of a box whose label is done with", () => {
  it("prints the same label again: a new job with the box's SSCC and fields, its reason in the same write", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const context = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const first = await sendLabelJob(context, await closeBoxWithLabel(at));
    expect(first.state).toBe("sent");
    const job = await reprintBox(
      { ...context, shift: at.shift },
      first.subjectId,
      { code: "damaged_label", text: null },
      at.settings,
      fakeRender,
    );
    expect(job).toMatchObject({
      purpose: "box",
      subjectId: first.subjectId,
      sscc: FIRST_SSCC,
      state: "sent",
      attempts: 1,
      fields: first.fields,
      templateId: first.templateId,
      templateRev: first.templateRev,
    });
    expect(job.id).not.toBe(first.id);
    expect(shell.sends.map((send) => send.text)).toEqual([
      renderedText(ZEBRA, FIRST_SSCC),
      renderedText(ZEBRA, FIRST_SSCC),
    ]);
    expect(
      rows(at.db, "SELECT kind, box_id, reason_code, reason_text FROM floor_exceptions"),
    ).toEqual([
      { kind: "reprint", box_id: first.subjectId, reason_code: "damaged_label", reason_text: null },
    ]);
    const [record] = rows(at.db, "SELECT payload FROM outbox WHERE kind = 'box_exception'");
    expect(JSON.parse(String(record?.["payload"]))).toMatchObject({
      data: { exception: "reprint", boxId: first.subjectId, reasonCode: "damaged_label" },
    });
  });

  it("writes the job and the reprint's record in one transaction, before the send", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    shell.holdSends();
    const context = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const first = await sendLabelJobSettled(at, context, shell);
    const reprint = reprintBox(
      { ...context, shift: at.shift },
      first.subjectId,
      { code: "unreadable_label", text: null },
      at.settings,
      fakeRender,
    );
    await waitForSend(shell, 2);
    expect(jobRows(at.db).map((row) => row["state"])).toEqual(["sent", "sending"]);
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_exception'")).toEqual([
      { n: 1 },
    ]);
    shell.releaseSend({ sent: true });
    expect((await reprint).state).toBe("sent");
  });

  it("refuses a box whose label still waits, a box taken apart and a box without a job, writing nothing", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const context = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const failed = await sendLabelJob(context, await closeBoxWithLabel(at));
    expect(failed.state).toBe("failed");
    const reason = { code: "damaged_label" as const, text: null };
    await expect(
      reprintBox({ ...context, shift: at.shift }, failed.subjectId, reason, at.settings),
    ).rejects.toThrow(LabelWaitingError);
    await expect(
      reprintBox({ ...context, shift: at.shift }, crypto.randomUUID(), reason, at.settings),
    ).rejects.toThrow(BoxUnavailableError);
    expect(jobRows(at.db)).toHaveLength(1);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_exceptions")).toEqual([{ n: 0 }]);
  });

  it("keeps the job `failed` when no printer is assigned now, for the label's panel", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const context = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const first = await sendLabelJob(context, await closeBoxWithLabel(at));
    const job = await reprintBox(
      { ...context, shift: at.shift },
      first.subjectId,
      { code: "printer_jam", text: null },
      { ...at.settings, assignments: { box: null, pallet: null, duplicate: null } },
      fakeRender,
    );
    expect(job).toMatchObject({ state: "failed", errorCode: "printer_unconfigured" });
    expect(shell.sends).toHaveLength(1);
    expect(await readPrintJob(at.local, PAIRING, job.id)).toMatchObject({ state: "failed" });
  });
});

/** The first label of a box, sent and taken by the printer. */
async function sendLabelJobSettled(
  at: Awaited<ReturnType<typeof printStation>>,
  context: ReturnType<typeof resolveContext>,
  shell: ReturnType<typeof fakeHardware>,
) {
  const sending = sendLabelJob(context, await closeBoxWithLabel(at));
  await waitForSend(shell, 1);
  shell.releaseSend({ sent: true });
  shell.holdSends();
  return sending;
}

/** Resolves once the fake printer holds `count` sends in all. */
async function waitForSend(shell: ReturnType<typeof fakeHardware>, count: number): Promise<void> {
  for (let turn = 0; turn < 200 && shell.sends.length < count; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (shell.sends.length < count) throw new Error(`the printer took ${shell.sends.length} sends`);
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-exceptions.test.ts`
Expected: FAIL — `test/floor-box-exceptions.test.ts` не загружается (`Failed to resolve import "../src/floor/exceptions/box-exceptions.js"`).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/floor/exceptions/box-exceptions.ts`:

<!-- prettier-ignore -->
```ts
import type { LabelTemplateSpec } from "@markiro/domain";
import { z } from "zod";

import type { BoxExceptionFact } from "../../host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import {
  DISASSEMBLE_REASONS,
  MAX_REASON_TEXT_CHARS,
  OTHER_REASON,
  REPRINT_REASONS,
  type DisassembleReason,
  type ReprintReason,
} from "../exception-reasons.js";
import { boxExceptionRecord, outboxStatement } from "../facts.js";
import {
  isOpenJob,
  prepareLabelJob,
  readPrintJob,
  sendLabelJob,
  type PrintJob,
  type RenderLabel,
} from "../print/print-jobs.js";
import type { ResolveContext } from "../print/print-resolution.js";
import type { WorkstationSettings } from "../setup/workstation-settings.js";
import type { BoxContext } from "../work/box-close.js";
import { readOpenBox } from "../work/work-reads.js";

/** The words of a reason that cannot be kept: too long, or with a control character. */
export class InvalidReasonError extends Error {
  constructor() {
    super("the words of the reason cannot be kept");
    this.name = "InvalidReasonError";
  }
}

const CONTROL = /\p{Cc}/u;

/**
 * The words of the reason `other` as the host keeps them
 * (`validate::exception_reason_text`): trimmed, at most 200 code points, no
 * control character, so no line break. Nothing but blanks — no words
 * (`null`); words the host would refuse are refused here, before anything is
 * written, so a record of this station is never refused for them.
 */
export function reasonWords(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if ([...trimmed].length > MAX_REASON_TEXT_CHARS || CONTROL.test(trimmed)) {
    throw new InvalidReasonError();
  }
  return trimmed;
}

/** A reason of a reprint or a disassembly: a code of its kind's list, and words only with `other`. */
export interface ExceptionReason<Code extends string> {
  code: Code;
  text: string | null;
}

/** The checked reason fields of a record: the code, and its words or `null`. */
function reasonFields(
  reasons: readonly string[],
  reason: ExceptionReason<string>,
): { reasonCode: string; reasonText: string | null } {
  if (!reasons.includes(reason.code)) throw new InvalidReasonError();
  const words = reasonWords(reason.text);
  if (words !== null && reason.code !== OTHER_REASON) throw new InvalidReasonError();
  return { reasonCode: reason.code, reasonText: words };
}

/**
 * The station's `floor_exceptions` row and the `box_exception` record of an
 * exception (stage 2a spec §5.7.6): the same fields in both, for the
 * transaction that applies its consequences.
 */
function exceptionStatements(
  context: Pick<BoxContext, "pairing" | "operatorId" | "newId">,
  shiftId: string,
  data: BoxExceptionFact,
): LocalStatement[] {
  const { pairing, operatorId } = context;
  const record = boxExceptionRecord({ id: context.newId(), shiftId, operatorId }, data);
  return [
    {
      sql:
        "INSERT INTO floor_exceptions (id, host_id, device_id, shift_id, kind, box_id, code_hash, " +
        "target_scanned_at, reason_code, reason_text, occurred_at, operator_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      values: [
        context.newId(),
        pairing.hostId,
        pairing.deviceId,
        shiftId,
        data.exception,
        data.boxId,
        data.codeHash,
        data.targetScannedAt,
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

/** Runs the write; a guard that no longer holds is `stale` (nothing was written). */
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
 * How an exception on the open box went: done, with the box and what is left
 * in it; `empty` — no open box, or one without a code, and nothing written;
 * `stale` — the box changed between the read and the write, nothing was
 * written, and the operator may simply try again.
 */
export type OpenBoxResult =
  { kind: "done"; boxId: string; itemCount: number } | { kind: "empty" } | { kind: "stale" };

const lastCodeRow = z.object({
  code_hash: z.string(),
  scan_id: z.string(),
  scanned_at: z.string(),
});

/**
 * «Снять последний код» (stage 2a spec §5.7.6): the code accepted last into
 * the shift's open box — the latest row of `floor_codes` (a row's rowid
 * grows with every insert, the order the codes were accepted in) — leaves
 * the box in ONE transaction: its place in `floor_codes` (the code is free
 * again), one less in the box (only while the box is open and holds what was
 * read: a scan or a close that landed meanwhile makes it `stale`),
 * the station's exception and the `undo` record. The record names the code
 * and the exact instant of its scan as `floor_codes` keeps it — the same
 * text as the scan's record — because the host takes out only the item of
 * that code added at that instant (plan 2a2): an undo that arrives late, or
 * is sent again under a new id, never takes out a later scan of the code.
 */
export async function undoLastCode(context: BoxContext): Promise<OpenBoxResult> {
  const { local, pairing, shift } = context;
  const box = await readOpenBox(local, pairing, shift.copy.id);
  if (box === null || box.itemCount === 0) return { kind: "empty" };
  const [last] = await local.query(
    "SELECT code_hash, scan_id, scanned_at FROM floor_codes " +
      "WHERE host_id = ? AND device_id = ? AND box_id = ? ORDER BY rowid DESC LIMIT 1",
    [pairing.hostId, pairing.deviceId, box.id],
    lastCodeRow,
  );
  if (last === undefined) return { kind: "empty" };
  const at = context.now().toISOString();
  const written = await commit(local, [
    {
      sql:
        "DELETE FROM floor_codes WHERE host_id = ? AND device_id = ? AND code_hash = ? " +
        "AND scan_id = ? AND box_id = ?",
      values: [pairing.hostId, pairing.deviceId, last.code_hash, last.scan_id, box.id],
    },
    {
      sql:
        "UPDATE floor_boxes SET item_count = item_count - 1 WHERE id = ? AND host_id = ? " +
        "AND device_id = ? AND closed_at IS NULL AND item_count = ?",
      values: [box.id, pairing.hostId, pairing.deviceId, box.itemCount],
      expectedChanges: 1,
    },
    ...exceptionStatements(context, shift.copy.id, {
      exception: "undo",
      boxId: box.id,
      codeHash: last.code_hash,
      targetScannedAt: last.scanned_at,
      reasonCode: null,
      reasonText: null,
      occurredAt: at,
    }),
  ]);
  return written === "stale"
    ? { kind: "stale" }
    : { kind: "done", boxId: box.id, itemCount: box.itemCount - 1 };
}

/**
 * «Очистить короб» (stage 2a spec §5.7.6): every code of the shift's open box
 * leaves it in ONE transaction — their places in `floor_codes` (each code is
 * free again), the box emptied (only while it is open and holds what was
 * read), the station's exception and the `clear` record.
 * The box stays open, and the next code goes into it. The record's
 * `occurredAt` is the moment of the clear: the host takes out the items
 * added up to it, never one scanned after it (plan 2a2).
 */
export async function clearOpenBox(context: BoxContext): Promise<OpenBoxResult> {
  const { local, pairing, shift } = context;
  const box = await readOpenBox(local, pairing, shift.copy.id);
  if (box === null || box.itemCount === 0) return { kind: "empty" };
  const at = context.now().toISOString();
  const written = await commit(local, [
    {
      sql: "DELETE FROM floor_codes WHERE host_id = ? AND device_id = ? AND box_id = ?",
      values: [pairing.hostId, pairing.deviceId, box.id],
    },
    {
      sql:
        "UPDATE floor_boxes SET item_count = 0 WHERE id = ? AND host_id = ? AND device_id = ? " +
        "AND closed_at IS NULL AND item_count = ?",
      values: [box.id, pairing.hostId, pairing.deviceId, box.itemCount],
      expectedChanges: 1,
    },
    ...exceptionStatements(context, shift.copy.id, {
      exception: "clear",
      boxId: box.id,
      codeHash: null,
      targetScannedAt: null,
      reasonCode: null,
      reasonText: null,
      occurredAt: at,
    }),
  ]);
  return written === "stale" ? { kind: "stale" } : { kind: "done", boxId: box.id, itemCount: 0 };
}

/** A closed box of the shift, as the exceptions list it. */
export interface ClosedBox {
  id: string;
  sscc: string;
  itemCount: number;
  closedAt: string;
}

const closedBoxRow = z.object({
  id: z.string(),
  sscc: z.string(),
  item_count: z.number().int().nonnegative(),
  closed_at: z.string(),
});

/**
 * The shift's closed boxes not taken apart, the box closed last first: what
 * a reprint or a disassembly can be done to.
 */
export async function readClosedBoxes(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<ClosedBox[]> {
  const rows = await local.query(
    "SELECT id, sscc, item_count, closed_at FROM floor_boxes WHERE host_id = ? AND device_id = ? " +
      "AND shift_id = ? AND closed_at IS NOT NULL AND disassembled_at IS NULL " +
      "ORDER BY closed_at DESC, serial DESC",
    [pairing.hostId, pairing.deviceId, shiftId],
    closedBoxRow,
  );
  return rows.map((row) => ({
    id: row.id,
    sscc: row.sscc,
    itemCount: row.item_count,
    closedAt: row.closed_at,
  }));
}

/** The box is no closed box of this shift that is not taken apart: nothing was written. */
export class BoxUnavailableError extends Error {
  constructor(boxId: string) {
    super(`box ${boxId} is not a closed box of the shift`);
    this.name = "BoxUnavailableError";
  }
}

const boxStateRow = z.object({
  closed_at: z.string().nullable(),
  disassembled_at: z.string().nullable(),
  codes: z.number().int().nonnegative(),
});

/** The box `boxId` of the shift when it is closed and not taken apart, with its codes counted. */
async function readClosedBox(
  context: BoxContext,
  boxId: string,
): Promise<{ codes: number } | null> {
  const { local, pairing, shift } = context;
  const [row] = await local.query(
    "SELECT closed_at, disassembled_at, (SELECT count(*) FROM floor_codes c " +
      "WHERE c.host_id = b.host_id AND c.device_id = b.device_id AND c.box_id = b.id) AS codes " +
      "FROM floor_boxes b WHERE b.id = ? AND b.host_id = ? AND b.device_id = ? AND b.shift_id = ?",
    [boxId, pairing.hostId, pairing.deviceId, shift.copy.id],
    boxStateRow,
  );
  if (row === undefined || row.closed_at === null || row.disassembled_at !== null) return null;
  return { codes: row.codes };
}

/**
 * «Расформировать короб» (stage 2a spec §5.7.6): a closed box of the shift is
 * taken apart in ONE transaction — `disassembled_at` (only while it is closed
 * and not taken apart), every code of it out of `floor_codes` (each is free
 * again and may be scanned into another box), the station's exception and
 * the `disassemble` record with its reason. The box keeps its SSCC: the
 * number is spent and never goes on another box. It no longer counts among
 * the shift's closed boxes. `stale` — the box changed meanwhile, nothing
 * written; a box that is open, taken apart or another shift's —
 * `BoxUnavailableError`.
 */
export async function disassembleBox(
  context: BoxContext,
  boxId: string,
  reason: ExceptionReason<DisassembleReason>,
): Promise<{ kind: "done"; freed: number } | { kind: "stale" }> {
  const fields = reasonFields(DISASSEMBLE_REASONS, reason);
  const box = await readClosedBox(context, boxId);
  if (box === null) throw new BoxUnavailableError(boxId);
  const { local, pairing, shift } = context;
  const at = context.now().toISOString();
  const written = await commit(local, [
    {
      sql:
        "UPDATE floor_boxes SET disassembled_at = ? WHERE id = ? AND host_id = ? AND device_id = ? " +
        "AND closed_at IS NOT NULL AND disassembled_at IS NULL",
      values: [at, boxId, pairing.hostId, pairing.deviceId],
      expectedChanges: 1,
    },
    {
      sql: "DELETE FROM floor_codes WHERE host_id = ? AND device_id = ? AND box_id = ?",
      values: [pairing.hostId, pairing.deviceId, boxId],
    },
    ...exceptionStatements(context, shift.copy.id, {
      exception: "disassemble",
      boxId,
      codeHash: null,
      targetScannedAt: null,
      ...fields,
      occurredAt: at,
    }),
  ]);
  return written === "stale" ? { kind: "stale" } : { kind: "done", freed: box.codes };
}

/** The box's label still waits (its print job): the work screen decides it first. */
export class LabelWaitingError extends Error {
  constructor(boxId: string) {
    super(`the label of box ${boxId} still waits`);
    this.name = "LabelWaitingError";
  }
}

const lastJobRow = z.object({ id: z.string() });

/** What a reprint needs: the decisions' context, the shift and its snapshot. */
export type ReprintContext = ResolveContext & Pick<BoxContext, "shift">;

/**
 * «Перепечатать этикетку» of a closed box whose label is done with (stage
 * 2a spec §5.7.6; plan 2a7's contract): a new print job of the same label —
 * the SSCC and the fields of the box's last job, the shift snapshot's
 * template of the job's own revision, the printer of the purpose «Короб» now
 * — is written in ONE transaction with the station's exception and the
 * `reprint` record and its reason, so the office sees that the box may carry
 * two labels of one SSCC; then the job goes to the printer once, as a first
 * send. A box whose label still waits is decided at the label's panel
 * (`LabelWaitingError`); a box open, taken apart or another shift's —
 * `BoxUnavailableError`. No printer or no render: the job is kept `failed`
 * and the label's panel takes it from there. Answers the new job.
 */
export async function reprintBox(
  context: ReprintContext,
  boxId: string,
  reason: ExceptionReason<ReprintReason>,
  settings: Pick<WorkstationSettings, "printers" | "assignments" | "verifyPrintedLabel">,
  render?: RenderLabel,
): Promise<PrintJob> {
  const fields = reasonFields(REPRINT_REASONS, reason);
  const { local, pairing, shift } = context;
  if ((await readClosedBox(context, boxId)) === null) throw new BoxUnavailableError(boxId);
  const [row] = await local.query(
    "SELECT id FROM floor_print_jobs WHERE host_id = ? AND device_id = ? AND purpose = 'box' " +
      "AND subject_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    [pairing.hostId, pairing.deviceId, boxId],
    lastJobRow,
  );
  const last = row === undefined ? null : await readPrintJob(local, pairing, row.id);
  if (last === null) throw new BoxUnavailableError(boxId);
  if (isOpenJob(last)) throw new LabelWaitingError(boxId);
  const { boxTemplate } = shift.snapshot;
  if (boxTemplate.id !== last.templateId || boxTemplate.rev !== last.templateRev) {
    throw new BoxUnavailableError(boxId);
  }
  const template: { id: string; rev: number; spec: LabelTemplateSpec } = {
    id: boxTemplate.id,
    rev: boxTemplate.rev,
    spec: boxTemplate.spec,
  };
  const at = context.now().toISOString();
  const jobId = context.newId();
  const job = await prepareLabelJob(
    {
      id: jobId,
      shiftId: shift.copy.id,
      purpose: "box",
      subjectId: boxId,
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
    ...exceptionStatements(context, shift.copy.id, {
      exception: "reprint",
      boxId,
      codeHash: null,
      targetScannedAt: null,
      ...fields,
      occurredAt: at,
    }),
  ]);
  const kept = await readPrintJob(local, pairing, jobId);
  if (kept === null) throw new BoxUnavailableError(boxId);
  return kept.state === "prepared" ? sendLabelJob(context, kept) : kept;
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-exceptions.test.ts`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  16 passed (16)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  107 passed (107)`, `Tests  2596 passed (2596)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — запись `undo` несёт момент снятия, а не момент скана снимаемого кода.
В `apps/standalone/src/floor/exceptions/box-exceptions.ts` фрагмент

<!-- prettier-ignore -->
```ts
      targetScannedAt: last.scanned_at,
```

заменить на:

<!-- prettier-ignore -->
```ts
      targetScannedAt: at,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-exceptions.test.ts`
Expected: FAIL — «takes out the code accepted last with the instant of its scan, in one write with its record».

М2 — «последний код» выбирается по часам, а не по порядку принятия.
В `apps/standalone/src/floor/exceptions/box-exceptions.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "WHERE host_id = ? AND device_id = ? AND box_id = ? ORDER BY rowid DESC LIMIT 1",
```

заменить на:

<!-- prettier-ignore -->
```ts
      "WHERE host_id = ? AND device_id = ? AND box_id = ? ORDER BY scanned_at DESC LIMIT 1",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-exceptions.test.ts`
Expected: FAIL — «takes out the code accepted last even when the clock went back between the scans».

М3 — снятие кода не сравнивает число кодов в коробе с прочитанным.
В `apps/standalone/src/floor/exceptions/box-exceptions.ts` фрагмент

<!-- prettier-ignore -->
```ts
        "AND device_id = ? AND closed_at IS NULL AND item_count = ?",
      values: [box.id, pairing.hostId, pairing.deviceId, box.itemCount],
```

заменить на:

<!-- prettier-ignore -->
```ts
        "AND device_id = ? AND closed_at IS NULL AND ? IS NOT NULL",
      values: [box.id, pairing.hostId, pairing.deviceId, box.itemCount],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-exceptions.test.ts`
Expected: FAIL — «writes nothing when a scan lands between its read and its write».

М4 — очистка не сравнивает число кодов в коробе с прочитанным.
В `apps/standalone/src/floor/exceptions/box-exceptions.ts` фрагмент

<!-- prettier-ignore -->
```ts
        "AND closed_at IS NULL AND item_count = ?",
      values: [box.id, pairing.hostId, pairing.deviceId, box.itemCount],
      expectedChanges: 1,
    },
    ...exceptionStatements(context, shift.copy.id, {
      exception: "clear",
```

заменить на:

<!-- prettier-ignore -->
```ts
        "AND closed_at IS NULL AND ? IS NOT NULL",
      values: [box.id, pairing.hostId, pairing.deviceId, box.itemCount],
      expectedChanges: 1,
    },
    ...exceptionStatements(context, shift.copy.id, {
      exception: "clear",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-exceptions.test.ts`
Expected: FAIL — «writes nothing when a scan lands between its read and its write».

М5 — расформирование не проверяет, что короб ещё не расформирован.
В `apps/standalone/src/floor/exceptions/box-exceptions.ts` фрагмент

<!-- prettier-ignore -->
```ts
        "AND closed_at IS NOT NULL AND disassembled_at IS NULL",
```

заменить на:

<!-- prettier-ignore -->
```ts
        "AND closed_at IS NOT NULL",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-exceptions.test.ts`
Expected: FAIL — «takes a box apart once when two disassemblies of it race».

М6 — расформирование не освобождает коды короба.
В `apps/standalone/src/floor/exceptions/box-exceptions.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
    {
      sql: "DELETE FROM floor_codes WHERE host_id = ? AND device_id = ? AND box_id = ?",
      values: [pairing.hostId, pairing.deviceId, boxId],
    },
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-exceptions.test.ts`
Expected: FAIL — «takes a closed box apart with its reason: its codes are free, its SSCC stays spent».

М7 — слова причины принимаются не только при «Другой причине».
В `apps/standalone/src/floor/exceptions/box-exceptions.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (words !== null && reason.code !== OTHER_REASON) throw new InvalidReasonError();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-exceptions.test.ts`
Expected: FAIL — «keeps the words of `other`, trimmed, and refuses words of any other reason or a code of the other list».

М8 — длина слов причины считается в единицах UTF-16, а не в кодовых точках.
В `apps/standalone/src/floor/exceptions/box-exceptions.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if ([...trimmed].length > MAX_REASON_TEXT_CHARS || CONTROL.test(trimmed)) {
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (trimmed.length > MAX_REASON_TEXT_CHARS || CONTROL.test(trimmed)) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-exceptions.test.ts`
Expected: FAIL — «are trimmed, at most 200 code points, and never hold a control character».

М9 — запись перепечатки пишется своей транзакцией после отправки.
В `apps/standalone/src/floor/exceptions/box-exceptions.ts` фрагмент 1

<!-- prettier-ignore -->
```ts
  await local.transaction([
    job,
    ...exceptionStatements(context, shift.copy.id, {
```

заменить на:

<!-- prettier-ignore -->
```ts
  const reprinted = exceptionStatements(context, shift.copy.id, {
```

В `apps/standalone/src/floor/exceptions/box-exceptions.ts` фрагмент 2

<!-- prettier-ignore -->
```ts
      occurredAt: at,
    }),
  ]);
  const kept = await readPrintJob(local, pairing, jobId);
```

заменить на:

<!-- prettier-ignore -->
```ts
      occurredAt: at,
    });
  await local.transaction([job]);
  const kept = await readPrintJob(local, pairing, jobId);
```

В `apps/standalone/src/floor/exceptions/box-exceptions.ts` фрагмент 3

<!-- prettier-ignore -->
```ts
  return kept.state === "prepared" ? sendLabelJob(context, kept) : kept;
```

заменить на:

<!-- prettier-ignore -->
```ts
  const sent = kept.state === "prepared" ? await sendLabelJob(context, kept) : kept;
  await local.transaction(reprinted);
  return sent;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-exceptions.test.ts`
Expected: FAIL — «writes the job and the reprint's record in one transaction, before the send».

М10 — перепечатка короба, чья этикетка ещё ждёт.
В `apps/standalone/src/floor/exceptions/box-exceptions.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (isOpenJob(last)) throw new LabelWaitingError(boxId);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-box-exceptions.test.ts`
Expected: FAIL — «refuses a box whose label still waits, a box taken apart and a box without a job, writing nothing».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/exceptions/box-exceptions.ts apps/standalone/test/floor-box-exceptions.test.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/exceptions/box-exceptions.ts apps/standalone/test/floor-box-exceptions.test.ts
git commit -m "feat(standalone): box exceptions on the floor — undo, clear, reprint and disassemble, each one write with its record" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Экран исключений — короб сканом или последними цифрами, причины, подтверждения

Экран исключений рабочего экрана (`src/floor/exceptions/ExceptionFlow.tsx`, порт облачного `ExceptionFlow` на `@markiro/ui`): остановка `exceptions` в `Stop` рабочего экрана, открывается только когда работу ничто не держит. Шаги — действие, короб (скан его этикетки — не журналируется — или последние цифры SSCC на клавиатуре из кнопок 64 px; список — не больше 12), причина кнопками, слова «Другой причины» полем ввода (пока оно в фокусе, источник сканов молчит), подтверждение, результат. Каждое действие — следующая работа очереди, отданная воротам работы; новая этикетка перепечатки, которая ждёт, сразу показывает свою панель. «Назад» — на каждом шаге, кроме мгновения записи; «Выйти из смены» остаётся вне экрана.

**Files:**

- Create: `apps/standalone/src/floor/exceptions/ExceptionFlow.tsx`
- Modify: `apps/standalone/src/app/shell.css`, `apps/standalone/src/floor/work/WorkScreen.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-work-exceptions.test.tsx` (Create), `apps/standalone/test/support/work-screen.tsx` (Create)

**Interfaces:**

- Consumes: задача 1 (`undoLastCode`, `clearOpenBox`, `disassembleBox`, `reprintBox`, `readClosedBoxes`, `reasonWords`, ошибки); `WorkScreen` и его `Stop`, `queue`, `track`, `showLabel`, `printContext` (планы 2a6, 2a7); `ScanSource.setManualTextEntryActive` (план 2a6).
- Produces:
  - `ExceptionFlow` (`openItems`, `boxes`, `onUndo`, `onClear`, `onReprint`, `onDisassemble`, `registerScan`, `onTextEntry`, `onBack`), `ExceptionOutcome`, `ExceptionAction`, `boxesByTail`, `MAX_LISTED_BOXES`;
  - `Stop` += `{ kind: "exceptions"; boxes: readonly ClosedBox[] | null }`; кнопка «Исключения»; ключи `floor.exceptions.*`; опора тестов `test/support/work-screen.tsx` (`renderWork`, `fakeSource`, `lastLine`, `SESSION`).

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-work-exceptions.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { buildSscc, formatSsccHri } from "@markiro/domain";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { boxesByTail, MAX_LISTED_BOXES } from "../src/floor/exceptions/ExceptionFlow.js";
import type { ClosedBox } from "../src/floor/exceptions/box-exceptions.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { failingWrites, holdingWrites, km, PREFIX, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import {
  FIRST_SSCC,
  jobRows,
  printStation,
  renderedText,
  setUpPrinting,
  ZEBRA,
} from "./support/printing.js";
import { lastLine, renderWork } from "./support/work-screen.js";

type Station = Awaited<ReturnType<typeof printStation>>;
type Work = ReturnType<typeof renderWork>;

const SECOND_SSCC = buildSscc(0, PREFIX, 1501);

async function scanAll(work: Work, serials: readonly string[]): Promise<void> {
  await work.scanner.listening();
  await work.settled();
  for (const serial of serials) await work.scan(km(serial));
}

/** Twelve codes: the box fills, closes by itself, and its label is printed. */
async function fillBox(work: Work, prefix: string): Promise<void> {
  await scanAll(
    work,
    Array.from({ length: 12 }, (_, index) => `${prefix}${index}`),
  );
}

function scans(at: Station): unknown {
  return rows(at.db, "SELECT count(*) AS n FROM floor_scans")[0]?.["n"];
}

function exceptionKinds(at: Station): unknown[] {
  return rows(
    at.db,
    "SELECT kind, reason_code, reason_text FROM floor_exceptions ORDER BY occurred_at",
  );
}

function region() {
  return within(screen.getByRole("region", { name: "Исключения" }));
}

describe("the list of closed boxes by the last digits of their SSCC", () => {
  it("shows the boxes that end with the digits, at most twelve, and counts the rest", () => {
    const boxes: ClosedBox[] = Array.from({ length: 15 }, (_, index) => ({
      id: String(index),
      sscc: buildSscc(0, PREFIX, 1500 + index),
      itemCount: 12,
      closedAt: "2026-10-08T06:15:00.000Z",
    }));
    expect(boxesByTail(boxes, "")).toEqual({ shown: boxes.slice(0, MAX_LISTED_BOXES), hidden: 3 });
    const tail = SECOND_SSCC.slice(-4);
    expect(boxesByTail(boxes, tail)).toEqual({ shown: [boxes[1]], hidden: 0 });
    expect(boxesByTail(boxes, "x")).toEqual({ shown: [], hidden: 0 });
  });
});

describe("the exceptions of the work screen", () => {
  it("takes the last code out of the open box, and the work goes on", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1", "A2", "A3"]);
    await work.press("Исключения");
    expect(await screen.findByRole("region", { name: "Исключения" })).toBeTruthy();
    await work.press("Снять последний код");
    expect(await screen.findByText("Последний код снят из короба.")).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([{ kind: "undo", reason_code: null, reason_text: null }]);
    expect(work.props.onRecorded).toHaveBeenCalled();
    await work.press("Вернуться к работе");
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
    expect(screen.getByText("2 из 12")).toBeTruthy();
    await work.scan(km("A3"));
    expect(screen.getByText("3 из 12")).toBeTruthy();
  });

  it("clears the open box only after the operator confirms", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1", "A2"]);
    await work.press("Исключения");
    await work.press("Очистить короб");
    expect(screen.getByText("Очистить короб?")).toBeTruthy();
    await work.press("Назад");
    expect(exceptionKinds(at)).toEqual([]);
    await work.press("Очистить короб");
    await work.press("Очистить короб");
    expect(await screen.findByText("Короб очищен.")).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([{ kind: "clear", reason_code: null, reason_text: null }]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 0 }]);
  });

  it("takes apart a box chosen by a scan of its label, with a reason; a scan there is never journalled", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    expect(work.shell.sends).toHaveLength(1);
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать короб" });
    await work.press("Расформировать короб");
    expect(screen.getByText("Какой короб расформировать?")).toBeTruthy();
    await work.scan(km("P99"));
    expect(screen.getByText("Это не код SSCC. Отсканируйте этикетку короба.")).toBeTruthy();
    await work.scan(`]C100${SECOND_SSCC}`);
    expect(screen.getByText("Короба с этим SSCC нет среди закрытых коробов смены.")).toBeTruthy();
    expect(scans(at)).toBe(12);
    await work.scan(`]C100${FIRST_SSCC}`);
    expect(screen.getByText(`Короб ${formatSsccHri(FIRST_SSCC)}`)).toBeTruthy();
    await work.press("Неверное количество");
    expect(screen.getByText("Расформировать короб?")).toBeTruthy();
    expect(screen.getByText("Причина: Неверное количество")).toBeTruthy();
    await work.press("Расформировать");
    expect(await screen.findByText("Короб расформирован, его коды свободны.")).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([
      { kind: "disassemble", reason_code: "wrong_quantity", reason_text: null },
    ]);
    expect(scans(at)).toBe(12);
    await work.press("Вернуться к работе");
    // The box's codes are free again: scanned again, they are accepted.
    await work.scan(km("P1"));
    expect(screen.getByText("1 из 12")).toBeTruthy();
  });

  it("prints a box's label again chosen by the last digits, with the words of «Другая причина»", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    await fillBox(work, "Q");
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Перепечатать этикетку" });
    await work.press("Перепечатать этикетку");
    const pad = within(screen.getByRole("group", { name: "Последние цифры SSCC" }));
    expect(
      screen.getByRole("button", { name: `${formatSsccHri(SECOND_SSCC)} · 12 шт.` }),
    ).toBeTruthy();
    for (const digit of FIRST_SSCC.slice(-2))
      fireEvent.click(pad.getByRole("button", { name: digit }));
    expect(
      screen.queryByRole("button", { name: `${formatSsccHri(SECOND_SSCC)} · 12 шт.` }),
    ).toBeNull();
    await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
    await work.press("Другая причина");
    const words = screen.getByLabelText("Причина своими словами (необязательно)");
    fireEvent.focus(words);
    expect(work.scanner.textEntry.at(-1)).toBe(true);
    fireEvent.change(words, { target: { value: "Я".repeat(201) } });
    await work.press("Дальше");
    expect(screen.getByText("Не больше 200 знаков, одной строкой.")).toBeTruthy();
    fireEvent.change(words, { target: { value: "  Смазалась при укладке  " } });
    fireEvent.blur(words);
    expect(work.scanner.textEntry.at(-1)).toBe(false);
    await work.press("Дальше");
    expect(screen.getByText("Причина: Смазалась при укладке")).toBeTruthy();
    await work.press("Перепечатать");
    expect(await screen.findByText("Этикетка отправлена на принтер.")).toBeTruthy();
    expect(work.shell.sends.at(-1)).toEqual({
      target: ZEBRA.target,
      text: renderedText(ZEBRA, FIRST_SSCC),
    });
    expect(exceptionKinds(at)).toEqual([
      { kind: "reprint", reason_code: "other", reason_text: "Смазалась при укладке" },
    ]);
  });

  it("stops at a reprinted label that waits for its check", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    await setUpPrinting(at.local, { verifyPrintedLabel: true });
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Перепечатать этикетку" });
    await work.press("Перепечатать этикетку");
    await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
    await work.press("Этикетка повреждена");
    await work.press("Перепечатать");
    expect(await screen.findByText("Проверьте этикетку")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
    expect(jobRows(at.db).map((job) => job["state"])).toEqual(["sent", "sent"]);
    await work.scan(`]C100${FIRST_SSCC}`);
    expect(screen.queryByText("Проверьте этикетку")).toBeNull();
  });

  it("hands its write to the floor's work gate: leaving the shift waits for it", async () => {
    const at = await printStation();
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await scanAll(work, ["A1"]);
    await work.press("Исключения");
    held.holdNext();
    fireEvent.click(screen.getByRole("button", { name: "Снять последний код" }));
    await held.reached();
    expect(work.gate.pending()).toBe(1);
    expect(screen.getByText("Выполняем…")).toBeTruthy();
    held.release();
    await work.settled();
    expect(work.gate.pending()).toBe(0);
    expect(await screen.findByText("Последний код снят из короба.")).toBeTruthy();
  });

  it("takes no ordinary scan while it is open, and says so", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1"]);
    await work.press("Исключения");
    await work.scan(km("A2"));
    expect(lastLine()).toBe(
      "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.",
    );
    expect(scans(at)).toBe(1);
  });

  it("says a failed write and lets the operator choose again or go back to the work", async () => {
    const at = await printStation();
    let broken = false;
    const local: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: (statements) =>
        broken ? failingWrites(at.local).transaction(statements) : at.local.transaction(statements),
    };
    const work = renderWork({ local, shift: at.shift });
    await scanAll(work, ["A1"]);
    await work.press("Исключения");
    broken = true;
    await work.press("Снять последний код");
    expect(
      await screen.findByText(
        "Не удалось записать исключение на этом компьютере. Ничего не сделано.",
      ),
    ).toBeTruthy();
    await work.press("Другое действие");
    expect(region().getByRole("button", { name: "Снять последний код" })).toBeTruthy();
    await work.press("Назад");
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
    expect(exceptionKinds(at)).toEqual([]);
  });

  it("opens neither at a label that waits nor while the operator leaves; «Выйти из смены» stays open in it", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const work = renderWork(at, { shell });
    await fillBox(work, "P");
    expect(screen.getByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Исключения" }).hasAttribute("disabled")).toBe(true);
    await work.press("Продолжить без этикетки");
    await work.press("Продолжить без этикетки");
    await work.press("Исключения");
    expect(screen.getByRole("button", { name: "Выйти из смены" }).hasAttribute("disabled")).toBe(
      false,
    );
    await work.press("Назад");
    work.rerender({ leaving: true });
    expect(screen.getByRole("button", { name: "Исключения" }).hasAttribute("disabled")).toBe(true);
  });
});
```

Создать `apps/standalone/test/support/work-screen.tsx`:

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";

import { ThemeProvider, type SignalTone } from "@markiro/ui";

import type { FloorSession } from "../../src/app/shell.js";
import type { PrintRuntime } from "../../src/floor/print/print-runtime.js";
import type { ScanListener, ScanSource } from "../../src/floor/scan-source.js";
import type { WorkShift } from "../../src/floor/shifts/shift-copies.js";
import { createWorkGate, type WorkGate } from "../../src/floor/work-gate.js";
import { WorkScreen, type WorkScreenProps } from "../../src/floor/work/WorkScreen.js";
import { createSystemAwake } from "../../src/hardware/awake.js";
import type { CodeCheck, SsccBlockRequest } from "../../src/host/protocol.js";
import type { LocalExecutor } from "../../src/local/executor.js";
import { OPERATOR_ID, PAIRING } from "./floor-work.js";
import { fakeHardware } from "./hardware.js";
import { manualRuntime, renderedText } from "./printing.js";

/** Anna's session on the floor. */
export const SESSION: FloorSession = {
  id: OPERATOR_ID,
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
  sessionId: 1,
};

/** A scanner the test reads codes into; it knows whether the screen asked for text entry. */
export function fakeSource() {
  let listener: ScanListener | null = null;
  const textEntry: boolean[] = [];
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    clearPendingInput: () => undefined,
    setManualTextEntryActive: (active) => {
      textEntry.push(active);
    },
  };
  return {
    source,
    textEntry,
    listening: () =>
      waitFor(() => {
        if (listener === null) throw new Error("the work screen does not listen yet");
      }),
    emit: (raw: string) => listener?.(raw),
  };
}

export interface WorkOptions {
  shell?: ReturnType<typeof fakeHardware>;
  runtime?: PrintRuntime;
  onLeave?: () => void;
  overrides?: Partial<WorkScreenProps>;
}

/** What a test drives the work screen with. */
export interface WorkHarness {
  view: RenderResult;
  gate: WorkGate;
  props: WorkScreenProps;
  scanner: ReturnType<typeof fakeSource>;
  shell: ReturnType<typeof fakeHardware>;
  /** The screen again with some props changed. */
  rerender: (next: Partial<WorkScreenProps>) => void;
  /** Waits for the work the screen has started. */
  settled: () => Promise<void>;
  /** A scan, and the work it started. */
  scan: (raw: string) => Promise<void>;
  /** A press of the button named so, and the work it started. */
  press: (name: string) => Promise<void>;
}

/**
 * The work screen of `at.shift` over `at.local`, printing through `shell` (a
 * printer that takes every label by default) with a render that writes
 * plain text; `scan` and `press` act and wait for the work they started.
 */
export function renderWork(
  at: { local: LocalExecutor; shift: WorkShift },
  options: WorkOptions = {},
): WorkHarness {
  const gate = createWorkGate();
  const scanner = fakeSource();
  const shell = options.shell ?? fakeHardware();
  const runtime = options.runtime ?? manualRuntime(shell.hardware).runtime;
  const props: WorkScreenProps = {
    shift: at.shift,
    operator: SESSION,
    pairing: PAIRING,
    local: at.local,
    online: false,
    track: gate.track,
    touch: vi.fn(),
    onLeave: options.onLeave ?? vi.fn(),
    leaving: false,
    source: scanner.source,
    checkCode: vi.fn(async (): Promise<CodeCheck> => ({ status: "free" })),
    requestBlock: vi.fn(async (request: SsccBlockRequest) => ({
      id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      issuerPrefix: request.issuerPrefix,
      extension: request.extension,
      fromSerial: 1500,
      toSerial: 3499,
    })),
    onHostError: vi.fn(),
    onRecorded: vi.fn(),
    signal: vi.fn<(tone: SignalTone) => void>(),
    printing: runtime,
    awake: createSystemAwake(vi.fn(async (_awake: boolean) => undefined)),
    render: async (spec, fields, printer) => {
      const text = renderedText(printer, fields.sscc, `${spec.widthMm}x${spec.heightMm}`);
      const bytes = new Uint8Array(text.length);
      for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
      return bytes;
    },
    ...options.overrides,
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
    shell,
    rerender: (next: Partial<WorkScreenProps>) =>
      view.rerender(
        <ThemeProvider>
          <WorkScreen {...props} {...next} />
        </ThemeProvider>,
      ),
    settled: () =>
      act(async () => {
        await gate.drain();
      }),
    scan: (raw: string) =>
      act(async () => {
        scanner.emit(raw);
        await gate.drain();
      }),
    press: (name: string) =>
      act(async () => {
        fireEvent.click(screen.getByRole("button", { name }));
        await gate.drain();
      }),
  };
}

/** The last scan, as the screen says it. */
export function lastLine(): string | null {
  return document.querySelector(".work-screen__last")?.textContent ?? null;
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-exceptions.test.tsx`
Expected: FAIL — `test/floor-work-exceptions.test.tsx` не загружается (`Failed to resolve import "../src/floor/exceptions/ExceptionFlow.js"`).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/app/shell.css`:

Фрагмент 1:

<!-- prettier-ignore -->
```css
}

/* The workstation setup (plan 2a7): one printer a row, its actions under it. */
```

заменить на:

<!-- prettier-ignore -->
```css
}

/* The exceptions of the work screen (plan 2a8): the steps under one heading,
   and the last digits of a box's SSCC typed on a pad of 64 px keys. */
.exceptions {
  display: grid;
  gap: 16px;
}

.exceptions h3,
.exceptions h4 {
  margin: 0;
}

.exceptions__pad {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
}

/* The workstation setup (plan 2a7): one printer a row, its actions under it. */
```

Создать `apps/standalone/src/floor/exceptions/ExceptionFlow.tsx`:

<!-- prettier-ignore -->
```tsx
import { formatSsccHri, parseScannedSscc } from "@markiro/domain";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input } from "@markiro/ui";

import {
  DISASSEMBLE_REASONS,
  OTHER_REASON,
  REPRINT_REASONS,
  type DisassembleReason,
  type ReprintReason,
} from "../exception-reasons.js";
import { formatQuantity } from "../shifts/shift-text.js";
import {
  InvalidReasonError,
  reasonWords,
  type ClosedBox,
  type ExceptionReason,
} from "./box-exceptions.js";

/** The four exceptions of a box (stage 2a spec §5.7.6). */
export type ExceptionAction = "undo" | "clear" | "reprint" | "disassemble";

/**
 * How an exception went, as the screen says it: done; a reprint whose new
 * label now waits (the work screen shows it); nothing to take out; the box
 * changed meanwhile; the box is no longer a closed box of the shift; its
 * label still waits; or this computer could not write. Nothing but `done`
 * and `label` wrote anything.
 */
export type ExceptionOutcome =
  | { kind: "done"; action: ExceptionAction }
  | { kind: "label" }
  | { kind: "empty" }
  | { kind: "stale" }
  | { kind: "unavailable" }
  | { kind: "label_waiting" }
  | { kind: "failed" };

/** A reason of its action's list. */
type Reasoned =
  | { action: "reprint"; reason: ExceptionReason<ReprintReason> }
  | { action: "disassemble"; reason: ExceptionReason<DisassembleReason> };

type BoxAction = Reasoned["action"];

type Stage =
  | { kind: "actions" }
  | { kind: "confirm_clear" }
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
  return {
    shown: matching.slice(0, MAX_LISTED_BOXES),
    hidden: Math.max(0, matching.length - MAX_LISTED_BOXES),
  };
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] as const;

export interface ExceptionFlowProps {
  /** Codes in the shift's open box: «Снять последний код» and «Очистить короб» need some. */
  openItems: number;
  /** The shift's closed boxes not taken apart, the last first; `null` while they are read. */
  boxes: readonly ClosedBox[] | null;
  onUndo: () => Promise<ExceptionOutcome>;
  onClear: () => Promise<ExceptionOutcome>;
  onReprint: (boxId: string, reason: ExceptionReason<ReprintReason>) => Promise<ExceptionOutcome>;
  onDisassemble: (
    boxId: string,
    reason: ExceptionReason<DisassembleReason>,
  ) => Promise<ExceptionOutcome>;
  /**
   * Hands the work screen the scan listener of the box choice (`null` — none):
   * while a box is chosen a scan of its label picks it, and is never
   * journalled.
   */
  registerScan: (listener: ((raw: string) => void) | null) => void;
  /** A text field takes typing (`true`) or gives it back: a keyboard scanner's keys are not a scan then. */
  onTextEntry: (active: boolean) => void;
  /** Back to the work: never held, whatever the screen shows. */
  onBack: () => void;
}

/**
 * The exceptions of the work screen (stage 2a spec §5.7.6, the cloud
 * station's `ExceptionFlow`): take the last code out of the open box, clear
 * it, print a closed box's label again, take a closed box apart. A closed
 * box is chosen by a scan of its label or by the last digits of its SSCC on
 * a pad of 64 px keys (a text field would take a keyboard scanner's keys); a
 * reprint and a disassembly need a reason of their list, with words only for
 * «Другая причина»; a clear, a reprint and a disassembly are confirmed. Each
 * action runs as the line's next piece of work and says how it went. «Назад»
 * is there at every step but while an action writes.
 */
export function ExceptionFlow({
  openItems,
  boxes,
  onUndo,
  onClear,
  onReprint,
  onDisassemble,
  registerScan,
  onTextEntry,
  onBack,
}: ExceptionFlowProps) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>({ kind: "actions" });
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // What a scan of the box choice reads when it lands.
  const current = useRef({ stage, boxes });
  useLayoutEffect(() => {
    current.current = { stage, boxes };
  });

  const choosing = stage.kind === "target";
  useEffect(() => {
    if (!choosing) return;
    registerScan((raw) => {
      const now = current.current.stage;
      if (now.kind !== "target") return;
      const sscc = parseScannedSscc(raw);
      if (sscc === null) {
        setStage({ ...now, note: "not_sscc" });
        return;
      }
      const box = current.current.boxes?.find((candidate) => candidate.sscc === sscc);
      setStage(
        box === undefined
          ? { ...now, note: "not_found" }
          : { kind: "reason", action: now.action, box },
      );
    });
    return () => registerScan(null);
  }, [choosing, registerScan]);
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
      if (reason !== undefined) {
        setStage({ kind: "confirm", box, reasoned: { action, reason: { code: reason, text } } });
      }
      return;
    }
    const reason = DISASSEMBLE_REASONS.find((candidate) => candidate === code);
    if (reason !== undefined) {
      setStage({ kind: "confirm", box, reasoned: { action, reason: { code: reason, text } } });
    }
  };

  const back = (to: Stage | null) => (
    <Button
      size="floor"
      variant="secondary"
      onClick={() => (to === null ? onBack() : setStage(to))}
    >
      {t("floor.exceptions.back")}
    </Button>
  );

  const title = t("floor.exceptions.title");
  const body = () => {
    switch (stage.kind) {
      case "actions": {
        const closed = boxes ?? [];
        const nothing = openItems === 0 && boxes !== null && closed.length === 0;
        return (
          <>
            {nothing && <p>{t("floor.exceptions.none")}</p>}
            <div className="standalone-form__actions work-screen__reasons">
              <Button
                size="floor"
                variant="secondary"
                disabled={openItems === 0}
                onClick={() => run(onUndo)}
              >
                {t("floor.exceptions.actions.undo")}
              </Button>
              <Button
                size="floor"
                variant="secondary"
                disabled={openItems === 0}
                onClick={() => setStage({ kind: "confirm_clear" })}
              >
                {t("floor.exceptions.actions.clear")}
              </Button>
              <Button
                size="floor"
                variant="secondary"
                disabled={closed.length === 0}
                onClick={() =>
                  setStage({ kind: "target", action: "reprint", tail: "", note: null })
                }
              >
                {t("floor.exceptions.actions.reprint")}
              </Button>
              <Button
                size="floor"
                variant="secondary"
                disabled={closed.length === 0}
                onClick={() =>
                  setStage({ kind: "target", action: "disassemble", tail: "", note: null })
                }
              >
                {t("floor.exceptions.actions.disassemble")}
              </Button>
            </div>
            <div className="standalone-form__actions">{back(null)}</div>
          </>
        );
      }
      case "confirm_clear":
        return (
          <Alert tone="warn" title={t("floor.exceptions.confirm.clear.title")}>
            <p>
              {t("floor.exceptions.confirm.clear.body", { quantity: formatQuantity(openItems) })}
            </p>
            <div className="standalone-form__actions">
              {back({ kind: "actions" })}
              <Button size="floor" variant="destructive" onClick={() => run(onClear)}>
                {t("floor.exceptions.confirm.clear.action")}
              </Button>
            </div>
          </Alert>
        );
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
              {stage.tail === ""
                ? t("floor.exceptions.target.tailEmpty")
                : t("floor.exceptions.target.tail", { tail: stage.tail })}
            </p>
            <div
              className="standalone-form__actions exceptions__pad"
              role="group"
              aria-label={t("floor.exceptions.target.pad")}
            >
              {DIGITS.map((digit) => (
                <Button
                  key={digit}
                  size="floor"
                  variant="secondary"
                  disabled={stage.tail.length >= 18}
                  onClick={() => type(stage.tail + digit)}
                >
                  {digit}
                </Button>
              ))}
              <Button
                size="floor"
                variant="secondary"
                disabled={stage.tail === ""}
                onClick={() => type(stage.tail.slice(0, -1))}
              >
                {t("floor.exceptions.target.erase")}
              </Button>
            </div>
            {boxes === null ? (
              <p>{t("floor.exceptions.target.loading")}</p>
            ) : shown.length === 0 ? (
              <p>{t("floor.exceptions.target.nothing")}</p>
            ) : (
              <div className="standalone-form__actions work-screen__reasons">
                {shown.map((box) => (
                  <Button
                    key={box.id}
                    size="floor"
                    variant="secondary"
                    onClick={() => setStage({ kind: "reason", action: stage.action, box })}
                  >
                    {t("floor.exceptions.target.box", {
                      sscc: formatSsccHri(box.sscc),
                      quantity: formatQuantity(box.itemCount),
                    })}
                  </Button>
                ))}
              </div>
            )}
            {hidden > 0 && (
              <p>{t("floor.exceptions.target.more", { number: formatQuantity(hidden) })}</p>
            )}
            <div className="standalone-form__actions">{back({ kind: "actions" })}</div>
          </>
        );
      }
      case "reason": {
        const reasons = stage.action === "reprint" ? REPRINT_REASONS : DISASSEMBLE_REASONS;
        return (
          <>
            <h4>{t("floor.exceptions.reason.title")}</h4>
            <p>{t("floor.exceptions.reason.box", { sscc: formatSsccHri(stage.box.sscc) })}</p>
            <div className="standalone-form__actions work-screen__reasons">
              {reasons.map((code) => (
                <Button
                  key={code}
                  size="floor"
                  variant="secondary"
                  onClick={() =>
                    code === OTHER_REASON
                      ? setStage({ ...stage, kind: "words", text: "", invalid: false })
                      : pick(stage.action, stage.box, code, null)
                  }
                >
                  {t(`floor.exceptions.reasons.${stage.action}.${code}`)}
                </Button>
              ))}
            </div>
            <div className="standalone-form__actions">
              {back({ kind: "target", action: stage.action, tail: "", note: null })}
            </div>
          </>
        );
      }
      case "words": {
        const next = () => {
          try {
            pick(stage.action, stage.box, OTHER_REASON, reasonWords(stage.text));
          } catch (error) {
            if (!(error instanceof InvalidReasonError)) throw error;
            setStage({ ...stage, invalid: true });
          }
        };
        return (
          <>
            <h4>{t(`floor.exceptions.reasons.${stage.action}.other`)}</h4>
            <Input
              size="floor"
              label={t("floor.exceptions.words.label")}
              hint={t("floor.exceptions.words.hint")}
              value={stage.text}
              {...(stage.invalid ? { error: t("floor.exceptions.words.invalid") } : {})}
              onChange={(event) =>
                setStage({ ...stage, text: event.currentTarget.value, invalid: false })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  next();
                }
              }}
              onFocus={() => onTextEntry(true)}
              onBlur={() => onTextEntry(false)}
            />
            <div className="standalone-form__actions">
              {back({ kind: "reason", action: stage.action, box: stage.box })}
              <Button size="floor" onClick={next}>
                {t("floor.exceptions.words.next")}
              </Button>
            </div>
          </>
        );
      }
      case "confirm": {
        const { box, reasoned } = stage;
        const reasonText =
          reasoned.reason.text ??
          t(`floor.exceptions.reasons.${reasoned.action}.${reasoned.reason.code}`);
        return (
          <Alert
            tone={reasoned.action === "disassemble" ? "error" : "warn"}
            title={t(`floor.exceptions.confirm.${reasoned.action}.title`)}
          >
            <p>
              {t(`floor.exceptions.confirm.${reasoned.action}.body`, {
                sscc: formatSsccHri(box.sscc),
                quantity: formatQuantity(box.itemCount),
              })}
            </p>
            <p>{t("floor.exceptions.confirm.reason", { reason: reasonText })}</p>
            <div className="standalone-form__actions">
              {back({ kind: "reason", action: reasoned.action, box })}
              <Button
                size="floor"
                variant={reasoned.action === "disassemble" ? "destructive" : "primary"}
                onClick={() => apply(box, reasoned)}
              >
                {t(`floor.exceptions.confirm.${reasoned.action}.action`)}
              </Button>
            </div>
          </Alert>
        );
      }
      case "applying":
        return <p aria-live="polite">{t("floor.exceptions.applying")}</p>;
      case "result": {
        const { outcome } = stage;
        const done = outcome.kind === "done" || outcome.kind === "label";
        return (
          <Alert
            tone={done ? "ok" : "error"}
            title={t(
              outcome.kind === "done"
                ? `floor.exceptions.result.done.${outcome.action}`
                : `floor.exceptions.result.${outcome.kind}`,
            )}
          >
            <div className="standalone-form__actions">
              <Button size="floor" onClick={onBack}>
                {t("floor.exceptions.result.back")}
              </Button>
              <Button
                size="floor"
                variant="secondary"
                onClick={() => setStage({ kind: "actions" })}
              >
                {t("floor.exceptions.result.again")}
              </Button>
            </div>
          </Alert>
        );
      }
    }
  };

  return (
    <section className="exceptions" aria-label={title}>
      <h3>{title}</h3>
      {body()}
    </section>
  );
}
```

Правка `apps/standalone/src/floor/work/WorkScreen.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import type { Pairing } from "../../local/reference-sync.js";
import { LabelPanel, type LabelNote } from "../print/LabelPanel.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { Pairing } from "../../local/reference-sync.js";
import {
  BoxUnavailableError,
  clearOpenBox,
  disassembleBox,
  LabelWaitingError,
  readClosedBoxes,
  reprintBox,
  undoLastCode,
  type ClosedBox,
  type OpenBoxResult,
} from "../exceptions/box-exceptions.js";
import { ExceptionFlow, type ExceptionOutcome } from "../exceptions/ExceptionFlow.js";
import { LabelPanel, type LabelNote } from "../print/LabelPanel.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
 * plan 2a7 adds the label of a closed box that waits — its check, or its
 * recovery when it failed or its outcome is unknown.
 */
```

заменить на:

<!-- prettier-ignore -->
```tsx
 * plan 2a7 adds the label of a closed box that waits — its check, or its
 * recovery when it failed or its outcome is unknown; plan 2a8 the
 * exceptions, with the shift's closed boxes once they are read.
 */
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  | { kind: "close_failed"; full: boolean }
  | { kind: "label"; job: PrintJob };

/** The last scan, said in words under the box. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
  | { kind: "close_failed"; full: boolean }
  | { kind: "label"; job: PrintJob }
  | { kind: "exceptions"; boxes: readonly ClosedBox[] | null };

/** What an exception's failure says on the screen; anything unforeseen is this computer's failed write. */
function outcomeOf(error: unknown): ExceptionOutcome {
  if (error instanceof BoxUnavailableError) return { kind: "unavailable" };
  if (error instanceof LabelWaitingError) return { kind: "label_waiting" };
  return { kind: "failed" };
}

/** An exception on the open box, as the screen says it. */
function openBoxOutcome(result: OpenBoxResult, action: "undo" | "clear"): ExceptionOutcome {
  return result.kind === "done" ? { kind: "done", action } : result;
}

/** The last scan, said in words under the box. */
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  );

  /** One scan, in its turn: taken only while nothing stops the work. */
  const scan = useCallback(
    async (raw: string): Promise<void> => {
      const stopped = stopRef.current;
      // The check of a label takes the scan before the pipeline (plan 2a6's contract).
```

заменить на:

<!-- prettier-ignore -->
```tsx
  );

  // The box choice of the exceptions, when it listens: a scan of a label picks the box.
  const targetScan = useRef<((raw: string) => void) | null>(null);
  const registerScan = useCallback((listener: ((raw: string) => void) | null) => {
    targetScan.current = listener;
  }, []);
  const textEntry = useCallback(
    (active: boolean) => source.setManualTextEntryActive(active),
    [source],
  );

  /** One scan, in its turn: taken only while nothing stops the work. */
  const scan = useCallback(
    async (raw: string): Promise<void> => {
      const stopped = stopRef.current;
      // The box choice of the exceptions takes a label's scan; nothing is journalled.
      const choose = targetScan.current;
      if (stopped?.kind === "exceptions" && choose !== null) {
        choose(raw);
        return;
      }
      // The check of a label takes the scan before the pipeline (plan 2a6's contract).
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
      return printAgain(printContext, job, request, settings, boxTemplate, render);
    });
```

заменить на:

<!-- prettier-ignore -->
```tsx
      return printAgain(printContext, job, request, settings, boxTemplate, render);
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
    ).catch(() => setStop({ kind: "system_error" }));
  };

  /**
   * An exception as the line's next piece of work: whatever it wrote goes to
   * the host, the closed boxes and the numbers are read again, and the
   * screen says how it went. It never rejects: a failure is said.
   */
  const exception = (work: () => Promise<ExceptionOutcome>): Promise<ExceptionOutcome> =>
    track(
      queue.run(async () => {
        let outcome: ExceptionOutcome;
        try {
          outcome = await work();
        } catch (error) {
          outcome = outcomeOf(error);
        }
        if (outcome.kind === "done" || outcome.kind === "label") live.current.onRecorded();
        try {
          const boxes = await readClosedBoxes(local, where, shift.copy.id);
          if (stopRef.current?.kind === "exceptions") setStop({ kind: "exceptions", boxes });
          await refresh();
        } catch {
          // The numbers are read again with the next piece of work.
        }
        return outcome;
      }),
    );

  const reprint = (boxId: string, reason: Parameters<typeof reprintBox>[2]) =>
    exception(async () => {
      const settings = await readWorkstationSettings(local);
      const job = await reprintBox({ ...printContext, shift }, boxId, reason, settings, render);
      // A new label that waits — its check, or a printer that failed — is decided at once.
      if (isOpenJob(job)) {
        showLabel(job);
        return { kind: "label" };
      }
      return { kind: "done", action: "reprint" };
    });
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
        {sending && <p aria-live="polite">{t("floor.print.sending")}</p>}
        {stop?.kind === "label" && (
```

заменить на:

<!-- prettier-ignore -->
```tsx
        {sending && <p aria-live="polite">{t("floor.print.sending")}</p>}
        {stop?.kind === "exceptions" && (
          <ExceptionFlow
            openItems={items}
            boxes={stop.boxes}
            onUndo={() =>
              exception(async () => openBoxOutcome(await undoLastCode(context), "undo"))
            }
            onClear={() =>
              exception(async () => openBoxOutcome(await clearOpenBox(context), "clear"))
            }
            onReprint={reprint}
            onDisassemble={(boxId, reason) =>
              exception(async () => {
                const result = await disassembleBox(context, boxId, reason);
                return result.kind === "done" ? { kind: "done", action: "disassemble" } : result;
              })
            }
            registerScan={registerScan}
            onTextEntry={textEntry}
            onBack={() => setStop(null)}
          />
        )}
        {stop?.kind === "label" && (
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
            </Button>
            <Button size="floor" variant="secondary" disabled={leaving} onClick={onLeave}>
```

заменить на:

<!-- prettier-ignore -->
```tsx
            </Button>
            <Button
              size="floor"
              variant="secondary"
              disabled={stop !== null || leaving}
              onClick={openExceptions}
            >
              {t("floor.exceptions.open")}
            </Button>
            <Button size="floor" variant="secondary" disabled={leaving} onClick={onLeave}>
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
        "notSscc": "НЕ SSCC"
      }
```

заменить на:

<!-- prettier-ignore -->
```json
        "notSscc": "НЕ SSCC"
      }
    },
    "exceptions": {
      "open": "Исключения",
      "title": "Исключения",
      "back": "Назад",
      "none": "Сейчас исключений нет: открытый короб пуст, закрытых коробов нет.",
      "actions": {
        "undo": "Снять последний код",
        "clear": "Очистить короб",
        "reprint": "Перепечатать этикетку",
        "disassemble": "Расформировать короб"
      },
      "target": {
        "title": {
          "reprint": "Какой короб перепечатать?",
          "disassemble": "Какой короб расформировать?"
        },
        "hint": "Отсканируйте этикетку короба или наберите последние цифры его SSCC.",
        "pad": "Последние цифры SSCC",
        "tail": "Последние цифры SSCC: {{tail}}",
        "tailEmpty": "Цифры не набраны: показаны последние закрытые короба.",
        "erase": "Стереть цифру",
        "loading": "Читаем закрытые короба…",
        "nothing": "Нет закрытых коробов с такими цифрами.",
        "box": "{{sscc}} · {{quantity}} шт.",
        "more": "Ещё коробов: {{number}}. Наберите больше цифр.",
        "not_sscc": "Это не код SSCC. Отсканируйте этикетку короба.",
        "not_found": "Короба с этим SSCC нет среди закрытых коробов смены."
      },
      "reason": {
        "title": "Укажите причину",
        "box": "Короб {{sscc}}"
      },
      "reasons": {
        "reprint": {
          "damaged_label": "Этикетка повреждена",
          "unreadable_label": "Этикетка не читается",
          "printer_jam": "Замятие в принтере",
          "quality_request": "Требование контроля качества",
          "other": "Другая причина"
        },
        "disassemble": {
          "wrong_product": "Не тот товар",
          "wrong_quantity": "Неверное количество",
          "damaged_package": "Повреждена упаковка",
          "quality_rejected": "Брак по качеству",
          "other": "Другая причина"
        }
      },
      "words": {
        "label": "Причина своими словами (необязательно)",
        "hint": "Одной строкой, до 200 знаков.",
        "invalid": "Не больше 200 знаков, одной строкой.",
        "next": "Дальше"
      },
      "confirm": {
        "reason": "Причина: {{reason}}",
        "clear": {
          "title": "Очистить короб?",
          "body": "Из открытого короба уйдут все коды ({{quantity}} шт.). Их можно будет отсканировать снова.",
          "action": "Очистить короб"
        },
        "reprint": {
          "title": "Перепечатать этикетку?",
          "body": "Новая этикетка будет с тем же SSCC {{sscc}}: на коробе должна остаться одна.",
          "action": "Перепечатать"
        },
        "disassemble": {
          "title": "Расформировать короб?",
          "body": "SSCC {{sscc}} больше не будет использован. Коды короба ({{quantity}} шт.) снова станут свободны.",
          "action": "Расформировать"
        }
      },
      "applying": "Выполняем…",
      "result": {
        "done": {
          "undo": "Последний код снят из короба.",
          "clear": "Короб очищен.",
          "reprint": "Этикетка отправлена на принтер.",
          "disassemble": "Короб расформирован, его коды свободны."
        },
        "label": "Новая этикетка ждёт решения на рабочем экране.",
        "empty": "Открытый короб пуст: снимать нечего.",
        "stale": "Пока вы выбирали, короб изменился. Ничего не сделано — повторите.",
        "unavailable": "Этого короба больше нет среди закрытых коробов смены. Ничего не сделано.",
        "label_waiting": "Этикетка этого короба ещё ждёт решения на рабочем экране. Ничего не сделано.",
        "failed": "Не удалось записать исключение на этом компьютере. Ничего не сделано.",
        "back": "Вернуться к работе",
        "again": "Другое действие"
      }
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-exceptions.test.tsx`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  10 passed (10)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  108 passed (108)`, `Tests  2606 passed (2606)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — скан на шаге выбора короба не доходит до экрана исключений.
В `apps/standalone/src/floor/work/WorkScreen.tsx` удалить фрагмент

<!-- prettier-ignore -->
```tsx
      if (stopped?.kind === "exceptions" && choose !== null) {
        choose(raw);
        return;
      }
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-exceptions.test.tsx`
Expected: FAIL — «takes apart a box chosen by a scan of its label, with a reason; a scan there is never journalled».

М2 — исключение не отдаётся воротам работы (выход из смены его не ждёт).
В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  const exception = (work: () => Promise<ExceptionOutcome>): Promise<ExceptionOutcome> =>
    track(
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const exception = (work: () => Promise<ExceptionOutcome>): Promise<ExceptionOutcome> =>
    Promise.resolve(
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-exceptions.test.tsx`
Expected: FAIL — «hands its write to the floor's work gate: leaving the shift waits for it».

М3 — «Исключения» открываются при ждущей этикетке.
В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
              disabled={stop !== null || leaving}
              onClick={openExceptions}
```

заменить на:

<!-- prettier-ignore -->
```tsx
              disabled={leaving}
              onClick={openExceptions}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-exceptions.test.tsx`
Expected: FAIL — «opens neither at a label that waits nor while the operator leaves; «Выйти из смены» stays open in it».

М4 — очистка короба без подтверждения.
В `apps/standalone/src/floor/exceptions/ExceptionFlow.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
                onClick={() => setStage({ kind: "confirm_clear" })}
```

заменить на:

<!-- prettier-ignore -->
```tsx
                onClick={() => run(onClear)}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-exceptions.test.tsx`
Expected: FAIL — «clears the open box only after the operator confirms».

М5 — поле слов не говорит источнику сканов, что берёт ввод.
В `apps/standalone/src/floor/exceptions/ExceptionFlow.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
              onFocus={() => onTextEntry(true)}
```

заменить на:

<!-- prettier-ignore -->
```tsx
              onFocus={() => onTextEntry(false)}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-exceptions.test.tsx`
Expected: FAIL — «prints a box's label again chosen by the last digits, with the words of «Другая причина»».

М6 — новая этикетка перепечатки, ждущая проверки, не останавливает работу.
В `apps/standalone/src/floor/work/WorkScreen.tsx` удалить фрагмент

<!-- prettier-ignore -->
```tsx
      if (isOpenJob(job)) {
        showLabel(job);
        return { kind: "label" };
      }
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-exceptions.test.tsx`
Expected: FAIL — «stops at a reprinted label that waits for its check».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/app/shell.css apps/standalone/src/floor/exceptions/ExceptionFlow.tsx apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-work-exceptions.test.tsx apps/standalone/test/support/work-screen.tsx`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-work-exceptions.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/floor-work-exceptions.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/app/shell.css apps/standalone/src/floor/exceptions/ExceptionFlow.tsx apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-work-exceptions.test.tsx apps/standalone/test/support/work-screen.tsx
git commit -m "feat(standalone): the work screen's exceptions — a box by its label or the last digits, reasons, confirmations" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Закрытие смены — модель: сводка, одна локальная запись, ни одной записи после неё

Модель закрытия смены (`src/floor/close/shift-close.ts`, решение 17, §5.7.7): `readCloseSummary` — план копии станции сейчас, факт (коды станции в коробах смены), закрытые короба, нужна ли причина (`shiftCloseReasonRequired` домена) и что держит смену открытой (открытый короб с кодами, ждущая этикетка — запросом, как `shiftLabelsSettled` плана 2a7, — или уже закрыта). `closeShift(context, reason, guards?)` — одна транзакция: проверки `guards` (точка ПЛ-Ц), удаление пустого открытого короба, запись `shift_closed`, отметка `closing` при неизменных счётчиках и без ждущей этикетки (`OPEN_JOB_SQL` из `print-jobs.ts` экспортируется), иначе `stale`. `outboxStatement` (план 2a6) больше не вставляет запись смены с `local_state`: `shift_closed` всегда последняя запись смены, и никакой писатель — скан, короб, исключение, перепечатка — не допишет её после закрытия (тест 2a7, «Контракт»).

**Files:**

- Create: `apps/standalone/src/floor/close/shift-close.ts`
- Modify: `apps/standalone/src/floor/facts.ts`, `apps/standalone/src/floor/print/print-jobs.ts`
- Test: `apps/standalone/test/floor-shift-close.test.ts` (Create)

**Interfaces:**

- Consumes: `BoxContext` (план 2a6), `outboxStatement`, `shiftClosedRecord` (`src/floor/facts.ts`), `readShiftCopy` (план 2a5), запрос ждущих заданий плана 2a7; задача 1 (тесты: `undoLastCode`, `clearOpenBox`, `disassembleBox`, `reprintBox`); домен `shiftCloseReasonRequired`, `isShiftCloseReasonCode`.
- Produces:
  - `readCloseSummary(local, pairing, shiftId): Promise<CloseSummary>` (`{ plannedQty; actualQty; closedBoxes; reasonRequired; blocker: CloseBlocker | null }`), `CloseBlocker` (`open_box` с `items`, `label`, `closed`);
  - `closeShift(context: BoxContext, reasonCode: ShiftCloseReasonCode | null, guards?: readonly LocalStatement[]): Promise<CloseResult>` (`closed` с записью, `blocked`, `reason_required`, `stale`);
  - `outboxStatement` — `INSERT … SELECT … WHERE NOT EXISTS (смена с local_state)`, `expectedChanges: 1`; `OPEN_JOB_SQL` экспортирован из `print-jobs.ts`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-shift-close.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import { closeShift, readCloseSummary } from "../src/floor/close/shift-close.js";
import {
  clearOpenBox,
  disassembleBox,
  reprintBox,
  undoLastCode,
} from "../src/floor/exceptions/box-exceptions.js";
import { readPrintJob, sendLabelJob } from "../src/floor/print/print-jobs.js";
import { skipLabel } from "../src/floor/print/print-resolution.js";
import { keepEnteredShift, readShiftCopy } from "../src/floor/shifts/shift-copies.js";
import { closeOpenBox } from "../src/floor/work/box-close.js";
import { processScan, type ScanContext } from "../src/floor/work/scan-pipeline.js";
import { LocalDbError } from "../src/local/executor.js";
import {
  ENTERED,
  enteredShift,
  holdingWrites,
  km,
  OPERATOR_ID,
  PAIRING,
  rows,
  scanContext,
  SHIFT_ID,
} from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import {
  closeBoxWithLabel,
  fakeRender,
  manualRuntime,
  printStation,
  resolveContext,
} from "./support/printing.js";

type Station = Awaited<ReturnType<typeof printStation>>;

/** A station whose plan is `planned` units (`null` — none). */
async function station(planned: number | null = 1_200): Promise<Station> {
  const at = await printStation();
  if (planned !== ENTERED.plannedQty) {
    await enteredShift(at.local, { ...ENTERED, plannedQty: planned });
  }
  return at;
}

/** The close's context: the station's clock from 06:15, fresh ids. */
function closer(at: Station, overrides: Partial<ScanContext> = {}): ScanContext {
  return scanContext(at.local, at.shift, { newId: () => crypto.randomUUID(), ...overrides });
}

async function fill(context: ScanContext, serials: readonly string[]): Promise<void> {
  for (const serial of serials) await processScan(context, km(serial));
}

/** A box of three codes closed, and its label sent and taken by the printer. */
async function closedBoxWithLabel(at: Station): Promise<void> {
  const context = resolveContext(at.local, manualRuntime(fakeHardware().hardware).runtime);
  await sendLabelJob(context, await closeBoxWithLabel(at));
}

/** The shift's outbox, oldest first: each record's kind. */
function outboxKinds(at: Station): unknown[] {
  return rows(at.db, "SELECT kind FROM outbox WHERE shift_id = ? ORDER BY seq", SHIFT_ID).map(
    (row) => row["kind"],
  );
}

function localState(at: Station): unknown {
  return rows(at.db, "SELECT local_state FROM floor_shifts WHERE id = ?", SHIFT_ID)[0]?.[
    "local_state"
  ];
}

describe("the summary of a shift's close", () => {
  it("counts the codes the station holds and its closed boxes, and says what keeps the shift open", async () => {
    const at = await station(6);
    await closedBoxWithLabel(at);
    const context = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    await fill(context, ["B1", "B2"]);
    expect(await readCloseSummary(at.local, PAIRING, SHIFT_ID)).toEqual({
      plannedQty: 6,
      actualQty: 5,
      closedBoxes: 1,
      reasonRequired: true,
      blocker: { kind: "open_box", items: 2 },
    });
    await clearOpenBox(context);
    expect(await readCloseSummary(at.local, PAIRING, SHIFT_ID)).toMatchObject({
      actualQty: 3,
      blocker: null,
    });
  });

  it("is kept open by a label that waits, and not once it is skipped", async () => {
    const at = await station(3);
    const context = resolveContext(
      at.local,
      manualRuntime(fakeHardware(async () => ({ sent: false, code: "not_sent" })).hardware).runtime,
    );
    const failed = await sendLabelJob(context, await closeBoxWithLabel(at));
    const summary = await readCloseSummary(at.local, PAIRING, SHIFT_ID);
    expect(summary).toMatchObject({
      actualQty: 3,
      reasonRequired: false,
      blocker: { kind: "label" },
    });
    expect(await closeShift(closer(at), null)).toEqual({
      kind: "blocked",
      blocker: { kind: "label" },
    });
    await skipLabel(context, failed);
    expect(await closeShift(closer(at), null)).toMatchObject({
      kind: "closed",
    });
  });
});

describe("the close of a shift on the station", () => {
  it("writes `shift_closed` as the shift's last record, drops the empty open box and marks the shift closing", async () => {
    const at = await station(3);
    await closedBoxWithLabel(at);
    const context = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    await fill(context, ["B1"]);
    await undoLastCode(context);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { n: 1 },
    ]);
    const result = await closeShift(
      scanContext(at.local, at.shift, { newId: () => "00000000-0000-4000-8000-0000000000aa" }),
      null,
    );
    const record = {
      plannedQtySnapshot: 3,
      actualQty: 3,
      closedBoxCount: 1,
      reasonCode: null,
      closedAt: "2026-10-08T06:15:00.000Z",
    };
    expect(result).toEqual({ kind: "closed", record });
    expect(outboxKinds(at).at(-1)).toBe("shift_closed");
    const [closed] = rows(at.db, "SELECT payload FROM outbox WHERE kind = 'shift_closed'");
    expect(JSON.parse(String(closed?.["payload"]))).toEqual({
      id: "00000000-0000-4000-8000-0000000000aa",
      kind: "shift_closed",
      shiftId: SHIFT_ID,
      operatorId: OPERATOR_ID,
      data: record,
    });
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { n: 0 },
    ]);
    expect(localState(at)).toBe("closing");
    expect((await readShiftCopy(at.local, PAIRING, SHIFT_ID))?.localState).toBe("closing");
  });

  it("needs one of the six reasons when the plan is not met, and keeps one given without need", async () => {
    const at = await station(4);
    await closedBoxWithLabel(at);
    expect(await closeShift(closer(at), null)).toEqual({
      kind: "reason_required",
    });
    expect(outboxKinds(at)).not.toContain("shift_closed");
    expect(localState(at)).toBeNull();
    expect(await closeShift(closer(at), "material_shortage")).toMatchObject({
      kind: "closed",
      record: { plannedQtySnapshot: 4, actualQty: 3, reasonCode: "material_shortage" },
    });

    const met = await station(3);
    await closedBoxWithLabel(met);
    expect(await closeShift(closer(met), "equipment_stop")).toMatchObject({
      kind: "closed",
      record: { reasonCode: "equipment_stop" },
    });

    const unplanned = await station(null);
    await closedBoxWithLabel(unplanned);
    expect(await closeShift(closer(unplanned), null)).toMatchObject({
      kind: "closed",
      record: { plannedQtySnapshot: null, actualQty: 3, reasonCode: null },
    });
  });

  it("is kept open by an open box with codes, writing nothing", async () => {
    const at = await station(null);
    await fill(scanContext(at.local, at.shift), ["A1"]);
    expect(await closeShift(closer(at), null)).toEqual({
      kind: "blocked",
      blocker: { kind: "open_box", items: 1 },
    });
    expect(outboxKinds(at)).toEqual(["scan"]);
    expect(localState(at)).toBeNull();
  });

  it("closes once: a second close finds the shift closed", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    await closeShift(closer(at), null);
    expect(await closeShift(closer(at), null)).toEqual({
      kind: "blocked",
      blocker: { kind: "closed" },
    });
    expect(outboxKinds(at).filter((kind) => kind === "shift_closed")).toHaveLength(1);
  });

  it("lets no record of the shift follow its close, whoever tries to write one", async () => {
    const at = await station(null);
    const shell = fakeHardware();
    const print = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const job = await sendLabelJob(print, await closeBoxWithLabel(at));
    const context = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    expect(await closeShift(context, null)).toMatchObject({ kind: "closed" });
    const closedSeq = rows(at.db, "SELECT seq FROM outbox WHERE kind = 'shift_closed'")[0]?.["seq"];
    await expect(processScan(context, km("Z1"))).rejects.toMatchObject({
      code: "changes_mismatch",
    });
    await expect(processScan(context, "not a code")).rejects.toBeInstanceOf(LocalDbError);
    expect(
      await disassembleBox(context, job.subjectId, { code: "wrong_product", text: null }),
    ).toEqual({ kind: "stale" });
    await expect(
      reprintBox(
        { ...print, shift: at.shift },
        job.subjectId,
        { code: "damaged_label", text: null },
        at.settings,
        fakeRender,
      ),
    ).rejects.toMatchObject({ code: "changes_mismatch" });
    expect(await closeOpenBox(context)).toEqual({ kind: "empty" });
    expect(
      rows(at.db, "SELECT max(seq) AS last FROM outbox WHERE shift_id = ?", SHIFT_ID)[0]?.["last"],
    ).toBe(closedSeq);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_exceptions")).toEqual([{ n: 0 }]);
    expect(shell.sends).toHaveLength(1);
    expect(await readPrintJob(at.local, PAIRING, job.id)).toMatchObject({ state: "sent" });
  });

  it("stops the records of the shift this pairing closed, not those of another pairing's copy", async () => {
    const at = await station(null);
    const other = { hostId: PAIRING.hostId, deviceId: "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f" };
    await keepEnteredShift(at.local, other, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    at.db
      .prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE device_id = ?")
      .run(other.deviceId);
    expect(await processScan(closer(at), km("D1"))).toMatchObject({ kind: "accepted" });
    await expect(
      processScan(closer(at, { pairing: other, newId: () => crypto.randomUUID() }), km("D2")),
    ).rejects.toMatchObject({ code: "changes_mismatch" });
  });

  it("writes nothing when a scan lands between its summary and its write", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeShift(closer(at, { local: held.executor }), null);
    await held.reached();
    await fill(scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() }), ["C1"]);
    held.release();
    expect(await closing).toEqual({ kind: "stale" });
    expect(localState(at)).toBeNull();
    expect(outboxKinds(at)).not.toContain("shift_closed");
    expect(rows(at.db, "SELECT item_count FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { item_count: 1 },
    ]);
  });

  it("writes nothing when a box is taken apart between its summary and its write", async () => {
    const at = await station(null);
    const shell = fakeHardware();
    const print = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const job = await sendLabelJob(print, await closeBoxWithLabel(at));
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeShift(closer(at, { local: held.executor }), null);
    await held.reached();
    await disassembleBox(closer(at), job.subjectId, { code: "quality_rejected", text: null });
    held.release();
    // The summary said 3 codes in 1 box; the station holds none now.
    expect(await closing).toEqual({ kind: "stale" });
    expect(await readCloseSummary(at.local, PAIRING, SHIFT_ID)).toMatchObject({
      actualQty: 0,
      closedBoxes: 0,
      blocker: null,
    });
    expect(outboxKinds(at)).not.toContain("shift_closed");
  });

  it("writes nothing when a label starts to wait between its summary and its write", async () => {
    const at = await station(null);
    const shell = fakeHardware();
    const print = resolveContext(at.local, manualRuntime(shell.hardware).runtime);
    const job = await sendLabelJob(print, await closeBoxWithLabel(at));
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeShift(closer(at, { local: held.executor }), null);
    await held.reached();
    shell.holdSends();
    const reprint = reprintBox(
      { ...print, shift: at.shift },
      job.subjectId,
      { code: "unreadable_label", text: null },
      at.settings,
      fakeRender,
    );
    for (let turn = 0; turn < 200 && shell.heldSends() === 0; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(shell.heldSends()).toBe(1);
    held.release();
    expect(await closing).toEqual({ kind: "stale" });
    shell.releaseSend({ sent: true });
    await reprint;
    expect(localState(at)).toBeNull();
  });

  it("writes nothing when a guard of a later plan fails", async () => {
    const at = await station(null);
    await closedBoxWithLabel(at);
    const failing = {
      sql: "UPDATE floor_shifts SET local_state = local_state WHERE id = ?",
      values: ["no such shift"],
      expectedChanges: 1,
    };
    expect(await closeShift(closer(at), null, [failing])).toEqual({
      kind: "stale",
    });
    expect(outboxKinds(at)).not.toContain("shift_closed");
    expect(localState(at)).toBeNull();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-close.test.ts`
Expected: FAIL — `test/floor-shift-close.test.ts` не загружается (`Failed to resolve import "../src/floor/close/shift-close.js"`).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/floor/close/shift-close.ts`:

<!-- prettier-ignore -->
```ts
import {
  isShiftCloseReasonCode,
  shiftCloseReasonRequired,
  type ShiftCloseReasonCode,
} from "@markiro/domain";
import { z } from "zod";

import type { ShiftClosedFact } from "../../host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { outboxStatement, shiftClosedRecord } from "../facts.js";
import { OPEN_JOB_SQL } from "../print/print-jobs.js";
import { readShiftCopy } from "../shifts/shift-copies.js";
import type { BoxContext } from "../work/box-close.js";

/**
 * What keeps the shift from closing now (stage 2a spec §5.7.7): an open box
 * with codes, which the operator closes or clears first; a label of the
 * shift that still waits for the printer or the operator (plan 2a7's
 * `shiftLabelsSettled`: a label decided after the close would reach the host
 * after `shift_closed` and mark the station's own shift late); or this
 * station has closed it already. The pallets' plan (ПЛ-Ц) adds an open
 * pallet with boxes.
 */
export type CloseBlocker =
  { kind: "open_box"; items: number } | { kind: "label" } | { kind: "closed" };

/** The summary of the close (the cloud's close summary), from this station's own records. */
export interface CloseSummary {
  /** The plan as this station's copy has it now: the record carries it as the plan it saw. */
  plannedQty: number | null;
  /** Codes this station holds in the shift's boxes: the shift's actual quantity. */
  actualQty: number;
  /** The shift's closed boxes not taken apart. */
  closedBoxes: number;
  /** The plan is given and not met: one of the domain's six reasons is needed. */
  reasonRequired: boolean;
  blocker: CloseBlocker | null;
}

const summaryRow = z.object({
  local_state: z.string().nullable(),
  actual: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  open_items: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
});

/** The counts of the shift's codes and closed boxes, as one statement's guard compares them. */
const COUNTS =
  "(SELECT count(*) FROM floor_codes c WHERE c.host_id = s.host_id AND c.device_id = s.device_id " +
  "AND c.shift_id = s.id) AS actual, " +
  "(SELECT count(*) FROM floor_boxes b WHERE b.host_id = s.host_id AND b.device_id = s.device_id " +
  "AND b.shift_id = s.id AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS closed";

/**
 * Reads the summary of the shift's close: the plan from this station's copy
 * now, the actual quantity and the closed boxes from its own records, and
 * what keeps it from closing. Every label is counted, not read: a waiting
 * job this build cannot read still keeps the shift open.
 */
export async function readCloseSummary(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<CloseSummary> {
  const copy = await readShiftCopy(local, pairing, shiftId);
  const [row] = await local.query(
    `SELECT s.local_state, ${COUNTS}, ` +
      "(SELECT coalesce(sum(b.item_count), 0) FROM floor_boxes b WHERE b.host_id = s.host_id " +
      "AND b.device_id = s.device_id AND b.shift_id = s.id AND b.closed_at IS NULL) AS open_items, " +
      "(SELECT count(*) FROM floor_print_jobs j WHERE j.host_id = s.host_id " +
      `AND j.device_id = s.device_id AND j.shift_id = s.id AND ${OPEN_JOB_SQL}) AS waiting ` +
      "FROM floor_shifts s WHERE s.host_id = ? AND s.device_id = ? AND s.id = ?",
    [pairing.hostId, pairing.deviceId, shiftId],
    summaryRow,
  );
  if (copy === null || row === undefined) {
    return {
      plannedQty: null,
      actualQty: 0,
      closedBoxes: 0,
      reasonRequired: false,
      blocker: { kind: "closed" },
    };
  }
  const blocker: CloseBlocker | null =
    row.local_state !== null
      ? { kind: "closed" }
      : row.open_items > 0
        ? { kind: "open_box", items: row.open_items }
        : row.waiting > 0
          ? { kind: "label" }
          : null;
  return {
    plannedQty: copy.plannedQty,
    actualQty: row.actual,
    closedBoxes: row.closed,
    reasonRequired: shiftCloseReasonRequired(copy.plannedQty, row.actual),
    blocker,
  };
}

/**
 * How a close went: closed, with the record it wrote; kept open by a
 * blocker; a reason needed and not given; or `stale` — a scan, a box or a
 * label changed the shift between the summary and the write, nothing was
 * written, and the summary is read again.
 */
export type CloseResult =
  | { kind: "closed"; record: ShiftClosedFact }
  | { kind: "blocked"; blocker: CloseBlocker }
  | { kind: "reason_required" }
  | { kind: "stale" };

/**
 * Closes the shift on this station (stage 2a spec, decision 17 and
 * §5.7.7): the local write is the point of no return — it needs neither the
 * host nor the link, and the shift never opens again on this station. In
 * ONE transaction, after the extra `guards` (the pallets' plan's): the
 * shift's empty open box goes; its `shift_closed` record — the plan it saw,
 * the codes it holds, its closed boxes, the reason, the moment — goes into
 * the outbox as the shift's last record; and the shift is marked `closing`,
 * but only while nothing changed since the summary: no label that waits,
 * the same counts of codes and closed boxes (a code scanned, taken out or
 * freed since changes them, an open box with codes included). From then on
 * the shift takes no
 * record (`outboxStatement`). The receipt `accepted` of the record makes it
 * `closed` (`sendFactBatch`).
 */
export async function closeShift(
  context: BoxContext,
  reasonCode: ShiftCloseReasonCode | null,
  guards: readonly LocalStatement[] = [],
): Promise<CloseResult> {
  const { local, pairing, shift } = context;
  const summary = await readCloseSummary(local, pairing, shift.copy.id);
  if (summary.blocker !== null) return { kind: "blocked", blocker: summary.blocker };
  if (reasonCode !== null && !isShiftCloseReasonCode(reasonCode)) {
    return { kind: "reason_required" };
  }
  if (summary.reasonRequired && reasonCode === null) return { kind: "reason_required" };
  const closedAt = context.now().toISOString();
  const data: ShiftClosedFact = {
    plannedQtySnapshot: summary.plannedQty,
    actualQty: summary.actualQty,
    closedBoxCount: summary.closedBoxes,
    reasonCode,
    closedAt,
  };
  const record = shiftClosedRecord(
    { id: context.newId(), shiftId: shift.copy.id, operatorId: context.operatorId },
    data,
  );
  const scope = [pairing.hostId, pairing.deviceId, shift.copy.id];
  try {
    await local.transaction([
      ...guards,
      {
        sql:
          "DELETE FROM floor_boxes WHERE host_id = ? AND device_id = ? AND shift_id = ? " +
          "AND closed_at IS NULL AND item_count = 0",
        values: scope,
      },
      outboxStatement(record, pairing, closedAt),
      {
        sql:
          "UPDATE floor_shifts AS s SET local_state = 'closing' WHERE s.host_id = ? " +
          "AND s.device_id = ? AND s.id = ? AND s.local_state IS NULL " +
          "AND NOT EXISTS (SELECT 1 FROM floor_print_jobs j WHERE j.host_id = s.host_id " +
          `AND j.device_id = s.device_id AND j.shift_id = s.id AND ${OPEN_JOB_SQL}) ` +
          "AND (SELECT count(*) FROM floor_codes c WHERE c.host_id = s.host_id " +
          "AND c.device_id = s.device_id AND c.shift_id = s.id) = ? " +
          "AND (SELECT count(*) FROM floor_boxes b WHERE b.host_id = s.host_id " +
          "AND b.device_id = s.device_id AND b.shift_id = s.id AND b.closed_at IS NOT NULL " +
          "AND b.disassembled_at IS NULL) = ?",
        values: [...scope, summary.actualQty, summary.closedBoxes],
        expectedChanges: 1,
      },
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch")
      return { kind: "stale" };
    throw error;
  }
  return { kind: "closed", record: data };
}
```

Правка `apps/standalone/src/floor/facts.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
 * large to send, is never kept, and it is kept whole as the payload it is
 * sent as.
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
 * large to send, is never kept, and it is kept whole as the payload it is
 * sent as. A shift this station has closed (`local_state`, plan 2a8) takes
 * no record any more: its `shift_closed` is its last, and the row of any
 * later one changes nothing, so its whole transaction is refused
 * (`changes_mismatch`). The host would mark the station's own shift late
 * for a record after its close (plan 2a2).
 */
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
    values: [
```

заменить на:

<!-- prettier-ignore -->
```ts
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
      "SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM floor_shifts " +
      "WHERE host_id = ? AND device_id = ? AND id = ? AND local_state IS NOT NULL)",
    values: [
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
      createdAt,
    ],
```

заменить на:

<!-- prettier-ignore -->
```ts
      createdAt,
      pairing.hostId,
      pairing.deviceId,
      checked.shiftId,
    ],
```

Правка `apps/standalone/src/floor/print/print-jobs.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
}

/** The same rule in SQL, word for word the index's. */
const OPEN =
  "(state IN ('prepared', 'sending', 'failed', 'unknown') OR (state = 'sent' AND verify = 1))";
```

заменить на:

<!-- prettier-ignore -->
```ts
}

/**
 * The same rule in SQL, word for word the index's; plan 2a8's close of a
 * shift checks it in its own transaction.
 */
export const OPEN_JOB_SQL =
  "(state IN ('prepared', 'sending', 'failed', 'unknown') OR (state = 'sent' AND verify = 1))";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
    `SELECT ${COLUMNS} FROM floor_print_jobs WHERE host_id = ? AND device_id = ? ` +
      `AND shift_id = ? AND ${OPEN} ORDER BY created_at, id LIMIT 1`,
    [pairing.hostId, pairing.deviceId, shiftId],
```

заменить на:

<!-- prettier-ignore -->
```ts
    `SELECT ${COLUMNS} FROM floor_print_jobs WHERE host_id = ? AND device_id = ? ` +
      `AND shift_id = ? AND ${OPEN_JOB_SQL} ORDER BY created_at, id LIMIT 1`,
    [pairing.hostId, pairing.deviceId, shiftId],
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
    `SELECT count(*) AS waiting FROM floor_print_jobs WHERE host_id = ? AND device_id = ? ` +
      `AND shift_id = ? AND ${OPEN}`,
    [pairing.hostId, pairing.deviceId, shiftId],
```

заменить на:

<!-- prettier-ignore -->
```ts
    `SELECT count(*) AS waiting FROM floor_print_jobs WHERE host_id = ? AND device_id = ? ` +
      `AND shift_id = ? AND ${OPEN_JOB_SQL}`,
    [pairing.hostId, pairing.deviceId, shiftId],
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-close.test.ts`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  12 passed (12)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  109 passed (109)`, `Tests  2618 passed (2618)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — запись смены пишется и после её закрытия.
В `apps/standalone/src/floor/facts.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "WHERE host_id = ? AND device_id = ? AND id = ? AND local_state IS NOT NULL)",
```

заменить на:

<!-- prettier-ignore -->
```ts
      "WHERE host_id = ? AND device_id = ? AND id = ? AND local_state IS NOT NULL AND 0)",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-close.test.ts`
Expected: FAIL — «lets no record of the shift follow its close, whoever tries to write one», «stops the records of the shift this pairing closed, not those of another pairing's copy».

М2 — закрытая копия смены чужого подключения останавливает записи этого.
В `apps/standalone/src/floor/facts.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "WHERE host_id = ? AND device_id = ? AND id = ? AND local_state IS NOT NULL)",
```

заменить на:

<!-- prettier-ignore -->
```ts
      "WHERE ? IS NOT NULL AND ? IS NOT NULL AND id = ? AND local_state IS NOT NULL)",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-close.test.ts`
Expected: FAIL — «stops the records of the shift this pairing closed, not those of another pairing's copy».

М3 — `shift_closed` пишется после отметки `closing` (проверка не даёт закрыть смену вовсе).
В `apps/standalone/src/floor/close/shift-close.ts` фрагмент 1

<!-- prettier-ignore -->
```ts
      outboxStatement(record, pairing, closedAt),
      {
        sql:
          "UPDATE floor_shifts AS s SET local_state = 'closing' WHERE s.host_id = ? " +
```

заменить на:

<!-- prettier-ignore -->
```ts
      {
        sql:
          "UPDATE floor_shifts AS s SET local_state = 'closing' WHERE s.host_id = ? " +
```

В `apps/standalone/src/floor/close/shift-close.ts` фрагмент 2

<!-- prettier-ignore -->
```ts
        values: [...scope, summary.actualQty, summary.closedBoxes],
        expectedChanges: 1,
      },
```

заменить на:

<!-- prettier-ignore -->
```ts
        values: [...scope, summary.actualQty, summary.closedBoxes],
        expectedChanges: 1,
      },
      outboxStatement(record, pairing, closedAt),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-close.test.ts`
Expected: FAIL — «is kept open by a label that waits, and not once it is skipped», «writes `shift_closed` as the shift's last record, drops the empty open box and marks the shift closing», «needs one of the six reasons when the plan is not met, and keeps one given without need», «closes once: a second close finds the shift closed», «lets no record of the shift follow its close, whoever tries to write one».

М4 — закрытие не сверяет счётчики сводки.
В `apps/standalone/src/floor/close/shift-close.ts` фрагмент

<!-- prettier-ignore -->
```ts
          "AND c.device_id = s.device_id AND c.shift_id = s.id) = ? " +
          "AND (SELECT count(*) FROM floor_boxes b WHERE b.host_id = s.host_id " +
          "AND b.device_id = s.device_id AND b.shift_id = s.id AND b.closed_at IS NOT NULL " +
          "AND b.disassembled_at IS NULL) = ?",
```

заменить на:

<!-- prettier-ignore -->
```ts
          "AND c.device_id = s.device_id AND c.shift_id = s.id) >= 0 + ? * 0 " +
          "AND (SELECT count(*) FROM floor_boxes b WHERE b.host_id = s.host_id " +
          "AND b.device_id = s.device_id AND b.shift_id = s.id AND b.closed_at IS NOT NULL " +
          "AND b.disassembled_at IS NULL) >= 0 + ? * 0",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-close.test.ts`
Expected: FAIL — «writes nothing when a scan lands between its summary and its write», «writes nothing when a box is taken apart between its summary and its write».

М5 — закрытие не проверяет ждущую этикетку в своей транзакции.
В `apps/standalone/src/floor/close/shift-close.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
          "AND NOT EXISTS (SELECT 1 FROM floor_print_jobs j WHERE j.host_id = s.host_id " +
          `AND j.device_id = s.device_id AND j.shift_id = s.id AND ${OPEN_JOB_SQL}) ` +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-close.test.ts`
Expected: FAIL — «writes nothing when a label starts to wait between its summary and its write».

М6 — смена закрывается без причины при невыполненном плане.
В `apps/standalone/src/floor/close/shift-close.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (summary.reasonRequired && reasonCode === null) return { kind: "reason_required" };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-close.test.ts`
Expected: FAIL — «needs one of the six reasons when the plan is not met, and keeps one given without need».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/close/shift-close.ts apps/standalone/src/floor/facts.ts apps/standalone/src/floor/print/print-jobs.ts apps/standalone/test/floor-shift-close.test.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/close/shift-close.ts apps/standalone/src/floor/facts.ts apps/standalone/src/floor/print/print-jobs.ts apps/standalone/test/floor-shift-close.test.ts
git commit -m "feat(standalone): a station closes its shift in one local write, and no record of the shift follows its close" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Сводка закрытия на рабочем экране — план, факт, коробов, шесть причин, никого не держит

Сводка закрытия (`src/floor/close/ShiftClosePanel.tsx`, порт облачной сводки): «Закрыть смену» рабочего экрана открывает остановку `close`, сводку читает следующая работа очереди (скан, принятый до нажатия, в ней учтён); товар, план, факт, отклонение, коробов закрыто, в среднем в коробе («—» без коробов); открытый короб с кодами или ждущая этикетка — слова и «Назад к работе»; невыполненный план — шесть причин сеткой (`aria-pressed`), «Подтвердить закрытие» — только с выбранной. Закрытие — работа очереди, без хоста; потом остановка `closed`: «Смена закрыта. Данные будут отправлены автоматически», сканы не принимаются, «К списку смен». «Назад к работе» и «Выйти из смены» не держатся, кроме мгновения самой записи.

**Files:**

- Create: `apps/standalone/src/floor/close/ShiftClosePanel.tsx`
- Modify: `apps/standalone/src/app/shell.css`, `apps/standalone/src/floor/work/WorkScreen.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-work-close.test.tsx` (Create)

**Interfaces:**

- Consumes: задача 3 (`readCloseSummary`, `closeShift`, `CloseSummary`); `WorkScreen` (`Stop`, `queue`, `track`, `onLeave`, `onRecorded`); задача 2 (`test/support/work-screen.tsx`); домен `SHIFT_CLOSE_REASON_CODES`.
- Produces:
  - `ShiftClosePanel`, `ShiftClosedPanel`, `CloseNote`, `averagePerBox`, `deviation`;
  - `Stop` += `{ kind: "close"; summary: CloseSummary | null; note: CloseNote | null }` и `{ kind: "closed"; record: ShiftClosedFact }`; кнопка «Закрыть смену»; ключи `floor.close.*`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-work-close.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LocalExecutor } from "../src/local/executor.js";
import {
  ENTERED,
  enteredShift,
  failingWrites,
  holdingWrites,
  km,
  rows,
  SHIFT_ID,
} from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { printStation } from "./support/printing.js";
import { lastLine, renderWork, type WorkHarness } from "./support/work-screen.js";

type Station = Awaited<ReturnType<typeof printStation>>;

async function scanAll(work: WorkHarness, serials: readonly string[]): Promise<void> {
  await work.scanner.listening();
  await work.settled();
  for (const serial of serials) await work.scan(km(serial));
}

/** Twelve codes: the box fills, closes by itself, and its label goes to the printer. */
async function fillBox(work: WorkHarness, prefix = "P"): Promise<void> {
  await scanAll(
    work,
    Array.from({ length: 12 }, (_, index) => `${prefix}${index}`),
  );
}

function fact(name: string): string | null {
  const term = screen.getAllByText(name).find((element) => element.tagName === "DT");
  return term?.nextElementSibling?.textContent ?? null;
}

function outboxKinds(at: Station): unknown[] {
  return rows(at.db, "SELECT kind FROM outbox WHERE shift_id = ? ORDER BY seq", SHIFT_ID).map(
    (row) => row["kind"],
  );
}

function localState(at: Station): unknown {
  return rows(at.db, "SELECT local_state FROM floor_shifts WHERE id = ?", SHIFT_ID)[0]?.[
    "local_state"
  ];
}

describe("the close of a shift on the work screen", () => {
  it("shows the summary, asks one of the six reasons when the plan is not met, and closes without the host", async () => {
    const at = await printStation();
    const onLeave = vi.fn();
    const work = renderWork(at, { onLeave });
    await fillBox(work);
    await work.press("Закрыть смену");
    expect(await screen.findByText("Закрытие смены OCT26-004")).toBeTruthy();
    expect(fact("План")).toBe("1 200");
    expect(fact("Факт")).toBe("12");
    expect(fact("Отклонение")).toBe("−1 188");
    expect(fact("Коробов закрыто")).toBe("1");
    expect(fact("В среднем в коробе")).toBe("12");
    const confirm = screen.getByRole("button", { name: "Подтвердить закрытие" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Недостаток сырья" }));
    expect(
      screen.getByRole("button", { name: "Недостаток сырья" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText("Смена OCT26-004 закрыта")).toBeTruthy();
    expect(screen.getByText("Смена закрыта. Данные будут отправлены автоматически.")).toBeTruthy();
    expect(outboxKinds(at).at(-1)).toBe("shift_closed");
    const [closed] = rows(at.db, "SELECT payload FROM outbox WHERE kind = 'shift_closed'");
    expect(JSON.parse(String(closed?.["payload"]))).toMatchObject({
      data: {
        plannedQtySnapshot: 1_200,
        actualQty: 12,
        closedBoxCount: 1,
        reasonCode: "material_shortage",
      },
    });
    expect(localState(at)).toBe("closing");
    expect(work.props.onRecorded).toHaveBeenCalled();
    // A closed shift takes no scan again.
    await work.scan(km("Z1"));
    expect(lastLine()).toBe(
      "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.",
    );
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 12 }]);
    await work.press("К списку смен");
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("asks no reason when the plan is met", async () => {
    const at = await printStation();
    const shift = await enteredShift(at.local, { ...ENTERED, plannedQty: 12 });
    const work = renderWork({ local: at.local, shift });
    await fillBox(work);
    await work.press("Закрыть смену");
    await screen.findByText("Закрытие смены OCT26-004");
    expect(fact("Отклонение")).toBe("0");
    expect(
      screen.queryByRole("group", { name: "Факт не совпадает с планом. Выберите причину:" }),
    ).toBeNull();
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText("Смена OCT26-004 закрыта")).toBeTruthy();
  });

  it("is kept open by an open box with codes and sends the operator back to the work", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1", "A2"]);
    await work.press("Закрыть смену");
    expect(
      await screen.findByText(
        "В открытом коробе 2 шт. Сначала закройте его или очистите в «Исключениях».",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Подтвердить закрытие" })).toBeNull();
    await work.press("Назад к работе");
    await work.scan(km("A3"));
    expect(screen.getByText("3 из 12")).toBeTruthy();
    expect(localState(at)).toBeNull();
  });

  it("waits for a label that waits; once it is skipped the shift closes", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const work = renderWork(at, { shell });
    await fillBox(work);
    expect(screen.getByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Закрыть смену" }).hasAttribute("disabled")).toBe(
      true,
    );
    await work.press("Продолжить без этикетки");
    await work.press("Продолжить без этикетки");
    await work.press("Закрыть смену");
    await screen.findByText("Закрытие смены OCT26-004");
    fireEvent.click(screen.getByRole("button", { name: "Остановка оборудования" }));
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText("Смена OCT26-004 закрыта")).toBeTruthy();
    expect(outboxKinds(at).slice(-2)).toEqual(["box_label", "shift_closed"]);
  });

  it("counts the scan taken before the press: the summary waits for it and finds its box open", async () => {
    const at = await printStation();
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await fillBox(work);
    held.holdNext();
    act(() => work.scanner.emit(km("Q1")));
    await held.reached();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть смену" }));
    // The summary waits for the scan in the queue, however long the write takes.
    await act(async () => {
      for (let turn = 0; turn < 10; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
    expect(screen.getByText("Считаем итоги смены…")).toBeTruthy();
    held.release();
    await work.settled();
    expect(
      await screen.findByText(
        "В открытом коробе 1 шт. Сначала закройте его или очистите в «Исключениях».",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Подтвердить закрытие" })).toBeNull();
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 13 }]);
  });

  it("never holds the operator: «Выйти из смены» stays open on the summary and after the close", async () => {
    const at = await printStation();
    const onLeave = vi.fn();
    const work = renderWork(at, { onLeave });
    await fillBox(work);
    await work.press("Закрыть смену");
    await screen.findByText("Закрытие смены OCT26-004");
    await work.press("Выйти из смены");
    expect(onLeave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Ошибка в плановом количестве" }));
    await work.press("Подтвердить закрытие");
    await screen.findByText("Смена OCT26-004 закрыта");
    await work.press("Выйти из смены");
    expect(onLeave).toHaveBeenCalledTimes(2);
  });

  it("says a failed write, leaves the shift open, and lets the operator go back to the work", async () => {
    const at = await printStation();
    let broken = false;
    const local: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: (statements) =>
        broken ? failingWrites(at.local).transaction(statements) : at.local.transaction(statements),
    };
    const work = renderWork({ local, shift: at.shift });
    await fillBox(work);
    await work.press("Закрыть смену");
    await screen.findByText("Закрытие смены OCT26-004");
    fireEvent.click(screen.getByRole("button", { name: "Производственный брак" }));
    broken = true;
    await work.press("Подтвердить закрытие");
    expect(
      await screen.findByText(
        "Не удалось записать закрытие на этом компьютере. Смена не закрыта — повторите.",
      ),
    ).toBeTruthy();
    expect(localState(at)).toBeNull();
    expect(outboxKinds(at)).not.toContain("shift_closed");
    broken = false;
    await work.press("Назад к работе");
    await work.scan(km("A1"));
    expect(screen.getByText("1 из 12")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-close.test.tsx`
Expected: FAIL — `test/floor-work-close.test.tsx`: 7 из 7 (первый — «shows the summary, asks one of the six reasons when the plan is not met, and closes without the host»: `Unable to find an accessible element with the role "button" and name "Закрыть смену"`).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/app/shell.css`:

Фрагмент 1:

<!-- prettier-ignore -->
```css
}

/* The workstation setup (plan 2a7): one printer a row, its actions under it. */
```

заменить на:

<!-- prettier-ignore -->
```css
}

/* The summary of a shift's close (plan 2a8): its numbers, the six reasons
   as a grid, and the way back to the work. */
.work-screen__close {
  display: grid;
  gap: 16px;
}

.work-screen__close h3 {
  margin: 0;
}

/* The workstation setup (plan 2a7): one printer a row, its actions under it. */
```

Создать `apps/standalone/src/floor/close/ShiftClosePanel.tsx`:

<!-- prettier-ignore -->
```tsx
import { SHIFT_CLOSE_REASON_CODES, type ShiftCloseReasonCode } from "@markiro/domain";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import type { ShiftClosedFact } from "../../host/protocol.js";
import { formatQuantity } from "../shifts/shift-text.js";
import type { CloseSummary } from "./shift-close.js";

/** Why the summary is shown again: the shift changed meanwhile, no reason was chosen, or the write failed. */
export type CloseNote = "stale" | "reason" | "failed";

const AVERAGE = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

/** Units per closed box, one decimal at most; `null` without boxes. */
export function averagePerBox(actualQty: number, closedBoxes: number): string | null {
  return closedBoxes === 0 ? null : AVERAGE.format(actualQty / closedBoxes);
}

/** The fact against the plan, signed: «+5», «−3», «0». */
export function deviation(plannedQty: number, actualQty: number): string {
  const difference = actualQty - plannedQty;
  const sign = difference > 0 ? "+" : difference < 0 ? "−" : "";
  return `${sign}${formatQuantity(Math.abs(difference))}`;
}

export interface ShiftClosePanelProps {
  number: string;
  productName: string;
  /** `null` while the summary is read. */
  summary: CloseSummary | null;
  note: CloseNote | null;
  /** The close is being written: every button waits. */
  busy: boolean;
  onClose: (reason: ShiftCloseReasonCode | null) => void;
  /** Back to the work, never held but while the close writes. */
  onBack: () => void;
}

/**
 * The summary of a shift's close (stage 2a spec §5.7.7, the cloud station's
 * close summary): the product, the plan, the fact, the deviation, the
 * closed boxes and the units per box. A shift that cannot close yet says
 * why — an open box with codes, a label that waits — and sends the operator
 * back to the work, where both are resolved. When the plan is given and not
 * met, one of the domain's six reasons is chosen before «Закрыть смену».
 */
export function ShiftClosePanel({
  number,
  productName,
  summary,
  note,
  busy,
  onClose,
  onBack,
}: ShiftClosePanelProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<ShiftCloseReasonCode | null>(null);
  const back = (
    <Button size="floor" variant="secondary" disabled={busy} onClick={onBack}>
      {t("floor.close.back")}
    </Button>
  );
  const body = () => {
    if (summary === null) return <p>{t("floor.close.loading")}</p>;
    if (summary.blocker !== null) {
      const { blocker } = summary;
      return (
        <Alert tone="warn" title={t("floor.close.blockedTitle")}>
          <p>
            {blocker.kind === "open_box"
              ? t("floor.close.blocked.open_box", { quantity: formatQuantity(blocker.items) })
              : t(`floor.close.blocked.${blocker.kind}`)}
          </p>
          <div className="standalone-form__actions">{back}</div>
        </Alert>
      );
    }
    const average = averagePerBox(summary.actualQty, summary.closedBoxes);
    const chosen = summary.reasonRequired ? reason : null;
    return (
      <>
        <dl className="work-screen__facts">
          <div>
            <dt>{t("floor.close.product")}</dt>
            <dd>{productName}</dd>
          </div>
          <div>
            <dt>{t("floor.close.plan")}</dt>
            <dd>
              {summary.plannedQty === null
                ? t("floor.close.noPlan")
                : formatQuantity(summary.plannedQty)}
            </dd>
          </div>
          <div>
            <dt>{t("floor.close.actual")}</dt>
            <dd>{formatQuantity(summary.actualQty)}</dd>
          </div>
          {summary.plannedQty !== null && (
            <div>
              <dt>{t("floor.close.deviation")}</dt>
              <dd>{deviation(summary.plannedQty, summary.actualQty)}</dd>
            </div>
          )}
          <div>
            <dt>{t("floor.close.boxes")}</dt>
            <dd>{formatQuantity(summary.closedBoxes)}</dd>
          </div>
          <div>
            <dt>{t("floor.close.average")}</dt>
            <dd>{average ?? t("floor.close.none")}</dd>
          </div>
        </dl>
        {summary.reasonRequired && (
          <div role="group" aria-label={t("floor.close.reasonTitle")}>
            <p>{t("floor.close.reasonTitle")}</p>
            <div className="standalone-form__actions work-screen__reasons">
              {SHIFT_CLOSE_REASON_CODES.map((code) => (
                <Button
                  key={code}
                  size="floor"
                  variant={reason === code ? "primary" : "secondary"}
                  aria-pressed={reason === code}
                  disabled={busy}
                  onClick={() => setReason(code)}
                >
                  {t(`floor.close.reasons.${code}`)}
                </Button>
              ))}
            </div>
          </div>
        )}
        <div className="standalone-form__actions">
          {back}
          <Button
            size="floor"
            disabled={busy || (summary.reasonRequired && chosen === null)}
            onClick={() => onClose(chosen)}
          >
            {t("floor.close.confirm")}
          </Button>
        </div>
      </>
    );
  };
  return (
    <section className="work-screen__close" aria-label={t("floor.close.title", { number })}>
      <h3>{t("floor.close.title", { number })}</h3>
      {note !== null && <p role="alert">{t(`floor.close.notes.${note}`)}</p>}
      {busy && <p aria-live="polite">{t("floor.close.closing")}</p>}
      {body()}
    </section>
  );
}

export interface ShiftClosedPanelProps {
  number: string;
  record: ShiftClosedFact;
  onDone: () => void;
}

/**
 * The shift closed on this station: the same words with the link and without
 * it (stage 2a spec §5.7.7) — the record waits in the outbox until the host
 * takes it — and the way back to the list.
 */
export function ShiftClosedPanel({ number, record, onDone }: ShiftClosedPanelProps) {
  const { t } = useTranslation();
  return (
    <Alert tone="ok" title={t("floor.close.done.title", { number })}>
      <p>{t("floor.close.done.body")}</p>
      <p>
        {t("floor.close.done.numbers", {
          quantity: formatQuantity(record.actualQty),
          boxes: formatQuantity(record.closedBoxCount),
        })}
      </p>
      <div className="standalone-form__actions">
        <Button size="floor" onClick={onDone}>
          {t("floor.close.done.toList")}
        </Button>
      </div>
    </Alert>
  );
}
```

Правка `apps/standalone/src/floor/work/WorkScreen.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { formatSsccHri } from "@markiro/domain";
import type { TFunction } from "i18next";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { formatSsccHri, type ShiftCloseReasonCode } from "@markiro/domain";
import type { TFunction } from "i18next";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
import type { SystemAwake } from "../../hardware/awake.js";
import type { CodeCheck, SsccBlock, SsccBlockRequest } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import {
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { SystemAwake } from "../../hardware/awake.js";
import type {
  CodeCheck,
  ShiftClosedFact,
  SsccBlock,
  SsccBlockRequest,
} from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { ShiftClosedPanel, ShiftClosePanel, type CloseNote } from "../close/ShiftClosePanel.js";
import { closeShift, readCloseSummary, type CloseSummary } from "../close/shift-close.js";
import {
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
 * recovery when it failed or its outcome is unknown; plan 2a8 the
 * exceptions, with the shift's closed boxes once they are read.
 */
```

заменить на:

<!-- prettier-ignore -->
```tsx
 * recovery when it failed or its outcome is unknown; plan 2a8 the
 * exceptions, with the shift's closed boxes once they are read, the summary
 * of the shift's close, and the shift closed — which never lets a scan in
 * again.
 */
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  | { kind: "label"; job: PrintJob }
  | { kind: "exceptions"; boxes: readonly ClosedBox[] | null };

/** What an exception's failure says on the screen; anything unforeseen is this computer's failed write. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
  | { kind: "label"; job: PrintJob }
  | { kind: "exceptions"; boxes: readonly ClosedBox[] | null }
  | { kind: "close"; summary: CloseSummary | null; note: CloseNote | null }
  | { kind: "closed"; record: ShiftClosedFact };

/** What an exception's failure says on the screen; anything unforeseen is this computer's failed write. */
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
  const [sending, setSending] = useState(false);
  const capacity = shift.copy.boxCapacity;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const [sending, setSending] = useState(false);
  // The shift's close is being written.
  const [closing, setClosing] = useState(false);
  const capacity = shift.copy.boxCapacity;
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
    });

  /** The system error dismissed: the work goes on, after the label that may wait. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
    });

  /** The summary of the close, read as the line's next piece of work. */
  const readSummary = (note: CloseNote | null) =>
    queue.run(async () => {
      const summary = await readCloseSummary(local, where, shift.copy.id);
      if (stopRef.current?.kind === "close") setStop({ kind: "close", summary, note });
    });

  /** «Закрыть смену», opened while nothing stops the work: its summary first. */
  const openClose = () => {
    setPlanReached(false);
    setStop({ kind: "close", summary: null, note: null });
    void track(readSummary(null)).catch(() => setStop({ kind: "system_error" }));
  };

  /**
   * The close itself, as the line's next piece of work, so no scan or box
   * of the queue is left behind it: a local write that needs no host. A
   * shift that changed since the summary, or a write that failed, shows the
   * summary again with why.
   */
  const confirmClose = (reason: ShiftCloseReasonCode | null) => {
    const before = stopRef.current;
    if (before?.kind !== "close") return;
    setClosing(true);
    void track(
      queue.run(async () => {
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
          setStop({ ...before, note: "failed" });
        } finally {
          if (alive.current) setClosing(false);
        }
      }),
    ).catch(() => setStop({ kind: "system_error" }));
  };

  /** The system error dismissed: the work goes on, after the label that may wait. */
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
        )}
        {stop?.kind === "label" && (
```

заменить на:

<!-- prettier-ignore -->
```tsx
        )}
        {stop?.kind === "close" && (
          <ShiftClosePanel
            number={shift.copy.number}
            productName={shift.snapshot.product.name}
            summary={stop.summary}
            note={stop.note}
            busy={closing}
            onClose={confirmClose}
            onBack={() => setStop(null)}
          />
        )}
        {stop?.kind === "closed" && (
          <ShiftClosedPanel number={shift.copy.number} record={stop.record} onDone={onLeave} />
        )}
        {stop?.kind === "label" && (
```

Фрагмент 8:

<!-- prettier-ignore -->
```tsx
            </Button>
            <Button size="floor" variant="secondary" disabled={leaving} onClick={onLeave}>
```

заменить на:

<!-- prettier-ignore -->
```tsx
            </Button>
            <Button
              size="floor"
              variant="secondary"
              disabled={stop !== null || leaving}
              onClick={openClose}
            >
              {t("floor.close.open")}
            </Button>
            <Button size="floor" variant="secondary" disabled={leaving} onClick={onLeave}>
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
        "again": "Другое действие"
      }
```

заменить на:

<!-- prettier-ignore -->
```json
        "again": "Другое действие"
      }
    },
    "close": {
      "open": "Закрыть смену",
      "title": "Закрытие смены {{number}}",
      "loading": "Считаем итоги смены…",
      "product": "Товар",
      "plan": "План",
      "noPlan": "План не указан",
      "actual": "Факт",
      "deviation": "Отклонение",
      "boxes": "Коробов закрыто",
      "average": "В среднем в коробе",
      "none": "—",
      "reasonTitle": "Факт не совпадает с планом. Выберите причину:",
      "reasons": {
        "production_defect": "Производственный брак",
        "material_shortage": "Недостаток сырья",
        "equipment_stop": "Остановка оборудования",
        "production_order_changed": "Изменение производственного задания",
        "planned_quantity_error": "Ошибка в плановом количестве",
        "other_production_deviation": "Другое производственное отклонение"
      },
      "confirm": "Подтвердить закрытие",
      "back": "Назад к работе",
      "closing": "Закрываем смену…",
      "blockedTitle": "Смену пока не закрыть",
      "blocked": {
        "open_box": "В открытом коробе {{quantity}} шт. Сначала закройте его или очистите в «Исключениях».",
        "label": "Этикетка короба ещё ждёт решения. Решите её на рабочем экране, затем закройте смену.",
        "closed": "Смена уже закрыта на этой станции."
      },
      "notes": {
        "stale": "Пока вы смотрели итоги, смена изменилась: итоги посчитаны заново.",
        "reason": "Выберите причину расхождения.",
        "failed": "Не удалось записать закрытие на этом компьютере. Смена не закрыта — повторите."
      },
      "done": {
        "title": "Смена {{number}} закрыта",
        "body": "Смена закрыта. Данные будут отправлены автоматически.",
        "numbers": "Принято: {{quantity}} шт., коробов: {{boxes}}.",
        "toList": "К списку смен"
      }
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-close.test.tsx`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  7 passed (7)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  110 passed (110)`, `Tests  2625 passed (2625)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — сводка читается мимо очереди работы.
В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент 1

<!-- prettier-ignore -->
```tsx
  const readSummary = (note: CloseNote | null) =>
    queue.run(async () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const readSummary = (note: CloseNote | null) =>
    (async () => {
```

В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент 2

<!-- prettier-ignore -->
```tsx
      if (stopRef.current?.kind === "close") setStop({ kind: "close", summary, note });
    });
```

заменить на:

<!-- prettier-ignore -->
```tsx
      if (stopRef.current?.kind === "close") setStop({ kind: "close", summary, note });
    })();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-close.test.tsx`
Expected: FAIL — «counts the scan taken before the press: the summary waits for it and finds its box open».

М2 — «Подтвердить закрытие» доступно без причины.
В `apps/standalone/src/floor/close/ShiftClosePanel.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
            disabled={busy || (summary.reasonRequired && chosen === null)}
```

заменить на:

<!-- prettier-ignore -->
```tsx
            disabled={busy}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-close.test.tsx`
Expected: FAIL — «shows the summary, asks one of the six reasons when the plan is not met, and closes without the host».

М3 — после закрытия экран снова берёт работу.
В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
            setStop({ kind: "closed", record: result.record });
```

заменить на:

<!-- prettier-ignore -->
```tsx
            setStop(null);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-close.test.tsx`
Expected: FAIL — «shows the summary, asks one of the six reasons when the plan is not met, and closes without the host», «asks no reason when the plan is met», «waits for a label that waits; once it is skipped the shift closes», «never holds the operator: «Выйти из смены» stays open on the summary and after the close».

М4 — «Назад к работе» на сводке недоступно.
В `apps/standalone/src/floor/close/ShiftClosePanel.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    <Button size="floor" variant="secondary" disabled={busy} onClick={onBack}>
```

заменить на:

<!-- prettier-ignore -->
```tsx
    <Button size="floor" variant="secondary" disabled onClick={onBack}>
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-close.test.tsx`
Expected: FAIL — «is kept open by an open box with codes and sends the operator back to the work», «says a failed write, leaves the shift open, and lets the operator go back to the work».

М5 — «Закрыть смену» доступно при ждущей этикетке.
В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
              disabled={stop !== null || leaving}
              onClick={openClose}
```

заменить на:

<!-- prettier-ignore -->
```tsx
              disabled={leaving}
              onClick={openClose}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-close.test.tsx`
Expected: FAIL — «waits for a label that waits; once it is skipped the shift closes».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/app/shell.css apps/standalone/src/floor/close/ShiftClosePanel.tsx apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-work-close.test.tsx`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-work-close.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/floor-work-close.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/app/shell.css apps/standalone/src/floor/close/ShiftClosePanel.tsx apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-work-close.test.tsx
git commit -m "feat(standalone): the close summary on the work screen — plan, fact, boxes, the six reasons, never held" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Квитанция закрытия и список смен — `closed` по квитанции, отказ виден, список следует за очередью

Квитанции и список (§5.7.7, контракт 2a6): четвёртый оператор транзакции квитанций `sendFactBatch` переводит `closing` в `closed` у смены, чья запись `shift_closed` получила `accepted` (и с `alreadyClosed`); отказ оставляет `closing`, `readRefusedCloses` даёт код отказа, карточка списка его называет. Список перечитывает копии после каждой записи и пачки квитанций (`outboxVersion` от `App` через `FloorApp`), поэтому принятая смена уходит из него сама. Сквозной тест приложения: смена закрывается без хоста, после связи её записи уходят по порядку с `shift_closed` последней, и список её отпускает.

**Files:**

- Modify: `apps/standalone/src/app/App.tsx`, `apps/standalone/src/floor/FloorApp.tsx`, `apps/standalone/src/floor/close/shift-close.ts`, `apps/standalone/src/floor/shifts/ShiftCard.tsx`, `apps/standalone/src/floor/shifts/ShiftList.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/local/facts-sender.ts`
- Test: `apps/standalone/test/app.test.tsx` (Modify), `apps/standalone/test/facts-sender.test.ts` (Modify), `apps/standalone/test/floor-shift-list.test.tsx` (Modify)

**Interfaces:**

- Consumes: задачи 3–4; `sendFactBatch` (план 2a6), `ShiftList`, `ShiftCard` (план 2a5), `FloorApp`, `App` (`ShellState.outboxVersion`).
- Produces:
  - `readRefusedCloses(local, pairing): Promise<Map<string, string | null>>` (`shift-close.ts`);
  - `ShiftListProps.outboxVersion?`, `ShiftCardProps.refusal?: { code } | null`, `FloorAppProps.outboxVersion?`; ключ `floor.shifts.closeRefused`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/app.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
    ]);
  });
});

/**
```

заменить на:

<!-- prettier-ignore -->
```tsx
    ]);
  });

  it("closes the shift while the host is away; its close goes last once the host is back, and the list lets it go", async () => {
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
    // The block arrived with the link up; then the host goes away.
    await waitFor(() => expect(host.requestSsccBlock).toHaveBeenCalled());
    host.sendFacts.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "host away" }),
    );
    await link.status({ state: "offline", lastContactAt: 1, lastError: "unreachable", seq: 2 });
    for (const serial of ["A1", "A2"]) {
      scan(km(serial));
      await screen.findByText(`Принято: в коробе ${serial.slice(1)} из 12.`);
    }
    fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    fireEvent.click(await screen.findByRole("button", { name: "Закрыть короб" }));
    // No printer on this computer: the label fails, and the operator goes on without it.
    expect(await screen.findByText("Этикетка короба не напечатана")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Продолжить без этикетки" }));
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить без этикетки" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Закрыть смену" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Закрыть смену" }));
    fireEvent.click(await screen.findByRole("button", { name: "Подтвердить закрытие" }));
    expect(
      await screen.findByText("Смена закрыта. Данные будут отправлены автоматически."),
    ).toBeTruthy();
    const bar = screen.getByRole("region", { name: "Строка состояния цеха" });
    const unsent = () => within(bar).getByText("Не отправлено").nextElementSibling?.textContent;
    await waitFor(() => expect(unsent()).toBe("5"));
    fireEvent.click(screen.getByRole("button", { name: "К списку смен" }));
    expect(await screen.findByRole("button", { name: "Закрывается" })).toBeTruthy();
    host.sendFacts.mockImplementation(async (records) =>
      records.map((record) => ({
        id: (record as { id: string }).id,
        outcome: "accepted" as const,
      })),
    );
    await link.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(unsent()).toBe("0"));
    const delivered = host.sendFacts.mock.calls.at(-1)?.[0] ?? [];
    expect(delivered.map((record) => (record as { kind: string }).kind)).toEqual([
      "scan",
      "scan",
      "box_closed",
      "box_label",
      "shift_closed",
    ]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Закрывается" })).toBeNull());
  });
});

/**
```

Правка `apps/standalone/test/facts-sender.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import { processScan } from "../src/floor/work/scan-pipeline.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import { closeShift, readRefusedCloses } from "../src/floor/close/shift-close.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import { processScan } from "../src/floor/work/scan-pipeline.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
import {
  enteredShift,
  km,
  PAIRING,
  rows,
```

заменить на:

<!-- prettier-ignore -->
```ts
import {
  ENTERED,
  enteredShift,
  km,
  PAIRING,
  SECOND,
  rows,
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
const OTHER_PAIRING = { ...PAIRING, deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f" };
const WINNER = {
```

заменить на:

<!-- prettier-ignore -->
```ts
const OTHER_PAIRING = { ...PAIRING, deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f" };
/** A third shift this station entered. */
const THIRD = { ...ENTERED, id: "5f8b2d0e-3c6a-4e9f-b4d7-0a1c2e3f4d5b", number: "OCT26-006/S" };
const WINNER = {
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  });
});
```

заменить на:

<!-- prettier-ignore -->
```ts
  });

  it("makes the station's close closed once the host takes it, `alreadyClosed` too, and leaves a refused one closing", async () => {
    const { db, executor } = openLocalDb();
    const shifts = [ENTERED, SECOND, THIRD];
    for (const shift of shifts) {
      const work = await enteredShift(executor, shift);
      const result = await closeShift(
        scanContext(executor, work, { newId: () => crypto.randomUUID() }),
        "production_order_changed",
      );
      expect(result.kind).toBe("closed");
    }
    await keepEnteredShift(executor, OTHER_PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE device_id = ?").run(
      OTHER_PAIRING.deviceId,
    );
    const send = vi.fn(async (records: readonly unknown[]): Promise<FactReceipt[]> =>
      records.map((record) => {
        const { id, shiftId } = record as { id: string; shiftId: string };
        if (shiftId === SECOND.id) {
          return { id, outcome: "accepted", details: { alreadyClosed: true } };
        }
        if (shiftId === THIRD.id) {
          return { id, outcome: "rejected", code: "invalid_record", details: { field: "data" } };
        }
        return { id, outcome: "accepted" };
      }),
    );
    await sendFactBatch(executor, PAIRING, send, steppingClock());
    expect(
      rows(db, "SELECT id, device_id, local_state FROM floor_shifts ORDER BY device_id, id"),
    ).toEqual([
      { id: ENTERED.id, device_id: PAIRING.deviceId, local_state: "closed" },
      { id: SECOND.id, device_id: PAIRING.deviceId, local_state: "closed" },
      { id: THIRD.id, device_id: PAIRING.deviceId, local_state: "closing" },
      { id: ENTERED.id, device_id: OTHER_PAIRING.deviceId, local_state: "closing" },
    ]);
    expect(await readRefusedCloses(executor, PAIRING)).toEqual(
      new Map([[THIRD.id, "invalid_record"]]),
    );
  });

  it("leaves the close closing while its record has no receipt", async () => {
    const { db, executor } = openLocalDb();
    const work = await enteredShift(executor);
    await closeShift(
      scanContext(executor, work, { newId: () => crypto.randomUUID() }),
      "material_shortage",
    );
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    await expect(
      sendFactBatch(
        executor,
        PAIRING,
        async () => {
          throw down;
        },
        steppingClock(),
      ),
    ).rejects.toBe(down);
    expect(rows(db, "SELECT local_state FROM floor_shifts")).toEqual([{ local_state: "closing" }]);
  });
});
```

Правка `apps/standalone/test/floor-shift-list.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  enter?: (id: string) => Promise<EnteredShift>;
}
```

заменить на:

<!-- prettier-ignore -->
```tsx
  enter?: (id: string) => Promise<EnteredShift>;
  outboxVersion?: number;
}
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
        shiftReads={options.shiftReads ?? READ}
        notice={options.notice ?? null}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        shiftReads={options.shiftReads ?? READ}
        outboxVersion={options.outboxVersion ?? 0}
        notice={options.notice ?? null}
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  });

  it("reads its copies again after every read of the host's list", async () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  });

  it("says a close the host refused, and lets a close go once the host took it", async () => {
    const { db, executor } = await copiesOf([PLANNED, MINE], [ENTERED_MINE]);
    await keepEnteredShift(executor, PAIRING, { ...OPENED }, "2026-10-09T06:00:00.000Z", SEEN);
    db.prepare("UPDATE floor_shifts SET local_state = 'closing'").run();
    const record = (id: string, shiftId: string) =>
      `{"id":"${id}","kind":"shift_closed","shiftId":"${shiftId}","operatorId":null,"data":{}}`;
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, " +
        "outcome_code, acked_at) VALUES (?, ?, ?, 'shift_closed', ?, ?, '2026-10-09T08:00:00.000Z', " +
        "'rejected', 'invalid_record', '2026-10-09T08:00:01.000Z')",
    ).run(
      "11111111-1111-4111-8111-111111111111",
      HOST_ID,
      DEVICE_ID,
      PLANNED.id,
      record("11111111-1111-4111-8111-111111111111", PLANNED.id),
    );
    const handlers = handlersOf();
    const view = render(listOf(executor, handlers, {}));
    await screen.findByText("OCT26-005/S");
    expect(
      within(card("OCT26-005/S")).getByText(
        "Хост не принял закрытие смены (код invalid_record). Смену закроют в офисе.",
      ),
    ).toBeTruthy();
    expect(within(card(MINE.number)).queryByText(/Хост не принял/)).toBeNull();
    db.prepare("UPDATE floor_shifts SET local_state = 'closed' WHERE id = ?").run(MINE.id);
    view.rerender(listOf(executor, handlers, { outboxVersion: 1 }));
    await waitFor(() => expect(screen.queryByText(MINE.number)).toBeNull());
    expect(screen.getByText("OCT26-005/S")).toBeTruthy();
  });

  it("reads its copies again after every read of the host's list", async () => {
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/facts-sender.test.ts test/floor-shift-list.test.tsx`
Expected: FAIL — `test/facts-sender.test.ts` — «makes the station's close closed once the host takes it, `alreadyClosed` too, and leaves a refused one closing»; `test/floor-shift-list.test.tsx` — «says a close the host refused, and lets a close go once the host took it»; `test/app.test.tsx` — «closes the shift while the host is away; its close goes last once the host is back, and the list lets it go».

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/app/App.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
              shiftReads={state.shiftReads}
              lineChangePending={state.pendingDevice !== null}
```

заменить на:

<!-- prettier-ignore -->
```tsx
              shiftReads={state.shiftReads}
              outboxVersion={state.outboxVersion}
              lineChangePending={state.pendingDevice !== null}
```

Правка `apps/standalone/src/floor/FloorApp.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  shiftReads: { done: number; failed: boolean };
  /** The office moved the station to another line, and the move waits for the work (`pendingDevice`). */
```

заменить на:

<!-- prettier-ignore -->
```tsx
  shiftReads: { done: number; failed: boolean };
  /** `ShellState.outboxVersion`: the list reads its copies again after every write and receipt. */
  outboxVersion?: number;
  /** The office moved the station to another line, and the move waits for the work (`pendingDevice`). */
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  shiftReads,
  lineChangePending,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  shiftReads,
  outboxVersion = 0,
  lineChangePending,
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
      shiftReads={shiftReads}
      notice={view.notice}
```

заменить на:

<!-- prettier-ignore -->
```tsx
      shiftReads={shiftReads}
      outboxVersion={outboxVersion}
      notice={view.notice}
```

Правка `apps/standalone/src/floor/close/shift-close.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  return { kind: "closed", record: data };
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  return { kind: "closed", record: data };
}

const refusalRow = z.object({ shift_id: z.string(), code: z.string().nullable() });

/**
 * The shifts of this pairing whose close the host refused, with the code of
 * the refusal (`null` — none given). A refused record is refused for good
 * (plan 2a2): the shift stays `closing` on this station, and the office
 * closes it on the host.
 */
export async function readRefusedCloses(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<Map<string, string | null>> {
  const rows = await local.query(
    "SELECT shift_id, outcome_code AS code FROM outbox WHERE host_id = ? AND device_id = ? " +
      "AND kind = 'shift_closed' AND outcome = 'rejected' ORDER BY seq",
    [pairing.hostId, pairing.deviceId],
    refusalRow,
  );
  return new Map(rows.map((row) => [row.shift_id, row.code]));
}
```

Правка `apps/standalone/src/floor/shifts/ShiftCard.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  copy: ShiftCopy;
  action: CardAction;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  copy: ShiftCopy;
  /** The host refused this station's close of the shift, with the refusal's code (plan 2a8). */
  refusal?: { code: string | null } | null;
  action: CardAction;
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
/** One shift of the line (the cloud station's `ShiftCard` without the photo panel). */
export function ShiftCard({ copy, action, busy, onAction }: ShiftCardProps) {
  const { t } = useTranslation();
```

заменить на:

<!-- prettier-ignore -->
```tsx
/** One shift of the line (the cloud station's `ShiftCard` without the photo panel). */
export function ShiftCard({ copy, refusal = null, action, busy, onAction }: ShiftCardProps) {
  const { t } = useTranslation();
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
      {needsLink && <p className="shift-card__hint">{t("floor.shifts.needsLink")}</p>}
    </Card>
```

заменить на:

<!-- prettier-ignore -->
```tsx
      {needsLink && <p className="shift-card__hint">{t("floor.shifts.needsLink")}</p>}
      {refusal !== null && (
        <p className="shift-card__hint">
          {t("floor.shifts.closeRefused", { code: refusal.code ?? "—" })}
        </p>
      )}
    </Card>
```

Правка `apps/standalone/src/floor/shifts/ShiftList.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import type { Pairing } from "../../local/reference-sync.js";
import { readShiftCopies, type ShiftCopy, type WorkShift } from "./shift-copies.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { Pairing } from "../../local/reference-sync.js";
import { readRefusedCloses } from "../close/shift-close.js";
import { readShiftCopies, type ShiftCopy, type WorkShift } from "./shift-copies.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  shiftReads: { done: number; failed: boolean };
  notice: ShiftListNotice | null;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  shiftReads: { done: number; failed: boolean };
  /**
   * `ShellState.outboxVersion`: the list reads its copies again after every
   * write and every batch of receipts, so a close the host took leaves it.
   */
  outboxVersion?: number;
  notice: ShiftListNotice | null;
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
}

type Copies = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; copies: ShiftCopy[] };

/**
```

заменить на:

<!-- prettier-ignore -->
```tsx
}

type Copies =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; copies: ShiftCopy[]; refused: Map<string, string | null> };

/**
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  shiftReads,
  notice,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  shiftReads,
  outboxVersion = 0,
  notice,
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
    let cancelled = false;
    readShiftCopies(local, { hostId, deviceId }, lineId).then(
      (read) => {
        if (!cancelled) setCopies({ kind: "ready", copies: read });
      },
```

заменить на:

<!-- prettier-ignore -->
```tsx
    let cancelled = false;
    const pairing = { hostId, deviceId };
    Promise.all([readShiftCopies(local, pairing, lineId), readRefusedCloses(local, pairing)]).then(
      ([read, refused]) => {
        if (!cancelled) setCopies({ kind: "ready", copies: read, refused });
      },
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
    };
  }, [local, hostId, deviceId, lineId, shiftReads.done, attempt]);

  const choose = async (copy: ShiftCopy) => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
    };
  }, [local, hostId, deviceId, lineId, shiftReads.done, outboxVersion, attempt]);

  const choose = async (copy: ShiftCopy) => {
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
            copy={copy}
            action={cardAction(copy, deviceId, online)}
```

заменить на:

<!-- prettier-ignore -->
```tsx
            copy={copy}
            refusal={
              copy.localState === "closing" && copies.refused.has(copy.id)
                ? { code: copies.refused.get(copy.id) ?? null }
                : null
            }
            action={cardAction(copy, deviceId, online)}
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
      "officeClosed": "Смену {{number}} закрыли в офисе.",
      "entering": "Открываем смену…",
```

заменить на:

<!-- prettier-ignore -->
```json
      "officeClosed": "Смену {{number}} закрыли в офисе.",
      "closeRefused": "Хост не принял закрытие смены (код {{code}}). Смену закроют в офисе.",
      "entering": "Открываем смену…",
```

Правка `apps/standalone/src/local/facts-sender.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
 * the time on every record; a `conflict` of a scan marks the scan and its
 * box for review (`floor_scans.conflict`, `floor_boxes.needs_fix`); a
 * `rejected` record stays in the outbox with its code, for the queue screen.
 * A failed send or an answer that does not fit rejects and keeps nothing:
```

заменить на:

<!-- prettier-ignore -->
```ts
 * the time on every record; a `conflict` of a scan marks the scan and its
 * box for review (`floor_scans.conflict`, `floor_boxes.needs_fix`); an
 * `accepted` `shift_closed` — `alreadyClosed` too, a shift the office closed
 * first — makes this station's close `closed` (plan 2a8); a `rejected`
 * record stays in the outbox with its code, for the queue screen, and a
 * refused close leaves the shift `closing`.
 * A failed send or an answer that does not fit rejects and keeps nothing:
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
      values: [hostId, deviceId, hostId, deviceId, answers],
    },
  ]);
  return { sent: unsent.length, more: unsent.length === MAX_FACT_BATCH };
```

заменить на:

<!-- prettier-ignore -->
```ts
      values: [hostId, deviceId, hostId, deviceId, answers],
    },
    {
      sql:
        "UPDATE floor_shifts SET local_state = 'closed' WHERE host_id = ? AND device_id = ? " +
        "AND local_state = 'closing' AND id IN (SELECT shift_id FROM outbox " +
        "WHERE host_id = ? AND device_id = ? AND kind = 'shift_closed' AND outcome = 'accepted' " +
        "AND id IN (SELECT value ->> 'id' FROM json_each(?)))",
      values: [hostId, deviceId, hostId, deviceId, answers],
    },
  ]);
  return { sent: unsent.length, more: unsent.length === MAX_FACT_BATCH };
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/facts-sender.test.ts test/floor-shift-list.test.tsx`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  130 passed (130)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  110 passed (110)`, `Tests  2629 passed (2629)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — квитанция `accepted` закрытия не переводит смену в `closed`.
В `apps/standalone/src/local/facts-sender.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
    {
      sql:
        "UPDATE floor_shifts SET local_state = 'closed' WHERE host_id = ? AND device_id = ? " +
        "AND local_state = 'closing' AND id IN (SELECT shift_id FROM outbox " +
        "WHERE host_id = ? AND device_id = ? AND kind = 'shift_closed' AND outcome = 'accepted' " +
        "AND id IN (SELECT value ->> 'id' FROM json_each(?)))",
      values: [hostId, deviceId, hostId, deviceId, answers],
    },
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/facts-sender.test.ts`
Expected: FAIL — «makes the station's close closed once the host takes it, `alreadyClosed` too, and leaves a refused one closing».

М2 — отказ в закрытии тоже переводит смену в `closed`.
В `apps/standalone/src/local/facts-sender.ts` фрагмент

<!-- prettier-ignore -->
```ts
        "WHERE host_id = ? AND device_id = ? AND kind = 'shift_closed' AND outcome = 'accepted' " +
```

заменить на:

<!-- prettier-ignore -->
```ts
        "WHERE host_id = ? AND device_id = ? AND kind = 'shift_closed' AND outcome IS NOT NULL " +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/facts-sender.test.ts`
Expected: FAIL — «makes the station's close closed once the host takes it, `alreadyClosed` too, and leaves a refused one closing».

М3 — список не перечитывает копии после квитанций.
В `apps/standalone/src/floor/shifts/ShiftList.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  }, [local, hostId, deviceId, lineId, shiftReads.done, outboxVersion, attempt]);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }, [local, hostId, deviceId, lineId, shiftReads.done, attempt]);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-list.test.tsx`
Expected: FAIL — «says a close the host refused, and lets a close go once the host took it».

М4 — отказ в закрытии не виден в карточке.
В `apps/standalone/src/floor/shifts/ShiftCard.tsx` удалить фрагмент

<!-- prettier-ignore -->
```tsx
      {refusal !== null && (
        <p className="shift-card__hint">
          {t("floor.shifts.closeRefused", { code: refusal.code ?? "—" })}
        </p>
      )}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-list.test.tsx`
Expected: FAIL — «says a close the host refused, and lets a close go once the host took it».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/app/App.tsx apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/floor/close/shift-close.ts apps/standalone/src/floor/shifts/ShiftCard.tsx apps/standalone/src/floor/shifts/ShiftList.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/local/facts-sender.ts apps/standalone/test/app.test.tsx apps/standalone/test/facts-sender.test.ts apps/standalone/test/floor-shift-list.test.tsx`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/app.test.tsx test/floor-shift-list.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/app.test.tsx test/floor-shift-list.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/app/App.tsx apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/floor/close/shift-close.ts apps/standalone/src/floor/shifts/ShiftCard.tsx apps/standalone/src/floor/shifts/ShiftList.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/local/facts-sender.ts apps/standalone/test/app.test.tsx apps/standalone/test/facts-sender.test.ts apps/standalone/test/floor-shift-list.test.tsx
git commit -m "feat(standalone): the host's receipt closes the shift on the station; the list follows the outbox and names a refused close" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Смена, закрытая офисом, — доводится на станции без новых кодов

Смена, которую закрыл офис (решение 18, уточнение §5.4): `FloorApp` после чтения списка больше не выводит оператора, а сообщает рабочему экрану `officeClosed` — тот не принимает новых кодов (скан называется словами, не журналируется), а короб, этикетка, исключения и закрытие смены работают; хост принимает эти записи поздними, закрытие — `alreadyClosed`. Список показывает такую смену, если станция в неё входила и не закрыла её, — «Закрыта в офисе», «Завершить», вход по сохранённому снимку без хоста (который такую смену не открывает). Собственное закрытие станции важнее: смена `closing`, которую закрыл и офис, остаётся «Закрывается». Уведомление списка «Смену … закрыли в офисе» и тип `ShiftListNotice` удаляются — их больше никто не выдаёт.

**Files:**

- Modify: `apps/standalone/src/floor/FloorApp.tsx`, `apps/standalone/src/floor/shifts/ShiftCard.tsx`, `apps/standalone/src/floor/shifts/ShiftList.tsx`, `apps/standalone/src/floor/shifts/shift-copies.ts`, `apps/standalone/src/floor/shifts/shift-entry.ts`, `apps/standalone/src/floor/work/WorkScreen.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-app.test.tsx` (Modify), `apps/standalone/test/floor-shift-list.test.tsx` (Modify), `apps/standalone/test/floor-work-close.test.tsx` (Modify), `apps/standalone/test/shift-copies.test.ts` (Modify)

**Interfaces:**

- Consumes: задачи 4–5; `readShiftCopies`, `enterShift`, `cardAction`, `ShiftCard`, `ShiftList`, `FloorApp` (план 2a5); `WorkScreen`.
- Produces:
  - `WorkScreenProps.officeClosed?: boolean`; `CardAction` += `{ kind: "finish" }`; `readShiftCopies` показывает закрытую хостом смену, в которую станция входила, пока станция её не закрыла; `enterShift` входит в неё по снимку без хоста;
  - ключи `floor.work.officeClosed.*`, `floor.work.last.officeClosed`, `floor.shifts.status.office_closed`, `floor.shifts.action.finish`, `floor.shifts.finishHint`; удалены `ShiftListNotice`, `ShiftListProps.notice`, ключ `floor.shifts.officeClosed`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/floor-app.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  });

  it("takes the operator back to the list when the office closed the shift", async () => {
    const local = await floorCopies();
```

заменить на:

<!-- prettier-ignore -->
```tsx
  });

  it("keeps the operator in the shift the office closed, to finish it, and takes no new code", async () => {
    const local = await floorCopies();
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
    view.rerender(floorOf(local, handlers, { shiftReads: { done: 2, failed: false } }));
    expect(await screen.findByText("Смену OCT26-005/S закрыли в офисе.")).toBeTruthy();
    expect(types(handlers)).toContain("work_left");
    expect(handlers.onSignOut).not.toHaveBeenCalled();
```

заменить на:

<!-- prettier-ignore -->
```tsx
    view.rerender(floorOf(local, handlers, { shiftReads: { done: 2, failed: false } }));
    expect(await screen.findByText("Смену закрыли в офисе")).toBeTruthy();
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
    expect(types(handlers)).not.toContain("work_left");
    // Back in the list it waits to be finished, and «Завершить» comes back to it.
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    fireEvent.click(await screen.findByRole("button", { name: "Завершить" }));
    expect(await screen.findByText("Смену закрыли в офисе")).toBeTruthy();
    expect(handlers.enter).toHaveBeenCalledTimes(1);
    expect(handlers.onSignOut).not.toHaveBeenCalled();
```

Правка `apps/standalone/test/floor-shift-list.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
} from "../src/floor/shifts/shift-copies.js";
import { ShiftList, type ShiftListNotice } from "../src/floor/shifts/ShiftList.js";
import { HostError } from "../src/host/client.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
} from "../src/floor/shifts/shift-copies.js";
import { ShiftList } from "../src/floor/shifts/ShiftList.js";
import { HostError } from "../src/host/client.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  shiftReads?: { done: number; failed: boolean };
  notice?: ShiftListNotice | null;
  enter?: (id: string) => Promise<EnteredShift>;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  shiftReads?: { done: number; failed: boolean };
  enter?: (id: string) => Promise<EnteredShift>;
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
        outboxVersion={options.outboxVersion ?? 0}
        notice={options.notice ?? null}
        enter={options.enter ?? handlers.enter}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        outboxVersion={options.outboxVersion ?? 0}
        enter={options.enter ?? handlers.enter}
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  });

  it("reads its copies again after every read of the host's list", async () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  });

  it("offers to finish a shift the office closed after this station entered it, without asking the host", async () => {
    const { db, executor } = await copiesOf([], [ENTERED_MINE, OPENED]);
    const closed = { status: "closed" as const, closedAt: "2026-10-09T18:00:00Z" };
    await replaceShiftCopies(
      executor,
      PAIRING,
      [
        { ...MINE, ...closed },
        { ...PLANNED, ...closed },
      ],
      SEEN + 1,
    );
    // A shift this station closed itself stays closing, whatever the office did.
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE id = ?").run(PLANNED.id);
    const { handlers } = renderList(executor);
    await screen.findByText(MINE.number);
    expect(
      within(card(PLANNED.number)).getByRole("button", { name: "Закрывается" }),
    ).toHaveProperty("disabled", true);
    const finished = card(MINE.number);
    expect(within(finished).getByText("Закрыта в офисе")).toBeTruthy();
    expect(
      within(finished).getByText(
        "Смену закрыли в офисе. Закончите на станции короб и этикетку и закройте смену.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(finished).getByRole("button", { name: "Завершить" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(handlers.enter).not.toHaveBeenCalled();
    expect(handlers.onEntered.mock.calls[0]?.[0].copy).toMatchObject({
      id: MINE.id,
      status: "closed",
      localState: null,
    });
  });

  it("reads its copies again after every read of the host's list", async () => {
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
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
```

заменить на:

<!-- prettier-ignore -->
```tsx
  });

  it("says when the host's list did not update", async () => {
    const { executor } = await copiesOf([PLANNED]);
    renderList(executor, { shiftReads: { done: 1, failed: true } });
    expect(
      await screen.findByText("Список смен не обновился с хоста — показаны полученные раньше."),
    ).toBeTruthy();
  });
```

Правка `apps/standalone/test/floor-work-close.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  });
});
```

заменить на:

<!-- prettier-ignore -->
```tsx
  });
});

describe("a shift the office closed while the station worked in it", () => {
  it("takes no new code, but closes the box with its label and the shift as usual", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1", "A2"]);
    work.rerender({ officeClosed: true });
    expect(screen.getByText("Смену закрыли в офисе")).toBeTruthy();
    await work.scan(km("A3"));
    expect(lastLine()).toBe("Скан не принят: смену закрыли в офисе.");
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 2 }]);
    await work.press("Закрыть короб");
    await work.press("Закрыть короб");
    expect(work.shell.sends).toHaveLength(1);
    await work.press("Закрыть смену");
    await screen.findByText("Закрытие смены OCT26-004");
    fireEvent.click(screen.getByRole("button", { name: "Изменение производственного задания" }));
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText("Смена OCT26-004 закрыта")).toBeTruthy();
    expect(screen.queryByText("Смену закрыли в офисе")).toBeNull();
    expect(outboxKinds(at)).toEqual(["scan", "scan", "box_closed", "shift_closed"]);
  });
});
```

Правка `apps/standalone/test/shift-copies.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
    });
    // An entered shift the host closed leaves the list but not the copies.
    await replaceShiftCopies(
```

заменить на:

<!-- prettier-ignore -->
```ts
    });
    // An entered shift the host closed stays, to be finished on this station (plan 2a8).
    await replaceShiftCopies(
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
    );
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toEqual([]);
    expect(await readShiftCopy(executor, PAIRING, ENTERED.id)).toMatchObject({
```

заменить на:

<!-- prettier-ignore -->
```ts
    );
    expect((await readShiftCopies(executor, PAIRING, LINE_ID)).map((copy) => copy.id)).toEqual([
      ENTERED.id,
    ]);
    expect(await readShiftCopy(executor, PAIRING, ENTERED.id)).toMatchObject({
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  });

  it("show a shift this station is closing, and neither one it closed nor one the host closed", async () => {
    const { db, executor } = openLocalDb();
```

заменить на:

<!-- prettier-ignore -->
```ts
  });

  it("show a shift this station is closing, and neither one it closed nor one the host closed that it never entered", async () => {
    const { db, executor } = openLocalDb();
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
      PLANNED.id,
    ]);
  });

  it("leave another pairing's rows alone, the same shift ids included", async () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
      PLANNED.id,
    ]);
  });

  it("show a shift the office closed after this station entered it, until this station closes it", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    const closed = { status: "closed" as const, closedAt: "2026-10-09T18:00:00Z" };
    await replaceShiftCopies(
      executor,
      PAIRING,
      [
        { ...ACTIVE, ...closed },
        { ...PLANNED, ...closed },
      ],
      SEEN,
    );
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toMatchObject([
      { id: ACTIVE.id, status: "closed", localState: null, entered: true },
    ]);
    // The station's own close stays its own: the host's list never touches it.
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE id = ?").run(ACTIVE.id);
    await replaceShiftCopies(executor, PAIRING, [{ ...ACTIVE, ...closed }], SEEN + 1);
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toMatchObject([
      { id: ACTIVE.id, status: "closed", localState: "closing" },
    ]);
    db.prepare("UPDATE floor_shifts SET local_state = 'closed' WHERE id = ?").run(ACTIVE.id);
    await replaceShiftCopies(executor, PAIRING, [{ ...ACTIVE, ...closed }], SEEN + 2);
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toEqual([]);
    expect((await readShiftCopy(executor, PAIRING, ACTIVE.id))?.localState).toBe("closed");
  });

  it("leave another pairing's rows alone, the same shift ids included", async () => {
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx test/floor-shift-list.test.tsx test/floor-work-close.test.tsx test/shift-copies.test.ts`
Expected: FAIL — `test/floor-shift-list.test.tsx`: 23 из 23 (`TypeError: Cannot read properties of undefined (reading 'number')`: список ещё ждёт свойство `notice`, которого тесты уже не передают); `test/floor-app.test.tsx` — «keeps the operator in the shift the office closed, to finish it, and takes no new code»; `test/floor-work-close.test.tsx` — «takes no new code, but closes the box with its label and the shift as usual»; `test/shift-copies.test.ts` — «keep a shift this station entered, with its snapshot, whatever a later list says» и «show a shift the office closed after this station entered it, until this station closes it».

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/floor/FloorApp.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { readShiftCopy, type WorkShift } from "./shifts/shift-copies.js";
import { ShiftList, type ShiftListNotice } from "./shifts/ShiftList.js";
import { readOperatorCopy } from "./sign-in.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { readShiftCopy, type WorkShift } from "./shifts/shift-copies.js";
import { ShiftList } from "./shifts/ShiftList.js";
import { readOperatorCopy } from "./sign-in.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
/**
 * Why the operator leaves the shift: back to the list, the office closed it,
 * a sign-out, another line, or the workstation setup from a label's recovery
 * (plan 2a7), which comes back to the shift.
 */
type Leave =
  | { kind: "list"; notice: ShiftListNotice | null }
  | { kind: "sign_out"; notice: FloorNotice | null }
  | { kind: "line_changed" }
  | { kind: "setup"; shift: WorkShift };

type FloorView =
  | { kind: "list"; notice: ShiftListNotice | null }
  | { kind: "new_shift" }
  | { kind: "work"; shift: WorkShift; leaving: boolean }
  | { kind: "setup"; back: WorkShift | null };
```

заменить на:

<!-- prettier-ignore -->
```tsx
/**
 * Why the operator leaves the shift: back to the list, a sign-out, another
 * line, or the workstation setup from a label's recovery (plan 2a7), which
 * comes back to the shift. A shift the office closed is no reason: it is
 * finished on the work screen (plan 2a8).
 */
type Leave =
  | { kind: "list" }
  | { kind: "sign_out"; notice: FloorNotice | null }
  | { kind: "line_changed" }
  | { kind: "setup"; shift: WorkShift };

/**
 * The floor's screens; in the work of a shift, `officeClosed` says the
 * office closed the shift after this station entered it (plan 2a8).
 */
type FloorView =
  | { kind: "list" }
  | { kind: "new_shift" }
  | { kind: "work"; shift: WorkShift; leaving: boolean; officeClosed: boolean }
  | { kind: "setup"; back: WorkShift | null };
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  const online = link?.state === "online" && !rejectionPending;
  const [view, setView] = useState<FloorView>({ kind: "list", notice: null });
  const gate = useMemo(() => createWorkGate(), []);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const online = link?.state === "online" && !rejectionPending;
  const [view, setView] = useState<FloorView>({ kind: "list" });
  const gate = useMemo(() => createWorkGate(), []);
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
    // Another line: `work_left` already moved the station and ended the session.
    if (leave.kind === "list") setView({ kind: "list", notice: leave.notice });
    if (leave.kind === "setup") setView({ kind: "setup", back: leave.shift });
```

заменить на:

<!-- prettier-ignore -->
```tsx
    // Another line: `work_left` already moved the station and ended the session.
    if (leave.kind === "list") setView({ kind: "list" });
    if (leave.kind === "setup") setView({ kind: "setup", back: leave.shift });
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
  // After every read of the host's list: a shift the office closed while the
  // operator works in it takes them back to the list.
  const workShiftId = view.kind === "work" ? view.shift.copy.id : null;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  // After every read of the host's list: a shift the office closed while the
  // operator works in it stays on screen to be finished (plan 2a8) — the box
  // on the line closes with its label, and the station closes the shift —
  // but it takes no new code. Leaving at once would strand the box and its
  // label; the host takes what follows and marks the shift late.
  const workShiftId = view.kind === "work" ? view.shift.copy.id : null;
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
        if (copy.status === "closed" && copy.localState === null) {
          leave({ kind: "list", notice: { kind: "office_closed", number: copy.number } });
        }
```

заменить на:

<!-- prettier-ignore -->
```tsx
        if (copy.status === "closed" && copy.localState === null) {
          setView((now) =>
            now.kind === "work" && now.shift.copy.id === copy.id
              ? { ...now, officeClosed: true }
              : now,
          );
        }
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
    };
  }, [local, hostId, deviceId, workShiftId, shiftReads.done, leave]);

  // Another line waits for the work (question В9): leave the shift for it.
```

заменить на:

<!-- prettier-ignore -->
```tsx
    };
  }, [local, hostId, deviceId, workShiftId, shiftReads.done]);

  // Another line waits for the work (question В9): leave the shift for it.
```

Фрагмент 8:

<!-- prettier-ignore -->
```tsx
      current.current.dispatch({ type: "work_entered", sessionId, shiftId: shift.copy.id });
      setView({ kind: "work", shift, leaving: false });
    },
```

заменить на:

<!-- prettier-ignore -->
```tsx
      current.current.dispatch({ type: "work_entered", sessionId, shiftId: shift.copy.id });
      setView({
        kind: "work",
        shift,
        leaving: false,
        officeClosed: shift.copy.status === "closed",
      });
    },
```

Фрагмент 9:

<!-- prettier-ignore -->
```tsx
        // Back to the shift the setup was opened from, or to the list.
        onBack={() => (back === null ? setView({ kind: "list", notice: null }) : entered(back))}
      />
```

заменить на:

<!-- prettier-ignore -->
```tsx
        // Back to the shift the setup was opened from, or to the list.
        onBack={() => (back === null ? setView({ kind: "list" }) : entered(back))}
      />
```

Фрагмент 10:

<!-- prettier-ignore -->
```tsx
        leaving={view.leaving}
        onLeave={() => leave({ kind: "list", notice: null })}
        source={source}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        leaving={view.leaving}
        officeClosed={view.officeClosed}
        onLeave={() => leave({ kind: "list" })}
        source={source}
```

Фрагмент 11:

<!-- prettier-ignore -->
```tsx
        onHostError={hostError}
        onBack={() => setView({ kind: "list", notice: null })}
      />
```

заменить на:

<!-- prettier-ignore -->
```tsx
        onHostError={hostError}
        onBack={() => setView({ kind: "list" })}
      />
```

Фрагмент 12:

<!-- prettier-ignore -->
```tsx
      outboxVersion={outboxVersion}
      notice={view.notice}
      enter={enter}
```

заменить на:

<!-- prettier-ignore -->
```tsx
      outboxVersion={outboxVersion}
      enter={enter}
```

Правка `apps/standalone/src/floor/shifts/ShiftCard.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
 * What the card offers: open a planned shift, continue the active one this
 * station opened, or nothing for a shift another station opened or one this
 * station is closing. `enabled` is false where the host is needed and away.
 */
export type CardAction =
  | { kind: "open"; enabled: boolean }
  | { kind: "continue"; enabled: boolean }
  | { kind: "busy" }
```

заменить на:

<!-- prettier-ignore -->
```tsx
 * What the card offers: open a planned shift, continue the active one this
 * station opened, finish one the office closed after this station entered it
 * (plan 2a8; no host needed), or nothing for a shift another station opened
 * or one this station is closing. `enabled` is false where the host is
 * needed and away.
 */
export type CardAction =
  | { kind: "open"; enabled: boolean }
  | { kind: "continue"; enabled: boolean }
  | { kind: "finish" }
  | { kind: "busy" }
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  if (copy.localState === "closing") return { kind: "closing" };
  if (copy.status === "active") {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  if (copy.localState === "closing") return { kind: "closing" };
  if (copy.status === "closed") return { kind: "finish" };
  if (copy.status === "active") {
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
}

const PHASE: Record<"planned" | "active" | "closing", TagPhase> = {
  planned: "planned",
  active: "active",
  closing: "running",
};
```

заменить на:

<!-- prettier-ignore -->
```tsx
}

const PHASE: Record<"planned" | "active" | "closing" | "office_closed", TagPhase> = {
  planned: "planned",
  active: "active",
  closing: "running",
  office_closed: "attention",
};
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  const phase =
    copy.localState === "closing" ? "closing" : copy.status === "active" ? "active" : "planned";
  const enabled = (action.kind === "open" || action.kind === "continue") && action.enabled;
  const needsLink = (action.kind === "open" || action.kind === "continue") && !action.enabled;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const phase =
    copy.localState === "closing"
      ? "closing"
      : copy.status === "active"
        ? "active"
        : copy.status === "closed"
          ? "office_closed"
          : "planned";
  const enabled =
    action.kind === "finish" ||
    ((action.kind === "open" || action.kind === "continue") && action.enabled);
  const needsLink = (action.kind === "open" || action.kind === "continue") && !action.enabled;
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
        fullWidth
        variant={action.kind === "continue" ? "primary" : "secondary"}
        disabled={busy || !enabled}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        fullWidth
        variant={action.kind === "continue" || action.kind === "finish" ? "primary" : "secondary"}
        disabled={busy || !enabled}
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
      {needsLink && <p className="shift-card__hint">{t("floor.shifts.needsLink")}</p>}
      {refusal !== null && (
```

заменить на:

<!-- prettier-ignore -->
```tsx
      {needsLink && <p className="shift-card__hint">{t("floor.shifts.needsLink")}</p>}
      {action.kind === "finish" && (
        <p className="shift-card__hint">{t("floor.shifts.finishHint")}</p>
      )}
      {refusal !== null && (
```

Правка `apps/standalone/src/floor/shifts/ShiftList.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { cardAction, ShiftCard } from "./ShiftCard.js";

/** What the list says it was brought back for: the office closed the shift the operator worked in. */
export type ShiftListNotice = { kind: "office_closed"; number: string };

export interface ShiftListProps {
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { cardAction, ShiftCard } from "./ShiftCard.js";

export interface ShiftListProps {
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  outboxVersion?: number;
  notice: ShiftListNotice | null;
  /** `HostApi.enterShift`. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
  outboxVersion?: number;
  /** `HostApi.enterShift`. */
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  outboxVersion = 0,
  notice,
  enter,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  outboxVersion = 0,
  enter,
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
            <Alert tone="error">{t(`floor.shifts.refused.${refusal}`)}</Alert>
          ) : notice !== null ? (
            <Alert tone="info">{t("floor.shifts.officeClosed", { number: notice.number })}</Alert>
          ) : !online ? (
```

заменить на:

<!-- prettier-ignore -->
```tsx
            <Alert tone="error">{t(`floor.shifts.refused.${refusal}`)}</Alert>
          ) : !online ? (
```

Правка `apps/standalone/src/floor/shifts/shift-copies.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
 * The shifts of `lineId` the floor's list shows, from this pairing's copies:
 * planned and active ones, and one this station is closing; neither a shift
 * the host closed nor one this station closed. By production date, then
 * number.
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
 * The shifts of `lineId` the floor's list shows, from this pairing's copies:
 * planned and active ones, one this station is closing, and one the office
 * closed after this station entered it and before this station closed it
 * (plan 2a8: the station finishes it); neither another shift the host closed
 * nor one this station closed. By production date, then number.
 */
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
    `SELECT ${COPY_COLUMNS} FROM floor_shifts WHERE host_id = ? AND device_id = ? ` +
      "AND line_id = ? AND status <> 'closed' AND (local_state IS NULL OR local_state = 'closing') " +
      "ORDER BY production_date, number, id",
```

заменить на:

<!-- prettier-ignore -->
```ts
    `SELECT ${COPY_COLUMNS} FROM floor_shifts WHERE host_id = ? AND device_id = ? ` +
      "AND line_id = ? AND (status <> 'closed' OR entered_at IS NOT NULL) " +
      "AND (local_state IS NULL OR local_state = 'closing') " +
      "ORDER BY production_date, number, id",
```

Правка `apps/standalone/src/floor/shifts/shift-entry.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
 * the link down, or a request that never reached the host, only an active
 * shift this station entered before is entered, from its stored snapshot.
 * Opening a planned shift and freezing its snapshot are the host's, so a
```

заменить на:

<!-- prettier-ignore -->
```ts
 * the link down, or a request that never reached the host, only an active
 * shift this station entered before is entered, from its stored snapshot;
 * so is a shift the office closed after this station entered it, to finish
 * it (plan 2a8).
 * Opening a planned shift and freezing its snapshot are the host's, so a
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  if (copy.localState !== null) return { kind: "refused", reason: "closed" };
  if (!context.online) return storedWork(context, copy.id);
  let answer: EnteredShift;
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (copy.localState !== null) return { kind: "refused", reason: "closed" };
  // The office closed it after this station entered: finished from the
  // stored snapshot, without the host, which refuses to enter a closed shift.
  if (copy.status === "closed" || !context.online) return storedWork(context, copy.id);
  let answer: EnteredShift;
```

Правка `apps/standalone/src/floor/work/WorkScreen.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  render?: RenderLabel;
}
```

заменить на:

<!-- prettier-ignore -->
```tsx
  render?: RenderLabel;
  /**
   * The office closed the shift after this station entered it (plan 2a8):
   * no new code is taken, while the box, its label, the exceptions and the
   * shift's close are finished as usual.
   */
  officeClosed?: boolean;
}
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
/** The last scan, said in words under the box. */
type Last = ScanOutcome | { kind: "paused"; leaving: boolean };

/** How long the coloured flash of a verdict covers the screen. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
/** The last scan, said in words under the box. */
type Last = ScanOutcome | { kind: "paused"; leaving: boolean } | { kind: "office_closed" };

/** How long the coloured flash of a verdict covers the screen. */
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
      return t(last.leaving ? "floor.work.last.leaving" : "floor.work.last.paused");
  }
```

заменить на:

<!-- prettier-ignore -->
```tsx
      return t(last.leaving ? "floor.work.last.leaving" : "floor.work.last.paused");
    case "office_closed":
      return t("floor.work.last.officeClosed");
  }
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  render,
}: WorkScreenProps) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  render,
  officeClosed = false,
}: WorkScreenProps) {
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
  // What a queued job reads when it runs, later than the render that queued it.
  const live = useRef({ online, leaving, touch, track, onHostError, onRecorded, signal, t });
  useLayoutEffect(() => {
    live.current = { online, leaving, touch, track, onHostError, onRecorded, signal, t };
  });
```

заменить на:

<!-- prettier-ignore -->
```tsx
  // What a queued job reads when it runs, later than the render that queued it.
  const live = useRef({
    online,
    leaving,
    officeClosed,
    touch,
    track,
    onHostError,
    onRecorded,
    signal,
    t,
  });
  useLayoutEffect(() => {
    live.current = {
      online,
      leaving,
      officeClosed,
      touch,
      track,
      onHostError,
      onRecorded,
      signal,
      t,
    };
  });
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
      }
      let outcome: ScanOutcome;
```

заменить на:

<!-- prettier-ignore -->
```tsx
      }
      // A shift the office closed takes no new code: nothing is journalled.
      if (live.current.officeClosed) {
        setLast({ kind: "office_closed" });
        show("error", live.current.t("floor.work.signal.paused"));
        return;
      }
      let outcome: ScanOutcome;
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
      <div className="standalone-form">
        <p className="shift-card__product">
```

заменить на:

<!-- prettier-ignore -->
```tsx
      <div className="standalone-form">
        {officeClosed && stop?.kind !== "closed" && (
          <Alert tone="warn" title={t("floor.work.officeClosed.title")}>
            {t("floor.work.officeClosed.body")}
          </Alert>
        )}
        <p className="shift-card__product">
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
        "paused": "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.",
        "leaving": "Скан не принят: идёт выход из смены."
      },
```

заменить на:

<!-- prettier-ignore -->
```json
        "paused": "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.",
        "leaving": "Скан не принят: идёт выход из смены.",
        "officeClosed": "Скан не принят: смену закрыли в офисе."
      },
```

Фрагмент 2:

<!-- prettier-ignore -->
```json
      "leaving": "Дожидаемся окончания начатой работы…",
      "leave": "Выйти из смены"
```

заменить на:

<!-- prettier-ignore -->
```json
      "leaving": "Дожидаемся окончания начатой работы…",
      "officeClosed": {
        "title": "Смену закрыли в офисе",
        "body": "Новые коды не принимаются. Закончите короб и этикетку и закройте смену на станции: её данные дойдут до хоста и будут отмечены поздними."
      },
      "leave": "Выйти из смены"
```

Фрагмент 3:

<!-- prettier-ignore -->
```json
      "readHostFailed": "Список смен не обновился с хоста — показаны полученные раньше.",
      "officeClosed": "Смену {{number}} закрыли в офисе.",
      "closeRefused": "Хост не принял закрытие смены (код {{code}}). Смену закроют в офисе.",
      "entering": "Открываем смену…",
```

заменить на:

<!-- prettier-ignore -->
```json
      "readHostFailed": "Список смен не обновился с хоста — показаны полученные раньше.",
      "closeRefused": "Хост не принял закрытие смены (код {{code}}). Смену закроют в офисе.",
      "finishHint": "Смену закрыли в офисе. Закончите на станции короб и этикетку и закройте смену.",
      "entering": "Открываем смену…",
```

Фрагмент 4:

<!-- prettier-ignore -->
```json
        "active": "В работе",
        "closing": "Закрывается"
      },
```

заменить на:

<!-- prettier-ignore -->
```json
        "active": "В работе",
        "closing": "Закрывается",
        "office_closed": "Закрыта в офисе"
      },
```

Фрагмент 5:

<!-- prettier-ignore -->
```json
        "continue": "Продолжить",
        "busy": "Занята другой станцией",
```

заменить на:

<!-- prettier-ignore -->
```json
        "continue": "Продолжить",
        "finish": "Завершить",
        "busy": "Занята другой станцией",
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx test/floor-shift-list.test.tsx test/floor-work-close.test.tsx test/shift-copies.test.ts`
Expected: PASS — `Test Files  4 passed (4)`, `Tests  68 passed (68)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  110 passed (110)`, `Tests  2632 passed (2632)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — закрытие офисом не доходит до рабочего экрана.
В `apps/standalone/src/floor/FloorApp.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
              ? { ...now, officeClosed: true }
```

заменить на:

<!-- prettier-ignore -->
```tsx
              ? now
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx`
Expected: FAIL — «keeps the operator in the shift the office closed, to finish it, and takes no new code».

М2 — смена, закрытая офисом, принимает новые коды.
В `apps/standalone/src/floor/work/WorkScreen.tsx` удалить фрагмент

<!-- prettier-ignore -->
```tsx
      if (live.current.officeClosed) {
        setLast({ kind: "office_closed" });
        show("error", live.current.t("floor.work.signal.paused"));
        return;
      }
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-close.test.tsx`
Expected: FAIL — «takes no new code, but closes the box with its label and the shift as usual».

М3 — смена, закрытая офисом, пропадает из списка до закрытия станцией.
В `apps/standalone/src/floor/shifts/shift-copies.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "AND line_id = ? AND (status <> 'closed' OR entered_at IS NOT NULL) " +
```

заменить на:

<!-- prettier-ignore -->
```ts
      "AND line_id = ? AND status <> 'closed' " +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-copies.test.ts`
Expected: FAIL — «keep a shift this station entered, with its snapshot, whatever a later list says», «show a shift the office closed after this station entered it, until this station closes it».

М4 — закрываемая станцией смена, которую закрыл и офис, предлагает «Завершить».
В `apps/standalone/src/floor/shifts/ShiftCard.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  if (copy.localState === "closing") return { kind: "closing" };
  if (copy.status === "closed") return { kind: "finish" };
```

заменить на:

<!-- prettier-ignore -->
```tsx
  if (copy.status === "closed") return { kind: "finish" };
  if (copy.localState === "closing") return { kind: "closing" };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-list.test.tsx`
Expected: FAIL — «offers to finish a shift the office closed after this station entered it, without asking the host».

М5 — вход в смену, закрытую офисом, спрашивает хост.
В `apps/standalone/src/floor/shifts/shift-entry.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (copy.status === "closed" || !context.online) return storedWork(context, copy.id);
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (!context.online) return storedWork(context, copy.id);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-list.test.tsx`
Expected: FAIL — «offers to finish a shift the office closed after this station entered it, without asking the host».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/floor/shifts/ShiftCard.tsx apps/standalone/src/floor/shifts/ShiftList.tsx apps/standalone/src/floor/shifts/shift-copies.ts apps/standalone/src/floor/shifts/shift-entry.ts apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-app.test.tsx apps/standalone/test/floor-shift-list.test.tsx apps/standalone/test/floor-work-close.test.tsx apps/standalone/test/shift-copies.test.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-app.test.tsx test/floor-shift-list.test.tsx test/floor-work-close.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/floor-app.test.tsx test/floor-shift-list.test.tsx test/floor-work-close.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/floor/shifts/ShiftCard.tsx apps/standalone/src/floor/shifts/ShiftList.tsx apps/standalone/src/floor/shifts/shift-copies.ts apps/standalone/src/floor/shifts/shift-entry.ts apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-app.test.tsx apps/standalone/test/floor-shift-list.test.tsx apps/standalone/test/floor-work-close.test.tsx apps/standalone/test/shift-copies.test.ts
git commit -m "feat(standalone): a shift the office closed is finished on the station, without new codes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Срок хранения — записи смены уходят через 30 дней после квитанции на закрытие

Срок хранения (решение 31, §5.5, вопрос В6): `purgeAcknowledged` удаляет записи смены подключения, если хост принял её `shift_closed` не позже 30 дней назад, у всех записей смены есть квитанции и нет ждущей этикетки: таблицы `RETAINED_TABLES` по `shift_id` и копия, по смене на транзакцию; первый оператор удаляет копию, только если смена всё ещё готова (`expectedChanges: 1`). Блоки SSCC и запросы блоков остаются (план РК). `scheduleRetention` — проход сразу и раз в час, не двойной; `App` запускает его для подключения. Тест читает все таблицы базы: таблица с `shift_id`, которой нет в списке, его роняет (точка ПЛ-Ц).

**Files:**

- Create: `apps/standalone/src/local/retention.ts`
- Modify: `apps/standalone/src/app/App.tsx`
- Test: `apps/standalone/test/retention.test.ts` (Create), `apps/standalone/test/app.test.tsx` (Modify)

**Interfaces:**

- Consumes: `OPEN_JOB_SQL` (задача 3), `LocalExecutor`, `LocalDbError`; задачи 1 и 3 (тесты); `App`.
- Produces:
  - `purgeAcknowledged(local, pairing, now: Date): Promise<number>`, `scheduleRetention(run, every?): () => void`, `Every`, `RETAINED_TABLES`, `RETENTION_DAYS`, `RETENTION_MS`, `RETENTION_INTERVAL_MS` (`src/local/retention.ts`).

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/app.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
} from "../src/floor/setup/workstation-settings.js";
import type { HardwareApi } from "../src/hardware/hardware.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
} from "../src/floor/setup/workstation-settings.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import type { HardwareApi } from "../src/hardware/hardware.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
    await waitFor(() => expect(screen.queryByRole("button", { name: "Закрывается" })).toBeNull());
  });
});

/**
```

заменить на:

<!-- prettier-ignore -->
```tsx
    await waitFor(() => expect(screen.queryByRole("button", { name: "Закрывается" })).toBeNull());
  });

  it("deletes at its start the records of a shift whose close the host took 30 days ago", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(
      executor,
      { hostId: HOST_ID, deviceId: DEVICE_ID },
      OPENED,
      "2026-10-09T06:00:00.000Z",
      1,
    );
    const ackedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE floor_shifts SET local_state = 'closed'").run();
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, " +
        "outcome, acked_at) VALUES (?, ?, ?, 'shift_closed', ?, '{}', ?, 'accepted', ?)",
    ).run(crypto.randomUUID(), HOST_ID, DEVICE_ID, OPENED.id, ackedAt, ackedAt);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      local: executor,
    });
    await waitFor(() =>
      expect({ ...db.prepare("SELECT count(*) AS n FROM floor_shifts").get() }).toEqual({ n: 0 }),
    );
    expect({ ...db.prepare("SELECT count(*) AS n FROM outbox").get() }).toEqual({ n: 0 });
  });
});

/**
```

Создать `apps/standalone/test/retention.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import { closeShift } from "../src/floor/close/shift-close.js";
import { undoLastCode } from "../src/floor/exceptions/box-exceptions.js";
import { boxLabelStep, readPrintJob, sendLabelJob } from "../src/floor/print/print-jobs.js";
import { closeOpenBox } from "../src/floor/work/box-close.js";
import { processScan } from "../src/floor/work/scan-pipeline.js";
import type { EnteredShift } from "../src/host/protocol.js";
import {
  purgeAcknowledged,
  RETAINED_TABLES,
  RETENTION_INTERVAL_MS,
  scheduleRetention,
  type Every,
} from "../src/local/retention.js";
import {
  ENTERED,
  enteredShift,
  km,
  PAIRING,
  rows,
  scanContext,
  SECOND,
} from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { fakeRender, manualRuntime, printStation, resolveContext } from "./support/printing.js";

type Station = Awaited<ReturnType<typeof printStation>>;

const NOW = new Date("2026-11-08T12:00:00.000Z");
/** 30 days before `NOW`: a close the host took at or before it is done with. */
const CUTOFF = "2026-10-09T12:00:00.000Z";
const THIRD: EnteredShift = {
  ...ENTERED,
  id: "5f8b2d0e-3c6a-4e9f-b4d7-0a1c2e3f4d5b",
  number: "OCT26-006/S",
};
const OTHER_PAIRING = { ...PAIRING, deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f" };

/**
 * A shift worked and closed on this station: two codes, one taken out again,
 * the box closed with its label sent, the shift closed; every record with
 * the receipt `outcome` at `ackedAt`, and the copy `closed` when the host
 * took the close.
 */
async function finished(
  at: Station,
  shift: EnteredShift,
  serial: string,
  ackedAt: string,
  outcome: "accepted" | "rejected" = "accepted",
): Promise<void> {
  const work = await enteredShift(at.local, shift);
  const context = scanContext(at.local, work, { newId: () => crypto.randomUUID() });
  await processScan(context, km(`${serial}1`));
  await processScan(context, km(`${serial}2`));
  await undoLastCode(context);
  const closed = await closeOpenBox(context, [
    boxLabelStep({
      local: at.local,
      pairing: PAIRING,
      shift: work,
      operatorName: "Анна Кузнецова",
      newId: () => `job-${serial}`,
      render: fakeRender,
    }),
  ]);
  if (closed.kind !== "closed") throw new Error(closed.kind);
  const job = await readPrintJob(at.local, PAIRING, `job-${serial}`);
  if (job === null) throw new Error("no job");
  await sendLabelJob(resolveContext(at.local, manualRuntime(fakeHardware().hardware).runtime), job);
  const result = await closeShift(context, "production_defect");
  if (result.kind !== "closed") throw new Error(result.kind);
  at.db
    .prepare("UPDATE outbox SET outcome = ?, acked_at = ? WHERE shift_id = ?")
    .run(outcome, ackedAt, shift.id);
  if (outcome === "accepted") {
    at.db.prepare("UPDATE floor_shifts SET local_state = 'closed' WHERE id = ?").run(shift.id);
  }
}

/** The rows of each table the shift's records live in, the copy's first. */
function kept(at: Station, shiftId: string): Record<string, unknown> {
  const counts: Record<string, unknown> = {
    floor_shifts: rows(at.db, "SELECT count(*) AS n FROM floor_shifts WHERE id = ?", shiftId)[0]?.[
      "n"
    ],
  };
  for (const table of RETAINED_TABLES) {
    counts[table] = rows(
      at.db,
      `SELECT count(*) AS n FROM ${table} WHERE shift_id = ?`,
      shiftId,
    )[0]?.["n"];
  }
  return counts;
}

const NONE = {
  floor_shifts: 0,
  floor_scans: 0,
  floor_exceptions: 0,
  floor_codes: 0,
  floor_print_jobs: 0,
  floor_boxes: 0,
  outbox: 0,
};
const WHOLE = {
  floor_shifts: 1,
  floor_scans: 2,
  floor_exceptions: 1,
  floor_codes: 1,
  floor_print_jobs: 1,
  floor_boxes: 1,
  outbox: 5,
};

describe("the retention of a shift's records on the station", () => {
  it("deletes a shift 30 days after the host took its close, and keeps one taken later", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", CUTOFF);
    await finished(at, SECOND, "B", "2026-10-09T12:00:00.001Z");
    expect(kept(at, ENTERED.id)).toEqual(WHOLE);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(1);
    expect(kept(at, ENTERED.id)).toEqual(NONE);
    expect(kept(at, SECOND.id)).toEqual(WHOLE);
    // The SSCC blocks stay: a restored host asks the station for them.
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_sscc_blocks")).toEqual([{ n: 1 }]);
    expect(await purgeAcknowledged(at.local, PAIRING, new Date("2026-11-08T12:00:00.001Z"))).toBe(
      1,
    );
    expect(kept(at, SECOND.id)).toEqual(NONE);
  });

  it("keeps a shift whose close the host refused, or has not answered", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", "2026-09-01T00:00:00.000Z", "rejected");
    await finished(at, SECOND, "B", "2026-09-01T00:00:00.000Z");
    at.db
      .prepare(
        "UPDATE outbox SET outcome = NULL, acked_at = NULL WHERE shift_id = ? AND kind = 'shift_closed'",
      )
      .run(SECOND.id);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(0);
    expect(kept(at, ENTERED.id)).toEqual(WHOLE);
    expect(kept(at, SECOND.id)).toEqual(WHOLE);
  });

  it("keeps a shift with a record not yet answered or a label that waits", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", "2026-09-01T00:00:00.000Z");
    await finished(at, SECOND, "B", "2026-09-01T00:00:00.000Z");
    at.db
      .prepare(
        "UPDATE outbox SET outcome = NULL, acked_at = NULL WHERE shift_id = ? AND kind = 'scan'",
      )
      .run(ENTERED.id);
    at.db
      .prepare(
        "UPDATE floor_print_jobs SET state = 'unknown', error_code = 'interrupted' WHERE shift_id = ?",
      )
      .run(SECOND.id);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(0);
    expect(kept(at, ENTERED.id)).toEqual(WHOLE);
    expect(kept(at, SECOND.id)).toEqual(WHOLE);
  });

  it("leaves another pairing's rows alone, the same shift ids included", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", "2026-09-01T00:00:00.000Z");
    expect(await purgeAcknowledged(at.local, OTHER_PAIRING, NOW)).toBe(0);
    expect(kept(at, ENTERED.id)).toEqual(WHOLE);
  });

  it("keeps a shift that took a record between its reading and its delete", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", "2026-09-01T00:00:00.000Z");
    await finished(at, THIRD, "C", "2026-09-01T00:00:00.000Z");
    let first = true;
    const racing = {
      query: at.local.query.bind(at.local),
      transaction: async (statements: Parameters<typeof at.local.transaction>[0]) => {
        if (first) {
          first = false;
          // Another write lands first: a record of the shift without its receipt.
          at.db
            .prepare(
              "UPDATE outbox SET outcome = NULL, acked_at = NULL WHERE shift_id = ? AND kind = 'scan'",
            )
            .run(ENTERED.id);
        }
        return at.local.transaction(statements);
      },
    };
    expect(await purgeAcknowledged(racing, PAIRING, NOW)).toBe(1);
    expect(kept(at, ENTERED.id)).toEqual(WHOLE);
    expect(kept(at, THIRD.id)).toEqual(NONE);
  });

  it("names every table of a shift's records: a table with a `shift_id` and no retention fails here", async () => {
    const at = await printStation();
    const withShift = rows(
      at.db,
      "SELECT m.name AS name FROM sqlite_master m WHERE m.type = 'table' AND EXISTS " +
        "(SELECT 1 FROM pragma_table_info(m.name) c WHERE c.name = 'shift_id') ORDER BY m.name",
    ).map((row) => row["name"]);
    expect(withShift).toEqual([...RETAINED_TABLES].sort());
  });
});

describe("the retention pass", () => {
  it("runs at once and then every hour, never two at a time, until stopped", async () => {
    let fire: () => void = () => undefined;
    let interval = 0;
    let stopped = false;
    const every: Every = (ms, callback) => {
      interval = ms;
      fire = callback;
      return () => {
        stopped = true;
      };
    };
    const runs: Array<() => void> = [];
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          runs.push(resolve);
        }),
    );
    const stop = scheduleRetention(run, every);
    expect(run).toHaveBeenCalledTimes(1);
    expect(interval).toBe(RETENTION_INTERVAL_MS);
    expect(RETENTION_INTERVAL_MS).toBe(3_600_000);
    fire();
    expect(run).toHaveBeenCalledTimes(1);
    runs[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    fire();
    expect(run).toHaveBeenCalledTimes(2);
    stop();
    expect(stopped).toBe(true);
  });

  it("runs again after a pass that failed", async () => {
    let fire: () => void = () => undefined;
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk"))
      .mockResolvedValue(undefined);
    scheduleRetention(run, (_ms, callback) => {
      fire = callback;
      return () => undefined;
    });
    await Promise.resolve();
    await Promise.resolve();
    fire();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/retention.test.ts`
Expected: FAIL — `test/retention.test.ts` не загружается (`Failed to resolve import "../src/local/retention.js"`); `test/app.test.tsx` — «deletes at its start the records of a shift whose close the host took 30 days ago».

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/app/App.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { countUnsentRecords } from "../local/outbox.js";
import { Office } from "../office/Office.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { countUnsentRecords } from "../local/outbox.js";
import { purgeAcknowledged, scheduleRetention } from "../local/retention.js";
import { Office } from "../office/Office.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
      : null;
  const { requestSync, requestFacts } = useHostLink({
```

заменить на:

<!-- prettier-ignore -->
```tsx
      : null;
  // The records of the shifts the host took 30 days ago go, at the start and
  // every hour (decision 31); a failed pass is tried again at the next.
  const keptHostId = pairedStatus?.hostId ?? null;
  const keptDeviceId = pairedStatus?.deviceId ?? null;
  useEffect(() => {
    if (keptHostId === null || keptDeviceId === null) return;
    const pairing = { hostId: keptHostId, deviceId: keptDeviceId };
    return scheduleRetention(async () => {
      if ((await purgeAcknowledged(localDb, pairing, new Date())) > 0) {
        dispatch({ type: "outbox_changed" });
      }
    });
  }, [localDb, keptHostId, keptDeviceId]);

  const { requestSync, requestFacts } = useHostLink({
```

Создать `apps/standalone/src/local/retention.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import { OPEN_JOB_SQL } from "../floor/print/print-jobs.js";
import { LocalDbError, type LocalExecutor } from "./executor.js";
import type { Pairing } from "./reference-sync.js";

/**
 * How long the station keeps a shift's records once the host has taken its
 * close (stage 2a spec, decision 31; question В6): 30 days.
 */
export const RETENTION_DAYS = 30;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** How often the pass runs while the app is open, besides once at its start. */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The tables of a shift's own records, which carry its `shift_id`: the
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
] as const;

const dueRow = z.object({ id: z.string() });

/**
 * When a shift of the pairing is done with on this station: the host took
 * this station's close (its `shift_closed` answered `accepted`,
 * `alreadyClosed` too — what makes the copy `closed`) at least 30 days
 * before the cutoff, every record of the shift has its receipt, and no
 * label of it waits. Parameters: host id, device id, the cutoff (an instant
 * as `Date.toISOString` writes it, as `acked_at` is).
 */
const DONE_WITH =
  "s.host_id = ? AND s.device_id = ? " +
  "AND EXISTS (SELECT 1 FROM outbox o WHERE o.host_id = s.host_id AND o.device_id = s.device_id " +
  "AND o.shift_id = s.id AND o.kind = 'shift_closed' AND o.outcome = 'accepted' " +
  "AND o.acked_at <= ?) " +
  "AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.host_id = s.host_id " +
  "AND o.device_id = s.device_id AND o.shift_id = s.id AND o.acked_at IS NULL) " +
  "AND NOT EXISTS (SELECT 1 FROM floor_print_jobs j WHERE j.host_id = s.host_id " +
  `AND j.device_id = s.device_id AND j.shift_id = s.id AND ${OPEN_JOB_SQL})`;

/**
 * Deletes the records of this pairing's shifts done with for 30 days
 * (stage 2a spec, decision 31): the copy, its scans, exceptions, codes,
 * print jobs, boxes and outbox records, one shift per transaction. The copy
 * goes first and only while the shift is still done with, so a shift that
 * took a record meanwhile keeps everything. The SSCC blocks and the
 * requests for them stay: a restore of the host asks the station for its
 * blocks (plan РК). Another pairing's rows are never touched. Answers how
 * many shifts went.
 */
export async function purgeAcknowledged(
  local: LocalExecutor,
  pairing: Pairing,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
  const { hostId, deviceId } = pairing;
  const due = await local.query(
    `SELECT s.id FROM floor_shifts s WHERE ${DONE_WITH} ORDER BY s.id`,
    [hostId, deviceId, cutoff],
    dueRow,
  );
  let purged = 0;
  for (const { id } of due) {
    try {
      await local.transaction([
        {
          sql: `DELETE FROM floor_shifts AS s WHERE s.id = ? AND ${DONE_WITH}`,
          values: [id, hostId, deviceId, cutoff],
          expectedChanges: 1,
        },
        ...RETAINED_TABLES.map((table) => ({
          sql: `DELETE FROM ${table} WHERE host_id = ? AND device_id = ? AND shift_id = ?`,
          values: [hostId, deviceId, id],
        })),
      ]);
      purged += 1;
    } catch (error) {
      // The shift took a record meanwhile: it stays, whole, for a later pass.
      if (!(error instanceof LocalDbError && error.code === "changes_mismatch")) throw error;
    }
  }
  return purged;
}

/** A repeating timer: calls `fire` every `ms`; returns the function that stops it. */
export type Every = (ms: number, fire: () => void) => () => void;

const realEvery: Every = (ms, fire) => {
  const timer = setInterval(fire, ms);
  return () => clearInterval(timer);
};

/**
 * Runs the retention pass now and every hour after (stage 2a spec §5.5),
 * one at a time: a pass still running when the hour comes is not doubled. A
 * pass that fails leaves everything as it was, and the next one tries again.
 * Returns the function that stops it.
 */
export function scheduleRetention(run: () => Promise<unknown>, every: Every = realEvery) {
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    run().then(
      () => {
        running = false;
      },
      () => {
        running = false;
      },
    );
  };
  pass();
  return every(RETENTION_INTERVAL_MS, pass);
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/retention.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  111 passed (111)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  111 passed (111)`, `Tests  2641 passed (2641)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — срок хранения не ждёт 30 дней.
В `apps/standalone/src/local/retention.ts` фрагмент

<!-- prettier-ignore -->
```ts
  const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
```

заменить на:

<!-- prettier-ignore -->
```ts
  const cutoff = now.toISOString();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/retention.test.ts`
Expected: FAIL — «deletes a shift 30 days after the host took its close, and keeps one taken later».

М2 — отказанное закрытие тоже начинает срок хранения.
В `apps/standalone/src/local/retention.ts` фрагмент

<!-- prettier-ignore -->
```ts
  "AND o.shift_id = s.id AND o.kind = 'shift_closed' AND o.outcome = 'accepted' " +
```

заменить на:

<!-- prettier-ignore -->
```ts
  "AND o.shift_id = s.id AND o.kind = 'shift_closed' AND o.outcome IS NOT NULL " +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/retention.test.ts`
Expected: FAIL — «keeps a shift whose close the host refused, or has not answered».

М3 — удаляется смена с записью без квитанции.
В `apps/standalone/src/local/retention.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  "AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.host_id = s.host_id " +
  "AND o.device_id = s.device_id AND o.shift_id = s.id AND o.acked_at IS NULL) " +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/retention.test.ts`
Expected: FAIL — «keeps a shift with a record not yet answered or a label that waits», «keeps a shift that took a record between its reading and its delete».

М4 — удаляется смена со ждущей этикеткой.
В `apps/standalone/src/local/retention.ts` фрагмент

<!-- prettier-ignore -->
```ts
  "AND NOT EXISTS (SELECT 1 FROM floor_print_jobs j WHERE j.host_id = s.host_id " +
  `AND j.device_id = s.device_id AND j.shift_id = s.id AND ${OPEN_JOB_SQL})`;
```

заменить на:

<!-- prettier-ignore -->
```ts
  "AND 1";
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/retention.test.ts`
Expected: FAIL — «keeps a shift with a record not yet answered or a label that waits».

М5 — `floor_codes` нет в списке таблиц срока хранения.
В `apps/standalone/src/local/retention.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  "floor_codes",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/retention.test.ts`
Expected: FAIL — «deletes a shift 30 days after the host took its close, and keeps one taken later», «keeps a shift whose close the host refused, or has not answered», «keeps a shift with a record not yet answered or a label that waits», «leaves another pairing's rows alone, the same shift ids included», «keeps a shift that took a record between its reading and its delete», «names every table of a shift's records: a table with a `shift_id` and no retention fails here».

М6 — два прохода срока хранения одновременно.
В `apps/standalone/src/local/retention.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
    if (running) return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/retention.test.ts`
Expected: FAIL — «runs at once and then every hour, never two at a time, until stopped».

М7 — удаление записей смены без проверки, что копия ещё «готова к удалению».
В `apps/standalone/src/local/retention.ts` фрагмент

<!-- prettier-ignore -->
```ts
          values: [id, hostId, deviceId, cutoff],
          expectedChanges: 1,
```

заменить на:

<!-- prettier-ignore -->
```ts
          values: [id, hostId, deviceId, cutoff],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/retention.test.ts`
Expected: FAIL — «keeps a shift that took a record between its reading and its delete».

М8 — приложение не запускает срок хранения.
В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    return scheduleRetention(async () => {
      if ((await purgeAcknowledged(localDb, pairing, new Date())) > 0) {
        dispatch({ type: "outbox_changed" });
      }
    });
```

заменить на:

<!-- prettier-ignore -->
```tsx
    return scheduleRetention(async () => {
      if (pairing.hostId === "") await purgeAcknowledged(localDb, pairing, new Date());
    });
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx`
Expected: FAIL — «deletes at its start the records of a shift whose close the host took 30 days ago».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/app/App.tsx apps/standalone/src/local/retention.ts apps/standalone/test/app.test.tsx apps/standalone/test/retention.test.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/app.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/app.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/app/App.tsx apps/standalone/src/local/retention.ts apps/standalone/test/app.test.tsx apps/standalone/test/retention.test.ts
git commit -m "feat(standalone): a shift's records leave the station 30 days after the host took its close" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Сквозной сценарий — одна смена на одном ПК, записи станции через маршрутизатор хоста

Сквозной сценарий (§7 спецификации, контракт 2a6 — «живой хост 2a2 покажет сквозной сценарий 2a8»): `test/floor-scenario.test.ts` проводит смену модулями цеха с шагающими часами и счётными `id` — три кода и короб с проверенной этикеткой, доставка; без хоста — снятие кода и повторный скан, очистка, второй короб, расформирование первого, перепечатка второго с проверкой, третий короб неполным, закрытие смены; затем отправка без хоста, отправка с потерянным ответом и отвеченная — и сверяет записи и отправки с фикстурой `proto/fixtures/floor-scenario.json`. `host/tests/floor_scenario.rs` подставляет `id` смены и блока хоста и отправляет те же пачки в маршрутизатор (`TestApp`, без сокета): каждая запись — `accepted`, та же пачка снова — те же квитанции и ничего нового, итоги офиса равны станционным, дайджест каждого короба совпал, смена закрыта станцией и не поздняя; второй тест — офис закрыл смену раньше: записи приняты, смена поздняя, закрытие `alreadyClosed`. Тесты проверяют собранное задачами 1–7 и проходят сразу; что они ловят, показывают мутации.

**Files:**

- Test: `apps/standalone/host/tests/floor_scenario.rs` (Create), `apps/standalone/proto/fixtures/floor-scenario.json` (Create), `apps/standalone/test/floor-scenario.test.ts` (Create)

**Interfaces:**

- Consumes: всё задач 1–7; `sendFactBatch` (план 2a6); опоры хоста `admin`, `shift_setup`, `open_floor`, `issue_block`, `send_facts`, `fact_rows`, `close_from_office` (`host/tests/support/app.rs`, план 2a2).
- Produces:
  - фикстура `proto/fixtures/floor-scenario.json` (`station { shiftId, blockId, acceptedUnits, closedBoxes }`, `records`, `sends [{ ids, answer }]`), которую читают Vitest и cargo.

- [ ] **Step 1: Сценарий, его фикстура и тест хоста**

Создать `apps/standalone/host/tests/floor_scenario.rs`:

<!-- prettier-ignore -->
```rust
//! One shift on one PC, the station's side replayed through the host's router
//! (plan 2a8): `proto/fixtures/floor-scenario.json` holds every record a
//! station wrote for it, in its outbox's order, and every send of that
//! outbox — the records' ids and how the send ended. The webview's own
//! modules write it (`test/floor-scenario.test.ts`, which fails when they
//! write anything else). The host must take every record of it — each
//! receipt `accepted`, the same receipts for a batch sent again — and end
//! with the station's numbers, the shift closed by the station and not late.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, close_from_office, fact_rows, issue_block, open_floor, send_facts, shift_setup, Admin,
    Floor,
};

/// The scenario, with the station's ids of the shift and of the block
/// replaced by the host's: the fixture was written by a station whose
/// shift and block the host never issued.
fn scenario(shift: &str, block: &str) -> Value {
    let path = format!(
        "{}/../proto/fixtures/floor-scenario.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    let raw: Value = serde_json::from_str(&text).unwrap();
    let station_shift = raw["station"]["shiftId"].as_str().unwrap().to_owned();
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
        &admin.app,
        &floor.key,
        "7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b",
    )
    .await;
    assert_eq!(
        (block["fromSerial"].clone(), block["toSerial"].clone()),
        (json!(1500), json!(3499))
    );
    let scenario = scenario(&floor.shift, block["id"].as_str().unwrap());
    (admin, floor, scenario)
}

/// The records of a send, in its order.
fn batch(scenario: &Value, send: &Value) -> Vec<Value> {
    let records = scenario["records"].as_array().unwrap();
    send["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| {
            records
                .iter()
                .find(|record| &record["id"] == id)
                .unwrap_or_else(|| panic!("no record {id}"))
                .clone()
        })
        .collect()
}

/// Sends the records and answers the host's receipts (status 200 only).
async fn receipts_of(admin: &Admin, floor: &Floor, records: &[Value]) -> Vec<Value> {
    let (status, body) = send_facts(&admin.app, &floor.key, records).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["receipts"].as_array().unwrap().clone()
}

/// The receipt `accepted` of every record, as the station's side was answered.
fn all_accepted(records: &[Value]) -> Vec<Value> {
    records
        .iter()
        .map(|record| json!({ "id": record["id"], "outcome": "accepted" }))
        .collect()
}

/// The office's totals of the shift and its state.
async fn office(admin: &Admin, shift: &str) -> Value {
    let (status, shift) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    shift
}

/// Who closed the shift, its reason, and whether a fact came after the close.
async fn close_columns(admin: &Admin, shift: &str) -> (String, Option<String>, bool) {
    let (by, reason, late): (String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT closed_by_kind, close_reason_code, late_data_at FROM shifts WHERE id = ?",
    )
    .bind(shift)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    (by, reason, late.is_some())
}

/// The boxes as the host keeps them: the serial, whether the station's digest
/// matched the host's items, and whether it was taken apart.
async fn boxes(admin: &Admin) -> Vec<(i64, Option<i64>, bool)> {
    let rows: Vec<(i64, Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT serial, digest_matches, disassembled_at FROM boxes ORDER BY serial")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    rows.into_iter()
        .map(|(serial, digest, disassembled)| (serial, digest, disassembled.is_some()))
        .collect()
}

#[tokio::test]
async fn the_host_takes_every_record_of_the_stations_shift_once_and_ends_with_its_numbers() {
    let (admin, floor, scenario) = station().await;
    let sends = scenario["sends"].as_array().unwrap();
    assert_eq!(sends.len(), 4);
    for send in sends {
        // A send that found no host never reached it.
        if send["answer"] == "unreachable" {
            continue;
        }
        // A lost answer: the host took the batch, the station never heard.
        let records = batch(&scenario, send);
        assert_eq!(
            receipts_of(&admin, &floor, &records).await,
            all_accepted(&records)
        );
    }
    // The last batch once more: the same receipts, and nothing written.
    let before = fact_rows(&admin.app).await;
    let last = batch(&scenario, sends.last().unwrap());
    assert_eq!(
        receipts_of(&admin, &floor, &last).await,
        all_accepted(&last)
    );
    assert_eq!(fact_rows(&admin.app).await, before);

    let shift = office(&admin, &floor.shift).await;
    let station = &scenario["station"];
    assert_eq!(shift["status"], "closed");
    assert_eq!(
        (
            shift["totals"]["acceptedUnits"].clone(),
            shift["totals"]["closedBoxes"].clone(),
            shift["totals"]["openBoxes"].clone(),
        ),
        (
            station["acceptedUnits"].clone(),
            station["closedBoxes"].clone(),
            json!(0)
        )
    );
    assert_eq!(
        close_columns(&admin, &floor.shift).await,
        (
            "device".to_owned(),
            Some("production_order_changed".to_owned()),
            false
        )
    );
    // Each box's digest, counted by the station after its undo and clear,
    // matches the host's items; the first box is taken apart.
    assert_eq!(
        boxes(&admin).await,
        vec![
            (1500, Some(1), true),
            (1501, Some(1), false),
            (1502, Some(1), false)
        ]
    );
}

#[tokio::test]
async fn the_stations_facts_after_the_offices_close_are_taken_and_mark_the_shift_late() {
    let (admin, floor, scenario) = station().await;
    let sends = scenario["sends"].as_array().unwrap();
    let first = batch(&scenario, &sends[0]);
    assert_eq!(
        receipts_of(&admin, &floor, &first).await,
        all_accepted(&first)
    );
    // The station is away; the office closes its shift.
    close_from_office(&admin, &floor.shift, "Станция не отвечает").await;
    let rest = batch(&scenario, &sends[3]);
    let mut expected = all_accepted(&rest);
    let close = expected.last_mut().unwrap();
    close["details"] = json!({ "alreadyClosed": true });
    assert_eq!(rest.last().unwrap()["kind"], "shift_closed");
    assert_eq!(receipts_of(&admin, &floor, &rest).await, expected);
    let shift = office(&admin, &floor.shift).await;
    assert_eq!(
        (
            shift["totals"]["acceptedUnits"].clone(),
            shift["totals"]["closedBoxes"].clone()
        ),
        (
            scenario["station"]["acceptedUnits"].clone(),
            scenario["station"]["closedBoxes"].clone()
        )
    );
    assert_eq!(
        close_columns(&admin, &floor.shift).await,
        ("office_user".to_owned(), None, true)
    );
}
```

Создать `apps/standalone/proto/fixtures/floor-scenario.json`:

<!-- prettier-ignore -->
```json
{
  "station": {
    "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
    "blockId": "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
    "acceptedUnits": 5,
    "closedBoxes": 2
  },
  "records": [
    {
      "id": "00000000-0000-4000-8000-000000000001",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
      "data": {
        "scannedAt": "2026-10-08T06:15:00.000Z",
        "verdict": "ok",
        "duplicateSource": null,
        "rawKind": "km",
        "rawLength": 30,
        "code": {
          "codeHash": "5066bf31ac88f18398f693870a0bfd29993658de62927d6141b9e2073da2df66",
          "gtin14": "04600682000013",
          "serial": "A1",
          "canonical": "010460068200001321A1\u001d93dGVz"
        },
        "boxId": "00000000-0000-4000-8000-000000000002"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000003",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
      "data": {
        "scannedAt": "2026-10-08T06:15:01.000Z",
        "verdict": "ok",
        "duplicateSource": null,
        "rawKind": "km",
        "rawLength": 30,
        "code": {
          "codeHash": "7d7697d127a14af608a8c5aaf4e1faaa13bc43bdde9b05372f2a00f1ca1fe0ae",
          "gtin14": "04600682000013",
          "serial": "A2",
          "canonical": "010460068200001321A2\u001d93dGVz"
        },
        "boxId": "00000000-0000-4000-8000-000000000002"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000004",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
      "data": {
        "scannedAt": "2026-10-08T06:15:02.000Z",
        "verdict": "ok",
        "duplicateSource": null,
        "rawKind": "km",
        "rawLength": 30,
        "code": {
          "codeHash": "a0bcf6b8672674919ef0cf51beef219fbd9d80716603eea7c7bfcc928b53290c",
          "gtin14": "04600682000013",
          "serial": "A3",
          "canonical": "010460068200001321A3\u001d93dGVz"
        },
        "boxId": "00000000-0000-4000-8000-000000000002"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000006",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_closed",
      "data": {
        "boxId": "00000000-0000-4000-8000-000000000002",
        "sscc": "046006820000015000",
        "blockId": "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
        "serial": 1500,
        "openedAt": "2026-10-08T06:15:00.000Z",
        "closedAt": "2026-10-08T06:15:03.000Z",
        "itemCount": 3,
        "membershipDigest": "a8ac289180d9807b954190fd8f4a65f2c1609fad1589a284ce2d185b6ca5441a"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000007",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_label",
      "data": {
        "boxId": "00000000-0000-4000-8000-000000000002",
        "outcome": "verified",
        "at": "2026-10-08T06:15:06.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000008",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
      "data": {
        "scannedAt": "2026-10-08T06:15:09.000Z",
        "verdict": "ok",
        "duplicateSource": null,
        "rawKind": "km",
        "rawLength": 30,
        "code": {
          "codeHash": "e645500adbed620bec039e164c48a17d985c6ab8f04d7708dd0fdfdee0025042",
          "gtin14": "04600682000013",
          "serial": "B1",
          "canonical": "010460068200001321B1\u001d93dGVz"
        },
        "boxId": "00000000-0000-4000-8000-000000000009"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000010",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
      "data": {
        "scannedAt": "2026-10-08T06:15:10.000Z",
        "verdict": "ok",
        "duplicateSource": null,
        "rawKind": "km",
        "rawLength": 30,
        "code": {
          "codeHash": "59626d6dcb61bc482b987f7613a91607ca2cf4b9ba43763a45990107b76701d1",
          "gtin14": "04600682000013",
          "serial": "B2",
          "canonical": "010460068200001321B2\u001d93dGVz"
        },
        "boxId": "00000000-0000-4000-8000-000000000009"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000011",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_exception",
      "data": {
        "exception": "undo",
        "boxId": "00000000-0000-4000-8000-000000000009",
        "codeHash": "59626d6dcb61bc482b987f7613a91607ca2cf4b9ba43763a45990107b76701d1",
        "targetScannedAt": "2026-10-08T06:15:10.000Z",
        "reasonCode": null,
        "reasonText": null,
        "occurredAt": "2026-10-08T06:15:11.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000013",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
      "data": {
        "scannedAt": "2026-10-08T06:15:12.000Z",
        "verdict": "ok",
        "duplicateSource": null,
        "rawKind": "km",
        "rawLength": 30,
        "code": {
          "codeHash": "59626d6dcb61bc482b987f7613a91607ca2cf4b9ba43763a45990107b76701d1",
          "gtin14": "04600682000013",
          "serial": "B2",
          "canonical": "010460068200001321B2\u001d93dGVz"
        },
        "boxId": "00000000-0000-4000-8000-000000000009"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000014",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_exception",
      "data": {
        "exception": "clear",
        "boxId": "00000000-0000-4000-8000-000000000009",
        "codeHash": null,
        "targetScannedAt": null,
        "reasonCode": null,
        "reasonText": null,
        "occurredAt": "2026-10-08T06:15:13.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000016",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
      "data": {
        "scannedAt": "2026-10-08T06:15:14.000Z",
        "verdict": "ok",
        "duplicateSource": null,
        "rawKind": "km",
        "rawLength": 30,
        "code": {
          "codeHash": "063b9bb4374012267a1d3a5b63d0e4b6df1425c9ba5df952e7f4bdead08b23b7",
          "gtin14": "04600682000013",
          "serial": "C1",
          "canonical": "010460068200001321C1\u001d93dGVz"
        },
        "boxId": "00000000-0000-4000-8000-000000000009"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000017",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
      "data": {
        "scannedAt": "2026-10-08T06:15:15.000Z",
        "verdict": "ok",
        "duplicateSource": null,
        "rawKind": "km",
        "rawLength": 30,
        "code": {
          "codeHash": "4891a84fae19995d63f378df3767daae9ab1db7621d416c865ea99e679f83304",
          "gtin14": "04600682000013",
          "serial": "C2",
          "canonical": "010460068200001321C2\u001d93dGVz"
        },
        "boxId": "00000000-0000-4000-8000-000000000009"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000018",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "scan",
      "data": {
        "scannedAt": "2026-10-08T06:15:16.000Z",
        "verdict": "ok",
        "duplicateSource": null,
        "rawKind": "km",
        "rawLength": 30,
        "code": {
          "codeHash": "1113b4cb64b09199a76d13cea056fdf13386c1810623e6cbbb13f47d6b7955f1",
          "gtin14": "04600682000013",
          "serial": "C3",
          "canonical": "010460068200001321C3\u001d93dGVz"
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
        "blockId": "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
        "serial": 1501,
        "openedAt": "2026-10-08T06:15:09.000Z",
        "closedAt": "2026-10-08T06:15:17.000Z",
        "itemCount": 3,
        "membershipDigest": "334a2cae4baf8c969aae3f80d30651f6179041c2479517f1b440442661f92d9a"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000021",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_label",
      "data": {
        "boxId": "00000000-0000-4000-8000-000000000009",
        "outcome": "verified",
        "at": "2026-10-08T06:15:20.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000022",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_exception",
      "data": {
        "exception": "disassemble",
        "boxId": "00000000-0000-4000-8000-000000000002",
        "codeHash": null,
        "targetScannedAt": null,
        "reasonCode": "wrong_quantity",
        "reasonText": null,
        "occurredAt": "2026-10-08T06:15:21.000Z"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000025",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "box_exception",
      "data": {
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
        "duplicateSource": null,
        "rawKind": "km",
        "rawLength": 30,
        "code": {
          "codeHash": "5066bf31ac88f18398f693870a0bfd29993658de62927d6141b9e2073da2df66",
          "gtin14": "04600682000013",
          "serial": "A1",
          "canonical": "010460068200001321A1\u001d93dGVz"
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
        "duplicateSource": null,
        "rawKind": "km",
        "rawLength": 30,
        "code": {
          "codeHash": "7d7697d127a14af608a8c5aaf4e1faaa13bc43bdde9b05372f2a00f1ca1fe0ae",
          "gtin14": "04600682000013",
          "serial": "A2",
          "canonical": "010460068200001321A2\u001d93dGVz"
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
      "operatorId": "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      "kind": "shift_closed",
      "data": {
        "plannedQtySnapshot": 1200,
        "actualQty": 5,
        "closedBoxCount": 2,
        "reasonCode": "production_order_changed",
        "closedAt": "2026-10-08T06:15:32.000Z"
      }
    }
  ],
  "sends": [
    {
      "ids": [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004",
        "00000000-0000-4000-8000-000000000006",
        "00000000-0000-4000-8000-000000000007"
      ],
      "answer": "receipts"
    },
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
    },
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
    },
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
      "answer": "receipts"
    }
  ]
}
```

Создать `apps/standalone/test/floor-scenario.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { closeShift } from "../src/floor/close/shift-close.js";
import {
  clearOpenBox,
  disassembleBox,
  reprintBox,
  undoLastCode,
  type ReprintContext,
} from "../src/floor/exceptions/box-exceptions.js";
import {
  boxLabelStep,
  readOpenJob,
  sendLabelJob,
  type PrintJob,
} from "../src/floor/print/print-jobs.js";
import { checkLabel } from "../src/floor/print/print-resolution.js";
import { closeIfFull, closeOpenBox } from "../src/floor/work/box-close.js";
import { processScan } from "../src/floor/work/scan-pipeline.js";
import { readWorkTotals } from "../src/floor/work/work-reads.js";
import { HostError } from "../src/host/client.js";
import type { FactReceipt } from "../src/host/protocol.js";
import { sendFactBatch } from "../src/local/facts-sender.js";
import {
  countingIds,
  ENTERED,
  enteredShift,
  km,
  OPERATOR_ID,
  PAIRING,
  rows,
  scanContext,
  seedBlock,
  steppingClock,
} from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRender, manualRuntime, setUpPrinting } from "./support/printing.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

/** The block the station holds: the host's first block of a new site, 1500–3499. */
const BLOCK = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";

/** How a send of the outbox ended: the host's receipts, no host at all, or an answer lost on its way back. */
type Answer = "receipts" | "unreachable" | "lost";

/**
 * The scenario both sides read (`proto/fixtures/floor-scenario.json`): the
 * station's ids of the shift and the block, the numbers it ends with, every
 * record it wrote, in the outbox's order, and every send of the outbox — the
 * records' ids and how the send ended. `host/tests/floor_scenario.rs` sends
 * the same batches to the host's router and checks that it takes every
 * record and ends with the same numbers.
 */
const scenarioSchema = z.object({
  station: z.object({
    shiftId: z.string(),
    blockId: z.string(),
    acceptedUnits: z.number(),
    closedBoxes: z.number(),
  }),
  records: z.array(z.object({ id: z.string() }).loose()),
  sends: z.array(
    z.object({ ids: z.array(z.string()), answer: z.enum(["receipts", "unreachable", "lost"]) }),
  ),
});
type Scenario = z.infer<typeof scenarioSchema>;

/**
 * The host of the scenario, from the station's side: it answers each send
 * as told next — receipts `accepted` for every record (what the host's
 * router answers, `host/tests/floor_scenario.rs` checks), no answer at all,
 * or an answer lost after the host took the batch — and keeps every send.
 */
function scenarioHost() {
  const sends: { ids: string[]; answer: Answer }[] = [];
  let next: Answer = "receipts";
  return {
    sends,
    answerNext: (answer: Answer) => {
      next = answer;
    },
    send: async (records: readonly unknown[]): Promise<FactReceipt[]> => {
      const ids = records.map((record) => z.object({ id: z.string() }).parse(record).id);
      const answer = next;
      next = "receipts";
      sends.push({ ids, answer });
      if (answer === "receipts") return ids.map((id) => ({ id, outcome: "accepted" }));
      throw new HostError({
        kind: "transport",
        code: "unreachable",
        message: answer === "lost" ? "the answer was lost" : "no host",
      });
    },
  };
}

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
  const print: ReprintContext = {
    local,
    pairing: PAIRING,
    runtime,
    now,
    operatorId: OPERATOR_ID,
    newId,
    shift,
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

  /** The label that waits goes to the printer and is checked by a scan of its SSCC. */
  const printAndCheck = async (job: PrintJob | null) => {
    const waiting = job ?? (await readOpenJob(local, PAIRING, shift.copy.id));
    if (waiting === null) throw new Error("no label waits");
    const sent = waiting.state === "prepared" ? await sendLabelJob(print, waiting) : waiting;
    const checked = await checkLabel(print, sent, `]C100${sent.sscc}`);
    if (checked.kind !== "verified") throw new Error(checked.kind);
  };
  const scan = async (serial: string) => {
    const outcome = await processScan(context, km(serial));
    if (outcome.kind !== "accepted") throw new Error(`${serial}: ${outcome.kind}`);
    const closed = await closeIfFull(context, [label]);
    if (closed !== null) {
      if (closed.kind !== "closed") throw new Error(closed.kind);
      await printAndCheck(null);
    }
  };
  const deliver = async () => {
    try {
      await sendFactBatch(local, PAIRING, host.send, now);
    } catch (error) {
      if (!(error instanceof HostError)) throw error;
    }
  };

  for (const serial of ["A1", "A2", "A3"]) await scan(serial);
  await deliver();
  const [firstBox] = rows(db, "SELECT id FROM floor_boxes WHERE serial = 1500");

  for (const serial of ["B1", "B2"]) await scan(serial);
  expect(await undoLastCode(context)).toMatchObject({ kind: "done" });
  await scan("B2");
  expect(await clearOpenBox(context)).toMatchObject({ kind: "done" });
  for (const serial of ["C1", "C2", "C3"]) await scan(serial);
  expect(
    await disassembleBox(context, String(firstBox?.["id"]), { code: "wrong_quantity", text: null }),
  ).toMatchObject({ kind: "done" });
  const [secondBox] = rows(db, "SELECT id FROM floor_boxes WHERE serial = 1501");
  const reprinted = await reprintBox(
    print,
    String(secondBox?.["id"]),
    { code: "damaged_label", text: null },
    settings,
    fakeRender,
  );
  await printAndCheck(reprinted);
  for (const serial of ["A1", "A2"]) await scan(serial);
  const third = await closeOpenBox(context, [label]);
  if (third.kind !== "closed") throw new Error(third.kind);
  await printAndCheck(null);
  expect(await closeShift(context, "production_order_changed")).toMatchObject({ kind: "closed" });

  host.answerNext("unreachable");
  await deliver();
  host.answerNext("lost");
  await deliver();
  await deliver();

  const records = rows(db, "SELECT payload FROM outbox ORDER BY seq").map((row) =>
    z
      .object({ id: z.string() })
      .loose()
      .parse(JSON.parse(String(row["payload"]))),
  );
  const totals = await readWorkTotals(local, PAIRING, shift.copy.id);
  const scenario: Scenario = {
    station: {
      shiftId: shift.copy.id,
      blockId: BLOCK,
      acceptedUnits: totals.accepted,
      closedBoxes: totals.closedBoxes,
    },
    records,
    sends: host.sends,
  };
  return { db, scenario };
}

describe("one shift on one PC, from the first code to the close, with the host away", () => {
  it("writes the records of the shared scenario, sends them in its batches, and ends closed", async () => {
    const { db, scenario } = await runScenario();
    const fixture = scenarioSchema.parse(
      JSON.parse(
        readFileSync(new URL("../proto/fixtures/floor-scenario.json", testModuleUrl), "utf8"),
      ),
    );
    expect(scenario).toEqual(fixture);
    expect(rows(db, "SELECT local_state FROM floor_shifts")).toEqual([{ local_state: "closed" }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")).toEqual([{ n: 0 }]);
    expect(scenario.records.map((record) => record["kind"])).toEqual([
      "scan",
      "scan",
      "scan",
      "box_closed",
      "box_label",
      "scan",
      "scan",
      "box_exception",
      "scan",
      "box_exception",
      "scan",
      "scan",
      "scan",
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
    ]);
  });

  it("sends again, with the same ids, a batch that found no host or whose answer was lost", async () => {
    const { scenario } = await runScenario();
    const [online, unreachable, lost, answered] = scenario.sends;
    expect(online).toEqual({
      ids: scenario.records.slice(0, 5).map((r) => r.id),
      answer: "receipts",
    });
    expect(unreachable?.answer).toBe("unreachable");
    expect(lost).toEqual({ ids: unreachable?.ids, answer: "lost" });
    expect(answered).toEqual({ ids: unreachable?.ids, answer: "receipts" });
    expect(unreachable?.ids).toEqual(scenario.records.slice(5).map((r) => r.id));
    expect(scenario.sends).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Тесты проходят сразу**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scenario.test.ts`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  2 passed (2)`: тест проверяет собранное задачами 1–7; что он ловит, показывают мутации шага 3.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test floor_scenario`
Expected: PASS — `test result: ok. 2 passed; 0 failed`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  112 passed (112)`, `Tests  2643 passed (2643)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 3: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — очередь уходит не по порядку `seq`.
В `apps/standalone/src/local/facts-sender.ts` фрагмент

<!-- prettier-ignore -->
```ts
      "AND acked_at IS NULL ORDER BY seq LIMIT ?",
```

заменить на:

<!-- prettier-ignore -->
```ts
      "AND acked_at IS NULL ORDER BY seq DESC LIMIT ?",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scenario.test.ts`
Expected: FAIL — «writes the records of the shared scenario, sends them in its batches, and ends closed», «sends again, with the same ids, a batch that found no host or whose answer was lost».

М2 — запись `undo` в фикстуре называет не тот момент скана (так написала бы станция, взявшая момент снятия, а не момент скана). В `apps/standalone/proto/fixtures/floor-scenario.json` фрагмент

<!-- prettier-ignore -->
```json
        "targetScannedAt": "2026-10-08T06:15:10.000Z",
```

заменить на:

<!-- prettier-ignore -->
```json
        "targetScannedAt": "2026-10-08T06:15:11.000Z",
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test floor_scenario`
Expected: FAIL — `the_host_takes_every_record_of_the_stations_shift_once_and_ends_with_its_numbers` и `the_stations_facts_after_the_offices_close_are_taken_and_mark_the_shift_late`: хост оставляет снятый код живым, и повторный скан того же кода получает `conflict` (`sameDevice`), а не `accepted`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-scenario.test.ts`
Expected: FAIL — «writes the records of the shared scenario, sends them in its batches, and ends closed» (записи станции больше не совпадают с фикстурой).

- [ ] **Step 4: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/floor-scenario.json apps/standalone/test/floor-scenario.test.ts`; `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`; сборка тестов хоста — без предупреждений.

- [ ] **Step 5: Commit**

```bash
git add apps/standalone/host/tests/floor_scenario.rs apps/standalone/proto/fixtures/floor-scenario.json apps/standalone/test/floor-scenario.test.ts
git commit -m "test(standalone): one shift on one PC end to end, the station's records replayed through the host's router" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Документы — `AGENTS.md` и уточнения спецификации

Раздел «Floor exceptions and close» и ручной список Windows в `apps/standalone/AGENTS.md`, правка абзацев о списке смен и выходе из смены, раздел «Уточнения плана 2a8» в спецификации этапа (номер — следующий свободный).

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`

**Interfaces:**

- Consumes: всё задач 1–8.
- Produces:
  - документы: `apps/standalone/AGENTS.md` («Shifts», «Floor work», «Floor exceptions and close», «Verification»), спецификация этапа (раздел «Уточнения плана 2a8»).

- [ ] **Step 1: Документы**

Правка `apps/standalone/AGENTS.md`:

Фрагмент 1:

<!-- prettier-ignore -->
````markdown
screen outlives their sign-out. The list shows this pairing's copies of the
line's planned and active shifts and one this station is closing
(`readShiftCopies`), never a closed one, so it stays on screen with the host
away. Opening a planned shift and creating one need the host: it freezes the
````

заменить на:

<!-- prettier-ignore -->
````markdown
screen outlives their sign-out. The list shows this pairing's copies of the
line's planned and active shifts, one this station is closing and one the
office closed after this station entered it, until this station closes it
(«Завершить», plan 2a8; `readShiftCopies`), never another closed one, so it
stays on screen with the host
away. Opening a planned shift and creating one need the host: it freezes the
````

Фрагмент 2:

<!-- prettier-ignore -->
````markdown
Leaving the shift — back to the list, a sign-out (the operator's own, idle,
removed), the office's close of the shift (seen in the copies after a read:
«Смену … закрыли в офисе»), another line — waits for the work the screen
tracks (`createWorkGate`, `src/floor/work-gate.ts`: a failed piece of work
````

заменить на:

<!-- prettier-ignore -->
````markdown
Leaving the shift — back to the list, a sign-out (the operator's own, idle,
removed), another line — waits for the work the screen
tracks (`createWorkGate`, `src/floor/work-gate.ts`: a failed piece of work
````

Фрагмент 3:

<!-- prettier-ignore -->
````markdown
is dropped silently. The box's label is «Floor printing»; the exceptions and
the shift's close are plan 2a8.

## Floor printing
````

заменить на:

<!-- prettier-ignore -->
````markdown
is dropped silently. The box's label is «Floor printing»; the exceptions and
the shift's close are «Floor exceptions and close».

## Floor printing
````

Фрагмент 4:

<!-- prettier-ignore -->
````markdown
it is open (`SystemAwake.hold`).

## Marking rules
````

заменить на:

<!-- prettier-ignore -->
````markdown
it is open (`SystemAwake.hold`).

## Floor exceptions and close

Stage 2a, plan 2a8 (`src/floor/exceptions`, `src/floor/close`,
`src/local/retention.ts`). The work screen's «Исключения» (`ExceptionFlow`,
`Stop` `exceptions`; never while a label waits or the operator leaves) does
four things, each as the line's next piece of work, handed to the work gate,
and each in ONE transaction with the station's `floor_exceptions` row and its
`box_exception` record (`box-exceptions.ts`):

- «Снять последний код» (`undoLastCode`): the code accepted last into the
  open box (the latest row of `floor_codes` by rowid, whatever the clock
  says) leaves it and is free again; the record carries that code's hash and
  the EXACT `scanned_at` of its `floor_codes` row — the text of the scan's
  own record — because the host takes out only the item of that code added
  at that instant (plan 2a2), so an undo that arrives late, or is sent again
  under a new id, never takes out a later scan of the code.
- «Очистить короб» (`clearOpenBox`), after a confirmation: every code of the
  open box is free again and the box stays open; the record's `occurredAt`
  is the moment of the clear, up to which the host takes out the items.
- «Перепечатать этикетку» of a closed box whose label is done with
  (`reprintBox`): a new print job with the SSCC and the fields of the box's
  last job, the snapshot's template of its revision and the box printer of
  now, written with the `reprint` record and its reason, then sent once; a
  label that waits is decided at its panel (`LabelWaitingError`).
- «Расформировать короб» (`disassembleBox`), after a confirmation: the box's
  codes are free again, `disassembled_at` is set, the SSCC stays spent and
  the box no longer counts among the closed ones.

Each guard compares what was read (the box open with the count read; not yet
taken apart), so a scan or another exception that landed meanwhile makes it
`stale` and writes nothing. A closed box is chosen by a scan of its label
(taken before the pipeline, never journalled) or by the last digits of its
SSCC on a pad of 64 px keys — a text field would take a keyboard scanner's
keys. A reprint and a disassembly need a reason of their list
(`exception-reasons.ts`), with words only for «Другая причина»: trimmed, at
most 200 code points, no control character (`reasonWords`, the host's
`validate::exception_reason_text`), refused before anything is written.

«Закрыть смену» (`ShiftClosePanel`, `Stop` `close`) shows the summary — the
product, the plan of the station's copy now, the fact (the codes it holds),
the deviation, the closed boxes and the units per box — read as the line's
next piece of work, so a scan taken before the press is counted. An open box
with codes or a label that waits keeps the shift open (`readCloseSummary`'s
blocker) and sends the operator back to the work, where both are resolved;
the plan not met needs one of the domain's six reasons. The close
(`closeShift`) is local and needs no host: ONE transaction drops the empty
open box, writes the `shift_closed` record (the plan it saw, the fact, the
closed boxes, the reason, the moment) and marks the copy `closing`, but only
while nothing changed since the summary (no waiting label, the same counts of
codes and closed boxes, which a code scanned or taken out since changes; else
`stale`, and the summary is read again). From then on the
shift takes no record: `outboxStatement` inserts a record only while its
shift has no `local_state`, so its whole transaction is refused otherwise
and `shift_closed` is always the shift's last record (the host marks the
station's own shift late for anything after it). The screen then says «Смена
закрыта. Данные будут отправлены автоматически» with the link and without
it, takes no scan again, and «К списку смен» leaves. «Назад к работе» and
«Выйти из смены» are never held, but while the close writes. The receipt
`accepted` of the record — `alreadyClosed` too — makes the copy `closed`
(the fourth statement of `sendFactBatch`); a refused close stays `closing`,
its card in the list says the host's code, and the office closes it there.
The list reads its copies again after every write and every batch of
receipts (`ShellState.outboxVersion`).

A shift the office closes while the station works in it (or before the
station closed it) stays on the work screen to be finished: no new code is
taken (the scan is said, never journalled), while the box, its label, the
exceptions and the shift's close work as usual; in the list it is «Закрыта в
офисе» with «Завершить», which enters it from the stored snapshot without the
host. Its records are late for the host, which takes them, and its close
gets `alreadyClosed`. The station's own close is never undone by the host's
list: `replaceShiftCopies` never touches `local_state`.

The retention (`purgeAcknowledged`, decision 31) runs when the app starts and
every hour (`scheduleRetention`, never two passes at a time): a shift of the
pairing that this station closed, whose close the host took at least 30 days
ago, with every record answered and no label waiting, goes with all its
rows — the tables of `RETAINED_TABLES` by `shift_id`, then the copy, one
shift per transaction, whose first statement deletes the copy only while
that still holds. The SSCC blocks stay (a restored host asks for them, plan
РК). A later plan's table of a shift's records joins `RETAINED_TABLES`: a
test fails for any table with a `shift_id` that the list does not name.

One shift on one PC is checked end to end on both sides of the protocol:
`test/floor-scenario.test.ts` runs it with the webview's own modules — codes,
three boxes with checked labels, every exception, the host away, the close,
a send that finds no host, one whose answer is lost — and compares the
records and sends with `proto/fixtures/floor-scenario.json`;
`host/tests/floor_scenario.rs` sends those batches to the host's router,
which must answer every record `accepted` and end with the station's
numbers, the digest of every box matching, the shift closed by the station
and not late (and with the office's close first: every record taken, the
shift late, the close `alreadyClosed`). A change of what the station writes
changes the fixture, and both tests read it.

## Marking rules
````

Фрагмент 5:

<!-- prettier-ignore -->
````markdown
    removed, its status, and the scanners again after a restart.
- The floor's work (plan 2a6) by hand, on Windows 10 and 11. None of it has
````

заменить на:

<!-- prettier-ignore -->
````markdown
    removed, its status, and the scanners again after a restart.
- The floor's exceptions and close (plan 2a8) by hand, on Windows 10 and 11.
  None of it has been run; check at least:
  - each exception on the touch panel, a box chosen by a scan of its label
    with the client's scanner and by the last digits on the pad, and the
    words of «Другая причина» typed with the on-screen keyboard while a
    keyboard scanner is plugged in;
  - the close of a shift with the host's PC switched off: the words after
    the close, the status bar's unsent count, the list's «Закрывается», and
    the close reaching the host once it is back (the office sees the shift
    closed by the station with the same numbers);
  - the office closing a shift while the station works in it: the work
    screen's message, the box and its label finished, the station's close,
    and «Завершить» in the list after a restart of the app;
  - the PC switched off in the middle of a close: on return the shift is
    either open or «Закрывается», never in between.
- The floor's work (plan 2a6) by hand, on Windows 10 and 11. None of it has
````

Правка `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`:

Фрагмент 1:

<!-- prettier-ignore -->
````markdown
- Запрос состояния принтера перед печатью (`~HS`) не делается (вопрос владельцу).
````

заменить на:

<!-- prettier-ignore -->
````markdown
- Запрос состояния принтера перед печатью (`~HS`) не делается (вопрос владельцу).

## 20. Уточнения плана 2a8

План `docs/superpowers/plans/2026-10-10-standalone-2a8-floor-exceptions-close.md` (цех: исключения,
закрытие смены, смена, закрытая офисом, срок хранения, сквозной сценарий) уточняет решения 17, 31
и 36, разделы 5.4, 5.5, 5.7.6, 5.7.7 и 7 так; допущения по вопросам раздела 11 и спецификации
пилота — рекомендованные варианты (если номер раздела занят, этот раздел получает следующий
свободный).

- Исключения — экран «Исключения» рабочего экрана; каждое пишется одной транзакцией со строкой
  `floor_exceptions` и записью `box_exception`. «Снять последний код» снимает код, принятый в
  открытый короб последним (по rowid `floor_codes`, а не по часам), и запись несёт его хеш и ровно
  `scanned_at` его строки `floor_codes`: хост снимает только позицию этого кода, добавленную в этот
  момент. «Очистить короб» — с подтверждением, `occurredAt` — момент очистки. «Перепечатать
  этикетку» — только короба с решённой этикеткой: новое задание с SSCC и полями последнего задания
  короба, шаблоном снимка его ревизии и принтером назначения «Короб» сейчас, вместе с записью
  `reprint`; ждущая этикетка решается в своей панели. «Расформировать короб» — с подтверждением:
  коды свободны, SSCC остаётся израсходованным. Короб выбирается сканом этикетки (скан не
  журналируется) или последними цифрами SSCC на клавиатуре из кнопок 64 px. Слова причины `other` —
  до 200 кодовых точек одной строкой, проверяются до записи.
- Закрытие смены — сводка: план копии станции сейчас, факт (коды, которые держит станция),
  отклонение, коробов закрыто, в среднем в коробе. Её читают в очереди работы, поэтому скан до
  нажатия в ней учтён. Открытый короб с кодами и ждущая этикетка не дают закрыть смену и
  возвращают оператора к работе; причина из шести нужна при невыполненном плане. Транзакция
  закрытия сверяет со сводкой счётчики кодов и закрытых коробов (новый или снятый код меняет их) и
  отсутствие ждущей этикетки (иначе ничего не пишет, и сводка читается заново). После закрытия смена не принимает ни одной записи:
  `outboxStatement` вставляет запись только при пустом `local_state` её смены, поэтому
  `shift_closed` — всегда последняя запись смены. Повторная отправка отклонённой записи после
  закрытия (план ОЧ) поздняя по определению и пишется в обход этой проверки.
- Квитанция `accepted` на `shift_closed` (и с `alreadyClosed`) переводит смену в `closed` четвёртым
  оператором транзакции квитанций; отклонённое закрытие оставляет `closing`, карточка списка
  называет код отказа, а смену закрывает офис. Список перечитывает копии после каждой записи и
  каждой пачки квитанций.
- Смена, закрытая офисом, пока станция в ней работает (или до её закрытия станцией), не выводит
  оператора, как предлагал §5.4: выход сразу бросал короб и этикетку на линии без способа их
  закончить. Рабочий экран не принимает новых кодов (скан не журналируется), а короб, этикетка,
  исключения и закрытие смены работают; в списке такая смена — «Закрыта в офисе» с «Завершить»
  (вход по сохранённому снимку без хоста). Хост принимает её записи как поздние, закрытие получает
  `alreadyClosed`.
- Срок хранения — при запуске приложения и раз в час: смена, закрытая станцией, закрытие которой
  хост принял не меньше 30 дней назад, все записи которой получили квитанции и у которой нет ждущей
  этикетки, удаляется целиком (таблицы `RETAINED_TABLES` и копия), по смене на транзакцию. Блоки
  SSCC остаются (план РК).
- Сквозной сценарий — общая фикстура `proto/fixtures/floor-scenario.json`: Vitest строит её модулями
  цеха с детерминированными часами и идентификаторами, cargo-тест хоста отправляет те же пачки в
  настоящий маршрутизатор (`TestApp`, без сокета) и сверяет квитанции, итоги, дайджесты коробов и
  отметку поздних данных. Процесс `markiro-host run` и HTTP-клиент тестов (§7) не понадобились.
- Не проверено: Windows, сенсорная панель, сканеры клиента, отключение питания посреди закрытия.
````

- [ ] **Step 2: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`; `git diff --check`
Expected: чисто.

- [ ] **Step 3: Commit**

```bash
git add apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md
git commit -m "docs(standalone): the floor's exceptions and close in AGENTS.md, spec section 20" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Итоговая проверка плана

1. Полный набор пакета: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — PASS; Vitest на копии плана — 112 файлов, 2643 теста (на настоящем дереве числа сдвигаются на тесты, которых на копии нет). Падение старого теста офиса тайм-аутом под нагрузкой записывается и разбирается (заметки), а не лечится повтором.
2. Rust: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test floor_scenario` — `2 passed`; гейт `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace --no-fail-fast` вне песочницы (его `ipc` открывает сокет) — PASS; на копии плана падает один тест `ipc`, `forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays`, — артефакт копии, названный планом 2a7: `src-tauri` план не меняет, двоичный тест тот же до плана и после, а на настоящем дереве у `ipc.rs` свой вид. Исходники Rust план не меняет: `git diff --stat <основа плана> -- apps/standalone/host/src apps/standalone/proto/src apps/standalone/src-tauri` пуст, а `-- apps/standalone/host apps/standalone/proto` называет только `host/tests/floor_scenario.rs` и `proto/fixtures/floor-scenario.json`.
3. Стенд с задержкой `setImmediate` и verbose-прогон для всех новых и изменённых тестовых файлов с React (`floor-work-exceptions`, `floor-work-close`, `floor-shift-list`, `floor-app`, `app`) — PASS, в выводе нет `stderr |`.
4. Каждая мутация задач 1–8 — FAIL названного теста, файл восстановлен (`cmp`, тот же `shasum`), `git status --short` после всех — пуст.
5. Классы целостности закрыты тестами, каждый с мутацией: закрытие смены — последняя запись («writes `shift_closed` as the shift's last record…», М3 задачи 3); ни одной записи после него, кто бы ни писал («lets no record of the shift follow its close…», М1); ничего не теряется без хоста — смена закрывается локально, запись ждёт и уходит последней («closes the shift while the host is away…» в `app.test.tsx`, задача 5, и сценарий задачи 8); оператор всегда уходит («Выйти из смены» на сводке и после закрытия, «Назад к работе», «Вернуться к работе» и «Другое действие» после сбоя записи; ждущая этикетка решается «Продолжить без этикетки» — «waits for a label that waits; once it is skipped the shift closes»); позднее закрытие офисом не портит локального состояния («show a shift the office closed after this station entered it, until this station closes it» и «offers to finish a shift the office closed…», М3 и М4 задачи 6, сценарий офиса в задаче 8). Тесты конкурентности держат запись или отправку (`holdingWrites`, `holdSends`), их ожидание ограничено числом шагов.
6. `grep -rnF '\u04' apps/standalone/src apps/standalone/test` — только `src/host/pairing-code.ts:66`; `grep -rn "console\." apps/standalone/src/floor/exceptions apps/standalone/src/floor/close apps/standalone/src/local/retention.ts` — ничего (журнал процесса не видит ни кодов, ни SSCC).
7. `git diff --check` от основы плана; `git log --format=%B` каждого коммита — ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; изменены только пути раздела «Файлы».
8. Сверка с разделом «Контракт для ПЛ-Ц и ОЧ»: `undoLastCode`, `clearOpenBox`, `disassembleBox`, `reprintBox`, `readClosedBoxes`, `reasonWords`, `ExceptionFlow`, `ExceptionOutcome`, `readCloseSummary`, `CloseBlocker`, `closeShift`, `readRefusedCloses`, `ShiftClosePanel`, `purgeAcknowledged`, `scheduleRetention`, `RETAINED_TABLES`, `WorkScreenProps.officeClosed`, `Stop` названы в коде так, как в контракте.

**Что нельзя проверить без Windows, оборудования и данных клиента** (отчёт называет отдельно от автоматических проверок): исключения на сенсорной панели клиента (кнопки 64 px, клавиатура из цифр при 1024 × 768 и 1280 × 800); выбор короба сканом его этикетки сканером клиента (SSCC с `]C1` и без); слова «Другой причины» экранной клавиатурой Windows при подключённом сканере-клавиатуре; закрытие смены при выключенном ПК хоста (вариант А) — слова после закрытия, «Не отправлено» в строке состояния, «Закрывается» в списке и закрытие на хосте после возвращения связи с теми же числами в офисе; офис закрывает смену, пока станция в ней работает, — сообщение рабочего экрана, короб и этикетка доведены, закрытие станцией, «Завершить» после перезапуска приложения; выключение ПК посреди закрытия — смена после запуска либо открыта, либо «Закрывается», никогда посередине; срок хранения на настоящей базе станции через 30 дней (тест сдвигает часы, а не ждёт); загрузка выгрузки смены, закрытой станцией, в ЛК ЧЗ — планы О-Х, ЧЗ.

## Перенесено

- **Нарастание блокировок входа и факт блокировки на хосте (вопрос В14)** — новый вид факта `floor_lockout` (тип `proto`, Zod, фикстура, обработчик хоста, строка журнала действий) и правка `lockout.ts`: поток хоста, вместе с протоколом 3 плана ПЛ-Х или отдельным малым планом.
- **«Отправить снова» отклонённой записи, в том числе закрытия смены** — план ОЧ (порядок — в «Контракте»: новый `id`, `data` байт в байт, в обход проверки `outboxStatement`).
- **Паллеты: исключения паллеты, «Закрыть паллету и смену», паллетные таблицы в сроке хранения, паллета в сквозном сценарии** — план ПЛ-Ц (точки расширения — в «Контракте»).
- **Запросы блоков другого префикса** (перенесено планом 2a6 сюда): срок хранения их не трогает — запрос блока не принадлежит смене, а повтор после восстановления хоста (план РК) должен найти свой `requestId`. Удаление брошенных запросов — вместе с РК-С.
- **Сводка закрытия по операторам** (облачный `getShiftSummary`) — не печатается и не выгружается (спецификация пилота §4.2).
- **Предложение закрыть смену при достижении плана** — уведомление «План выполнен» плана 2a6 остаётся уведомлением; кнопка «Закрыть смену» рабочего экрана рядом. Кнопка закрытия в самом уведомлении — по просьбе владельца.
- **Проверка часов станции**: «Снять последний код» берёт порядок принятия, но хост снимает позицию по моменту скана; если часы станции отступили назад между сканом и очисткой, позиция до момента очистки на хосте может остаться живой (компромисс облака, ревью задачи 5 плана 2a2, — вопрос владельцу из 2a2). Расхождение часов — этап 2b.

## Отклонения при исполнении
