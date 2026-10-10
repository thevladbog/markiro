# План 2a7: цех — этикетка короба, задания печати и восстановление, проверка этикетки, настройка рабочего места, «не засыпать» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Каждый закрытый короб получает этикетку с его уникальным SSCC на принтер Zebra или TSC (сеть 9100, COM, USB через спулер): этикетка строится на станции из шаблона снимка смены в языке и разрешении назначенного принтера, задание печати пишется той же транзакцией, что закрытие короба, проходит состояния «подготовлено → отправляется → отправлено → проверено / пропущено», сбой («не отправлено») и неизвестный исход отличаются, и ни одна этикетка не печатается второй раз без решения оператора (с причиной, если первая могла выйти); после перезапуска или отключения питания прерванная печать — «исход неизвестен»; при включённой проверке оператор сканирует SSCC напечатанной этикетки; настройка рабочего места задаёт принтеры, их назначения, COM-сканеры, звук и проверку, с пробной печатью; пока открыт рабочий экран смены, компьютер не засыпает. Печатающая часть цеха этапа 2a — на критическом пути пилота у текущего клиента.

**Architecture:**

- Локальная миграция `0007` (задача 1): `floor_print_jobs` (данные устройства; `purpose` `box`/`pallet` и `subject_id`, чтобы план паллет ПЛ-Ц не пересобирал таблицу) и `workstation_settings` (настройки ПК, класс `Workstation`).
- Настройки рабочего места (задача 2, `src/floor/setup/workstation-settings.ts`): профили принтеров и назначения `box`, `pallet`, `duplicate` по образцу облачной маршрутизации, COM-сканеры (отдаются оболочке при запуске), звук, проверка этикетки; каждый ключ читается отдельно, записывается только то, что прочитается так же.
- Этикетка (задача 3, `src/floor/print/label-render.ts`): поля `boxLabelFields` домена из снимка, байты — `generateZpl`/`generateTspl` в разрешении принтера (`withPrinterDpi`) с растеризатором предпросмотра офиса, получившим потолок холста 4096 × 4096.
- Задания (задача 4, `print-runtime.ts`, `print-jobs.ts`): одна очередь принтеров на приложение (отправки на адрес по очереди, ответ не позже 20 с от вопроса); задание короба — `CloseStep` плана 2a6 в транзакции закрытия; `sending` до отправки; сравнение состояния и попытки при каждой записи; прерванные — `unknown`.
- Решения оператора (задача 5, `print-resolution.ts`): проверка сканом, пропуск, «Этикетка напечаталась», печать снова (с причиной-исключением `reprint`, если этикетка могла выйти), другой принтер.
- Рабочий экран (задача 6): печать после закрытия той же работой очереди, остановка на ждущей этикетке, проверка до конвейера, «не засыпать»; настройка рабочего места (задачи 7–8, `WorkstationSetup.tsx`) — из списка смен и из восстановления этикетки; документы (задача 9).
- Хост, `proto`, `apps/station`, `packages/*`, `package.json`, `pnpm-lock.yaml`, `Cargo.toml` и `Cargo.lock` не меняются. Из Rust меняются только `src-tauri/src/local_db.rs` (два класса таблиц) и тесты `src-tauri/tests/local_db.rs`, `ipc.rs`.

**Tech Stack:** React 19.2, TypeScript 6 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4.4.3, i18next, `@markiro/ui` (`Card`, `Button size="floor"`, `Input size="floor"`, `Select size="floor"`, `Alert`), `@markiro/domain` (`boxLabelFields`, `withPrinterDpi`, `generateZpl`, `generateTspl`, `parseScannedSscc`, `formatSsccHri`, `sampleLabelData`, `LABEL_FIELDS`), Vitest 4 с jsdom и `node:sqlite` за `LocalExecutor`; Rust — sqlx 0.8.6 (SQLite), Tauri 2.11 (mock runtime в `tests/ipc.rs`).

**Спецификации:**

- `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` (черновик этапа 2a): решения 19–23, 34, 36, §5.3 (миграция `0007`), §5.7.5 (печать и восстановление), §5.7.8 (настройка рабочего места), §5.7.9 (сон), §7 (ручной список Windows), строка 2a7 раздела 8, §11 (вопросы), уточнения планов 2a1–2a6.
- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`: §4.1 (строка 7 среза), §6.2 (паллеты-лайт: назначение `pallet` задания печати), §9.1 (печать без хоста), §12.5 (критический путь), §13 (что можно урезать: пункты 2 и 3 не урезаны), §14 (П1, П2, П10), §15 (печать на принтерах клиента, отключение питания посреди печати).
- `.superpowers/sdd/cloud-pallet-flow-notes.md`: состояния печати паллеты повторяют коробные — задания печати не знают вида этикетки.
- Планы, на которых стоит этот: 2a2 (`…-2a2-host-facts.md`: факты `box_label`, `box_exception` и их правила; ревью его задачи 6, «Minor 4»: поздние данные от собственной записи станции после закрытия смены), 2a4 (`…-2a4-shell.md`, «Контракт для 2a5–2a7»: `print_bytes`, `not_sent`/`outcome_unknown`, `list_usb_printers`, сканеры, `set_system_awake`; `src/hardware/hardware.ts`; очередь мелочей `.superpowers/sdd/2a4-minors.md`, пункт 15), 2a5 (`…-2a5-floor-shifts.md`, «Контракт для 2a6–2a8»: снимок, `FloorApp`), 2a6 (`…-2a6-floor-scanning.md`, «Контракт для 2a7–2a8»: `closeOpenBox(context, steps?)`, `CloseStep`, `WorkScreen`, `Stop`, `onRecorded`, перехват SSCC до `processScan`).
- `apps/standalone/AGENTS.md` — «Local database», «Hardware», «Floor work», «Marking rules», «Logs», «Verification».
- Облачная станция (переносится своими модулями, не импортом): `apps/station/src/lib/printer-routing.ts`, `print-label.ts`, `box-printing.ts`, `hardware-config.ts`, `close-box.ts`, `ui/BoxPrintRecovery.tsx`, `pages/WorkstationSetup.tsx`, `ui/setup/*` (`test-code.ts`), тексты `ru.json` (`box.printRecovery`, `setup`).

## Допущения по вопросам владельцу

Владелец не ответил ни на вопросы раздела 11 спецификации 2a, ни на вопросы раздела 14 спецификации пилота. План исполняет рекомендованные варианты; ниже — что принято и что поменять, если ответ будет другим.

- **П1 — хост на ПК станции (вариант Б), но печать от хоста не зависит.** Этикетка строится и печатается станцией из сохранённого снимка, задание — локальная запись; связь нужна только записям `box_label` и `box_exception`, которые уходят очередью фактов. При варианте А обрыв Wi-Fi печать не останавливает.
- **П10 — В1–В14 по рекомендации.** В11 А: не засыпать, пока открыт рабочий экран смены (не всегда в киоск-режиме). В10 А: настройку рабочего места открывает любой вошедший оператор (из списка смен; из рабочего экрана — только через восстановление этикетки). В6 — чисел печати нет. В5 — признаки `windows-sys` печати и питания уже добавлены шагом владельца плана 2a4.
- **П2 (паллеты-лайт) — вне 2a7, но задание печати к ним готово.** `floor_print_jobs.purpose` допускает `pallet` с первой миграции (спецификация пилота §6.2 предлагала отдельную миграцию с пересборкой таблицы: на критическом пути это лишняя задача ПЛ-Ц); назначение принтера «Этикетка паллеты» хранится и настраивается; записи `pallet_label` и `pallet_exception` и рендер паллеты — план ПЛ-Ц (точки расширения — в «Контракте»).
- **Спецификация пилота §13, пункты 2 и 3, не урезаны:** экраны настройки рабочего места и проверка этикетки входят в план (9 задач уложились). Если сроки потребуют — задачи 7–8 можно отложить: принтеры и сканеры тогда задаёт файл `workstation_settings` (ключи и форма — в «Контракте»), задачи 1–6 от них не зависят.
- **Вопросы этого плана (новые; рекомендованы варианты, по которым он написан):**
  - **ВП1 — запрос состояния принтера перед печатью (ZPL `~HS`, аналог TSPL).** А) не делать: «отправлено» не значит «напечатано», это доказывает только проверка этикетки сканом; Б) делать для сетевых Zebra (чтение на том же соединении, разбор ответа, своё время ожидания; для COM без управления потоком и для спулера не работает). **Рекомендация — А** (план 2a4 оставил решение плану 2a7): Б — новая команда оболочки и язык-зависимый разбор, а проверка сканом уже есть.
  - **ВП2 — «Продолжить без этикетки» без кода причины.** У факта `box_label` нет поля причины (протокол — поток Б); облачная станция пропускает так же, с подтверждением. Если владелец хочет причину на хосте — новое поле `box_label` и версия протокола (вместе с ПЛ-Х).
  - **ВП3 — проверка этикетки по умолчанию выключена** (как `DEFAULT_HARDWARE_CONFIG` облака); для принтеров через спулер Windows рекомендуется включать: спулер может принять задание при выключенном принтере (§10 спецификации 2a).
  - **ВП4 — повтор задания, которое ничего не отправило (`failed`), — тоже решение оператора**, без причины (решение 19: «повтор — только решением оператора»); автоматического повтора даже для `not_sent` нет.

## Global Constraints

**Из спецификации этапа** (дословные значения)

- Решение 19: таблица заданий с состояниями `prepared → sending → sent → verified`/`skipped`, `failed` (точно не отправлено), `unknown` (исход неизвестен; в том числе `sending`, найденное при запуске). Отметка `sending` пишется до передачи; повтор — только решением оператора; байты сохраняются (base64 в тексте), повтор отправляет те же байты, если язык и разрешение принтера совпадают, иначе строит заново из того же снимка.
- Решение 20: оболочка отвечает голыми кодами `not_sent` (ни один байт не ушёл) и `outcome_unknown` (сбой после начала записи); плюс `invalid_target`, `unsupported`.
- Решение 21: настройка рабочего места `verifyPrintedLabel` (по умолчанию выключена); пока проверка или восстановление печати открыты, обычные сканы не принимаются; скан SSCC сверяется с ожидаемым (`parseScannedSscc`).
- Решение 22: поля — `boxLabelFields` домена из снимка, `productionDate` — дата смены, `closedAt` — сохранённое время закрытия; печать в разрешении принтера (`withPrinterDpi`), растеризатор `src/labels/rasterizer.ts` с потолком холста 4096 × 4096 точек.
- Решение 23: назначения «Короб», «Паллета», «Дубль кода» хранятся с 2a, используется только «Короб»; профиль задания печати фиксируется в задании до отправки; отправки на один адрес идут по очереди.
- Решение 34: `set_system_awake(true)`, пока оператор в рабочем экране смены, `false` — при выходе из него.
- Решение 36: причины перепечатки — `damaged_label`, `unreadable_label`, `printer_jam`, `quality_request`, `other`.
- §5.7.5: принтер не назначен — задание `failed` с `printer_unconfigured`, экран восстановления предлагает настройку; больше потолка холста — `failed` с `render_failed`; при запуске каждое `sending` становится `unknown` (`interrupted`); «Пропустить» не закрывает `unknown` и `failed`: для них — «Напечатать снова», «Другой принтер» или «Этикетка напечаталась»; нерешённое задание печати не даёт закрыть следующий короб.
- §5.7.8: вкладки «Сканеры», «Принтеры» (профили: имя, подключение, ZPL/TSPL, 203/300 dpi; назначения; проверка печати этикетки), «Звук»; тестовая печать — этикетка 58 × 40 с кодом Code 128, которую оператор сканирует обратно; сохранение — `workstation_settings`; изменение сканеров сразу вызывает `configure_scanners`; вход — из списка смен, из рабочего экрана — только через восстановление печати.
- Решение 15 и «Logs»: ни кодов маркировки, ни SSCC целиком, ни сырого текста нераспознанных сканов в журнале процесса; скан бейджа не показывается.

**Из контрактов планов 2a2, 2a4, 2a6**

- `print_bytes` никогда не отправляет снова; `printBytes` вебвью не бросает и читает неизвестный ответ как `outcome_unknown`; `sent` — все байты ушли с компьютера, не «напечатано» (план 2a4); вызов оболочки может не ответить дольше её пределов — у вебвью свой предел ожидания.
- Запрос сна переживает перезагрузку вебвью: вебвью снимает его при запуске (очередь мелочей 2a4, пункт 15).
- Закрытие короба — точка расширения `CloseStep`: план 2a7 добавляет задание печати той же транзакцией; отправку начинает после результата `closed` (контракт 2a6). Скан SSCC при ждущей проверке перехватывается до `processScan`.
- Хост отмечает закрытую смену поздней (`late_data_at`) на любой принятый факт после закрытия, и на собственный факт станции (ревью задачи 6 плана 2a2, «Minor 4»): смену нельзя закрыть, пока задание печати её ждёт.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!` в исходниках (`as const` — не приведение); именованные экспорты, `import type`; члены интерфейсов, которые передаются несвязанными, — свойства-функции.
- Правила маркировки и этикеток — только `@markiro/domain`; рендер этикетки — на станции; предпросмотр и печать — одна модель.
- Экраны цеха: только `@markiro/ui`, каждая кнопка — `size="floor"` (64 px), состояние — словами; ни одна кнопка ухода («Выйти из смены», «Назад») не держится запросом, который может не ответить.
- Тексты — ключи `src/i18n/ru.json`, кириллица буквами; переменные текстов — именованные, не `count`.
- Тесты конкурентности детерминированы: удерживаемая запись (`holdingWrites`), удерживаемая отправка (`fakeHardware().holdSends`), таймеры, которые тест запускает руками (`manualTimers`); никаких надежд на время.
- Rust: `cargo fmt` чистый, сборка без предупреждений; `Cargo.toml`, `Cargo.lock` не меняются.
- Не меняются: `apps/station`, `packages/*`, `apps/standalone/host`, `apps/standalone/proto`, `package.json`, `pnpm-lock.yaml`.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Решения планировщика

- **Задание печати не знает вида этикетки.** `purpose` (`box`, `pallet`) и `subject_id` вместо `box_id`; запись решения по этикетке (`box_label`, `box_exception`) выбирается по `purpose` (`switch`), и для `pallet` план ПЛ-Ц дописывает свои ветки (`pallet_label`, `pallet_exception`); TypeScript заставит его это сделать.
- **`verify` хранится в задании** (настройка на момент задания): «ждущее» задание — `prepared`, `sending`, `failed`, `unknown` и `sent` с `verify = 1`; то же правило — в частичном уникальном индексе, в `isOpenJob` и в SQL `readOpenJob`/`shiftLabelsSettled` слово в слово. Выключенная потом проверка не закрывает уже ждущую — оператор её пропускает.
- **Поля этикетки хранятся в задании** (`fields`): рендер для другого принтера берёт те же поля (имя оператора, закрывшего короб, время закрытия), а макет — из снимка смены той же ревизии (`printAgain` сверяет `template_id` и `template_rev`).
- **Очередь принтеров с пределом на стороне вебвью.** Одна на приложение (`App`); следующая отправка на адрес ждёт настоящего завершения предыдущего вызова оболочки (иначе две этикетки сплелись бы); ответ — не позже 20 с от вопроса: байты у оболочки без ответа — `timeout` (`unknown`), байты, не дождавшиеся очереди, — `printer_busy` (`failed`) и оболочке не отдаются никогда. Задание «в полёте» до настоящего завершения вызова, и восстановление прерванных его не трогает.
- **`prepared` отправляется само один раз** — при входе в рабочий экран (записано с коробом, но станция остановилась до отправки): это первая отправка, не повтор, и `sending` пишется до неё. Всё остальное — решение оператора.
- **Печать снова этикетки, которая могла выйти** (`unknown`, `sent` с ждущей проверкой) — только с причиной перепечатки, которая пишется исключением `reprint` (`floor_exceptions` и `box_exception`) той же транзакцией, что `sending`: офис увидит, что у короба может быть две этикетки с одним SSCC. Повтор `failed` (ничего не ушло) — без причины. Тексты причины в 2a7 нет: только коды (поле слов — экран исключений плана 2a8).
- **«Этикетка напечаталась» — только для `unknown`**: у `failed` ничего не уходило с компьютера.
- **Ловушек нет.** «Выйти из смены» открыта при любой ждущей этикетке; этикетка ждёт до возвращения оператора; у восстановления всегда есть выход без печати («Продолжить без этикетки» с подтверждением) — линия не стоит из-за принтера, который не печатает. Настройка открывается из восстановления только после ожидания начатой работы, как любой выход из смены, и возвращает в ту же смену.
- **Следующий короб не закрывается, пока этикетка ждёт**: `closeBox` читает ждущее задание до закрытия (и при входе в экран тоже — поэтому вход больше не проверяет остановку перед `closeBox`). После решённой этикетки закрывается полный короб, оставленный остановкой станции.
- **Проверка до конвейера** не пишет скан в журнал и очередь: другой SSCC и не SSCC — слова под этикеткой и звук ошибки.
- **Закрытие смены (план 2a8) — только при решённых этикетках смены** (`shiftLabelsSettled`), считается запросом, а не чтением строк: ждущее задание, которое эта сборка не читает, тоже держит смену.
- **Настройка рабочего места — один экран**, а не вкладки: на сенсорной панели и при 1024 × 768 разделы друг под другом; переключатели — кнопки 64 px с `aria-pressed`, а не флажки `Checkbox` (меньше 64 px). Сохраняется целиком; «Назад» уходит сразу и называет брошенные изменения. Порт — в поле ввода, список портов — по просьбе (`list_serial_ports` отвечает именами, а не устройствами).
- **Звук** — уровень 0–100 шагами по 10 % и «Без звука»; `playSignalTone` получает уровень третьим аргументом; рабочий экран получает сигнал от `FloorApp`, который перечитывает громкость после сохранения настройки.
- **Пробная этикетка только из ASCII**, со случайным кодом (облачный `makeSetupTestCode`): она не зависит от холста вебвью и не пройдёт сканом старой этикетки; скан, который не код пробной этикетки, не показывается (бейдж — секрет).
- **Запрос «не засыпать»** — удержание с поколением: сброс при запуске забывает прежние удержания, их отпускание ничего не просит; вызовы оболочки идут по порядку.

## Контракт для 2a8 и ПЛ-Ц

**Локальная база (`src-tauri/migrations/0007_floor_printing.sql`).** `floor_print_jobs` — `TableClass::DeviceData`, строки с `host_id`, `device_id`; `workstation_settings` — `TableClass::Workstation` (ключи `printers` — `{ printers, assignments }`, `scanners`, `sound`, `verify_printed_label`; JSON). Состояния задания: `prepared`, `sending`, `sent`, `failed`, `unknown`, `verified`, `skipped`; «ждущее» — `prepared`, `sending`, `failed`, `unknown` и `sent` при `verify = 1` (частичный уникальный индекс `floor_print_jobs_open`: одно ждущее задание на `(host_id, device_id, purpose, subject_id)`); код отказа ровно у `failed` и `unknown`; отправленное — только с байтами. `purpose` — `box` и `pallet` (ПЛ-Ц не пересобирает таблицу).

**Задания (`src/floor/print/print-jobs.ts`).**

```ts
prepareLabelJob(label: NewLabel, settings, pairing, render?): Promise<LocalStatement>
// NewLabel { id; shiftId; purpose: "box" | "pallet"; subjectId; sscc; fields; template: { id; rev; spec }; operatorId; createdAt }
boxLabelStep({ local, pairing, shift, operatorName, newId, render? }): CloseStep
sendLabelJob(context: PrintContext, job: PrintJob, options?: { rebind?: { printer; bytesBase64 }; extra?: LocalStatement[] }): Promise<PrintJob>
readOpenJob(local, pairing, shiftId): Promise<PrintJob | null>
shiftLabelsSettled(local, pairing, shiftId): Promise<boolean>
recoverInterruptedJobs(context): Promise<number>
```

- **План 2a8, закрытие смены:** сводка закрытия недоступна, пока `shiftLabelsSettled(local, pairing, shiftId)` отвечает `false` (экран называет ждущую этикетку и возвращает к рабочему экрану, где её решают); тест 2a8 — ни одна запись `outbox` смены не стоит по `seq` после её `shift_closed` (иначе хост отметит собственную смену станции поздней, ревью задачи 6 плана 2a2).
- **План 2a8, исключение «Перепечатать этикетку»** решённого короба (`sent`, `verified`, `skipped`): новое задание тем же `prepareLabelJob` (поля и шаблон — из задания короба, `readPrintJob`/последнее по `created_at`; принтер — назначение «Короб» сейчас) плюс `floor_exceptions` и `box_exception` `reprint` одной транзакцией, затем `sendLabelJob`; ждущее задание короба перепечатывается не так, а решениями задачи 5 (`printAgain` с причиной). Коды причин — `REPRINT_REASONS`, `DISASSEMBLE_REASONS`, `OTHER_REASON`, `MAX_REASON_TEXT_CHARS` (`src/floor/exception-reasons.ts`, сверены с `proto/fixtures/exception-reasons.json`). «Расформировать короб» ждущее задание этого короба оставляет — его решают (пропуск).
- **План ПЛ-Ц:** шаг закрытия паллеты строит задание тем же `prepareLabelJob` с `purpose: "pallet"`, полями `palletLabelFields` домена и шаблоном паллеты снимка; принтер — `resolvePrinter(settings, "pallet")`; дописывает ветки `pallet` в `labelRecord` и `reprintStatements` (`print-resolution.ts`: `pallet_label`, `pallet_exception` — формы плана ПЛ-Х, Zod — свой); рабочий экран решает этикетку паллеты тем же `settleLabel` и `LabelPanel` (`readOpenJob` уже отдаёт задания любого назначения смены, старшее первым).

**Принтеры (`src/floor/print/print-runtime.ts`).** `createPrintRuntime(printBytes, { limitMs?, startTimer? })` — одна на приложение (`App`); `send(jobId | null, target, bytes): Promise<SendOutcome>` — по очереди на адрес, ответ не позже `PRINT_SEND_LIMIT_MS` (20 с): `answered`, `timeout` (байты у оболочки), `busy` (не дождались очереди, оболочке не отданы); `isInFlight`, `inFlight`. `settleOutcome(outcome)` — состояние задания: `sent` только на `{ sent: true }`.

**Решения (`src/floor/print/print-resolution.ts`).** `checkLabel(context, job, raw)` → `verified` | `not_sscc` | `mismatch`; `skipLabel`; `confirmPrinted` (только `unknown`); `printAgain(context, job, { reason, printer }, settings, template, render?)` — причина обязательна, если этикетка могла выйти; ошибки `NoPrinterError`, `LabelRenderError`, `UnresolvableJobError`, `StaleJobError`. `ResolveContext = PrintContext & { operatorId; newId }`.

**Рабочий экран (`src/floor/work/WorkScreen.tsx`).** `WorkScreenProps` += `printing: PrintRuntime`, `awake: SystemAwake`, `onSetup?: () => void`, `render?: RenderLabel`. `Stop` += `{ kind: "label"; job: PrintJob }`. Каждое закрытие короба идёт с `labelStep`, после `closed` — `settleLabel()` той же работой очереди; `closeBox` не закрывает короб, пока у смены есть ждущее задание. План 2a8 добавляет свои остановки (исключения, сводка закрытия) в тот же `Stop`; перехват скана при ждущей проверке стоит первым в `scan`.

**Настройки (`src/floor/setup/workstation-settings.ts`).** `readWorkstationSettings(local)`, `saveWorkstationSettings(local, settings)`, `resolvePrinter(settings, purpose)` (`box`, `pallet`, `duplicate`), `soundLevel(sound)`, `applySavedScanners(local, configure)`; экран `WorkstationSetup` — из списка смен (`ShiftList.onSetup`) и из восстановления этикетки (`FloorApp`, вид `setup` с возвратом в смену).

**Сон (`src/hardware/awake.ts`).** `createSystemAwake(setSystemAwake)` — одна на приложение; рабочий экран держит `hold()` на время монтирования; `App` при запуске вызывает `reset()`.

**Тексты.** Ключи `floor.print.*`, `floor.setup.*`, `floor.shifts.setup`.

## Заметки для исполнения

**Основа плана**

- 2a7 стоит на коде планов 2a1–2a6 (2a2 — факты `box_label` и `box_exception` и фикстура `exception-reasons.json`; 2a4 — `src/hardware/hardware.ts`, `print_bytes`, `set_system_awake`, сканеры; 2a5 — миграция `0006`, `FloorApp`, снимок; 2a6 — `box-close.ts` с `CloseStep`, `WorkScreen.tsx`, `facts.ts`, `test/support/floor-work.ts`). Перед задачей 1 убедиться, что `git log --oneline` содержит их коммиты, а `apps/standalone/src/floor/work/box-close.ts`, `apps/standalone/proto/fixtures/exception-reasons.json` и `apps/standalone/src-tauri/migrations/0006_floor_production.sql` есть; если чего-то нет — остановиться и назвать это в отчёте.
- Фрагменты построены сценарием на копии репозитория: ветка `p2a7-scratch` — копия планировщика 2a6 (`p2a6-scratch`, `782ec34ae`: `claude/2a4-shell` на `939a2c8dc`, влитые основная ветка и `claude/2a3-office`, план 2a2 из дерева `c875f9ded`, задачи 5–9 плана 2a4 и планы 2a5 и 2a6, применённые по тексту), в которой задачи 5–9 плана 2a4 заменены исполненными (`claude/2a4-shell` на `ce6511b3b`, вместе с волной итогового ревью; `tests/local_db.rs` и `tests/ipc.rs` — в виде, который им оставил план 2a5, с исправленными импортами). Ветка `claude/2a2-facts` (`407a3cae4`) исполнена не целиком (нет `box_label`, `box_exception`, `shift_closed`), поэтому 2a2 — по тексту плана. Задача за задачей план применён к этой копии, и каждая команда ниже запущена на ней; затем текст плана разобран сценарием и применён к чистой копии основы — деревья совпали побайтно. Настоящее дерево будет другим (исполненные 2a2, 2a5, 2a6): фрагмент, который из-за этого не находится, применяется к тому же месту по смыслу, а расхождение записывается в «Отклонения при исполнении». Номер раздела спецификации задачи 9 — следующий свободный.

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, с отступами; на свою очередь он встречается в файле ровно один раз. Фрагменты одной правки идут сверху вниз по файлу и применяются по порядку. Шаг 1 (тесты) применяется раньше шага 3 (реализация).
- «Создать» — новый файл, ровно как в блоке.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках отформатирован prettier и `cargo fmt`: расхождение при проверке значит опечатку.
- Русский текст в коде и в `ru.json` — буквами. Каждая задача с вебвью кончается `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное совпадение — `src/host/pairing-code.ts:66`. Разделитель групп GS1 в тестах пишется `\u001d`.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие защиты. Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из шага (у мутации из двух фрагментов — оба, по порядку); команда — ожидаемый FAIL с названным тестом; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить. Мутация миграции `0007` проверяется Vitest (он читает каталог миграций при каждом запуске), мутация `local_db.rs` — `cargo test`.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON, CSS и MD (SQL prettier не форматирует); `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `run lint`; Rust (задача 1) — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`.

**pnpm, git, Cargo и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. Команды — из корня репозитория, без `cd`. Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата; если обёртка `rtk` урезала вывод, `rtk proxy <команда>`.
- В свежем worktree сначала: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`, а перед Cargo — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (оболочка встраивает `apps/standalone/dist`).
- Cargo — с `--offline --locked`. В песочнице проходят библиотека оболочки и `--test local_db`; `--test ipc` открывает сокет на loopback и идёт вне песочницы. На копии плана `ipc` падает в одном тесте — `forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays` (3 файла отложены вместо 2) — и до плана, и после: это артефакт копии (`tests/ipc.rs` плана 2a5 рядом с исполненным `local_db.rs` плана 2a4, который при подсчёте неотправленного в испорченной базе создаёт `-shm`); на настоящем дереве у `ipc.rs` свой вид, тест должен проходить.
- React 19.2 запускает пассивные эффекты задачей планировщика (`setImmediate`), а `waitFor` после успеха ждёт `setTimeout(0)`: утверждение сразу после ожидания, которое зависит от следующего эффекта или рендера, — скрытый флейк. Поэтому тесты рабочего экрана сканируют и нажимают внутри одного асинхронного `act`, который дожидается ворот работы (`scan`, `press`), ждут подписки сканера (`listening()`), а состояние, которое читает обработчик скана, хранится в ref при каждой установке, а не эффектом (это нашёл стенд у пробной печати настройки). Новые и изменённые тестовые файлы с React (задачи 2, 6–8) один раз запускаются с `--reporter=verbose` (в выводе нет `stderr |`) и один раз под стендом с задержкой `setImmediate` на 3 мс — два временных файла внутри пакета, удалить сразу после прогона, до `lint`:

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

- Под сильной нагрузкой машины полный прогон Vitest роняет тайм-аутом 5 с старые тесты офиса, которых план не трогает (`shifts-page`, `template-editor` и подобные): на копии плана при средней загрузке 65–120 таких было от 5 до 16, а `template-editor` падал и отдельным прогоном, как и на основе плана без его изменений. Это не дефект плана; падение в полном прогоне записывается и разбирается (сверка с основой, отдельный прогон), а не лечится повтором.

**Счёт тестов** (измерено на копии плана; на настоящем дереве числа сдвигаются на тесты, которых на копии нет)

- До плана: Vitest — 97 файлов, 2428 тестов; оболочка — библиотека 134, `local_db` 16, `ipc` 19.
- После задач: 1 — 98, 2433; 2 — 99, 2447; 3 — 100, 2453; 4 — 102, 2476; 5 — 103, 2491; 6 — 105, 2511; 7 — 106, 2524; 8 — 106, 2530; 9 — без изменений. Оболочка: числа те же во всех задачах (задача 1 меняет тесты, а не их число).
- После: Vitest — 106 файлов, 2530 тестов.

## Файлы

Задачи выполняются по порядку: 1 — схема, 2 — настройки, 3 — этикетка, 4–5 — задания и решения по ним, 6 — рабочий экран, который их собирает, 7–8 — экран настройки, 9 — документы. Задачи 2–3 от задач 4–6 не зависят и могут идти параллельно с остатком плана 2a6 (спецификация пилота §12.2).

<!-- prettier-ignore -->
```text
apps/standalone/src-tauri/migrations/0007_floor_printing.sql (новый),
apps/standalone/src-tauri/src/local_db.rs, src-tauri/tests/{local_db,ipc}.rs,
apps/standalone/test/{floor-print-schema (новый),floor-schema,local-executor}.test.ts   задача 1
apps/standalone/src/floor/setup/workstation-settings.ts (новый), src/app/App.tsx,
apps/standalone/src/floor/work/signal-sound.ts, test/support/hardware.ts (новый),
apps/standalone/test/{workstation-settings (новый),signal-sound}.test.ts, test/app.test.tsx  задача 2
apps/standalone/src/floor/print/{label-render,label-emitters}.ts (новые), src/labels/rasterizer.ts,
apps/standalone/test/{floor-label-render (новый),label-raster}.test.ts, test/support/printing.ts (новый)  задача 3
apps/standalone/src/floor/print/{print-runtime,print-jobs}.ts (новые),
apps/standalone/test/floor-print-{runtime,jobs}.test.ts (новые), test/support/printing.ts  задача 4
apps/standalone/src/floor/exception-reasons.ts, src/floor/print/print-resolution.ts (новые),
apps/standalone/test/floor-print-resolution.test.ts (новый), test/support/printing.ts  задача 5
apps/standalone/src/hardware/awake.ts, src/floor/print/LabelPanel.tsx (новые),
apps/standalone/src/floor/work/WorkScreen.tsx, src/floor/FloorApp.tsx, src/app/{App.tsx,shell.css},
apps/standalone/src/i18n/ru.json, test/{awake.test.ts,floor-work-print.test.tsx} (новые),
apps/standalone/test/{app,floor-app,floor-work-screen}.test.tsx                        задача 6
apps/standalone/src/floor/setup/{WorkstationSetup.tsx,printer-draft.ts,test-label.ts} (новые),
apps/standalone/src/floor/{FloorApp.tsx,shifts/ShiftList.tsx}, src/app/{App.tsx,shell.css},
apps/standalone/src/i18n/ru.json, test/floor-setup.test.tsx (новый), test/floor-app.test.tsx  задача 7
apps/standalone/src/floor/setup/WorkstationSetup.tsx, src/floor/FloorApp.tsx, src/i18n/ru.json,
apps/standalone/test/{floor-setup,floor-app}.test.tsx                                    задача 8
apps/standalone/AGENTS.md, спецификация этапа (раздел «Уточнения плана 2a7»)             задача 9
```

---

### Task 1: Локальная миграция `0007` — задания печати и настройки рабочего места, их классы

Миграция `0007_floor_printing.sql` (§5.3 спецификации, решение 19): `floor_print_jobs` — данные устройства, каждая строка с подключением; `purpose` (`box`, `pallet`) и `subject_id` вместо `box_id`, чтобы план паллет ПЛ-Ц не пересобирал таблицу ради `CHECK` (спецификация пилота §6.2 предлагала отдельную миграцию с копированием); задание хранит SSCC своей этикетки, шаблон снимка (идентификатор и ревизию), поля этикетки (рендер для другого принтера), снимок профиля принтера, байты base64 (`local_query` не читает BLOB), код отказа, число попыток, `verify` — настройку проверки этикетки на момент задания. Правила схемы: байты только с принтером; отправленное (`sending`, `sent`, `unknown`, `verified`) — только с байтами; код отказа ровно у `failed` и `unknown`; у `prepared` нет попыток; `verified` — только при `verify = 1`; частичный уникальный индекс — одно ждущее задание на этикетку подключения. `workstation_settings` — настройки ПК (класс `Workstation`, единственная таблица класса): ключ и JSON. Оба названия — в `TABLE_CLASSES` той же правкой (правило плана 2a4).

**Files:**

- Create: `apps/standalone/src-tauri/migrations/0007_floor_printing.sql`
- Modify: `apps/standalone/src-tauri/src/local_db.rs`
- Test: `apps/standalone/test/floor-print-schema.test.ts` (Create), `apps/standalone/src-tauri/tests/ipc.rs` (Modify), `apps/standalone/src-tauri/tests/local_db.rs` (Modify), `apps/standalone/test/floor-schema.test.ts` (Modify), `apps/standalone/test/local-executor.test.ts` (Modify)

**Interfaces:**

- Consumes: `TABLE_CLASSES`, `TableClass` (`src-tauri/src/local_db.rs`, план 2a4); тесты классов `tests/local_db.rs` и `tests/ipc.rs`; `test/floor-schema.test.ts` (`DEVICE_TABLES`, план 2a5); миграция `0006`.
- Produces:
  - `src-tauri/migrations/0007_floor_printing.sql`: `floor_print_jobs (id, host_id, device_id, shift_id, purpose, subject_id, sscc, state, verify, template_id, template_rev, fields, printer, bytes_base64, error_code, attempts, operator_id, created_at, updated_at)`, индекс `floor_print_jobs_open` (одно ждущее задание на `(host_id, device_id, purpose, subject_id)`), `floor_print_jobs_shift`; `workstation_settings (key, value)`;
  - `TABLE_CLASSES`: `("floor_print_jobs", TableClass::DeviceData)`, `("workstation_settings", TableClass::Workstation)`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/src-tauri/tests/ipc.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
    assert_eq!(
        TABLE_CLASSES.last(),
        Some(&("sync_state", TableClass::Disposable))
```

заменить на:

<!-- prettier-ignore -->
```rust
    assert_eq!(
        TABLE_CLASSES
            .iter()
            .filter(|(_, class)| *class == TableClass::Disposable)
            .last(),
        Some(&("sync_state", TableClass::Disposable))
```

Правка `apps/standalone/src-tauri/tests/local_db.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
            "floor_boxes",
            "floor_codes",
            "floor_exceptions",
            "floor_scans",
            "floor_shifts",
            "floor_sign_in_failures",
```

заменить на:

<!-- prettier-ignore -->
```rust
            "floor_boxes",
            "floor_codes",
            "floor_exceptions",
            "floor_print_jobs",
            "floor_scans",
            "floor_shifts",
            "floor_sign_in_failures",
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
            "sync_quarantine",
            "sync_state"
        ]
```

заменить на:

<!-- prettier-ignore -->
```rust
            "sync_quarantine",
            "sync_state",
            "workstation_settings"
        ]
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
    );
    // This device's own records are the production tables of `0006`; the
    // sign-in lockouts stay with the copies (an open owner question).
    let device_data: Vec<&str> = TABLE_CLASSES
```

заменить на:

<!-- prettier-ignore -->
```rust
    );
    // This device's own records are the production tables of `0006` and the
    // print jobs of `0007`; the sign-in lockouts stay with the copies (an
    // open owner question); the workstation's settings belong to the PC.
    let device_data: Vec<&str> = TABLE_CLASSES
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
            "floor_exceptions",
            "floor_scans",
```

заменить на:

<!-- prettier-ignore -->
```rust
            "floor_exceptions",
            "floor_print_jobs",
            "floor_scans",
```

Фрагмент 5:

<!-- prettier-ignore -->
```rust
        Some(TableClass::Disposable)
    );
```

заменить на:

<!-- prettier-ignore -->
```rust
        Some(TableClass::Disposable)
    );
    assert_eq!(
        table_class("workstation_settings"),
        Some(TableClass::Workstation)
    );
```

Фрагмент 6:

<!-- prettier-ignore -->
```rust
/// Forgetting the device (`device_forget`) empties every disposable table and
/// nothing else: a table outside that class (here two a later migration might
/// add, one of this device's records and one of the workstation's settings)
/// keeps its rows, and so does sqlx's migration journal.
#[tokio::test]
async fn clearing_the_copies_empties_the_disposable_tables_and_nothing_else() {
    let (dir, db) = open().await;
    db.transaction(vec![
```

заменить на:

<!-- prettier-ignore -->
```rust
/// Forgetting the device (`device_forget`) empties every disposable table and
/// nothing else: every table outside that class (this device's records and
/// the workstation's settings) keeps its rows, and so does sqlx's migration
/// journal.
#[tokio::test]
async fn clearing_the_copies_empties_the_disposable_tables_and_nothing_else() {
    let (_dir, db) = open().await;
    db.transaction(vec![
```

Фрагмент 7:

<!-- prettier-ignore -->
```rust
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
```

заменить на:

<!-- prettier-ignore -->
```rust
    .unwrap();
    // One record in each table of this device's own (`0006`, `0007`) and
    // one setting of the workstation (`0007`).
    db.transaction(device_records()).await.unwrap();
    db.transaction(vec![statement(
        "INSERT INTO workstation_settings (key, value) VALUES ('printers', '{}')",
        json!([]),
    )])
    .await
    .unwrap();
    let journal = "SELECT count(*) AS n FROM _sqlx_migrations";
```

Фрагмент 8:

<!-- prettier-ignore -->
```rust
    }
    let kept = db
        .query(
            "SELECT count(*) AS n FROM kept_workstation_settings",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(Value::Object(kept[0].clone()), json!({ "n": 1 }));
    assert_eq!(db.query(journal, vec![]).await.unwrap(), migrations);
```

заменить на:

<!-- prettier-ignore -->
```rust
    }
    assert_eq!(db.query(journal, vec![]).await.unwrap(), migrations);
```

Фрагмент 9:

<!-- prettier-ignore -->
```rust
const OTHER_DEVICE: &str = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";

/// Runs `statements` on a raw connection, as a later migration would: the
/// webview may not create tables.
async fn run_raw(dir: &std::path::Path, statements: &[&str]) {
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    for sql in statements {
        sqlx::query(sql).execute(&mut raw).await.unwrap();
    }
    raw.close().await.unwrap();
}

/// An outbox record of the pairing `(host, device)`, acknowledged at `acked`
```

заменить на:

<!-- prettier-ignore -->
```rust
const OTHER_DEVICE: &str = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";

/// An outbox record of the pairing `(host, device)`, acknowledged at `acked`
```

Фрагмент 10:

<!-- prettier-ignore -->
```rust
             '2026-10-08T06:04:00.000Z')",
            json!([HOST, DEVICE]),
```

заменить на:

<!-- prettier-ignore -->
```rust
             '2026-10-08T06:04:00.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_print_jobs (id, host_id, device_id, shift_id, purpose, \
             subject_id, sscc, state, verify, template_id, template_rev, fields, operator_id, \
             created_at, updated_at) VALUES ('job-1', ?, ?, 'shift-1', 'box', 'box-1', \
             '046006820000000017', 'skipped', 0, 'template-1', 3, '{}', 'operator-1', \
             '2026-10-08T06:04:00.000Z', '2026-10-08T06:04:00.000Z')",
            json!([HOST, DEVICE]),
```

Создать `apps/standalone/test/floor-print-schema.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import type { LocalExecutor, LocalStatement } from "../src/local/executor.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const AT = "2026-10-09T08:00:00.000Z";
const SSCC = "046006820000035007";
const PRINTER = JSON.stringify({ id: "p1", name: "Zebra" });

function job(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  const row: Record<string, unknown> = {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: "shift-1",
    purpose: "box",
    subject_id: `box-${id}`,
    sscc: SSCC,
    state: "prepared",
    verify: 0,
    template_id: "template-1",
    template_rev: 3,
    fields: "{}",
    printer: PRINTER,
    bytes_base64: "XlhB",
    operator_id: "operator-1",
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO floor_print_jobs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

function setting(key: string, value: string): LocalStatement {
  return {
    sql: "INSERT INTO workstation_settings (key, value) VALUES (?, ?)",
    values: [key, value],
  };
}

async function refused(local: LocalExecutor, statement: LocalStatement): Promise<void> {
  await expect(local.transaction([statement])).rejects.toMatchObject({ code: "statement_failed" });
}

async function accepted(local: LocalExecutor, statement: LocalStatement): Promise<void> {
  await expect(local.transaction([statement])).resolves.toEqual([1]);
}

describe("the station's print jobs (migration 0007)", () => {
  it("name what the label is for: a box, or a pallet of the pallets' plan, and nothing else", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, job("box"));
    await accepted(executor, job("pallet", { purpose: "pallet" }));
    await refused(executor, job("duplicate", { purpose: "duplicate" }));
    await refused(executor, job("short", { sscc: "04600682000003500" }));
    await refused(executor, job("letters", { sscc: "04600682000003500X" }));
  });

  it("keep a reason exactly for a failed or unknown job, and bytes for every job that went to a printer", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, job("failed", { state: "failed", error_code: "not_sent" }));
    await accepted(
      executor,
      job("unconfigured", {
        state: "failed",
        error_code: "printer_unconfigured",
        printer: null,
        bytes_base64: null,
      }),
    );
    await accepted(
      executor,
      job("unknown", { state: "unknown", error_code: "outcome_unknown", attempts: 1 }),
    );
    await refused(executor, job("failed-silent", { state: "failed" }));
    await refused(executor, job("sent-with-reason", { state: "sent", error_code: "not_sent" }));
    await refused(executor, job("prepared-with-reason", { error_code: "render_failed" }));
    for (const state of ["sending", "sent", "unknown", "verified"]) {
      await refused(
        executor,
        job(`no-bytes-${state}`, {
          state,
          verify: 1,
          attempts: 1,
          bytes_base64: null,
          error_code: state === "unknown" ? "timeout" : null,
        }),
      );
    }
    await refused(executor, job("bytes-without-printer", { printer: null }));
    await refused(executor, job("empty-bytes", { bytes_base64: "" }));
  });

  it("count no attempt before a job's first send, and verify only a job that asked for the check", async () => {
    const { executor } = openLocalDb();
    await refused(executor, job("prepared-sent-once", { attempts: 1 }));
    await accepted(executor, job("verified", { state: "verified", verify: 1, attempts: 1 }));
    await refused(executor, job("verified-unasked", { state: "verified", verify: 0, attempts: 1 }));
    await refused(executor, job("bad-state", { state: "printed" }));
    await refused(executor, job("bad-verify", { verify: 2 }));
    await refused(executor, job("bad-json", { fields: "{" }));
  });

  it("let one label wait at a time, and any number be done with", async () => {
    const { executor } = openLocalDb();
    const box = { subject_id: "box-1" };
    await accepted(executor, job("first", box));
    // A second open job of the same box, whatever open state it is in.
    await refused(executor, job("again-prepared", box));
    await refused(
      executor,
      job("again-failed", { ...box, state: "failed", error_code: "not_sent" }),
    );
    await refused(
      executor,
      job("again-awaiting", { ...box, state: "sent", verify: 1, attempts: 1 }),
    );
    // Done with: sent without a check, verified, skipped.
    await accepted(executor, job("sent", { ...box, state: "sent", attempts: 1 }));
    await accepted(
      executor,
      job("verified", { ...box, state: "verified", verify: 1, attempts: 1 }),
    );
    await accepted(executor, job("skipped", { ...box, state: "skipped" }));
    // Another box, another purpose, another pairing: each has its own.
    await accepted(executor, job("box-2", { subject_id: "box-2" }));
    await accepted(executor, job("pallet-1", { ...box, purpose: "pallet" }));
    await accepted(executor, job("other-device", { ...box, device_id: OTHER_DEVICE }));
  });
});

describe("the workstation's settings (migration 0007)", () => {
  it("keep one JSON value per key and belong to no pairing", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, setting("printers", "{}"));
    await refused(executor, setting("printers", "[]"));
    await refused(executor, setting("sound", "{"));
    await expect(
      executor.transaction([
        {
          sql: "INSERT INTO workstation_settings (key, value, host_id) VALUES ('a', '1', 'h')",
        },
      ]),
    ).rejects.toMatchObject({ code: "statement_failed" });
  });
});
```

Правка `apps/standalone/test/floor-schema.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
const AT = "2026-10-09T08:00:00.000Z";

/** The tables of this device's own records (migration `0006`, `TableClass::DeviceData`). */
const DEVICE_TABLES = [
```

заменить на:

<!-- prettier-ignore -->
```ts
const AT = "2026-10-09T08:00:00.000Z";

/** The tables of this device's own records (migrations `0006`, `0007`; `TableClass::DeviceData`). */
const DEVICE_TABLES = [
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  "floor_exceptions",
  "floor_scans",
```

заменить на:

<!-- prettier-ignore -->
```ts
  "floor_exceptions",
  "floor_print_jobs",
  "floor_scans",
```

Правка `apps/standalone/test/local-executor.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
      "floor_exceptions",
      "floor_scans",
```

заменить на:

<!-- prettier-ignore -->
```ts
      "floor_exceptions",
      "floor_print_jobs",
      "floor_scans",
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
      "sync_state",
    ]);
```

заменить на:

<!-- prettier-ignore -->
```ts
      "sync_state",
      "workstation_settings",
    ]);
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-schema.test.ts test/floor-schema.test.ts test/local-executor.test.ts`
Expected: FAIL — `test/floor-print-schema.test.ts`: 5 из 5 (`no such table: floor_print_jobs`); `test/floor-schema.test.ts` — «tag every row with its pairing and have no foreign key»; `test/local-executor.test.ts` — «has exactly the shell's tables».

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`
Expected: FAIL — `every_table_has_a_forget_class`, `clearing_the_copies_empties_the_disposable_tables_and_nothing_else`, `opening_creates_the_reference_tables_in_wal_mode_and_keeps_data` (миграции `0007` ещё нет).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src-tauri/migrations/0007_floor_printing.sql`:

<!-- prettier-ignore -->
```sql
-- The station's printing (stage 2a spec §5.3 and §5.7.5, plan 2a7): the print
-- jobs of the labels it printed and this computer's workstation settings.
--
-- `floor_print_jobs` is this device's data (`TableClass::DeviceData`): every
-- row carries the pairing it was written under, and a forget keeps it. A job
-- is written in the transaction that closes its box, with the label's bytes
-- (base64 text: `local_query` reads no BLOB) and the snapshot of the printer
-- profile they were rendered for, and then walks:
--
--   prepared -> sending -> sent [-> verified | skipped]
--                       -> failed  (nothing left this computer)
--                       -> unknown (a label may exist: never sent again
--                                   without the operator's decision)
--
-- `sending` is written before the bytes go to the shell, so a job found in
-- `sending` after a restart is `unknown`. `purpose` and `subject_id` name what
-- the label is for — a box today, a pallet with the pallets' plan (ПЛ-Ц) —
-- so that plan adds no rebuild of this table. `verify` is the workstation's
-- «check the printed label» setting at the time the job was made: a `sent`
-- job with `verify = 1` still waits for the scan of its label.
--
-- `workstation_settings` belongs to the computer, not to a pairing
-- (`TableClass::Workstation`): printers and their purposes, COM scanners,
-- sound and the label check outlive a forget. One JSON value per key.
--
-- No foreign keys (see `0006`). Times are UTC RFC 3339 text as
-- `Date.toISOString` writes it.

CREATE TABLE floor_print_jobs (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('box', 'pallet')),
  subject_id TEXT NOT NULL,
  sscc TEXT NOT NULL CHECK (length(sscc) = 18 AND sscc NOT GLOB '*[^0-9]*'),
  state TEXT NOT NULL CHECK (state IN
    ('prepared', 'sending', 'sent', 'failed', 'unknown', 'verified', 'skipped')),
  verify INTEGER NOT NULL CHECK (verify IN (0, 1)),
  template_id TEXT NOT NULL,
  template_rev INTEGER NOT NULL CHECK (template_rev >= 0),
  fields TEXT NOT NULL CHECK (json_valid(fields)),
  printer TEXT CHECK (printer IS NULL OR json_valid(printer)),
  bytes_base64 TEXT CHECK (bytes_base64 IS NULL OR length(bytes_base64) > 0),
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  operator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Bytes are always rendered for a printer.
  CHECK (bytes_base64 IS NULL OR printer IS NOT NULL),
  -- Only a job with bytes can have gone to a printer.
  CHECK (state NOT IN ('sending', 'sent', 'unknown', 'verified') OR bytes_base64 IS NOT NULL),
  -- A reason exactly for a failed or unknown job.
  CHECK ((error_code IS NOT NULL) = (state IN ('failed', 'unknown'))),
  -- A prepared job has never been sent.
  CHECK (state <> 'prepared' OR attempts = 0),
  -- Verified only where the check was asked.
  CHECK (state <> 'verified' OR verify = 1)
);

-- At most one job of a label waits for the operator or the printer: the
-- next box does not close while one does, and a reprint of plan 2a8 cannot
-- start a second.
CREATE UNIQUE INDEX floor_print_jobs_open
  ON floor_print_jobs (host_id, device_id, purpose, subject_id)
  WHERE state IN ('prepared', 'sending', 'failed', 'unknown')
    OR (state = 'sent' AND verify = 1);

CREATE INDEX floor_print_jobs_shift ON floor_print_jobs (host_id, device_id, shift_id);

CREATE TABLE workstation_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);
```

Правка `apps/standalone/src-tauri/src/local_db.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
    ("floor_exceptions", TableClass::DeviceData),
    ("floor_scans", TableClass::DeviceData),
```

заменить на:

<!-- prettier-ignore -->
```rust
    ("floor_exceptions", TableClass::DeviceData),
    ("floor_print_jobs", TableClass::DeviceData),
    ("floor_scans", TableClass::DeviceData),
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
    ("sync_state", TableClass::Disposable),
];
```

заменить на:

<!-- prettier-ignore -->
```rust
    ("sync_state", TableClass::Disposable),
    ("workstation_settings", TableClass::Workstation),
];
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-schema.test.ts test/floor-schema.test.ts test/local-executor.test.ts`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  69 passed (69)`.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib --test local_db`
Expected: PASS — библиотека `134 passed`, `local_db` `16 passed` (на настоящем дереве — числа его библиотеки).

Run (вне песочницы: сокет на loopback): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc`
Expected: PASS на настоящем дереве; на копии плана `18 passed; 1 failed` — тот же тест, что падает и до плана (`forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays`, артефакт копии, «Заметки для исполнения»).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  98 passed (98)`, `Tests  2433 passed (2433)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — задание без байтов в состоянии, где оно уже ушло на принтер.
В `apps/standalone/src-tauri/migrations/0007_floor_printing.sql` удалить фрагмент

<!-- prettier-ignore -->
```sql
  CHECK (state NOT IN ('sending', 'sent', 'unknown', 'verified') OR bytes_base64 IS NOT NULL),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-schema.test.ts`
Expected: FAIL — «keep a reason exactly for a failed or unknown job, and bytes for every job that went to a printer».

М2 — ждущая проверки этикетка не считается ждущей (второе задание того же короба проходит).
В `apps/standalone/src-tauri/migrations/0007_floor_printing.sql` фрагмент

<!-- prettier-ignore -->
```sql
  WHERE state IN ('prepared', 'sending', 'failed', 'unknown')
    OR (state = 'sent' AND verify = 1);
```

заменить на:

<!-- prettier-ignore -->
```sql
  WHERE state IN ('prepared', 'sending', 'failed', 'unknown');
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-schema.test.ts`
Expected: FAIL — «let one label wait at a time, and any number be done with».

М3 — назначение задания только `box` — план ПЛ-Ц пересобирал бы таблицу.
В `apps/standalone/src-tauri/migrations/0007_floor_printing.sql` фрагмент

<!-- prettier-ignore -->
```sql
  purpose TEXT NOT NULL CHECK (purpose IN ('box', 'pallet')),
```

заменить на:

<!-- prettier-ignore -->
```sql
  purpose TEXT NOT NULL CHECK (purpose IN ('box')),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-schema.test.ts`
Expected: FAIL — «name what the label is for: a box, or a pallet of the pallets' plan, and nothing else», «let one label wait at a time, and any number be done with».

М4 — настройки рабочего места стираются «забыванием». В `apps/standalone/src-tauri/src/local_db.rs` фрагмент

<!-- prettier-ignore -->
```rust
    ("workstation_settings", TableClass::Workstation),
```

заменить на:

<!-- prettier-ignore -->
```rust
    ("workstation_settings", TableClass::Disposable),
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`
Expected: FAIL — `every_table_has_a_forget_class`.

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/test/floor-print-schema.test.ts apps/standalone/test/floor-schema.test.ts apps/standalone/test/local-executor.test.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src-tauri/migrations/0007_floor_printing.sql apps/standalone/src-tauri/src/local_db.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/src-tauri/tests/local_db.rs apps/standalone/test/floor-print-schema.test.ts apps/standalone/test/floor-schema.test.ts apps/standalone/test/local-executor.test.ts
git commit -m "feat(standalone): migration 0007, the station's print jobs and the workstation's settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Настройки рабочего места — модель, чтение и запись, сканеры при запуске, громкость сигналов

`src/floor/setup/workstation-settings.ts` — модель настроек (§5.7.8, решение 23): профили принтеров `{ id, name, target, language, dpi }` (облачная маршрутизация `printer-routing.ts`: профиль на адрес, назначение по профилю), назначения `box`, `pallet`, `duplicate` (хранятся с 2a, печатается только `box`), COM-сканеры, звук `{ muted, volume }`, проверка этикетки (по умолчанию выключена, как `DEFAULT_HARDWARE_CONFIG` облака). Каждый ключ `workstation_settings` читается отдельно: испорченное значение — умолчание только этого ключа; нечитаемая база — отказ, не умолчания поверх неё. Запись — одна транзакция четырёх ключей, и записывается только то, что прочитается так же (`InvalidSettingsError` иначе). `applySavedScanners` отдаёт оболочке сохранённые сканеры при запуске (`App`); отказ — ответ `false`, без исключения. `playSignalTone` получает уровень громкости (0 — тишина, ничего не играет).

**Files:**

- Create: `apps/standalone/src/floor/setup/workstation-settings.ts`
- Modify: `apps/standalone/src/app/App.tsx`, `apps/standalone/src/floor/work/signal-sound.ts`
- Test: `apps/standalone/test/support/hardware.ts` (Create), `apps/standalone/test/workstation-settings.test.ts` (Create), `apps/standalone/test/app.test.tsx` (Modify), `apps/standalone/test/signal-sound.test.ts` (Modify)

**Interfaces:**

- Consumes: `PrintTarget`, `ScannerConfig`, `HardwareApi.configureScanners` (`src/hardware/hardware.ts`, план 2a4); таблица `workstation_settings` (задача 1); `LocalExecutor`, `LocalStatement`.
- Produces:
  - `src/floor/setup/workstation-settings.ts`: `PRINT_PURPOSES`, `type PrintPurpose`, `PRINTER_LANGUAGES`, `type PrinterLanguage`, `PRINTER_DPIS`, `type PrinterDpi`, `interface PrinterProfile { id; name; target; language; dpi }`, `interface SoundSettings { muted; volume }`, `interface WorkstationSettings { printers; assignments; scanners; sound; verifyPrintedLabel }`, `DEFAULT_SOUND`, `DEFAULT_WORKSTATION_SETTINGS`, `SETTING_KEYS`, `canonicalPort`, `parsePrintTarget`, `printerTargetKey`, `parsePrinterProfile`, `parsePrinters`, `parseScanners`, `parseSound`, `soundLevel`, `readWorkstationSettings(local)`, `class InvalidSettingsError`, `saveWorkstationSettings(local, settings)`, `resolvePrinter(settings, purpose)`, `applySavedScanners(local, configure)`;
  - `src/floor/work/signal-sound.ts`: `playSignalTone(tone, context?, level = 1)`;
  - `test/support/hardware.ts`: `fakeHardware(answer?)` — `{ hardware, sends, holdSends, heldSends, releaseSend, scannerStatus }`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/app.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import type { HardwareApi } from "../src/hardware/hardware.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import {
  DEFAULT_WORKSTATION_SETTINGS,
  saveWorkstationSettings,
} from "../src/floor/setup/workstation-settings.js";
import type { HardwareApi } from "../src/hardware/hardware.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
import { km } from "./support/floor-work.js";
import { completeWizard, EXPECTED_REQUEST } from "./support/wizard.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { km } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { completeWizard, EXPECTED_REQUEST } from "./support/wizard.js";
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

  it("gives the shell the COM scanners of the workstation's settings when it starts", async () => {
    const { executor } = openLocalDb();
    await saveWorkstationSettings(executor, {
      ...DEFAULT_WORKSTATION_SETTINGS,
      scanners: [{ port: "COM3", baud: 9600 }],
    });
    const { hardware } = fakeHardware();
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      local: executor,
      hardware,
    });
    await waitFor(() =>
      expect(hardware.configureScanners).toHaveBeenCalledWith([{ port: "COM3", baud: 9600 }]),
    );
  });

  it("starts the wait again on a touch of the screen, not only on a key", async () => {
```

Правка `apps/standalone/test/signal-sound.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  };
  return { audio, oscillator, frequency };
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  };
  return { audio, oscillator, frequency, gain };
}
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  });

  it("is silent, and throws nothing, without sound", () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
  });

  it("plays at the workstation's level, and not at all when muted", () => {
    const quiet = fakeAudio();
    playSignalTone("ok", () => quiet.audio as unknown as AudioContext, 0.4);
    expect(quiet.gain.gain.setValueAtTime).toHaveBeenCalledWith(0.4, 10);
    const full = fakeAudio();
    playSignalTone("ok", () => full.audio as unknown as AudioContext);
    expect(full.gain.gain.setValueAtTime).toHaveBeenCalledWith(1, 10);
    const muted = fakeAudio();
    const asked = vi.fn(() => muted.audio as unknown as AudioContext);
    playSignalTone("error", asked, 0);
    expect(asked).not.toHaveBeenCalled();
    expect(muted.oscillator.start).not.toHaveBeenCalled();
  });

  it("is silent, and throws nothing, without sound", () => {
```

Создать `apps/standalone/test/support/hardware.ts`:

<!-- prettier-ignore -->
```ts
import { vi } from "vitest";

import type {
  HardwareApi,
  PrintResult,
  PrintTarget,
  ScannerSnapshot,
} from "../../src/hardware/hardware.js";

/** One send the fake printer took: where, and the bytes as text (labels are latin1). */
export interface FakeSend {
  target: PrintTarget;
  text: string;
}

/**
 * The shell's hardware for tests: every send is recorded and answered by
 * `answer` (`{ sent: true }` by default); `holdSends()` keeps the next sends
 * waiting until `releaseSend(result)` — the printer that does not answer yet.
 * Scanners and power are plain mocks.
 */
export function fakeHardware(answer: () => Promise<PrintResult> = async () => ({ sent: true })) {
  const sends: FakeSend[] = [];
  const held: ((result: PrintResult) => void)[] = [];
  let holding = false;
  let snapshotListener: ((snapshot: ScannerSnapshot) => void) | null = null;
  const hardware: HardwareApi = {
    printBytes: vi.fn<HardwareApi["printBytes"]>(async (target, bytes) => {
      let text = "";
      for (const byte of bytes) text += String.fromCharCode(byte);
      sends.push({ target, text });
      if (holding) {
        return new Promise<PrintResult>((resolve) => {
          held.push(resolve);
        });
      }
      return answer();
    }),
    listUsbPrinters: vi.fn<HardwareApi["listUsbPrinters"]>(async () => []),
    listSerialPorts: vi.fn<HardwareApi["listSerialPorts"]>(async () => []),
    configureScanners: vi.fn<HardwareApi["configureScanners"]>(async () => undefined),
    closeScanners: vi.fn<HardwareApi["closeScanners"]>(async () => undefined),
    watchScanners: vi.fn<HardwareApi["watchScanners"]>(async (onSnapshot) => {
      snapshotListener = onSnapshot;
      onSnapshot({ revision: 0, scanners: [] });
      return () => {
        snapshotListener = null;
      };
    }),
    onScan: vi.fn<HardwareApi["onScan"]>(async () => () => undefined),
    setSystemAwake: vi.fn<HardwareApi["setSystemAwake"]>(async () => undefined),
  };
  return {
    hardware,
    sends,
    /** The next sends wait until `releaseSend`. */
    holdSends: () => {
      holding = true;
    },
    /** How many sends wait for an answer. */
    heldSends: () => held.length,
    /** Answers the oldest waiting send; later sends are answered by `answer` again once none wait. */
    releaseSend: (result: PrintResult) => {
      const resolve = held.shift();
      if (held.length === 0) holding = false;
      resolve?.(result);
    },
    /** Tells the watcher of the scanners a new snapshot. */
    scannerStatus: (snapshot: ScannerSnapshot) => snapshotListener?.(snapshot),
  };
}
```

Создать `apps/standalone/test/workstation-settings.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import {
  applySavedScanners,
  DEFAULT_WORKSTATION_SETTINGS,
  InvalidSettingsError,
  parsePrinters,
  parsePrintTarget,
  printerTargetKey,
  readWorkstationSettings,
  resolvePrinter,
  saveWorkstationSettings,
  soundLevel,
  type PrinterProfile,
  type WorkstationSettings,
} from "../src/floor/setup/workstation-settings.js";
import type { ScannerConfig } from "../src/hardware/hardware.js";
import { failingWrites, rows } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

const ZEBRA: PrinterProfile = {
  id: "zebra",
  name: "Zebra у линии",
  target: { kind: "tcp", host: "192.168.1.50", port: 9100 },
  language: "zpl",
  dpi: 203,
};
const TSC: PrinterProfile = {
  id: "tsc",
  name: "TSC на COM",
  target: { kind: "serial", port: "COM4", baud: 9600 },
  language: "tspl",
  dpi: 300,
};

const SETTINGS: WorkstationSettings = {
  printers: [ZEBRA, TSC],
  assignments: { box: "zebra", pallet: "tsc", duplicate: null },
  scanners: [
    { port: "COM3", baud: 9600 },
    { port: "COM5", baud: 115200 },
  ],
  sound: { muted: false, volume: 40 },
  verifyPrintedLabel: true,
};

describe("the workstation's settings", () => {
  it("read as the defaults on a computer that has none: no printer, no scanner, no check", async () => {
    const { executor } = openLocalDb();
    await expect(readWorkstationSettings(executor)).resolves.toEqual(DEFAULT_WORKSTATION_SETTINGS);
    expect(resolvePrinter(DEFAULT_WORKSTATION_SETTINGS, "box")).toBeNull();
  });

  it("are stored in one transaction under four keys and read back exactly", async () => {
    const { db, executor } = openLocalDb();
    await saveWorkstationSettings(executor, SETTINGS);
    expect(rows(db, "SELECT key FROM workstation_settings ORDER BY key")).toEqual([
      { key: "printers" },
      { key: "scanners" },
      { key: "sound" },
      { key: "verify_printed_label" },
    ]);
    await expect(readWorkstationSettings(executor)).resolves.toEqual(SETTINGS);
    expect(resolvePrinter(SETTINGS, "box")).toEqual(ZEBRA);
    expect(resolvePrinter(SETTINGS, "pallet")).toEqual(TSC);
    expect(resolvePrinter(SETTINGS, "duplicate")).toBeNull();
    // A second save replaces every key.
    await saveWorkstationSettings(executor, DEFAULT_WORKSTATION_SETTINGS);
    await expect(readWorkstationSettings(executor)).resolves.toEqual(DEFAULT_WORKSTATION_SETTINGS);
  });

  it("refuse to store what would read back otherwise, and write nothing then", async () => {
    const { db, executor } = openLocalDb();
    const refused = async (settings: WorkstationSettings) => {
      await expect(saveWorkstationSettings(executor, settings)).rejects.toBeInstanceOf(
        InvalidSettingsError,
      );
    };
    await refused({ ...SETTINGS, assignments: { ...SETTINGS.assignments, box: "missing" } });
    await refused({ ...SETTINGS, printers: [ZEBRA, { ...TSC, target: ZEBRA.target }] });
    await refused({ ...SETTINGS, printers: [{ ...ZEBRA, name: " " }] });
    await refused({
      ...SETTINGS,
      scanners: [
        { port: "COM3", baud: 9600 },
        { port: "com3", baud: 9600 },
      ],
    });
    await refused({ ...SETTINGS, scanners: [{ port: "COM3", baud: 0 }] });
    await refused({ ...SETTINGS, sound: { muted: false, volume: 101 } });
    expect(rows(db, "SELECT count(*) AS n FROM workstation_settings")).toEqual([{ n: 0 }]);
  });

  it("read each key on its own: one damaged value is its default, the others stay", async () => {
    const { db, executor } = openLocalDb();
    await saveWorkstationSettings(executor, SETTINGS);
    db.prepare("UPDATE workstation_settings SET value = ? WHERE key = 'sound'").run('"loud"');
    db.prepare("UPDATE workstation_settings SET value = ? WHERE key = 'scanners'").run(
      JSON.stringify([{ port: "COM3", baud: 9600 }, { port: "", baud: 9600 }, "COM9"]),
    );
    const read = await readWorkstationSettings(executor);
    expect(read.sound).toEqual(DEFAULT_WORKSTATION_SETTINGS.sound);
    expect(read.scanners).toEqual([{ port: "COM3", baud: 9600 }]);
    expect(read.printers).toEqual(SETTINGS.printers);
    expect(read.verifyPrintedLabel).toBe(true);
  });

  it("turn the label check on only for a stored `true`", async () => {
    const { db, executor } = openLocalDb();
    for (const value of ['"true"', "1", "null", "{}"]) {
      db.prepare(
        "INSERT INTO workstation_settings (key, value) VALUES ('verify_printed_label', ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).run(value);
      expect((await readWorkstationSettings(executor)).verifyPrintedLabel).toBe(false);
    }
  });

  it("reject a database that cannot be read, rather than read defaults over it", async () => {
    const { executor } = openLocalDb();
    const broken = {
      ...executor,
      query: async () => {
        throw new Error("disk I/O error");
      },
    };
    await expect(readWorkstationSettings(broken)).rejects.toThrow("disk I/O error");
    await expect(saveWorkstationSettings(failingWrites(executor), SETTINGS)).rejects.toMatchObject({
      code: "statement_failed",
    });
  });
});

describe("the printers of the settings", () => {
  it("read a target as the shell takes it, COM names in capitals", () => {
    expect(parsePrintTarget({ kind: "tcp", host: " zebra.local ", port: 9100 })).toEqual({
      kind: "tcp",
      host: "zebra.local",
      port: 9100,
    });
    expect(parsePrintTarget({ kind: "serial", port: "com4", baud: 9600 })).toEqual({
      kind: "serial",
      port: "COM4",
      baud: 9600,
    });
    expect(parsePrintTarget({ kind: "usb", printer: "ZDesigner GK420d" })).toEqual({
      kind: "usb",
      printer: "ZDesigner GK420d",
    });
    for (const bad of [
      null,
      { kind: "tcp", host: "zebra", port: 0 },
      { kind: "tcp", host: "zebra", port: 65_536 },
      { kind: "tcp", host: "", port: 9100 },
      { kind: "serial", port: "COM4", baud: 1.5 },
      { kind: "usb", printer: "a\0b" },
      { kind: "lpt", port: "LPT1" },
    ]) {
      expect(parsePrintTarget(bad)).toBeNull();
    }
  });

  it("give one key to one address, however it is written", () => {
    expect(printerTargetKey({ kind: "tcp", host: "Zebra.Local.", port: 9100 })).toBe(
      printerTargetKey({ kind: "tcp", host: "zebra.local", port: 9100 }),
    );
    expect(printerTargetKey({ kind: "tcp", host: "zebra", port: 9100 })).not.toBe(
      printerTargetKey({ kind: "tcp", host: "zebra", port: 9101 }),
    );
    expect(printerTargetKey({ kind: "serial", port: "com4", baud: 9600 })).toBe(
      printerTargetKey({ kind: "serial", port: "COM4", baud: 115200 }),
    );
    expect(printerTargetKey({ kind: "usb", printer: "TSC TE200" })).toBe(
      printerTargetKey({ kind: "usb", printer: "tsc te200" }),
    );
  });

  it("drop a profile it cannot print with, and give a duplicate address's purposes to the first", () => {
    const read = parsePrinters({
      printers: [
        ZEBRA,
        { ...TSC, dpi: 600 },
        { ...ZEBRA, id: "zebra-again", name: "Та же Zebra", target: { ...ZEBRA.target } },
        { ...TSC, id: "tsc-2", language: "pdf" },
        { ...TSC, id: "tsc-3" },
      ],
      assignments: { box: "zebra-again", pallet: "tsc", duplicate: "tsc-3" },
    });
    expect(read.printers).toEqual([ZEBRA, { ...TSC, id: "tsc-3" }]);
    // `tsc` was dropped (600 dpi): its purpose is unassigned, never guessed.
    expect(read.assignments).toEqual({ box: "zebra", pallet: null, duplicate: "tsc-3" });
  });
});

describe("the sound and the scanners of the settings", () => {
  it("give a tone's gain from the level, and none when muted", () => {
    expect(soundLevel({ muted: false, volume: 40 })).toBe(0.4);
    expect(soundLevel({ muted: true, volume: 40 })).toBe(0);
  });

  it("give the shell the saved scanners when the app starts, and an empty set when there are none", async () => {
    const { executor } = openLocalDb();
    const configure = vi.fn<(scanners: readonly ScannerConfig[]) => Promise<void>>(
      async () => undefined,
    );
    await expect(applySavedScanners(executor, configure)).resolves.toBe(true);
    expect(configure).toHaveBeenLastCalledWith([]);
    await saveWorkstationSettings(executor, SETTINGS);
    await expect(applySavedScanners(executor, configure)).resolves.toBe(true);
    expect(configure).toHaveBeenLastCalledWith(SETTINGS.scanners);
  });

  it("answer false, never throw, when the shell refuses the scanners or the database fails", async () => {
    const { executor } = openLocalDb();
    const refusing = vi.fn(async () => {
      throw new Error("invalid_scanners");
    });
    await expect(applySavedScanners(executor, refusing)).resolves.toBe(false);
    const broken = {
      ...executor,
      query: async () => {
        throw new Error("local_db_unavailable");
      },
    };
    const configure = vi.fn(async () => undefined);
    await expect(applySavedScanners(broken, configure)).resolves.toBe(false);
    expect(configure).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/signal-sound.test.ts test/workstation-settings.test.ts`
Expected: FAIL — `test/workstation-settings.test.ts` и `test/app.test.tsx` не загружаются (`Failed to resolve import "../src/floor/setup/workstation-settings.js"`); `test/signal-sound.test.ts` — «plays at the workstation's level, and not at all when muted».

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/app/App.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
} from "../floor/scan-source.js";
import type { FloorOperator } from "../floor/sign-in.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
} from "../floor/scan-source.js";
import { applySavedScanners } from "../floor/setup/workstation-settings.js";
import type { FloorOperator } from "../floor/sign-in.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  );
  const kiosk = useMemo(
```

заменить на:

<!-- prettier-ignore -->
```tsx
  );
  // The COM scanners the workstation's settings name, once the app starts;
  // the setup gives the shell a changed set itself.
  useEffect(() => {
    void applySavedScanners(localDb, hardwareApi.configureScanners);
  }, [localDb, hardwareApi]);
  const kiosk = useMemo(
```

Создать `apps/standalone/src/floor/setup/workstation-settings.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import type { PrintTarget, ScannerConfig } from "../../hardware/hardware.js";
import type { LocalExecutor, LocalStatement } from "../../local/executor.js";

/**
 * What a printer prints for (stage 2a spec, decision 23): the box label, the
 * pallet label of the pallets' plan (ПЛ-Ц) and the code duplicate of stage 3.
 * All three are kept from plan 2a7 on, so the later plans add no migration of
 * the settings; plan 2a7 prints only `box`.
 */
export const PRINT_PURPOSES = ["box", "pallet", "duplicate"] as const;
export type PrintPurpose = (typeof PRINT_PURPOSES)[number];

/** The printer's command language. */
export const PRINTER_LANGUAGES = ["zpl", "tspl"] as const;
export type PrinterLanguage = (typeof PRINTER_LANGUAGES)[number];

/** The printer's resolution in dots per inch. */
export const PRINTER_DPIS = [203, 300] as const;
export type PrinterDpi = (typeof PRINTER_DPIS)[number];

/**
 * A printer of this workstation: where it is, its language and its
 * resolution. A job keeps a copy of the profile it was rendered for, so an
 * edit here never changes a label already prepared.
 */
export interface PrinterProfile {
  id: string;
  name: string;
  target: PrintTarget;
  language: PrinterLanguage;
  dpi: PrinterDpi;
}

/** The workstation's sound: the verdict tones' level, 0–100, or none at all. */
export interface SoundSettings {
  muted: boolean;
  volume: number;
}

/**
 * Everything the workstation setup configures (stage 2a spec §5.7.8). It
 * belongs to this computer, not to a pairing (`workstation_settings`,
 * `TableClass::Workstation`), and a forget keeps it.
 */
export interface WorkstationSettings {
  printers: PrinterProfile[];
  /** The printer of each purpose, by profile id; `null` — none. */
  assignments: Record<PrintPurpose, string | null>;
  scanners: ScannerConfig[];
  sound: SoundSettings;
  /** After a box label prints, its SSCC is scanned back before the work goes on. */
  verifyPrintedLabel: boolean;
}

export const DEFAULT_SOUND: SoundSettings = { muted: false, volume: 80 };

export const DEFAULT_WORKSTATION_SETTINGS: WorkstationSettings = {
  printers: [],
  assignments: { box: null, pallet: null, duplicate: null },
  scanners: [],
  sound: DEFAULT_SOUND,
  // Off, as the cloud's `DEFAULT_HARDWARE_CONFIG`: a station is told to check.
  verifyPrintedLabel: false,
};

/** The keys of `workstation_settings`: each is read on its own, so one bad value spoils only itself. */
export const SETTING_KEYS = {
  printers: "printers",
  scanners: "scanners",
  sound: "sound",
  verifyPrintedLabel: "verify_printed_label",
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" && !value.includes("\0")
    ? value.trim()
    : null;
}

function wholeNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

/** COM names are case-insensitive (`com3` is `COM3`); other port names are kept as they are. */
export function canonicalPort(port: string): string {
  const trimmed = port.trim();
  return /^com[0-9]+$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

/** A print target as the shell takes it (`PrintTarget` of `src-tauri/src/printer.rs`), or `null`. */
export function parsePrintTarget(value: unknown): PrintTarget | null {
  const target = record(value);
  if (target === null) return null;
  if (target["kind"] === "tcp") {
    const host = text(target["host"]);
    const port = wholeNumber(target["port"], 1, 65_535);
    return host !== null && port !== null ? { kind: "tcp", host, port } : null;
  }
  if (target["kind"] === "serial") {
    const port = text(target["port"]);
    const baud = wholeNumber(target["baud"], 1, 4_294_967_295);
    return port !== null && baud !== null
      ? { kind: "serial", port: canonicalPort(port), baud }
      : null;
  }
  if (target["kind"] === "usb") {
    const printer = text(target["printer"]);
    return printer !== null ? { kind: "usb", printer } : null;
  }
  return null;
}

/**
 * The physical endpoint of a target, whatever it is used for: one address,
 * one queue of sends (`createPrinterQueue`), and one profile per address in
 * the settings.
 */
export function printerTargetKey(target: PrintTarget): string {
  switch (target.kind) {
    case "tcp":
      return JSON.stringify([
        "tcp",
        target.host.trim().toLowerCase().replace(/\.$/, ""),
        target.port,
      ]);
    case "serial":
      return JSON.stringify(["serial", canonicalPort(target.port)]);
    case "usb":
      return JSON.stringify(["usb", target.printer.trim().toLowerCase()]);
  }
}

/** A printer profile, or `null` for anything this build cannot print with. */
export function parsePrinterProfile(value: unknown): PrinterProfile | null {
  const row = record(value);
  if (row === null) return null;
  const id = text(row["id"]);
  const name = text(row["name"]);
  const target = parsePrintTarget(row["target"]);
  const language = PRINTER_LANGUAGES.find((candidate) => candidate === row["language"]);
  const dpi = PRINTER_DPIS.find((candidate) => candidate === row["dpi"]);
  if (id === null || name === null || target === null || !language || !dpi) return null;
  return { id, name, target, language, dpi };
}

/**
 * The printers and their purposes. A profile this build cannot read is
 * dropped; a second profile of an id already read, or of an address already
 * read, is dropped too and its purposes go to the first one (as the cloud's
 * `parsePrinterRouting`); a purpose naming no profile is unassigned — never a
 * guess.
 */
export function parsePrinters(
  value: unknown,
): Pick<WorkstationSettings, "printers" | "assignments"> {
  const row = record(value);
  const printers: PrinterProfile[] = [];
  const byEndpoint = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const candidate of Array.isArray(row?.["printers"]) ? row["printers"] : []) {
    const profile = parsePrinterProfile(candidate);
    if (profile === null || aliases.has(profile.id)) continue;
    const key = printerTargetKey(profile.target);
    const existing = byEndpoint.get(key);
    aliases.set(profile.id, existing ?? profile.id);
    if (existing === undefined) {
      printers.push(profile);
      byEndpoint.set(key, profile.id);
    }
  }
  const stored = record(row?.["assignments"]);
  const assignments: Record<PrintPurpose, string | null> = {
    box: null,
    pallet: null,
    duplicate: null,
  };
  for (const purpose of PRINT_PURPOSES) {
    const id = stored?.[purpose];
    assignments[purpose] = typeof id === "string" ? (aliases.get(id) ?? null) : null;
  }
  return { printers, assignments };
}

/** The COM scanners, each port once (`COM3` and `com3` are one), as `configure_scanners` takes them. */
export function parseScanners(value: unknown): ScannerConfig[] {
  const scanners: ScannerConfig[] = [];
  const seen = new Set<string>();
  for (const candidate of Array.isArray(value) ? value : []) {
    const row = record(candidate);
    const port = text(row?.["port"]);
    const baud = wholeNumber(row?.["baud"], 1, 4_294_967_295);
    if (port === null || baud === null) continue;
    const canonical = canonicalPort(port);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    scanners.push({ port: canonical, baud });
  }
  return scanners;
}

/** The sound settings; a value this build cannot read is the default. */
export function parseSound(value: unknown): SoundSettings {
  const row = record(value);
  const volume = wholeNumber(row?.["volume"], 0, 100);
  if (row === null || typeof row["muted"] !== "boolean" || volume === null) return DEFAULT_SOUND;
  return { muted: row["muted"], volume };
}

/** The gain of a verdict's tone: 0 when muted. */
export function soundLevel(sound: SoundSettings): number {
  return sound.muted ? 0 : sound.volume / 100;
}

const settingRow = z.object({ key: z.string(), value: z.string() });

function parsedValue(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * The workstation's settings as stored, each key read on its own: a key not
 * stored yet, or one this build cannot read, is its default, so one damaged
 * value never loses the others. A database that cannot be read rejects.
 */
export async function readWorkstationSettings(local: LocalExecutor): Promise<WorkstationSettings> {
  const rows = await local.query("SELECT key, value FROM workstation_settings", [], settingRow);
  const stored = new Map(rows.map((row) => [row.key, parsedValue(row.value)]));
  const verify = stored.get(SETTING_KEYS.verifyPrintedLabel);
  return {
    ...parsePrinters(stored.get(SETTING_KEYS.printers)),
    scanners: parseScanners(stored.get(SETTING_KEYS.scanners)),
    sound: parseSound(stored.get(SETTING_KEYS.sound)),
    verifyPrintedLabel: verify === true,
  };
}

/** A setting this build would not read back as it was given. */
export class InvalidSettingsError extends Error {
  constructor(what: string) {
    super(`workstation settings: ${what}`);
    this.name = "InvalidSettingsError";
  }
}

/** JSON with every object's keys in order, so two equal values compare equal as text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const row = record(value);
  if (row === null) return JSON.stringify(value);
  const keys = Object.keys(row).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
}

/** `value` survives `parse` unchanged. */
function readsBack(value: unknown, parse: (raw: unknown) => unknown): boolean {
  const raw: unknown = JSON.parse(JSON.stringify(value));
  return canonicalJson(parse(raw)) === canonicalJson(raw);
}

function upsert(key: string, value: unknown): LocalStatement {
  return {
    sql:
      "INSERT INTO workstation_settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    values: [key, JSON.stringify(value)],
    expectedChanges: 1,
  };
}

/**
 * Stores the settings in one transaction. What is stored is exactly what
 * `readWorkstationSettings` reads back: settings it would read otherwise (a
 * profile it would drop, a purpose naming no profile, a scanner twice) are
 * refused with `InvalidSettingsError` before anything is written.
 */
export async function saveWorkstationSettings(
  local: LocalExecutor,
  settings: WorkstationSettings,
): Promise<void> {
  const printers = { printers: settings.printers, assignments: settings.assignments };
  if (!readsBack(printers, parsePrinters)) throw new InvalidSettingsError("printers");
  if (!readsBack(settings.scanners, parseScanners)) throw new InvalidSettingsError("scanners");
  if (!readsBack(settings.sound, parseSound)) throw new InvalidSettingsError("sound");
  await local.transaction([
    upsert(SETTING_KEYS.printers, printers),
    upsert(SETTING_KEYS.scanners, settings.scanners),
    upsert(SETTING_KEYS.sound, settings.sound),
    upsert(SETTING_KEYS.verifyPrintedLabel, settings.verifyPrintedLabel),
  ]);
}

/** The printer assigned to `purpose`, or `null`. */
export function resolvePrinter(
  settings: Pick<WorkstationSettings, "printers" | "assignments">,
  purpose: PrintPurpose,
): PrinterProfile | null {
  const id = settings.assignments[purpose];
  return settings.printers.find((printer) => printer.id === id) ?? null;
}

/**
 * Gives the shell the COM scanners the settings name (an empty set closes
 * them all): when the app starts, and after the setup saves. A refusal or a
 * database that cannot be read is said by the answer, never thrown — the
 * keyboard scans either way, and the setup shows each port's connection.
 */
export async function applySavedScanners(
  local: LocalExecutor,
  configure: (scanners: readonly ScannerConfig[]) => Promise<void>,
): Promise<boolean> {
  try {
    const settings = await readWorkstationSettings(local);
    await configure(settings.scanners);
    return true;
  } catch {
    return false;
  }
}
```

Правка `apps/standalone/src/floor/work/signal-sound.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
 * a duplicate from an error while the operator watches the line, not the
 * screen. The volume and muting of the workstation's setup are plan 2a7's.
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
 * a duplicate from an error while the operator watches the line, not the
 * screen. Its level is the workstation's sound setting (`soundLevel`).
 */
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
/**
 * Plays a verdict's tone. Never throws: a station without working sound
 * keeps scanning, and the screen says the verdict in words and colour too.
 */
export function playSignalTone(
  tone: SignalTone,
  context: () => AudioContext | null = audioContext,
): void {
  try {
```

заменить на:

<!-- prettier-ignore -->
```ts
/**
 * Plays a verdict's tone at `level` (0–1; 0 — muted, nothing plays). Never
 * throws: a station without working sound keeps scanning, and the screen
 * says the verdict in words and colour too.
 */
export function playSignalTone(
  tone: SignalTone,
  context: () => AudioContext | null = audioContext,
  level = 1,
): void {
  if (!(level > 0)) return;
  try {
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
    oscillator.frequency.setValueAtTime(spec.hz, audio.currentTime);
    gain.gain.setValueAtTime(1, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + spec.seconds);
```

заменить на:

<!-- prettier-ignore -->
```ts
    oscillator.frequency.setValueAtTime(spec.hz, audio.currentTime);
    gain.gain.setValueAtTime(Math.min(level, 1), audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + spec.seconds);
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/signal-sound.test.ts test/workstation-settings.test.ts`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  116 passed (116)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  99 passed (99)`, `Tests  2447 passed (2447)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — проверку этикетки включает любое «истинное» значение.
В `apps/standalone/src/floor/setup/workstation-settings.ts` фрагмент

<!-- prettier-ignore -->
```ts
    verifyPrintedLabel: verify === true,
```

заменить на:

<!-- prettier-ignore -->
```ts
    verifyPrintedLabel: Boolean(verify),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/workstation-settings.test.ts`
Expected: FAIL — «turn the label check on only for a stored `true`».

М2 — назначение указывает на отброшенный профиль.
В `apps/standalone/src/floor/setup/workstation-settings.ts` фрагмент

<!-- prettier-ignore -->
```ts
    assignments[purpose] = typeof id === "string" ? (aliases.get(id) ?? null) : null;
```

заменить на:

<!-- prettier-ignore -->
```ts
    assignments[purpose] = typeof id === "string" ? id : null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/workstation-settings.test.ts`
Expected: FAIL — «refuse to store what would read back otherwise, and write nothing then», «drop a profile it cannot print with, and give a duplicate address's purposes to the first».

М3 — записываются настройки, которые прочитаются иначе.
В `apps/standalone/src/floor/setup/workstation-settings.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (!readsBack(printers, parsePrinters)) throw new InvalidSettingsError("printers");
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/workstation-settings.test.ts`
Expected: FAIL — «refuse to store what would read back otherwise, and write nothing then».

М4 — сохранённые сканеры не отдаются оболочке при запуске.
В `apps/standalone/src/app/App.tsx` удалить фрагмент

<!-- prettier-ignore -->
```tsx
    void applySavedScanners(localDb, hardwareApi.configureScanners);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx`
Expected: FAIL — «gives the shell the COM scanners of the workstation's settings when it starts».

М5 — станция «без звука» звучит.
В `apps/standalone/src/floor/work/signal-sound.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (!(level > 0)) return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/signal-sound.test.ts`
Expected: FAIL — «plays at the workstation's level, and not at all when muted».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/app/App.tsx apps/standalone/src/floor/setup/workstation-settings.ts apps/standalone/src/floor/work/signal-sound.ts apps/standalone/test/app.test.tsx apps/standalone/test/signal-sound.test.ts apps/standalone/test/support/hardware.ts apps/standalone/test/workstation-settings.test.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/app.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/app.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/app/App.tsx apps/standalone/src/floor/setup/workstation-settings.ts apps/standalone/src/floor/work/signal-sound.ts apps/standalone/test/app.test.tsx apps/standalone/test/signal-sound.test.ts apps/standalone/test/support/hardware.ts apps/standalone/test/workstation-settings.test.ts
git commit -m "feat(standalone): the workstation's settings: printers and their purposes, scanners, sound, the label check" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Поля и байты этикетки короба — из снимка, в языке и разрешении принтера; потолок холста

`boxLabelData` — поля этикетки (`boxLabelFields` домена) из снимка смены (товар, название для печати, срок годности, контрагент — замороженные при открытии, не сегодняшний каталог), короба (SSCC, число, сохранённое время закрытия), номера и даты производства смены и оператора, закрывшего короб. `renderLabel` — порт облачного `renderLabelBytes`: геометрия шаблона в разрешении принтера (`withPrinterDpi`), язык принтера (`generateZpl`/`generateTspl` — из своего ленивого чанка `label-emitters.ts`), нелатинский текст — растеризатор приложения (тот же, что у предпросмотра офиса: «предпросмотр = печать»), байты — `latin1ToBytes`. Растеризатор получает потолок холста 4096 × 4096 точек (решение 22, открытый пункт ревью 1e4b): больший холст — `RasterTooLargeError` до его создания; предпросмотр офиса такую ошибку уже ловит и оставляет собственный рисунок элемента.

**Files:**

- Create: `apps/standalone/src/floor/print/label-emitters.ts`, `apps/standalone/src/floor/print/label-render.ts`
- Modify: `apps/standalone/src/labels/rasterizer.ts`
- Test: `apps/standalone/test/floor-label-render.test.ts` (Create), `apps/standalone/test/support/printing.ts` (Create), `apps/standalone/test/label-raster.test.ts` (Modify)

**Interfaces:**

- Consumes: `boxLabelFields`, `withPrinterDpi`, `generateZpl`, `generateTspl`, `LabelTemplateSpec`, `RasterizeTextFn` (`@markiro/domain`); `rasterizeText` (`src/labels/rasterizer.ts`); `WorkShift` (`src/floor/shifts/shift-copies.ts`, план 2a5); `PrinterLanguage`, `PrinterDpi` (задача 2).
- Produces:
  - `src/labels/rasterizer.ts`: `MAX_RASTER_DOTS = 4096`, `class RasterTooLargeError { width; height }`;
  - `src/floor/print/label-render.ts`: `interface LabelPrinter { language; dpi }`, `type LabelFields`, `latin1ToBytes(text)`, `boxLabelData(shift, box: { sscc; itemCount; closedAt }, operatorName)`, `renderLabel(spec, fields, printer, rasterize?)`;
  - `src/floor/print/label-emitters.ts` — ленивый чанк генераторов;
  - `test/support/printing.ts`: `fakeRaster`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-label-render.test.ts`:

<!-- prettier-ignore -->
```ts
import {
  generateTspl,
  generateZpl,
  withPrinterDpi,
  type RasterizeTextFn,
  type RasterResult,
} from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";

import { boxLabelData, latin1ToBytes, renderLabel } from "../src/floor/print/label-render.js";
import { RasterTooLargeError } from "../src/labels/rasterizer.js";
import { enteredShift, ENTERED } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRaster } from "./support/printing.js";

const SSCC = "046006820000035007";
const CLOSED_AT = "2026-10-08T06:20:00.000Z";

function decode(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

describe("a box label's fields", () => {
  it("come from the shift's snapshot, the box and the operator — never from today's copy", async () => {
    const { executor } = openLocalDb();
    // The host's list renamed the product and the counterparty after the shift opened.
    const shift = await enteredShift(executor, {
      ...ENTERED,
      productName: "Молоко (новое имя)",
      counterpartyName: "ООО «Другой»",
    });
    expect(boxLabelData(shift, { sscc: SSCC, itemCount: 12, closedAt: CLOSED_AT }, "Анна")).toEqual(
      {
        "product.name": "Молоко 3,2% 0,9 л",
        "product.printName": "Молоко 3,2%",
        "product.gtin": "04600682000013",
        "product.egais": "",
        "km.code": "",
        sscc: SSCC,
        "shift.no": "OCT26-004",
        date: "08.10.2026",
        expiry: "17.10.2026",
        qty: "12",
        "qty.boxes": "",
        operator: "Анна",
        "counterparty.name": "ООО «Северный берег»",
      },
    );
  });
});

describe("a label's bytes", () => {
  it("are the domain's document for the printer's language and resolution: the model the office previews", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const spec = shift.snapshot.boxTemplate.spec;
    const fields = boxLabelData(shift, { sscc: SSCC, itemCount: 12, closedAt: CLOSED_AT }, "Анна");
    const zpl203 = decode(
      await renderLabel(spec, fields, { language: "zpl", dpi: 203 }, fakeRaster),
    );
    const zpl300 = decode(
      await renderLabel(spec, fields, { language: "zpl", dpi: 300 }, fakeRaster),
    );
    const tspl = decode(
      await renderLabel(spec, fields, { language: "tspl", dpi: 300 }, fakeRaster),
    );
    // The template is TSPL at 203 dpi; the printer's language and resolution win.
    expect(zpl203).toBe(await generateZpl(spec, fields, { rasterizeText: fakeRaster }));
    expect(zpl203).toContain("^PW464");
    expect(zpl300).toBe(
      await generateZpl(withPrinterDpi(spec, 300), fields, { rasterizeText: fakeRaster }),
    );
    expect(zpl300).toContain("^PW685");
    expect(tspl).toBe(
      await generateTspl(withPrinterDpi(spec, 300), fields, { rasterizeText: fakeRaster }),
    );
    expect(tspl.startsWith("SIZE 58 mm, 40 mm")).toBe(true);
  });

  it("draw the Cyrillic text through the rasterizer it is given, with the printer's dots", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const fields = boxLabelData(shift, { sscc: SSCC, itemCount: 12, closedAt: CLOSED_AT }, null);
    const rasterize = vi.fn<RasterizeTextFn>(fakeRaster);
    await renderLabel(
      shift.snapshot.boxTemplate.spec,
      fields,
      { language: "zpl", dpi: 300 },
      rasterize,
    );
    expect(rasterize).toHaveBeenCalledWith(
      "Молоко 3,2%",
      expect.objectContaining({ fontSizePx: 42, bold: false }),
    );
  });

  it("reject when the rasterizer cannot draw a text, so nothing half-rendered is printed", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const fields = boxLabelData(shift, { sscc: SSCC, itemCount: 12, closedAt: CLOSED_AT }, null);
    const refusing: RasterizeTextFn = async (): Promise<RasterResult> => {
      throw new RasterTooLargeError(5000, 32);
    };
    await expect(
      renderLabel(
        shift.snapshot.boxTemplate.spec,
        fields,
        { language: "tspl", dpi: 203 },
        refusing,
      ),
    ).rejects.toBeInstanceOf(RasterTooLargeError);
  });

  it("keep every byte of a latin1 document as one byte", () => {
    expect([...latin1ToBytes("Aÿ\u0080\u001d")]).toEqual([0x41, 0xff, 0x80, 0x1d]);
  });
});
```

Правка `apps/standalone/test/label-raster.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
} from "../src/labels/font-coverage.js";
import { mapFontFamily, RasterUnavailableError, rasterizeText } from "../src/labels/rasterizer.js";

/** A real, serializable font of `.notdef` and one glyph per character: no outlines, no file. */
```

заменить на:

<!-- prettier-ignore -->
```ts
} from "../src/labels/font-coverage.js";
import {
  mapFontFamily,
  MAX_RASTER_DOTS,
  RasterTooLargeError,
  RasterUnavailableError,
  rasterizeText,
} from "../src/labels/rasterizer.js";

/** A real, serializable font of `.notdef` and one glyph per character: no outlines, no file. */
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  const font = "400 21px IBM Plex Sans, sans-serif";

  it("draws one unbounded line black on white and packs exactly what it read back", async () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
  const font = "400 21px IBM Plex Sans, sans-serif";

  it("draws a canvas of up to 4096 dots on a side, and refuses a larger one before making it", async () => {
    const fits = fakeCanvases({ charWidth: 1 });
    await rasterizeText("Ш".repeat(MAX_RASTER_DOTS), {
      fontFamily: "sans-serif",
      fontSizePx: 21,
      bold: false,
    });
    expect(fits.map((s) => s.width)).toEqual([1, 4096]);

    const wide = fakeCanvases({ charWidth: 1 });
    const tooWide = rasterizeText("Ш".repeat(MAX_RASTER_DOTS + 1), {
      fontFamily: "sans-serif",
      fontSizePx: 21,
      bold: false,
    });
    await expect(tooWide).rejects.toBeInstanceOf(RasterTooLargeError);
    await expect(tooWide).rejects.toMatchObject({ width: 4097, height: 32 });
    // Only the 1x1 measuring canvas was made.
    expect(wide.map((s) => [s.width, s.height])).toEqual([[1, 1]]);

    // 2731 px of font is a line of ceil(2731 x 1.5) = 4097 dots.
    const tall = fakeCanvases();
    await expect(
      rasterizeText("Ш", { fontFamily: "sans-serif", fontSizePx: 2731, bold: false }),
    ).rejects.toMatchObject({ name: "RasterTooLargeError", height: 4097 });
    expect(tall).toHaveLength(1);
    // Sixteen lines of a 171 px font: 16 x 257 = 4112 dots.
    fakeCanvases({ charWidth: 100 });
    await expect(
      rasterizeText("а б в г д е ж з и к л м н о п р", {
        fontFamily: "sans-serif",
        fontSizePx: 171,
        bold: false,
        maxWidthPx: 150,
        maxLines: 16,
      }),
    ).rejects.toMatchObject({ height: 4112 });
  });

  it("draws one unbounded line black on white and packs exactly what it read back", async () => {
```

Создать `apps/standalone/test/support/printing.ts`:

<!-- prettier-ignore -->
```ts
import type { RasterizeTextFn } from "@markiro/domain";

/** A rasterizer that draws every text as the same 8 x 2 bitmap: jsdom has no canvas. */
export const fakeRaster: RasterizeTextFn = async () => ({
  hex: "FF00",
  totalBytes: 2,
  bytesPerRow: 1,
  width: 8,
  height: 2,
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-label-render.test.ts test/label-raster.test.ts`
Expected: FAIL — `test/floor-label-render.test.ts` не загружается (`Failed to resolve import "../src/floor/print/label-render.js"`); `test/label-raster.test.ts` — «draws a canvas of up to 4096 dots on a side, and refuses a larger one before making it».

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/floor/print/label-emitters.ts`:

<!-- prettier-ignore -->
```ts
/**
 * The domain's ZPL and TSPL generators, loaded on their own
 * (`import("./label-emitters.js")`): they bring the barcode encoder with them
 * (about 0.9 MB), which the station needs only once a box closes, not when
 * the app starts. The office loads the same code through its own chunk.
 */
export { generateTspl, generateZpl } from "@markiro/domain";
```

Создать `apps/standalone/src/floor/print/label-render.ts`:

<!-- prettier-ignore -->
```ts
import {
  boxLabelFields,
  withPrinterDpi,
  type LabelField,
  type LabelTemplateSpec,
  type RasterizeTextFn,
} from "@markiro/domain";

import { rasterizeText } from "../../labels/rasterizer.js";
import type { PrinterDpi, PrinterLanguage } from "../setup/workstation-settings.js";
import type { WorkShift } from "../shifts/shift-copies.js";

/** What a render needs of a printer: its language and its resolution. */
export interface LabelPrinter {
  language: PrinterLanguage;
  dpi: PrinterDpi;
}

/** A label's fields, as the domain gives them for its template. */
export type LabelFields = Record<LabelField, string>;

/**
 * Turns an emitter's output into its exact bytes, one code unit per byte (the
 * cloud station's `latin1ToBytes`): the TSPL emitter carries its `BITMAP`
 * payload as a latin1 string, which `TextEncoder` would corrupt by encoding
 * every byte above 0x7F as two.
 */
export function latin1ToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

/**
 * The fields of a box's label (stage 2a spec §5.7.5) from the shift's
 * snapshot — never from today's catalog: the product, the counterparty and
 * the shift as they were frozen when the shift opened — the box (its SSCC,
 * its count and the time it closed, kept with the box) and the operator who
 * closed it. `egaisCode` is none (no alcohol in stage 2a).
 */
export function boxLabelData(
  shift: WorkShift,
  box: { sscc: string; itemCount: number; closedAt: string },
  operatorName: string | null,
): LabelFields {
  const { product, counterpartyName } = shift.snapshot;
  return boxLabelFields({
    sscc: box.sscc,
    itemCount: box.itemCount,
    productName: product.name,
    productPrintName: product.printName,
    gtin14: product.gtin14,
    egaisCode: null,
    shelfLifeDays: product.shelfLifeDays,
    operatorName,
    counterpartyName,
    closedAt: box.closedAt,
    productionDate: shift.copy.productionDate,
    shiftNumber: shift.copy.number,
  });
}

/**
 * A label's bytes for one printer (the cloud station's `renderLabelBytes`):
 * the template's millimetre geometry at the printer's own resolution
 * (`withPrinterDpi`), in the printer's language, with non-Latin text drawn by
 * the app's rasterizer — the same model the office previews, so the print
 * and the preview do not drift. A text too large for the canvas rejects with
 * `RasterTooLargeError`; any failure rejects, and the caller records the
 * label as `render_failed`.
 */
export async function renderLabel(
  spec: LabelTemplateSpec,
  fields: LabelFields,
  printer: LabelPrinter,
  rasterize: RasterizeTextFn = rasterizeText,
): Promise<Uint8Array> {
  const { generateTspl, generateZpl } = await import("./label-emitters.js");
  const printSpec = withPrinterDpi(spec, printer.dpi);
  const text =
    printer.language === "tspl"
      ? await generateTspl(printSpec, fields, { rasterizeText: rasterize })
      : await generateZpl(printSpec, fields, { rasterizeText: rasterize });
  return latin1ToBytes(text);
}
```

Правка `apps/standalone/src/labels/rasterizer.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
}

function canvas2d(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
```

заменить на:

<!-- prettier-ignore -->
```ts
}

/**
 * The largest canvas side the rasterizer draws, in dots (stage 2a spec,
 * decision 22): 4096 is 13.6 inches at 300 dpi, longer than any label, and a
 * webview may refuse a larger canvas or run out of memory on one.
 */
export const MAX_RASTER_DOTS = 4096;

/**
 * A text that would need a canvas larger than `MAX_RASTER_DOTS` on a side:
 * a font far too large for the label, or a line with no width to wrap in.
 * Typed, so a print says «cannot render» (`render_failed`) and the office's
 * preview keeps the element's own drawing.
 */
export class RasterTooLargeError extends Error {
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    super(`a ${width} x ${height} canvas exceeds ${MAX_RASTER_DOTS} dots on a side`);
    this.name = "RasterTooLargeError";
    this.width = width;
    this.height = height;
  }
}

function canvas2d(width: number, height: number): CanvasRenderingContext2D {
  // Before the canvas exists: a webview asked for a huge one may hang or crash.
  if (width > MAX_RASTER_DOTS || height > MAX_RASTER_DOTS) {
    throw new RasterTooLargeError(width, height);
  }
  const canvas = document.createElement("canvas");
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-label-render.test.ts test/label-raster.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  35 passed (35)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  100 passed (100)`, `Tests  2453 passed (2453)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — холст без потолка.
В `apps/standalone/src/labels/rasterizer.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (width > MAX_RASTER_DOTS || height > MAX_RASTER_DOTS) {
    throw new RasterTooLargeError(width, height);
  }
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-raster.test.ts`
Expected: FAIL — «draws a canvas of up to 4096 dots on a side, and refuses a larger one before making it».

М2 — этикетка в разрешении шаблона, а не принтера.
В `apps/standalone/src/floor/print/label-render.ts` фрагмент

<!-- prettier-ignore -->
```ts
  const printSpec = withPrinterDpi(spec, printer.dpi);
```

заменить на:

<!-- prettier-ignore -->
```ts
  const printSpec = spec;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-label-render.test.ts`
Expected: FAIL — «are the domain's document for the printer's language and resolution: the model the office previews», «draw the Cyrillic text through the rasterizer it is given, with the printer's dots».

М3 — контрагент из списка хоста, а не из снимка.
В `apps/standalone/src/floor/print/label-render.ts` фрагмент

<!-- prettier-ignore -->
```ts
  const { product, counterpartyName } = shift.snapshot;
```

заменить на:

<!-- prettier-ignore -->
```ts
  const { product } = shift.snapshot;
  const { counterpartyName } = shift.copy;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-label-render.test.ts`
Expected: FAIL — «come from the shift's snapshot, the box and the operator — never from today's copy».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/print/label-emitters.ts apps/standalone/src/floor/print/label-render.ts apps/standalone/src/labels/rasterizer.ts apps/standalone/test/floor-label-render.test.ts apps/standalone/test/label-raster.test.ts apps/standalone/test/support/printing.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/print/label-emitters.ts apps/standalone/src/floor/print/label-render.ts apps/standalone/src/labels/rasterizer.ts apps/standalone/test/floor-label-render.test.ts apps/standalone/test/label-raster.test.ts apps/standalone/test/support/printing.ts
git commit -m "feat(standalone): a box label's fields from the snapshot and its bytes for the printer; a canvas cap" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Задания печати — очередь принтеров с пределом, задание в транзакции закрытия, отправка, восстановление прерванных

`print-runtime.ts` — принтеры приложения: отправки на один адрес — по очереди (облачный `serializePrinterOutput`), очередь ждёт настоящего ответа оболочки, а не предела; ответ — не позже `PRINT_SEND_LIMIT_MS` (20 с) от вопроса: ушедшие оболочке байты без ответа — `timeout`, байты, чей предел истёк в очереди за чужой зависшей отправкой, оболочке не отдаются никогда — `busy` (заметка плана 2a4: сброс COM-порта может держать вызов дольше предела оболочки). Задание «в полёте», пока вызов оболочки не завершился на деле.

`print-jobs.ts`: `boxLabelStep` — `CloseStep` плана 2a6: задание короба (поля из снимка, байты для принтера назначения «Короб», читаемого из настроек при каждом закрытии) — строкой транзакции закрытия; нет принтера — `failed` `printer_unconfigured`, не рендерится — `failed` `render_failed`, короб закрывается в любом случае. `sendLabelJob`: `sending` и попытка пишутся ДО отправки, конец — `sent` только на `{ sent: true }` оболочки, `failed` — ничего не ушло, `unknown` — этикетка может быть; каждая запись сравнивает состояние и попытку с прочитанными (`StaleJobError`). `recoverInterruptedJobs` — `sending`, чьих байтов не держит ни одна отправка приложения, становится `unknown` `interrupted`. `shiftLabelsSettled` — все этикетки смены решены (для закрытия смены плана 2a8: запись `box_label` после `shift_closed` отметила бы смену поздней на хосте, ревью задачи 6 плана 2a2). Сама эта часть ничего не отправляет повторно.

**Files:**

- Create: `apps/standalone/src/floor/print/print-jobs.ts`, `apps/standalone/src/floor/print/print-runtime.ts`
- Test: `apps/standalone/test/floor-print-jobs.test.ts` (Create), `apps/standalone/test/floor-print-runtime.test.ts` (Create), `apps/standalone/test/support/printing.ts` (Modify)

**Interfaces:**

- Consumes: `HardwareApi.printBytes`, `PrintResult`, `PrintTarget`, `bytesToBase64` (план 2a4); `CloseStep`, `closeOpenBox` (`src/floor/work/box-close.ts`, план 2a6); `readWorkstationSettings`, `resolvePrinter`, `parsePrinterProfile`, `printerTargetKey` (задача 2); `boxLabelData`, `renderLabel` (задача 3); таблица `floor_print_jobs` (задача 1).
- Produces:
  - `src/floor/print/print-runtime.ts`: `PRINT_SEND_LIMIT_MS = 20_000`, `type SendOutcome = { kind: "answered"; result } | { kind: "timeout" } | { kind: "busy" }`, `type StartTimer`, `interface PrintRuntime { send(jobId | null, target, bytes); isInFlight(jobId); inFlight() }`, `createPrintRuntime(printBytes, { limitMs?, startTimer? })`;
  - `src/floor/print/print-jobs.ts`: `LABEL_PURPOSES`, `type LabelPurpose`, `PRINT_JOB_STATES`, `type PrintJobState`, `FAILED_CODES`, `UNKNOWN_CODES`, `type FailedCode`, `type UnknownCode`, `type PrintJobCode`, `interface PrintJob`, `isOpenJob(job)`, `class UnreadableJobError`, `readPrintJob(local, pairing, id)`, `readOpenJob(local, pairing, shiftId)`, `shiftLabelsSettled(local, pairing, shiftId)`, `type RenderLabel`, `interface NewLabel`, `prepareLabelJob(label, settings, pairing, render?)`, `boxLabelStep({ local, pairing, shift, operatorName, newId, render? })`, `class StaleJobError`, `class UnsendableJobError`, `base64ToBytes`, `settleOutcome(outcome)`, `interface PrintContext { local; pairing; runtime; now }`, `interface SendOptions { rebind?; extra? }`, `sendLabelJob(context, job, options?)`, `recoverInterruptedJobs(context)`;
  - `test/support/printing.ts`: `ZEBRA`, `TSC`, `printingSettings`, `setUpPrinting`, `fakeRender`, `renderedText`, `renderedBase64`, `manualTimers`, `manualRuntime`, `jobRows`, `flushPromises`, `spyRender`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-print-jobs.test.ts`:

<!-- prettier-ignore -->
```ts
import { buildSscc } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";

import {
  boxLabelStep,
  isOpenJob,
  readOpenJob,
  readPrintJob,
  recoverInterruptedJobs,
  sendLabelJob,
  settleOutcome,
  shiftLabelsSettled,
  StaleJobError,
  UnreadableJobError,
  UnsendableJobError,
  type PrintContext,
  type PrintJob,
} from "../src/floor/print/print-jobs.js";
import type { PrintRuntime } from "../src/floor/print/print-runtime.js";
import { closeOpenBox } from "../src/floor/work/box-close.js";
import { processScan, type ScanContext } from "../src/floor/work/scan-pipeline.js";
import type { LocalExecutor } from "../src/local/executor.js";
import {
  enteredShift,
  failingWrites,
  holdingWrites,
  km,
  OPERATOR_ID,
  PAIRING,
  PREFIX,
  rows,
  scanContext,
  seedBlock,
  SHIFT_ID,
} from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import {
  fakeRender,
  flushPromises,
  jobRows,
  manualRuntime,
  renderedBase64,
  renderedText,
  setUpPrinting,
  spyRender,
  TSC,
  ZEBRA,
} from "./support/printing.js";

const BLOCK = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const SSCC = buildSscc(0, PREFIX, 1500);
const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";

async function station() {
  const { db, executor } = openLocalDb();
  const shift = await enteredShift(executor);
  seedBlock(db, { blockId: BLOCK, from: 1500, to: 3499 });
  return { db, local: executor, shift };
}

type Station = Awaited<ReturnType<typeof station>>;

/** Accepts three codes into the open box. */
async function fill(context: ScanContext): Promise<void> {
  for (const serial of ["A1", "A2", "A3"]) await processScan(context, km(serial));
}

/** Closes the open box with its print job, as the work screen does; the job's id is `job-1`. */
async function closeWithLabel(at: Station, local: LocalExecutor = at.local, render = fakeRender) {
  const context = scanContext(local, at.shift);
  await fill(scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() }));
  const step = boxLabelStep({
    local,
    pairing: PAIRING,
    shift: at.shift,
    operatorName: "Анна Кузнецова",
    newId: () => "job-1",
    render,
  });
  return closeOpenBox(context, [step]);
}

function printContext(local: LocalExecutor, runtime: PrintRuntime): PrintContext {
  let tick = Date.parse("2026-10-08T06:30:00.000Z");
  return {
    local,
    pairing: PAIRING,
    runtime,
    now: () => {
      tick += 1_000;
      return new Date(tick);
    },
  };
}

async function job(at: Station, id = "job-1"): Promise<PrintJob> {
  const found = await readPrintJob(at.local, PAIRING, id);
  if (found === null) throw new Error(`no job ${id}`);
  return found;
}

describe("a box's print job", () => {
  it("is written with the close, rendered from the snapshot for the box's printer", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    const render = spyRender();
    const closed = await closeWithLabel(at, at.local, render);
    expect(closed.kind).toBe("closed");
    const box = rows(at.db, "SELECT id, sscc, closed_at FROM floor_boxes")[0];
    expect(jobRows(at.db)).toEqual([
      {
        id: "job-1",
        purpose: "box",
        subject_id: box?.["id"],
        sscc: SSCC,
        state: "prepared",
        verify: 0,
        template_id: "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
        template_rev: 62,
        printer: JSON.stringify(ZEBRA),
        bytes_base64: renderedBase64(ZEBRA, SSCC),
        error_code: null,
        attempts: 0,
        operator_id: OPERATOR_ID,
        created_at: box?.["closed_at"],
      },
    ]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]?.[0]).toEqual(at.shift.snapshot.boxTemplate.spec);
    expect(render.mock.calls[0]?.[1]).toMatchObject({
      sscc: SSCC,
      qty: "3",
      operator: "Анна Кузнецова",
      "product.printName": "Молоко 3,2%",
    });
    const stored = await job(at);
    expect(stored.fields).toEqual(render.mock.calls[0]?.[1]);
    expect(isOpenJob(stored)).toBe(true);
  });

  it("takes the layout of the snapshot's template revision, not the station's newer copy of it", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    // The office widened the template after the shift opened; the copy has the new revision.
    at.db
      .prepare(
        "INSERT INTO ref_templates (id, name, purpose, enabled, stock, spec, rev) " +
          "VALUES (?, 'Молоко 100×150', 'box', 1, 0, ?, 63)",
      )
      .run(
        "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
        JSON.stringify({
          ...at.shift.snapshot.boxTemplate.spec,
          widthMm: 100,
          heightMm: 150,
        }),
      );
    await closeWithLabel(at);
    expect(jobRows(at.db)[0]).toMatchObject({
      template_rev: 62,
      bytes_base64: renderedBase64(ZEBRA, SSCC, "58x40"),
    });
  });

  it("asks for the label check when the workstation checks labels", async () => {
    const at = await station();
    await setUpPrinting(at.local, { verifyPrintedLabel: true });
    await closeWithLabel(at);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "prepared", verify: 1 });
  });

  it("is failed for want of a printer, and the box closes all the same", async () => {
    const at = await station();
    await setUpPrinting(at.local, {
      assignments: { box: null, pallet: "zebra", duplicate: "tsc" },
    });
    const closed = await closeWithLabel(at);
    expect(closed.kind).toBe("closed");
    expect(jobRows(at.db)[0]).toMatchObject({
      state: "failed",
      error_code: "printer_unconfigured",
      printer: null,
      bytes_base64: null,
    });
  });

  it("is failed when the label does not render, and keeps the printer it was for", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    const closed = await closeWithLabel(at, at.local, async () => {
      throw new Error("RasterTooLargeError");
    });
    expect(closed.kind).toBe("closed");
    expect(jobRows(at.db)[0]).toMatchObject({
      state: "failed",
      error_code: "render_failed",
      printer: JSON.stringify(ZEBRA),
      bytes_base64: null,
    });
  });

  it("never exists for a box that did not close: a failed write leaves neither", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await expect(closeWithLabel(at, failingWrites(at.local))).rejects.toMatchObject({
      code: "statement_failed",
    });
    expect(rows(at.db, "SELECT closed_at FROM floor_boxes")).toEqual([{ closed_at: null }]);
    expect(jobRows(at.db)).toEqual([]);
  });

  it("never exists for a close the box's change undid: a stale close writes no job", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    const held = holdingWrites(at.local);
    held.holdNext();
    const closing = closeWithLabel(at, held.executor);
    await held.reached();
    // A scan landed in the box between the close's read and its write.
    at.db.prepare("UPDATE floor_boxes SET item_count = item_count + 1").run();
    held.release();
    await expect(closing).resolves.toEqual({ kind: "stale" });
    expect(jobRows(at.db)).toEqual([]);
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_sscc_blocks WHERE next_serial = 1500"),
    ).toEqual([{ n: 1 }]);
  });
});

describe("the send of a print job", () => {
  it("writes sending and the attempt before the bytes go, and sent once the shell took them", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const shell = fakeHardware();
    shell.holdSends();
    const { runtime } = manualRuntime(shell.hardware);
    const sending = sendLabelJob(printContext(at.local, runtime), await job(at));
    await vi.waitFor(() => expect(shell.heldSends()).toBe(1));
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sending", attempts: 1, error_code: null });
    expect(shell.sends).toEqual([{ target: ZEBRA.target, text: renderedText(ZEBRA, SSCC) }]);
    shell.releaseSend({ sent: true });
    await expect(sending).resolves.toMatchObject({ state: "sent", attempts: 1, errorCode: null });
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent", attempts: 1 });
  });

  it("ends failed when nothing left this computer, and unknown when a label may exist", async () => {
    const cases = [
      [{ kind: "answered", result: { sent: false, code: "not_sent" } }, "failed", "not_sent"],
      [{ kind: "answered", result: { sent: false, code: "unsupported" } }, "failed", "unsupported"],
      [
        { kind: "answered", result: { sent: false, code: "invalid_target" } },
        "failed",
        "invalid_target",
      ],
      [
        { kind: "answered", result: { sent: false, code: "invalid_payload" } },
        "failed",
        "invalid_payload",
      ],
      [
        { kind: "answered", result: { sent: false, code: "outcome_unknown" } },
        "unknown",
        "outcome_unknown",
      ],
      [{ kind: "timeout" }, "unknown", "timeout"],
      [{ kind: "busy" }, "failed", "printer_busy"],
    ] as const;
    for (const [outcome, state, code] of cases) {
      expect(settleOutcome(outcome)).toEqual({ state, code });
    }
    expect(settleOutcome({ kind: "answered", result: { sent: true } })).toEqual({ state: "sent" });

    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const shell = fakeHardware(async () => ({ sent: false, code: "outcome_unknown" }));
    const { runtime } = manualRuntime(shell.hardware);
    await expect(
      sendLabelJob(printContext(at.local, runtime), await job(at)),
    ).resolves.toMatchObject({ state: "unknown", errorCode: "outcome_unknown", attempts: 1 });
  });

  it("ends unknown, never sent, when the shell does not answer within the limit", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const shell = fakeHardware();
    shell.holdSends();
    const { runtime, expire } = manualRuntime(shell.hardware);
    const sending = sendLabelJob(printContext(at.local, runtime), await job(at));
    await vi.waitFor(() => expect(shell.heldSends()).toBe(1));
    expire();
    await expect(sending).resolves.toMatchObject({ state: "unknown", errorCode: "timeout" });
    // The answer that comes late changes nothing.
    shell.releaseSend({ sent: true });
    await flushPromises();
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown", error_code: "timeout" });
  });

  it("refuses a job moved on meanwhile, and leaves it as it was moved", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const shell = fakeHardware();
    shell.holdSends();
    const { runtime } = manualRuntime(shell.hardware);
    const sending = sendLabelJob(printContext(at.local, runtime), await job(at));
    await vi.waitFor(() => expect(shell.heldSends()).toBe(1));
    at.db
      .prepare("UPDATE floor_print_jobs SET state = 'unknown', error_code = 'interrupted'")
      .run();
    shell.releaseSend({ sent: true });
    await expect(sending).rejects.toBeInstanceOf(StaleJobError);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown", error_code: "interrupted" });

    // A stale read is refused before anything is sent.
    const read = await job(at);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'").run();
    await expect(sendLabelJob(printContext(at.local, runtime), read)).rejects.toBeInstanceOf(
      StaleJobError,
    );
    expect(shell.sends).toHaveLength(1);
  });

  it("refuses a job without bytes and a job that is done with, and sends nothing", async () => {
    const at = await station();
    await setUpPrinting(at.local, { assignments: { box: null, pallet: null, duplicate: null } });
    await closeWithLabel(at);
    const shell = fakeHardware();
    const { runtime } = manualRuntime(shell.hardware);
    await expect(
      sendLabelJob(printContext(at.local, runtime), await job(at)),
    ).rejects.toBeInstanceOf(UnsendableJobError);
    const done: PrintJob = {
      ...(await job(at)),
      state: "verified",
      bytesBase64: "XlhB",
      printer: TSC,
    };
    await expect(sendLabelJob(printContext(at.local, runtime), done)).rejects.toBeInstanceOf(
      UnsendableJobError,
    );
    expect(shell.sends).toEqual([]);
  });
});

describe("the recovery of interrupted jobs", () => {
  it("reads a job left sending as unknown, and sends nothing by itself", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sending', attempts = 1").run();
    const shell = fakeHardware();
    const { runtime } = manualRuntime(shell.hardware);
    await expect(recoverInterruptedJobs(printContext(at.local, runtime))).resolves.toBe(1);
    expect(jobRows(at.db)[0]).toMatchObject({
      state: "unknown",
      error_code: "interrupted",
      attempts: 1,
    });
    expect(shell.hardware.printBytes).not.toHaveBeenCalled();
    await expect(recoverInterruptedJobs(printContext(at.local, runtime))).resolves.toBe(0);
  });

  it("leaves a job whose bytes this app's send still holds, and another pairing's jobs", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    at.db
      .prepare(
        "INSERT INTO floor_print_jobs (id, host_id, device_id, shift_id, purpose, subject_id, " +
          "sscc, state, verify, template_id, template_rev, fields, printer, bytes_base64, " +
          "attempts, operator_id, created_at, updated_at) SELECT 'job-other', host_id, ?, " +
          "shift_id, purpose, 'box-other', sscc, 'sending', verify, template_id, template_rev, " +
          "fields, printer, bytes_base64, 1, operator_id, created_at, updated_at " +
          "FROM floor_print_jobs WHERE id = 'job-1'",
      )
      .run(OTHER_DEVICE);
    const shell = fakeHardware();
    shell.holdSends();
    const { runtime } = manualRuntime(shell.hardware);
    const context = printContext(at.local, runtime);
    const sending = sendLabelJob(context, await job(at));
    await vi.waitFor(() => expect(shell.heldSends()).toBe(1));
    await expect(recoverInterruptedJobs(context)).resolves.toBe(0);
    expect(rows(at.db, "SELECT id, state FROM floor_print_jobs ORDER BY id")).toEqual([
      { id: "job-1", state: "sending" },
      { id: "job-other", state: "sending" },
    ]);
    shell.releaseSend({ sent: true });
    await expect(sending).resolves.toMatchObject({ state: "sent" });
  });
});

describe("the open job of a shift", () => {
  it("is the oldest one waiting for the printer or the operator, of this pairing only", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const insert = (
      id: string,
      state: string,
      verify: number,
      createdAt: string,
      device = PAIRING.deviceId,
    ) =>
      at.db
        .prepare(
          "INSERT INTO floor_print_jobs (id, host_id, device_id, shift_id, purpose, subject_id, " +
            "sscc, state, verify, template_id, template_rev, fields, printer, bytes_base64, " +
            "error_code, attempts, operator_id, created_at, updated_at) SELECT ?, host_id, ?, " +
            "shift_id, purpose, ?, sscc, ?, ?, template_id, template_rev, fields, printer, " +
            "bytes_base64, NULL, 1, operator_id, ?, ? FROM floor_print_jobs WHERE id = 'job-1'",
        )
        .run(id, device, `box-${id}`, state, verify, createdAt, createdAt);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sent', attempts = 1").run();
    insert("done-verified", "verified", 1, "2026-10-08T06:00:00.000Z");
    insert("done-sent", "sent", 0, "2026-10-08T06:00:01.000Z");
    insert("other-pairing", "sent", 1, "2026-10-08T06:00:02.000Z", OTHER_DEVICE);
    await expect(readOpenJob(at.local, PAIRING, SHIFT_ID)).resolves.toBeNull();
    insert("awaiting", "sent", 1, "2026-10-08T06:00:04.000Z");
    insert("awaiting-older", "sent", 1, "2026-10-08T06:00:03.000Z");
    await expect(readOpenJob(at.local, PAIRING, SHIFT_ID)).resolves.toMatchObject({
      id: "awaiting-older",
      verify: true,
    });
    await expect(readOpenJob(at.local, PAIRING, "another-shift")).resolves.toBeNull();
  });

  it("keeps the shift's labels unsettled while any job of it waits, even one that cannot be read", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    const settled = () => shiftLabelsSettled(at.local, PAIRING, SHIFT_ID);
    for (const [state, verify, code] of [
      ["prepared", 0, null],
      ["sending", 0, null],
      ["failed", 0, "not_sent"],
      ["unknown", 0, "timeout"],
      ["sent", 1, null],
    ] as const) {
      at.db
        .prepare("UPDATE floor_print_jobs SET state = ?, verify = ?, error_code = ?, attempts = ?")
        .run(state, verify, code, state === "prepared" ? 0 : 1);
      await expect(settled(), state).resolves.toBe(false);
    }
    for (const [state, verify] of [
      ["sent", 0],
      ["verified", 1],
      ["skipped", 1],
    ] as const) {
      at.db
        .prepare(
          "UPDATE floor_print_jobs SET state = ?, verify = ?, error_code = NULL, attempts = 1",
        )
        .run(state, verify);
      await expect(settled(), state).resolves.toBe(true);
    }
    // A waiting job of another shift or another pairing is not this shift's.
    at.db
      .prepare(
        "UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent', shift_id = 'another'",
      )
      .run();
    await expect(settled()).resolves.toBe(true);
    at.db
      .prepare("UPDATE floor_print_jobs SET shift_id = ?, device_id = ?")
      .run(SHIFT_ID, OTHER_DEVICE);
    await expect(settled()).resolves.toBe(true);
    // A waiting job whose printer cannot be read still waits.
    at.db
      .prepare('UPDATE floor_print_jobs SET device_id = ?, printer = \'{"id":"zebra"}\'')
      .run(PAIRING.deviceId);
    await expect(settled()).resolves.toBe(false);
  });

  it("refuses a stored job whose printer cannot be read", async () => {
    const at = await station();
    await setUpPrinting(at.local);
    await closeWithLabel(at);
    at.db.prepare('UPDATE floor_print_jobs SET printer = \'{"id":"zebra"}\'').run();
    await expect(readOpenJob(at.local, PAIRING, SHIFT_ID)).rejects.toBeInstanceOf(
      UnreadableJobError,
    );
  });
});
```

Создать `apps/standalone/test/floor-print-runtime.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import {
  createPrintRuntime,
  PRINT_SEND_LIMIT_MS,
  type StartTimer,
} from "../src/floor/print/print-runtime.js";
import type { HardwareApi, PrintResult, PrintTarget } from "../src/hardware/hardware.js";

const ZEBRA: PrintTarget = { kind: "tcp", host: "192.168.1.50", port: 9100 };
const ZEBRA_AGAIN: PrintTarget = { kind: "tcp", host: "192.168.1.50.", port: 9100 };
const TSC: PrintTarget = { kind: "serial", port: "COM4", baud: 9600 };
const BYTES = new Uint8Array([0x5e, 0x58, 0x41]);

/** Timers the test fires by hand: nothing here waits for real time. */
function manualTimers() {
  const timers: { ms: number; fire: () => void; live: boolean }[] = [];
  const startTimer: StartTimer = (ms, fire) => {
    const timer = { ms, fire, live: true };
    timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  return {
    startTimer,
    timers,
    /** Fires every timer still running, as if the limit ran out now. */
    expire: () => {
      for (const timer of timers.filter((candidate) => candidate.live)) {
        timer.live = false;
        timer.fire();
      }
    },
  };
}

/** A shell whose sends wait until the test answers them, in order. */
function heldPrinter() {
  const calls: { target: PrintTarget; answer: (result: PrintResult) => void }[] = [];
  const printBytes = vi.fn<HardwareApi["printBytes"]>(
    (target) =>
      new Promise<PrintResult>((resolve) => {
        calls.push({ target, answer: resolve });
      }),
  );
  return { printBytes, calls };
}

/** Lets the promise callbacks queued so far run. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("the printers' runtime", () => {
  it("gives the bytes to the shell and answers with its answer; the job is in flight until then", async () => {
    const timers = manualTimers();
    const shell = heldPrinter();
    const runtime = createPrintRuntime(shell.printBytes, { startTimer: timers.startTimer });
    const sent = runtime.send("job-1", ZEBRA, BYTES);
    await flush();
    expect(shell.printBytes).toHaveBeenCalledWith(ZEBRA, BYTES);
    expect(runtime.isInFlight("job-1")).toBe(true);
    expect(runtime.inFlight()).toEqual(["job-1"]);
    expect(timers.timers.map((timer) => timer.ms)).toEqual([PRINT_SEND_LIMIT_MS]);
    shell.calls[0]?.answer({ sent: false, code: "not_sent" });
    await expect(sent).resolves.toEqual({
      kind: "answered",
      result: { sent: false, code: "not_sent" },
    });
    await flush();
    expect(runtime.isInFlight("job-1")).toBe(false);
    // The answer stopped the limit: nothing fires later.
    expect(timers.timers[0]?.live).toBe(false);
  });

  it("sends to one address one at a time, and to another address meanwhile", async () => {
    const timers = manualTimers();
    const shell = heldPrinter();
    const runtime = createPrintRuntime(shell.printBytes, { startTimer: timers.startTimer });
    const first = runtime.send("job-1", ZEBRA, BYTES);
    const second = runtime.send("job-2", ZEBRA_AGAIN, BYTES);
    const other = runtime.send("job-3", TSC, BYTES);
    await flush();
    // The same printer written another way waits; the COM printer does not.
    expect(shell.calls.map((call) => call.target)).toEqual([ZEBRA, TSC]);
    expect(runtime.isInFlight("job-2")).toBe(true);
    shell.calls[0]?.answer({ sent: true });
    await expect(first).resolves.toEqual({ kind: "answered", result: { sent: true } });
    await flush();
    expect(shell.calls.map((call) => call.target)).toEqual([ZEBRA, TSC, ZEBRA_AGAIN]);
    shell.calls[2]?.answer({ sent: true });
    shell.calls[1]?.answer({ sent: true });
    await expect(second).resolves.toEqual({ kind: "answered", result: { sent: true } });
    await expect(other).resolves.toEqual({ kind: "answered", result: { sent: true } });
  });

  it("answers timeout for bytes the shell holds past the limit, and keeps the job in flight", async () => {
    const timers = manualTimers();
    const shell = heldPrinter();
    const runtime = createPrintRuntime(shell.printBytes, { startTimer: timers.startTimer });
    const stuck = runtime.send("job-1", ZEBRA, BYTES);
    await flush();
    timers.expire();
    await expect(stuck).resolves.toEqual({ kind: "timeout" });
    expect(runtime.isInFlight("job-1")).toBe(true);
    // A late answer changes nothing that was said, and ends the flight.
    shell.calls[0]?.answer({ sent: true });
    await flush();
    expect(runtime.isInFlight("job-1")).toBe(false);
  });

  it("never gives the shell bytes whose limit ran out while an earlier send held the printer", async () => {
    const timers = manualTimers();
    const shell = heldPrinter();
    const runtime = createPrintRuntime(shell.printBytes, { startTimer: timers.startTimer });
    const stuck = runtime.send("job-1", ZEBRA, BYTES);
    const queued = runtime.send("job-2", ZEBRA, BYTES);
    await flush();
    timers.expire();
    await expect(stuck).resolves.toEqual({ kind: "timeout" });
    await expect(queued).resolves.toEqual({ kind: "busy" });
    // The stuck call settles at last: the queued bytes still do not go.
    shell.calls[0]?.answer({ sent: true });
    await flush();
    expect(shell.printBytes).toHaveBeenCalledTimes(1);
    expect(runtime.inFlight()).toEqual([]);
    // The next send goes at once.
    const next = runtime.send("job-3", ZEBRA, BYTES);
    await flush();
    expect(shell.printBytes).toHaveBeenCalledTimes(2);
    shell.calls[1]?.answer({ sent: true });
    await expect(next).resolves.toEqual({ kind: "answered", result: { sent: true } });
  });

  it("reads a failed IPC call as outcome_unknown and keeps the queue going", async () => {
    const timers = manualTimers();
    const printBytes = vi
      .fn<HardwareApi["printBytes"]>()
      .mockRejectedValueOnce(new Error("ipc gone"))
      .mockResolvedValueOnce({ sent: true });
    const runtime = createPrintRuntime(printBytes, { startTimer: timers.startTimer });
    await expect(runtime.send("job-1", ZEBRA, BYTES)).resolves.toEqual({
      kind: "answered",
      result: { sent: false, code: "outcome_unknown" },
    });
    await expect(runtime.send(null, ZEBRA, BYTES)).resolves.toEqual({
      kind: "answered",
      result: { sent: true },
    });
    expect(runtime.inFlight()).toEqual([]);
  });

  it("waits for a real limit by default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shell = heldPrinter();
      const runtime = createPrintRuntime(shell.printBytes, { limitMs: 1_000 });
      const stuck = runtime.send("job-1", ZEBRA, BYTES);
      await vi.advanceTimersByTimeAsync(999);
      const early = await Promise.race([stuck, Promise.resolve("waiting")]);
      expect(early).toBe("waiting");
      await vi.advanceTimersByTimeAsync(1);
      await expect(stuck).resolves.toEqual({ kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
```

Правка `apps/standalone/test/support/printing.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import type { RasterizeTextFn } from "@markiro/domain";

/** A rasterizer that draws every text as the same 8 x 2 bitmap: jsdom has no canvas. */
```

заменить на:

<!-- prettier-ignore -->
```ts
import type { RasterizeTextFn } from "@markiro/domain";
import type { DatabaseSync } from "node:sqlite";

import { vi } from "vitest";

import { latin1ToBytes } from "../../src/floor/print/label-render.js";
import type { RenderLabel } from "../../src/floor/print/print-jobs.js";
import { createPrintRuntime, type StartTimer } from "../../src/floor/print/print-runtime.js";
import {
  DEFAULT_WORKSTATION_SETTINGS,
  saveWorkstationSettings,
  type PrinterProfile,
  type WorkstationSettings,
} from "../../src/floor/setup/workstation-settings.js";
import type { HardwareApi } from "../../src/hardware/hardware.js";
import type { LocalExecutor } from "../../src/local/executor.js";
import { rows } from "./floor-work.js";

/** A rasterizer that draws every text as the same 8 x 2 bitmap: jsdom has no canvas. */
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
});
```

заменить на:

<!-- prettier-ignore -->
```ts
});

/** The Zebra at the line: ZPL, 203 dpi, on the network. */
export const ZEBRA: PrinterProfile = {
  id: "zebra",
  name: "Zebra у линии",
  target: { kind: "tcp", host: "192.168.1.50", port: 9100 },
  language: "zpl",
  dpi: 203,
};

/** A TSC on a COM port: TSPL, 300 dpi. */
export const TSC: PrinterProfile = {
  id: "tsc",
  name: "TSC на COM4",
  target: { kind: "serial", port: "COM4", baud: 9600 },
  language: "tspl",
  dpi: 300,
};

/** Settings with the Zebra for boxes and the TSC on the side. */
export function printingSettings(
  overrides: Partial<WorkstationSettings> = {},
): WorkstationSettings {
  return {
    ...DEFAULT_WORKSTATION_SETTINGS,
    printers: [ZEBRA, TSC],
    assignments: { box: "zebra", pallet: null, duplicate: null },
    ...overrides,
  };
}

/** Stores `printingSettings(overrides)` on this computer. */
export async function setUpPrinting(
  local: LocalExecutor,
  overrides: Partial<WorkstationSettings> = {},
): Promise<WorkstationSettings> {
  const settings = printingSettings(overrides);
  await saveWorkstationSettings(local, settings);
  return settings;
}

/**
 * A render that writes what it was asked in plain ASCII: the language, the
 * resolution, the layout's size and element count, the SSCC — so a test sees
 * which printer and which layout a label's bytes were made for.
 */
export const fakeRender: RenderLabel = async (spec, fields, printer) =>
  latin1ToBytes(
    `^XA ${printer.language} ${printer.dpi} ${spec.widthMm}x${spec.heightMm} ` +
      `${spec.elements.length} ${fields.sscc} ^XZ`,
  );

/** The text `fakeRender` writes for this printer, layout size and SSCC. */
export function renderedText(
  printer: Pick<PrinterProfile, "language" | "dpi">,
  sscc: string,
  size = "58x40",
  elements = 1,
): string {
  return `^XA ${printer.language} ${printer.dpi} ${size} ${elements} ${sscc} ^XZ`;
}

/** The base64 of `renderedText`, as a job keeps it. */
export function renderedBase64(
  printer: Pick<PrinterProfile, "language" | "dpi">,
  sscc: string,
  size = "58x40",
  elements = 1,
): string {
  return btoa(renderedText(printer, sscc, size, elements));
}

/** Timers the test fires by hand: nothing waits for real time. */
export function manualTimers() {
  const timers: { ms: number; fire: () => void; live: boolean }[] = [];
  const startTimer: StartTimer = (ms, fire) => {
    const timer = { ms, fire, live: true };
    timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  return {
    startTimer,
    timers,
    /** Fires every timer still running, as if the limit ran out now. */
    expire: () => {
      for (const timer of timers.filter((candidate) => candidate.live)) {
        timer.live = false;
        timer.fire();
      }
    },
  };
}

/** A runtime over `hardware` whose limit runs out only when the test says. */
export function manualRuntime(hardware: Pick<HardwareApi, "printBytes">) {
  const timers = manualTimers();
  return {
    runtime: createPrintRuntime(hardware.printBytes, { startTimer: timers.startTimer }),
    expire: timers.expire,
  };
}

/** The print jobs as stored, oldest first, with the columns a test reads. */
export function jobRows(db: DatabaseSync): Record<string, unknown>[] {
  return rows(
    db,
    "SELECT id, purpose, subject_id, sscc, state, verify, template_id, template_rev, printer, " +
      "bytes_base64, error_code, attempts, operator_id, created_at FROM floor_print_jobs " +
      "ORDER BY created_at, id",
  );
}

/** Lets the promise callbacks queued so far run. */
export async function flushPromises(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

/** A shell spy for one test: `vi.fn` over a real answer. */
export function spyRender(render: RenderLabel = fakeRender) {
  return vi.fn<RenderLabel>(render);
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-jobs.test.ts test/floor-print-runtime.test.ts`
Expected: FAIL — `test/floor-print-runtime.test.ts` и `test/floor-print-jobs.test.ts` не загружаются (`Failed to resolve import "../src/floor/print/print-runtime.js"`, `"../src/floor/print/print-jobs.js"`).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/floor/print/print-jobs.ts`:

<!-- prettier-ignore -->
```ts
import { LABEL_FIELDS, type LabelTemplateSpec } from "@markiro/domain";
import { z } from "zod";

import { bytesToBase64 } from "../../hardware/hardware.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import {
  parsePrinterProfile,
  readWorkstationSettings,
  resolvePrinter,
  type PrinterProfile,
  type WorkstationSettings,
} from "../setup/workstation-settings.js";
import type { WorkShift } from "../shifts/shift-copies.js";
import type { CloseStep } from "../work/box-close.js";
import { boxLabelData, renderLabel, type LabelFields, type LabelPrinter } from "./label-render.js";
import type { PrintRuntime, SendOutcome } from "./print-runtime.js";

/** What a label is for: a box, or a pallet of the pallets' plan (ПЛ-Ц). */
export const LABEL_PURPOSES = ["box", "pallet"] as const;
export type LabelPurpose = (typeof LABEL_PURPOSES)[number];

/** A print job's states (stage 2a spec, decision 19; migration `0007`). */
export const PRINT_JOB_STATES = [
  "prepared",
  "sending",
  "sent",
  "failed",
  "unknown",
  "verified",
  "skipped",
] as const;
export type PrintJobState = (typeof PRINT_JOB_STATES)[number];

/**
 * Why a job failed — nothing left this computer, so a new send cannot double
 * a label: no printer for the purpose, a label that would not render, the
 * shell's `not_sent`, `invalid_target`, `invalid_payload`, `unsupported`,
 * and `printer_busy` — the send's limit ran out while an earlier send to the
 * same address still had the printer.
 */
export const FAILED_CODES = [
  "printer_unconfigured",
  "render_failed",
  "not_sent",
  "invalid_target",
  "invalid_payload",
  "unsupported",
  "printer_busy",
] as const;
/**
 * Why a job's outcome is unknown — a label may exist: the shell's
 * `outcome_unknown`, no answer within the limit (`timeout`), and a job found
 * `sending` after a restart or a lost write (`interrupted`).
 */
export const UNKNOWN_CODES = ["outcome_unknown", "timeout", "interrupted"] as const;
export type FailedCode = (typeof FAILED_CODES)[number];
export type UnknownCode = (typeof UNKNOWN_CODES)[number];
export type PrintJobCode = FailedCode | UnknownCode;

/** A print job as stored, read for the current pairing. */
export interface PrintJob {
  id: string;
  shiftId: string;
  purpose: LabelPurpose;
  subjectId: string;
  sscc: string;
  state: PrintJobState;
  /** The label is checked by a scan of its SSCC once sent. */
  verify: boolean;
  templateId: string;
  templateRev: number;
  /** The label's fields, kept to render it again for another printer. */
  fields: LabelFields;
  /** The profile the bytes were rendered for; `null` — no printer was assigned. */
  printer: PrinterProfile | null;
  bytesBase64: string | null;
  errorCode: PrintJobCode | null;
  attempts: number;
  operatorId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A job that waits for the printer or for the operator: prepared, sending,
 * failed, unknown, or sent with a check not done yet. The next box does not
 * close while one waits (the unique index `floor_print_jobs_open` holds one
 * per label).
 */
export function isOpenJob(job: Pick<PrintJob, "state" | "verify">): boolean {
  return (
    job.state === "prepared" ||
    job.state === "sending" ||
    job.state === "failed" ||
    job.state === "unknown" ||
    (job.state === "sent" && job.verify)
  );
}

/** The same rule in SQL, word for word the index's. */
const OPEN =
  "(state IN ('prepared', 'sending', 'failed', 'unknown') OR (state = 'sent' AND verify = 1))";

const COLUMNS =
  "id, shift_id, purpose, subject_id, sscc, state, verify, template_id, template_rev, " +
  "fields, printer, bytes_base64, error_code, attempts, operator_id, created_at, updated_at";

const jobRow = z.object({
  id: z.string(),
  shift_id: z.string(),
  purpose: z.enum(LABEL_PURPOSES),
  subject_id: z.string(),
  sscc: z.string(),
  state: z.enum(PRINT_JOB_STATES),
  verify: z.union([z.literal(0), z.literal(1)]),
  template_id: z.string(),
  template_rev: z.number().int(),
  fields: z.string(),
  printer: z.string().nullable(),
  bytes_base64: z.string().nullable(),
  error_code: z.enum([...FAILED_CODES, ...UNKNOWN_CODES]).nullable(),
  attempts: z.number().int(),
  operator_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** Every field of the domain, each a string: what `boxLabelData` gives. */
const fieldsSchema = z.record(z.enum(LABEL_FIELDS), z.string());

/** A stored job this build cannot read: its printer profile or its fields are damaged. */
export class UnreadableJobError extends Error {
  constructor(id: string) {
    super(`print job ${id} cannot be read`);
    this.name = "UnreadableJobError";
  }
}

function toJob(row: z.infer<typeof jobRow>): PrintJob {
  let printer: PrinterProfile | null = null;
  let fields: LabelFields;
  try {
    if (row.printer !== null) {
      printer = parsePrinterProfile(JSON.parse(row.printer));
      if (printer === null) throw new UnreadableJobError(row.id);
    }
    fields = fieldsSchema.parse(JSON.parse(row.fields));
  } catch {
    throw new UnreadableJobError(row.id);
  }
  return {
    id: row.id,
    shiftId: row.shift_id,
    purpose: row.purpose,
    subjectId: row.subject_id,
    sscc: row.sscc,
    state: row.state,
    verify: row.verify === 1,
    templateId: row.template_id,
    templateRev: row.template_rev,
    fields,
    printer,
    bytesBase64: row.bytes_base64,
    errorCode: row.error_code,
    attempts: row.attempts,
    operatorId: row.operator_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The job `id` of the current pairing, or `null`. */
export async function readPrintJob(
  local: LocalExecutor,
  pairing: Pairing,
  id: string,
): Promise<PrintJob | null> {
  const [row] = await local.query(
    `SELECT ${COLUMNS} FROM floor_print_jobs WHERE host_id = ? AND device_id = ? AND id = ?`,
    [pairing.hostId, pairing.deviceId, id],
    jobRow,
  );
  return row === undefined ? null : toJob(row);
}

/** The oldest job of the shift that waits for the printer or the operator, or `null`. */
export async function readOpenJob(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<PrintJob | null> {
  const [row] = await local.query(
    `SELECT ${COLUMNS} FROM floor_print_jobs WHERE host_id = ? AND device_id = ? ` +
      `AND shift_id = ? AND ${OPEN} ORDER BY created_at, id LIMIT 1`,
    [pairing.hostId, pairing.deviceId, shiftId],
    jobRow,
  );
  return row === undefined ? null : toJob(row);
}

/**
 * Every label of the shift is done with: verified, skipped, or sent without a
 * check — no job of it can write a `box_label` record any more. Plan 2a8
 * closes a shift only then: a label decided after the shift's close would
 * reach the host after `shift_closed` and mark the station's own shift late
 * (`late_data_at`, plan 2a2). Counted, not read: a waiting job this build
 * cannot read still keeps the shift open.
 */
export async function shiftLabelsSettled(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<boolean> {
  const [row] = await local.query(
    `SELECT count(*) AS waiting FROM floor_print_jobs WHERE host_id = ? AND device_id = ? ` +
      `AND shift_id = ? AND ${OPEN}`,
    [pairing.hostId, pairing.deviceId, shiftId],
    z.object({ waiting: z.number().int() }),
  );
  return row?.waiting === 0;
}

/** How a label is rendered; the app's rasterizer by default, a test's own otherwise. */
export type RenderLabel = (
  spec: LabelTemplateSpec,
  fields: LabelFields,
  printer: LabelPrinter,
) => Promise<Uint8Array>;

/** What a new job is made from. */
export interface NewLabel {
  id: string;
  shiftId: string;
  purpose: LabelPurpose;
  subjectId: string;
  sscc: string;
  fields: LabelFields;
  /** The shift snapshot's template: its id, revision and layout. */
  template: { id: string; rev: number; spec: LabelTemplateSpec };
  operatorId: string;
  createdAt: string;
}

/**
 * The row of a new job, for the transaction that closes its box or pallet:
 * the printer of its purpose, the bytes rendered for it — `prepared` — or,
 * when no printer is assigned or the label does not render, `failed` with the
 * reason: the box closes all the same, and the operator decides at the
 * recovery screen. The label check is the workstation's setting now.
 */
export async function prepareLabelJob(
  label: NewLabel,
  settings: Pick<WorkstationSettings, "printers" | "assignments" | "verifyPrintedLabel">,
  pairing: Pairing,
  render: RenderLabel = renderLabel,
): Promise<LocalStatement> {
  const printer = resolvePrinter(settings, label.purpose);
  let bytes: string | null = null;
  let error: FailedCode | null = printer === null ? "printer_unconfigured" : null;
  if (printer !== null) {
    try {
      bytes = bytesToBase64(await render(label.template.spec, label.fields, printer));
    } catch {
      error = "render_failed";
    }
  }
  return {
    sql:
      `INSERT INTO floor_print_jobs (host_id, device_id, ${COLUMNS}) ` +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
    values: [
      pairing.hostId,
      pairing.deviceId,
      label.id,
      label.shiftId,
      label.purpose,
      label.subjectId,
      label.sscc,
      error === null ? "prepared" : "failed",
      settings.verifyPrintedLabel ? 1 : 0,
      label.template.id,
      label.template.rev,
      JSON.stringify(label.fields),
      printer === null ? null : JSON.stringify(printer),
      bytes,
      error,
      label.operatorId,
      label.createdAt,
      label.createdAt,
    ],
    expectedChanges: 1,
  };
}

/**
 * The box close's step of plan 2a7 (`CloseStep`, plan 2a6): the box's print
 * job, rendered from the shift's snapshot with the SSCC, the count and the
 * time of the close, joins the close's own transaction — the box never
 * closes without its job, and no job exists for a box that did not close.
 * The workstation's settings are read at each close, so a printer set up a
 * minute ago prints the next box.
 */
export function boxLabelStep(deps: {
  local: LocalExecutor;
  pairing: Pairing;
  shift: WorkShift;
  operatorName: string | null;
  newId: () => string;
  render?: RenderLabel;
}): CloseStep {
  return async (box) => {
    const settings = await readWorkstationSettings(deps.local);
    const { boxTemplate } = deps.shift.snapshot;
    const statement = await prepareLabelJob(
      {
        id: deps.newId(),
        shiftId: box.shiftId,
        purpose: "box",
        subjectId: box.boxId,
        sscc: box.sscc,
        fields: boxLabelData(deps.shift, box, deps.operatorName),
        template: { id: boxTemplate.id, rev: boxTemplate.rev, spec: boxTemplate.spec },
        operatorId: box.operatorId,
        createdAt: box.closedAt,
      },
      settings,
      deps.pairing,
      deps.render,
    );
    return { statements: [statement] };
  };
}

/** The job changed between the read and the write: someone else moved it on. */
export class StaleJobError extends Error {
  constructor(id: string) {
    super(`print job ${id} changed meanwhile`);
    this.name = "StaleJobError";
  }
}

/** A job that cannot be sent as it is: no bytes or no printer, or a state no send starts from. */
export class UnsendableJobError extends Error {
  constructor(id: string, state: PrintJobState) {
    super(`print job ${id} cannot be sent from ${state}`);
    this.name = "UnsendableJobError";
  }
}

/** The bytes of a stored label. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Where a send leaves a job: `sent` only on the shell's `{ sent: true }`. */
export function settleOutcome(
  outcome: SendOutcome,
):
  | { state: "sent" }
  | { state: "failed"; code: FailedCode }
  | { state: "unknown"; code: UnknownCode } {
  if (outcome.kind === "timeout") return { state: "unknown", code: "timeout" };
  if (outcome.kind === "busy") return { state: "failed", code: "printer_busy" };
  const { result } = outcome;
  if (result.sent) return { state: "sent" };
  if (result.code === "outcome_unknown") return { state: "unknown", code: "outcome_unknown" };
  return { state: "failed", code: result.code };
}

/** What a send needs: the database, the pairing, the printers, a clock. */
export interface PrintContext {
  local: LocalExecutor;
  pairing: Pairing;
  runtime: PrintRuntime;
  now: () => Date;
}

/** The states a send may start from: a first send, a retry the operator chose, a reprint with a reason. */
const SEND_FROM: readonly PrintJobState[] = ["prepared", "failed", "unknown", "sent"];

/** What a send changes besides the state: another printer's profile and bytes, the reprint's records. */
export interface SendOptions {
  /** The job's new printer and the bytes rendered for it, written with `sending`. */
  rebind?: { printer: PrinterProfile; bytesBase64: string };
  /** Written in the same transaction as `sending`: a reprint's exception and its record. */
  extra?: readonly LocalStatement[];
}

/**
 * Sends a job's bytes (stage 2a spec §5.7.5). `sending` and one more attempt
 * are written BEFORE the bytes go — together with the new printer and bytes
 * of `rebind` and the statements of `extra` (the reprint's exception when the
 * operator sends a label that may already exist) — so a crash in between
 * leaves `sending`, which a restart reads as `unknown`.
 * Then one send through the runtime and one write of where it ended: `sent`
 * only on the shell's `{ sent: true }`, `failed` when nothing left this
 * computer, `unknown` otherwise. Each write compares the job with what was
 * read (`StaleJobError` otherwise), so a late answer never overwrites a job
 * the recovery or the operator moved on. Nothing here ever sends a job
 * again by itself: every send after the first is the operator's.
 */
export async function sendLabelJob(
  context: PrintContext,
  job: PrintJob,
  options: SendOptions = {},
): Promise<PrintJob> {
  const { local, pairing, runtime } = context;
  const printer = options.rebind?.printer ?? job.printer;
  const bytesBase64 = options.rebind?.bytesBase64 ?? job.bytesBase64;
  if (printer === null || bytesBase64 === null || !SEND_FROM.includes(job.state)) {
    throw new UnsendableJobError(job.id, job.state);
  }
  const attempt = job.attempts + 1;
  try {
    await local.transaction([
      {
        sql:
          "UPDATE floor_print_jobs SET state = 'sending', attempts = ?, error_code = NULL, " +
          "printer = ?, bytes_base64 = ?, updated_at = ? " +
          "WHERE host_id = ? AND device_id = ? AND id = ? AND state = ? AND attempts = ?",
        values: [
          attempt,
          JSON.stringify(printer),
          bytesBase64,
          context.now().toISOString(),
          pairing.hostId,
          pairing.deviceId,
          job.id,
          job.state,
          job.attempts,
        ],
        expectedChanges: 1,
      },
      ...(options.extra ?? []),
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleJobError(job.id);
    }
    throw error;
  }
  const outcome = await runtime.send(job.id, printer.target, base64ToBytes(bytesBase64));
  const settled = settleOutcome(outcome);
  try {
    await local.transaction([
      {
        sql:
          "UPDATE floor_print_jobs SET state = ?, error_code = ?, updated_at = ? " +
          "WHERE host_id = ? AND device_id = ? AND id = ? AND state = 'sending' AND attempts = ?",
        values: [
          settled.state,
          settled.state === "sent" ? null : settled.code,
          context.now().toISOString(),
          pairing.hostId,
          pairing.deviceId,
          job.id,
          attempt,
        ],
        expectedChanges: 1,
      },
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleJobError(job.id);
    }
    throw error;
  }
  const after = await readPrintJob(local, pairing, job.id);
  if (after === null) throw new StaleJobError(job.id);
  return after;
}

/**
 * Turns every `sending` job of the pairing whose bytes no send of this app
 * holds into `unknown` (`interrupted`): the app stopped, or the write of a
 * send's end was lost, after the bytes may have gone. Run when the work
 * screen opens and before it reads a job to decide on; the runtime's jobs in
 * flight are left as they are. Answers how many jobs it moved.
 */
export async function recoverInterruptedJobs(context: PrintContext): Promise<number> {
  const { local, pairing, runtime } = context;
  const [changed] = await local.transaction([
    {
      sql:
        "UPDATE floor_print_jobs SET state = 'unknown', error_code = 'interrupted', updated_at = ? " +
        "WHERE host_id = ? AND device_id = ? AND state = 'sending' " +
        "AND id NOT IN (SELECT value FROM json_each(?))",
      values: [
        context.now().toISOString(),
        pairing.hostId,
        pairing.deviceId,
        JSON.stringify(runtime.inFlight()),
      ],
    },
  ]);
  return changed ?? 0;
}
```

Создать `apps/standalone/src/floor/print/print-runtime.ts`:

<!-- prettier-ignore -->
```ts
import type { HardwareApi, PrintResult, PrintTarget } from "../../hardware/hardware.js";
import { printerTargetKey } from "../setup/workstation-settings.js";

/**
 * How long the webview waits for one send's answer, from the moment it asks
 * (queue included). The shell bounds each connection and write by 5 s, but a
 * COM port's flush or a spooler call can block past its own limit, and the
 * call then never answers (plan 2a4's notes): the work screen must not wait
 * for it forever.
 */
export const PRINT_SEND_LIMIT_MS = 20_000;

/**
 * How one send went, as far as this computer knows: `answered` — the shell's
 * answer; `timeout` — the bytes went to the shell and no answer came within
 * the limit, so a label may exist; `busy` — the limit ran out while an
 * earlier send to the same address still had the printer, and these bytes
 * were never given to the shell (they never will be).
 */
export type SendOutcome =
  { kind: "answered"; result: PrintResult } | { kind: "timeout" } | { kind: "busy" };

/** A timer the runtime can stop; tests give one they fire by hand. */
export type StartTimer = (ms: number, fire: () => void) => () => void;

const realTimer: StartTimer = (ms, fire) => {
  const id = setTimeout(fire, ms);
  return () => clearTimeout(id);
};

/**
 * The printers of this app: one send at a time per address (the cloud
 * station's `serializePrinterOutput`), each answered within
 * `PRINT_SEND_LIMIT_MS`, and the jobs whose bytes the shell holds right now.
 */
export interface PrintRuntime {
  /**
   * Sends `bytes` to `target` after the sends already queued for its address.
   * Never rejects: a failed IPC call is `outcome_unknown` (`printBytes`).
   * `jobId` (a print job's, `null` for a test label) is in flight from now
   * until the shell's call really settles — past the limit too.
   */
  send: (jobId: string | null, target: PrintTarget, bytes: Uint8Array) => Promise<SendOutcome>;
  /** The job's bytes are with the shell, or wait for their turn. */
  isInFlight: (jobId: string) => boolean;
  /** Every job in flight (the recovery of interrupted jobs skips them). */
  inFlight: () => string[];
}

export function createPrintRuntime(
  printBytes: HardwareApi["printBytes"],
  options: { limitMs?: number; startTimer?: StartTimer } = {},
): PrintRuntime {
  const { limitMs = PRINT_SEND_LIMIT_MS, startTimer = realTimer } = options;
  const tails = new Map<string, Promise<void>>();
  const flying = new Map<string, number>();

  function hold(jobId: string | null): () => void {
    if (jobId === null) return () => undefined;
    flying.set(jobId, (flying.get(jobId) ?? 0) + 1);
    return () => {
      const left = (flying.get(jobId) ?? 1) - 1;
      if (left <= 0) flying.delete(jobId);
      else flying.set(jobId, left);
    };
  }

  return {
    send: (jobId, target, bytes) => {
      const key = printerTargetKey(target);
      const release = hold(jobId);
      let started = false;
      let expired = false;
      const previous = tails.get(key) ?? Promise.resolve();
      // The call starts after every earlier send to this address has really
      // settled, never merely timed out: two writes to one printer at once
      // could interleave two labels.
      const call = previous.then(async (): Promise<PrintResult | null> => {
        if (expired) return null;
        started = true;
        return printBytes(target, bytes);
      });
      const settled = call.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, settled);
      void settled.then(() => {
        release();
        if (tails.get(key) === settled) tails.delete(key);
      });
      const answered = call.then(
        (result): SendOutcome =>
          result === null ? { kind: "busy" } : { kind: "answered", result },
        (): SendOutcome => ({ kind: "answered", result: { sent: false, code: "outcome_unknown" } }),
      );
      return new Promise<SendOutcome>((resolve) => {
        let done = false;
        const stop = startTimer(limitMs, () => {
          if (done) return;
          done = true;
          // Not yet given to the shell: it never will be.
          if (!started) expired = true;
          resolve(started ? { kind: "timeout" } : { kind: "busy" });
        });
        void answered.then((outcome) => {
          if (done) return;
          done = true;
          stop();
          resolve(outcome);
        });
      });
    },
    isInFlight: (jobId) => flying.has(jobId),
    inFlight: () => [...flying.keys()],
  };
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-jobs.test.ts test/floor-print-runtime.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  23 passed (23)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  102 passed (102)`, `Tests  2476 passed (2476)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — байты уходят раньше, чем записано `sending`.
В `apps/standalone/src/floor/print/print-jobs.ts` фрагмент 1

<!-- prettier-ignore -->
```ts
  const attempt = job.attempts + 1;
  try {
    await local.transaction([
```

заменить на:

<!-- prettier-ignore -->
```ts
  const attempt = job.attempts + 1;
  const first = await runtime.send(job.id, printer.target, base64ToBytes(bytesBase64));
  try {
    await local.transaction([
```

В `apps/standalone/src/floor/print/print-jobs.ts` фрагмент 2

<!-- prettier-ignore -->
```ts
  const outcome = await runtime.send(job.id, printer.target, base64ToBytes(bytesBase64));
```

заменить на:

<!-- prettier-ignore -->
```ts
  const outcome = first;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-jobs.test.ts`
Expected: FAIL — «writes sending and the attempt before the bytes go, and sent once the shell took them», «refuses a job moved on meanwhile, and leaves it as it was moved», «leaves a job whose bytes this app's send still holds, and another pairing's jobs».

М2 — этикетка без ответа принтера отмечена `sent`.
В `apps/standalone/src/floor/print/print-jobs.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (outcome.kind === "timeout") return { state: "unknown", code: "timeout" };
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (outcome.kind === "timeout") return { state: "sent" };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-jobs.test.ts`
Expected: FAIL — «ends failed when nothing left this computer, and unknown when a label may exist», «ends unknown, never sent, when the shell does not answer within the limit».

М3 — задание пишется своей транзакцией, а не транзакцией закрытия.
В `apps/standalone/src/floor/print/print-jobs.ts` фрагмент

<!-- prettier-ignore -->
```ts
      deps.render,
    );
    return { statements: [statement] };
```

заменить на:

<!-- prettier-ignore -->
```ts
      deps.render,
    );
    await deps.local.transaction([statement]);
    return { statements: [] };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-jobs.test.ts`
Expected: FAIL — «never exists for a close the box's change undid: a stale close writes no job».

М4 — поздний ответ перезаписывает задание, которое уже сдвинули.
В `apps/standalone/src/floor/print/print-jobs.ts` фрагмент

<!-- prettier-ignore -->
```ts
          "WHERE host_id = ? AND device_id = ? AND id = ? AND state = 'sending' AND attempts = ?",
```

заменить на:

<!-- prettier-ignore -->
```ts
          "WHERE host_id = ? AND device_id = ? AND id = ? AND attempts = ?",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-jobs.test.ts`
Expected: FAIL — «refuses a job moved on meanwhile, and leaves it as it was moved».

М5 — восстановление принимает за прерванное задание, байты которого ещё у оболочки.
В `apps/standalone/src/floor/print/print-jobs.ts` фрагмент

<!-- prettier-ignore -->
```ts
        "WHERE host_id = ? AND device_id = ? AND state = 'sending' " +
        "AND id NOT IN (SELECT value FROM json_each(?))",
```

заменить на:

<!-- prettier-ignore -->
```ts
        "WHERE host_id = ? AND device_id = ? AND state = 'sending' " +
        "AND ? IS NOT NULL",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-jobs.test.ts`
Expected: FAIL — «leaves a job whose bytes this app's send still holds, and another pairing's jobs».

М6 — байты, чей предел истёк в очереди, всё равно уходят на принтер позже.
В `apps/standalone/src/floor/print/print-runtime.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
        if (expired) return null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-runtime.test.ts`
Expected: FAIL — «never gives the shell bytes whose limit ran out while an earlier send held the printer».

М7 — две отправки на один принтер одновременно.
В `apps/standalone/src/floor/print/print-runtime.ts` фрагмент

<!-- prettier-ignore -->
```ts
      tails.set(key, settled);
```

заменить на:

<!-- prettier-ignore -->
```ts
      tails.set(key, Promise.resolve());
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-runtime.test.ts`
Expected: FAIL — «sends to one address one at a time, and to another address meanwhile», «never gives the shell bytes whose limit ran out while an earlier send held the printer».

М8 — этикетка по копии шаблона станции, а не по снимку смены.
В `apps/standalone/src/floor/print/print-jobs.ts` фрагмент

<!-- prettier-ignore -->
```ts
    const settings = await readWorkstationSettings(deps.local);
    const { boxTemplate } = deps.shift.snapshot;
```

заменить на:

<!-- prettier-ignore -->
```ts
    const settings = await readWorkstationSettings(deps.local);
    const snapshotTemplate = deps.shift.snapshot.boxTemplate;
    const [copy] = await deps.local.query(
      "SELECT spec, rev FROM ref_templates WHERE id = ?",
      [snapshotTemplate.id],
      z.object({ spec: z.string(), rev: z.number() }),
    );
    const boxTemplate =
      copy === undefined
        ? snapshotTemplate
        : { ...snapshotTemplate, rev: copy.rev, spec: JSON.parse(copy.spec) as LabelTemplateSpec };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-jobs.test.ts`
Expected: FAIL — «takes the layout of the snapshot's template revision, not the station's newer copy of it».

М9 — этикетка, ждущая проверки, не держит смену открытой.
В `apps/standalone/src/floor/print/print-jobs.ts` фрагмент

<!-- prettier-ignore -->
```ts
  "(state IN ('prepared', 'sending', 'failed', 'unknown') OR (state = 'sent' AND verify = 1))";
```

заменить на:

<!-- prettier-ignore -->
```ts
  "(state IN ('prepared', 'sending', 'failed', 'unknown'))";
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-jobs.test.ts`
Expected: FAIL — «is the oldest one waiting for the printer or the operator, of this pairing only», «keeps the shift's labels unsettled while any job of it waits, even one that cannot be read».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/print/print-jobs.ts apps/standalone/src/floor/print/print-runtime.ts apps/standalone/test/floor-print-jobs.test.ts apps/standalone/test/floor-print-runtime.test.ts apps/standalone/test/support/printing.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/print/print-jobs.ts apps/standalone/src/floor/print/print-runtime.ts apps/standalone/test/floor-print-jobs.test.ts apps/standalone/test/floor-print-runtime.test.ts apps/standalone/test/support/printing.ts
git commit -m "feat(standalone): print jobs in the box's close, one send at a time per printer within a limit, interrupted sends unknown" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Решения по этикетке — проверка сканом, пропуск, «Этикетка напечаталась», печать снова с причиной

`print-resolution.ts` — решения оператора (§5.7.5, решения 21 и 36): `checkLabel` — SSCC скана (`parseScannedSscc` домена, с `(00)` и префиксом AIM или без) равен SSCC задания — `verified` и запись `box_label` одной транзакцией; другой SSCC — `mismatch`, не SSCC — `not_sscc`, ничего не пишется. `skipLabel` («Пропустить проверку», «Продолжить без этикетки») — из ждущей проверки, `failed` и `unknown`: `skipped` и `box_label` `skipped`. `confirmPrinted` («Этикетка напечаталась») — только из `unknown`: `sent`, дальше проверка, если задание её просит. `printAgain` («Напечатать снова», «Другой принтер») — `failed` отправляется снова без причины; этикетка, которая может уже существовать (`unknown`, `sent` с непрочитанной проверкой), — только с причиной из `REPRINT_REASONS`, которая пишется исключением `reprint` (`floor_exceptions` и запись `box_exception`) той же транзакцией, что `sending`; байты — задания, если язык и разрешение принтера те же, иначе рендер заново из снимка (шаблон — той же ревизии). Нет принтера — `NoPrinterError`, нет рендера — `LabelRenderError`: ничего не изменено и не отправлено. Записи паллет (`pallet_label`, `pallet_exception`) — план ПЛ-Ц.

**Files:**

- Create: `apps/standalone/src/floor/exception-reasons.ts`, `apps/standalone/src/floor/print/print-resolution.ts`
- Test: `apps/standalone/test/floor-print-resolution.test.ts` (Create), `apps/standalone/test/support/printing.ts` (Modify)

**Interfaces:**

- Consumes: `parseScannedSscc` (`@markiro/domain`); `boxLabelRecord`, `boxExceptionRecord`, `outboxStatement` (`src/floor/facts.ts`, план 2a6); фикстура `proto/fixtures/exception-reasons.json` (план 2a2); `readPrintJob`, `sendLabelJob`, `StaleJobError`, `PrintContext`, `PrintJob`, `RenderLabel` (задача 4); `resolvePrinter`, `PrinterProfile`, `WorkstationSettings` (задача 2); `renderLabel` (задача 3).
- Produces:
  - `src/floor/exception-reasons.ts`: `REPRINT_REASONS`, `type ReprintReason`, `DISASSEMBLE_REASONS`, `type DisassembleReason`, `OTHER_REASON`, `MAX_REASON_TEXT_CHARS = 200`;
  - `src/floor/print/print-resolution.ts`: `interface ResolveContext extends PrintContext { operatorId; newId }`, `class UnresolvableJobError`, `class NoPrinterError`, `class LabelRenderError`, `awaitsCheck(job)`, `type CheckResult`, `checkLabel(context, job, raw)`, `skipLabel(context, job)`, `confirmPrinted(context, job)`, `interface PrintAgain { reason: ReprintReason | null; printer: PrinterProfile | null }`, `printerForAgain(job, settings, chosen)`, `printAgain(context, job, request, settings, template, render?)`;
  - `test/support/printing.ts`: `PRINT_BLOCK`, `FIRST_SSCC`, `printStation(overrides?)`, `closeBoxWithLabel(at, render?)`, `resolveContext(local, runtime)`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-print-resolution.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { buildSscc, formatSsccHri } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";

import {
  DISASSEMBLE_REASONS,
  MAX_REASON_TEXT_CHARS,
  OTHER_REASON,
  REPRINT_REASONS,
} from "../src/floor/exception-reasons.js";
import { sendLabelJob, type PrintJob } from "../src/floor/print/print-jobs.js";
import {
  checkLabel,
  confirmPrinted,
  LabelRenderError,
  NoPrinterError,
  printAgain,
  printerForAgain,
  skipLabel,
  UnresolvableJobError,
} from "../src/floor/print/print-resolution.js";
import { PREFIX, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import {
  closeBoxWithLabel,
  FIRST_SSCC,
  jobRows,
  manualRuntime,
  printingSettings,
  printStation,
  renderedText,
  resolveContext,
  spyRender,
  TSC,
  ZEBRA,
} from "./support/printing.js";

const supportModuleUrl = import.meta.url;

type Station = Awaited<ReturnType<typeof printStation>>;

/** The job after a first send that ended as `answer` says. */
async function sentOnce(
  at: Station,
  answer: Parameters<ReturnType<typeof fakeHardware>["releaseSend"]>[0],
): Promise<{ job: PrintJob; shell: ReturnType<typeof fakeHardware> }> {
  const job = await closeBoxWithLabel(at);
  const shell = fakeHardware(async () => answer);
  const { runtime } = manualRuntime(shell.hardware);
  return { job: await sendLabelJob(resolveContext(at.local, runtime), job), shell };
}

function context(at: Station, shell = fakeHardware()) {
  return resolveContext(at.local, manualRuntime(shell.hardware).runtime);
}

function template(at: Station) {
  const { id, rev, spec } = at.shift.snapshot.boxTemplate;
  return { id, rev, spec };
}

function outbox(at: Station) {
  return rows(at.db, "SELECT kind, payload FROM outbox WHERE kind <> 'scan' ORDER BY seq").map(
    (row) => ({ kind: row["kind"], payload: JSON.parse(String(row["payload"])) as unknown }),
  );
}

describe("the reasons of a box exception", () => {
  it("are the host's lists, word for word", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../proto/fixtures/exception-reasons.json", supportModuleUrl), "utf8"),
    ) as unknown;
    expect(fixture).toEqual({
      reprint: [...REPRINT_REASONS],
      disassemble: [...DISASSEMBLE_REASONS],
      other: OTHER_REASON,
      maxTextChars: MAX_REASON_TEXT_CHARS,
    });
  });
});

describe("the check of a printed label", () => {
  it("verifies the scan of the job's SSCC, with its record, in one write", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job } = await sentOnce(at, { sent: true });
    const result = await checkLabel(context(at), job, `]C100${FIRST_SSCC}`);
    expect(result).toMatchObject({ kind: "verified", job: { state: "verified" } });
    expect(outbox(at)).toEqual([
      expect.objectContaining({ kind: "box_closed" }),
      {
        kind: "box_label",
        payload: {
          id: "00000000-0000-4000-8000-000000000101",
          kind: "box_label",
          shiftId: at.shift.copy.id,
          operatorId: job.operatorId,
          data: { boxId: job.subjectId, outcome: "verified", at: "2026-10-08T06:30:01.000Z" },
        },
      },
    ]);
  });

  it("refuses another box's SSCC and a scan that is no SSCC, and writes nothing", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job } = await sentOnce(at, { sent: true });
    const other = buildSscc(0, PREFIX, 1501);
    await expect(checkLabel(context(at), job, other)).resolves.toEqual({
      kind: "mismatch",
      sscc: other,
    });
    await expect(
      checkLabel(context(at), job, formatSsccHri(FIRST_SSCC).slice(0, 10)),
    ).resolves.toEqual({ kind: "not_sscc" });
    await expect(checkLabel(context(at), job, "]d201046006820000132100001")).resolves.toEqual({
      kind: "not_sscc",
    });
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent" });
    expect(outbox(at).map((record) => record.kind)).toEqual(["box_closed"]);
  });

  it("is for a sent job that asked for it only", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: true });
    await expect(checkLabel(context(at), job, FIRST_SSCC)).rejects.toBeInstanceOf(
      UnresolvableJobError,
    );
  });
});

describe("going on without a label", () => {
  it("skips a waiting check, a failed job and an unknown one, each with its record", async () => {
    for (const [answer, verify] of [
      [{ sent: true }, true],
      [{ sent: false, code: "not_sent" }, false],
      [{ sent: false, code: "outcome_unknown" }, false],
    ] as const) {
      const at = await printStation({ verifyPrintedLabel: verify });
      const { job } = await sentOnce(at, answer);
      await expect(skipLabel(context(at), job)).resolves.toMatchObject({
        state: "skipped",
        errorCode: null,
      });
      expect(outbox(at).at(-1)).toMatchObject({
        kind: "box_label",
        payload: { data: { boxId: job.subjectId, outcome: "skipped" } },
      });
    }
  });

  it("is not for a job that is done with or on its way", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: true });
    await expect(skipLabel(context(at), job)).rejects.toBeInstanceOf(UnresolvableJobError);
    await expect(skipLabel(context(at), { ...job, state: "prepared" })).rejects.toBeInstanceOf(
      UnresolvableJobError,
    );
    await expect(skipLabel(context(at), { ...job, state: "sending" })).rejects.toBeInstanceOf(
      UnresolvableJobError,
    );
  });
});

describe("the label the operator sees printed", () => {
  it("turns an unknown job into a sent one, and the check comes next when the job asks", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job, shell } = await sentOnce(at, { sent: false, code: "outcome_unknown" });
    await expect(confirmPrinted(context(at, shell), job)).resolves.toMatchObject({
      state: "sent",
      errorCode: null,
      attempts: 1,
    });
    expect(shell.sends).toHaveLength(1);
  });

  it("is not for a failed job: nothing left the computer", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "not_sent" });
    await expect(confirmPrinted(context(at), job)).rejects.toBeInstanceOf(UnresolvableJobError);
  });
});

describe("printing again", () => {
  it("sends a failed job's own bytes again, without a reason or an exception", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "not_sent" });
    const shell = fakeHardware();
    const again = await printAgain(
      context(at, shell),
      job,
      { reason: null, printer: null },
      at.settings,
      template(at),
    );
    expect(again).toMatchObject({ state: "sent", attempts: 2 });
    expect(shell.sends).toEqual([{ target: ZEBRA.target, text: renderedText(ZEBRA, FIRST_SSCC) }]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_exceptions")).toEqual([{ n: 0 }]);
  });

  it("never prints a label that may exist without the operator's reason", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "outcome_unknown" });
    const shell = fakeHardware();
    await expect(
      printAgain(
        context(at, shell),
        job,
        { reason: null, printer: null },
        at.settings,
        template(at),
      ),
    ).rejects.toBeInstanceOf(UnresolvableJobError);
    expect(shell.sends).toEqual([]);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown", attempts: 1 });
  });

  it("writes the reprint with its reason in the write that marks the job sending", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "outcome_unknown" });
    const shell = fakeHardware();
    shell.holdSends();
    const sending = printAgain(
      context(at, shell),
      job,
      { reason: "printer_jam", printer: null },
      at.settings,
      template(at),
    );
    await vi.waitFor(() => expect(shell.heldSends()).toBe(1));
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sending", attempts: 2 });
    expect(
      rows(
        at.db,
        "SELECT kind, box_id, reason_code, reason_text, operator_id FROM floor_exceptions",
      ),
    ).toEqual([
      {
        kind: "reprint",
        box_id: job.subjectId,
        reason_code: "printer_jam",
        reason_text: null,
        operator_id: job.operatorId,
      },
    ]);
    expect(outbox(at).at(-1)).toMatchObject({
      kind: "box_exception",
      payload: {
        data: {
          exception: "reprint",
          boxId: job.subjectId,
          codeHash: null,
          targetScannedAt: null,
          reasonCode: "printer_jam",
          reasonText: null,
        },
      },
    });
    shell.releaseSend({ sent: true });
    await expect(sending).resolves.toMatchObject({ state: "sent" });
  });

  it("reprints a sent label whose check did not read it, with a reason", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job } = await sentOnce(at, { sent: true });
    const shell = fakeHardware();
    await expect(
      printAgain(
        context(at, shell),
        job,
        { reason: "unreadable_label", printer: null },
        at.settings,
        template(at),
      ),
    ).resolves.toMatchObject({ state: "sent", verify: true, attempts: 2 });
    expect(shell.sends).toHaveLength(1);
  });

  it("renders again for a printer of another language or resolution, from the snapshot", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "not_sent" });
    const shell = fakeHardware();
    const render = spyRender();
    const again = await printAgain(
      context(at, shell),
      job,
      { reason: null, printer: TSC },
      at.settings,
      template(at),
      render,
    );
    expect(render).toHaveBeenCalledWith(at.shift.snapshot.boxTemplate.spec, job.fields, TSC);
    expect(again.printer).toEqual(TSC);
    expect(shell.sends).toEqual([{ target: TSC.target, text: renderedText(TSC, FIRST_SSCC) }]);
    // The same language and resolution keep the bytes: no render.
    const same = {
      ...ZEBRA,
      id: "zebra-2",
      target: { kind: "usb", printer: "ZDesigner" },
    } as const;
    const at2 = await printStation();
    const second = await sentOnce(at2, { sent: false, code: "not_sent" });
    const render2 = spyRender();
    await printAgain(
      context(at2),
      second.job,
      { reason: null, printer: same },
      at2.settings,
      template(at2),
      render2,
    );
    expect(render2).not.toHaveBeenCalled();
  });

  it("takes the job's printer as the settings have it now, then the purpose's printer", () => {
    const job = { printer: ZEBRA, purpose: "box" } as const;
    const moved = { ...ZEBRA, target: { kind: "tcp", host: "192.168.1.60", port: 9100 } } as const;
    expect(printerForAgain(job, printingSettings({ printers: [moved, TSC] }), null)).toEqual(moved);
    expect(
      printerForAgain(
        job,
        printingSettings({
          printers: [TSC],
          assignments: { box: "tsc", pallet: null, duplicate: null },
        }),
        null,
      ),
    ).toEqual(TSC);
    expect(printerForAgain(job, printingSettings({ printers: [TSC] }), null)).toBeNull();
    expect(printerForAgain(job, printingSettings(), TSC)).toEqual(TSC);
  });

  it("changes and sends nothing without a printer or a render, and refuses another template", async () => {
    const at = await printStation({ assignments: { box: null, pallet: null, duplicate: null } });
    const job = await closeBoxWithLabel(at);
    const shell = fakeHardware();
    await expect(
      printAgain(
        context(at, shell),
        job,
        { reason: null, printer: null },
        at.settings,
        template(at),
      ),
    ).rejects.toBeInstanceOf(NoPrinterError);
    await expect(
      printAgain(
        context(at, shell),
        job,
        { reason: null, printer: ZEBRA },
        at.settings,
        template(at),
        async () => {
          throw new Error("no canvas");
        },
      ),
    ).rejects.toBeInstanceOf(LabelRenderError);
    await expect(
      printAgain(context(at, shell), job, { reason: null, printer: ZEBRA }, at.settings, {
        ...template(at),
        rev: 63,
      }),
    ).rejects.toBeInstanceOf(UnresolvableJobError);
    expect(shell.sends).toEqual([]);
    expect(jobRows(at.db)[0]).toMatchObject({
      state: "failed",
      error_code: "printer_unconfigured",
      attempts: 0,
    });
  });
});
```

Правка `apps/standalone/test/support/printing.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import type { RasterizeTextFn } from "@markiro/domain";
import type { DatabaseSync } from "node:sqlite";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { buildSscc, type RasterizeTextFn } from "@markiro/domain";
import type { DatabaseSync } from "node:sqlite";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
import { latin1ToBytes } from "../../src/floor/print/label-render.js";
import type { RenderLabel } from "../../src/floor/print/print-jobs.js";
import { createPrintRuntime, type StartTimer } from "../../src/floor/print/print-runtime.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { latin1ToBytes } from "../../src/floor/print/label-render.js";
import {
  boxLabelStep,
  readPrintJob,
  type PrintContext,
  type PrintJob,
  type RenderLabel,
} from "../../src/floor/print/print-jobs.js";
import type { ResolveContext } from "../../src/floor/print/print-resolution.js";
import { createPrintRuntime, type StartTimer } from "../../src/floor/print/print-runtime.js";
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
} from "../../src/floor/setup/workstation-settings.js";
import type { HardwareApi } from "../../src/hardware/hardware.js";
import type { LocalExecutor } from "../../src/local/executor.js";
import { rows } from "./floor-work.js";

/** A rasterizer that draws every text as the same 8 x 2 bitmap: jsdom has no canvas. */
```

заменить на:

<!-- prettier-ignore -->
```ts
} from "../../src/floor/setup/workstation-settings.js";
import type { PrintRuntime } from "../../src/floor/print/print-runtime.js";
import type { WorkShift } from "../../src/floor/shifts/shift-copies.js";
import { closeOpenBox } from "../../src/floor/work/box-close.js";
import { processScan } from "../../src/floor/work/scan-pipeline.js";
import type { HardwareApi } from "../../src/hardware/hardware.js";
import type { LocalExecutor } from "../../src/local/executor.js";
import {
  enteredShift,
  km,
  OPERATOR_ID,
  PAIRING,
  PREFIX,
  rows,
  scanContext,
  seedBlock,
} from "./floor-work.js";
import { openLocalDb } from "./local-db.js";

/** A rasterizer that draws every text as the same 8 x 2 bitmap: jsdom has no canvas. */
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  return vi.fn<RenderLabel>(render);
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  return vi.fn<RenderLabel>(render);
}

/** The block of the printing tests: serials from 1500. */
export const PRINT_BLOCK = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
/** The SSCC of the first box the printing tests close. */
export const FIRST_SSCC = buildSscc(0, PREFIX, 1500);

/** A station with the shift entered, a block of serials and these workstation settings. */
export async function printStation(overrides: Partial<WorkstationSettings> = {}) {
  const { db, executor } = openLocalDb();
  const shift: WorkShift = await enteredShift(executor);
  seedBlock(db, { blockId: PRINT_BLOCK, from: 1500, to: 3499 });
  const settings = await setUpPrinting(executor, overrides);
  return { db, local: executor, shift, settings };
}

/**
 * Accepts three codes and closes the box with its print job `job-1`, as the
 * work screen does; answers the stored job.
 */
export async function closeBoxWithLabel(
  at: { local: LocalExecutor; shift: WorkShift },
  render: RenderLabel = fakeRender,
): Promise<PrintJob> {
  const filling = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
  for (const serial of ["A1", "A2", "A3"]) await processScan(filling, km(serial));
  const closed = await closeOpenBox(scanContext(at.local, at.shift), [
    boxLabelStep({
      local: at.local,
      pairing: PAIRING,
      shift: at.shift,
      operatorName: "Анна Кузнецова",
      newId: () => "job-1",
      render,
    }),
  ]);
  if (closed.kind !== "closed") throw new Error(`the box did not close: ${closed.kind}`);
  const job = await readPrintJob(at.local, PAIRING, "job-1");
  if (job === null) throw new Error("the box closed without its job");
  return job;
}

/** A send's and a decision's context over `local`: a clock one second a reading from 06:30, counting ids. */
export function resolveContext(local: LocalExecutor, runtime: PrintRuntime): ResolveContext {
  let tick = Date.parse("2026-10-08T06:30:00.000Z");
  let id = 100;
  const context: PrintContext = {
    local,
    pairing: PAIRING,
    runtime,
    now: () => {
      tick += 1_000;
      return new Date(tick);
    },
  };
  return {
    ...context,
    operatorId: OPERATOR_ID,
    newId: () => {
      id += 1;
      return `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
    },
  };
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-resolution.test.ts`
Expected: FAIL — `test/floor-print-resolution.test.ts` не загружается (`Failed to resolve import "../src/floor/exception-reasons.js"`).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/floor/exception-reasons.ts`:

<!-- prettier-ignore -->
```ts
/**
 * The reasons of a box exception (stage 2a spec, decision 36), the same lists
 * as the host's (`markiro_proto::exception_reasons`, fixture
 * `proto/fixtures/exception-reasons.json`): codes, not words, so exports and
 * translations read them; words come only with `other`.
 */
export const REPRINT_REASONS = [
  "damaged_label",
  "unreadable_label",
  "printer_jam",
  "quality_request",
  "other",
] as const;
export type ReprintReason = (typeof REPRINT_REASONS)[number];

export const DISASSEMBLE_REASONS = [
  "wrong_product",
  "wrong_quantity",
  "damaged_package",
  "quality_rejected",
  "other",
] as const;
export type DisassembleReason = (typeof DISASSEMBLE_REASONS)[number];

/** The one reason that may carry words. */
export const OTHER_REASON = "other";

/** The longest words of `other`, in code points. */
export const MAX_REASON_TEXT_CHARS = 200;
```

Создать `apps/standalone/src/floor/print/print-resolution.ts`:

<!-- prettier-ignore -->
```ts
import { parseScannedSscc, type LabelTemplateSpec } from "@markiro/domain";

import { bytesToBase64 } from "../../hardware/hardware.js";
import { LocalDbError, type LocalStatement } from "../../local/executor.js";
import type { ReprintReason } from "../exception-reasons.js";
import { boxExceptionRecord, boxLabelRecord, outboxStatement } from "../facts.js";
import {
  resolvePrinter,
  type PrinterProfile,
  type WorkstationSettings,
} from "../setup/workstation-settings.js";
import { renderLabel } from "./label-render.js";
import {
  readPrintJob,
  sendLabelJob,
  StaleJobError,
  type PrintContext,
  type PrintJob,
  type PrintJobState,
  type RenderLabel,
} from "./print-jobs.js";

/** What the operator's decisions on a label need besides the send's context. */
export interface ResolveContext extends PrintContext {
  /** The operator signed in now: the records name them. */
  operatorId: string;
  newId: () => string;
}

/** The job is in no state this decision is for (the screen offered it by mistake, or it moved on). */
export class UnresolvableJobError extends Error {
  constructor(id: string, state: PrintJobState) {
    super(`print job ${id} cannot be resolved so from ${state}`);
    this.name = "UnresolvableJobError";
  }
}

/** No printer to print on: the job's own is gone from the settings and none is assigned. */
export class NoPrinterError extends Error {
  constructor() {
    super("no printer for the label");
    this.name = "NoPrinterError";
  }
}

/** The label would not render for the chosen printer; nothing was changed or sent. */
export class LabelRenderError extends Error {
  constructor() {
    super("the label did not render");
    this.name = "LabelRenderError";
  }
}

/**
 * The record of a label's check for the host: `box_label` for a box. A
 * pallet's (`pallet_label`) is the pallets' plan's to add (ПЛ-Ц).
 */
function labelRecord(
  context: ResolveContext,
  job: PrintJob,
  outcome: "verified" | "skipped",
  at: string,
) {
  const head = { id: context.newId(), shiftId: job.shiftId, operatorId: context.operatorId };
  switch (job.purpose) {
    case "box":
      return boxLabelRecord(head, { boxId: job.subjectId, outcome, at });
    case "pallet":
      throw new UnresolvableJobError(job.id, job.state);
  }
}

/**
 * The records of a reprint (decision 36): the station's `floor_exceptions`
 * row and the `box_exception` record of kind `reprint` with its reason, no
 * words (the work screen offers the codes only). A pallet's reprint is the
 * pallets' plan's.
 */
function reprintStatements(
  context: ResolveContext,
  job: PrintJob,
  reason: ReprintReason,
  at: string,
): LocalStatement[] {
  if (job.purpose !== "box") throw new UnresolvableJobError(job.id, job.state);
  const exceptionId = context.newId();
  const record = boxExceptionRecord(
    { id: context.newId(), shiftId: job.shiftId, operatorId: context.operatorId },
    {
      exception: "reprint",
      boxId: job.subjectId,
      codeHash: null,
      targetScannedAt: null,
      reasonCode: reason,
      reasonText: null,
      occurredAt: at,
    },
  );
  return [
    {
      sql:
        "INSERT INTO floor_exceptions (id, host_id, device_id, shift_id, kind, box_id, " +
        "reason_code, occurred_at, operator_id) VALUES (?, ?, ?, ?, 'reprint', ?, ?, ?, ?)",
      values: [
        exceptionId,
        context.pairing.hostId,
        context.pairing.deviceId,
        job.shiftId,
        job.subjectId,
        reason,
        at,
        context.operatorId,
      ],
      expectedChanges: 1,
    },
    outboxStatement(record, context.pairing, at),
  ];
}

/** Writes `statements` (the first one compares the job), mapping a lost comparison to `StaleJobError`. */
async function commit(
  context: ResolveContext,
  job: PrintJob,
  statements: readonly LocalStatement[],
): Promise<PrintJob> {
  try {
    await context.local.transaction(statements);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleJobError(job.id);
    }
    throw error;
  }
  const after = await readPrintJob(context.local, context.pairing, job.id);
  if (after === null) throw new StaleJobError(job.id);
  return after;
}

/** The comparing update of a job's state. */
function move(
  context: ResolveContext,
  job: PrintJob,
  state: PrintJobState,
  at: string,
): LocalStatement {
  return {
    sql:
      "UPDATE floor_print_jobs SET state = ?, error_code = NULL, updated_at = ? " +
      "WHERE host_id = ? AND device_id = ? AND id = ? AND state = ? AND attempts = ?",
    values: [
      state,
      at,
      context.pairing.hostId,
      context.pairing.deviceId,
      job.id,
      job.state,
      job.attempts,
    ],
    expectedChanges: 1,
  };
}

/** A check is waiting on this job: it was sent and asks for the scan of its label. */
export function awaitsCheck(job: Pick<PrintJob, "state" | "verify">): boolean {
  return job.state === "sent" && job.verify;
}

/** The answer to a scan while a label's check waits. */
export type CheckResult =
  { kind: "verified"; job: PrintJob } | { kind: "not_sscc" } | { kind: "mismatch"; sscc: string };

/**
 * The scan of a printed label (decision 21): an SSCC read by the domain
 * (`parseScannedSscc`, with or without `(00)` and the AIM prefix) equal to the
 * job's — `verified` and the `box_label` record in one transaction; another
 * SSCC — `mismatch`; anything else — `not_sscc`. Nothing is written for
 * either refusal.
 */
export async function checkLabel(
  context: ResolveContext,
  job: PrintJob,
  raw: string,
): Promise<CheckResult> {
  if (!awaitsCheck(job)) throw new UnresolvableJobError(job.id, job.state);
  const sscc = parseScannedSscc(raw);
  if (sscc === null) return { kind: "not_sscc" };
  if (sscc !== job.sscc) return { kind: "mismatch", sscc };
  const at = context.now().toISOString();
  const verified = await commit(context, job, [
    move(context, job, "verified", at),
    outboxStatement(labelRecord(context, job, "verified", at), context.pairing, at),
  ]);
  return { kind: "verified", job: verified };
}

/**
 * «Продолжить без этикетки» / «Пропустить проверку»: the operator goes on
 * without a checked label — from a check that waits, a failed job or an
 * unknown one (the cloud's «Продолжить без этикетки»). `skipped` and the
 * `box_label` record `skipped`, in one transaction; the box can get a label
 * later by a reprint (plan 2a8).
 */
export async function skipLabel(context: ResolveContext, job: PrintJob): Promise<PrintJob> {
  if (!(awaitsCheck(job) || job.state === "failed" || job.state === "unknown")) {
    throw new UnresolvableJobError(job.id, job.state);
  }
  const at = context.now().toISOString();
  return commit(context, job, [
    move(context, job, "skipped", at),
    outboxStatement(labelRecord(context, job, "skipped", at), context.pairing, at),
  ]);
}

/**
 * «Этикетка напечаталась»: the operator sees the label of an `unknown` job
 * on the box. `sent` — done with, or the check next when the job asks for it.
 * Only from `unknown`: a failed job left nothing on any printer.
 */
export async function confirmPrinted(context: ResolveContext, job: PrintJob): Promise<PrintJob> {
  if (job.state !== "unknown") throw new UnresolvableJobError(job.id, job.state);
  const at = context.now().toISOString();
  return commit(context, job, [move(context, job, "sent", at)]);
}

/** Where to print again: the job's own printer as the settings have it now, or another one. */
export interface PrintAgain {
  /** The operator's reason: required when a label may already exist (`unknown`, a check waiting). */
  reason: ReprintReason | null;
  /** «Другой принтер»: this profile; otherwise the job's own, or the purpose's printer. */
  printer: PrinterProfile | null;
}

/** The printer a print again goes to. */
export function printerForAgain(
  job: Pick<PrintJob, "printer" | "purpose">,
  settings: Pick<WorkstationSettings, "printers" | "assignments">,
  chosen: PrinterProfile | null,
): PrinterProfile | null {
  if (chosen !== null) return chosen;
  const own = job.printer === null ? null : settings.printers.find((p) => p.id === job.printer?.id);
  return own ?? resolvePrinter(settings, job.purpose);
}

/**
 * «Напечатать снова» and «Другой принтер» (stage 2a spec §5.7.5): only the
 * operator's decision ever sends a label again. A failed job is sent again
 * as it is; a job whose label may exist — `unknown`, or `sent` with a check
 * that failed to read it — only with a reason, written as a reprint
 * exception in the transaction that marks the job `sending`. The bytes are
 * the job's when the printer's language and resolution are the job's, and
 * rendered again from the shift's snapshot otherwise (`template` must be the
 * job's own revision). No printer — `NoPrinterError`; no render —
 * `LabelRenderError`; neither changes or sends anything.
 */
export async function printAgain(
  context: ResolveContext,
  job: PrintJob,
  request: PrintAgain,
  settings: Pick<WorkstationSettings, "printers" | "assignments">,
  template: { id: string; rev: number; spec: LabelTemplateSpec },
  render: RenderLabel = renderLabel,
): Promise<PrintJob> {
  const mayExist = job.state === "unknown" || awaitsCheck(job);
  if (!(job.state === "failed" || mayExist)) throw new UnresolvableJobError(job.id, job.state);
  if (mayExist && request.reason === null) throw new UnresolvableJobError(job.id, job.state);
  if (template.id !== job.templateId || template.rev !== job.templateRev) {
    throw new UnresolvableJobError(job.id, job.state);
  }
  const printer = printerForAgain(job, settings, request.printer);
  if (printer === null) throw new NoPrinterError();
  let bytesBase64 = job.bytesBase64;
  const sameRender =
    job.printer !== null &&
    job.printer.language === printer.language &&
    job.printer.dpi === printer.dpi;
  if (bytesBase64 === null || !sameRender) {
    try {
      bytesBase64 = bytesToBase64(await render(template.spec, job.fields, printer));
    } catch {
      throw new LabelRenderError();
    }
  }
  const at = context.now().toISOString();
  return sendLabelJob(context, job, {
    rebind: { printer, bytesBase64 },
    extra:
      mayExist && request.reason !== null
        ? reprintStatements(context, job, request.reason, at)
        : [],
  });
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-resolution.test.ts`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  15 passed (15)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  103 passed (103)`, `Tests  2491 passed (2491)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — этикетка, которая может уже существовать, печатается снова без причины.
В `apps/standalone/src/floor/print/print-resolution.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (mayExist && request.reason === null) throw new UnresolvableJobError(job.id, job.state);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-resolution.test.ts`
Expected: FAIL — «never prints a label that may exist without the operator's reason».

М2 — запись перепечатки пишется после отправки, а не той же транзакцией.
В `apps/standalone/src/floor/print/print-resolution.ts` фрагмент

<!-- prettier-ignore -->
```ts
  return sendLabelJob(context, job, {
    rebind: { printer, bytesBase64 },
    extra:
      mayExist && request.reason !== null
        ? reprintStatements(context, job, request.reason, at)
        : [],
  });
```

заменить на:

<!-- prettier-ignore -->
```ts
  const sent = await sendLabelJob(context, job, { rebind: { printer, bytesBase64 } });
  if (mayExist && request.reason !== null) {
    await context.local.transaction(reprintStatements(context, job, request.reason, at));
  }
  return sent;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-resolution.test.ts`
Expected: FAIL — «writes the reprint with its reason in the write that marks the job sending».

М3 — любой SSCC проверяет этикетку.
В `apps/standalone/src/floor/print/print-resolution.ts` удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (sscc !== job.sscc) return { kind: "mismatch", sscc };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-resolution.test.ts`
Expected: FAIL — «refuses another box's SSCC and a scan that is no SSCC, and writes nothing».

М4 — «Этикетка напечаталась» для задания, которое ничего не отправило.
В `apps/standalone/src/floor/print/print-resolution.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (job.state !== "unknown") throw new UnresolvableJobError(job.id, job.state);
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (job.state !== "unknown" && job.state !== "failed") throw new UnresolvableJobError(job.id, job.state);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-resolution.test.ts`
Expected: FAIL — «is not for a failed job: nothing left the computer».

М5 — байты ZPL уходят на принтер TSPL.
В `apps/standalone/src/floor/print/print-resolution.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (bytesBase64 === null || !sameRender) {
```

заменить на:

<!-- prettier-ignore -->
```ts
  if (bytesBase64 === null) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-print-resolution.test.ts`
Expected: FAIL — «renders again for a printer of another language or resolution, from the snapshot».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/exception-reasons.ts apps/standalone/src/floor/print/print-resolution.ts apps/standalone/test/floor-print-resolution.test.ts apps/standalone/test/support/printing.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/exception-reasons.ts apps/standalone/src/floor/print/print-resolution.ts apps/standalone/test/floor-print-resolution.test.ts apps/standalone/test/support/printing.ts
git commit -m "feat(standalone): decisions on a label: the scan check, a skip, «printed», printing again with a reason" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Рабочий экран — печать после закрытия, остановка на этикетке, проверка до конвейера, «не засыпать»

Рабочий экран плана 2a6 передаёт в каждое закрытие короба шаг `boxLabelStep` и после `closed` той же работой очереди решает этикетку (`settleLabel`): прерванные — `unknown`; `prepared` — отправляется (первая отправка, не повтор); ждущая — остановка `Stop` `label` и панель `LabelPanel` (проверка или восстановление). Пока этикетка ждёт, следующий короб не закрывается (`closeBox` читает ждущее задание до закрытия) и обычный скан не принимается; скан при ждущей проверке перехватывается до `processScan` (контракт плана 2a6) и в журнал не пишется. Решения панели идут работой очереди (`decide`), под этикеткой — слова о том, чего решение не смогло; «Выйти из смены» открыта всегда. После решённой этикетки закрывается полный короб, оставленный остановкой станции. Сбой системы после закрытия сообщения снова читает этикетку.

«Не засыпать» (решение 34, вопрос В11): `createSystemAwake` — удержание запроса оболочки на время рабочего экрана (первое удержание просит, последнее отпускание отпускает, вызовы по порядку); `App` при запуске отпускает запрос всегда (`reset`): запрос оболочки переживает перезагрузку вебвью (пункт 15 очереди мелочей 2a4). `App` держит одну очередь принтеров (`createPrintRuntime`) на приложение; `FloorApp` передаёт её и удержание рабочему экрану.

**Files:**

- Create: `apps/standalone/src/floor/print/LabelPanel.tsx`, `apps/standalone/src/hardware/awake.ts`
- Modify: `apps/standalone/src/app/App.tsx`, `apps/standalone/src/app/shell.css`, `apps/standalone/src/floor/FloorApp.tsx`, `apps/standalone/src/floor/work/WorkScreen.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/awake.test.ts` (Create), `apps/standalone/test/floor-work-print.test.tsx` (Create), `apps/standalone/test/app.test.tsx` (Modify), `apps/standalone/test/floor-app.test.tsx` (Modify), `apps/standalone/test/floor-work-screen.test.tsx` (Modify)

**Interfaces:**

- Consumes: `WorkScreenProps`, `Stop`, `closeBox`, `queue`, `track`, `onRecorded` (`src/floor/work/WorkScreen.tsx`, план 2a6); `closeIfFull`, `closeOpenBox` (план 2a6); задачи 2–5; `HardwareApi.setSystemAwake`, `printBytes` (план 2a4).
- Produces:
  - `src/hardware/awake.ts`: `interface SystemAwake { hold(): () => void; reset(): Promise<void> }`, `createSystemAwake(setSystemAwake)`;
  - `src/floor/print/LabelPanel.tsx`: `type LabelNote`, `interface LabelPanelProps`, `LabelPanel`;
  - `WorkScreenProps` += `printing: PrintRuntime`, `awake: SystemAwake`, `onSetup?: () => void`, `render?: RenderLabel`; `Stop` += `{ kind: "label"; job: PrintJob }`;
  - `FloorAppProps` += `printing: PrintRuntime`, `awake: SystemAwake`, `render?: RenderLabel`;
  - ключи `floor.print.*` в `ru.json`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/app.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  });

  it("starts the wait again on a touch of the screen, not only on a key", async () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  });

  it("lets the computer sleep when it starts: a reloaded webview's request is let go", async () => {
    const { hardware } = fakeHardware();
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      hardware,
    });
    await waitFor(() => expect(hardware.setSystemAwake).toHaveBeenCalledWith(false));
    expect(hardware.setSystemAwake).not.toHaveBeenCalledWith(true);
  });

  it("starts the wait again on a touch of the screen, not only on a key", async () => {
```

Создать `apps/standalone/test/awake.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import { createSystemAwake } from "../src/hardware/awake.js";
import type { HardwareApi } from "../src/hardware/hardware.js";

/** A shell whose power requests the test answers one by one. */
function heldPower() {
  const calls: { awake: boolean; answer: (error?: Error) => void }[] = [];
  const setSystemAwake = vi.fn<HardwareApi["setSystemAwake"]>(
    (awake) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ awake, answer: (error) => (error ? reject(error) : resolve()) });
      }),
  );
  return { setSystemAwake, calls };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("keeping the computer awake", () => {
  it("asks once for the first hold and lets go after the last release", async () => {
    const setSystemAwake = vi.fn<HardwareApi["setSystemAwake"]>(async () => undefined);
    const awake = createSystemAwake(setSystemAwake);
    const first = awake.hold();
    const second = awake.hold();
    await flush();
    expect(setSystemAwake.mock.calls).toEqual([[true]]);
    first();
    first();
    await flush();
    expect(setSystemAwake.mock.calls).toEqual([[true]]);
    second();
    await flush();
    expect(setSystemAwake.mock.calls).toEqual([[true], [false]]);
  });

  it("asks in the order the screens did, one request at a time", async () => {
    const power = heldPower();
    const awake = createSystemAwake(power.setSystemAwake);
    awake.hold()();
    awake.hold();
    await flush();
    // The release and the next hold wait for the first request's answer.
    expect(power.calls.map((call) => call.awake)).toEqual([true]);
    power.calls[0]?.answer();
    await flush();
    expect(power.calls.map((call) => call.awake)).toEqual([true, false]);
    power.calls[1]?.answer(new Error("power_request_failed"));
    await flush();
    // A refusal does not stop the next request.
    expect(power.calls.map((call) => call.awake)).toEqual([true, false, true]);
  });

  it("lets go at the app's start whatever a reloaded webview held, and a later release asks nothing", async () => {
    const setSystemAwake = vi.fn<HardwareApi["setSystemAwake"]>(async () => undefined);
    const awake = createSystemAwake(setSystemAwake);
    const release = awake.hold();
    await awake.reset();
    expect(setSystemAwake.mock.calls).toEqual([[true], [false]]);
    release();
    await flush();
    expect(setSystemAwake.mock.calls).toEqual([[true], [false]]);
    const next = awake.hold();
    // The hold from before the reset lets go of nothing the new one holds.
    release();
    await flush();
    expect(setSystemAwake.mock.calls).toEqual([[true], [false], [true]]);
    next();
    await flush();
    expect(setSystemAwake.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it("never rejects, even when the shell refuses", async () => {
    const awake = createSystemAwake(async () => {
      throw new Error("power_request_failed");
    });
    await expect(awake.reset()).resolves.toBeUndefined();
    expect(() => awake.hold()()).not.toThrow();
  });
});
```

Правка `apps/standalone/test/floor-app.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { createOperatorIdleLock, OPERATOR_IDLE_TIMEOUT_MS } from "../src/floor/idle-lock.js";
import type { ScanSource } from "../src/floor/scan-source.js";
import { keepEnteredShift, replaceShiftCopies } from "../src/floor/shifts/shift-copies.js";
import { signInWithPin } from "../src/floor/sign-in.js";
import type { WorkScreenProps } from "../src/floor/work/WorkScreen.js";
import {
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { createOperatorIdleLock, OPERATOR_IDLE_TIMEOUT_MS } from "../src/floor/idle-lock.js";
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import type { ScanSource } from "../src/floor/scan-source.js";
import { keepEnteredShift, replaceShiftCopies } from "../src/floor/shifts/shift-copies.js";
import { signInWithPin } from "../src/floor/sign-in.js";
import type { WorkScreenProps } from "../src/floor/work/WorkScreen.js";
import { createSystemAwake } from "../src/hardware/awake.js";
import {
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
        source={SILENT_SOURCE}
        {...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs })}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        source={SILENT_SOURCE}
        printing={handlers.printing}
        awake={handlers.awake}
        {...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs })}
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
    requestFacts: vi.fn(),
    dispatch: vi.fn<(action: ShellAction) => void>(),
```

заменить на:

<!-- prettier-ignore -->
```tsx
    requestFacts: vi.fn(),
    printing: createPrintRuntime(fakeHardware().hardware.printBytes),
    awake: createSystemAwake(vi.fn(async () => undefined)),
    dispatch: vi.fn<(action: ShellAction) => void>(),
```

Создать `apps/standalone/test/floor-work-print.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { buildSscc, formatSsccHri } from "@markiro/domain";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider, type SignalTone } from "@markiro/ui";

import type { FloorSession } from "../src/app/shell.js";
import type { PrintRuntime } from "../src/floor/print/print-runtime.js";
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import { createWorkGate } from "../src/floor/work-gate.js";
import { WorkScreen, type WorkScreenProps } from "../src/floor/work/WorkScreen.js";
import { createSystemAwake } from "../src/hardware/awake.js";
import type { CodeCheck, SsccBlockRequest } from "../src/host/protocol.js";
import { processScan } from "../src/floor/work/scan-pipeline.js";
import { km, OPERATOR_ID, PAIRING, PREFIX, rows, scanContext } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import {
  closeBoxWithLabel,
  FIRST_SSCC,
  jobRows,
  manualRuntime,
  printStation,
  renderedText,
  ZEBRA,
} from "./support/printing.js";

const SESSION: FloorSession = {
  id: OPERATOR_ID,
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
  sessionId: 1,
};
const SECOND_SSCC = buildSscc(0, PREFIX, 1501);

/** A scanner the test reads codes into. */
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
    listening: () =>
      waitFor(() => {
        if (listener === null) throw new Error("the work screen does not listen yet");
      }),
    emit: (raw: string) => listener?.(raw),
  };
}

type Station = Awaited<ReturnType<typeof printStation>>;

interface Options {
  shell?: ReturnType<typeof fakeHardware>;
  runtime?: PrintRuntime;
  onSetup?: () => void;
  onLeave?: () => void;
}

/** The work screen over `at`, printing through `shell` (a printer that takes every label by default). */
function work(at: Station, options: Options = {}) {
  const gate = createWorkGate();
  const scanner = fakeSource();
  const shell = options.shell ?? fakeHardware();
  const runtime = options.runtime ?? manualRuntime(shell.hardware).runtime;
  const power = vi.fn(async (_awake: boolean) => undefined);
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
    awake: createSystemAwake(power),
    render: async (spec, fields, printer) => {
      const text = renderedText(printer, fields.sscc, `${spec.widthMm}x${spec.heightMm}`);
      const bytes = new Uint8Array(text.length);
      for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
      return bytes;
    },
    ...(options.onSetup === undefined ? {} : { onSetup: options.onSetup }),
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
    power,
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

/** Twelve codes: the box fills and closes by itself. */
async function fillBox(screenWork: ReturnType<typeof work>, prefix = "P"): Promise<void> {
  await screenWork.scanner.listening();
  await screenWork.settled();
  for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`${prefix}${index}`));
}

function lastLine(): string | null {
  return document.querySelector(".work-screen__last")?.textContent ?? null;
}

function scans(at: Station): unknown {
  return rows(at.db, "SELECT count(*) AS n FROM floor_scans")[0]?.["n"];
}

describe("the label of a box the work screen closes", () => {
  it("prints before the next scan is taken, and the work goes on once the printer took it", async () => {
    const at = await printStation();
    const screenWork = work(at);
    await fillBox(screenWork);
    expect(screenWork.shell.sends).toEqual([
      { target: ZEBRA.target, text: renderedText(ZEBRA, FIRST_SSCC) },
    ]);
    expect(jobRows(at.db)).toEqual([
      expect.objectContaining({ state: "sent", attempts: 1, sscc: FIRST_SSCC }),
    ]);
    expect(screen.queryByText("Этикетка короба не напечатана")).toBeNull();
    await screenWork.scan(km("P12"));
    expect(scans(at)).toBe(13);
  });

  it("stops at a label that failed, takes no scan, and goes on once the operator printed it again", async () => {
    const at = await printStation();
    const answers = [{ sent: false, code: "not_sent" } as const, { sent: true } as const];
    const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    expect(screen.getByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(screen.getByText("Принтер не принял задание: этикетка не напечатана.")).toBeTruthy();
    expect(screen.getByText(`SSCC короба: ${formatSsccHri(FIRST_SSCC)}`)).toBeTruthy();
    // No «Этикетка напечаталась»: nothing left the computer.
    expect(screen.queryByRole("button", { name: "Этикетка напечаталась" })).toBeNull();
    await screenWork.scan(km("P12"));
    expect(lastLine()).toBe(
      "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.",
    );
    expect(scans(at)).toBe(12);
    await screenWork.press("Напечатать снова");
    expect(screenWork.shell.sends).toHaveLength(2);
    expect(screen.queryByText("Этикетка короба не напечатана")).toBeNull();
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_exceptions")).toEqual([{ n: 0 }]);
    await screenWork.scan(km("P12"));
    expect(scans(at)).toBe(13);
  });

  it("never prints a label of an unknown outcome again by itself; again only with the operator's reason", async () => {
    const at = await printStation();
    const answers = [{ sent: false, code: "outcome_unknown" } as const];
    const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    expect(screen.getByText("Неизвестно, напечаталась ли этикетка")).toBeTruthy();
    expect(
      screen.getByText(
        "Связь с принтером оборвалась посреди передачи. Посмотрите, вышла ли этикетка.",
      ),
    ).toBeTruthy();
    expect(shell.sends).toHaveLength(1);
    // The work screen opened again (a leave and a return) sends nothing either.
    screenWork.view.unmount();
    const again = work(at, { shell });
    await again.settled();
    expect(screen.getByText("Неизвестно, напечаталась ли этикетка")).toBeTruthy();
    expect(shell.sends).toHaveLength(1);
    await again.press("Напечатать снова");
    expect(shell.sends).toHaveLength(1);
    expect(screen.getByText("Почему печатаете снова?")).toBeTruthy();
    await again.press("Замятие в принтере");
    expect(shell.sends).toHaveLength(2);
    expect(rows(at.db, "SELECT kind, reason_code FROM floor_exceptions")).toEqual([
      { kind: "reprint", reason_code: "printer_jam" },
    ]);
    expect(screen.queryByText("Неизвестно, напечаталась ли этикетка")).toBeNull();
  });

  it("takes «Этикетка напечаталась» for an unknown one, and the check comes next when asked for", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const shell = fakeHardware(async () => ({ sent: false, code: "outcome_unknown" }));
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    await screenWork.press("Этикетка напечаталась");
    expect(screen.getByText("Проверьте этикетку")).toBeTruthy();
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent", attempts: 1 });
    expect(shell.sends).toHaveLength(1);
  });

  it("goes on without a label only after the operator confirms, with its record", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    await screenWork.press("Продолжить без этикетки");
    expect(screen.getByText("Продолжить без этикетки?")).toBeTruthy();
    await screenWork.press("Назад");
    expect(screen.getByText("Этикетка короба не напечатана")).toBeTruthy();
    await screenWork.press("Продолжить без этикетки");
    await screenWork.press("Продолжить без этикетки");
    expect(jobRows(at.db)[0]).toMatchObject({ state: "skipped" });
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_label'")).toEqual([
      { n: 1 },
    ]);
    await screenWork.scan(km("P12"));
    expect(scans(at)).toBe(13);
  });

  it("prints on another printer of the settings, rendering for its language and resolution", async () => {
    const at = await printStation();
    const answers = [{ sent: false, code: "not_sent" } as const];
    const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    await screenWork.press("Другой принтер");
    await screen.findByRole("button", { name: "TSC на COM4 · TSPL · 300 dpi" });
    await screenWork.press("TSC на COM4 · TSPL · 300 dpi");
    expect(shell.sends.at(-1)).toEqual({
      target: { kind: "serial", port: "COM4", baud: 9600 },
      text: renderedText({ language: "tspl", dpi: 300 }, FIRST_SSCC),
    });
    expect(screen.queryByText("Этикетка короба не напечатана")).toBeNull();
  });

  it("says there is no printer, and offers the setup when the floor gives one", async () => {
    const at = await printStation({ assignments: { box: null, pallet: null, duplicate: null } });
    const onSetup = vi.fn();
    const screenWork = work(at, { onSetup });
    await fillBox(screenWork);
    expect(
      screen.getByText(
        "Принтер для коробов не назначен. Назначьте его в настройке рабочего места.",
      ),
    ).toBeTruthy();
    expect(screenWork.shell.sends).toEqual([]);
    await screenWork.press("Напечатать снова");
    expect(screen.getByText("Нет принтера для этикетки: настройте принтер.")).toBeTruthy();
    await screenWork.press("Настроить принтер");
    expect(onSetup).toHaveBeenCalledTimes(1);
  });

  it("never holds the operator: «Выйти из смены» stays open at a label that waits", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const onLeave = vi.fn();
    const screenWork = work(at, { shell, onLeave });
    await fillBox(screenWork);
    const leave = screen.getByRole("button", { name: "Выйти из смены" });
    expect(leave.hasAttribute("disabled")).toBe(false);
    fireEvent.click(leave);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

describe("the check of a printed label on the work screen", () => {
  it("takes the SSCC scan before the pipeline: another box's label is refused, the right one goes on", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const screenWork = work(at);
    await fillBox(screenWork);
    expect(screen.getByText("Проверьте этикетку")).toBeTruthy();
    await screenWork.scan(`]C100${SECOND_SSCC}`);
    expect(
      screen.getByText(`Это этикетка другого короба: ${formatSsccHri(SECOND_SSCC)}.`),
    ).toBeTruthy();
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("error");
    await screenWork.scan(km("P12"));
    expect(screen.getByText("Это не код SSCC. Отсканируйте этикетку короба.")).toBeTruthy();
    // Neither scan reached the pipeline: no journal row, no code accepted.
    expect(scans(at)).toBe(12);
    await screenWork.scan(formatSsccHri(FIRST_SSCC));
    expect(screen.queryByText("Проверьте этикетку")).toBeNull();
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("ok");
    expect(jobRows(at.db)[0]).toMatchObject({ state: "verified" });
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_label'")).toEqual([
      { n: 1 },
    ]);
    await screenWork.scan(km("P12"));
    expect(scans(at)).toBe(13);
  });

  it("skips the check at once, and reprints an unreadable label with a reason", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const screenWork = work(at);
    await fillBox(screenWork);
    await screenWork.press("Напечатать снова");
    await screenWork.press("Этикетка не читается");
    expect(screenWork.shell.sends).toHaveLength(2);
    expect(screen.getByText("Проверьте этикетку")).toBeTruthy();
    await screenWork.press("Пропустить проверку");
    expect(screen.queryByText("Проверьте этикетку")).toBeNull();
    expect(jobRows(at.db)[0]).toMatchObject({ state: "skipped", attempts: 2 });
  });
});

describe("a label a stop of the station left", () => {
  it("shows on entry as unknown when its send was cut, and nothing is sent", async () => {
    const at = await printStation();
    await closeBoxWithLabel(at);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sending', attempts = 1").run();
    const screenWork = work(at);
    await screenWork.settled();
    expect(screen.getByText("Неизвестно, напечаталась ли этикетка")).toBeTruthy();
    expect(
      screen.getByText(
        "Печать прервалась: программа или компьютер перезапустились. Посмотрите, вышла ли этикетка.",
      ),
    ).toBeTruthy();
    expect(screenWork.shell.sends).toEqual([]);
  });

  it("is sent on entry when it was written with its box and never sent", async () => {
    const at = await printStation();
    await closeBoxWithLabel(at);
    const screenWork = work(at);
    await screenWork.settled();
    expect(screenWork.shell.sends).toEqual([
      { target: ZEBRA.target, text: renderedText(ZEBRA, FIRST_SSCC) },
    ]);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent" });
  });

  it("keeps the next full box open while it waits", async () => {
    const at = await printStation();
    await closeBoxWithLabel(at);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'").run();
    // A second box the station left full: it does not close while the first label waits.
    const filling = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    for (let index = 0; index < 12; index += 1) await processScan(filling, km(`Q${index}`));
    const screenWork = work(at);
    await screenWork.settled();
    expect(screen.getByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { n: 1 },
    ]);
    await screenWork.press("Продолжить без этикетки");
    await screenWork.press("Продолжить без этикетки");
    // Its turn now: the full box closes, and its label prints.
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { n: 0 },
    ]);
    expect(screenWork.shell.sends).toEqual([
      { target: ZEBRA.target, text: renderedText(ZEBRA, SECOND_SSCC) },
    ]);
    expect(jobRows(at.db).map((row) => row["state"])).toEqual(["skipped", "sent"]);
  });
});

describe("a send that does not answer", () => {
  it("waits on the screen, and turns unknown when its limit runs out", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const { runtime, expire } = manualRuntime(shell.hardware);
    const screenWork = work(at, { shell, runtime });
    await screenWork.scanner.listening();
    await screenWork.settled();
    for (let index = 0; index < 11; index += 1) await screenWork.scan(km(`P${index}`));
    shell.holdSends();
    await act(async () => {
      screenWork.scanner.emit(km("P11"));
    });
    await waitFor(() => expect(shell.heldSends()).toBe(1));
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sending" });
    expect(screen.getByText("Этикетка отправлена на принтер…")).toBeTruthy();
    await act(async () => {
      expire();
      await screenWork.gate.drain();
    });
    expect(
      screen.getByText("Принтер не ответил вовремя. Посмотрите, вышла ли этикетка."),
    ).toBeTruthy();
    expect(screen.queryByText("Этикетка отправлена на принтер…")).toBeNull();
    shell.releaseSend({ sent: true });
    await screenWork.settled();
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown", error_code: "timeout" });
  });
});

describe("the computer while the work screen is open", () => {
  it("stays awake, and may sleep once the screen goes", async () => {
    const at = await printStation();
    const screenWork = work(at);
    await screenWork.settled();
    await waitFor(() => expect(screenWork.power.mock.calls).toEqual([[true]]));
    screenWork.view.unmount();
    await waitFor(() => expect(screenWork.power.mock.calls).toEqual([[true], [false]]));
  });
});
```

Правка `apps/standalone/test/floor-work-screen.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import type { WorkShift } from "../src/floor/shifts/shift-copies.js";
import { createWorkGate } from "../src/floor/work-gate.js";
import { scanTime, WorkScreen, type WorkScreenProps } from "../src/floor/work/WorkScreen.js";
import { HostError } from "../src/host/client.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { WorkShift } from "../src/floor/shifts/shift-copies.js";
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import { createWorkGate } from "../src/floor/work-gate.js";
import { scanTime, WorkScreen, type WorkScreenProps } from "../src/floor/work/WorkScreen.js";
import { createSystemAwake } from "../src/hardware/awake.js";
import { HostError } from "../src/host/client.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

const SESSION: FloorSession = {
```

заменить на:

<!-- prettier-ignore -->
```tsx
} from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRender, setUpPrinting } from "./support/printing.js";

const SESSION: FloorSession = {
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
}

async function station(shift = ENTERED): Promise<Station> {
  const { db, executor } = openLocalDb();
  return { db, local: executor, shift: await enteredShift(executor, shift) };
```

заменить на:

<!-- prettier-ignore -->
```tsx
}

/** A station with the shift entered and the Zebra set up for boxes (plan 2a7). */
async function station(shift = ENTERED): Promise<Station> {
  const { db, executor } = openLocalDb();
  await setUpPrinting(executor);
  return { db, local: executor, shift: await enteredShift(executor, shift) };
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
    signal: vi.fn<(tone: SignalTone) => void>(),
    ...overrides,
```

заменить на:

<!-- prettier-ignore -->
```tsx
    signal: vi.fn<(tone: SignalTone) => void>(),
    printing: createPrintRuntime(fakeHardware().hardware.printBytes),
    awake: createSystemAwake(vi.fn(async () => undefined)),
    render: fakeRender,
    ...overrides,
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/awake.test.ts test/floor-app.test.tsx test/floor-work-print.test.tsx test/floor-work-screen.test.tsx`
Expected: FAIL — `test/awake.test.ts`, `test/floor-work-print.test.tsx`, `test/floor-work-screen.test.tsx` и `test/floor-app.test.tsx` не загружаются (`Failed to resolve import "../src/hardware/awake.js"`); `test/app.test.tsx` — «lets the computer sleep when it starts: a reloaded webview's request is let go».

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/app/App.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
} from "../floor/scan-source.js";
import { applySavedScanners } from "../floor/setup/workstation-settings.js";
import type { FloorOperator } from "../floor/sign-in.js";
import { createTauriHardware, type HardwareApi } from "../hardware/hardware.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
} from "../floor/scan-source.js";
import { createPrintRuntime } from "../floor/print/print-runtime.js";
import { applySavedScanners } from "../floor/setup/workstation-settings.js";
import type { FloorOperator } from "../floor/sign-in.js";
import { createSystemAwake } from "../hardware/awake.js";
import { createTauriHardware, type HardwareApi } from "../hardware/hardware.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  }, [localDb, hardwareApi]);
  const kiosk = useMemo(
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }, [localDb, hardwareApi]);
  // One queue of sends per printer for the whole app, and the request that
  // keeps the computer awake, let go at the start: a webview that reloaded
  // during a shift leaves the shell's request held.
  const printing = useMemo(() => createPrintRuntime(hardwareApi.printBytes), [hardwareApi]);
  const awake = useMemo(() => createSystemAwake(hardwareApi.setSystemAwake), [hardwareApi]);
  useEffect(() => {
    void awake.reset();
  }, [awake]);
  const kiosk = useMemo(
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
              source={scanner}
              {...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs })}
```

заменить на:

<!-- prettier-ignore -->
```tsx
              source={scanner}
              printing={printing}
              awake={awake}
              {...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs })}
```

Правка `apps/standalone/src/app/shell.css`:

Фрагмент 1:

<!-- prettier-ignore -->
```css
.work-screen__confirm {
  display: grid;
  gap: 16px;
}
```

заменить на:

<!-- prettier-ignore -->
```css
.work-screen__confirm {
  display: grid;
  gap: 16px;
}

/* The label the work stopped for (plan 2a7): its check or its recovery,
   with the reasons of a reprint as a grid of 64 px buttons. */
.work-screen__label p {
  margin: 0 0 8px;
}

.work-screen__reasons {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}
```

Правка `apps/standalone/src/floor/FloorApp.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
} from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import { createOperatorIdleLock, OPERATOR_IDLE_TIMEOUT_MS } from "./idle-lock.js";
import type { ScanSource } from "./scan-source.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
} from "../host/protocol.js";
import type { SystemAwake } from "../hardware/awake.js";
import type { LocalExecutor } from "../local/executor.js";
import { createOperatorIdleLock, OPERATOR_IDLE_TIMEOUT_MS } from "./idle-lock.js";
import type { RenderLabel } from "./print/print-jobs.js";
import type { PrintRuntime } from "./print/print-runtime.js";
import type { ScanSource } from "./scan-source.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  source: ScanSource;
  /** Nobody touched the station this long: the operator is signed out. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
  source: ScanSource;
  /** The app's printers (plan 2a7). */
  printing: PrintRuntime;
  /** Keeps the computer awake while a work screen is open. */
  awake: SystemAwake;
  /** How a label is rendered; tests give their own. */
  render?: RenderLabel;
  /** Nobody touched the station this long: the operator is signed out. */
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  source,
  idleTimeoutMs = OPERATOR_IDLE_TIMEOUT_MS,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  source,
  printing,
  awake,
  render,
  idleTimeoutMs = OPERATOR_IDLE_TIMEOUT_MS,
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
        onRecorded={recorded}
      />
```

заменить на:

<!-- prettier-ignore -->
```tsx
        onRecorded={recorded}
        printing={printing}
        awake={awake}
        {...(render === undefined ? {} : { render })}
      />
```

Создать `apps/standalone/src/floor/print/LabelPanel.tsx`:

<!-- prettier-ignore -->
```tsx
import { formatSsccHri } from "@markiro/domain";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import { REPRINT_REASONS } from "../exception-reasons.js";
import type { PrinterProfile } from "../setup/workstation-settings.js";
import type { PrintJob } from "./print-jobs.js";
import { awaitsCheck, type PrintAgain } from "./print-resolution.js";

/** What the panel says under the label: a scan that did not match, a decision that could not be done. */
export type LabelNote =
  | { kind: "mismatch"; sscc: string }
  | { kind: "not_sscc" }
  | { kind: "no_printer" }
  | { kind: "render_failed" }
  | { kind: "moved" };

export interface LabelPanelProps {
  /** A job that waits: failed, unknown, or sent with its check to do. */
  job: PrintJob;
  /** A decision is being carried out: every button waits. */
  busy: boolean;
  note: LabelNote | null;
  /** The workstation's printers, read when the operator asks for another one. */
  loadPrinters: () => Promise<PrinterProfile[]>;
  onPrintAgain: (request: PrintAgain) => void;
  onPrinted: () => void;
  onSkip: () => void;
  /** The workstation setup; absent where the floor gives none. */
  onSetup?: () => void;
}

type Mode =
  | { kind: "main" }
  | { kind: "reason"; printer: PrinterProfile | null }
  | { kind: "printers"; printers: PrinterProfile[] | null }
  | { kind: "skip" };

function noteText(note: LabelNote, t: ReturnType<typeof useTranslation>["t"]): string {
  switch (note.kind) {
    case "mismatch":
      return t("floor.print.check.mismatch", { sscc: formatSsccHri(note.sscc) });
    case "not_sscc":
      return t("floor.print.check.notSscc");
    case "no_printer":
      return t("floor.print.notes.noPrinter");
    case "render_failed":
      return t("floor.print.notes.renderFailed");
    case "moved":
      return t("floor.print.notes.moved");
  }
}

/**
 * The label of the box the work stopped for (stage 2a spec §5.7.5): its
 * check — scan the SSCC, or skip it — or its recovery when it failed or its
 * outcome is unknown. Only the operator sends a label again: a label that
 * may already exist only with a reason, which the panel asks before the
 * send; «Продолжить без этикетки» after a confirmation. The work screen's
 * «Выйти из смены» stays outside the panel, so nobody is held here.
 */
export function LabelPanel({
  job,
  busy,
  note,
  loadPrinters,
  onPrintAgain,
  onPrinted,
  onSkip,
  onSetup,
}: LabelPanelProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>({ kind: "main" });
  const checking = awaitsCheck(job);
  // A label that may already be on a box: a second one needs a reason.
  const mayExist = checking || job.state === "unknown";
  const sscc = t("floor.print.sscc", { sscc: formatSsccHri(job.sscc) });

  const again = (printer: PrinterProfile | null) => {
    if (mayExist) {
      setMode({ kind: "reason", printer });
      return;
    }
    setMode({ kind: "main" });
    onPrintAgain({ reason: null, printer });
  };

  const choosePrinter = () => {
    setMode({ kind: "printers", printers: null });
    loadPrinters().then(
      (printers) =>
        setMode((now) => (now.kind === "printers" ? { kind: "printers", printers } : now)),
      () => setMode((now) => (now.kind === "printers" ? { kind: "printers", printers: [] } : now)),
    );
  };

  const back = (
    <Button
      size="floor"
      variant="secondary"
      disabled={busy}
      onClick={() => setMode({ kind: "main" })}
    >
      {t("floor.print.back")}
    </Button>
  );

  if (mode.kind === "reason") {
    return (
      <Alert tone="warn" title={t("floor.print.reason.title")} className="work-screen__label">
        <p>{t("floor.print.reason.hint")}</p>
        <p>{sscc}</p>
        <div className="standalone-form__actions work-screen__reasons">
          {REPRINT_REASONS.map((reason) => (
            <Button
              key={reason}
              size="floor"
              disabled={busy}
              onClick={() => {
                setMode({ kind: "main" });
                onPrintAgain({ reason, printer: mode.printer });
              }}
            >
              {t(`floor.print.reason.${reason}`)}
            </Button>
          ))}
          {back}
        </div>
      </Alert>
    );
  }

  if (mode.kind === "printers") {
    return (
      <Alert tone="warn" title={t("floor.print.printers.title")} className="work-screen__label">
        <p>{sscc}</p>
        {mode.printers !== null && mode.printers.length === 0 && (
          <p>{t("floor.print.printers.none")}</p>
        )}
        <div className="standalone-form__actions">
          {(mode.printers ?? []).map((printer) => (
            <Button key={printer.id} size="floor" disabled={busy} onClick={() => again(printer)}>
              {t("floor.print.printers.option", {
                name: printer.name,
                language: printer.language.toUpperCase(),
                dpi: printer.dpi,
              })}
            </Button>
          ))}
          {back}
        </div>
      </Alert>
    );
  }

  if (mode.kind === "skip") {
    return (
      <Alert tone="warn" title={t("floor.print.skipConfirm.title")} className="work-screen__label">
        <p>{t("floor.print.skipConfirm.body")}</p>
        <p>{sscc}</p>
        <div className="standalone-form__actions">
          {back}
          <Button
            size="floor"
            disabled={busy}
            onClick={() => {
              setMode({ kind: "main" });
              onSkip();
            }}
          >
            {t("floor.print.skipConfirm.confirm")}
          </Button>
        </div>
      </Alert>
    );
  }

  if (checking) {
    return (
      <Alert tone="info" title={t("floor.print.check.title")} className="work-screen__label">
        <p>{t("floor.print.check.body")}</p>
        <p>{sscc}</p>
        {note !== null && <p role="alert">{noteText(note, t)}</p>}
        <div className="standalone-form__actions">
          <Button size="floor" variant="secondary" disabled={busy} onClick={() => again(null)}>
            {t("floor.print.printAgain")}
          </Button>
          <Button size="floor" variant="secondary" disabled={busy} onClick={onSkip}>
            {t("floor.print.check.skip")}
          </Button>
        </div>
      </Alert>
    );
  }

  return (
    <Alert
      tone="error"
      title={t(job.state === "unknown" ? "floor.print.unknownTitle" : "floor.print.failedTitle")}
      className="work-screen__label"
    >
      {job.errorCode !== null && <p>{t(`floor.print.codes.${job.errorCode}`)}</p>}
      <p>{sscc}</p>
      {note !== null && <p role="alert">{noteText(note, t)}</p>}
      <div className="standalone-form__actions">
        {job.state === "unknown" && (
          <Button size="floor" disabled={busy} onClick={onPrinted}>
            {t("floor.print.printed")}
          </Button>
        )}
        <Button size="floor" disabled={busy} onClick={() => again(null)}>
          {t("floor.print.printAgain")}
        </Button>
        <Button size="floor" variant="secondary" disabled={busy} onClick={choosePrinter}>
          {t("floor.print.otherPrinter")}
        </Button>
        {onSetup !== undefined && (
          <Button size="floor" variant="secondary" disabled={busy} onClick={onSetup}>
            {t("floor.print.setup")}
          </Button>
        )}
        <Button
          size="floor"
          variant="secondary"
          disabled={busy}
          onClick={() => setMode({ kind: "skip" })}
        >
          {t("floor.print.skip")}
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
import type { FloorSession } from "../../app/shell.js";
import type { CodeCheck, SsccBlock, SsccBlockRequest } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { ScanSource } from "../scan-source.js";
import type { WorkShift } from "../shifts/shift-copies.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { FloorSession } from "../../app/shell.js";
import type { SystemAwake } from "../../hardware/awake.js";
import type { CodeCheck, SsccBlock, SsccBlockRequest } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { LabelPanel, type LabelNote } from "../print/LabelPanel.js";
import {
  boxLabelStep,
  isOpenJob,
  readOpenJob,
  recoverInterruptedJobs,
  sendLabelJob,
  StaleJobError,
  type PrintJob,
  type RenderLabel,
} from "../print/print-jobs.js";
import {
  awaitsCheck,
  checkLabel,
  confirmPrinted,
  LabelRenderError,
  NoPrinterError,
  printAgain,
  skipLabel,
  type PrintAgain,
  type ResolveContext,
} from "../print/print-resolution.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import type { ScanSource } from "../scan-source.js";
import { readWorkstationSettings } from "../setup/workstation-settings.js";
import type { WorkShift } from "../shifts/shift-copies.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  signal?: (tone: SignalTone) => void;
}

/** What stops the scanning until the operator acts (stage 2a spec §5.7.3). */
type Stop =
  | { kind: "system_error" }
  | { kind: "confirm_close" }
  | { kind: "no_serials"; reason: "offline" | "exhausted" | "failed"; full: boolean }
  | { kind: "close_failed"; full: boolean };

/** The last scan, said in words under the box. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
  signal?: (tone: SignalTone) => void;
  /** The app's printers: one send at a time per address, each within its limit (plan 2a7). */
  printing: PrintRuntime;
  /** Keeps the computer awake while the screen is open (decision 34). */
  awake: SystemAwake;
  /** The workstation setup, from the recovery of a label (plan 2a7); none — no button. */
  onSetup?: () => void;
  /** How a label is rendered; the app's rasterizer by default. */
  render?: RenderLabel;
}

/**
 * What stops the scanning until the operator acts (stage 2a spec §5.7.3):
 * plan 2a7 adds the label of a closed box that waits — its check, or its
 * recovery when it failed or its outcome is unknown.
 */
type Stop =
  | { kind: "system_error" }
  | { kind: "confirm_close" }
  | { kind: "no_serials"; reason: "offline" | "exhausted" | "failed"; full: boolean }
  | { kind: "close_failed"; full: boolean }
  | { kind: "label"; job: PrintJob };

/** The last scan, said in words under the box. */
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  signal = playSignalTone,
}: WorkScreenProps) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  signal = playSignalTone,
  printing,
  awake,
  onSetup,
  render,
}: WorkScreenProps) {
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  const [planReached, setPlanReached] = useState(false);
  const capacity = shift.copy.boxCapacity;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const [planReached, setPlanReached] = useState(false);
  const [labelNote, setLabelNote] = useState<LabelNote | null>(null);
  const [labelBusy, setLabelBusy] = useState(false);
  // A label on its way to the printer: the work waits for it, and says so.
  const [sending, setSending] = useState(false);
  const capacity = shift.copy.boxCapacity;
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
  }, []);
  const planShown = useRef(false);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }, []);
  // The computer stays awake while the screen is open.
  useEffect(() => awake.hold(), [awake]);
  const planShown = useRef(false);
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
  );

  const refresh = useCallback(async () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  );

  const printContext = useMemo<ResolveContext>(
    () => ({
      local,
      pairing: where,
      runtime: printing,
      now: () => new Date(),
      operatorId: operator.id,
      newId: () => crypto.randomUUID(),
    }),
    [local, where, printing, operator.id],
  );
  const labelStep = useMemo(
    () =>
      boxLabelStep({
        local,
        pairing: where,
        shift,
        operatorName: operator.name,
        newId: () => crypto.randomUUID(),
        ...(render === undefined ? {} : { render }),
      }),
    [local, where, shift, operator.name, render],
  );

  /** The label stop for `job` when it still waits, and the work goes on when it does not. */
  const showLabel = useCallback(
    (job: PrintJob | null) => {
      setStop(job !== null && isOpenJob(job) ? { kind: "label", job } : null);
    },
    [setStop],
  );

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
      try {
        job = await sendLabelJob(printContext, job);
      } finally {
        if (alive.current) setSending(false);
      }
      live.current.onRecorded();
    }
    showLabel(job);
  }, [printContext, local, where, shift.copy.id, showLabel]);

  const refresh = useCallback(async () => {
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
    async (full: boolean): Promise<void> => {
      const close = () => (full ? closeIfFull(context) : closeOpenBox(context));
      let result = await closeSettled(close);
```

заменить на:

<!-- prettier-ignore -->
```tsx
    async (full: boolean): Promise<void> => {
      // A label that waits keeps the next box open (stage 2a spec §5.7.5).
      const waiting = await readOpenJob(local, where, shift.copy.id);
      if (waiting !== null) {
        await settleLabel();
        return;
      }
      const steps = [labelStep];
      const close = () => (full ? closeIfFull(context, steps) : closeOpenBox(context, steps));
      let result = await closeSettled(close);
```

Фрагмент 8:

<!-- prettier-ignore -->
```tsx
        live.current.onRecorded();
        // The half rule after every close: work of its own, not the line's.
```

заменить на:

<!-- prettier-ignore -->
```tsx
        live.current.onRecorded();
        await settleLabel();
        // The half rule after every close: work of its own, not the line's.
```

Фрагмент 9:

<!-- prettier-ignore -->
```tsx
    },
    [context, supply, setStop],
  );
```

заменить на:

<!-- prettier-ignore -->
```tsx
    },
    [local, where, shift.copy.id, settleLabel, labelStep, context, supply, setStop],
  );
```

Фрагмент 10:

<!-- prettier-ignore -->
```tsx
  );

  /** One scan, in its turn: taken only while nothing stops the work. */
  const scan = useCallback(
    async (raw: string): Promise<void> => {
      if (stopRef.current !== null) {
        setLast({ kind: "paused", leaving: false });
```

заменить на:

<!-- prettier-ignore -->
```tsx
  );

  /** A scan while a label's check waits: its SSCC, compared with the label's. */
  const check = useCallback(
    async (job: PrintJob, raw: string): Promise<void> => {
      const say = live.current.t;
      let result: Awaited<ReturnType<typeof checkLabel>>;
      try {
        result = await checkLabel(printContext, job, raw);
      } catch (error) {
        if (!(error instanceof StaleJobError)) throw error;
        setLabelNote({ kind: "moved" });
        await settleLabel();
        return;
      }
      if (result.kind === "verified") {
        live.current.onRecorded();
        setLabelNote(null);
        show("ok", say("floor.print.signal.verified"));
        showLabel(result.job);
        // A box a stop of the station left full closes now, with its label.
        if (stopRef.current === null) await closeBox(true);
        await refresh();
        return;
      }
      setLabelNote(result.kind === "mismatch" ? { kind: "mismatch", sscc: result.sscc } : result);
      show(
        "error",
        say(
          result.kind === "mismatch" ? "floor.print.signal.mismatch" : "floor.print.signal.notSscc",
        ),
      );
    },
    [printContext, settleLabel, show, showLabel, closeBox, refresh],
  );

  /** One scan, in its turn: taken only while nothing stops the work. */
  const scan = useCallback(
    async (raw: string): Promise<void> => {
      const stopped = stopRef.current;
      // The check of a label takes the scan before the pipeline (plan 2a6's contract).
      if (stopped?.kind === "label" && awaitsCheck(stopped.job)) {
        try {
          await check(stopped.job, raw);
        } catch {
          setStop({ kind: "system_error" });
          show("error", live.current.t("floor.work.signal.systemError"));
        }
        return;
      }
      if (stopped !== null) {
        setLast({ kind: "paused", leaving: false });
```

Фрагмент 11:

<!-- prettier-ignore -->
```tsx
    },
    [context, settle, setStop, show],
  );

  const scanRef = useRef(scan);
```

заменить на:

<!-- prettier-ignore -->
```tsx
    },
    [check, context, settle, setStop, show],
  );

  /**
   * A decision on the waiting label, as the line's next piece of work: the
   * panel waits while it runs, and shows where the job ended. A printer or a
   * render the decision could not have, and a job moved on meanwhile, are
   * said under the label; any other failure is the system error, whose
   * dismissal reads the label again.
   */
  const decide = (work: (job: PrintJob) => Promise<PrintJob>) => {
    const stopped = stopRef.current;
    if (stopped?.kind !== "label") return;
    setLabelBusy(true);
    setLabelNote(null);
    void track(
      queue.run(async () => {
        try {
          const job = await work(stopped.job);
          live.current.onRecorded();
          showLabel(job);
          if (stopRef.current === null) await closeBox(true);
        } catch (error) {
          if (error instanceof NoPrinterError) setLabelNote({ kind: "no_printer" });
          else if (error instanceof LabelRenderError) setLabelNote({ kind: "render_failed" });
          else if (error instanceof StaleJobError) {
            setLabelNote({ kind: "moved" });
            await settleLabel();
          } else throw error;
        } finally {
          if (alive.current) setLabelBusy(false);
        }
        await refresh();
      }),
    ).catch(() => setStop({ kind: "system_error" }));
  };

  const decideAgain = (request: PrintAgain) =>
    decide(async (job) => {
      const { boxTemplate } = shift.snapshot;
      const settings = await readWorkstationSettings(local);
      return printAgain(printContext, job, request, settings, boxTemplate, render);
    });

  /** The system error dismissed: the work goes on, after the label that may wait. */
  const dismissSystemError = () => {
    setStop(null);
    void track(
      queue.run(async () => {
        await settleLabel();
        if (stopRef.current === null) await closeBox(true);
        await refresh();
      }),
    ).catch(() => setStop({ kind: "system_error" }));
  };

  const scanRef = useRef(scan);
```

Фрагмент 12:

<!-- prettier-ignore -->
```tsx
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
```

заменить на:

<!-- prettier-ignore -->
```tsx
  );

  // On entry: the numbers, the label a stop of the station left waiting, and
  // a box it left full closes first.
  useEffect(() => {
    void track(
      queue.run(async () => {
        await refresh();
        await settleLabel();
        // Kept open while the label waits (`closeBox` reads it again).
        await closeBox(true);
        await refresh();
      }),
    ).catch(() => setStop({ kind: "system_error" }));
  }, [track, queue, refresh, settleLabel, closeBox, setStop]);

  // On entry and whenever the link is back: serials by the half rule; a
```

Фрагмент 13:

<!-- prettier-ignore -->
```tsx
            action={
              <Button size="floor" variant="secondary" onClick={() => setStop(null)}>
                {t("floor.work.systemError.dismiss")}
```

заменить на:

<!-- prettier-ignore -->
```tsx
            action={
              <Button size="floor" variant="secondary" onClick={dismissSystemError}>
                {t("floor.work.systemError.dismiss")}
```

Фрагмент 14:

<!-- prettier-ignore -->
```tsx
            {t("floor.work.closeFailed.body")}
          </Alert>
        )}
        {planReached && (
```

заменить на:

<!-- prettier-ignore -->
```tsx
            {t("floor.work.closeFailed.body")}
          </Alert>
        )}
        {sending && <p aria-live="polite">{t("floor.print.sending")}</p>}
        {stop?.kind === "label" && (
          <LabelPanel
            // A new job, state or attempt starts the panel afresh.
            key={`${stop.job.id}:${stop.job.state}:${stop.job.attempts}`}
            job={stop.job}
            busy={labelBusy || leaving}
            note={labelNote}
            loadPrinters={async () => (await readWorkstationSettings(local)).printers}
            onPrintAgain={decideAgain}
            onPrinted={() => decide((job) => confirmPrinted(printContext, job))}
            onSkip={() => decide((job) => skipLabel(printContext, job))}
            {...(onSetup === undefined ? {} : { onSetup })}
          />
        )}
        {planReached && (
```

Создать `apps/standalone/src/hardware/awake.ts`:

<!-- prettier-ignore -->
```ts
import type { HardwareApi } from "./hardware.js";

/**
 * Keeping the computer awake while a shift's work screen is open (stage 2a
 * spec, decision 34, question В11): `hold()` while a screen needs it, and
 * the function it answers when the screen goes. The shell's request is
 * asked for on the first hold and let go after the last release, in the
 * order the screen asked — a release and a hold racing as one work screen
 * gives way to the next can never leave the computer asleep or awake by
 * mistake. A refusal of the shell is not the screen's concern: the work goes
 * on, and the manual Windows list checks `powercfg /requests`.
 */
export interface SystemAwake {
  /** Keeps the computer awake until the answered function is called (once; again is nothing). */
  hold: () => () => void;
  /**
   * Lets the computer sleep whatever was held: the app's start, which a
   * reload of the webview also is — the shell's request outlives the
   * webview that asked for it (plan 2a4's queued item 15).
   */
  reset: () => Promise<void>;
}

export function createSystemAwake(setSystemAwake: HardwareApi["setSystemAwake"]): SystemAwake {
  let holders = 0;
  // A reset forgets every hold before it: their releases ask nothing.
  let generation = 0;
  let chain: Promise<void> = Promise.resolve();

  function ask(awake: boolean): Promise<void> {
    chain = chain.then(() => setSystemAwake(awake)).catch(() => undefined);
    return chain;
  }

  return {
    hold: () => {
      holders += 1;
      if (holders === 1) void ask(true);
      const heldIn = generation;
      let released = false;
      return () => {
        if (released || heldIn !== generation) return;
        released = true;
        holders -= 1;
        if (holders === 0) void ask(false);
      };
    },
    reset: () => {
      holders = 0;
      generation += 1;
      return ask(false);
    },
  };
}
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
      "leave": "Выйти из смены"
    },
```

заменить на:

<!-- prettier-ignore -->
```json
      "leave": "Выйти из смены"
    },
    "print": {
      "sscc": "SSCC короба: {{sscc}}",
      "sending": "Этикетка отправлена на принтер…",
      "failedTitle": "Этикетка короба не напечатана",
      "unknownTitle": "Неизвестно, напечаталась ли этикетка",
      "codes": {
        "printer_unconfigured": "Принтер для коробов не назначен. Назначьте его в настройке рабочего места.",
        "render_failed": "Этикетку не удалось подготовить для этого принтера.",
        "not_sent": "Принтер не принял задание: этикетка не напечатана.",
        "invalid_target": "Адрес принтера в настройке неверен: этикетка не напечатана.",
        "invalid_payload": "Этикетку не удалось передать принтеру: она не напечатана.",
        "unsupported": "Этот способ подключения принтера здесь не работает: этикетка не напечатана.",
        "printer_busy": "Принтер ещё занят предыдущим заданием: эта этикетка не отправлена.",
        "outcome_unknown": "Связь с принтером оборвалась посреди передачи. Посмотрите, вышла ли этикетка.",
        "timeout": "Принтер не ответил вовремя. Посмотрите, вышла ли этикетка.",
        "interrupted": "Печать прервалась: программа или компьютер перезапустились. Посмотрите, вышла ли этикетка."
      },
      "printAgain": "Напечатать снова",
      "otherPrinter": "Другой принтер",
      "printed": "Этикетка напечаталась",
      "skip": "Продолжить без этикетки",
      "setup": "Настроить принтер",
      "back": "Назад",
      "skipConfirm": {
        "title": "Продолжить без этикетки?",
        "body": "Короб уже закрыт. Его нужно будет промаркировать позже: этикетку можно перепечатать в «Исключениях».",
        "confirm": "Продолжить без этикетки"
      },
      "reason": {
        "title": "Почему печатаете снова?",
        "hint": "Если этикетка уже вышла, новая будет с тем же номером SSCC: на коробе должна остаться одна.",
        "damaged_label": "Этикетка повреждена",
        "unreadable_label": "Этикетка не читается",
        "printer_jam": "Замятие в принтере",
        "quality_request": "Требование контроля качества",
        "other": "Другая причина"
      },
      "printers": {
        "title": "На какой принтер печатать?",
        "none": "В настройке рабочего места нет принтеров.",
        "option": "{{name}} · {{language}} · {{dpi}} dpi"
      },
      "check": {
        "title": "Проверьте этикетку",
        "body": "Отсканируйте SSCC на этикетке короба.",
        "skip": "Пропустить проверку",
        "mismatch": "Это этикетка другого короба: {{sscc}}.",
        "notSscc": "Это не код SSCC. Отсканируйте этикетку короба."
      },
      "notes": {
        "noPrinter": "Нет принтера для этикетки: настройте принтер.",
        "renderFailed": "Этикетку не удалось подготовить для этого принтера.",
        "moved": "Состояние этикетки изменилось — показано текущее."
      },
      "signal": {
        "verified": "ЭТИКЕТКА ВЕРНА",
        "mismatch": "ДРУГАЯ ЭТИКЕТКА",
        "notSscc": "НЕ SSCC"
      }
    },
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/awake.test.ts test/floor-app.test.tsx test/floor-work-print.test.tsx test/floor-work-screen.test.tsx`
Expected: PASS — `Test Files  5 passed (5)`, `Tests  154 passed (154)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  105 passed (105)`, `Tests  2511 passed (2511)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — рабочий экран сам отправляет снова этикетку с неизвестным исходом.
В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    if (job?.state === "prepared") {
```

заменить на:

<!-- prettier-ignore -->
```tsx
    if (job?.state === "prepared" || job?.state === "unknown") {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-print.test.tsx`
Expected: FAIL — «never prints a label of an unknown outcome again by itself; again only with the operator's reason», «shows on entry as unknown when its send was cut, and nothing is sent».

М2 — проверка этикетки не перехватывает скан.
В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      if (stopped?.kind === "label" && awaitsCheck(stopped.job)) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
      if (stopped?.kind === "label" && awaitsCheck(stopped.job) && raw === "") {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-print.test.tsx`
Expected: FAIL — «takes the SSCC scan before the pipeline: another box's label is refused, the right one goes on».

М3 — следующий короб закрывается, пока этикетка ждёт.
В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      const waiting = await readOpenJob(local, where, shift.copy.id);
      if (waiting !== null) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
      const waiting = await readOpenJob(local, where, shift.copy.id);
      if (waiting !== null && waiting.id === "") {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-print.test.tsx`
Expected: FAIL — «keeps the next full box open while it waits».

М4 — компьютер может заснуть во время смены.
В `apps/standalone/src/floor/work/WorkScreen.tsx` удалить фрагмент

<!-- prettier-ignore -->
```tsx
  useEffect(() => awake.hold(), [awake]);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-print.test.tsx`
Expected: FAIL — «stays awake, and may sleep once the screen goes».

М5 — перезагруженный вебвью оставляет компьютер не засыпающим.
В `apps/standalone/src/app/App.tsx` удалить фрагмент

<!-- prettier-ignore -->
```tsx
    void awake.reset();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx`
Expected: FAIL — «lets the computer sleep when it starts: a reloaded webview's request is let go».

М6 — оператор заперт на этикетке.
В `apps/standalone/src/floor/work/WorkScreen.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
            <Button size="floor" variant="secondary" disabled={leaving} onClick={onLeave}>
```

заменить на:

<!-- prettier-ignore -->
```tsx
            <Button
              size="floor"
              variant="secondary"
              disabled={leaving || stop?.kind === "label"}
              onClick={onLeave}
            >
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-print.test.tsx`
Expected: FAIL — «never holds the operator: «Выйти из смены» stays open at a label that waits».

М7 — удержание до сброса отпускает новое.
В `apps/standalone/src/hardware/awake.ts` фрагмент

<!-- prettier-ignore -->
```ts
        if (released || heldIn !== generation) return;
```

заменить на:

<!-- prettier-ignore -->
```ts
        if (released) return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/awake.test.ts`
Expected: FAIL — «lets go at the app's start whatever a reloaded webview held, and a later release asks nothing».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/app/App.tsx apps/standalone/src/app/shell.css apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/floor/print/LabelPanel.tsx apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/hardware/awake.ts apps/standalone/src/i18n/ru.json apps/standalone/test/app.test.tsx apps/standalone/test/awake.test.ts apps/standalone/test/floor-app.test.tsx apps/standalone/test/floor-work-print.test.tsx apps/standalone/test/floor-work-screen.test.tsx`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/app.test.tsx test/floor-app.test.tsx test/floor-work-print.test.tsx test/floor-work-screen.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/app.test.tsx test/floor-app.test.tsx test/floor-work-print.test.tsx test/floor-work-screen.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/app/App.tsx apps/standalone/src/app/shell.css apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/floor/print/LabelPanel.tsx apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/hardware/awake.ts apps/standalone/src/i18n/ru.json apps/standalone/test/app.test.tsx apps/standalone/test/awake.test.ts apps/standalone/test/floor-app.test.tsx apps/standalone/test/floor-work-print.test.tsx apps/standalone/test/floor-work-screen.test.tsx
git commit -m "feat(standalone): the work screen prints each box's label, stops at a label that waits and checks it by a scan; awake while open" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Настройка рабочего места — принтеры, назначения, пробная печать; вход из списка смен и из восстановления этикетки

Порт `WorkstationSetup.tsx` и `ui/setup/*` облачной станции заменой слоя данных на `workstation_settings` (§5.7.8): список принтеров (сеть, COM, принтер Windows из `list_usb_printers`; язык; разрешение), форма принтера (`printer-draft.ts`: первое, что неверно, словами; второй профиль того же адреса — отказ), назначения «Этикетка короба», «Этикетка паллеты», «Дубль кода», пробная печать — этикетка 58 × 40 только из ASCII со случайным Code 128 (`test-label.ts`) через ту же очередь принтеров и проверка её кода сканером; скан, который не код пробной этикетки, не показывается (это может быть бейдж). Сохраняется всё сразу на «Сохранить»; «Назад» уходит сразу и говорит, когда бросает изменения. Вход — «Рабочее место» в списке смен (`ShiftList.onSetup`) и «Настроить принтер» в восстановлении этикетки: `FloorApp` выходит из работы смены, дождавшись начатой работы (`work_left`), и после «Назад» возвращает в ту же смену (`work_entered`).

**Files:**

- Create: `apps/standalone/src/floor/setup/WorkstationSetup.tsx`, `apps/standalone/src/floor/setup/printer-draft.ts`, `apps/standalone/src/floor/setup/test-label.ts`
- Modify: `apps/standalone/src/app/App.tsx`, `apps/standalone/src/app/shell.css`, `apps/standalone/src/floor/FloorApp.tsx`, `apps/standalone/src/floor/shifts/ShiftList.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-setup.test.tsx` (Create), `apps/standalone/test/floor-app.test.tsx` (Modify)

**Interfaces:**

- Consumes: `readWorkstationSettings`, `saveWorkstationSettings`, `parsePrinterProfile`, `printerTargetKey`, `PRINT_PURPOSES` (задача 2); `renderLabel` (задача 3); `PrintRuntime`, `settleOutcome`, `RenderLabel` (задача 4); `HardwareApi.listUsbPrinters`; `ScanSource`; `sampleLabelData` (`@markiro/domain`); `ShiftList`, `FloorApp` (план 2a5).
- Produces:
  - `src/floor/setup/printer-draft.ts`: `type Kind`, `interface PrinterDraft`, `NEW_PRINTER`, `draftOf(profile)`, `type DraftError`, `profileOf(draft, newId)`;
  - `src/floor/setup/test-label.ts`: `makeTestCode(random?)`, `testLabelSpec(code, language)`, `scannedTestCode(raw)`;
  - `src/floor/setup/WorkstationSetup.tsx`: `interface WorkstationSetupProps { local; hardware; printing; source; render?; onSaved; onBack }`, `WorkstationSetup`;
  - `ShiftListProps.onSetup?`; `FloorAppProps.hardware: HardwareApi`; вид `FloorView` `setup` с возвратом в смену или в список;
  - ключи `floor.setup.*`, `floor.shifts.setup`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/floor-app.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
        printing={handlers.printing}
        awake={handlers.awake}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        printing={handlers.printing}
        hardware={handlers.hardware}
        awake={handlers.awake}
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
    printing: createPrintRuntime(fakeHardware().hardware.printBytes),
    awake: createSystemAwake(vi.fn(async () => undefined)),
```

заменить на:

<!-- prettier-ignore -->
```tsx
    printing: createPrintRuntime(fakeHardware().hardware.printBytes),
    hardware: fakeHardware().hardware,
    awake: createSystemAwake(vi.fn(async () => undefined)),
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
});

describe("the operator a sign-in hands over", () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
});

describe("the workstation setup on the floor", () => {
  it("opens from the list of shifts and comes back to it", async () => {
    const handlers = handlersOf();
    render(floorOf(await floorCopies(), handlers));
    fireEvent.click(await screen.findByRole("button", { name: "Рабочее место" }));
    expect(await screen.findByRole("heading", { name: "Принтеры" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByRole("button", { name: "Открыть" })).toBeTruthy();
    expect(types(handlers)).not.toContain("work_entered");
  });

  it("opens from a label's recovery once the work settled, and comes back to the same shift", async () => {
    const handlers = handlersOf();
    const work = holdingWork();
    function Work(props: WorkScreenProps) {
      return (
        <>
          <work.Work {...props} />
          <button type="button" onClick={props.onSetup}>
            Настроить принтер
          </button>
        </>
      );
    }
    render(floorOf(await floorCopies(), handlers, { workScreen: Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    fireEvent.click(screen.getByRole("button", { name: "Настроить принтер" }));
    await settle();
    // The work it handed over holds the setup back, as it holds any leave.
    expect(screen.queryByRole("heading", { name: "Принтеры" })).toBeNull();
    expect(work.leaving.at(-1)).toBe(true);
    await work.release();
    expect(await screen.findByRole("heading", { name: "Принтеры" })).toBeTruthy();
    const workActions = () => types(handlers).filter((type) => type.startsWith("work_"));
    expect(workActions()).toEqual(["work_entered", "work_left"]);
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByRole("button", { name: "Работа OCT26-005/S" })).toBeTruthy();
    expect(workActions()).toEqual(["work_entered", "work_left", "work_entered"]);
    expect(handlers.dispatch).toHaveBeenLastCalledWith({
      type: "work_entered",
      sessionId: 1,
      shiftId: PLANNED.id,
    });
  });
});

describe("the operator a sign-in hands over", () => {
```

Создать `apps/standalone/test/floor-setup.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { renderLabel } from "../src/floor/print/label-render.js";
import type { RenderLabel } from "../src/floor/print/print-jobs.js";
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import { NEW_PRINTER, profileOf } from "../src/floor/setup/printer-draft.js";
import { makeTestCode, scannedTestCode, testLabelSpec } from "../src/floor/setup/test-label.js";
import { WorkstationSetup } from "../src/floor/setup/WorkstationSetup.js";
import {
  readWorkstationSettings,
  type WorkstationSettings,
} from "../src/floor/setup/workstation-settings.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import {
  fakeRaster,
  fakeRender,
  manualRuntime,
  printingSettings,
  setUpPrinting,
  TSC,
  ZEBRA,
} from "./support/printing.js";

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
    read: (raw: string) =>
      act(() => {
        listener?.(raw);
      }),
  };
}

interface Options {
  local?: LocalExecutor;
  shell?: ReturnType<typeof fakeHardware>;
  render?: RenderLabel;
}

async function setup(options: Options = {}) {
  const local = options.local ?? openLocalDb().executor;
  const shell = options.shell ?? fakeHardware();
  const scanner = fakeSource();
  const onSaved = vi.fn<(settings: WorkstationSettings) => void>();
  const onBack = vi.fn();
  render(
    <ThemeProvider>
      <WorkstationSetup
        local={local}
        hardware={shell.hardware}
        printing={manualRuntime(shell.hardware).runtime}
        source={scanner.source}
        render={options.render ?? fakeRender}
        onSaved={onSaved}
        onBack={onBack}
      />
    </ThemeProvider>,
  );
  await screen.findByRole("heading", { name: "Принтеры" });
  return { local, shell, scanner, onSaved, onBack };
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function click(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("the printer form", () => {
  it("describes a profile, or names the first thing wrong", () => {
    const newId = () => "new-1";
    expect(
      profileOf(
        { ...NEW_PRINTER, name: " Zebra ", host: " 192.168.1.50 ", tcpPort: "9100" },
        newId,
      ),
    ).toEqual({
      profile: {
        id: "new-1",
        name: "Zebra",
        target: { kind: "tcp", host: "192.168.1.50", port: 9100 },
        language: "zpl",
        dpi: 203,
      },
    });
    expect(
      profileOf(
        { ...NEW_PRINTER, id: "tsc", name: "TSC", kind: "serial", serialPort: "com4", dpi: "300" },
        newId,
      ),
    ).toEqual({
      profile: {
        id: "tsc",
        name: "TSC",
        target: { kind: "serial", port: "COM4", baud: 9600 },
        language: "zpl",
        dpi: 300,
      },
    });
    const wrong = (patch: Partial<typeof NEW_PRINTER>) =>
      profileOf({ ...NEW_PRINTER, name: "Zebra", host: "zebra", ...patch }, newId);
    expect(wrong({ name: " " })).toEqual({ error: "name" });
    expect(wrong({ host: "" })).toEqual({ error: "host" });
    expect(wrong({ tcpPort: "0" })).toEqual({ error: "port" });
    expect(wrong({ tcpPort: "65536" })).toEqual({ error: "port" });
    expect(wrong({ tcpPort: "91a" })).toEqual({ error: "port" });
    expect(wrong({ kind: "serial", serialPort: "" })).toEqual({ error: "serialPort" });
    expect(wrong({ kind: "serial", serialPort: "COM4", baud: "0" })).toEqual({ error: "baud" });
    expect(wrong({ kind: "usb", usbPrinter: "" })).toEqual({ error: "usbPrinter" });
  });
});

describe("the test label", () => {
  it("is a random code of unmistakable letters, all ASCII, read back without the scanner's prefix", () => {
    const code = makeTestCode((bytes) => bytes.set([0, 1, 2, 19, 20, 39]));
    expect(code).toBe("MKR-347Y3Y");
    expect(makeTestCode()).toMatch(/^MKR-[34789ACDEFHKMNPRTWXY]{6}$/);
    const spec = testLabelSpec(code, "tspl");
    expect(spec).toMatchObject({ widthMm: 58, heightMm: 40, language: "tspl" });
    expect(JSON.stringify(spec)).toMatch(/^[\x20-\x7e]*$/);
    expect(scannedTestCode(` ]C0${code}\r`)).toBe(code);
  });
});

describe("the workstation setup", () => {
  it("adds a network printer, gives it the box label and stores the settings only on save", async () => {
    const { local, onSaved } = await setup();
    expect(screen.getByText("Принтеров пока нет.")).toBeTruthy();
    click("Добавить принтер");
    type("Название", "Zebra у линии");
    type("Адрес принтера", "192.168.1.50");
    click("Готово");
    expect(screen.getByText("Сеть: 192.168.1.50:9100 · ZPL · 203 dpi")).toBeTruthy();
    const box = screen.getByLabelText("Этикетка короба");
    fireEvent.change(box, {
      target: {
        value: within(box).getByRole("option", { name: "Zebra у линии" }).getAttribute("value"),
      },
    });
    expect((await readWorkstationSettings(local)).printers).toEqual([]);
    expect(screen.getByRole("button", { name: "Назад без сохранения" })).toBeTruthy();
    await act(async () => {
      click("Сохранить");
    });
    expect(await screen.findByText("Настройки сохранены.")).toBeTruthy();
    const stored = await readWorkstationSettings(local);
    expect(stored.printers).toEqual([
      expect.objectContaining({
        name: "Zebra у линии",
        target: { kind: "tcp", host: "192.168.1.50", port: 9100 },
        language: "zpl",
        dpi: 203,
      }),
    ]);
    expect(stored.assignments.box).toBe(stored.printers[0]?.id);
    expect(onSaved).toHaveBeenCalledWith(stored);
    expect(screen.getByRole("button", { name: "Назад" })).toBeTruthy();
  });

  it("refuses a form with a mistake, and a second profile of one printer", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    await setup({ local });
    click("Добавить принтер");
    type("Название", "Ещё Zebra");
    type("Адрес принтера", "192.168.1.50");
    type("Порт", "70000");
    click("Готово");
    expect(screen.getByText("Порт — целое число от 1 до 65 535.")).toBeTruthy();
    type("Порт", "9100");
    click("Готово");
    expect(screen.getByText("Этот принтер уже есть в списке: «Zebra у линии».")).toBeTruthy();
    click("Отмена");
    expect(screen.queryByText("Новый принтер")).toBeNull();
  });

  it("edits a printer, and a removed printer prints nothing any more", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local, {
      assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" },
    });
    await setup({ local });
    click("Изменить принтер «TSC на COM4»");
    fireEvent.change(screen.getByLabelText("Разрешение"), { target: { value: "203" } });
    click("Готово");
    expect(screen.getByText("COM4, 9600 бод · TSPL · 203 dpi")).toBeTruthy();
    click("Удалить принтер «Zebra у линии»");
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены.");
    expect(await readWorkstationSettings(local)).toEqual(
      printingSettings({
        printers: [{ ...TSC, dpi: 203 }],
        assignments: { box: null, pallet: null, duplicate: "tsc" },
      }),
    );
  });

  it("lists the Windows queues for a USB printer, and says when the spooler does not answer", async () => {
    const shell = fakeHardware();
    vi.mocked(shell.hardware.listUsbPrinters)
      .mockResolvedValueOnce([{ name: "ZDesigner GK420d", port: "USB001" }])
      .mockRejectedValueOnce(new Error("spooler_unavailable"));
    await setup({ shell });
    click("Добавить принтер");
    type("Название", "Zebra USB");
    fireEvent.change(screen.getByLabelText("Подключение"), { target: { value: "usb" } });
    await screen.findByRole("option", { name: "ZDesigner GK420d" });
    type("Принтер Windows", "ZDesigner GK420d");
    click("Обновить список принтеров");
    expect(await screen.findByText("Служба печати Windows не ответила.")).toBeTruthy();
    click("Готово");
    expect(screen.getByText("Принтер Windows: ZDesigner GK420d · ZPL · 203 dpi")).toBeTruthy();
  });

  it("prints a test label and checks its code by the scanner, never showing another scan", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    // The real render: the test label is ASCII, so no text goes to the rasterizer.
    const render = vi.fn<RenderLabel>((spec, fields, printer) =>
      renderLabel(spec, fields, printer, fakeRaster),
    );
    const { shell, scanner } = await setup({ local, render });
    await act(async () => {
      click("Пробная печать на «Zebra у линии»");
    });
    expect(
      await screen.findByText("Пробная этикетка ушла на «Zebra у линии». Отсканируйте её код."),
    ).toBeTruthy();
    const spec = render.mock.calls[0]?.[0];
    const code = JSON.stringify(spec).match(/MKR-[A-Z0-9]{6}/)?.[0] ?? "";
    expect(spec).toEqual(testLabelSpec(code, "zpl"));
    expect(render.mock.calls[0]?.[2]).toEqual(ZEBRA);
    expect(shell.sends).toEqual([
      { target: ZEBRA.target, text: expect.stringContaining(`^FD${code}^FS`) },
    ]);
    await scanner.read("0042-badge-secret");
    expect(screen.getByText("Это не код пробной этикетки. Отсканируйте её код.")).toBeTruthy();
    expect(screen.queryByText(/badge-secret/)).toBeNull();
    // The check stays open for the right code.
    await scanner.read(`]C0${code}`);
    expect(screen.getByText("Код совпал: принтер и сканер работают.")).toBeTruthy();
  });

  it("says why a test label did not print", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    await setup({ local, shell });
    await act(async () => {
      click("Пробная печать на «TSC на COM4»");
    });
    expect(
      await screen.findByText(
        "Пробная этикетка не напечатана. Принтер не принял задание: этикетка не напечатана.",
      ),
    ).toBeTruthy();
  });

  it("leaves at once, dropping what was not saved", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    const { onBack } = await setup({ local });
    click("Удалить принтер «TSC на COM4»");
    click("Назад без сохранения");
    expect(onBack).toHaveBeenCalledTimes(1);
    expect((await readWorkstationSettings(local)).printers).toEqual([ZEBRA, TSC]);
  });

  it("says when the settings cannot be read, and lets the operator go back", async () => {
    const { executor } = openLocalDb();
    const broken: LocalExecutor = {
      ...executor,
      query: async () => {
        throw new Error("disk I/O error");
      },
    };
    const onBack = vi.fn();
    render(
      <ThemeProvider>
        <WorkstationSetup
          local={broken}
          hardware={fakeHardware().hardware}
          printing={manualRuntime(fakeHardware().hardware).runtime}
          source={fakeSource().source}
          onSaved={vi.fn()}
          onBack={onBack}
        />
      </ThemeProvider>,
    );
    expect(
      await screen.findByText(
        "Настройки рабочего места не прочитались. Вернитесь и откройте их снова.",
      ),
    ).toBeTruthy();
    click("Назад");
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("says a failed save and keeps the changes on the screen", async () => {
    const { executor } = openLocalDb();
    const failing: LocalExecutor = {
      ...executor,
      transaction: async () => {
        throw new Error("database or disk is full");
      },
    };
    await setup({ local: failing });
    click("Добавить принтер");
    type("Название", "Zebra");
    type("Адрес принтера", "zebra.local");
    click("Готово");
    await act(async () => {
      click("Сохранить");
    });
    await waitFor(() =>
      expect(
        screen.getByText("Настройки не сохранились: база этого компьютера не ответила."),
      ).toBeTruthy(),
    );
    expect(screen.getByText("Сеть: zebra.local:9100 · ZPL · 203 dpi")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx test/floor-setup.test.tsx`
Expected: FAIL — `test/floor-setup.test.tsx` не загружается (`Failed to resolve import "../src/floor/setup/printer-draft.js"`); `test/floor-app.test.tsx` — «opens from the list of shifts and comes back to it», «opens from a label's recovery once the work settled, and comes back to the same shift».

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/app/App.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
              printing={printing}
              awake={awake}
```

заменить на:

<!-- prettier-ignore -->
```tsx
              printing={printing}
              hardware={hardwareApi}
              awake={awake}
```

Правка `apps/standalone/src/app/shell.css`:

Фрагмент 1:

<!-- prettier-ignore -->
```css
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}
```

заменить на:

<!-- prettier-ignore -->
```css
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

/* The workstation setup (plan 2a7): one printer a row, its actions under it. */
.workstation-setup {
  width: min(880px, 100%);
}

.workstation-setup__list {
  display: grid;
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.workstation-setup__list li {
  display: grid;
  gap: 8px;
}

.workstation-setup__editor h3 {
  margin: 0;
}
```

Правка `apps/standalone/src/floor/FloorApp.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import type { SystemAwake } from "../hardware/awake.js";
import type { LocalExecutor } from "../local/executor.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { SystemAwake } from "../hardware/awake.js";
import type { HardwareApi } from "../hardware/hardware.js";
import type { LocalExecutor } from "../local/executor.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
import type { ScanSource } from "./scan-source.js";
import { NewShift } from "./shifts/NewShift.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { ScanSource } from "./scan-source.js";
import { WorkstationSetup } from "./setup/WorkstationSetup.js";
import { NewShift } from "./shifts/NewShift.js";
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
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
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { WorkScreen, type WorkScreenProps } from "./work/WorkScreen.js";

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

export interface FloorAppProps {
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  printing: PrintRuntime;
  /** Keeps the computer awake while a work screen is open. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
  printing: PrintRuntime;
  /** The shell's printers and scanners, for the workstation setup. */
  hardware: HardwareApi;
  /** Keeps the computer awake while a work screen is open. */
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
  printing,
  awake,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  printing,
  hardware,
  awake,
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
    if (leave.kind === "list") setView({ kind: "list", notice: leave.notice });
  }, []);
```

заменить на:

<!-- prettier-ignore -->
```tsx
    if (leave.kind === "list") setView({ kind: "list", notice: leave.notice });
    if (leave.kind === "setup") setView({ kind: "setup", back: leave.shift });
  }, []);
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
  }, [requestFacts]);

  if (view.kind === "work") {
    return (
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }, [requestFacts]);

  if (view.kind === "setup") {
    const { back } = view;
    return (
      <WorkstationSetup
        local={local}
        hardware={hardware}
        printing={printing}
        source={source}
        {...(render === undefined ? {} : { render })}
        onSaved={() => undefined}
        // Back to the shift the setup was opened from, or to the list.
        onBack={() => (back === null ? setView({ kind: "list", notice: null }) : entered(back))}
      />
    );
  }
  if (view.kind === "work") {
    const { shift } = view;
    return (
```

Фрагмент 8:

<!-- prettier-ignore -->
```tsx
        awake={awake}
        {...(render === undefined ? {} : { render })}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        awake={awake}
        onSetup={() => leave({ kind: "setup", shift })}
        {...(render === undefined ? {} : { render })}
```

Фрагмент 9:

<!-- prettier-ignore -->
```tsx
      onNew={() => setView({ kind: "new_shift" })}
      onSignOut={() => leave({ kind: "sign_out", notice: null })}
```

заменить на:

<!-- prettier-ignore -->
```tsx
      onNew={() => setView({ kind: "new_shift" })}
      onSetup={() => setView({ kind: "setup", back: null })}
      onSignOut={() => leave({ kind: "sign_out", notice: null })}
```

Создать `apps/standalone/src/floor/setup/WorkstationSetup.tsx`:

<!-- prettier-ignore -->
```tsx
import { sampleLabelData } from "@markiro/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Input, Select } from "@markiro/ui";

import type { HardwareApi, UsbPrinter } from "../../hardware/hardware.js";
import type { LocalExecutor } from "../../local/executor.js";
import { renderLabel } from "../print/label-render.js";
import { settleOutcome, type PrintJobCode, type RenderLabel } from "../print/print-jobs.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import type { ScanSource } from "../scan-source.js";
import { draftOf, NEW_PRINTER, profileOf, type PrinterDraft } from "./printer-draft.js";
import { makeTestCode, scannedTestCode, testLabelSpec } from "./test-label.js";
import {
  InvalidSettingsError,
  PRINT_PURPOSES,
  printerTargetKey,
  readWorkstationSettings,
  saveWorkstationSettings,
  type PrinterProfile,
  type PrintPurpose,
  type WorkstationSettings,
} from "./workstation-settings.js";

export interface WorkstationSetupProps {
  local: LocalExecutor;
  hardware: Pick<HardwareApi, "listUsbPrinters">;
  printing: PrintRuntime;
  /** The floor's scanner: the code of a test label is scanned back here. */
  source: ScanSource;
  /** How the test label is rendered; the app's by default. */
  render?: RenderLabel;
  /** The settings were stored: the floor reads them again. */
  onSaved: (settings: WorkstationSettings) => void;
  onBack: () => void;
}

/** How a test print went, in words: the printer's answer, then the scan of its code. */
type TestState =
  | { kind: "sending"; printerId: string }
  | { kind: "sent"; printerId: string; name: string; code: string }
  | { kind: "failed"; code: PrintJobCode; unknown: boolean }
  | { kind: "render_failed" }
  | { kind: "match" }
  | { kind: "mismatch"; name: string; code: string };

type Status = { kind: "saved" } | { kind: "save_failed" } | { kind: "invalid" };

/**
 * The workstation setup (stage 2a spec §5.7.8): the printers of this
 * computer — where each is, its language and resolution — which one prints
 * which label, and a test print whose code is scanned back. Nothing is
 * stored until «Сохранить»; «Назад» leaves at once and says when it drops a
 * change, so the setup never holds the operator.
 */
export function WorkstationSetup({
  local,
  hardware,
  printing,
  source,
  render = renderLabel,
  onSaved,
  onBack,
}: WorkstationSetupProps) {
  const { t } = useTranslation();
  const [stored, setStored] = useState<WorkstationSettings | null>(null);
  const [draft, setDraft] = useState<WorkstationSettings | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [editor, setEditor] = useState<PrinterDraft | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [usbPrinters, setUsbPrinters] = useState<UsbPrinter[] | null>(null);
  const [usbFailed, setUsbFailed] = useState(false);
  const [test, setTestState] = useState<TestState | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    readWorkstationSettings(local).then(
      (settings) => {
        if (cancelled) return;
        setStored(settings);
        setDraft(settings);
      },
      () => {
        if (!cancelled) setReadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local]);

  // The test print as the scanner's listener reads it: kept as it is set, so
  // a scan right after the label went is checked against it, never missed.
  const testRef = useRef<TestState | null>(null);
  const setTest = useCallback((next: TestState | null) => {
    testRef.current = next;
    setTestState(next);
  }, []);
  useEffect(
    () =>
      source.start((raw) => {
        const now = testRef.current;
        // The check stays open after a wrong scan, until the right code comes.
        if (now?.kind !== "sent" && now?.kind !== "mismatch") return;
        // A scan that is not this label's code is never shown: it may be a badge.
        setTest(
          scannedTestCode(raw) === now.code
            ? { kind: "match" }
            : { kind: "mismatch", name: now.name, code: now.code },
        );
      }),
    [source, setTest],
  );

  const refreshUsb = () => {
    setUsbFailed(false);
    hardware.listUsbPrinters().then(
      (printers) => setUsbPrinters(printers),
      () => {
        setUsbPrinters([]);
        setUsbFailed(true);
      },
    );
  };

  const change = (next: WorkstationSettings) => {
    setDraft(next);
    setStatus(null);
  };

  if (readFailed || draft === null || stored === null) {
    return (
      <Card className="standalone-card" title={t("floor.setup.title")} titleAs="h2">
        <div className="standalone-form">
          {readFailed ? (
            <Alert tone="error">{t("floor.setup.readFailed")}</Alert>
          ) : (
            <p>{t("floor.setup.loading")}</p>
          )}
          <div className="standalone-form__actions">
            <Button size="floor" variant="secondary" onClick={onBack}>
              {t("floor.setup.back")}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);

  const applyEditor = () => {
    if (editor === null) return;
    const result = profileOf(editor, () => crypto.randomUUID());
    if ("error" in result) {
      setEditorError(t(`floor.setup.printers.errors.${result.error}`));
      return;
    }
    const { profile } = result;
    const clash = draft.printers.find(
      (printer) =>
        printer.id !== profile.id &&
        printerTargetKey(printer.target) === printerTargetKey(profile.target),
    );
    if (clash !== undefined) {
      setEditorError(t("floor.setup.printers.errors.duplicate", { name: clash.name }));
      return;
    }
    const exists = draft.printers.some((printer) => printer.id === profile.id);
    change({
      ...draft,
      printers: exists
        ? draft.printers.map((printer) => (printer.id === profile.id ? profile : printer))
        : [...draft.printers, profile],
    });
    setEditor(null);
    setEditorError(null);
  };

  const remove = (id: string) => {
    const assignments = { ...draft.assignments };
    for (const purpose of PRINT_PURPOSES) {
      if (assignments[purpose] === id) assignments[purpose] = null;
    }
    change({ ...draft, printers: draft.printers.filter((p) => p.id !== id), assignments });
  };

  const assign = (purpose: PrintPurpose, id: string) => {
    change({ ...draft, assignments: { ...draft.assignments, [purpose]: id === "" ? null : id } });
  };

  const testPrint = async (printer: PrinterProfile) => {
    const code = makeTestCode();
    setTest({ kind: "sending", printerId: printer.id });
    let bytes: Uint8Array;
    try {
      bytes = await render(testLabelSpec(code, printer.language), sampleLabelData(), printer);
    } catch {
      setTest({ kind: "render_failed" });
      return;
    }
    const settled = settleOutcome(await printing.send(null, printer.target, bytes));
    setTest(
      settled.state === "sent"
        ? { kind: "sent", printerId: printer.id, name: printer.name, code }
        : { kind: "failed", code: settled.code, unknown: settled.state === "unknown" },
    );
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await saveWorkstationSettings(local, draft);
      setStored(draft);
      setStatus({ kind: "saved" });
      onSaved(draft);
    } catch (error) {
      setStatus(
        error instanceof InvalidSettingsError ? { kind: "invalid" } : { kind: "save_failed" },
      );
    } finally {
      setSaving(false);
    }
  };

  const summary = (printer: PrinterProfile) => {
    const { target } = printer;
    const where =
      target.kind === "tcp"
        ? t("floor.setup.printers.summary.tcp", { host: target.host, port: target.port })
        : target.kind === "serial"
          ? t("floor.setup.printers.summary.serial", { port: target.port, baud: target.baud })
          : t("floor.setup.printers.summary.usb", { printer: target.printer });
    return `${where} · ${t("floor.setup.printers.format", {
      language: printer.language.toUpperCase(),
      dpi: printer.dpi,
    })}`;
  };

  const testText = (state: TestState): { tone: "ok" | "error" | "info" | "warn"; text: string } => {
    switch (state.kind) {
      case "sending":
        return { tone: "info", text: t("floor.setup.printers.testResult.sending") };
      case "sent":
        return {
          tone: "info",
          text: t("floor.setup.printers.testResult.sent", { name: state.name }),
        };
      case "failed":
        return {
          tone: "error",
          text: `${t(
            state.unknown
              ? "floor.setup.printers.testResult.unknown"
              : "floor.setup.printers.testResult.failed",
          )} ${t(`floor.print.codes.${state.code}`)}`,
        };
      case "render_failed":
        return { tone: "error", text: t("floor.setup.printers.testResult.renderFailed") };
      case "match":
        return { tone: "ok", text: t("floor.setup.printers.testResult.match") };
      case "mismatch":
        return { tone: "warn", text: t("floor.setup.printers.testResult.mismatch") };
    }
  };

  const editorForm = (form: PrinterDraft) => {
    const set = (patch: Partial<PrinterDraft>) => {
      setEditor({ ...form, ...patch });
      setEditorError(null);
    };
    const usbOptions = [
      { value: "", label: t("floor.setup.printers.editor.usbChoose") },
      ...(form.usbPrinter !== "" && !(usbPrinters ?? []).some((p) => p.name === form.usbPrinter)
        ? [{ value: form.usbPrinter, label: form.usbPrinter }]
        : []),
      ...(usbPrinters ?? []).map((printer) => ({ value: printer.name, label: printer.name })),
    ];
    return (
      <div className="standalone-form workstation-setup__editor">
        <h3>
          {form.id === null
            ? t("floor.setup.printers.editor.titleNew")
            : t("floor.setup.printers.editor.titleEdit", { name: form.name })}
        </h3>
        <Input
          size="floor"
          label={t("floor.setup.printers.editor.name")}
          value={form.name}
          onChange={(event) => set({ name: event.target.value })}
        />
        <Select
          native
          size="floor"
          label={t("floor.setup.printers.editor.kind")}
          value={form.kind}
          options={(["tcp", "serial", "usb"] as const).map((kind) => ({
            value: kind,
            label: t(`floor.setup.printers.editor.kinds.${kind}`),
          }))}
          onValueChange={(kind) => {
            set({ kind });
            if (kind === "usb" && usbPrinters === null) refreshUsb();
          }}
        />
        {form.kind === "tcp" && (
          <>
            <Input
              size="floor"
              label={t("floor.setup.printers.editor.host")}
              value={form.host}
              onChange={(event) => set({ host: event.target.value })}
            />
            <Input
              size="floor"
              inputMode="numeric"
              label={t("floor.setup.printers.editor.port")}
              value={form.tcpPort}
              onChange={(event) => set({ tcpPort: event.target.value })}
            />
          </>
        )}
        {form.kind === "serial" && (
          <>
            <Input
              size="floor"
              label={t("floor.setup.printers.editor.serialPort")}
              value={form.serialPort}
              onChange={(event) => set({ serialPort: event.target.value })}
            />
            <Input
              size="floor"
              inputMode="numeric"
              label={t("floor.setup.printers.editor.baud")}
              value={form.baud}
              onChange={(event) => set({ baud: event.target.value })}
            />
          </>
        )}
        {form.kind === "usb" && (
          <>
            <Select
              native
              size="floor"
              label={t("floor.setup.printers.editor.usbPrinter")}
              value={form.usbPrinter}
              options={usbOptions}
              {...(usbFailed ? { error: t("floor.setup.printers.editor.usbFailed") } : {})}
              {...(usbPrinters !== null && usbPrinters.length === 0 && !usbFailed
                ? { hint: t("floor.setup.printers.editor.usbNone") }
                : {})}
              onValueChange={(usbPrinter) => set({ usbPrinter })}
            />
            <Button size="floor" variant="secondary" onClick={refreshUsb}>
              {t("floor.setup.printers.editor.usbRefresh")}
            </Button>
          </>
        )}
        <Select
          native
          size="floor"
          label={t("floor.setup.printers.editor.language")}
          value={form.language}
          options={[
            { value: "zpl", label: "ZPL (Zebra)" },
            { value: "tspl", label: "TSPL (TSC)" },
          ]}
          onValueChange={(language) => set({ language })}
        />
        <Select
          native
          size="floor"
          label={t("floor.setup.printers.editor.dpi")}
          value={form.dpi}
          options={[
            { value: "203", label: "203 dpi" },
            { value: "300", label: "300 dpi" },
          ]}
          onValueChange={(dpi) => set({ dpi })}
        />
        {editorError !== null && <Alert tone="error">{editorError}</Alert>}
        <div className="standalone-form__actions">
          <Button size="floor" onClick={applyEditor}>
            {t("floor.setup.printers.editor.apply")}
          </Button>
          <Button
            size="floor"
            variant="secondary"
            onClick={() => {
              setEditor(null);
              setEditorError(null);
            }}
          >
            {t("floor.setup.printers.editor.cancel")}
          </Button>
        </div>
      </div>
    );
  };

  const purposeOptions = [
    { value: "", label: t("floor.setup.printers.purposes.none") },
    ...draft.printers.map((printer) => ({ value: printer.id, label: printer.name })),
  ];

  return (
    <Card className="standalone-card workstation-setup" title={t("floor.setup.title")} titleAs="h2">
      <div className="standalone-form">
        <h3>{t("floor.setup.printers.title")}</h3>
        {editor !== null ? (
          editorForm(editor)
        ) : (
          <>
            {draft.printers.length === 0 ? (
              <p>{t("floor.setup.printers.empty")}</p>
            ) : (
              <ul className="workstation-setup__list">
                {draft.printers.map((printer) => (
                  <li key={printer.id}>
                    <strong>{printer.name}</strong>
                    <span>{summary(printer)}</span>
                    <div className="standalone-form__actions">
                      <Button
                        size="floor"
                        variant="secondary"
                        aria-label={t("floor.setup.printers.editFor", { name: printer.name })}
                        onClick={() => setEditor(draftOf(printer))}
                      >
                        {t("floor.setup.printers.edit")}
                      </Button>
                      <Button
                        size="floor"
                        variant="secondary"
                        aria-label={t("floor.setup.printers.testFor", { name: printer.name })}
                        disabled={test?.kind === "sending"}
                        onClick={() => void testPrint(printer)}
                      >
                        {t("floor.setup.printers.test")}
                      </Button>
                      <Button
                        size="floor"
                        variant="secondary"
                        aria-label={t("floor.setup.printers.removeFor", { name: printer.name })}
                        onClick={() => remove(printer.id)}
                      >
                        {t("floor.setup.printers.remove")}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {test !== null && (
              <Alert tone={testText(test).tone} aria-live="polite">
                {testText(test).text}
              </Alert>
            )}
            <Button size="floor" variant="secondary" onClick={() => setEditor(NEW_PRINTER)}>
              {t("floor.setup.printers.add")}
            </Button>
            <h3>{t("floor.setup.printers.purposes.title")}</h3>
            {PRINT_PURPOSES.map((purpose) => (
              <Select
                key={purpose}
                native
                size="floor"
                label={t(`floor.setup.printers.purposes.${purpose}`)}
                value={draft.assignments[purpose] ?? ""}
                options={purposeOptions}
                {...(purpose === "box" ? {} : { hint: t("floor.setup.printers.purposes.later") })}
                onValueChange={(id) => assign(purpose, id)}
              />
            ))}
          </>
        )}
        {status !== null && (
          <Alert tone={status.kind === "saved" ? "ok" : "error"} aria-live="polite">
            {t(`floor.setup.status.${status.kind}`)}
          </Alert>
        )}
        <div className="standalone-form__actions">
          <Button
            size="floor"
            disabled={!dirty || saving || editor !== null}
            onClick={() => void save()}
          >
            {t("floor.setup.save")}
          </Button>
          {/* Never held by a save or a test print: leaving is always open. */}
          <Button size="floor" variant="secondary" onClick={onBack}>
            {t(dirty ? "floor.setup.backUnsaved" : "floor.setup.back")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
```

Создать `apps/standalone/src/floor/setup/printer-draft.ts`:

<!-- prettier-ignore -->
```ts
/**
 * The printer form of the workstation setup: what the operator types, and
 * the profile it describes once checked.
 */
import type { PrintTarget } from "../../hardware/hardware.js";
import {
  parsePrinterProfile,
  type PrinterDpi,
  type PrinterLanguage,
  type PrinterProfile,
} from "./workstation-settings.js";

/** How the printer is connected. */
export type Kind = PrintTarget["kind"];

/** The printer form, as typed: numbers stay text until the form is checked. */
export interface PrinterDraft {
  /** The profile being changed; `null` — a new one. */
  id: string | null;
  name: string;
  kind: Kind;
  host: string;
  tcpPort: string;
  serialPort: string;
  baud: string;
  usbPrinter: string;
  language: PrinterLanguage;
  dpi: `${PrinterDpi}`;
}

export const NEW_PRINTER: PrinterDraft = {
  id: null,
  name: "",
  kind: "tcp",
  host: "",
  tcpPort: "9100",
  serialPort: "",
  baud: "9600",
  usbPrinter: "",
  language: "zpl",
  dpi: "203",
};

export function draftOf(profile: PrinterProfile): PrinterDraft {
  const { target } = profile;
  return {
    ...NEW_PRINTER,
    id: profile.id,
    name: profile.name,
    kind: target.kind,
    host: target.kind === "tcp" ? target.host : "",
    tcpPort: target.kind === "tcp" ? String(target.port) : NEW_PRINTER.tcpPort,
    serialPort: target.kind === "serial" ? target.port : "",
    baud: target.kind === "serial" ? String(target.baud) : NEW_PRINTER.baud,
    usbPrinter: target.kind === "usb" ? target.printer : "",
    language: profile.language,
    dpi: profile.dpi === 300 ? "300" : "203",
  };
}

/** The keys of `floor.setup.printers.errors`. */
export type DraftError = "name" | "host" | "port" | "serialPort" | "baud" | "usbPrinter";

function wholeNumber(text: string): number | null {
  return /^[0-9]+$/.test(text.trim()) ? Number(text.trim()) : null;
}

/** The profile a draft describes, or the first thing wrong with it. */
export function profileOf(
  draft: PrinterDraft,
  newId: () => string,
): { profile: PrinterProfile } | { error: DraftError } {
  if (draft.name.trim() === "") return { error: "name" };
  let target: PrintTarget;
  if (draft.kind === "tcp") {
    const port = wholeNumber(draft.tcpPort);
    if (draft.host.trim() === "") return { error: "host" };
    if (port === null || port < 1 || port > 65_535) return { error: "port" };
    target = { kind: "tcp", host: draft.host.trim(), port };
  } else if (draft.kind === "serial") {
    const baud = wholeNumber(draft.baud);
    if (draft.serialPort.trim() === "") return { error: "serialPort" };
    if (baud === null || baud < 1 || baud > 4_294_967_295) return { error: "baud" };
    target = { kind: "serial", port: draft.serialPort, baud };
  } else {
    if (draft.usbPrinter.trim() === "") return { error: "usbPrinter" };
    target = { kind: "usb", printer: draft.usbPrinter };
  }
  const profile = parsePrinterProfile({
    id: draft.id ?? newId(),
    name: draft.name,
    target,
    language: draft.language,
    dpi: Number(draft.dpi),
  });
  return profile === null ? { error: "name" } : { profile };
}
```

Создать `apps/standalone/src/floor/setup/test-label.ts`:

<!-- prettier-ignore -->
```ts
import type { LabelTemplateSpec } from "@markiro/domain";

import type { PrinterLanguage } from "./workstation-settings.js";

/**
 * The letters of a test code: digits and capitals without the ones a person
 * confuses on a printed label (0/O, 1/I/L, 5/S, 6/G, U/V, Z/2), as the cloud
 * station's `makeSetupTestCode`.
 */
const ALPHABET = "34789ACDEFHKMNPRTWXY";

/**
 * A fresh code for one test print, «MKR-7Q4F2N»: random, so a label left
 * over from an earlier test can never pass this one.
 */
export function makeTestCode(
  random: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => {
    crypto.getRandomValues(bytes);
  },
): string {
  const bytes = new Uint8Array(6);
  random(bytes);
  let tail = "";
  for (const byte of bytes) tail += ALPHABET[byte % ALPHABET.length] ?? "";
  return `MKR-${tail}`;
}

/**
 * The test label (stage 2a spec §5.7.8): 58 × 40 mm, a Code 128 of `code`
 * and the code in words, all ASCII — no text goes through the rasterizer, so
 * the test proves the printer, its address, language and resolution, and
 * the scanner that reads the code back, and nothing of the webview's canvas.
 */
export function testLabelSpec(code: string, language: PrinterLanguage): LabelTemplateSpec {
  return {
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language,
    elements: [
      { id: "title", kind: "text", text: "MARKIRO TEST", xMm: 4, yMm: 4, fontSizePt: 10 },
      {
        id: "code",
        kind: "barcode",
        format: "code128",
        data: { literal: code },
        xMm: 4,
        yMm: 11,
        sizeMm: 16,
      },
      { id: "caption", kind: "text", text: code, xMm: 4, yMm: 30, fontSizePt: 10 },
    ],
  };
}

/**
 * The text of a scan, without the AIM prefix a scanner may send before a
 * Code 128 (`]C0`), as the code was printed.
 */
export function scannedTestCode(raw: string): string {
  return raw.trim().replace(/^\][A-Za-z][0-9]/, "");
}
```

Правка `apps/standalone/src/floor/shifts/ShiftList.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  onSignOut: () => void;
}
```

заменить на:

<!-- prettier-ignore -->
```tsx
  onSignOut: () => void;
  /** The workstation setup (plan 2a7); none — no button. */
  onSetup?: () => void;
}
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  onSignOut,
}: ShiftListProps) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  onSignOut,
  onSetup,
}: ShiftListProps) {
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
          </Button>
          {/* Never held by an entry: one that never settles must not trap the station here. */}
```

заменить на:

<!-- prettier-ignore -->
```tsx
          </Button>
          {onSetup !== undefined && (
            <Button size="floor" variant="secondary" disabled={busy} onClick={onSetup}>
              {t("floor.shifts.setup")}
            </Button>
          )}
          {/* Never held by an entry: one that never settles must not trap the station here. */}
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
      }
    },
    "shifts": {
      "title": "Смены линии",
```

заменить на:

<!-- prettier-ignore -->
```json
      }
    },
    "setup": {
      "title": "Рабочее место",
      "loading": "Читаем настройки рабочего места…",
      "readFailed": "Настройки рабочего места не прочитались. Вернитесь и откройте их снова.",
      "save": "Сохранить",
      "back": "Назад",
      "backUnsaved": "Назад без сохранения",
      "status": {
        "saved": "Настройки сохранены.",
        "save_failed": "Настройки не сохранились: база этого компьютера не ответила.",
        "invalid": "Настройки не сохранены: проверьте принтеры и сканеры."
      },
      "printers": {
        "title": "Принтеры",
        "empty": "Принтеров пока нет.",
        "add": "Добавить принтер",
        "edit": "Изменить",
        "editFor": "Изменить принтер «{{name}}»",
        "remove": "Удалить",
        "removeFor": "Удалить принтер «{{name}}»",
        "test": "Пробная печать",
        "testFor": "Пробная печать на «{{name}}»",
        "summary": {
          "tcp": "Сеть: {{host}}:{{port}}",
          "serial": "{{port}}, {{baud}} бод",
          "usb": "Принтер Windows: {{printer}}"
        },
        "format": "{{language}} · {{dpi}} dpi",
        "editor": {
          "titleNew": "Новый принтер",
          "titleEdit": "Принтер «{{name}}»",
          "name": "Название",
          "kind": "Подключение",
          "kinds": {
            "tcp": "Сеть (порт 9100)",
            "serial": "COM-порт",
            "usb": "Принтер Windows (USB)"
          },
          "host": "Адрес принтера",
          "port": "Порт",
          "serialPort": "COM-порт",
          "baud": "Скорость, бод",
          "usbPrinter": "Принтер Windows",
          "usbChoose": "Выберите принтер",
          "usbRefresh": "Обновить список принтеров",
          "usbNone": "Принтеров Windows не найдено.",
          "usbFailed": "Служба печати Windows не ответила.",
          "language": "Язык принтера",
          "dpi": "Разрешение",
          "apply": "Готово",
          "cancel": "Отмена"
        },
        "errors": {
          "name": "Укажите название.",
          "host": "Укажите адрес принтера.",
          "port": "Порт — целое число от 1 до 65 535.",
          "serialPort": "Укажите COM-порт.",
          "baud": "Скорость — целое число больше нуля.",
          "usbPrinter": "Выберите принтер Windows.",
          "duplicate": "Этот принтер уже есть в списке: «{{name}}»."
        },
        "purposes": {
          "title": "Что на каком принтере",
          "box": "Этикетка короба",
          "pallet": "Этикетка паллеты",
          "duplicate": "Дубль кода",
          "none": "Не назначен",
          "later": "Станция пока печатает только этикетки коробов."
        },
        "testResult": {
          "sending": "Пробная этикетка отправляется…",
          "sent": "Пробная этикетка ушла на «{{name}}». Отсканируйте её код.",
          "failed": "Пробная этикетка не напечатана.",
          "unknown": "Неизвестно, напечаталась ли пробная этикетка.",
          "renderFailed": "Пробную этикетку не удалось подготовить.",
          "match": "Код совпал: принтер и сканер работают.",
          "mismatch": "Это не код пробной этикетки. Отсканируйте её код."
        }
      }
    },
    "shifts": {
      "title": "Смены линии",
```

Фрагмент 2:

<!-- prettier-ignore -->
```json
      "new": "Новая смена",
      "newNeedsLink": "Новую смену можно создать только при связи с хостом.",
```

заменить на:

<!-- prettier-ignore -->
```json
      "new": "Новая смена",
      "setup": "Рабочее место",
      "newNeedsLink": "Новую смену можно создать только при связи с хостом.",
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx test/floor-setup.test.tsx`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  34 passed (34)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  106 passed (106)`, `Tests  2524 passed (2524)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — один неверный скан навсегда закрывает проверку пробной этикетки.
В `apps/standalone/src/floor/setup/WorkstationSetup.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        if (now?.kind !== "sent" && now?.kind !== "mismatch") return;
```

заменить на:

<!-- prettier-ignore -->
```tsx
        if (now?.kind !== "sent") return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-setup.test.tsx`
Expected: FAIL — «prints a test label and checks its code by the scanner, never showing another scan».

М2 — два профиля одного принтера.
В `apps/standalone/src/floor/setup/WorkstationSetup.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    if (clash !== undefined) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
    if (clash !== undefined && clash.id === "") {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-setup.test.tsx`
Expected: FAIL — «refuses a form with a mistake, and a second profile of one printer».

М3 — настройка открывается, пока работа рабочего экрана ещё идёт.
В `apps/standalone/src/floor/FloorApp.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        onSetup={() => leave({ kind: "setup", shift })}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        onSetup={() => setView({ kind: "setup", back: shift })}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx`
Expected: FAIL — «opens from a label's recovery once the work settled, and comes back to the same shift».

М4 — назначение остаётся у удалённого принтера.
В `apps/standalone/src/floor/setup/WorkstationSetup.tsx` удалить фрагмент

<!-- prettier-ignore -->
```tsx
      if (assignments[purpose] === id) assignments[purpose] = null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-setup.test.tsx`
Expected: FAIL — «edits a printer, and a removed printer prints nothing any more».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/app/App.tsx apps/standalone/src/app/shell.css apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/floor/setup/WorkstationSetup.tsx apps/standalone/src/floor/setup/printer-draft.ts apps/standalone/src/floor/setup/test-label.ts apps/standalone/src/floor/shifts/ShiftList.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-app.test.tsx apps/standalone/test/floor-setup.test.tsx`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-app.test.tsx test/floor-setup.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/floor-app.test.tsx test/floor-setup.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/app/App.tsx apps/standalone/src/app/shell.css apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/floor/setup/WorkstationSetup.tsx apps/standalone/src/floor/setup/printer-draft.ts apps/standalone/src/floor/setup/test-label.ts apps/standalone/src/floor/shifts/ShiftList.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-app.test.tsx apps/standalone/test/floor-setup.test.tsx
git commit -m "feat(standalone): the workstation setup: printers, their purposes and a test print, from the shifts and from a label's recovery" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Настройка рабочего места — COM-сканеры, звук, проверка этикетки; сигналы цеха с сохранённой громкостью

Вторая половина настройки: COM-сканеры (порт и скорость, список портов `list_serial_ports` по просьбе, статус соединения из `watchScanners`; сохранение отдаёт оболочке весь набор сразу — удалённый сканер закрывается; отказ оболочки — слова, настройки при этом сохранены), звук (громкость шагами по 10 %, «Без звука», «Проверить звук») и проверка этикетки — кнопками 64 px с `aria-pressed`, а не флажками. `FloorApp` читает громкость при входе и после сохранения настройки и передаёт рабочему экрану сигнал с ней (`playTone`).

**Files:**

- Modify: `apps/standalone/src/floor/FloorApp.tsx`, `apps/standalone/src/floor/setup/WorkstationSetup.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-app.test.tsx` (Modify), `apps/standalone/test/floor-setup.test.tsx` (Modify)

**Interfaces:**

- Consumes: `HardwareApi.listSerialPorts`, `configureScanners`, `watchScanners`, `ScannerSnapshot` (план 2a4); `canonicalPort`, `soundLevel`, `DEFAULT_SOUND`, `SoundSettings` (задача 2); `playSignalTone` (задача 2); `WorkstationSetup` (задача 7).
- Produces:
  - `WorkstationSetupProps.hardware: Pick<HardwareApi, "listUsbPrinters" | "listSerialPorts" | "configureScanners" | "watchScanners">`, `playTone?: (level: number) => void`;
  - `FloorAppProps.playTone?: (tone: SignalTone, level: number) => void`; рабочий экран получает `signal` с громкостью настроек;
  - ключи `floor.setup.scanners.*`, `floor.setup.sound.*`, `floor.setup.check.*`, `floor.setup.status.scanners_failed`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/floor-app.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorNotice, FloorSession, ShellAction, SyncState } from "../src/app/shell.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, type SignalTone } from "@markiro/ui";

import type { FloorNotice, FloorSession, ShellAction, SyncState } from "../src/app/shell.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import type { ScanSource } from "../src/floor/scan-source.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import {
  DEFAULT_WORKSTATION_SETTINGS,
  saveWorkstationSettings,
} from "../src/floor/setup/workstation-settings.js";
import type { ScanSource } from "../src/floor/scan-source.js";
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  workScreen?: ComponentType<WorkScreenProps>;
}
```

заменить на:

<!-- prettier-ignore -->
```tsx
  workScreen?: ComponentType<WorkScreenProps>;
  playTone?: (tone: SignalTone, level: number) => void;
}
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
        {...(options.workScreen === undefined ? {} : { workScreen: options.workScreen })}
        dispatch={handlers.dispatch}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        {...(options.workScreen === undefined ? {} : { workScreen: options.workScreen })}
        {...(options.playTone === undefined ? {} : { playTone: options.playTone })}
        dispatch={handlers.dispatch}
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
});

describe("the operator a sign-in hands over", () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
});

describe("the tones of the floor", () => {
  it("play at the workstation's level, and at the new one once the setup saved it", async () => {
    const local = await floorCopies();
    await saveWorkstationSettings(local, {
      ...DEFAULT_WORKSTATION_SETTINGS,
      sound: { muted: false, volume: 40 },
    });
    const handlers = handlersOf();
    const playTone = vi.fn<(tone: SignalTone, level: number) => void>();
    let signal: ((tone: SignalTone) => void) | undefined;
    function Work(props: WorkScreenProps) {
      signal = props.signal;
      return (
        <button type="button" onClick={props.onLeave}>
          Работа
        </button>
      );
    }
    render(floorOf(local, handlers, { workScreen: Work, playTone }));
    // The settings are read when the floor opens: let that read land before entering.
    await settle();
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа" });
    signal?.("ok");
    expect(playTone).toHaveBeenLastCalledWith("ok", 0.4);
    fireEvent.click(screen.getByRole("button", { name: "Работа" }));
    fireEvent.click(await screen.findByRole("button", { name: "Рабочее место" }));
    fireEvent.click(await screen.findByRole("button", { name: "Без звука" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    });
    await screen.findByText("Настройки сохранены.");
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    await screen.findByRole("button", { name: "Работа" });
    signal?.("error");
    expect(playTone).toHaveBeenLastCalledWith("error", 0);
  });
});

describe("the operator a sign-in hands over", () => {
```

Правка `apps/standalone/test/floor-setup.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
    expect(screen.getByText("Сеть: zebra.local:9100 · ZPL · 203 dpi")).toBeTruthy();
  });
});
```

заменить на:

<!-- prettier-ignore -->
```tsx
    expect(screen.getByText("Сеть: zebra.local:9100 · ZPL · 203 dpi")).toBeTruthy();
  });
});

describe("the scanners, the sound and the label check of the setup", () => {
  it("adds a COM scanner, gives the shell the whole set on save, and shows its connection", async () => {
    const { local, shell } = await setup();
    type("COM-порт сканера", "com3");
    click("Добавить сканер");
    expect(screen.getByText("COM3, 9600 бод")).toBeTruthy();
    expect(screen.getByText("Подключится после сохранения.")).toBeTruthy();
    expect(shell.hardware.configureScanners).not.toHaveBeenCalled();
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены.");
    expect(shell.hardware.configureScanners).toHaveBeenCalledWith([{ port: "COM3", baud: 9600 }]);
    expect((await readWorkstationSettings(local)).scanners).toEqual([{ port: "COM3", baud: 9600 }]);
    act(() => {
      shell.scannerStatus({
        revision: 1,
        scanners: [{ port: "COM3", baud: 9600, status: "disconnected" }],
      });
    });
    expect(screen.getByText("Нет связи: проверьте кабель и порт.")).toBeTruthy();
    act(() => {
      shell.scannerStatus({
        revision: 2,
        scanners: [{ port: "COM3", baud: 9600, status: "connected" }],
      });
    });
    expect(screen.getByText("Подключён.")).toBeTruthy();
    // Removed and saved: the shell gets the empty set, which closes the port.
    click("Удалить сканер COM3");
    await act(async () => {
      click("Сохранить");
    });
    await waitFor(() => expect(shell.hardware.configureScanners).toHaveBeenLastCalledWith([]));
  });

  it("refuses a scanner without a port, with a wrong speed or on a port it has", async () => {
    await setup();
    click("Добавить сканер");
    expect(screen.getByText("Укажите COM-порт.")).toBeTruthy();
    type("COM-порт сканера", "COM3");
    type("Скорость сканера, бод", "0");
    click("Добавить сканер");
    expect(screen.getByText("Скорость — целое число больше нуля.")).toBeTruthy();
    type("Скорость сканера, бод", "9600");
    click("Добавить сканер");
    type("COM-порт сканера", "com3");
    click("Добавить сканер");
    expect(screen.getByText("Сканер на COM3 уже есть.")).toBeTruthy();
  });

  it("lists the computer's COM ports on request, and says when they cannot be read", async () => {
    const shell = fakeHardware();
    vi.mocked(shell.hardware.listSerialPorts)
      .mockResolvedValueOnce(["COM3", "COM4"])
      .mockRejectedValueOnce(new Error("serial_unavailable"));
    await setup({ shell });
    click("Показать COM-порты");
    expect(await screen.findByText("COM-порты этого компьютера: COM3, COM4.")).toBeTruthy();
    click("Показать COM-порты");
    expect(await screen.findByText("Список COM-портов не прочитался.")).toBeTruthy();
  });

  it("keeps the saved settings when the shell refuses the scanners, and says so", async () => {
    const shell = fakeHardware();
    vi.mocked(shell.hardware.configureScanners).mockRejectedValueOnce(
      new Error("invalid_scanners"),
    );
    const { local, onSaved } = await setup({ shell });
    type("COM-порт сканера", "COM3");
    click("Добавить сканер");
    await act(async () => {
      click("Сохранить");
    });
    expect(
      await screen.findByText(
        "Настройки сохранены, но оболочка не приняла сканеры. Проверьте COM-порты.",
      ),
    ).toBeTruthy();
    expect((await readWorkstationSettings(local)).scanners).toEqual([{ port: "COM3", baud: 9600 }]);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("sets the tones' level and the label check, tries the sound, and stores both", async () => {
    const local = openLocalDb().executor;
    const shell = fakeHardware();
    const playTone = vi.fn<(level: number) => void>();
    const scanner = fakeSource();
    render(
      <ThemeProvider>
        <WorkstationSetup
          local={local}
          hardware={shell.hardware}
          printing={manualRuntime(shell.hardware).runtime}
          source={scanner.source}
          playTone={playTone}
          onSaved={vi.fn()}
          onBack={vi.fn()}
        />
      </ThemeProvider>,
    );
    expect(await screen.findByText("Громкость сигналов: 80 %.")).toBeTruthy();
    click("Тише");
    click("Тише");
    expect(screen.getByText("Громкость сигналов: 60 %.")).toBeTruthy();
    click("Проверить звук");
    expect(playTone).toHaveBeenLastCalledWith(0.6);
    click("Без звука");
    expect(screen.getByText("Сигналы без звука.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Тише" }).hasAttribute("disabled")).toBe(true);
    click("Проверить звук");
    expect(playTone).toHaveBeenLastCalledWith(0);
    expect(screen.getByText("Проверка этикетки выключена.")).toBeTruthy();
    click("Проверять этикетку короба");
    expect(
      screen
        .getByRole("button", { name: "Проверять этикетку короба" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены.");
    const stored = await readWorkstationSettings(local);
    expect(stored.sound).toEqual({ muted: true, volume: 60 });
    expect(stored.verifyPrintedLabel).toBe(true);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx test/floor-setup.test.tsx`
Expected: FAIL — `test/floor-setup.test.tsx`: 5 тестов (первый — «adds a COM scanner, gives the shell the whole set on save, and shows its connection»: `Unable to find a label with the text of: COM-порт сканера`); `test/floor-app.test.tsx` — «play at the workstation's level, and at the new one once the setup saved it».

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/floor/FloorApp.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
} from "react";

import {
```

заменить на:

<!-- prettier-ignore -->
```tsx
} from "react";

import type { SignalTone } from "@markiro/ui";

import {
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
import type { ScanSource } from "./scan-source.js";
import { WorkstationSetup } from "./setup/WorkstationSetup.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { ScanSource } from "./scan-source.js";
import {
  DEFAULT_SOUND,
  readWorkstationSettings,
  soundLevel,
  type SoundSettings,
} from "./setup/workstation-settings.js";
import { WorkstationSetup } from "./setup/WorkstationSetup.js";
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
import { createWorkGate } from "./work-gate.js";
import { WorkScreen, type WorkScreenProps } from "./work/WorkScreen.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { createWorkGate } from "./work-gate.js";
import { playSignalTone } from "./work/signal-sound.js";
import { WorkScreen, type WorkScreenProps } from "./work/WorkScreen.js";
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  render?: RenderLabel;
  /** Nobody touched the station this long: the operator is signed out. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
  render?: RenderLabel;
  /** How a verdict's tone plays at a level (0–1); the generated tones by default. */
  playTone?: (tone: SignalTone, level: number) => void;
  /** Nobody touched the station this long: the operator is signed out. */
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
  render,
  idleTimeoutMs = OPERATOR_IDLE_TIMEOUT_MS,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  render,
  playTone = (tone, level) => playSignalTone(tone, undefined, level),
  idleTimeoutMs = OPERATOR_IDLE_TIMEOUT_MS,
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
  const gate = useMemo(() => createWorkGate(), []);
  const alive = useRef(true);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const gate = useMemo(() => createWorkGate(), []);
  // The tones' level of the workstation's settings: read once, and again after a save.
  const [sound, setSound] = useState<SoundSettings>(DEFAULT_SOUND);
  useEffect(() => {
    let cancelled = false;
    readWorkstationSettings(local).then(
      (settings) => {
        if (!cancelled) setSound(settings.sound);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [local]);
  const signal = useCallback(
    (tone: SignalTone) => playTone(tone, soundLevel(sound)),
    [playTone, sound],
  );
  const alive = useRef(true);
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
        {...(render === undefined ? {} : { render })}
        onSaved={() => undefined}
        // Back to the shift the setup was opened from, or to the list.
```

заменить на:

<!-- prettier-ignore -->
```tsx
        {...(render === undefined ? {} : { render })}
        onSaved={(settings) => setSound(settings.sound)}
        // Back to the shift the setup was opened from, or to the list.
```

Фрагмент 8:

<!-- prettier-ignore -->
```tsx
        awake={awake}
        onSetup={() => leave({ kind: "setup", shift })}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        awake={awake}
        signal={signal}
        onSetup={() => leave({ kind: "setup", shift })}
```

Правка `apps/standalone/src/floor/setup/WorkstationSetup.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { Alert, Button, Card, Input, Select } from "@markiro/ui";

import type { HardwareApi, UsbPrinter } from "../../hardware/hardware.js";
import type { LocalExecutor } from "../../local/executor.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { Alert, Button, Card, Input, Select } from "@markiro/ui";

import type { HardwareApi, ScannerSnapshot, UsbPrinter } from "../../hardware/hardware.js";
import type { LocalExecutor } from "../../local/executor.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
import type { ScanSource } from "../scan-source.js";
import { draftOf, NEW_PRINTER, profileOf, type PrinterDraft } from "./printer-draft.js";
import { makeTestCode, scannedTestCode, testLabelSpec } from "./test-label.js";
import {
  InvalidSettingsError,
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { ScanSource } from "../scan-source.js";
import { playSignalTone } from "../work/signal-sound.js";
import { draftOf, NEW_PRINTER, profileOf, type PrinterDraft } from "./printer-draft.js";
import { makeTestCode, scannedTestCode, testLabelSpec } from "./test-label.js";
import {
  canonicalPort,
  InvalidSettingsError,
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
} from "./workstation-settings.js";

export interface WorkstationSetupProps {
  local: LocalExecutor;
  hardware: Pick<HardwareApi, "listUsbPrinters">;
  printing: PrintRuntime;
```

заменить на:

<!-- prettier-ignore -->
```tsx
} from "./workstation-settings.js";

/** The steps of the tones' level: 0, 10, … 100. */
const VOLUME_STEP = 10;

export interface WorkstationSetupProps {
  local: LocalExecutor;
  hardware: Pick<
    HardwareApi,
    "listUsbPrinters" | "listSerialPorts" | "configureScanners" | "watchScanners"
  >;
  printing: PrintRuntime;
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  render?: RenderLabel;
  /** The settings were stored: the floor reads them again. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
  render?: RenderLabel;
  /** «Проверить звук»: a tone at this level; the generated tone by default. */
  playTone?: (level: number) => void;
  /** The settings were stored: the floor reads them again. */
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
  | { kind: "mismatch"; name: string; code: string };

type Status = { kind: "saved" } | { kind: "save_failed" } | { kind: "invalid" };

/**
 * The workstation setup (stage 2a spec §5.7.8): the printers of this
 * computer — where each is, its language and resolution — which one prints
 * which label, and a test print whose code is scanned back. Nothing is
 * stored until «Сохранить»; «Назад» leaves at once and says when it drops a
 * change, so the setup never holds the operator.
```

заменить на:

<!-- prettier-ignore -->
```tsx
  | { kind: "mismatch"; name: string; code: string };

type Status =
  { kind: "saved" } | { kind: "save_failed" } | { kind: "invalid" } | { kind: "scanners_failed" };

/**
 * The workstation setup (stage 2a spec §5.7.8): the printers of this
 * computer — where each is, its language and resolution — which one prints
 * which label, and a test print whose code is scanned back; the COM scanners
 * with their connection as the shell sees it; the tones' level; the check of
 * a printed label. Nothing is stored until «Сохранить», which also gives the
 * shell the scanners; «Назад» leaves at once and says when it drops a
 * change, so the setup never holds the operator.
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
  render = renderLabel,
  onSaved,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  render = renderLabel,
  playTone = (level) => playSignalTone("ok", undefined, level),
  onSaved,
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
  const [saving, setSaving] = useState(false);

  useEffect(() => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const [saving, setSaving] = useState(false);
  const [snapshot, setSnapshot] = useState<ScannerSnapshot | null>(null);
  const [serialPorts, setSerialPorts] = useState<string[] | null>(null);
  const [serialFailed, setSerialFailed] = useState(false);
  const [scanner, setScanner] = useState({ port: "", baud: "9600" });
  const [scannerError, setScannerError] = useState<string | null>(null);

  // The configured COM scanners and their connection, as the shell sees them.
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    hardware.watchScanners(setSnapshot).then(
      (stopWatching) => {
        if (cancelled) stopWatching();
        else stop = stopWatching;
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [hardware]);

  useEffect(() => {
```

Фрагмент 8:

<!-- prettier-ignore -->
```tsx
        setUsbFailed(true);
      },
```

заменить на:

<!-- prettier-ignore -->
```tsx
        setUsbFailed(true);
      },
    );
  };

  const refreshSerial = () => {
    setSerialFailed(false);
    hardware.listSerialPorts().then(
      (ports) => setSerialPorts(ports),
      () => {
        setSerialPorts([]);
        setSerialFailed(true);
      },
```

Фрагмент 9:

<!-- prettier-ignore -->
```tsx
      await saveWorkstationSettings(local, draft);
      setStored(draft);
      setStatus({ kind: "saved" });
      onSaved(draft);
    } catch (error) {
      setStatus(
        error instanceof InvalidSettingsError ? { kind: "invalid" } : { kind: "save_failed" },
      );
    } finally {
```

заменить на:

<!-- prettier-ignore -->
```tsx
      await saveWorkstationSettings(local, draft);
    } catch (error) {
      setStatus(
        error instanceof InvalidSettingsError ? { kind: "invalid" } : { kind: "save_failed" },
      );
      setSaving(false);
      return;
    }
    setStored(draft);
    onSaved(draft);
    try {
      // The whole set at once: a removed scanner's port is closed too.
      await hardware.configureScanners(draft.scanners);
      setStatus({ kind: "saved" });
    } catch {
      setStatus({ kind: "scanners_failed" });
    } finally {
```

Фрагмент 10:

<!-- prettier-ignore -->
```tsx
  };

  const purposeOptions = [
```

заменить на:

<!-- prettier-ignore -->
```tsx
  };

  const addScanner = () => {
    const port = canonicalPort(scanner.port);
    const baud = /^[0-9]+$/.test(scanner.baud.trim()) ? Number(scanner.baud.trim()) : 0;
    if (port === "") {
      setScannerError(t("floor.setup.scanners.errors.port"));
      return;
    }
    if (baud < 1 || baud > 4_294_967_295) {
      setScannerError(t("floor.setup.scanners.errors.baud"));
      return;
    }
    if (draft.scanners.some((existing) => existing.port === port)) {
      setScannerError(t("floor.setup.scanners.errors.duplicate", { port }));
      return;
    }
    change({ ...draft, scanners: [...draft.scanners, { port, baud }] });
    setScanner({ port: "", baud: "9600" });
    setScannerError(null);
  };

  const connection = (port: string): string => {
    const known = snapshot?.scanners.find((candidate) => candidate.port === port);
    if (known === undefined) return t("floor.setup.scanners.notApplied");
    return t(
      known.status === "connected"
        ? "floor.setup.scanners.connected"
        : "floor.setup.scanners.disconnected",
    );
  };

  const setVolume = (volume: number) => {
    change({ ...draft, sound: { ...draft.sound, volume: Math.min(100, Math.max(0, volume)) } });
  };

  const purposeOptions = [
```

Фрагмент 11:

<!-- prettier-ignore -->
```tsx
        )}
        {status !== null && (
```

заменить на:

<!-- prettier-ignore -->
```tsx
        )}
        {editor === null && (
          <>
            <h3>{t("floor.setup.scanners.title")}</h3>
            {draft.scanners.length === 0 ? (
              <p>{t("floor.setup.scanners.empty")}</p>
            ) : (
              <ul className="workstation-setup__list">
                {draft.scanners.map((configured) => (
                  <li key={configured.port}>
                    <strong>
                      {t("floor.setup.scanners.summary", {
                        port: configured.port,
                        baud: configured.baud,
                      })}
                    </strong>
                    <span>{connection(configured.port)}</span>
                    <div className="standalone-form__actions">
                      <Button
                        size="floor"
                        variant="secondary"
                        aria-label={t("floor.setup.scanners.removeFor", { port: configured.port })}
                        onClick={() =>
                          change({
                            ...draft,
                            scanners: draft.scanners.filter((s) => s.port !== configured.port),
                          })
                        }
                      >
                        {t("floor.setup.scanners.remove")}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Input
              size="floor"
              label={t("floor.setup.scanners.port")}
              value={scanner.port}
              onChange={(event) => {
                setScanner({ ...scanner, port: event.target.value });
                setScannerError(null);
              }}
            />
            {serialPorts !== null && (
              <p>
                {serialFailed
                  ? t("floor.setup.scanners.portsFailed")
                  : serialPorts.length === 0
                    ? t("floor.setup.scanners.portsNone")
                    : t("floor.setup.scanners.ports", { ports: serialPorts.join(", ") })}
              </p>
            )}
            <Input
              size="floor"
              inputMode="numeric"
              label={t("floor.setup.scanners.baud")}
              value={scanner.baud}
              onChange={(event) => {
                setScanner({ ...scanner, baud: event.target.value });
                setScannerError(null);
              }}
            />
            {scannerError !== null && <Alert tone="error">{scannerError}</Alert>}
            <div className="standalone-form__actions">
              <Button size="floor" variant="secondary" onClick={addScanner}>
                {t("floor.setup.scanners.add")}
              </Button>
              <Button size="floor" variant="secondary" onClick={refreshSerial}>
                {t("floor.setup.scanners.listPorts")}
              </Button>
            </div>
            <p>{t("floor.setup.scanners.keyboard")}</p>

            <h3>{t("floor.setup.sound.title")}</h3>
            <p aria-live="polite">
              {draft.sound.muted
                ? t("floor.setup.sound.mutedNow")
                : t("floor.setup.sound.level", { volume: draft.sound.volume })}
            </p>
            <div className="standalone-form__actions">
              <Button
                size="floor"
                variant="secondary"
                disabled={draft.sound.muted || draft.sound.volume <= 0}
                onClick={() => setVolume(draft.sound.volume - VOLUME_STEP)}
              >
                {t("floor.setup.sound.quieter")}
              </Button>
              <Button
                size="floor"
                variant="secondary"
                disabled={draft.sound.muted || draft.sound.volume >= 100}
                onClick={() => setVolume(draft.sound.volume + VOLUME_STEP)}
              >
                {t("floor.setup.sound.louder")}
              </Button>
              <Button
                size="floor"
                variant="secondary"
                aria-pressed={draft.sound.muted}
                onClick={() =>
                  change({ ...draft, sound: { ...draft.sound, muted: !draft.sound.muted } })
                }
              >
                {t("floor.setup.sound.mute")}
              </Button>
              <Button
                size="floor"
                variant="secondary"
                onClick={() => playTone(draft.sound.muted ? 0 : draft.sound.volume / 100)}
              >
                {t("floor.setup.sound.try")}
              </Button>
            </div>

            <h3>{t("floor.setup.check.title")}</h3>
            <p>{t("floor.setup.check.body")}</p>
            <Button
              size="floor"
              variant="secondary"
              aria-pressed={draft.verifyPrintedLabel}
              onClick={() => change({ ...draft, verifyPrintedLabel: !draft.verifyPrintedLabel })}
            >
              {t("floor.setup.check.toggle")}
            </Button>
            <p aria-live="polite">
              {t(draft.verifyPrintedLabel ? "floor.setup.check.on" : "floor.setup.check.off")}
            </p>
          </>
        )}
        {status !== null && (
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
        "save_failed": "Настройки не сохранились: база этого компьютера не ответила.",
        "invalid": "Настройки не сохранены: проверьте принтеры и сканеры."
      },
```

заменить на:

<!-- prettier-ignore -->
```json
        "save_failed": "Настройки не сохранились: база этого компьютера не ответила.",
        "invalid": "Настройки не сохранены: проверьте принтеры и сканеры.",
        "scanners_failed": "Настройки сохранены, но оболочка не приняла сканеры. Проверьте COM-порты."
      },
      "scanners": {
        "title": "Сканеры COM-портов",
        "empty": "COM-сканеров нет.",
        "summary": "{{port}}, {{baud}} бод",
        "connected": "Подключён.",
        "disconnected": "Нет связи: проверьте кабель и порт.",
        "notApplied": "Подключится после сохранения.",
        "remove": "Удалить",
        "removeFor": "Удалить сканер {{port}}",
        "port": "COM-порт сканера",
        "baud": "Скорость сканера, бод",
        "add": "Добавить сканер",
        "listPorts": "Показать COM-порты",
        "ports": "COM-порты этого компьютера: {{ports}}.",
        "portsNone": "COM-портов не найдено.",
        "portsFailed": "Список COM-портов не прочитался.",
        "keyboard": "Сканер, который работает как клавиатура, настраивать не нужно.",
        "errors": {
          "port": "Укажите COM-порт.",
          "baud": "Скорость — целое число больше нуля.",
          "duplicate": "Сканер на {{port}} уже есть."
        }
      },
      "sound": {
        "title": "Звук",
        "level": "Громкость сигналов: {{volume}} %.",
        "mutedNow": "Сигналы без звука.",
        "quieter": "Тише",
        "louder": "Громче",
        "mute": "Без звука",
        "try": "Проверить звук"
      },
      "check": {
        "title": "Проверка этикетки",
        "body": "После печати оператор сканирует SSCC этикетки короба, и работа идёт дальше после совпадения или пропуска проверки.",
        "toggle": "Проверять этикетку короба",
        "on": "Проверка этикетки включена.",
        "off": "Проверка этикетки выключена."
      },
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx test/floor-setup.test.tsx`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  40 passed (40)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: PASS — на копии плана `Test Files  106 passed (106)`, `Tests  2530 passed (2530)` (на настоящем дереве — больше на тесты, которых на копии нет; старые тесты офиса под нагрузкой — заметки).

- [ ] **Step 5: Мутации**

Порядок каждой мутации — раздел «Заметки для исполнения» («Мутации»).

М1 — сохранённые сканеры не отдаются оболочке.
В `apps/standalone/src/floor/setup/WorkstationSetup.tsx` удалить фрагмент

<!-- prettier-ignore -->
```tsx
      await hardware.configureScanners(draft.scanners);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-setup.test.tsx`
Expected: FAIL — «adds a COM scanner, gives the shell the whole set on save, and shows its connection», «keeps the saved settings when the shell refuses the scanners, and says so».

М2 — цех звучит по-старому после сохранения настройки.
В `apps/standalone/src/floor/FloorApp.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        onSaved={(settings) => setSound(settings.sound)}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        onSaved={() => undefined}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-app.test.tsx`
Expected: FAIL — «play at the workstation's level, and at the new one once the setup saved it».

М3 — один COM-порт дважды.
В `apps/standalone/src/floor/setup/WorkstationSetup.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    if (draft.scanners.some((existing) => existing.port === port)) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
    if (draft.scanners.some((existing) => existing.port === port && port === "")) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-setup.test.tsx`
Expected: FAIL — «refuses a scanner without a port, with a wrong speed or on a port it has».

- [ ] **Step 6: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/floor/setup/WorkstationSetup.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-app.test.tsx apps/standalone/test/floor-setup.test.tsx`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-app.test.tsx test/floor-setup.test.tsx`
Expected: PASS, в выводе нет строк `stderr |`.

Run (стенд с задержкой `setImmediate`, раздел «Заметки для исполнения»): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts test/floor-app.test.tsx test/floor-setup.test.tsx`; затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`
Expected: PASS; `git status --short` без временных файлов.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/floor/setup/WorkstationSetup.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-app.test.tsx apps/standalone/test/floor-setup.test.tsx
git commit -m "feat(standalone): the setup's COM scanners, sound and label check; the floor's tones at the saved level" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Документы — `AGENTS.md` и уточнения спецификации

`apps/standalone/AGENTS.md`: миграция `0007` в «Local database», раздел «Floor printing» (задание в транзакции закрытия, состояния и коды, очередь принтеров с пределом, восстановление прерванных, решения оператора, проверка до конвейера, настройка, «не засыпать», закрытие смены только при решённых этикетках), правки «Hardware» (кто теперь вызывает обёртки, отказ от `~HS`, предел ожидания, сброс запроса сна) и ручной список Windows печати. Спецификация этапа — раздел «Уточнения плана 2a7» (номер — следующий свободный).

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`

**Interfaces:**

- Consumes: код задач 1–8.
- Produces:
  - документы; кода нет.

- [ ] **Step 1: Документы**

Правка `apps/standalone/AGENTS.md`:

Фрагмент 1:

<!-- prettier-ignore -->
````markdown
`test/floor-schema.test.ts` pins these rules on node:sqlite.

## Writes
````

заменить на:

<!-- prettier-ignore -->
````markdown
`test/floor-schema.test.ts` pins these rules on node:sqlite.

Migration `0007_floor_printing.sql` (plan 2a7) adds `floor_print_jobs`
(`DeviceData`, see «Floor printing») and `workstation_settings`
(`Workstation`, the only table of that class: one JSON value per key —
`printers`, `scanners`, `sound`, `verify_printed_label` — with no pairing; a
forget keeps it). `floor_print_jobs.purpose` admits `box` and `pallet` from
the start, so the pallets' plan (ПЛ-Ц) rebuilds no table.
`test/floor-print-schema.test.ts` pins its rules.

## Writes
````

Фрагмент 2:

<!-- prettier-ignore -->
````markdown
the cloud station's `printer.rs`, `scanner.rs` and `power.rs`) are reached
only through `src/hardware/hardware.ts` (`createTauriHardware`); nothing in
the app calls it before plans 2a5–2a7. `src-tauri/tests/ipc.rs` pins the
names and arguments, refusals are bare codes, and the system's own words go
````

заменить на:

<!-- prettier-ignore -->
````markdown
the cloud station's `printer.rs`, `scanner.rs` and `power.rs`) are reached
only through `src/hardware/hardware.ts` (`createTauriHardware`): the floor's
COM scans (plan 2a6), and the printers, the scanners' configuration and the
power request (plan 2a7, «Floor printing»). `src-tauri/tests/ipc.rs` pins the
names and arguments, refusals are bare codes, and the system's own words go
````

Фрагмент 3:

<!-- prettier-ignore -->
````markdown
  `invalid_payload` before the shell is asked. Neither the shell nor the
  wrapper ever sends again; plan 2a7 owns one send at a time per address.
  `sent` means every byte left this computer, not that a label printed: a
  network printer sends no receipt, so a paused, out-of-paper or open printer
  that accepted the connection buffers the label and prints it later, and a
  reprint then doubles it; a spooler may take a job for a printer that is
  off. A status query before sending (ZPL `~HS`, a TSPL equivalent) is a
  language-specific decision left to plans 2a7 and `@markiro/domain`.
  Other limits, all unverified on Windows: Winsock may count the 5 s over one
````

заменить на:

<!-- prettier-ignore -->
````markdown
  `invalid_payload` before the shell is asked. Neither the shell nor the
  wrapper ever sends again; the floor's print runtime
  (`src/floor/print/print-runtime.ts`) sends one at a time per address.
  `sent` means every byte left this computer, not that a label printed: a
  network printer sends no receipt, so a paused, out-of-paper or open printer
  that accepted the connection buffers the label and prints it later, and a
  reprint then doubles it; a spooler may take a job for a printer that is
  off. A status query before sending (ZPL `~HS`, a TSPL equivalent) is not
  made: plan 2a7 left it to the owner (it would need a read on the same
  connection, and neither a COM printer without flow control nor a spooler
  queue answers one); the label check by scan is what proves a label.
  Other limits, all unverified on Windows: Winsock may count the 5 s over one
````

Фрагмент 4:

<!-- prettier-ignore -->
````markdown
  abort it instead is an owner question); and a COM flush or a trickling
  printer keeps the webview's call pending, so plan 2a7 needs its own limit
  on the awaiting side that answers `outcome_unknown`.
- `configure_scanners { scanners: [{ port, baud }] }` replaces the whole set
````

заменить на:

<!-- prettier-ignore -->
````markdown
  abort it instead is an owner question); and a COM flush or a trickling
  printer keeps the webview's call pending, so the print runtime answers a
  send it waited `PRINT_SEND_LIMIT_MS` (20 s) for as `timeout`, read as an
  unknown outcome.
- `configure_scanners { scanners: [{ port, baud }] }` replaces the whole set
````

Фрагмент 5:

<!-- prettier-ignore -->
````markdown
  with the process (unverified). The request survives a webview reload, so
  plan 2a7 calls `setSystemAwake(false)` once when the webview starts; it is
  idempotent and never fails.
- `run()` manages every state through `manage_state` in `setup`: the device,
````

заменить на:

<!-- prettier-ignore -->
````markdown
  with the process (unverified). The request survives a webview reload, so
  the app lets it go once when the webview starts (`createSystemAwake`,
  `src/hardware/awake.ts`, `reset`); it is idempotent and never fails.
- `run()` manages every state through `manage_state` in `setup`: the device,
````

Фрагмент 6:

<!-- prettier-ignore -->
````markdown
or the operator leaves, a scan is not taken, and the screen says so: nothing
is dropped silently. Printing the box's label is plan 2a7; the exceptions and
the shift's close are plan 2a8.

## Marking rules
````

заменить на:

<!-- prettier-ignore -->
````markdown
or the operator leaves, a scan is not taken, and the screen says so: nothing
is dropped silently. The box's label is «Floor printing»; the exceptions and
the shift's close are plan 2a8.

## Floor printing

Stage 2a, plan 2a7 (`src/floor/print`, `src/floor/setup`). A closing box
gets its print job in the close's own transaction (`boxLabelStep`, a
`CloseStep` of plan 2a6): the label's fields are the domain's
`boxLabelFields` from the shift's SNAPSHOT (product, print name, shelf life,
counterparty — never today's catalog), the box (SSCC, count, the stored
`closedAt`), the shift's number and production date and the operator who
closed it; the bytes are rendered for the box's printer of the
workstation's settings, read at each close: its language (`generateZpl` or
`generateTspl`, loaded on their own) and resolution (`withPrinterDpi`), the
template being the snapshot's revision, whose id and revision the job keeps.
Non-Latin text goes through `src/labels/rasterizer.ts`, the office preview's
rasterizer («предпросмотр = печать»), which refuses a canvas over 4096 dots
on a side (`RasterTooLargeError`) before it makes it. No printer for boxes —
the job is `failed` `printer_unconfigured`; no render — `failed`
`render_failed` with the printer kept; the box closes either way, and no job
exists for a box that did not close.

A job (`floor_print_jobs`, `print-jobs.ts`) walks `prepared → sending →
sent`, then `verified` or `skipped` when the workstation checks labels
(`verify`, the setting when the job was made), `failed` (nothing left this
computer: `not_sent`, `invalid_target`, `invalid_payload`, `unsupported`,
`printer_busy`) or `unknown` (a label may exist: `outcome_unknown`,
`timeout`, `interrupted`). `sending` and the attempt are written before the
bytes go (`sendLabelJob`), and every move compares the job's state and
attempt with what was read, so a late answer never overwrites a job moved
on. `sent` comes only from the shell's `{ sent: true }`. A send goes through
the app's one `PrintRuntime` (`createPrintRuntime`): one at a time per
address (`printerTargetKey`), each answered within `PRINT_SEND_LIMIT_MS`; a
send whose limit ran out while an earlier one to the same address still had
the printer is never given to the shell (`printer_busy`). When the work
screen opens and before it reads a job, every `sending` job whose bytes no
send of this app holds becomes `unknown` `interrupted`
(`recoverInterruptedJobs`). Nothing sends a label twice by itself: a
`prepared` job — written with its box, never sent — is sent once when the
screen finds it; every other send is the operator's.

The work screen stops at a label that waits (`Stop` `label`, `LabelPanel`)
and closes no next box while one does (the unique index
`floor_print_jobs_open` holds one waiting job per label). A failed label:
«Напечатать снова» (the job's bytes again), «Другой принтер», «Настроить
принтер» (the setup, after the work settles, and back to the shift),
«Продолжить без этикетки» after a confirmation (`skipped` with a `box_label`
record `skipped`). An unknown one adds «Этикетка напечаталась» (`sent`, then
the check when asked), and printing it again needs a reason of
`REPRINT_REASONS` (`src/floor/exception-reasons.ts`, the host's fixture),
written as a `reprint` exception (`floor_exceptions` and its `box_exception`
record) in the transaction that marks the job `sending`. Printing again
keeps the job's bytes when the printer's language and resolution are the
job's and renders again from the snapshot otherwise (`printAgain`). A check
that waits takes the scan before the pipeline: the SSCC read by
`parseScannedSscc` equal to the job's — `verified` with its `box_label`
record; another SSCC or no SSCC — said under the label, nothing written or
journalled; «Пропустить проверку» — `skipped`. «Выйти из смены» stays open
at every label: the label waits for the operator's return. Once a label is
done with, a box a stop of the station left full closes. A shift closes only
once every label of it is done with (`shiftLabelsSettled`, plan 2a8): a
`box_label` record after `shift_closed` would mark the station's own shift
late on the host (`late_data_at`).

The workstation setup (`WorkstationSetup.tsx`, from the list of shifts and
from a label's recovery) stores the printers (`{ id, name, target,
language, dpi }`, one per address) and the printer of each purpose — `box`,
`pallet`, `duplicate`; only `box` prints in stage 2a — the COM scanners
(given to the shell on save and when the app starts,
`applySavedScanners`), the tones' level and the label check, all at once on
«Сохранить»; «Назад» leaves at once. Its test print sends a 58 × 40 label of
ASCII only with a random Code 128 (`testLabelSpec`) through the same runtime
and checks the scan of its code; a scan that is not that code is never
shown (it may be a badge). The work screen keeps the computer awake while
it is open (`SystemAwake.hold`).

## Marking rules
````

Фрагмент 7:

<!-- prettier-ignore -->
````markdown
  station to another line and revoking it while the operator is in a shift.
- The floor's work (plan 2a6) by hand, on Windows 10 and 11. None of it has
````

заменить на:

<!-- prettier-ignore -->
````markdown
  station to another line and revoking it while the operator is in a shift.
- The floor's printing (plan 2a7) by hand, on Windows 10 and 11, with the
  client's printers. None of it has been run; check at least:
  - the box label on a Zebra (ZPL) and a TSC (TSPL) at 203 and 300 dpi over
    TCP 9100, a COM port and a USB spooler queue matches the office preview
    of the same template, with a long Cyrillic name, and its SSCC and barcode
    read back; the test print and its scan back on each;
  - a printer switched off, out of paper, paused and unplugged before and in
    the middle of a label: «не напечатана» or «неизвестно» as the shell
    answers, never a second label without the operator; a COM printer that
    stops reading (the 20 s limit, then «Принтер не ответил вовремя»);
  - the PC switched off in the middle of a send: on return the label is
    «Печать прервалась», and the operator's decisions work;
  - the label check with the client's scanners (an SSCC with and without the
    `]C1` prefix), «Пропустить проверку» and the reprint with a reason;
  - `powercfg /requests` while a work screen is open and after it closes,
    and after the window was reloaded during a shift;
  - the COM scanners of the setup: the port list, a scanner added and
    removed, its status, and the scanners again after a restart.
- The floor's work (plan 2a6) by hand, on Windows 10 and 11. None of it has
````

Правка `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`:

Фрагмент 1:

<!-- prettier-ignore -->
````markdown
  этикетки (вопрос владельцу: `AbortPrinter`); запрос питания переживает перезагрузку окна (сбрасывает план 2a7).
````

заменить на:

<!-- prettier-ignore -->
````markdown
  этикетки (вопрос владельцу: `AbortPrinter`); запрос питания переживает перезагрузку окна (сбрасывает план 2a7).

## 19. Уточнения плана 2a7

План `docs/superpowers/plans/2026-10-10-standalone-2a7-floor-printing.md` (цех: печать этикетки
короба, задания печати, восстановление, проверка этикетки, настройка рабочего места, «не засыпать»)
уточняет решения 19, 21–23, 34, разделы 5.3, 5.7.5 и 5.7.8 так; допущения по вопросам раздела 11
и спецификации пилота — рекомендованные варианты (если номер раздела занят, этот раздел получает
следующий свободный).

- Миграция `0007`: `floor_print_jobs` — `purpose` (`box`, `pallet`) и `subject_id` вместо
  `box_id`, чтобы план паллет ПЛ-Ц не пересобирал таблицу; задание хранит SSCC этикетки, шаблон
  снимка (идентификатор и ревизию), поля этикетки (для рендера под другой принтер), снимок профиля
  принтера, байты, `verify` — настройку проверки на момент задания; частичный уникальный индекс —
  одно ждущее задание на этикетку. `workstation_settings` — по ключу на группу настроек.
- Коды отказов задания: `failed` — `printer_unconfigured`, `render_failed`, `not_sent`,
  `invalid_target`, `invalid_payload`, `unsupported`, `printer_busy`; `unknown` —
  `outcome_unknown`, `timeout` (свой предел ожидания вебвью 20 с), `interrupted`.
- Отправки — через одну очередь приложения на адрес принтера; отправка, чей предел истёк в очереди
  за чужой зависшей, оболочке не отдаётся. `prepared` (записано с коробом, не отправлялось)
  отправляется само один раз при входе в экран; всё остальное — решение оператора.
- Повторная печать задания с неизвестным исходом и перепечатка непрочитанной этикетки — только с
  причиной из кодов перепечатки, которая пишется исключением `reprint` той же транзакцией, что
  `sending`; повтор `failed` — без причины. «Продолжить без этикетки» — с подтверждением, без кода
  причины (у `box_label` нет поля причины), как в облаке.
- Проверка этикетки перехватывает скан до конвейера; скан не того SSCC или не SSCC не пишется
  ни в журнал, ни в очередь.
- Настройка рабочего места — один экран (принтеры с назначениями и пробной печатью, COM-сканеры
  со статусом, звук, проверка этикетки), сохраняется целиком; из рабочего экрана — только через
  восстановление этикетки, после ожидания начатой работы, с возвратом в смену.
- «Не засыпать» — удержание на время рабочего экрана; при запуске вебвью запрос сна снимается
  всегда (переживший перезагрузку вебвью запрос оболочки).
- Смена закрывается только когда все её этикетки решены (`shiftLabelsSettled`, план 2a8):
  запись `box_label` после `shift_closed` отметила бы на хосте поздние данные собственной смены
  станции (`late_data_at`, ревью задачи 6 плана 2a2).
- Запрос состояния принтера перед печатью (`~HS`) не делается (вопрос владельцу).
````

- [ ] **Step 2: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`; `git diff --check`
Expected: чисто.

- [ ] **Step 3: Commit**

```bash
git add apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md
git commit -m "docs(standalone): floor printing in AGENTS.md and the stage 2a spec" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Итоговая проверка плана

1. Полный набор пакета: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — PASS; Vitest на копии плана — 106 файлов, 2530 тестов (на настоящем дереве числа сдвигаются на тесты, которых на копии нет). Падение старого теста офиса тайм-аутом под нагрузкой записывается и разбирается (заметки), а не лечится повтором.
2. Rust: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace` вне песочницы — PASS (на копии плана один тест `ipc` падает и до плана — артефакт копии, заметки). Из Rust план меняет только `src-tauri/src/local_db.rs` (два класса таблиц): `git diff --stat <основа плана> -- apps/standalone/src-tauri/src apps/standalone/host apps/standalone/proto` называет только его.
3. Стенд с задержкой `setImmediate` и verbose-прогон для всех новых и изменённых тестовых файлов с React (`app`, `floor-app`, `floor-work-screen`, `floor-work-print`, `floor-setup`) — PASS, в выводе нет `stderr |`.
4. Каждая мутация задач 1–8 — FAIL названного теста, файл восстановлен (`cmp`, тот же `shasum`), `git status --short` после всех — пуст.
5. `grep -rnF '\u04' apps/standalone/src apps/standalone/test` — только `src/host/pairing-code.ts:66`; `grep -rn "console\." apps/standalone/src/floor/print apps/standalone/src/floor/setup apps/standalone/src/hardware/awake.ts` — ничего (журнал процесса не видит ни SSCC, ни сканов).
6. `git diff --check` от основы плана; `git log --format=%B` каждого коммита — ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; изменены только пути раздела «Файлы».
7. Сверка с разделом «Контракт для 2a8 и ПЛ-Ц»: `prepareLabelJob`, `boxLabelStep`, `sendLabelJob`, `readOpenJob`, `shiftLabelsSettled`, `recoverInterruptedJobs`, `createPrintRuntime`, `PRINT_SEND_LIMIT_MS`, `settleOutcome`, `checkLabel`, `skipLabel`, `confirmPrinted`, `printAgain`, `REPRINT_REASONS`, `readWorkstationSettings`, `resolvePrinter`, `createSystemAwake`, `WorkScreenProps`, `Stop` названы в коде так, как в контракте.

**Что нельзя проверить без Windows, оборудования и данных клиента** (отчёт называет отдельно от автоматических проверок): этикетка короба на Zebra (ZPL) и TSC (TSPL) при 203 и 300 dpi по сети 9100, через COM и через спулер USB совпадает с предпросмотром офиса того же шаблона, с длинным названием кириллицей, её SSCC и штрихкод читаются; пробная печать и её скан на каждом; принтер выключен, без бумаги, на паузе и выдернут до и посреди этикетки — «не напечатана» или «неизвестно», как ответит оболочка, и никогда вторая этикетка без оператора; COM-принтер, который перестал читать (предел 20 с, «Принтер не ответил вовремя»); ПК выключен посреди отправки — после запуска «Печать прервалась» и решения оператора; проверка этикетки сканерами клиента (SSCC с `]C1` и без), «Пропустить проверку», перепечатка с причиной; `powercfg /requests` при открытом рабочем экране, после его закрытия и после перезагрузки окна посреди смены; COM-сканеры настройки (список портов, добавление, удаление, статус, сканеры после перезапуска); растеризатор WebView2 с IBM Plex и холстом до 4096 × 4096; раскладка экранов восстановления и настройки на 1024 × 768 и 1280 × 800 с сенсорной панелью (64 px).

## Перенесено

- **Запрос состояния принтера** (ZPL `~HS`, аналог TSPL) — вопрос владельцу ВП1; по рекомендации не делается, проверку дают скан этикетки и ручная приёмка.
- **Причина «Продолжить без этикетки» на хосте** — вопрос ВП2: нужно новое поле `box_label` и версия протокола (поток Б, вместе с ПЛ-Х).
- **Отмена задания спулера после неудачной записи** (`AbortPrinter`: сейчас половина этикетки может дойти до принтера) — вопрос владельцу из плана 2a4, остаётся.
- **Перепечатка решённого короба, расформирование, закрытие смены** — план 2a8 (по «Контракту»: `prepareLabelJob` и `shiftLabelsSettled`).
- **Этикетка паллеты, её проверка, перепечатка и расформирование паллеты** — план ПЛ-Ц (назначение `pallet` задания и принтера уже есть).
- **Срок хранения заданий печати** (решение 31: удалять задания смены вместе с её фактами, если нет ждущих) — план 2a8.
- **Выбор одного источника сканов по настройке** (решение 25) — план 2a6 читает клавиатуру и COM сразу; если владелец захочет выбор, — флаг в `workstation_settings` и `mergeScanSources` по нему.
- **Слова причины `other` при печати снова** — экран исключений плана 2a8 (поле текста до 200 символов); восстановление этикетки в 2a7 предлагает только коды.
- **Проверка сканера на экране настройки без принтера** (облачная «проверка сканера» кодом на экране) — пробная печать проверяет сканер вместе с принтером; отдельная проверка — по просьбе владельца.
- **Подтверждение ухода с изменёнными настройками** — «Назад без сохранения» называет потерю словами; диалог подтверждения — по просьбе владельца.

## Отклонения при исполнении
